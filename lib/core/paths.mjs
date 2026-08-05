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
    macroIndexFile: path.join(dataDir, 'macros', 'MACROS.md'),
    flowsDir: path.join(dataDir, 'flows'),
    flowsPendingDir: path.join(dataDir, 'flows-pending'),
    flowsStateFile: path.join(dataDir, 'flows-state.json'),
    sessionsDir: path.join(dataDir, 'sessions'),
    screenshotsDir: path.join(dataDir, 'screenshots'),
    // Written by the runtime, not this plugin: --save-video records into the
    // `videos` subdirectory of --output-dir, which launchRuntime pins to
    // dataDir. Named here so the `gif` command and the runtime agree on the
    // location through one definition.
    videosDir: path.join(dataDir, 'videos'),
    archiveDir: path.join(dataDir, 'archive'),
    backupsDir: path.join(dataDir, 'backups'),
    macroFailuresFile: path.join(dataDir, 'macro-failures.md'),
    rejectedMacrosFile: path.join(dataDir, 'rejected-macros.md'),
    rejectedFlowsFile: path.join(dataDir, 'rejected-flows.md'),
    // Deliberately outside dataDir: ~/.local/bin is the conventional
    // user-writable bin directory shells already put on PATH, which is the
    // whole point of the launcher. Derived here rather than from os.homedir()
    // at any use site so every consumer and every test resolves it from the
    // same injected home.
    launcherDir: path.join(homeDir, '.local', 'bin'),
    launcherFile: path.join(homeDir, '.local', 'bin', 'fast-browser'),
  };
}
