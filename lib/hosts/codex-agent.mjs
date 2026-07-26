import { readFileSync } from 'node:fs';

const PREFERRED_MODEL = 'gpt-5.6-terra';
const TEMPLATE = readFileSync(
  new URL('../../templates/codex/browser_driver.toml', import.meta.url),
  'utf8',
);
const TOKEN_LINE = '{{MODEL_LINE}}\n';

export function shouldUsePreferredCodexModel(versionText) {
  if (typeof versionText !== 'string') return false;
  const match =
    /^\s*(?:(?:codex-cli|codex)\s+)?(\d+)\.(\d+)\.(\d+)\s*$/.exec(
      versionText,
    );
  if (!match) return false;
  const version = match.slice(1, 4).map(Number);
  const minimum = [0, 145, 0];
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) {
      return version[index] > minimum[index];
    }
  }
  return true;
}

export function renderCodexAgent({ usePreferredModel }) {
  if (!TEMPLATE.includes(TOKEN_LINE)) {
    throw new Error('Codex browser-driver template is missing its model token');
  }
  const modelLine = usePreferredModel
    ? `model = "${PREFERRED_MODEL}"\n`
    : '';
  const rendered = TEMPLATE.replace(TOKEN_LINE, modelLine);
  if (rendered.includes('{{MODEL_LINE}}')) {
    throw new Error('Codex browser-driver template has duplicate model tokens');
  }
  return rendered;
}

export function removePreferredModelLine(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Codex agent text must be a string');
  }
  const line = /^model = "gpt-5\.6-terra"(?:\r\n|\n|$)/gm;
  const matches = text.match(line) ?? [];
  if (matches.length > 1) {
    throw new Error('duplicate owned preferred-model lines');
  }
  return matches.length === 0 ? text : text.replace(line, '');
}

export async function runWithCodexModelFallback({
  run,
  rewriteOwnedAgent,
  isPreferredModelRejection,
}) {
  try {
    return await run();
  } catch (error) {
    if (!isPreferredModelRejection(error)) throw error;
    await rewriteOwnedAgent();
    return run();
  }
}
