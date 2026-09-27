import type { CompactionTrace, JsonValue } from '@varin/protocol';

export const PI_COMPACTION_TRACE_OPEN_EVENT = 'varin:open-compaction-trace';

export const parseCompactionTraceDetails = (details: JsonValue | undefined): CompactionTrace | null => {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const trace = details.varinCompactionTrace;
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) return null;
  if (typeof trace.taskId !== 'string' || !Array.isArray(trace.entries)) return null;
  if (!trace.entries.every((entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry.kind === 'assistant' || entry.kind === 'tool-call' || entry.kind === 'tool-result')
    && typeof entry.at === 'number'
  ))) return null;
  return trace as unknown as CompactionTrace;
};
