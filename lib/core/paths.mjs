import os from 'node:os';
import path from 'node:path';

export function resolvePaths({
  homeDir = process.env.HOME || os.homedir(),
  pluginRoot,
} = {}) {
  const dataDir = path.join(homeDir, '.fast-browser');

  return {
    homeDir,
    pluginRoot,
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    runtimeDir: path.join(dataDir, 'runtime'),
    extensionDir: path.join(dataDir, 'extension'),
    macrosDir: path.join(dataDir, 'macros'),
    sessionsDir: path.join(dataDir, 'sessions'),
    archiveDir: path.join(dataDir, 'archive'),
    backupsDir: path.join(dataDir, 'backups'),
    macroFailuresFile: path.join(dataDir, 'macro-failures.json'),
  };
}
