import { run as runProcess } from '../core/process.mjs';

const HOSTS = ['claude', 'codex'];

export async function detectHosts({ run = runProcess } = {}) {
  const detected = [];
  for (const host of HOSTS) {
    try {
      await run(host, ['--version']);
      detected.push(host);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      const code = typeof error?.code === 'string' ? error.code : 'unknown error';
      throw new Error(`unable to detect ${host} CLI: ${code}`);
    }
  }
  return detected;
}
