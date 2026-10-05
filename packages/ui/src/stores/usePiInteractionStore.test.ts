import { describe, expect, test } from 'vitest';
import {
  VARIN_PROTOCOL_VERSION,
  type HostEvent,
  type HostEventData,
  type RuntimeEventEnvelope,
  type RuntimeMethod,
  type RuntimeMethodParams,
  type RuntimeWorkerRole,
} from '@varin/protocol';
import {
  createPiInteractionStore,
  type PiInteractionRuntimeClient,
  type PiInteractionStoreRuntime,
} from './usePiInteractionStore';

class FakeRuntime implements PiInteractionStoreRuntime {
  key = 'runtime-a';
  readonly calls: Array<{ method: RuntimeMethod; params: unknown }> = [];
  readonly #changedListeners = new Set<() => void>();
  readonly #eventListeners = new Set<(event: RuntimeEventEnvelope) => void>();
  handler: (method: RuntimeMethod, params: unknown) => unknown | Promise<unknown> = () => ({
    accepted: true,
  });

  readonly client: PiInteractionRuntimeClient = {
    request: (async <M extends RuntimeMethod>(method: M, params: RuntimeMethodParams<M>) => {
      this.calls.push({ method, params });
      return this.handler(method, params) as never;
    }) as PiInteractionRuntimeClient['request'],
    subscribe: (listener) => {
      this.#eventListeners.add(listener);
      return () => this.#eventListeners.delete(listener);
    },
  };

  async connect() {
    return { client: this.client, runtimeKey: this.key };
  }

  currentKey() {
    return this.key;
  }

  event<E extends HostEvent>(
    event: E,
    data: HostEventData<E>,
    source: { role: RuntimeWorkerRole; sessionId?: string; workerId: string },
    seq = 1,
  ) {
    const envelope = {
      data,
      event,
      kind: 'event',
      seq,
      source,
      v: VARIN_PROTOCOL_VERSION,
    } as RuntimeEventEnvelope<E>;
    for (const listener of this.#eventListeners) listener(envelope);
  }

  subscribeChanged(listener: () => void) {
    this.#changedListeners.add(listener);
    return () => this.#changedListeners.delete(listener);
  }

  switchTo(key: string) {
    this.key = key;
    for (const listener of this.#changedListeners) listener();
  }
}

describe('Pi interaction state', () => {
  test('hides a question without cancelling it, keeps its draft, and can answer after reopening', async () => {
    const runtime = new FakeRuntime();
    const store = createPiInteractionStore(runtime);
    await store.getState().connect();
    runtime.event('extension.ui.request', { id: 'question-1', method: 'question', sessionId: 'session-a', payload: {
      id: 'question-1', sessionId: 'session-a', createdAt: Date.now(), popupUntil: Date.now() + 60_000,
      questions: [{ id: 'name', type: 'input', question: 'Project name?' }],
    } }, { role: 'session', sessionId: 'session-a', workerId: 'worker-a' });
    store.getState().setQuestionDraft('question-1', 'name', 'Sample');
    store.getState().hideQuestion('question-1');
    expect(runtime.calls).toHaveLength(0);
    expect(store.getState().dialogs).toHaveLength(1);
    runtime.event('session.closed', { sessionId: 'session-a' }, { role: 'session', sessionId: 'session-a', workerId: 'worker-a' });
    runtime.event('session.worker.exited', { sessionId: 'session-a', expected: true, code: 0, signal: null }, { role: 'session', sessionId: 'session-a', workerId: 'worker-a' });
    expect(store.getState().dialogs).toHaveLength(1);
    store.getState().showQuestion('question-1');
    expect(store.getState().hiddenQuestions['question-1']).toBeUndefined();
    expect(store.getState().questionDrafts['question-1']?.name).toBe('Sample');
    expect(await store.getState().respondDialog('question-1', [{ id: 'name', type: 'input', value: 'Sample' }])).toBe(true);
    expect(store.getState().dialogs).toHaveLength(0);
    expect(store.getState().questionDrafts['question-1']).toBeUndefined();
  });

  test('lets the surface answer project trust for the exact worker', async () => {
    const runtime = new FakeRuntime();
    const store = createPiInteractionStore(runtime);
    await store.getState().connect();

    runtime.event('project.trust.request', {
      cwd: 'D:/work',
      id: 'trust-1',
      reason: 'project-resources',
    }, {
      role: 'catalog',
      workerId: 'catalog-worker',
    });

    expect(store.getState().trustRequests).toEqual([{
      cwd: 'D:/work',
      id: 'trust-1',
      reason: 'project-resources',
      role: 'catalog',
      workerId: 'catalog-worker',
    }]);
    expect(await store.getState().respondTrust('trust-1', true, true)).toBe(true);
    expect(runtime.calls.at(-1)).toEqual({
      method: 'project.trust.respond',
      params: {
        remember: true,
        requestId: 'trust-1',
        trusted: true,
        workerId: 'catalog-worker',
      },
    });
    expect(store.getState().trustRequests).toEqual([]);
  });

  test('queues interactive extension requests and respects host dismissals', async () => {
    const runtime = new FakeRuntime();
    const store = createPiInteractionStore(runtime);
    await store.getState().connect();
    const source = { role: 'session' as const, sessionId: 'session-a', workerId: 'worker-a' };

    runtime.event('extension.ui.request', {
      id: 'confirm-1',
      method: 'confirm',
      payload: { message: 'Apply?', title: 'Plugin question' },
      sessionId: 'session-a',
    }, source);
    expect(store.getState().dialogs.map((dialog) => dialog.id)).toEqual(['confirm-1']);

    expect(await store.getState().respondDialog('confirm-1', true)).toBe(true);
    expect(runtime.calls.at(-1)).toEqual({
      method: 'extension.ui.respond',
      params: {
        response: { requestId: 'confirm-1', value: true },
        sessionId: 'session-a',
      },
    });
    expect(store.getState().dialogs).toEqual([]);

    runtime.event('extension.ui.request', {
      id: 'input-1',
      method: 'input',
      payload: { placeholder: 'value', title: 'Input' },
      sessionId: 'session-a',
    }, source, 2);
    runtime.event('extension.ui.dismiss', {
      requestId: 'input-1',
      sessionId: 'session-a',
    }, source, 3);
    expect(store.getState().dialogs).toEqual([]);

    runtime.event('extension.ui.request', {
      id: 'custom-1',
      method: 'custom',
      payload: { lines: ['Extension output'], title: 'Extension panel' },
      sessionId: 'session-a',
    }, source, 4);
    expect(store.getState().dialogs.map((candidate) => candidate.method)).toEqual(['custom']);
  });

  test('returns a permission plugin select choice unchanged to its owning Pi request', async () => {
    const runtime = new FakeRuntime();
    const store = createPiInteractionStore(runtime);
    await store.getState().connect();
    const source = { role: 'session' as const, sessionId: 'session-a', workerId: 'worker-a' };
    runtime.event('extension.ui.request', {
      id: 'permission-select-1',
      method: 'select',
      payload: {
        options: ['Yes', 'Yes, for this session', 'No', 'No, provide reason'],
        title: 'Permission Required\ntool : bash\nvalue : git status',
      },
      sessionId: 'session-a',
    }, source);

    expect(await store.getState().respondDialog('permission-select-1', 'Yes, for this session')).toBe(true);
    expect(runtime.calls.at(-1)).toEqual({
      method: 'extension.ui.respond',
      params: {
        response: {
          requestId: 'permission-select-1',
          value: 'Yes, for this session',
        },
        sessionId: 'session-a',
      },
    });
  });

  test('projects persistent extension chrome and editor text without plugin whitelists', async () => {
    const runtime = new FakeRuntime();
    const store = createPiInteractionStore(runtime);
    await store.getState().connect();
    const source = { role: 'session' as const, sessionId: 'session-a', workerId: 'worker-a' };
    const request = (method: HostEventData<'extension.ui.request'>['method'], payload: HostEventData<'extension.ui.request'>['payload'], seq: number) => {
      runtime.event('extension.ui.request', { method, payload, sessionId: 'session-a' }, source, seq);
    };

    request('setStatus', { key: 'pi-wtf', text: 'Checking prompt' }, 1);
    request('setWidget', {
      key: 'pi-wtf-typo',
      lines: ['checking restored prompt'],
      placement: 'aboveEditor',
    }, 2);
    request('setTitle', { title: 'Extension workspace' }, 3);
    request('setEditorText', { text: 'restored prompt' }, 4);
    request('setWorkingMessage', { message: 'Inspecting' }, 5);
    request('setWorkingVisible', { visible: true }, 6);
    request('setWorkingIndicator', { frames: ['a', 'b'], intervalMs: 25 }, 7);
    request('setHiddenThinkingLabel', { label: 'Reasoning privately' }, 8);
    request('notify', { message: 'Done', type: 'warning' }, 9);

    expect(store.getState().sessions['session-a']).toEqual({
      editorText: { revision: 1, text: 'restored prompt' },
      hiddenThinkingLabel: 'Reasoning privately',
      statuses: { 'pi-wtf': 'Checking prompt' },
      title: 'Extension workspace',
      widgets: {
        'pi-wtf-typo': {
          lines: ['checking restored prompt'],
          placement: 'aboveEditor',
        },
      },
      workingIndicator: { frames: ['a', 'b'], intervalMs: 25 },
      workingMessage: 'Inspecting',
      workingVisible: true,
    });
    expect(store.getState().notices).toEqual([{
      id: 'runtime-a:worker-a:9',
      message: 'Done',
      sessionId: 'session-a',
      type: 'warning',
    }]);

    request('setStatus', { key: 'pi-wtf', text: null }, 10);
    request('setWidget', { key: 'pi-wtf-typo', lines: null, placement: 'aboveEditor' }, 11);
    request('setWorkingMessage', { message: null }, 12);
    request('setWorkingIndicator', null, 13);
    request('setHiddenThinkingLabel', { label: null }, 14);
    expect(store.getState().sessions['session-a']).toEqual({
      editorText: { revision: 1, text: 'restored prompt' },
      statuses: {},
      title: 'Extension workspace',
      widgets: {},
      workingVisible: true,
    });
  });

  test('clears session chrome on close and all interactions on runtime change', async () => {
    const runtime = new FakeRuntime();
    const store = createPiInteractionStore(runtime);
    await store.getState().connect();
    const source = { role: 'session' as const, sessionId: 'session-a', workerId: 'worker-a' };
    runtime.event('extension.ui.request', {
      method: 'setStatus',
      payload: { key: 'plugin', text: 'active' },
      sessionId: 'session-a',
    }, source);
    runtime.event('session.closed', { sessionId: 'session-a' }, source, 2);
    expect(store.getState().sessions).toEqual({});

    runtime.event('project.trust.request', {
      cwd: 'D:/other',
      id: 'trust-2',
      reason: 'project-resources',
    }, { role: 'catalog', workerId: 'catalog-worker' }, 3);
    runtime.switchTo('runtime-b');
    const state = store.getState();
    expect({
      connected: state.connected,
      dialogs: state.dialogs,
      notices: state.notices,
      runtimeKey: state.runtimeKey,
      sessions: state.sessions,
      trustRequests: state.trustRequests,
    }).toEqual({
      connected: false,
      dialogs: [],
      notices: [],
      runtimeKey: 'runtime-b',
      sessions: {},
      trustRequests: [],
    });
  });

  test('clears extension dialogs and chrome when their session worker exits', async () => {
    const runtime = new FakeRuntime();
    const store = createPiInteractionStore(runtime);
    await store.getState().connect();
    const source = { role: 'session' as const, sessionId: 'session-a', workerId: 'worker-a' };
    runtime.event('extension.ui.request', {
      id: 'confirm-exit',
      method: 'confirm',
      payload: { message: 'Continue?', title: 'Pending' },
      sessionId: 'session-a',
    }, source);
    runtime.event('extension.ui.request', {
      method: 'setStatus',
      payload: { key: 'plugin', text: 'working' },
      sessionId: 'session-a',
    }, source, 2);

    runtime.event('session.worker.exited', {
      code: 1,
      expected: false,
      sessionId: 'session-a',
      signal: null,
    }, source, 3);

    expect(store.getState().dialogs).toEqual([]);
    expect(store.getState().sessions).toEqual({});
  });
});
