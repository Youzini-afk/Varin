import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import {
  createEvent,
  createRuntimeRequest,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  VARIN_PROTOCOL_VERSION,
  type RuntimeWireEnvelope,
  type SessionSnapshot,
  type SessionStats,
} from '@varin/protocol';
import {
  configureRuntimeUrlResolver,
  getRuntimeUrlResolver,
  setRuntimeUrlAuthToken,
  setRuntimeUrlResolver,
} from '@varin/application-client';
import {
  PiRuntimeBroker,
  type PiRuntimeBrokerEvent,
} from '@varin/runtime-broker';
import { WebSocket } from 'ws';
import { PiRuntimeAmbiguousRequestError, PiRuntimeClient, WebSocketRuntimeTransport } from '@varin/runtime-client';
import { createPiRuntimeGateway, PI_RUNTIME_WS_PATH } from './gateway.js';

const active: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (active.length > 0) {
    await active.pop()?.();
  }
});

const listen = (server: http.Server): Promise<number> => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server address');
    resolve(address.port);
  });
});

const closeServer = async (server: http.Server): Promise<void> => {
  server.close();
  server.closeAllConnections?.();
};

const openSocket = (url: string, origin = 'http://127.0.0.1'): Promise<WebSocket> => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  socket.once('open', () => resolve(socket));
  socket.once('error', reject);
});

const nextMessage = (socket: WebSocket): Promise<RuntimeWireEnvelope> => new Promise((resolve, reject) => {
  socket.once('message', (raw) => {
    try {
      resolve(decodeRuntimeEnvelope(raw.toString('utf8')));
    } catch (error) {
      reject(error);
    }
  });
  socket.once('error', reject);
});

const handshake = async (socket: WebSocket, id = 'handshake'): Promise<RuntimeWireEnvelope> => {
  const responsePromise = nextMessage(socket);
  socket.send(encodeRuntimeEnvelope(createRuntimeRequest(id, 'host.handshake', {
    clientName: 'gateway-test',
    clientVersion: '0.1.0',
    mode: 'test',
    protocolVersions: [VARIN_PROTOCOL_VERSION],
  })));
  return responsePromise;
};

interface TestBroker extends PiRuntimeBroker {
  emitTest(event: PiRuntimeBrokerEvent): void;
}

const createBroker = (): TestBroker => {
  const listeners = new Set<(event: PiRuntimeBrokerEvent) => void>();
  const broker = Object.create(PiRuntimeBroker.prototype) as PiRuntimeBroker;
  return Object.assign(broker, {
    subscribe(listener: (event: PiRuntimeBrokerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    warmup: async () => ({
      capabilities: {
        extensionUi: true,
        models: true,
        packages: true,
        recovery: true,
        sessions: true,
        settings: true,
      },
      hostVersion: '0.1.0',
      protocolVersion: VARIN_PROTOCOL_VERSION,
      runtime: {
        agentDir: 'C:/agent',
        nodePath: 'node',
        nodeVersion: process.version,
        piVersion: '0.83.0',
        source: 'bundled',
      },
    }),
    listSessions: async () => [],
    emitTest(event: PiRuntimeBrokerEvent) {
      for (const listener of listeners) listener(event);
    },
  }) as TestBroker;
};

const setup = async ({ auth = true, origin = true }: {
  auth?: boolean | undefined;
  origin?: boolean | undefined;
} = {}) => {
  const server = http.createServer();
  const broker = createBroker();
  const rejections: Array<{ reason: string; status: number }> = [];
  const gateway = createPiRuntimeGateway({
    server,
    broker,
    uiAuthController: {
      resolveWebSocketAuthContext: async () => auth ? { type: 'session', token: 'test' } : null,
    },
    isRequestOriginAllowed: async () => origin,
    rejectWebSocketUpgrade: (socket, status, reason) => {
      rejections.push({ reason, status });
    },
  });
  const port = await listen(server);
  active.push(async () => {
    await gateway.stop();
    await closeServer(server);
  });
  return { broker, rejections, server, url: `ws://127.0.0.1:${port}${PI_RUNTIME_WS_PATH}` };
};

describe('Pi runtime gateway', () => {
  it('authenticates and dispatches native runtime requests', async () => {
    const { url } = await setup();
    const socket = await openSocket(url);
    const response = await handshake(socket, 'handshake-1');
    expect(response).toMatchObject({
      id: 'handshake-1',
      kind: 'response',
      ok: true,
      result: { protocolVersion: VARIN_PROTOCOL_VERSION },
    });
    socket.close();
  });

  it('broadcasts host events with worker routing metadata', async () => {
    const { broker, url } = await setup();
    const socket = await openSocket(url);
    await handshake(socket);
    const message = nextMessage(socket);
    broker.emitTest({
      envelope: createEvent(7, 'session.closed', { sessionId: 'session-1' }),
      kind: 'host',
      role: 'session',
      runtimeGeneration: 1,
      sessionId: 'session-1',
      workerId: 'worker-1',
    });

    expect(await message).toMatchObject({
      event: 'session.closed',
      seq: 7,
      source: {
        role: 'session',
        sessionId: 'session-1',
        workerId: 'worker-1',
      },
    });
    socket.close();
  });

  it('rejects unauthenticated and cross-origin upgrades', async () => {
    for (const [options, expectedStatus] of [
      [{ auth: false }, 401],
      [{ origin: false }, 403],
    ] as const) {
      const { rejections, server } = await setup(options);
      server.emit('upgrade', {
        headers: { origin: 'http://127.0.0.1' },
        url: PI_RUNTIME_WS_PATH,
      }, new PassThrough(), Buffer.alloc(0));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([
        expect.objectContaining({ status: expectedStatus }),
      ]);
    }
  });

  it('rejects worker-only methods before dispatch', async () => {
    const { url } = await setup();
    const socket = await openSocket(url);
    const responsePromise = nextMessage(socket);
    socket.send(JSON.stringify({
      id: 'shutdown-1',
      kind: 'request',
      method: 'host.shutdown',
      params: {},
      v: VARIN_PROTOCOL_VERSION,
    }));

    expect(await responsePromise).toMatchObject({
      id: 'shutdown-1',
      ok: false,
      error: { code: 'unsupported_method' },
    });
    socket.close();
  });

  it('requires a successful handshake before runtime operations', async () => {
    const { url } = await setup();
    const socket = await openSocket(url);
    const responsePromise = nextMessage(socket);
    socket.send(encodeRuntimeEnvelope(createRuntimeRequest('list-1', 'session.list', {})));

    expect(await responsePromise).toMatchObject({
      id: 'list-1',
      ok: false,
      error: { code: 'handshake_required' },
    });
    socket.close();
  });

  it('does not impose a product payload ceiling by default', async () => {
    const { url } = await setup();
    const socket = await openSocket(url);
    await handshake(socket);
    const responsePromise = nextMessage(socket);
    socket.send(JSON.stringify({
      id: 'large-list',
      kind: 'request',
      method: 'session.list',
      params: { deploymentOwnedPayload: 'x'.repeat(6 * 1024 * 1024) },
      v: VARIN_PROTOCOL_VERSION,
    }));

    expect(await responsePromise).toMatchObject({ id: 'large-list', ok: true, result: [] });
    socket.close();
  });

  it("carries a real client through a killed socket: ambiguous pending, connection-lost signal, reconnect resume", async () => {
    const { broker, url } = await setup();

    const openClient = async () => {
      let lost: Error | undefined;
      let liveSocket: WebSocket | undefined;
      const transport = new WebSocketRuntimeTransport({
        url,
        webSocketFactory: (socketUrl: string) => {
          liveSocket = new WebSocket(socketUrl, { headers: { Origin: 'http://127.0.0.1' } });
          return liveSocket as never;
        },
      });
      const client = new PiRuntimeClient({
        transport,
        onConnectionLost: (error) => { lost = error ?? new Error('transport closed'); },
      });
      await client.connect();
      const hs = await client.request('host.handshake', {
        clientName: 'gateway-test',
        clientVersion: '0.1.0',
        mode: 'test',
        protocolVersions: [VARIN_PROTOCOL_VERSION],
      });
      expect(hs).toMatchObject({ protocolVersion: VARIN_PROTOCOL_VERSION });
      return { client, wasLost: () => lost !== undefined, kill: () => liveSocket?.terminate() };
    };

    // First connection: keep session.list in-flight, then kill the wire.
    let hangList = true;
    broker.listSessions = () => (hangList ? new Promise<never>(() => {}) : Promise.resolve([]));
    const first = await openClient();
    const pending = first.client.request('session.list', {}, 15_000);
    const pendingOutcome = pending.then(
      () => ({ resolved: true as const }),
      (error: unknown) => ({ resolved: false as const, error }),
    );
    first.kill();
    const outcome = await pendingOutcome;
    expect(outcome.resolved).toBe(false);
    expect(!outcome.resolved && outcome.error instanceof PiRuntimeAmbiguousRequestError).toBe(true);
    expect(first.wasLost()).toBe(true);
    // A dead client must not silently keep serving requests.
    await expect(first.client.request('session.list', {})).rejects.toThrow(/closed|not connected/i);

    // The reconnect path the UI supervisor drives: new transport + client on
    // the same gateway resumes requests without replaying the killed one.
    hangList = false;
    const second = await openClient();
    await expect(second.client.request('session.list', {})).resolves.toEqual([]);
  });

  it('reconnects the production supervisor and catches the Store up after a real socket loss', async () => {
    type RecoveryRecord = {
      branchEntries?: { entries: Array<{ id: string }> };
      liveAssistant?: unknown;
      snapshot?: SessionSnapshot;
      stats?: SessionStats;
      syncState?: string;
      toolExecutions?: Record<string, { result?: unknown; status: string }>;
    };
    type RecoveryStore = { getState(): {
      loadCatalog(): Promise<void>;
      records: Record<string, RecoveryRecord>;
      refreshEntries(sessionId: string): Promise<unknown>;
    } };
    const { createPiSessionStore } = await vi.importActual<{
      createPiSessionStore(): RecoveryStore;
    }>('@varin/ui/stores/usePiSessionStore');
    const { disconnectPiRuntime } = await vi.importActual<{
      disconnectPiRuntime(): Promise<void>;
    }>('@varin/ui/lib/pi-runtime/client');
    const { broker, server, url } = await setup();
    const priorResolver = getRuntimeUrlResolver();
    const acceptedSockets: Array<{ destroy(): void }> = [];
    server.on('upgrade', (_request, socket) => { acceptedSockets.push(socket); });
    await disconnectPiRuntime();
    configureRuntimeUrlResolver({ apiBaseUrl: url.replace(/^ws:/, 'http:').replace(PI_RUNTIME_WS_PATH, '') });
    setRuntimeUrlAuthToken('gateway-test-token', Date.now() + 60_000);
    active.push(async () => {
      await disconnectPiRuntime();
      setRuntimeUrlAuthToken(null, null);
      setRuntimeUrlResolver(priorResolver);
    });

    const sessionId = 'session-socket-recovery';
    const workerId = 'worker-socket-recovery';
    const snapshot = (busy: boolean): SessionSnapshot => ({
      activeTools: [], busy, cwd: 'D:/work', eventWatermark: busy ? 5 : 9,
      eventWorkerId: workerId, features: { revision: 0, schemaVersion: 1 },
      followUp: [], followUpMode: 'all', isCompacting: false, isStreaming: busy,
      queuedMessages: [],
      leafId: busy ? null : 'entry-final', pendingMessageCount: 0,
      pendingToolCallIds: busy ? ['call-1'] : [],
      retryAttempt: 0, runId: 'run-one', sessionId, steering: [],
      steeringMode: 'all', thinkingLevel: 'medium',
    });
    const finalMessage = {
      api: 'messages' as const, content: [{ text: 'final answer', type: 'text' as const }],
      model: 'model', provider: 'provider', role: 'assistant' as const,
      stopReason: 'stop' as const, timestamp: 42,
      usage: {
        cacheRead: 0, cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 2, output: 3, totalTokens: 5,
      },
    };
    const stats: SessionStats = {
      assistantMessages: 1, contextUsage: { contextWindow: 100, percent: 5, tokens: 5 },
      cost: 0, sessionId,
      tokens: { cacheRead: 0, cacheWrite: 0, input: 2, output: 3, total: 5 },
      toolCalls: 1, toolResults: 1, totalMessages: 3, userMessages: 1,
    };
    let completed = false;
    const methods: string[] = [];
    broker.requestForSession = (async (_sessionId: string, method: string, params: {
      scope?: string; scopes?: string[];
    }) => {
      methods.push(method);
      if (method === 'session.snapshot') return snapshot(!completed);
      const entries = {
        entries: completed ? [{
          id: 'entry-tool', parentId: null, timestamp: '2026-09-26T00:00:00.000Z',
          type: 'message', message: {
            content: [{ text: 'read output', type: 'text' }], details: { lines: 3 },
            isError: false, role: 'toolResult', timestamp: 41,
            toolCallId: 'call-1', toolName: 'read',
          },
        }, {
          id: 'entry-final', parentId: 'entry-tool', timestamp: '2026-09-26T00:00:00.001Z',
          type: 'message', message: finalMessage,
        }] : [],
        leafId: completed ? 'entry-final' : null,
        scope: params.scope ?? 'branch', sessionId,
      };
      if (method === 'session.reconcile') return {
        entries: params.scopes?.includes('branch') ? { branch: entries } : {},
        snapshot: snapshot(!completed), stats,
      };
      if (method === 'session.entries') return entries;
      if (method === 'session.stats') return stats;
      throw new Error(`Unexpected ${method}`);
    }) as typeof broker.requestForSession;
    const store = createPiSessionStore();
    await store.getState().loadCatalog();
    broker.emitTest({
      envelope: createEvent(3, 'session.snapshot', snapshot(true)),
      kind: 'host', role: 'session', runtimeGeneration: 1, sessionId, workerId,
    });
    broker.emitTest({
      envelope: createEvent(4, 'agent.event', {
        event: {
          message: { ...finalMessage, content: [{ text: 'half', type: 'text' }], stopReason: 'pending' },
          runId: 'run-one', type: 'message_start',
        }, sessionId,
      }),
      kind: 'host', role: 'session', runtimeGeneration: 1, sessionId, workerId,
    });
    broker.emitTest({
      envelope: createEvent(5, 'agent.event', {
        event: { args: { path: 'README.md' }, runId: 'run-one',
          toolCallId: 'call-1', toolName: 'read', type: 'tool_execution_start' },
        sessionId,
      }),
      kind: 'host', role: 'session', runtimeGeneration: 1, sessionId, workerId,
    });
    const until = async (check: () => boolean): Promise<void> => {
      const deadline = Date.now() + 8_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for socket recovery');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await until(() => store.getState().records[sessionId]?.liveAssistant !== undefined);
    await store.getState().refreshEntries(sessionId);
    completed = true;
    acceptedSockets[0]?.destroy();
    await until(() => {
      const record = store.getState().records[sessionId];
      return record?.syncState === 'synced'
        && record.snapshot?.busy === false
        && record.branchEntries?.entries[1]?.id === 'entry-final'
        && record.liveAssistant === undefined;
    });
    expect(store.getState().records[sessionId]?.stats?.tokens.total).toBe(5);
    expect(store.getState().records[sessionId]?.branchEntries?.entries[0]?.id).toBe('entry-tool');
    expect(store.getState().records[sessionId]?.toolExecutions?.['call-1']).toMatchObject({
      result: { lines: 3 }, status: 'success',
    });
    expect(methods).toContain('session.reconcile');
    expect(methods.filter((method) => method.startsWith('agent.'))).toEqual([]);
  });

  it('recovers a missed terminal event on a still-connected visible busy session', async () => {
    type ProbeStore = {
      getState(): {
        connectionPhase: string;
        loadCatalog(): Promise<void>;
        records: Record<string, {
          branchEntries?: { entries: Array<{ id: string }> };
          snapshot?: SessionSnapshot;
          syncState?: string;
        }>;
        refreshEntries(sessionId: string): Promise<unknown>;
      };
      setState(patch: { currentSessionId: string }): void;
    };
    const { createPiSessionStore } = await vi.importActual<{
      createPiSessionStore(runtime?: undefined, options?: { healthProbeIntervalMs: number }): ProbeStore;
    }>('@varin/ui/stores/usePiSessionStore');
    const { disconnectPiRuntime } = await vi.importActual<{
      disconnectPiRuntime(): Promise<void>;
    }>('@varin/ui/lib/pi-runtime/client');
    const { broker, url } = await setup();
    const priorResolver = getRuntimeUrlResolver();
    await disconnectPiRuntime();
    configureRuntimeUrlResolver({ apiBaseUrl: url.replace(/^ws:/, 'http:').replace(PI_RUNTIME_WS_PATH, '') });
    setRuntimeUrlAuthToken('gateway-probe-token', Date.now() + 60_000);
    active.push(async () => {
      await disconnectPiRuntime();
      setRuntimeUrlAuthToken(null, null);
      setRuntimeUrlResolver(priorResolver);
    });
    const sessionId = 'session-missed-terminal';
    const workerId = 'worker-missed-terminal';
    let authoritativeBusy = true;
    let reconcileReads = 0;
    const snapshot = (): SessionSnapshot => ({
      activeTools: [], busy: authoritativeBusy, cwd: 'D:/work',
      eventWatermark: authoritativeBusy ? 4 : 8, eventWorkerId: workerId,
      features: { revision: 0, schemaVersion: 1 }, followUp: [], followUpMode: 'all',
      queuedMessages: [],
      isCompacting: false, isStreaming: authoritativeBusy,
      leafId: authoritativeBusy ? null : 'entry-final', pendingMessageCount: 0,
      pendingToolCallIds: [], retryAttempt: 0, runId: 'run-one', sessionId,
      steering: [], steeringMode: 'all', thinkingLevel: 'medium',
    });
    broker.requestForSession = (async (_id: string, method: string, params: { scopes?: string[] }) => {
      if (method === 'session.snapshot') return snapshot();
      if (method === 'session.entries') return {
        entries: [], leafId: null, scope: 'branch', sessionId,
      };
      if (method === 'session.reconcile') {
        reconcileReads += 1;
        return {
          snapshot: snapshot(),
          entries: params.scopes?.includes('branch') ? { branch: {
            entries: authoritativeBusy ? [] : [{
              id: 'entry-final', parentId: null, timestamp: '2026-09-26T00:00:00.000Z',
              type: 'message', message: {
                api: 'messages', content: [{ text: 'finished quietly', type: 'text' }],
                model: 'model', provider: 'provider', role: 'assistant', stopReason: 'stop',
                timestamp: 42, usage: { cacheRead: 0, cacheWrite: 0,
                  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
                  input: 0, output: 0, totalTokens: 0 },
              },
            }], leafId: authoritativeBusy ? null : 'entry-final', scope: 'branch', sessionId,
          } } : {},
          stats: { assistantMessages: 1, cost: 0, sessionId,
            tokens: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            toolCalls: 0, toolResults: 0, totalMessages: 1, userMessages: 0 },
        };
      }
      throw new Error(`Unexpected ${method}`);
    }) as typeof broker.requestForSession;
    const store = createPiSessionStore(undefined, { healthProbeIntervalMs: 30 });
    await store.getState().loadCatalog();
    broker.emitTest({
      envelope: createEvent(3, 'session.snapshot', snapshot()),
      kind: 'host', role: 'session', runtimeGeneration: 1, sessionId, workerId,
    });
    await store.getState().refreshEntries(sessionId);
    store.setState({ currentSessionId: sessionId });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const baselineReads = reconcileReads;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reconcileReads, 'a quiet but still-busy run needs no history reload').toBe(baselineReads);
    authoritativeBusy = false; // terminal event is deliberately never delivered
    const deadline = Date.now() + 3_000;
    while (store.getState().records[sessionId]?.snapshot?.busy !== false) {
      if (Date.now() > deadline) throw new Error('Busy probe did not recover the missed terminal state');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(store.getState().connectionPhase).toBe('connected');
    expect(store.getState().records[sessionId]?.syncState).toBe('synced');
    expect(store.getState().records[sessionId]?.branchEntries?.entries[0]?.id).toBe('entry-final');
    expect(reconcileReads).toBe(baselineReads + 1);
  });
});
