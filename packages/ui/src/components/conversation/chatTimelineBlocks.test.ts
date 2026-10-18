import { expect, it } from 'vitest';
import { projectChatTimeline } from './chatTimelineProjection';
import { projectChatTimelineBlocks, type ChatTimelineBlockAliases } from './chatTimelineBlocks';
import type { ChatAssistantMessage, ChatSessionEntry, ChatSessionMessageEntry } from './types';

const user: ChatSessionMessageEntry = { id: 'prompt', parentId: null, runId: 'run', timestamp: '', type: 'message', message: { role: 'user', content: 'Question', timestamp: 0 } };
const answer = (id: string, content: ChatAssistantMessage['content']): ChatSessionMessageEntry => ({ id, parentId: user.id, runId: 'run', timestamp: '', type: 'message',
  message: { id, role: 'assistant', model: 'model', provider: '', api: '', stopReason: 'stop', timestamp: 0, content } });

it('keeps native message keys when an earlier prompt is discovered and virtualizes a long Run into small rows', () => {
  const messages = Array.from({ length: 200 }, (_, index) => answer(`answer:${index}`, [{ type: 'text', text: `${index}` }]));
  const aliases: ChatTimelineBlockAliases = new Map();
  const orphan = projectChatTimelineBlocks(projectChatTimeline(messages), { sorted: false, expanded: () => true, aliases });
  const joined = projectChatTimelineBlocks(projectChatTimeline([user, ...messages]), { sorted: false, expanded: () => true, previous: orphan, aliases });
  expect(joined.items.filter(item => item.kind === 'entry').map(item => item.id)).toEqual(orphan.items.filter(item => item.kind === 'entry').map(item => item.id));
  expect(joined.items.filter(item => item.kind === 'entry')).toHaveLength(messages.length);
  expect(joined.items.filter(item => item.kind === 'footer')).toHaveLength(1);
  expect(joined.items.find(item => item.kind === 'chrome')?.id).toBe(orphan.items.find(item => item.kind === 'chrome')?.id);
  expect(joined.items.find(item => item.kind === 'footer')?.id).toBe(orphan.items.find(item => item.kind === 'footer')?.id);
  expect(joined.items[0]).toMatchObject({ id: 'turn:prompt', kind: 'user' });
  const returned = projectChatTimelineBlocks(projectChatTimeline([user, ...messages]), { sorted: false, expanded: () => true, aliases });
  expect(returned.items.map(item => item.id)).toEqual(joined.items.map(item => item.id));
});

it('keeps sorted activities separately virtualized and preserves row identity across streaming deltas', () => {
  const call = answer('call', [{ type: 'thinking', thinking: 'Reason' }, { type: 'toolCall', id: 'call-id', name: 'read', arguments: {} }]);
  const entries = [user, call];
  const live: ChatAssistantMessage = { ...answer('live', [{ type: 'text', text: 'A' }]).message as ChatAssistantMessage, runId: 'run', stopReason: 'pending' };
  const first = projectChatTimeline(entries, live);
  const before = projectChatTimelineBlocks(first, { sorted: true, expanded: () => true });
  const next = projectChatTimeline(entries, { ...live, content: [{ type: 'text', text: 'Answer continues' }] }, undefined, first);
  const after = projectChatTimelineBlocks(next, { sorted: true, expanded: () => true, previous: before });
  expect(after.items).toBe(before.items);
  expect(after.items.filter(item => item.kind === 'activity')).toHaveLength(2);
  const closed = projectChatTimelineBlocks(next, { sorted: true, expanded: () => false, previous: after });
  expect(closed.items.filter(item => item.kind === 'activity')).toHaveLength(0);
  expect(closed.items.filter(item => item.kind === 'activity-header')).toHaveLength(1);
  expect(closed.items.some(item => item.kind === 'entry' && item.entry.id === call.id)).toBe(false);
  const custom = projectChatTimelineBlocks(next, { sorted: true, expanded: () => true, customIds: new Set([call.id]) });
  expect(custom.items.some(item => item.kind === 'entry' && item.entry.id === call.id)).toBe(true);
  expect(custom.items.some(item => item.kind === 'activity')).toBe(false);
  const summary: ChatSessionEntry = { id: 'run-usage:run', parentId: call.id, timestamp: '', type: 'run_usage', runId: 'run', usages: [{ requestId: 'request', input: 100, output: 20, measurement: 'actual', unknownReceipts: 0 }] };
  const ended = projectChatTimelineBlocks(projectChatTimeline([...entries, summary]), { sorted: true, expanded: () => true, previous: after });
  expect(ended.items.filter(item => item.kind === 'footer')).toHaveLength(1);
  expect(ended.items.filter(item => item.kind === 'entry').some(item => item.entry.type === 'run_usage')).toBe(false);
});
