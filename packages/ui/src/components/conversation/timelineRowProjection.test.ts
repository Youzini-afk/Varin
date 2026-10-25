import { expect, it, vi } from 'vitest';
import { projectChatTimeline } from './chatTimelineProjection';
import { projectChatTimelineBlocks } from './chatTimelineBlocks';
import { projectTimelineRow } from './timelineRowProjection';
import type { ConversationPresentation } from './ConversationContext';
import type { ChatSessionMessageEntry, ChatToolExecutionState } from './types';

it('isolates unrelated tool progress while keeping gateway child updates and new results', () => {
  const user: ChatSessionMessageEntry = { type: 'message', id: 'user', parentId: null, timestamp: '', message: { role: 'user', content: 'Question', timestamp: 0 } };
  const call: ChatSessionMessageEntry = { type: 'message', id: 'answer', parentId: 'user', runId: 'run', timestamp: '', message: {
    role: 'assistant', id: 'answer', model: 'model', provider: '', api: '', timestamp: 0, stopReason: 'stop',
    content: [{ type: 'toolCall', id: 'own', name: 'script_run', arguments: {} }],
  } };
  const source = projectChatTimeline([user, call]);
  const block = projectChatTimelineBlocks(source, { sorted: false, expanded: () => true }).items.find(item => item.kind === 'entry')!;
  const execution = (status: ChatToolExecutionState['status'], parentToolCallId?: string) => ({ status, parentToolCallId } as ChatToolExecutionState);
  const own = execution('running'), child = execution('running', 'own');
  const context = { identity: { threadId: 'thread' }, head: 'answer', api: {}, quote: vi.fn(), openFile: vi.fn(), fileTarget: vi.fn(),
    toolExecutions: { own, child, elsewhere: execution('running') }, uiCards: {},
  } as unknown as ConversationPresentation;
  const first = projectTimelineRow(block, source, context);
  expect(Object.keys(first.presentation.toolExecutions)).toEqual(['own', 'child']);
  const other = projectTimelineRow(block, { ...source }, { ...context, uiCards: {}, toolExecutions: { own, child, elsewhere: execution('success') } });
  expect(other).toBe(first);
  const next = projectTimelineRow(block, source, { ...context, toolExecutions: { own, child: execution('error', 'own') } });
  expect(next.presentation.toolExecutions.child?.status).toBe('error');
  expect(next.presentation).not.toBe(first.presentation);
  const result: ChatSessionMessageEntry = { type: 'message', id: 'result', parentId: 'answer', runId: 'run', timestamp: '', message: {
    role: 'toolResult', toolCallId: 'own', toolName: 'script_run', content: [{ type: 'text', text: 'done' }], isError: false, timestamp: 0,
  } };
  const finished = projectChatTimeline([user, call, result]);
  expect(projectTimelineRow(block, finished, context).projection.resultByCallId.get('own')).toBe(finished.resultByCallId.get('own'));
});
