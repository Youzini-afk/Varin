import { describe, expect, test } from 'vitest';
import type {
  PiAssistantMessage,
  PiSessionEntry,
  PiSessionMessageEntry,
  PiUserMessage,
} from '@varin/protocol';
import { VARIN_RECOVERY_NAVIGATION_MARKER_TYPE } from '@varin/protocol';
import { projectPiTimeline, resolvePiTimelineItem } from './piTimelineProjection';

const assistant = (text: string, timestamp = 1): PiAssistantMessage => ({
  api: 'messages',
  content: [{ text, type: 'text' }],
  model: 'model',
  provider: 'provider',
  role: 'assistant',
  stopReason: 'stop',
  timestamp,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const userEntry = (id: string, content: string, timestamp: number): PiSessionMessageEntry => ({
  id,
  message: { content, role: 'user', timestamp },
  parentId: null,
  timestamp: String(timestamp),
  type: 'message',
});

const assistantEntry = (id: string, message: PiAssistantMessage): PiSessionMessageEntry => ({
  id,
  message,
  parentId: null,
  timestamp: String(message.timestamp),
  type: 'message',
});

describe('Pi timeline projection', () => {
  test('turns runtime configuration history into metadata for the next user turn', () => {
    const model = { id: 'model', modelId: 'gpt', parentId: null, provider: 'openai', timestamp: '1', type: 'model_change' as const };
    const thinking = { id: 'thinking', parentId: 'model', thinkingLevel: 'high', timestamp: '2', type: 'thinking_level_change' as const };
    const title = { id: 'title', name: 'Renamed', parentId: 'thinking', timestamp: '3', type: 'session_info' as const };
    const user = userEntry('user', 'hello', 4);
    const projection = projectPiTimeline([model, thinking, title, user]);

    expect(projection.items).toHaveLength(1);
    const item = projection.items[0];
    expect(item?.kind).toBe('turn');
    if (item?.kind !== 'turn') throw new Error('expected a turn');
    expect(item.turn.userEntry).toBe(user);
    expect(item.turn.metadata.model).toBe(model);
    expect(item.turn.metadata.thinking).toBe(thinking);
    expect(item.turn.metadata.sessionInfo).toBe(title);
  });

  test('does not render a completed assistant again as the live tail', () => {
    const user = userEntry('user', 'hello', 1);
    const message = assistant('done', 42);
    const projection = projectPiTimeline(
      [user, assistantEntry('assistant', message)],
      { ...message, content: [{ text: 'done', type: 'text' }] },
    );
    const item = projection.items[0];
    expect(item?.kind).toBe('turn');
    if (item?.kind !== 'turn') throw new Error('expected a turn');
    expect(item.turn.entries).toHaveLength(1);
    expect(item.turn.liveAssistant).toBeUndefined();
  });

  test('keeps a runtime user turn visible until its persisted entry arrives', () => {
    const message: PiUserMessage = { content: 'hello', role: 'user', timestamp: 9 };
    const pending = projectPiTimeline([], undefined, message);
    expect(pending.items[0]?.kind).toBe('turn');
    if (pending.items[0]?.kind !== 'turn') throw new Error('expected a live turn');
    expect(pending.items[0].turn.liveUser).toBe(true);

    const persisted = projectPiTimeline([userEntry('user', 'hello', 9)], undefined, message, pending);
    expect(persisted.items).toHaveLength(1);
    if (persisted.items[0]?.kind !== 'turn') throw new Error('expected a persisted turn');
    expect(persisted.items[0].turn.liveUser).toBe(false);
  });

  test('groups entries by user turn and assigns tool results to their calls', () => {
    const firstUser = userEntry('user-1', 'first', 1);
    const toolAssistant = assistant('working', 2);
    toolAssistant.content = [{ arguments: { path: 'README.md' }, id: 'tool-1', name: 'read', type: 'toolCall' }];
    const toolResult: PiSessionMessageEntry = {
      id: 'result-1',
      message: {
        content: [{ text: 'done', type: 'text' }],
        isError: false,
        role: 'toolResult',
        timestamp: 3,
        toolCallId: 'tool-1',
        toolName: 'read',
      },
      parentId: 'assistant-1',
      timestamp: '3',
      type: 'message',
    };
    const bash: PiSessionMessageEntry = {
      id: 'bash-1',
      message: {
        cancelled: false,
        command: 'echo ok',
        exitCode: 0,
        output: 'ok',
        role: 'bashExecution',
        timestamp: 4,
        truncated: false,
      },
      parentId: 'result-1',
      timestamp: '4',
      type: 'message',
    };
    const secondUser = userEntry('user-2', 'second', 5);
    const entries: PiSessionEntry[] = [
      { id: 'summary', firstKeptEntryId: 'x', parentId: null, summary: 'older context', timestamp: '0', tokensBefore: 100, type: 'compaction' },
      firstUser,
      assistantEntry('assistant-1', toolAssistant),
      toolResult,
      bash,
      secondUser,
      assistantEntry('assistant-2', assistant('done', 6)),
    ];
    const projection = projectPiTimeline(entries);

    expect(projection.items.map((item) => item.kind)).toEqual(['entry', 'turn', 'turn']);
    const firstTurn = projection.items[1];
    const secondTurn = projection.items[2];
    if (firstTurn?.kind !== 'turn' || secondTurn?.kind !== 'turn') throw new Error('expected turns');
    expect(firstTurn.turn.entries.map((entry) => entry.id)).toEqual(['assistant-1', 'bash-1']);
    expect(secondTurn.turn.entries.map((entry) => entry.id)).toEqual(['assistant-2']);
    expect(projection.resultByCallId.get('tool-1')).toBe(toolResult.message);
  });

  test('keeps orphan tool results visible through the generic entry renderer', () => {
    const user = userEntry('user', 'hello', 1);
    const orphan: PiSessionMessageEntry = {
      id: 'orphan-result',
      message: {
        content: [{ text: 'orphan', type: 'text' }],
        isError: true,
        role: 'toolResult',
        timestamp: 2,
        toolCallId: 'missing-call',
        toolName: 'missing',
      },
      parentId: user.id,
      timestamp: '2',
      type: 'message',
    };
    const projection = projectPiTimeline([user, orphan]);
    if (projection.items[0]?.kind !== 'turn') throw new Error('expected a turn');
    expect(projection.items[0].turn.entries).toEqual([orphan]);
  });

  test('hides persisted Varin recovery navigation markers', () => {
    const user = userEntry('user', 'hello', 1);
    const marker: PiSessionEntry = {
      customType: VARIN_RECOVERY_NAVIGATION_MARKER_TYPE,
      data: {
        expectedLeafId: user.id,
        operationId: 'restore-1',
        schemaVersion: 1,
        targetId: user.id,
        targetLeafId: null,
      },
      id: 'marker',
      parentId: user.id,
      timestamp: '2',
      type: 'custom',
    };
    const projection = projectPiTimeline([user, marker]);

    expect(projection.visibleEntries).toEqual([user]);
    if (projection.items[0]?.kind !== 'turn') throw new Error('expected a turn');
    expect(projection.items[0].turn.entries).toEqual([]);
  });

  test('keeps completed turn identities stable while only the tail changes', () => {
    const firstUser = userEntry('user-1', 'first', 1);
    const firstAssistant = assistantEntry('assistant-1', assistant('done', 2));
    const initial = projectPiTimeline([firstUser, firstAssistant]);
    const streaming = projectPiTimeline(
      [firstUser, firstAssistant],
      { ...assistant('streaming', 3), stopReason: 'pending' },
      undefined,
      initial,
    );
    expect(streaming.persistentItems[0]).toBe(initial.persistentItems[0]);
    expect(streaming.resultByCallId).toBe(initial.resultByCallId);
    expect(streaming.items[0]).toBe(initial.items[0]);
    expect(resolvePiTimelineItem(streaming.items[0]!, streaming.liveItem)).not.toBe(initial.items[0]);

    const secondUser = userEntry('user-2', 'second', 4);
    const extended = projectPiTimeline([firstUser, firstAssistant, secondUser], undefined, undefined, streaming);
    expect(extended.items[0]).toBe(initial.items[0]);
    expect(extended.items[1]?.kind).toBe('turn');
  });

  test('reuses unchanged history during text streaming and refreshes it when live tool identities change', () => {
    const entries: PiSessionEntry[] = [userEntry('user-1', 'first', 1), {
      id: 'result', parentId: null, timestamp: '2', type: 'message',
      message: { role: 'toolResult', toolName: 'read', toolCallId: 'tool-live',
        content: [{ type: 'text', text: 'result' }], isError: false, timestamp: 2 },
    }];
    const first = projectPiTimeline(entries, assistant('first delta', 3));
    const next = projectPiTimeline(entries, assistant('next delta', 3), undefined, first);
    expect(next.persistentItems).toBe(first.persistentItems);
    expect(next.visibleEntries).toBe(first.visibleEntries);
    expect(next.items).toBe(first.items);
    const liveTurn = resolvePiTimelineItem(next.items[0]!, next.liveItem);
    expect(liveTurn?.kind === 'turn' && liveTurn.turn.liveAssistant?.content).toEqual(assistant('next delta', 3).content);
    const call = { ...assistant('', 3), content: [{ type: 'toolCall' as const, id: 'tool-live', name: 'read', arguments: {} }] };
    const withCall = projectPiTimeline(entries, call, undefined, next);
    expect(withCall.visibleEntries.map(entry => entry.id)).toEqual(['user-1']);
    expect(withCall.resultByCallId.get('tool-live')).toBe(entries[1]!.type === 'message' ? entries[1]!.message : undefined);
  });
  test('refreshes a replaced historical message without invalidating an unchanged tail turn', () => {
    const firstUser = userEntry('user-1', 'first', 1);
    const firstAnswer = assistantEntry('answer-1', assistant('old answer', 2));
    const lastUser = userEntry('user-2', 'second', 3);
    const entries = [firstUser, firstAnswer, lastUser];
    const before = projectPiTimeline(entries, assistant('live delta', 4));
    const replacement = assistantEntry('answer-1', assistant('corrected answer', 2));
    const after = projectPiTimeline([firstUser, replacement, lastUser], assistant('new live delta', 4), undefined, before);

    expect(after.items[0]).not.toBe(before.items[0]);
    expect(after.items[1]).toBe(before.items[1]);
    const first = resolvePiTimelineItem(after.items[0]!, after.liveItem);
    expect(first?.kind === 'turn' && first.turn.entries).toEqual([replacement]);
    const tail = resolvePiTimelineItem(after.items[1]!, after.liveItem);
    expect(tail?.kind === 'turn' && tail.turn.liveAssistant?.content).toEqual(assistant('new live delta', 4).content);
  });

  test('updates live tool results on completion and retires the overlay when the assistant persists', () => {
    const user = userEntry('user', 'read the file', 1);
    const live: PiAssistantMessage = {
      ...assistant('', 2), stopReason: 'pending',
      content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'README.md' } }],
    };
    const initial = projectPiTimeline([user], live);
    const result: PiSessionMessageEntry = {
      id: 'result', type: 'message', parentId: user.id, timestamp: '3',
      message: { role: 'toolResult', toolName: 'read', toolCallId: 'call', content: [{ type: 'text', text: 'complete' }],
        isError: false, timestamp: 3 },
    };
    const entries = [user, result];
    const completed = projectPiTimeline(entries, live, undefined, initial);
    const turn = resolvePiTimelineItem(completed.items[0]!, completed.liveItem);
    expect(turn?.kind === 'turn' && turn.turn.resultByCallId.get('call')).toBe(result.message);
    expect(completed.visibleEntries).toEqual([user]);
    const next = projectPiTimeline(entries, { ...live }, undefined, completed);
    expect(next.items).toBe(completed.items);
    const nextTurn = resolvePiTimelineItem(next.items[0]!, next.liveItem);
    expect(nextTurn?.kind === 'turn' && turn?.kind === 'turn' && nextTurn.turn.resultByCallId).toBe(turn?.kind === 'turn' && turn.turn.resultByCallId);

    const persisted = assistantEntry('assistant', { ...live, stopReason: 'toolUse' });
    const settled = projectPiTimeline([user, persisted, result], live, undefined, next);
    expect(settled.liveItem).toBeUndefined();
    expect(settled.items).toHaveLength(1);
    const settledTurn = resolvePiTimelineItem(settled.items[0]!);
    expect(settledTurn?.kind === 'turn' && settledTurn.turn.entries).toEqual([persisted]);
    expect(settledTurn?.kind === 'turn' && settledTurn.turn.resultByCallId.get('call')).toBe(result.message);
  });

  test('keeps a standalone live row stable and removes it when the live message is withdrawn', () => {
    const entries: PiSessionEntry[] = [];
    const first = projectPiTimeline(entries, assistant('first', 1));
    const next = projectPiTimeline(entries, assistant('latest', 1), undefined, first);
    expect(next.items).toBe(first.items);
    const item = resolvePiTimelineItem(next.items[0]!, next.liveItem);
    expect(item?.kind === 'live-assistant' && item.message.content).toEqual(assistant('latest', 1).content);
    const withdrawn = projectPiTimeline(entries, undefined, undefined, next);
    expect(withdrawn.items).toEqual([]);
    expect(withdrawn.liveItem).toBeUndefined();
    const newUser = { role: 'user' as const, content: 'new prompt', timestamp: 2 };
    const restarted = projectPiTimeline(entries, assistant('new reply', 3), newUser, withdrawn);
    expect(restarted.items.map(row => row.id)).toEqual(['turn:live-user:2']);
    expect(resolvePiTimelineItem(restarted.items[0]!, restarted.liveItem)?.kind).toBe('turn');
  });

  test('does not apply a live payload to another row generation with the same ID', () => {
    const first = projectPiTimeline([], assistant('old owner', 1));
    const current = projectPiTimeline([], assistant('current owner', 1));
    expect(first.items[0]?.id).toBe(current.items[0]?.id);
    expect(resolvePiTimelineItem(first.items[0]!, current.liveItem)).toBeUndefined();
    const item = resolvePiTimelineItem(current.items[0]!, current.liveItem);
    expect(item?.kind === 'live-assistant' && item.message.content).toEqual(assistant('current owner', 1).content);

    const persisted = projectPiTimeline([userEntry('user', 'saved prompt', 2)]);
    expect(resolvePiTimelineItem(persisted.items[0]!, current.liveItem)).toBe(persisted.items[0]);
  });

});
