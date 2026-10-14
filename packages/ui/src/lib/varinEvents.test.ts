import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let mockThreadId: string | null = null;
let mockBranchId = 'branch';
const threadListeners = new Set<(state: { selectedIdentity: { runtime: 'agent'; threadId: string; branchId: string } | null; hostKey?: string }, previous: { selectedIdentity: { runtime: 'agent'; threadId: string; branchId: string } | null; hostKey?: string }) => void>();
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

vi.doMock('@/stores/useThreadStore', () => ({
  useThreadStore: {
    getState: () => ({ selectedIdentity: mockThreadId ? { runtime: 'agent', threadId: mockThreadId, branchId: mockBranchId } : null, hostKey: 'host' }),
    subscribe: (listener: (state: { selectedIdentity: { runtime: 'agent'; threadId: string; branchId: string } | null; hostKey?: string }, previous: { selectedIdentity: { runtime: 'agent'; threadId: string; branchId: string } | null; hostKey?: string }) => void) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
  },
}));

vi.doMock('@/lib/client-settings-bridge', () => ({
  selectedClientThread: () => mockThreadId ? { runtime: 'agent', threadId: mockThreadId, branchId: mockBranchId } : null,
  bindClientSurfaceThread: async (identity: { threadId: string; branchId: string }) => {
    bindCalls.push(identity.threadId);
    if (bindGate) await bindGate;
  },
  clientSurfaceQuery: () => ({
    surface: 'surface-test',
    kind: 'web',
    ...(mockThreadId ? { threadId: mockThreadId, branchId: mockBranchId } : {}),
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
    mockThreadId = null;
    mockBranchId = 'branch';
    bindCalls.length = 0;
    bindGate = null;
    runtimeListener = null;
    threadListeners.clear();
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
    const properties = { desktopId: 'd1', activity: { execution: { work: { runtime: 'agent', threadId: 'thread', branchId: 'branch' }, runId: 'run' }, app: 'Editor', operation: 'click', status: 'running', updatedAt: 'now' } };
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:computer-activity', properties }) });
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:computer-activity', properties: { ...properties, activity: { ...properties.activity, status: 'unrecognized' } } }) });
    expect(events).toEqual([{ type: 'computer-activity', ...properties }]);
    unsubscribe();
  });

  test('preserves Native Computer execution identities and idle cleanup while rejecting Pi aliases', async () => {
    const { subscribeVarinEvents } = await import('./varinEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeVarinEvents(event => events.push(event));
    const source = MockEventSource.instances[0];
    const work = { runtime: 'agent', threadId: 'same', branchId: 'branch' };
    const execution = { work, runId: 'old-run' };
    const state = { work, rootWork: work, currentExecution: null, currentRootExecution: null,
      active: false, status: 'cancel-unconfirmed', leases: [], requests: [], cleanups: [{ execution, status: 'cancel-unconfirmed' }] };
    const activity = { execution, app: 'Editor', operation: 'click', status: 'running', updatedAt: 'now' };
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:computer-automation', properties: state }) });
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:computer-activity', properties: { desktopId: 'desktop', activity } }) });
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:computer-activity', properties: { desktopId: 'desktop', activity: { ...activity, sessionId: 'same' } } }) });
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:computer-automation', properties: { ...state, cleanups: [{ execution: { runId: 'bad', work: { runtime: 'agent', threadId: 'same' } }, status: 'cancel-unconfirmed' }] } }) });
    expect(events).toEqual([{ type: 'computer-automation', state }, { type: 'computer-activity', desktopId: 'desktop', activity }]);
    unsubscribe();
  });

  test('decodes Computer invalidation identities without accepting bodies or incomplete work references', async () => {
    const { subscribeVarinEvents } = await import('./varinEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeVarinEvents(event => events.push(event));
    try {
      const source = MockEventSource.instances[0];
      const work = { runtime: 'agent', threadId: 'root', branchId: 'original-branch' };
      const send = (properties: unknown) => source.onmessage?.({ data: JSON.stringify({ type: 'varin:computer-automation-invalidated', properties }) });
      send({ work });
      send({ work, reason: 'Bodies do not belong in invalidations' });
      send({ work: { runtime: 'agent', threadId: 'root' } });
      send({ work: { runtime: 'agent', sessionId: 'root' } });
      expect(events).toEqual([{ type: 'computer-automation-invalidated', work }]);
    } finally { unsubscribe(); }
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

  test('binds a native Thread branch before opening SSE', async () => {
    mockThreadId = 'session-a';
    let release!: () => void;
    bindGate = new Promise<void>((resolve) => { release = resolve; });
    const { subscribeVarinEvents } = await import('./varinEvents');
    const unsubscribe = subscribeVarinEvents(() => undefined);

    expect(bindCalls).toEqual(['session-a']);
    expect(MockEventSource.instances).toHaveLength(0);
    release();
    await flushAsync();
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toContain('threadId=session-a');
    unsubscribe();
  });

  test('rebinds after a Thread switch and runtime reconnect', async () => {
    mockThreadId = 'session-a';
    const { subscribeVarinEvents } = await import('./varinEvents');
    const unsubscribe = subscribeVarinEvents(() => undefined);
    await flushAsync();
    const first = MockEventSource.instances[0];
    expect(first?.url).toContain('threadId=session-a');

    mockThreadId = 'session-b';
    for (const listener of threadListeners) {
      listener({ selectedIdentity: { runtime: 'agent', threadId: 'session-b', branchId: 'branch' } }, { selectedIdentity: { runtime: 'agent', threadId: 'session-a', branchId: 'branch' } });
    }
    await flushAsync();
    expect(first?.readyState).toBe(MockEventSource.CLOSED);
    expect(bindCalls).toEqual(['session-a', 'session-b']);
    expect(MockEventSource.instances.at(-1)?.url).toContain('threadId=session-b');

    MockEventSource.instances.at(-1)?.onerror?.();
    expect(bindCalls).toEqual(['session-a', 'session-b']);
    runtimeListener?.();
    await flushAsync();
    expect(bindCalls).toEqual(['session-a', 'session-b', 'session-b']);
    expect(MockEventSource.instances.at(-1)?.url).toContain('threadId=session-b');
    unsubscribe();
  });

  test('rebinds when only the native branch changes and discards an old Host binding result', async () => {
    mockThreadId = 'same-thread';
    const { subscribeVarinEvents } = await import('./varinEvents');
    const unsubscribe = subscribeVarinEvents(() => undefined);
    await flushAsync();
    const first = MockEventSource.instances.at(-1)!;
    mockBranchId = 'new-branch';
    for (const listener of threadListeners) listener({ selectedIdentity: { runtime: 'agent', threadId: mockThreadId, branchId: mockBranchId } },
      { selectedIdentity: { runtime: 'agent', threadId: mockThreadId, branchId: 'branch' } });
    await flushAsync();
    expect(first.readyState).toBe(MockEventSource.CLOSED);
    expect(MockEventSource.instances.at(-1)?.url).toContain('branchId=new-branch');
    let release!: () => void;
    bindGate = new Promise<void>(resolve => { release = resolve; });
    runtimeListener?.();
    const count = MockEventSource.instances.length;
    runtimeListener?.();
    release(); await flushAsync();
    expect(MockEventSource.instances).toHaveLength(count);
    bindGate = null; runtimeListener?.(); await flushAsync();
    expect(MockEventSource.instances).toHaveLength(count + 1);
    unsubscribe();
  });

  test('ignores messages and errors from a replaced Host stream', async () => {
    const { subscribeVarinEvents } = await import('./varinEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeVarinEvents(event => events.push(event));
    try {
      const oldSource = MockEventSource.instances[0];
      runtimeListener?.();
      const currentSource = MockEventSource.instances.at(-1)!;
      expect(currentSource).not.toBe(oldSource);
      const envelope = { data: JSON.stringify({ type: 'varin:event-stream-ready', properties: {} }) };
      oldSource.onmessage?.(envelope);
      expect(events).toEqual([]);
      oldSource.onerror?.();
      expect(currentSource.readyState).not.toBe(MockEventSource.CLOSED);
      currentSource.onmessage?.(envelope);
      expect(events).toEqual([{ type: 'stream-ready' }]);
    } finally { unsubscribe(); }
  });

  test('dispatches stream readiness and knowledge changes', async () => {
    const { subscribeVarinEvents } = await import('./varinEvents');
    const events: unknown[] = [];
    const unsubscribe = subscribeVarinEvents(event => events.push(event));
    const source = MockEventSource.instances[0];
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:event-stream-ready', properties: {} }) });
    source.onmessage?.({ data: JSON.stringify({ type: 'varin:harness-knowledge-changed', properties: { sessionId: 'owner', scope: 'user' } }) });
    expect(events).toEqual([
      { type: 'stream-ready' },
      { type: 'harness-knowledge-changed', sessionId: 'owner', scope: 'user' },
    ]);
    unsubscribe();
  });
});
