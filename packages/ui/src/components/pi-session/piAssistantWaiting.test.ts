import { describe, expect, test } from 'vitest';
import type {
  PiAssistantMessage,
  PiSessionMessageEntry,
  SessionSnapshot,
} from '@varin/protocol';
import { projectPiTimeline } from './piTimelineProjection';
import {
  findPiAssistantWaitingTurnId,
  projectPiAssistantWaiting,
} from './piAssistantWaiting';

const userEntry = (id: string, timestamp: number): PiSessionMessageEntry => ({
  id,
  message: { content: id, role: 'user', timestamp },
  parentId: null,
  timestamp: String(timestamp),
  type: 'message',
});

const assistant = (stopReason: PiAssistantMessage['stopReason']): PiAssistantMessage => ({
  api: 'messages',
  content: [],
  model: 'model',
  provider: 'provider',
  role: 'assistant',
  stopReason,
  timestamp: 2,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const assistantEntry = (message: PiAssistantMessage): PiSessionMessageEntry => ({
  id: 'assistant',
  message,
  parentId: 'user',
  timestamp: String(message.timestamp),
  type: 'message',
});

const idleSnapshot = (): SessionSnapshot => ({
  busy: false,
  isCompacting: false,
  isStreaming: false,
  model: { id: 'snapshot-model', provider: 'snapshot-provider' },
  retryAttempt: 0,
} as SessionSnapshot);

describe('Pi assistant waiting presentation', () => {
  test('covers every active prompt submission state and keeps the snapshot model', () => {
    for (const status of ['preparing', 'dispatching', 'accepted'] as const) {
      expect(projectPiAssistantWaiting({
        snapshot: idleSnapshot(),
        submission: { mode: 'prompt', status },
      })).toEqual({ model: { id: 'snapshot-model', provider: 'snapshot-provider' } });
    }
  });

  test('does not claim assistant activity for failed, uncertain, or queued submissions', () => {
    for (const status of ['failed', 'uncertain'] as const) {
      expect(projectPiAssistantWaiting({
        snapshot: idleSnapshot(),
        submission: { mode: 'prompt', status },
      })).toBeUndefined();
    }
    expect(projectPiAssistantWaiting({
      snapshot: idleSnapshot(),
      submission: { mode: 'followUp', status: 'preparing' },
    })).toBeUndefined();
  });

  test('bridges live user and each authoritative runtime working state', () => {
    expect(projectPiAssistantWaiting({
      liveUser: { content: 'hello', role: 'user', timestamp: 1 },
      snapshot: idleSnapshot(),
    })).toBeDefined();
    for (const patch of [
      { busy: true },
      { isStreaming: true },
      { isCompacting: true },
      { retryAttempt: 1 },
    ]) {
      expect(projectPiAssistantWaiting({
        snapshot: { ...idleSnapshot(), ...patch },
      })).toBeDefined();
    }
    expect(projectPiAssistantWaiting({ snapshot: idleSnapshot() })).toBeUndefined();
  });
});

describe('Pi assistant waiting turn', () => {
  test('binds activity to the newest unanswered turn', () => {
    const projection = projectPiTimeline([userEntry('user', 1)]);
    expect(findPiAssistantWaitingTurnId(projection.items, true)).toBe('turn:user');
  });

  test('keeps a live pending assistant on its owning turn', () => {
    const projection = projectPiTimeline(
      [userEntry('user', 1)],
      assistant('pending'),
    );
    expect(findPiAssistantWaitingTurnId(projection.items, true)).toBe('turn:user');
  });

  test('does not attach unrelated working state to a completed turn', () => {
    const message = assistant('stop');
    const projection = projectPiTimeline([
      userEntry('user', 1),
      assistantEntry(message),
    ]);
    expect(findPiAssistantWaitingTurnId(projection.items, true)).toBeUndefined();
    expect(findPiAssistantWaitingTurnId(projection.items, false)).toBeUndefined();
  });
});
