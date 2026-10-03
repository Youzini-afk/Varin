import { afterEach, describe, expect, test } from 'vitest';
import type {
  VarinDebugEvent,
  VarinDebugFeatureResult,
  VarinDebugStackFrame,
  VarinDebugThread,
  VarinTestEvent,
  VarinTestRunStatus,
  WorkspaceDebugAPI,
  WorkspaceTasksAPI,
  WorkspaceTestAPI,
} from '@varin/application-client';
import {
  acquireRunDebugView,
  bindRunDebugServices,
  getBoundRunDebugServices,
  isRunDebugViewActive,
  peekLastTestFailure,
  peekRunDebugEditorProjection,
  releaseRunDebugView,
  resetRunDebugServices,
  subscribeRunDebugEditorProjection,
} from './session';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

type HarnessOptions = {
  getStack?(request: { workspaceId: string; threadId: number }): Promise<VarinDebugFeatureResult<VarinDebugStackFrame[]>>;
  getTestStatus?(workspaceId: string): Promise<VarinTestRunStatus>;
  getThreads?(request: { workspaceId: string }): Promise<VarinDebugFeatureResult<VarinDebugThread[]>>;
};

const createHarness = (options: HarnessOptions = {}) => {
  const subscribed = { tasks: 0, debug: 0, tests: 0 };
  const disposed = { tasks: 0, debug: 0, tests: 0 };
  let debugListener: ((event: VarinDebugEvent) => void) | undefined;
  let testListener: ((event: VarinTestEvent) => void) | undefined;

  const tasks: WorkspaceTasksAPI = {
    list: async (workspaceId) => ({ status: 'ready', workspaceId, configurations: [] }),
    run: async (request) => ({ status: 'running', workspaceId: request.workspaceId, runId: 'task-1' }),
    cancel: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId, runId: request.runId }),
    subscribe() {
      subscribed.tasks += 1;
      return {
        close() {
          subscribed.tasks -= 1;
        },
      };
    },
    disposeWorkspace: async () => {
      disposed.tasks += 1;
    },
  };

  const debug: WorkspaceDebugAPI = {
    getStatus: async (workspaceId) => ({ status: 'absent', workspaceId }),
    listBreakpoints: async (workspaceId) => ({ status: 'ready', workspaceId, breakpoints: [] }),
    setBreakpoints: async (request) => ({ status: 'ready', workspaceId: request.workspaceId, breakpoints: [] }),
    start: async (request) => ({ status: 'paused', workspaceId: request.workspaceId, sessionId: 'debug-1', generation: 1 }),
    stop: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId }),
    continue: async (request) => ({ status: 'running', workspaceId: request.workspaceId }),
    pause: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
    stepOver: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
    stepIn: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
    stepOut: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
    getThreads: options.getThreads ?? (async () => ({ status: 'absent' })),
    getStack: options.getStack ?? (async () => ({ status: 'absent' })),
    getScopes: async () => ({ status: 'absent' }),
    getVariables: async () => ({ status: 'absent' }),
    evaluate: async () => ({ status: 'absent' }),
    listWatch: async (workspaceId) => ({ status: 'ready', workspaceId, expressions: [] }),
    addWatch: async (request) => ({ status: 'ready', workspaceId: request.workspaceId, expressions: [] }),
    removeWatch: async (request) => ({ status: 'ready', workspaceId: request.workspaceId, expressions: [] }),
    subscribe(_workspaceId, listener) {
      subscribed.debug += 1;
      debugListener = listener;
      return {
        close() {
          subscribed.debug -= 1;
          debugListener = undefined;
        },
      };
    },
    disposeWorkspace: async () => {
      disposed.debug += 1;
    },
  };

  const tests: WorkspaceTestAPI = {
    discover: async (request) => ({ status: 'empty', workspaceId: request.workspaceId, tests: [] }),
    run: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId }),
    cancel: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId }),
    getStatus: options.getTestStatus ?? (async (workspaceId) => ({ status: 'absent', workspaceId })),
    subscribe(_workspaceId, listener) {
      subscribed.tests += 1;
      testListener = listener;
      return {
        close() {
          subscribed.tests -= 1;
          testListener = undefined;
        },
      };
    },
    disposeWorkspace: async () => {
      disposed.tests += 1;
    },
  };

  return {
    apis: { tasks, debug, tests },
    debugEvent(event: VarinDebugEvent) {
      debugListener?.(event);
    },
    disposed,
    subscribed,
    testEvent(event: VarinTestEvent) {
      testListener?.(event);
    },
  };
};

afterEach(() => {
  resetRunDebugServices();
});

describe('run/debug editor projection lifecycle', () => {
  test('hidden workspaces do not retain event subscriptions or projected state', async () => {
    const harness = createHarness();
    bindRunDebugServices(harness.apis);
    expect(getBoundRunDebugServices()).not.toBeNull();
    expect(harness.subscribed.debug).toBe(0);

    acquireRunDebugView(WORKSPACE_ID);
    expect(isRunDebugViewActive(WORKSPACE_ID)).toBe(true);
    expect(harness.subscribed).toEqual({ tasks: 1, debug: 1, tests: 1 });
    harness.testEvent({
      kind: 'status',
      snapshot: { status: 'running', workspaceId: WORKSPACE_ID, runId: 'run-1', generation: 1 },
    });
    harness.testEvent({
      kind: 'test',
      runId: 'run-1',
      generation: 1,
      test: { id: 'fail.test.js', label: 'fails', status: 'failed', message: 'boom' },
    });
    expect(peekLastTestFailure(WORKSPACE_ID)?.message).toBe('boom');

    releaseRunDebugView(WORKSPACE_ID);
    await flushPromises();
    expect(isRunDebugViewActive(WORKSPACE_ID)).toBe(false);
    expect(harness.subscribed).toEqual({ tasks: 0, debug: 0, tests: 0 });
    expect(peekLastTestFailure(WORKSPACE_ID)).toBeUndefined();
    expect(peekRunDebugEditorProjection(WORKSPACE_ID).breakpoints).toEqual([]);
  });

  test('a projection consumer shares one workspace subscription and releases it on dispose', () => {
    const harness = createHarness();
    bindRunDebugServices(harness.apis);
    const first = subscribeRunDebugEditorProjection(WORKSPACE_ID, () => {});
    const second = subscribeRunDebugEditorProjection(WORKSPACE_ID, () => {});
    expect(harness.subscribed).toEqual({ tasks: 1, debug: 1, tests: 1 });
    first();
    expect(harness.subscribed.debug).toBe(1);
    second();
    expect(harness.subscribed).toEqual({ tasks: 0, debug: 0, tests: 0 });
  });
});

describe('run/debug editor projection ownership', () => {
  test('resolves the real paused thread top frame and drops the old session completion', async () => {
    const firstThreads = deferred<VarinDebugFeatureResult<VarinDebugThread[]>>();
    const secondThreads = deferred<VarinDebugFeatureResult<VarinDebugThread[]>>();
    const threadRequests: Array<{ workspaceId: string }> = [];
    const stackRequests: Array<{ workspaceId: string; threadId: number }> = [];
    const harness = createHarness({
      getThreads: async (request) => {
        threadRequests.push(request);
        return threadRequests.length === 1 ? firstThreads.promise : secondThreads.promise;
      },
      getStack: async (request) => {
        stackRequests.push(request);
        return {
          status: 'ready',
          workspaceId: WORKSPACE_ID,
          sessionId: 'debug-2',
          generation: 2,
          value: [{ id: 202, name: 'newTop', line: 17, column: 3, resourceId: 'src/new.ts' }],
        };
      },
    });
    bindRunDebugServices(harness.apis);
    acquireRunDebugView(WORKSPACE_ID);
    harness.debugEvent({
      kind: 'status',
      snapshot: { status: 'paused', workspaceId: WORKSPACE_ID, sessionId: 'debug-1', generation: 1 },
    });
    harness.debugEvent({
      kind: 'status',
      snapshot: { status: 'paused', workspaceId: WORKSPACE_ID, sessionId: 'debug-2', generation: 2 },
    });
    expect(threadRequests).toHaveLength(2);

    secondThreads.resolve({
      status: 'ready',
      workspaceId: WORKSPACE_ID,
      sessionId: 'debug-2',
      generation: 2,
      value: [{ id: 22, name: 'worker' }],
    });
    await flushPromises();
    expect(stackRequests).toEqual([{ workspaceId: WORKSPACE_ID, threadId: 22 }]);
    const projection = peekRunDebugEditorProjection(WORKSPACE_ID);
    expect(projection.debugOwner).toEqual({ sessionId: 'debug-2', generation: 2 });
    expect(projection.currentDebugFrame).toEqual({
      id: 202,
      name: 'newTop',
      line: 17,
      column: 3,
      resourceId: 'src/new.ts',
    });

    firstThreads.resolve({
      status: 'ready',
      workspaceId: WORKSPACE_ID,
      sessionId: 'debug-1',
      generation: 1,
      value: [{ id: 11, name: 'old-worker' }],
    });
    await flushPromises();
    expect(stackRequests).toHaveLength(1);
    expect(peekRunDebugEditorProjection(WORKSPACE_ID).currentDebugFrame?.name).toBe('newTop');
  });

  test('a new test run clears the previous failure and an older status completion cannot restore its owner', async () => {
    const initialStatus = deferred<VarinTestRunStatus>();
    const harness = createHarness({
      getTestStatus: () => initialStatus.promise,
    });
    bindRunDebugServices(harness.apis);
    acquireRunDebugView(WORKSPACE_ID);
    harness.testEvent({
      kind: 'status',
      snapshot: { status: 'running', workspaceId: WORKSPACE_ID, runId: 'run-1', generation: 1 },
    });
    harness.testEvent({
      kind: 'test',
      runId: 'run-1',
      generation: 1,
      test: { id: 'old', label: 'old', status: 'failed', message: 'old failure' },
    });
    expect(peekLastTestFailure(WORKSPACE_ID)?.id).toBe('old');

    harness.testEvent({
      kind: 'status',
      snapshot: { status: 'running', workspaceId: WORKSPACE_ID, runId: 'run-2', generation: 2 },
    });
    expect(peekRunDebugEditorProjection(WORKSPACE_ID).testOwner).toEqual({
      runId: 'run-2',
      generation: 2,
    });
    expect(peekLastTestFailure(WORKSPACE_ID)).toBeUndefined();

    harness.testEvent({
      kind: 'test',
      runId: 'run-1',
      generation: 1,
      test: { id: 'late-old', label: 'late old', status: 'failed', message: 'late old failure' },
    });
    expect(peekLastTestFailure(WORKSPACE_ID)).toBeUndefined();

    harness.testEvent({
      kind: 'test',
      runId: 'run-2',
      generation: 2,
      test: { id: 'new', label: 'new', status: 'failed', message: 'new failure' },
    });
    expect(peekLastTestFailure(WORKSPACE_ID)?.id).toBe('new');

    initialStatus.resolve({
      status: 'failed',
      workspaceId: WORKSPACE_ID,
      runId: 'run-1',
      generation: 1,
    });
    await flushPromises();
    expect(peekRunDebugEditorProjection(WORKSPACE_ID).testOwner).toEqual({
      runId: 'run-2',
      generation: 2,
    });
    expect(peekLastTestFailure(WORKSPACE_ID)?.id).toBe('new');
  });
});
