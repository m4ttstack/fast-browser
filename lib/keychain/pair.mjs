import { parseConfig } from '../core/config.mjs';
import {
  deleteToken as deleteKeychainToken,
  hasToken as keychainHasToken,
  writeTokenFromPrompt as promptForKeychainToken,
} from './keychain.mjs';

const PAIRING_INSTRUCTIONS = [
  '1. Open the Fast Browser extension status page.',
  '2. Copy the raw reconnect token.',
  '3. Paste it into the secure macOS Keychain prompt below.',
];

export class PairingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PairingError';
  }
}

function stdoutLine(line) {
  process.stdout.write(`${line}\n`);
}

async function persistIfRequested(config, updateConfig) {
  if (typeof updateConfig === 'function') await updateConfig(config);
}

export async function pairAutoConnect(config, dependencies = {}) {
  const current = parseConfig(config);
  const {
    print = stdoutLine,
    writeTokenFromPrompt = promptForKeychainToken,
    hasToken = keychainHasToken,
    updateConfig,
  } = dependencies;

  for (const line of PAIRING_INSTRUCTIONS) print(line);
  await writeTokenFromPrompt(dependencies);
  if (!await hasToken(dependencies)) {
    throw new PairingError('Keychain token is missing after secure prompt');
  }

  const updated = parseConfig({
    ...current,
    connection: { mode: 'auto' },
  });
  await persistIfRequested(updated, updateConfig);
  return updated;
}

export async function setManualConnection(config, dependencies = {}) {
  const current = parseConfig(config);
  const {
    confirmDeleteToken,
    deleteToken = deleteKeychainToken,
    updateConfig,
  } = dependencies;

  if (
    current.connection.mode === 'auto'
    && typeof confirmDeleteToken === 'function'
    && await confirmDeleteToken()
  ) {
    await deleteToken(dependencies);
  }

  const updated = parseConfig({
    ...current,
    connection: { mode: 'manual' },
  });
  await persistIfRequested(updated, updateConfig);
  return updated;
}
