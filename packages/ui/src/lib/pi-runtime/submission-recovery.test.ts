import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeSuccessResponse, decodeRuntimeEnvelope, encodeRuntimeEnvelope,
  type SessionSnapshot, type SessionStats, type PiSessionEntry,
} from '@varin/protocol';
import { PiRuntimeClient, PiRuntimeRequestTimeoutError, PiRuntimeAmbiguousRequestError,
  type RuntimeTransportHandlers } from '@varin/runtime-client';
import { createPiSessionStore } from '@/stores/usePiSessionStore';
import { isPiRequestOutcomeUnknown } from './request-outcome';

const sessionId = 'submission-fixture';
const snapshot: SessionSnapshot = {
  activeTools: [], busy: false, cwd: '/fixture', features: { revision: 0, schemaVersion: 1 },
  followUp: [], followUpMode: 'all', isCompacting: false, isStreaming: false,
  leafId: 'native-user', pendingMessageCount: 0, retryAttempt: 0, sessionId,
  steering: [], steeringMode: 'all', thinkingLevel: 'medium',
};
const stats: SessionStats = {
  sessionId, assistantMessages: 0, userMessages: 1, totalMessages: 1, toolCalls: 0, toolResults: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0,
};
const nativeUser: PiSessionEntry = {
  id: 'native-user', parentId: null, type: 'message', timestamp: '2026-09-28T10:00:02.000Z',
  message: { role: 'user', timestamp: 2000, content: [{ type: 'text', text: 'execute once' }] },
};

async function fixture(answersReads: boolean) {
  let handlers: RuntimeTransportHandlers | undefined;
  let lost = 0;
  const sent: string[] = [];
  const client = new PiRuntimeClient({
    onConnectionLost: () => { lost++; },
    transport: {
      start: (next) => { handlers = next; },
      close: () => undefined,
      send: (frame) => {
        const request = decodeRuntimeEnvelope(frame);
        if (request.kind !== 'request') throw new Error('Expected request');
        sent.push(request.method);
        // The server received the prompt, but its acknowledgement is lost.
        if (request.method === 'agent.prompt' || !answersReads) return;
        const response = request.method === 'session.reconcile'
          ? createRuntimeSuccessResponse<'session.reconcile'>(request.id, {
            snapshot, stats, entries: { branch: { sessionId, scope: 'branch', leafId: nativeUser.id, entries: [nativeUser] } },
          })
          : createRuntimeSuccessResponse<'session.snapshot'>(request.id, snapshot);
        queueMicrotask(() => handlers?.message(encodeRuntimeEnvelope(response)));
      },
    },
  });
  await client.connect();
  const store = createPiSessionStore({
    currentKey: () => 'fixture-runtime',
    connect: async () => ({ client, runtimeKey: 'fixture-runtime' }),
    subscribeChanged: () => () => undefined,
  }, { submissionTimeoutMs: 100, observationTimeoutMs: 20 });
  store.setState({ records: { [sessionId]: {
    extensionStates: {}, sessionId, open: true, snapshot: { ...snapshot, leafId: null }, toolExecutions: {},
    branchEntries: { sessionId, scope: 'branch', leafId: null, entries: [] }, branchEntriesSource: 'live',
  } } });
  const id = store.getState().beginSubmission(sessionId,
    { role: 'user', content: 'execute once', timestamp: 1000 }, 'prompt');
  const send = () => store.getState().prompt(sessionId, 'execute once', undefined, undefined, undefined,
    () => store.getState().updateSubmission(sessionId, id, { status: 'dispatching', dispatchedText: 'execute once' }));
  return { client, store, send, sent, losses: () => lost };
}

describe('submission acknowledgement recovery', () => {
  it('bounds an unanswered acknowledgement and reconciles native history without resending', async () => {
    const f = await fixture(true);
    try {
      const error = await f.send().then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(PiRuntimeRequestTimeoutError);
      expect(isPiRequestOutcomeUnknown(error)).toBe(true);
      await vi.waitFor(() => expect(f.store.getState().records[sessionId]?.submission).toBeUndefined());
      expect(f.store.getState().records[sessionId]?.branchEntries?.entries).toEqual([nativeUser]);
      expect(f.sent.filter((method) => method === 'agent.prompt')).toHaveLength(1);
      expect(f.losses()).toBe(0); // a slow acknowledgement alone does not kill a healthy connection
    } finally { f.store.getState().reset(); await f.client.close(); }
  });

  it('retires a silent live connection after a read-only probe fails; prompt outcome stays unknown', async () => {
    const f = await fixture(false);
    try {
      const pending = f.send().then(() => null, (reason: unknown) => reason);
      await vi.waitFor(() => expect(f.sent).toContain('agent.prompt'));
      await f.store.getState().probeBusySession(sessionId);
      const error = await pending;
      expect(error).toBeInstanceOf(PiRuntimeAmbiguousRequestError);
      expect(f.losses()).toBe(1);
      expect(f.client.connected).toBe(false);
      expect(f.sent.filter((method) => method === 'agent.prompt')).toHaveLength(1);
    } finally { f.store.getState().reset(); await f.client.close(); }
  });
});
