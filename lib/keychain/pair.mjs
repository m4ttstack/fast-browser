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

export async function pairAutoConnect(config, dependencies = {}) {
  const {
    print = stdoutLine,
    writeTokenFromPrompt = promptForKeychainToken,
    hasToken = keychainHasToken,
    updateConfig,
  } = dependencies;
  if (typeof updateConfig !== 'function') {
    throw new PairingError('automatic pairing requires config persistence');
  }
  const current = parseConfig(config);

  for (const line of PAIRING_INSTRUCTIONS) print(line);
  await writeTokenFromPrompt(dependencies);
  if (!await hasToken(dependencies)) {
    throw new PairingError('Keychain token is missing after secure prompt');
  }

  const updated = parseConfig({
    ...current,
    connection: { mode: 'auto' },
  });
  try {
    await updateConfig(updated);
  } catch {
    throw new PairingError(
      'unable to save automatic connection; Keychain token was preserved; '
      + 'fix config storage and retry',
    );
  }
  return updated;
}

export async function setManualConnection(config, dependencies = {}) {
  const current = parseConfig(config);
  const {
    confirmDeleteToken,
    deleteToken = deleteKeychainToken,
    updateConfig,
  } = dependencies;

  const updated = parseConfig({
    ...current,
    connection: { mode: 'manual' },
  });

  let confirmed = false;
  if (current.connection.mode === 'auto' && typeof confirmDeleteToken === 'function') {
    try {
      confirmed = await confirmDeleteToken();
    } catch {
      throw new PairingError(
        'unable to confirm Keychain deletion; existing connection configuration was preserved',
      );
    }
  }

  if (confirmed && typeof updateConfig !== 'function') {
    throw new PairingError(
      'manual connection requires config persistence before Keychain deletion',
    );
  }

  if (typeof updateConfig === 'function') {
    try {
      await updateConfig(updated);
    } catch {
      const previous = current.connection.mode === 'auto' ? 'automatic' : 'manual';
      throw new PairingError(
        `unable to save manual connection; ${previous} connection remains configured`,
      );
    }
  }

  if (confirmed) {
    try {
      await deleteToken(dependencies);
    } catch {
      throw new PairingError(
        'manual connection was saved, but the Keychain token could not be deleted; '
        + 'remove it from macOS Keychain before re-enabling automatic connection',
      );
    }
  }

  return updated;
}
