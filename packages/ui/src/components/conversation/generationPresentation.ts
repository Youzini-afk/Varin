import type { ProgressActivity } from '@/lib/agent-runtime/thread-projection';
import type { ChatUsage } from './types';

export function generationPresentation(usages: readonly ChatUsage[], live?: ProgressActivity) {
  const requests = new Map<string, { metrics: NonNullable<ChatUsage['generation']>; output: number; actual: boolean }>();
  for (const usage of usages) if (usage.requestId && usage.generation) requests.set(usage.requestId, {
    metrics: usage.generation, output: usage.output ?? usage.generation.outputTokens,
    actual: usage.output !== undefined ? usage.measurement === 'actual' : usage.generation.measurement === 'actual',
  });
  if (live?.requestId && live.generation?.finished && !requests.has(live.requestId)) requests.set(live.requestId, {
    metrics: live.generation, output: live.generation.outputTokens, actual: live.generation.measurement === 'actual',
  });
  const values = [...requests.values()].filter(value => value.metrics.elapsedMs > 0).sort((a, b) => a.metrics.startedAtMs - b.metrics.startedAtMs);
  if (!values.length) return undefined;
  const elapsed = values.reduce((total, value) => total + value.metrics.elapsedMs, 0);
  return { rate: values.reduce((total, value) => total + value.output, 0) * 1000 / elapsed,
    firstOutputMs: values[0]!.metrics.firstOutputMs, actual: values.every(value => value.actual) };
}
