import { describe, expect, it } from 'vitest';
import { parseCompactionTraceDetails } from './compactionTrace';

describe('saved compaction worker transcript', () => {
  it('reopens the worker transcript stored on a native Pi compaction entry', () => {
    const trace = { taskId: 'task-a', entries: [{ kind: 'assistant', at: 1, text: 'Continue the task.' }] };
    expect(parseCompactionTraceDetails({ varinCompactionTrace: trace })).toEqual(trace);
    expect(parseCompactionTraceDetails({ varinCompactionTrace: { taskId: 'task-a', entries: [{}] } })).toBeNull();
  });
});
