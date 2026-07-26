import { performance } from 'node:perf_hooks';

export function createMetrics() {
  const calls = [];

  return {
    async measure(name, operation) {
      const startedAt = performance.now();
      try {
        return await operation();
      } finally {
        calls.push({ name, startedAt, endedAt: performance.now() });
      }
    },
    summary() {
      const byTool = {};
      for (const call of calls) byTool[call.name] = (byTool[call.name] ?? 0) + 1;
      return {
        calls: calls.length,
        byTool,
        elapsedMs: calls.reduce((total, call) => total + call.endedAt - call.startedAt, 0),
      };
    },
  };
}
