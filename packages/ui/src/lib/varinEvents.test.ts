import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let mockSessionId: string | null = null;
const sessionListeners = new Set<(state: { currentSessionId: string | null }, previous: { currentSessionId: string | null }) => void>();
const bindCalls: string[] = [];
let bindGate: Promise<void> | null = null;
let runtimeListener: (() => void) | null = null;

vi.doMock('@varin/application-client', () => ({
  getRuntimeUrlResolver: () => ({
    sse: (path: string, query?: Record<string, string>) => {
      const suffix = query ? `?${new URLSearchParams(query).toString()}` : '';
      return `http://runtime.test${path}${suffix}`;
    },
  }),
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtimeListener = listener;
    return () => { runtimeListener = null; };
  },
}));

vi.doMock('@/stores/usePiSessionStore', () => ({
  usePiSessionStore: {
    getState: () => ({ currentSessionId: mockSessionId }),
    subscribe: (listener: (state: { currentSessionId: string | null }, previous: { currentSessionId: string | null }) => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
  },
}));

vi.doMock('@/lib/client-settings-bridge', () => ({
  bindClientSurfaceSession: async (sessionId: string) => {
    bindCalls.push(sessionId);
    if (bindGate) await bindGate;
  },
  clientSurfaceQuery: () => ({
    surface: 'surface-test',
    kind: 'web',
    ...(mockSessionId ? { session: mockSessionId } : {}),
  }),
  handleClientSettingsRequest: async () => undefined,
}));

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];

  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.readyState = MockEventSource.CLOSED;
  }
}

describe('Varin events', () => {
  const flushAsync = async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  beforeEach(() => {
    MockEventSource.instances = [];
    mockSessionId = null;
    bindCalls.length = 0;
    bindGate = null;
    runtimeListener = null;
    sessionListeners.clear();
    globalThis.window = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as Window & typeof globalThis;
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  test('dispatches application activity on the shared stream and rejects malformed events', async () => {
    const { subscribeVarinEvents } = await import('./varinEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeVarinEvents(event => events.push(event));
    const source = MockEventSource.instances[0];
    const properties = { desktopId: 'd1', activity: { sessionId: 's1', app: 'Editor', operation: 'click', status: 'running', updatedAt: 'now' } };
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:computer-activity', properties }) });
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:computer-activity', properties: { ...properties, activity: { ...properties.activity, status: 'unrecognized' } } }) });
    expect(events).toEqual([{ type: 'computer-activity', ...properties }]);
    unsubscribe();
  });

  test('dispatches native plan identity hints and rejects malformed envelopes', async () => {
    const { subscribeVarinEvents } = await import('./varinEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeVarinEvents(event => events.push(event));
    const source = MockEventSource.instances[0];
    const properties = { threadId: 'native-thread', branchId: 'native-branch', ref: 'plan-version' };
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:plan-changed', properties }) });
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:plan-changed', properties: { ...properties, ref: null } }) });
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:plan-changed', properties: { ...properties, branchId: '' } }) });
    expect(events).toEqual([{ type: 'plan-changed', ...properties }]);
    unsubscribe();
  });

  test('dispatches externally created session events', async () => {
    const { subscribeVarinEvents } = await import('./varinEvents');
    const events: unknown[] = [];
    const listener = (event: unknown) => events.push(event);
    const unsubscribe = subscribeVarinEvents(listener);
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({
        type: 'varin:session-created',
        properties: {
          sessionId: 'ses_123',
          directory: '/repo/worktrees/research',
          projectId: 'project_1',
          createdAt: 123,
          promptDispatched: true,
          dispatchedAsCommand: false,
        },
      }),
    });
    expect(events).toEqual([
      {
        type: 'session-created',
        sessionId: 'ses_123',
        directory: '/repo/worktrees/research',
        projectId: 'project_1',
        createdAt: 123,
        promptDispatched: true,
        dispatchedAsCommand: false,
      },
    ]);
    unsubscribe();
  });

  test('binds a non-empty session before opening SSE', async () => {
    mockSessionId = 'session-a';
    let release!: () => void;
    bindGate = new Promise<void>((resolve) => { release = resolve; });
    const { subscribeVarinEvents } = await import('./varinEvents');
    const unsubscribe = subscribeVarinEvents(() => undefined);

    expect(bindCalls).toEqual(['session-a']);
    expect(MockEventSource.instances).toHaveLength(0);
    release();
    await flushAsync();
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toContain('session=session-a');
    unsubscribe();
  });

  test('rebinds after a session switch and runtime reconnect', async () => {
    mockSessionId = 'session-a';
    const { subscribeVarinEvents } = await import('./varinEvents');
    const unsubscribe = subscribeVarinEvents(() => undefined);
    await flushAsync();
    const first = MockEventSource.instances[0];
    expect(first?.url).toContain('session=session-a');

    mockSessionId = 'session-b';
    for (const listener of sessionListeners) {
      listener({ currentSessionId: 'session-b' }, { currentSessionId: 'session-a' });
    }
    await flushAsync();
    expect(first?.readyState).toBe(MockEventSource.CLOSED);
    expect(bindCalls).toEqual(['session-a', 'session-b']);
    expect(MockEventSource.instances.at(-1)?.url).toContain('session=session-b');

    MockEventSource.instances.at(-1)?.onerror?.();
    expect(bindCalls).toEqual(['session-a', 'session-b']);
    runtimeListener?.();
    await flushAsync();
    expect(bindCalls).toEqual(['session-a', 'session-b', 'session-b']);
    expect(MockEventSource.instances.at(-1)?.url).toContain('session=session-b');
    unsubscribe();
  });

  test('dispatches stream readiness and typed harness thread changes', async () => {
    const { subscribeVarinEvents } = await import('./varinEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeVarinEvents((event) => events.push(event));
    const source = MockEventSource.instances[0];

    source.onmessage?.({
      data: JSON.stringify({ type: 'varin:event-stream-ready', properties: {} }),
    });
    source.onmessage?.({
      data: JSON.stringify({
        type: 'varin:harness-thread-changed',
        properties: {
          workspaceId: 'workspace-1',
          parent: { kind: 'session', id: 'parent-1' },
          thread: { id: 'thread-1', workspaceId: 'workspace-1', eventSeq: 3 },
          activeRun: { id: 'run-1', workerState: 'running' },
        },
      }),
    });
    source.onmessage?.({
      data: JSON.stringify({
        type: 'varin:harness-blocks-changed',
        properties: { workspaceId: 'workspace-1', sessionId: 'parent-1' },
      }),
    });
    source.onmessage?.({
      data: JSON.stringify({
        type: 'varin:harness-knowledge-changed',
        properties: { sessionId: 'parent-1', scope: 'user' },
      }),
    });

    expect(events).toEqual([
      { type: 'stream-ready' },
      {
        type: 'harness-thread-changed',
        workspaceId: 'workspace-1',
        parent: { kind: 'session', id: 'parent-1' },
        thread: { id: 'thread-1', workspaceId: 'workspace-1', eventSeq: 3 },
        activeRun: { id: 'run-1', workerState: 'running' },
      },
      { type: 'harness-blocks-changed', workspaceId: 'workspace-1', sessionId: 'parent-1' },
      { type: 'harness-knowledge-changed', sessionId: 'parent-1', scope: 'user' },
    ]);
    unsubscribe();
  });
});
