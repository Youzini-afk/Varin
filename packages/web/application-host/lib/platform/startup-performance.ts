const ENABLED_VALUES = new Set(['1', 'true']);
const ALLOWED_PHASES = new Set([
  'web.pipeline.start',
  'web.listener.ready',
]);
const ALLOWED_OUTCOMES = new Set(['ready', 'timeout', 'aborted', 'error']);
const ALLOWED_ROUTE_CLASSES = new Set(['thread-messages', 'thread', 'events', 'other']);

const finiteNonNegative = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
);
const nonNegativeInteger = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
);

const isStartupPerformanceEnabled = () => (
  ENABLED_VALUES.has(String(process.env.VARIN_STARTUP_PERF ?? '').toLowerCase())
);

export interface StartupPerformanceDetails extends Record<string, unknown> {
  attempt?: unknown;
  durationMs?: unknown;
  outcome?: unknown;
  routeClass?: unknown;
  totalDurationMs?: unknown;
}

interface StartupPerformanceEvent {
  at: number;
  attempt?: number | undefined;
  durationMs?: number | undefined;
  outcome?: string | undefined;
  phase: string;
  routeClass?: string | undefined;
  totalDurationMs?: number | undefined;
}

export const recordStartupPerformance = (
  phase: string,
  details: StartupPerformanceDetails = {},
): void => {
  if (!isStartupPerformanceEnabled() || !ALLOWED_PHASES.has(phase)) return;

  const event: StartupPerformanceEvent = {
    phase,
    at: Date.now(),
  };
  const durationMs = finiteNonNegative(details.durationMs);
  const totalDurationMs = finiteNonNegative(details.totalDurationMs);
  const attempt = nonNegativeInteger(details.attempt);
  if (durationMs !== undefined) event.durationMs = durationMs;
  if (totalDurationMs !== undefined) event.totalDurationMs = totalDurationMs;
  if (attempt !== undefined) event.attempt = attempt;
  if (typeof details.outcome === 'string' && ALLOWED_OUTCOMES.has(details.outcome)) {
    event.outcome = details.outcome;
  }
  if (typeof details.routeClass === 'string' && ALLOWED_ROUTE_CLASSES.has(details.routeClass)) {
    event.routeClass = details.routeClass;
  }

  console.info('[startup-performance]', event);
};
