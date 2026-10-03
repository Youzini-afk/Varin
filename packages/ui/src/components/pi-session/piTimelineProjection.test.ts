import { describe, expect, test } from 'vitest';
import type {
  PiAssistantMessage,
  PiSessionEntry,
  PiSessionMessageEntry,
  PiUserMessage,
} from '@varin/protocol';
import { VARIN_RECOVERY_NAVIGATION_MARKER_TYPE } from '@varin/protocol';
import { projectPiTimeline } from './piTimelineProjection';

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
    expect(streaming.items[0]).not.toBe(initial.items[0]);

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
    expect(next.items[0]?.kind === 'turn' && next.items[0].turn.liveAssistant?.content).toEqual(assistant('next delta', 3).content);
    const call = { ...assistant('', 3), content: [{ type: 'toolCall' as const, id: 'tool-live', name: 'read', arguments: {} }] };
    const withCall = projectPiTimeline(entries, call, undefined, next);
    expect(withCall.visibleEntries.map(entry => entry.id)).toEqual(['user-1']);
    expect(withCall.resultByCallId.get('tool-live')).toBe(entries[1]!.type === 'message' ? entries[1]!.message : undefined);
  });
});
