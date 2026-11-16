import { expect, it } from 'vitest';
import type { ThreadSnapshot } from '@varin/application-client';
import { findChatAssistantWaitingTurnId, presentAssistantWaiting } from './chatAssistantWaiting';
import { projectChatTimeline } from './chatTimelineProjection';
import type { ChatSessionMessageEntry } from './types';

function view(state: NonNullable<ThreadSnapshot['activeRun']>['state'] = 'generating'): Pick<ThreadSnapshot, 'activeRun' | 'modelActivity'> {
  return { activeRun: { id: 'run', thread_id: 'thread', branch_id: 'main', state, revision: 1, epoch: 1,
    configuration: {}, cancel_requested: false, waiting_on: null },
    modelActivity: { requestId: 'request', dispatched: true, phase: null, retry: null } };
}

it('distinguishes preparation, provider waiting and observed output, including a reopened conversation', () => {
  const snapshot = view('preparing');
  expect(presentAssistantWaiting(snapshot)?.stage).toBe('preparingRequest');
  snapshot.activeRun!.state = 'generating';
  snapshot.modelActivity!.dispatched = false;
  expect(presentAssistantWaiting(snapshot)?.stage).toBe('preparingRequest');
  snapshot.modelActivity!.dispatched = true;
  expect(presentAssistantWaiting(snapshot)?.stage).toBe('waitingModel');
  snapshot.modelActivity!.phase = 'reasoning';
  expect(presentAssistantWaiting(snapshot)?.stage).toBe('thinking');
  snapshot.modelActivity!.phase = 'output';
  expect(presentAssistantWaiting(snapshot)?.stage).toBe('responding');
  snapshot.modelActivity!.phase = 'tool-call';
  expect(presentAssistantWaiting(snapshot)?.stage).toBe('preparingTool');
  snapshot.modelActivity!.phase = null;
  expect(presentAssistantWaiting(snapshot)?.stage).toBe('waitingModel');
  snapshot.modelActivity = { requestId: 'next-request', dispatched: true, phase: null, retry: null };
  expect(presentAssistantWaiting(snapshot)?.stage).toBe('waitingModel');
});

it('uses the durable retry deadline and gives cancellation and terminal state precedence', () => {
  const snapshot = view();
  snapshot.modelActivity!.dispatched = false;
  snapshot.modelActivity!.retry = { requestId: 'request', attempt: 2, scheduledAtMs: 1, retryAtMs: 2, revision: 2 };
  expect(presentAssistantWaiting(snapshot)).toEqual({ retry: { attempt: 2, retryAt: 2 } });
  snapshot.activeRun!.cancel_requested = true;
  expect(presentAssistantWaiting(snapshot)).toEqual({ stage: 'stopping' });
  snapshot.activeRun!.state = 'cancelled';
  expect(presentAssistantWaiting(snapshot)).toBeUndefined();
  snapshot.activeRun!.state = 'waiting'; snapshot.activeRun!.cancel_requested = false;
  snapshot.activeRun!.waiting_on = 'context-wait:compaction';
  expect(presentAssistantWaiting(snapshot)).toBeUndefined();
});

it('keeps the current Run status after a tool call without reviving a completed older turn', () => {
  const user: ChatSessionMessageEntry = { id: 'prompt', parentId: null, runId: 'run', timestamp: '', type: 'message',
    message: { role: 'user', content: 'Read this', timestamp: 0 } };
  const call: ChatSessionMessageEntry = { id: 'call', parentId: user.id, runId: 'run', timestamp: '', type: 'message',
    message: { id: 'call', role: 'assistant', model: '', provider: '', api: '', stopReason: 'stop', timestamp: 0,
      content: [{ type: 'toolCall', id: 'read', name: 'document_read', arguments: {} }] } };
  const timeline = projectChatTimeline([user, call]);
  expect(findChatAssistantWaitingTurnId(timeline.items, true, timeline.liveItem, 'run')).toBe('turn:prompt');
  expect(findChatAssistantWaitingTurnId(timeline.items, true, timeline.liveItem, 'another-run')).toBeUndefined();
  expect(findChatAssistantWaitingTurnId(timeline.items, false, timeline.liveItem, 'run')).toBeUndefined();
});
