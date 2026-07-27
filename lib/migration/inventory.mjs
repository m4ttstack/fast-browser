import crypto from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  readlink,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';

export const LEGACY_FILES = Object.freeze([
  '.claude.json',
  '.claude/agents/browser-driver.md',
  '.claude/rules/playwright-first.md',
  '.claude/rules/playwright-verification.md',
]);

export const LEGACY_LINKS = Object.freeze([
  ['.claude/skills/mattstack:browser-macros', 'skills/browser/browser-macros'],
  ['.claude/skills/mattstack:fast-browsing', 'skills/browser/fast-browsing'],
  ['.claude/skills/mattstack:mine-macros', 'skills/browser/mine-macros'],
]);

export const LEGACY_MCP_POINTER = '/mcpServers/playwright';
export const LEGACY_TOKEN_POINTER =
  '/mcpServers/playwright/env/PLAYWRIGHT_MCP_EXTENSION_TOKEN';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function canonicalHome(homeDir) {
  if (typeof homeDir !== 'string' || homeDir.length === 0) {
    throw new Error('migration requires a supplied home directory');
  }
  const resolved = path.resolve(homeDir);
  const state = await lstat(resolved);
  if (state.isSymbolicLink() || !state.isDirectory()) {
    throw new Error('migration home must be a real directory');
  }
  return realpath(resolved);
}

export function assertConfined(homeDir, candidate) {
  const resolved = path.resolve(candidate);
  if (resolved !== homeDir && !resolved.startsWith(`${homeDir}${path.sep}`)) {
    throw new Error(`migration path is not confined to the supplied home: ${candidate}`);
  }
  return resolved;
}

export async function assertNoSymlinkPath(homeDir, candidate, {
  allowLeafSymlink = false,
  allowMissing = true,
} = {}) {
  const target = assertConfined(homeDir, candidate);
  const relative = path.relative(homeDir, target);
  let current = homeDir;
  for (const [index, segment] of relative.split(path.sep).filter(Boolean).entries()) {
    current = path.join(current, segment);
    const state = await lstatOrNull(current);
    if (!state) {
      if (allowMissing) return null;
      throw new Error(`migration path is missing: ${current}`);
    }
    const leaf = index === relative.split(path.sep).filter(Boolean).length - 1;
    if (state.isSymbolicLink() && !(leaf && allowLeafSymlink)) {
      throw new Error(`refusing symlink in migration path: ${current}`);
    }
    if (!leaf && !state.isDirectory()) {
      throw new Error(`migration parent is not a directory: ${current}`);
    }
  }
  return lstatOrNull(target);
}

export async function readRegularFile(homeDir, target, message = 'legacy source must be a regular file') {
  const pathname = assertConfined(homeDir, target);
  const state = await assertNoSymlinkPath(homeDir, pathname, { allowMissing: false });
  if (!state?.isFile() || state.isSymbolicLink()) throw new Error(message);
  let handle;
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(state, opened)) throw new Error(message);
    return { bytes: await handle.readFile(), state: opened };
  } finally {
    await handle?.close();
  }
}

function skipWhitespace(raw, index) {
  while (index < raw.length && /[\t\n\r ]/.test(raw[index])) index += 1;
  return index;
}

function stringEnd(raw, start) {
  if (raw[start] !== '"') throw new Error('invalid JSON string');
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      return index + 1;
    } else if (character.charCodeAt(0) < 0x20) {
      throw new Error('invalid JSON control character');
    }
  }
  throw new Error('unterminated JSON string');
}

function parseNode(raw, inputIndex) {
  const start = skipWhitespace(raw, inputIndex);
  const character = raw[start];
  if (character === '"') {
    const end = stringEnd(raw, start);
    return { type: 'scalar', start, end };
  }
  if (character === '{') {
    const members = [];
    let index = skipWhitespace(raw, start + 1);
    if (raw[index] === '}') return { type: 'object', start, end: index + 1, members };
    while (index < raw.length) {
      const keyStart = index;
      const keyEnd = stringEnd(raw, keyStart);
      const key = JSON.parse(raw.slice(keyStart, keyEnd));
      index = skipWhitespace(raw, keyEnd);
      if (raw[index] !== ':') throw new Error('invalid JSON object');
      const value = parseNode(raw, index + 1);
      members.push({ key, keyStart, keyEnd, value });
      index = skipWhitespace(raw, value.end);
      if (raw[index] === '}') {
        return { type: 'object', start, end: index + 1, members };
      }
      if (raw[index] !== ',') throw new Error('invalid JSON object');
      index = skipWhitespace(raw, index + 1);
    }
    throw new Error('unterminated JSON object');
  }
  if (character === '[') {
    const items = [];
    let index = skipWhitespace(raw, start + 1);
    if (raw[index] === ']') return { type: 'array', start, end: index + 1, items };
    while (index < raw.length) {
      const value = parseNode(raw, index);
      items.push(value);
      index = skipWhitespace(raw, value.end);
      if (raw[index] === ']') return { type: 'array', start, end: index + 1, items };
      if (raw[index] !== ',') throw new Error('invalid JSON array');
      index = skipWhitespace(raw, index + 1);
    }
    throw new Error('unterminated JSON array');
  }
  const match = raw.slice(start).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
  if (!match) throw new Error('invalid JSON value');
  return { type: 'scalar', start, end: start + match[0].length };
}

export function parseJsonSpans(raw) {
  const root = parseNode(raw, 0);
  if (skipWhitespace(raw, root.end) !== raw.length) throw new Error('invalid trailing JSON data');
  return root;
}

export function locateJsonPointer(raw, pointer) {
  const keys = pointer.split('/').slice(1).map((key) => (
    key.replaceAll('~1', '/').replaceAll('~0', '~')
  ));
  let node = parseJsonSpans(raw);
  let member = null;
  let parent = null;
  for (const key of keys) {
    if (node.type !== 'object') return null;
    const matches = node.members.filter((entry) => entry.key === key);
    if (matches.length > 1) throw new Error(`duplicate JSON pointer member: ${pointer}`);
    if (matches.length === 0) return null;
    parent = node;
    [member] = matches;
    node = member.value;
  }
  return { node, member, parent };
}

export function removeJsonPointer(raw, pointer) {
  const location = locateJsonPointer(raw, pointer);
  if (!location) return raw;
  const { member, parent } = location;
  const index = parent.members.indexOf(member);
  let start;
  let end;
  if (parent.members.length === 1) {
    start = member.keyStart;
    end = member.value.end;
  } else if (index < parent.members.length - 1) {
    start = member.keyStart;
    end = parent.members[index + 1].keyStart;
  } else {
    start = parent.members[index - 1].value.end;
    end = member.value.end;
  }
  return raw.slice(0, start) + raw.slice(end);
}

// Fixed placeholder for any env key name that looks like a token, so an
// unmanaged candidate's report never even echoes back a key name that could
// itself be mistaken for a secret.
export const UNMANAGED_TOKEN_KEY_PLACEHOLDER = '<redacted-token-key>';

function recognizedPublishedPlaywright(value) {
  return value.command === 'npx'
    && Array.isArray(value.args)
    && value.args.length === 2
    && value.args[0] === '@playwright/mcp@latest'
    && value.args[1] === '--extension';
}

function isMcpServerScriptPath(candidate) {
  return typeof candidate === 'string'
    && path.isAbsolute(candidate)
    && path.basename(candidate) === 'mcp-server.js';
}

function hasPlaywrightMcpEnvMarker(env) {
  return env !== null
    && typeof env === 'object'
    && !Array.isArray(env)
    && Object.keys(env).some((key) => key.startsWith('PLAYWRIGHT_MCP_'));
}

// A locally built Playwright MCP server launched directly by Node, e.g. a
// development checkout: `node <absolute path>/mcp-server.js [extra args...]`.
// Extra args must not defeat the match, but an env marker is required so this
// stays conservative and never recognizes an unrelated `node` invocation.
function recognizedLocalDevPlaywright(value) {
  return value.command === 'node'
    && Array.isArray(value.args)
    && value.args.length >= 1
    && isMcpServerScriptPath(value.args[0])
    && hasPlaywrightMcpEnvMarker(value.env);
}

function recognizedPlaywright(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return recognizedPublishedPlaywright(value) || recognizedLocalDevPlaywright(value);
}

// Deliberately broad, read-only signal: does this mcpServers entry look
// Playwright-related at all? Used only to decide whether to report an
// unmanaged candidate, never to recognize or mutate anything.
function looksPlaywrightRelated(key, value) {
  if (typeof key === 'string' && key.toLowerCase().includes('playwright')) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const args = Array.isArray(value.args) ? value.args : [];
  if (args.some((arg) => typeof arg === 'string' && arg.toLowerCase().includes('playwright'))) {
    return true;
  }
  const { env } = value;
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    if (Object.keys(env).some((envKey) => envKey.toLowerCase().includes('playwright'))) {
      return true;
    }
  }
  return false;
}

function sanitizedCandidateEnvKeys(value) {
  const env = value?.env;
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return [];
  return Object.keys(env).map((key) => (
    /token/i.test(key) ? UNMANAGED_TOKEN_KEY_PLACEHOLDER : key
  ));
}

function unmanagedCandidate(key, value) {
  return {
    key,
    command: typeof value?.command === 'string' ? value.command : null,
    argCount: Array.isArray(value?.args) ? value.args.length : 0,
    envKeys: sanitizedCandidateEnvKeys(value),
  };
}

// Read-only inventory of every mcpServers entry that looks Playwright-related
// but is not the one recognized legacy registration. Never mutated, backed
// up, or rolled back; exists only so a user is told what exists instead of
// being shown an empty plan.
function unmanagedPlaywrightCandidates(rootValue) {
  const mcpServers = rootValue?.mcpServers;
  if (mcpServers === null || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
    return [];
  }
  const candidates = [];
  for (const [key, entryValue] of Object.entries(mcpServers)) {
    if (key === 'playwright' && recognizedPlaywright(entryValue)) continue;
    if (!looksPlaywrightRelated(key, entryValue)) continue;
    candidates.push(unmanagedCandidate(key, entryValue));
  }
  candidates.sort((left, right) => (
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  ));
  return candidates;
}

function sanitizedBefore(value) {
  const before = structuredClone(value);
  if (before?.env && typeof before.env === 'object' && !Array.isArray(before.env)) {
    delete before.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    if (Object.keys(before.env).length === 0) delete before.env;
  }
  return before;
}

async function regularEntry(homeDir, target) {
  const state = await lstatOrNull(target);
  if (!state) return null;
  const { bytes, state: opened } = await readRegularFile(homeDir, target);
  return {
    path: target,
    sha256: sha256(bytes),
    mode: opened.mode & 0o777,
  };
}

async function validateTree(homeDir, root) {
  const rootState = await assertNoSymlinkPath(homeDir, root, { allowMissing: false });
  if (!rootState?.isDirectory()) throw new Error('legacy import root must be a directory');
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`refusing symlink in legacy import: ${target}`);
      if (entry.isDirectory()) queue.push(target);
      else if (entry.isFile()) await readRegularFile(homeDir, target);
      else throw new Error(`legacy import entry must be regular: ${target}`);
    }
  }
}

async function directEntries(homeDir, root, predicate) {
  const state = await lstatOrNull(root);
  if (!state) return [];
  await assertNoSymlinkPath(homeDir, root, { allowMissing: false });
  if (!state.isDirectory()) throw new Error('legacy import root must be a directory');
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!predicate(entry)) continue;
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink in legacy import: ${target}`);
    if (entry.isDirectory()) await validateTree(homeDir, target);
    else if (entry.isFile()) await readRegularFile(homeDir, target);
    else throw new Error(`legacy import entry must be regular: ${target}`);
    result.push({ path: target, name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

export async function inventoryLegacy(paths) {
  const homeDir = await canonicalHome(paths?.homeDir);
  const files = [];
  const jsonEdits = [];
  let unmanagedCandidates = [];
  const claudeJson = path.join(homeDir, '.claude.json');
  const claudeState = await lstatOrNull(claudeJson);
  if (claudeState) {
    const { bytes, state } = await readRegularFile(homeDir, claudeJson);
    let value;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('legacy Claude JSON is malformed');
    }
    unmanagedCandidates = unmanagedPlaywrightCandidates(value);
    const playwright = value?.mcpServers?.playwright;
    if (recognizedPlaywright(playwright)) {
      const raw = bytes.toString('utf8');
      if (!locateJsonPointer(raw, LEGACY_MCP_POINTER)) {
        throw new Error('legacy Claude JSON pointer is ambiguous');
      }
      files.push({
        path: claudeJson,
        sha256: sha256(bytes),
        mode: state.mode & 0o777,
      });
      const tokenValue = playwright?.env?.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
      jsonEdits.push({
        path: claudeJson,
        pointer: LEGACY_MCP_POINTER,
        before: sanitizedBefore(playwright),
        tokenPointer: typeof tokenValue === 'string' ? LEGACY_TOKEN_POINTER : null,
      });
    }
  }

  for (const relative of LEGACY_FILES.slice(1)) {
    const entry = await regularEntry(homeDir, path.join(homeDir, relative));
    if (entry) files.push(entry);
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const symlinks = [];
  for (const [relative, expectedSuffix] of LEGACY_LINKS) {
    const targetPath = path.join(homeDir, relative);
    const state = await assertNoSymlinkPath(homeDir, targetPath, {
      allowLeafSymlink: true,
    });
    if (!state) continue;
    if (!state.isSymbolicLink()) throw new Error(`legacy skill link must be a symlink: ${targetPath}`);
    const target = await readlink(targetPath);
    if (!target.replaceAll(path.sep, '/').endsWith(expectedSuffix)) continue;
    symlinks.push({ path: targetPath, target });
  }
  symlinks.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const legacyRoot = path.join(homeDir, '.playwright-mcp');
  const legacyState = await lstatOrNull(legacyRoot);
  if (legacyState) {
    await assertNoSymlinkPath(homeDir, legacyRoot, { allowMissing: false });
    if (!legacyState.isDirectory()) throw new Error('legacy data root must be a directory');
  }
  const macrosRoot = path.join(legacyRoot, 'macros');
  const macrosState = await lstatOrNull(macrosRoot);
  if (macrosState) {
    await assertNoSymlinkPath(homeDir, macrosRoot, { allowMissing: false });
    if (!macrosState.isDirectory()) throw new Error('legacy macros root must be a directory');
  }
  const macroIndexPath = path.join(macrosRoot, 'MACROS.md');
  const macroIndex = await regularEntry(homeDir, macroIndexPath);
  const macros = await directEntries(
    homeDir,
    macrosRoot,
    (entry) => entry.isSymbolicLink() || (entry.isFile() && entry.name.endsWith('.js')),
  );
  const failureRecord = await regularEntry(
    homeDir,
    path.join(legacyRoot, 'macro-failures.md'),
  );
  const sessions = await directEntries(
    homeDir,
    legacyRoot,
    (entry) => entry.isSymbolicLink()
      || (entry.isDirectory() && /^session-[A-Za-z0-9._-]+$/.test(entry.name)),
  );
  const archive = await directEntries(
    homeDir,
    path.join(legacyRoot, 'archive'),
    (entry) => entry.isSymbolicLink() || entry.isDirectory() || entry.isFile(),
  );

  return {
    schemaVersion: 1,
    homeDir,
    files,
    jsonEdits,
    unmanagedCandidates,
    symlinks,
    imports: {
      macroIndex: macroIndex ? { path: macroIndex.path } : null,
      macros: macros.map(({ path: target, name }) => ({ path: target, name })),
      failureRecord: failureRecord ? { path: failureRecord.path } : null,
      sessions,
      archive,
    },
  };
}
