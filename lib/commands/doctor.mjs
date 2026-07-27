import { access, lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig as loadSavedConfig, parseConfig } from '../core/config.mjs';
import { saveConfig as saveValidatedConfig } from '../core/files.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { openNdjsonProcess, run as runProcess } from '../core/process.mjs';
import { DOCTOR_CHECK_IDS, defaultCheck } from '../doctor/checks.mjs';
import { buildContentManifestDigest } from '../core/content-manifest.mjs';
import { detectChromeExtension } from '../extension/detect.mjs';
import { extensionInstallLocation } from '../extension/install.mjs';
import { preflightClaudeUninstall } from '../hosts/claude.mjs';
import { preflightCodexUninstall } from '../hosts/codex.mjs';
import { runWithCodexModelFallback } from '../hosts/codex-agent.mjs';
import { detectHosts } from '../hosts/detect.mjs';
import {
  beginOwnedCodexAgentFallback,
  preflightRoutingRemoval,
} from '../hosts/routing.mjs';
import { hasToken, readToken } from '../keychain/keychain.mjs';
import { verifyRuntimeContentDigest } from '../runtime/content.mjs';
import { runtimeArgs } from '../runtime/launch.mjs';
import { loadRuntimeLock, runtimeLockIdentity } from '../runtime/lock.mjs';

const STATUSES = new Set(['pass', 'warn', 'fail']);
const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PREFERRED_CODEX_MODEL = 'gpt-5.6-terra';
const CODEX_SMOKE_MARKER = 'FAST_BROWSER_DRIVER_OK';
const CODEX_FALLBACK_RECOVERY_REQUIRED = 'CODEX_FALLBACK_RECOVERY_REQUIRED';
const CODEX_SMOKE_PROMPT =
  `Delegate to browser_driver. Return exactly ${CODEX_SMOKE_MARKER} without using browser tools.`;

class CodexBrowserDriverSmokeError extends Error {
  constructor(message, { code = 'SMOKE_FAILED', model = null } = {}) {
    super(message);
    this.name = 'CodexBrowserDriverSmokeError';
    this.code = code;
    this.model = model;
  }
}

function jsonLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error();
      }
      events.push(value);
    } catch {
      throw new CodexBrowserDriverSmokeError('Codex browser-driver smoke returned malformed JSON.');
    }
  }
  return events;
}

export function isPreferredCodexModelRejection(error) {
  return (
    error?.name === 'CodexBrowserDriverSmokeError'
    && error?.code === 'MODEL_NOT_FOUND'
    && error?.model === PREFERRED_CODEX_MODEL
  );
}

export async function runCodexBrowserDriverSmoke({
  cwd,
  run = runProcess,
} = {}) {
  const result = await run(
    'codex',
    [
      'exec',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--json',
      '--skip-git-repo-check',
      '-C',
      cwd,
      CODEX_SMOKE_PROMPT,
    ],
    // exec is already non-interactive; a real agent run measured 23.6s, so
    // give it headroom above the 10s that was tuned for a stub response.
    { timeoutMs: 60_000 },
  );
  const events = jsonLines(result.stdout);
  const preferredRejection = events.find((event) => (
    event.type === 'error'
    && event.error?.code === 'model_not_found'
    && event.error?.model === PREFERRED_CODEX_MODEL
  ));
  if (preferredRejection) {
    throw new CodexBrowserDriverSmokeError(
      'Codex rejected the preferred browser-driver model.',
      { code: 'MODEL_NOT_FOUND', model: PREFERRED_CODEX_MODEL },
    );
  }
  if (result.exitCode !== 0) {
    throw new CodexBrowserDriverSmokeError('Codex browser-driver smoke failed.');
  }
  const completed = events.some((event) => (
    event.type === 'item.completed'
    && event.item?.type === 'agent_message'
    && event.item?.text === CODEX_SMOKE_MARKER
  ));
  if (!completed) {
    throw new CodexBrowserDriverSmokeError(
      'Codex browser-driver smoke did not return its expected marker.',
    );
  }
}

function checkResult(status, message, remediation = null) {
  return { status, message, remediation };
}

function pass(message) {
  return checkResult('pass', message);
}

function fail(message, remediation) {
  return checkResult('fail', message, remediation);
}

async function installedRuntime(paths, lock) {
  if (!lock) throw new Error('runtime lock unavailable');
  const directory = path.join(paths.runtimeDir, lock.productVersion);
  const cliDirectory = path.join(directory, 'fast-browser-mcp');
  const cli = path.join(cliDirectory, 'cli.cjs');
  const markerPath = path.join(directory, 'installed.json');
  const [marker, cliState, markerState] = await Promise.all([
    readFile(markerPath, 'utf8').then(JSON.parse),
    stat(cli),
    lstat(markerPath),
  ]);
  if (
    markerState.isSymbolicLink()
    || !markerState.isFile()
    || !cliState.isFile()
    || JSON.stringify(marker.lock) !== JSON.stringify(runtimeLockIdentity(lock))
  ) throw new Error('runtime install mismatch');
  // A version string, and even a marker that names the right lock, proves
  // nothing about the bytes actually on disk: recompute the digest over the
  // installed tree, symmetric with extensionArtifact below, so tampering the
  // CLI after install (independently of the marker) is caught here instead
  // of only surfacing later as a broken MCP handshake. Shared with
  // installRuntime's existingInstall, the upgrade classifier, and the
  // launch-time validator, so there is exactly one implementation of what
  // "verified" means for the runtime artifact.
  if (!(await verifyRuntimeContentDigest(cliDirectory, marker))) {
    throw new Error('runtime install mismatch');
  }
  return cli;
}

async function extensionArtifact(paths, lock) {
  if (!lock) throw new Error('runtime lock unavailable');
  const { marker: markerPath, unpacked, manifest: manifestPath } = extensionInstallLocation(paths);
  const [marker, manifest, markerState, manifestState] = await Promise.all([
    readFile(markerPath, 'utf8').then(JSON.parse),
    readFile(manifestPath, 'utf8').then(JSON.parse),
    lstat(markerPath),
    lstat(manifestPath),
  ]);
  if (
    markerState.isSymbolicLink()
    || manifestState.isSymbolicLink()
    || !markerState.isFile()
    || !manifestState.isFile()
    || JSON.stringify(marker.lock) !== JSON.stringify(runtimeLockIdentity(lock))
    || manifest.version !== lock.extension.version
    || typeof marker.contentDigest !== 'string'
    || !/^[0-9a-f]{64}$/.test(marker.contentDigest)
  ) throw new Error('extension artifact mismatch');
  const actualDigest = await buildContentManifestDigest(unpacked);
  if (actualDigest !== marker.contentDigest) throw new Error('extension artifact mismatch');
  return unpacked;
}

// A version string cannot prove the loaded extension matches the pinned
// artifact: two different builds can share one version (the focus-fix
// incident). Verify the CONTENT Chrome actually loaded from instead, against
// the deterministic manifest digest recorded when extension/install.mjs last
// verified and unpacked the pinned artifact.
async function verifyExtensionContent({ loadedPath, managedDirectory }) {
  if (
    typeof loadedPath !== 'string'
    || path.resolve(loadedPath) !== path.resolve(managedDirectory)
  ) return false;
  let marker;
  try {
    marker = JSON.parse(await readFile(
      path.join(path.dirname(managedDirectory), 'installed.json'),
      'utf8',
    ));
  } catch {
    return false;
  }
  if (typeof marker.contentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(marker.contentDigest)) {
    return false;
  }
  let actualDigest;
  try {
    actualDigest = await buildContentManifestDigest(loadedPath);
  } catch {
    return false;
  }
  return actualDigest === marker.contentDigest;
}

// Everything above verifies BYTES ON DISK. Under a stable install directory
// that is no longer sufficient on its own: setup swaps the content of a path
// Chrome is already holding open, so the digest matches the pinned artifact
// the instant setup finishes, while Chrome keeps serving the previously
// parsed extension until someone reloads it. Disk agreement and "Chrome is
// running this" became separable, so compare Chrome's own recorded load time
// against when the content was last written.
//
// Deliberately strict: reporting stale-but-fine is the failure that hides a
// wrong extension, and it is the exact shape of the version trap that already
// cost a day.
//
// Measured on Chrome 150: a developer-mode reload does bump last_update_time,
// but Chrome commits Secure Preferences lazily, so for a short window after a
// real reload this still reads the previous value and reports stale. That
// false alarm is the safe direction and it clears itself once Chrome flushes,
// so the remediation says so rather than sending the user round again.
async function verifyExtensionIsLoadedContent({ loadedAt, markerPath }) {
  if (typeof loadedAt !== 'number' || !Number.isFinite(loadedAt)) return false;
  let installedAt;
  try {
    installedAt = (await lstat(markerPath)).mtimeMs;
  } catch {
    return false;
  }
  return loadedAt >= installedAt;
}

async function productionDependencies(request, dependencies, paths) {
  let config = dependencies.config;
  if (!config) {
    try {
      config = await (dependencies.loadConfig ?? loadSavedConfig)(paths);
    } catch {
      config = null;
    }
  }
  let lock = dependencies.lock;
  if (!lock) {
    try {
      lock = await (dependencies.loadRuntimeLock ?? loadRuntimeLock)({
        bundledPath: path.join(paths.pluginRoot ?? PLUGIN_ROOT, 'runtime-lock.json'),
        overridePath: request.runtimeLock,
      });
    } catch {
      lock = null;
    }
  }
  let detectedPromise;
  const detected = () => {
    detectedPromise ??= (dependencies.detectHosts ?? detectHosts)();
    return detectedPromise;
  };
  let routingPromise;
  const routing = () => {
    if (!config) throw new Error('config unavailable');
    routingPromise ??= (dependencies.preflightRouting ?? preflightRoutingRemoval)({
      paths,
      managedState: {
        profile: config.profile,
        files: config.managed.files,
        blocks: config.managed.blocks,
      },
    });
    return routingPromise;
  };
  const chromeUserDataDir = dependencies.chromeUserDataDir
    ?? path.join(paths.homeDir, 'Library', 'Application Support', 'Google', 'Chrome');

  const selected = (host) => config?.hosts?.[host] === true;
  const notSelected = (host, label) => (
    !selected(host)
      ? pass(`${label} is not selected for this configuration.`)
      : null
  );

  const checks = {
    platform: async () => (
      (dependencies.platform ?? process.platform) === 'darwin'
        ? pass('macOS is supported.')
        : fail(
          'Fast Browser supports macOS only.',
          'Run Fast Browser on macOS with Google Chrome.',
        )
    ),
    node: async () => (
      Number.parseInt((dependencies.nodeVersion ?? process.versions.node).split('.')[0], 10) >= 20
        ? pass('Node 20 or newer is available.')
        : fail('Node 20 or newer is required.', 'Install Node 20 or newer.')
    ),
    chrome: async () => {
      await (dependencies.checkChrome ?? (() => access('/Applications/Google Chrome.app')))();
      return pass('Google Chrome is available.');
    },
    'claude-cli': async () => (
      notSelected('claude', 'Claude Code')
      ?? ((await detected()).includes('claude')
        ? pass('Claude Code CLI is available.')
        : fail('Claude Code CLI is unavailable.', 'Install Claude Code or select Codex only.'))
    ),
    'codex-cli': async () => (
      notSelected('codex', 'Codex')
      ?? ((await detected()).includes('codex')
        ? pass('Codex CLI is available.')
        : fail('Codex CLI is unavailable.', 'Install Codex or select Claude Code only.'))
    ),
    'claude-plugin': async () => (
      notSelected('claude', 'Claude Code')
      ?? ((await (dependencies.preflightClaude ?? preflightClaudeUninstall)()).installed
        ? pass('Claude Code has the exact Fast Browser plugin.')
        : fail('Claude Code does not have Fast Browser installed.', 'Run `fast-browser setup --host claude`.'))
    ),
    'codex-plugin': async () => (
      notSelected('codex', 'Codex')
      ?? ((await (dependencies.preflightCodex ?? preflightCodexUninstall)()).installed
        ? pass('Codex has the exact Fast Browser plugin.')
        : fail('Codex does not have Fast Browser installed.', 'Run `fast-browser setup --host codex`.'))
    ),
    'claude-routing': async () => {
      const skipped = notSelected('claude', 'Claude routing');
      if (skipped) return skipped;
      await routing();
      const installed = config?.profile !== 'full'
        || config.managed.files.some(({ path: target }) => target.endsWith(
          path.join('.claude', 'rules', 'fast-browser-routing.md'),
        ));
      return installed
        ? pass('Claude routing ownership is valid.')
        : fail('Claude routing is missing.', 'Run `fast-browser configure --profile full`.');
    },
    'codex-routing': async () => {
      const skipped = notSelected('codex', 'Codex routing');
      if (skipped) return skipped;
      await routing();
      const installed = config?.managed.blocks.some(({ path: target }) => (
        target.endsWith(path.join('.codex', 'config.toml'))
      ));
      return installed
        ? pass('Codex routing ownership is valid.')
        : fail('Codex routing is missing.', 'Run `fast-browser configure`.');
    },
    'browser-driver': async () => {
      const skipped = notSelected('codex', 'Codex browser-driver');
      if (skipped) return skipped;
      await routing();
      const installed = config?.managed.files.some(({ path: target }) => (
        target.endsWith(path.join('.codex', 'agents', 'browser_driver.toml'))
      ));
      if (!installed) {
        return fail('The browser-driver agent is missing.', 'Run `fast-browser configure`.');
      }
      const smoke = dependencies.runCodexAgentSmoke
        ?? (() => runCodexBrowserDriverSmoke({
          cwd: dependencies.codexSmokeCwd ?? paths.homeDir,
          run: dependencies.runProcess ?? runProcess,
        }));
      try {
        await runWithCodexModelFallback({
          run: smoke,
          isPreferredModelRejection: isPreferredCodexModelRejection,
          rewriteOwnedAgent: async () => {
            const receipt = await (
              dependencies.beginOwnedCodexAgentFallback
              ?? beginOwnedCodexAgentFallback
            )({
              paths,
              managedState: {
                profile: config.profile,
                files: config.managed.files,
                blocks: config.managed.blocks,
              },
            });
            const managedState = receipt.managedState;
            const nextConfig = parseConfig({
              ...config,
              managed: {
                files: managedState.files,
                blocks: managedState.blocks,
              },
            });
            try {
              await (dependencies.saveConfig ?? saveValidatedConfig)(paths, nextConfig);
            } catch {
              try {
                await receipt.rollback();
              } catch {
                const recoveryError = new Error('Codex agent fallback recovery is required.');
                recoveryError.code = CODEX_FALLBACK_RECOVERY_REQUIRED;
                throw recoveryError;
              }
              throw new Error('Codex agent fallback config persistence failed.');
            }
            config = nextConfig;
          },
        });
      } catch (error) {
        if (error?.code === CODEX_FALLBACK_RECOVERY_REQUIRED) {
          return fail(
            'The browser-driver agent fallback requires recovery.',
            'Run `fast-browser configure` to restore the owned agent.',
          );
        }
        throw error;
      }
      return pass('The browser-driver agent is installed, owned, and runnable.');
    },
    'runtime-checksum': async () => {
      try {
        await (dependencies.checkRuntime ?? installedRuntime)(paths, lock);
      } catch {
        // Fails by definition after a legitimate re-pin, since the newly
        // pinned version was never installed under the old lock. Point at
        // `setup` (which upgrades when eligible, or refuses on real
        // tampering) rather than `doctor`, which cannot fix this itself.
        return fail(
          'The installed runtime does not match its pinned lock.',
          'Run `fast-browser setup` to install the pinned runtime.',
        );
      }
      return pass(`Runtime ${lock.productVersion} matches its lock.`);
    },
    'extension-artifact': async () => {
      try {
        await (dependencies.checkExtensionArtifact ?? extensionArtifact)(paths, lock);
      } catch {
        return fail(
          'The installed extension artifact does not match its pinned lock.',
          'Run `fast-browser setup` to install the pinned extension.',
        );
      }
      return pass(`Extension artifact ${lock.extension.version} matches its lock.`);
    },
    'extension-installed': async () => {
      const profiles = await (dependencies.detectChromeExtension ?? detectChromeExtension)({
        extensionId: lock.extension.id,
        chromeUserDataDir,
      });
      const { unpacked: managedDirectory, marker: markerPath } = extensionInstallLocation(paths);
      const verify = dependencies.verifyExtensionContent ?? verifyExtensionContent;
      const verifyLoaded = dependencies.verifyExtensionIsLoadedContent
        ?? verifyExtensionIsLoadedContent;
      let versionMatchedSomeProfile = false;
      for (const profile of profiles) {
        if (!profile.installed || profile.manifestVersion !== lock.extension.version) continue;
        versionMatchedSomeProfile = true;
        if (await verify({ loadedPath: profile.path, managedDirectory })) {
          return pass('The pinned Chrome extension is installed.');
        }
      }
      return versionMatchedSomeProfile
        ? fail(
          'The installed Chrome extension does not match the verified artifact content.',
          'Run `fast-browser setup` to reinstall the pinned extension.',
        )
        : fail(
          'The pinned Chrome extension is not installed.',
          `Load the unpacked extension in Google Chrome from ${managedDirectory}.`,
        );
    },
    // Split out from extension-installed deliberately. Those two questions
    // were the same question only while installs were version-scoped: the
    // loaded path then encoded which build Chrome had parsed. The install
    // directory is stable now, so setup swaps content under a path Chrome is
    // already holding, and "the right bytes are on disk" becomes true at
    // install time while "Chrome is running them" stays false until a reload.
    //
    // They must stay separate checks because they mean opposite things to the
    // drift guard: content that does not match the pinned artifact is
    // evidence of tampering and must keep failing setup, whereas a stale load
    // is an expected, benign resting state with one documented manual step.
    // Folding staleness into extension-installed would force a choice between
    // calling a normal state tampering and letting real tampering pass.
    'extension-loaded': async () => {
      const profiles = await (dependencies.detectChromeExtension ?? detectChromeExtension)({
        extensionId: lock.extension.id,
        chromeUserDataDir,
      });
      const { unpacked: managedDirectory, marker: markerPath } = extensionInstallLocation(paths);
      const verifyLoaded = dependencies.verifyExtensionIsLoadedContent
        ?? verifyExtensionIsLoadedContent;
      let managedSomeProfile = false;
      for (const profile of profiles) {
        if (
          !profile.installed
          || typeof profile.path !== 'string'
          || path.resolve(profile.path) !== path.resolve(managedDirectory)
        ) continue;
        managedSomeProfile = true;
        if (await verifyLoaded({ loadedAt: profile.loadedAt, markerPath })) {
          return pass('Chrome is running the installed extension content.');
        }
      }
      // Nothing managed is loaded at all: extension-installed already reports
      // that, and repeating it here would double-count one problem.
      if (!managedSomeProfile) {
        return pass('No managed Chrome extension load to verify.');
      }
      return fail(
        'Chrome is still running the previously loaded extension content.',
        'Open chrome://extensions and click the reload arrow on Fast Browser. '
        + 'If you just did, rerun doctor in a moment: Chrome records the reload '
        + 'on a short delay.',
      );
    },
    pairing: async () => (
      config?.connection.mode !== 'auto'
      || await (dependencies.hasToken ?? hasToken)()
        ? pass(config?.connection.mode === 'auto'
          ? 'Automatic pairing is available.'
          : 'Manual extension connection is configured.')
        : fail('Automatic pairing is missing.', 'Run `fast-browser configure --connection auto`.')
    ),
    'data-permissions': async () => {
      if (dependencies.checkDataPermissions) {
        await dependencies.checkDataPermissions(paths);
        return pass('Fast Browser data permissions are private.');
      }
      const [directory, configFile] = await Promise.all([
        lstat(paths.dataDir),
        lstat(paths.configFile),
      ]);
      return (
        !directory.isSymbolicLink()
        && directory.isDirectory()
        && (directory.mode & 0o777) === 0o700
        && !configFile.isSymbolicLink()
        && configFile.isFile()
        && (configFile.mode & 0o777) === 0o600
      )
        ? pass('Fast Browser data permissions are private.')
        : fail('Fast Browser data permissions are unsafe.', 'Run `fast-browser setup` to repair permissions.');
    },
  };

  const openMcpTransport = dependencies.openMcpTransport ?? (async (options = {}) => {
    if (!config || !lock) throw new Error('runtime configuration unavailable');
    const cli = await installedRuntime(paths, lock);
    let token = null;
    if (config.connection.mode === 'auto') {
      token = await (dependencies.readToken ?? readToken)();
      if (!token) throw new Error('pairing token unavailable');
    }
    const env = token
      ? { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: token }
      : process.env;
    try {
      return await (dependencies.openNdjsonProcess ?? openNdjsonProcess)(
        process.execPath,
        [cli, ...runtimeArgs({ config, paths, lock })],
        {
          env,
          outputCapBytes: options.outputCapBytes,
        },
      );
    } finally {
      token = null;
    }
  });
  return {
    ...dependencies,
    paths,
    config,
    lock,
    checks: { ...checks, ...dependencies.checks },
    openMcpTransport,
  };
}

function normalizedResult(id, value) {
  if (
    !value
    || typeof value !== 'object'
    || !STATUSES.has(value.status)
    || typeof value.message !== 'string'
    || !(value.remediation === null || typeof value.remediation === 'string')
  ) {
    return {
      id,
      status: 'fail',
      message: `${id} check returned an invalid result.`,
      remediation: `Run \`fast-browser doctor\` after fixing ${id}.`,
    };
  }
  return {
    id,
    status: value.status,
    message: value.message.replaceAll('\n', ' '),
    remediation: value.remediation?.replaceAll('\n', ' ') ?? null,
  };
}

function failedResult(id) {
  const label = id === 'chrome' ? 'Chrome' : id;
  return {
    id,
    status: 'fail',
    message: `${label} check failed.`,
    remediation: `Run \`fast-browser doctor\` after fixing ${label}.`,
  };
}

async function profileFor(request, dependencies, paths) {
  if (request.profile === 'safe' || request.profile === 'full') return request.profile;
  if (dependencies.config?.profile) return dependencies.config.profile;
  try {
    return (await (dependencies.loadConfig ?? loadSavedConfig)(paths)).profile;
  } catch {
    return 'safe';
  }
}

export async function doctor(request = {}, dependencies = {}) {
  const paths = dependencies.paths ?? resolvePaths({
    homeDir: dependencies.homeDir,
    pluginRoot: dependencies.pluginRoot ?? PLUGIN_ROOT,
  });
  const composed = await productionDependencies(request, dependencies, paths);
  const profile = await profileFor(request, composed, paths);
  const context = {};
  const checks = [];
  for (const id of DOCTOR_CHECK_IDS) {
    const implementation = composed.checks?.[id]
      ?? defaultCheck(id, composed);
    try {
      checks.push(normalizedResult(id, await implementation(context)));
    } catch {
      checks.push(failedResult(id));
    }
  }
  return {
    schemaVersion: 1,
    ok: checks.every(({ status }) => status !== 'fail'),
    profile,
    checks,
  };
}
