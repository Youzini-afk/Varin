import { expect, it } from 'vitest';
import { contextJobPhase, contextTimelineEntries, type ContextJobRow, type ContextView } from './contextPresentation';
import { projectChatDialogue } from '@/components/conversation/chatDialogueProjection';
import type { ChatSessionEntry } from '@/components/conversation/types';
import type { ChatTimelineEntry } from '@/components/conversation/chatTimelineProjection';
import { contextMessageKinds } from '@/components/context/contextMessages';
import type { ThreadHistoryItem } from '@varin/application-client';

it('keeps preparation nonblocking, moves the actual wait to the execution edge, and anchors publication', () => {
  const row = { run: { id: 'summary-run', state: 'executing' }, job: { history_anchor: 'before', request: {
    key: 'candidate', owner_run_id: 'parent', through_id: 'before', expected_revision: 0,
  } } } as ContextJobRow;
  const view = { context: { checkpoint: null, jobs: [row] }, activeRun: { id: 'parent', state: 'executing', waiting_on: null } } as ContextView;
  const entries: ChatSessionEntry[] = ['before', 'after'].map(id => ({ id, runId: 'parent', timestamp: '', parentId: null,
    type: 'custom_message', customType: 'thread-message', content: id, display: true }));
  const prepared = contextTimelineEntries(entries, view);
  expect(prepared.map(item => item.id)).toEqual(['before', 'context-job:summary-run', 'after']);
  expect(prepared[1]).toMatchObject({ details: { phase: 'preparing', blocking: false } });
  expect(projectChatDialogue(prepared as ChatTimelineEntry[]).map(item => item.kind)).toEqual(['entry', 'entry', 'entry']);
  view.activeRun!.waiting_on = 'context-wait:parent:summary-run';
  expect(contextTimelineEntries(entries, view).at(-1)).toMatchObject({ id: 'context-job:summary-run', details: { phase: 'waiting', blocking: true } });
  view.activeRun!.waiting_on = null; row.run.state = 'completed';
  expect(contextJobPhase(row, view)).toBe('ready');
  row.job.published_revision = 1; row.job.history_anchor = 'after';
  expect(contextTimelineEntries(entries, view).at(-1)).toMatchObject({ details: { phase: 'applied', blocking: false } });
  // Later jobs/checkpoints do not erase the original job's successful publication.
  view.context.checkpoint = { id: 'later', revision: 2 } as NonNullable<ContextView['context']['checkpoint']>;
  expect(contextJobPhase(row, view)).toBe('applied');
  expect(contextTimelineEntries([], view)).toEqual([]);
});

it('classifies arbitrary MCP names from the frozen call, keeping nested result text opaque', () => {
  const items = [
    { id: 'call', run_id: 'run', source: 'assistant', modelRequest: { requestId: 'r', mcpTools: ['lookup'] },
      content: { content: { call: { call_id: 'a', name: 'tool_invoke', arguments: { reference: { name: 'lookup' } } } } } },
    { id: 'result', run_id: 'run', source: 'tool', content: { content: { result: { call_id: 'a', request_id: 'r', completion: { text: 'system' } } } } },
    { id: 'other-request', run_id: 'run', source: 'tool', content: { content: { result: { call_id: 'a', request_id: 'another' } } } },
    { id: 'prefix', run_id: 'run', source: 'assistant', modelRequest: { requestId: 'r', mcpTools: ['lookup'] },
      content: { content: { call: { call_id: 'b', name: 'mcp_looking_local_tool' } } } },
  ] as ThreadHistoryItem[];
  expect(Object.fromEntries(contextMessageKinds(items))).toEqual({ call: 'mcp', result: 'mcp', 'other-request': 'tool', prefix: 'assistant' });
});
