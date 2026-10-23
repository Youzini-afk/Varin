import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

export type LocalCpuMode = 'auto' | 'efficient' | 'performance';
export type LocalCpuSettings = { mode?: LocalCpuMode; maxThreads?: number | null };

/** Sampling is demand-driven; an idle encoder has no polling timer. Remove
 * this process's own CPU time so indexing does not mistake itself for another app. */
export function createCpuPressureSampler() {
  let previous = os.cpus();
  let previousOwn = process.cpuUsage();
  let previousAt = performance.now();
  let pressure = 0;
  return () => {
    const now = performance.now();
    if (now - previousAt < 1000) return pressure;
    const current = os.cpus();
    const own = process.cpuUsage();
    let total = 0, idle = 0;
    current.forEach((cpu, index) => {
      const before = previous[index];
      if (!before) return;
      for (const key of ['user', 'nice', 'sys', 'idle', 'irq'] as const) total += cpu.times[key] - before.times[key];
      idle += cpu.times.idle - before.times.idle;
    });
    const ownShare = (own.user + own.system - previousOwn.user - previousOwn.system)
      / ((now - previousAt) * 1000 * Math.max(1, current.length));
    if (total > 0) pressure = Math.max(0, Math.min(1, 1 - idle / total - ownShare));
    previous = current; previousOwn = own; previousAt = now;
    return pressure;
  };
}

/** These are execution preferences, not admission quotas. Every input is
 * processed; an individual long input can exceed the scheduling quantum. */
export function createLocalCpuPolicy(options: {
  parallelism: number;
  settings?: LocalCpuSettings;
  maxBatchSize: number;
  maxTokens: number;
  initialThreads?: number;
  samplePressure?: () => number;
  now?: () => number;
}) {
  const mode = options.settings?.mode ?? 'auto';
  const share = mode === 'efficient' ? .25 : mode === 'performance' ? .9 : .5;
  // Auto's 50ms quantum follows the observed ~80–90ms query waits with a
  // two-input background grain. Performance explicitly favors longer batches.
  const quantumMs = mode === 'efficient' ? 25 : mode === 'performance' ? 100 : 50;
  const ceiling = Math.max(1, Math.min(options.parallelism,
    options.settings?.maxThreads ?? Math.ceil(options.parallelism * share)));
  const now = options.now ?? (() => performance.now());
  const sample = options.samplePressure ?? createCpuPressureSampler();
  const workOf = (tokens: number) => tokens * (tokens + 256);
  // A measured model hint selects the starting point, not the user's ceiling.
  // Explicit thread budgets override it. More threads are not always faster.
  const preferredThreads = Math.min(ceiling, options.settings?.maxThreads ?? options.initialThreads ?? ceiling);
  let threads = preferredThreads;
  let candidate = threads, candidateSince = now(), changedAt = now();
  let loadMs = 0;
  // Begin with one near-window input; learn larger grains from real forwards.
  let costMs = quantumMs / workOf(options.maxTokens);
  let nextBackgroundAt = 0;
  let lastForegroundAt = -Infinity;
  let batches = 0, lastBatchSize = 0;
  const coreBudget = () => Math.max(.25, options.parallelism * (1 - sample()) * share);
  const desiredThreads = () => Math.max(1, Math.min(preferredThreads, Math.ceil(coreBudget())));
  return {
    get initialThreads() { return preferredThreads; },
    nextThreads(priority: 'foreground' | 'background') {
      const target = desiredThreads();
      if (candidate !== target) { candidate = target; candidateSince = now(); }
      // Reconfiguration rebuilds an ORT session. Only change at a background
      // boundary after stable demand and at least 20x its measured load cost.
      if (priority === 'background' && now() - candidateSince >= 5000
        && now() - changedAt >= Math.max(5000, 20 * loadMs)) {
        if (threads !== target) {
          costMs *= threads / target;
          threads = target; changedAt = now();
        }
      }
      return threads;
    },
    selectBatchSize(lengths: readonly number[]) {
      const quantum = now() - lastForegroundAt < 1000 ? quantumMs / 2 : quantumMs;
      let size = 0, longest = 0;
      while (size < lengths.length && size < options.maxBatchSize) {
        const nextLongest = Math.max(longest, lengths[size]!);
        if (size > 0 && (size + 1) * workOf(nextLongest) * costMs > quantum) break;
        longest = nextLongest; size += 1;
      }
      return size;
    },
    record(input: { lengths: readonly number[]; durationMs: number; cpuMs: number;
      threads: number; loadMs?: number; priority: 'foreground' | 'background' }) {
      if (input.loadMs !== undefined) loadMs = input.loadMs;
      if (input.priority === 'foreground') lastForegroundAt = now();
      threads = input.threads;
      const work = input.lengths.length * workOf(Math.max(1, ...input.lengths));
      // Short/coalesced queries have different fixed overhead; learn the
      // background grain from background work only.
      if (input.priority === 'background' && input.durationMs > 0 && work > 0) {
        costMs = .7 * costMs + .3 * input.durationMs / work;
      }
      if (input.priority === 'background') {
        nextBackgroundAt = now() + Math.max(0, input.cpuMs / coreBudget() - input.durationMs);
      }
      batches += 1; lastBatchSize = input.lengths.length;
    },
    async waitForBackground(signal?: AbortSignal) {
      signal?.throwIfAborted();
      const wait = nextBackgroundAt - now();
      if (wait > 0) await delay(wait, undefined, { signal });
    },
    snapshot: () => ({ mode, threadCeiling: ceiling, threads, batches, lastBatchSize,
      quantumMs, predictedMsPerWork: costMs, backgroundWaitMs: Math.max(0, nextBackgroundAt - now()) }),
  };
}
