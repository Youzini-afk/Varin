import { afterEach, describe, expect, test } from 'vitest';
import type { editor, IDisposable } from 'monaco-editor/editor';

import type {
  VarinDebugEvent,
  VarinTestEvent,
  WorkspaceDebugAPI,
  WorkspaceTasksAPI,
  WorkspaceTestAPI,
} from '@varin/application-client';
import { bindRunDebugServices, resetRunDebugServices } from '@/lib/run-debug/session';
import {
  createRunDebugEditorAdapter,
  RUN_DEBUG_DECORATION_CLASS_NAMES,
} from './run-debug-editor-adapter';
import type { MonacoRuntime } from './runtime';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

class FakeDecorationsCollection {
  current: editor.IModelDeltaDecoration[] = [];
  clearCount = 0;

  clear(): void {
    this.clearCount += 1;
    this.current = [];
  }

  set(next: readonly editor.IModelDeltaDecoration[]): string[] {
    this.current = [...next];
    return next.map((_decoration, index) => `decoration-${index}`);
  }
}

class FakeEditor {
  readonly decorations = new FakeDecorationsCollection();
  mouseListener: ((event: editor.IEditorMouseEvent) => void) | undefined;
  modelListener: (() => void) | undefined;
  disposedListeners = 0;

  createDecorationsCollection(): editor.IEditorDecorationsCollection {
    return this.decorations as unknown as editor.IEditorDecorationsCollection;
  }

  getModel(): editor.ITextModel {
    return { getLineCount: () => 50 } as unknown as editor.ITextModel;
  }

  onDidChangeModel(listener: () => void): IDisposable {
    this.modelListener = listener;
    return {
      dispose: () => {
        this.disposedListeners += 1;
        this.modelListener = undefined;
      },
    };
  }

  onMouseDown(listener: (event: editor.IEditorMouseEvent) => void): IDisposable {
    this.mouseListener = listener;
    return {
      dispose: () => {
        this.disposedListeners += 1;
        this.mouseListener = undefined;
      },
    };
  }
}

const createServices = () => {
  let debugListener: ((event: VarinDebugEvent) => void) | undefined;
  let testListener: ((event: VarinTestEvent) => void) | undefined;
  const breakpointRequests: Parameters<WorkspaceDebugAPI['setBreakpoints']>[0][] = [];
  const subscriptions = { tasks: 0, debug: 0, tests: 0 };
  const tasks: WorkspaceTasksAPI = {
    list: async (workspaceId) => ({ status: 'ready', workspaceId, configurations: [] }),
    run: async (request) => ({ status: 'running', workspaceId: request.workspaceId }),
    cancel: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId }),
    subscribe() {
      subscriptions.tasks += 1;
      return { close: () => { subscriptions.tasks -= 1; } };
    },
    disposeWorkspace: async () => {},
  };
  const debug: WorkspaceDebugAPI = {
    getStatus: async (workspaceId) => ({ status: 'absent', workspaceId }),
    listBreakpoints: async (workspaceId) => ({ status: 'ready', workspaceId, breakpoints: [] }),
    setBreakpoints: async (request) => {
      breakpointRequests.push(request);
      return {
        status: 'ready',
        workspaceId: request.workspaceId,
        sessionId: 'debug-2',
        generation: 2,
        breakpoints: request.lines.map((line) => ({ resourceId: request.resourceId, line })),
      };
    },
    start: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
    stop: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId }),
    continue: async (request) => ({ status: 'running', workspaceId: request.workspaceId }),
    pause: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
    stepOver: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
    stepIn: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
    stepOut: async (request) => ({ status: 'paused', workspaceId: request.workspaceId }),
    getThreads: async () => ({
      status: 'ready',
      workspaceId: WORKSPACE_ID,
      sessionId: 'debug-2',
      generation: 2,
      value: [{ id: 42, name: 'worker' }],
    }),
    getStack: async () => ({
      status: 'ready',
      workspaceId: WORKSPACE_ID,
      sessionId: 'debug-2',
      generation: 2,
      value: [{ id: 9, name: 'top', line: 11, column: 1, resourceId: 'src/file.ts' }],
    }),
    getScopes: async () => ({ status: 'absent' }),
    getVariables: async () => ({ status: 'absent' }),
    evaluate: async () => ({ status: 'absent' }),
    listWatch: async (workspaceId) => ({ status: 'ready', workspaceId, expressions: [] }),
    addWatch: async (request) => ({ status: 'ready', workspaceId: request.workspaceId, expressions: [] }),
    removeWatch: async (request) => ({ status: 'ready', workspaceId: request.workspaceId, expressions: [] }),
    subscribe(_workspaceId, listener) {
      subscriptions.debug += 1;
      debugListener = listener;
      return {
        close: () => {
          subscriptions.debug -= 1;
          debugListener = undefined;
        },
      };
    },
    disposeWorkspace: async () => {},
  };
  const tests: WorkspaceTestAPI = {
    discover: async (request) => ({ status: 'empty', workspaceId: request.workspaceId, tests: [] }),
    run: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId }),
    cancel: async (request) => ({ status: 'stopped', workspaceId: request.workspaceId }),
    getStatus: async (workspaceId) => ({ status: 'absent', workspaceId }),
    subscribe(_workspaceId, listener) {
      subscriptions.tests += 1;
      testListener = listener;
      return {
        close: () => {
          subscriptions.tests -= 1;
          testListener = undefined;
        },
      };
    },
    disposeWorkspace: async () => {},
  };
  return {
    apis: { tasks, debug, tests },
    breakpointRequests,
    debugEvent: (event: VarinDebugEvent) => debugListener?.(event),
    subscriptions,
    testEvent: (event: VarinTestEvent) => testListener?.(event),
  };
};

afterEach(() => {
  resetRunDebugServices();
});

describe('Monaco run/debug editor adapter', () => {
  test('projects glyphs and dispatches the clicked gutter line, then fully disposes', async () => {
    const services = createServices();
    bindRunDebugServices(services.apis);
    const fakeEditor = new FakeEditor();
    const monaco = {
      editor: {
        MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
      },
    } as unknown as MonacoRuntime;
    const adapter = createRunDebugEditorAdapter({
      editor: fakeEditor as unknown as editor.IStandaloneCodeEditor,
      identity: { workspaceId: WORKSPACE_ID, resourceId: 'src/file.ts' },
      monaco,
    });
    expect(services.subscriptions).toEqual({ tasks: 1, debug: 1, tests: 1 });

    services.debugEvent({
      kind: 'breakpoints',
      snapshot: {
        status: 'ready',
        workspaceId: WORKSPACE_ID,
        sessionId: 'debug-2',
        generation: 2,
        breakpoints: [{ resourceId: 'src/file.ts', line: 3 }],
      },
    });
    services.debugEvent({
      kind: 'status',
      snapshot: { status: 'paused', workspaceId: WORKSPACE_ID, sessionId: 'debug-2', generation: 2 },
    });
    services.testEvent({
      kind: 'status',
      snapshot: { status: 'running', workspaceId: WORKSPACE_ID, runId: 'test-4', generation: 4 },
    });
    services.testEvent({
      kind: 'test',
      runId: 'test-4',
      generation: 4,
      test: {
        id: 'fails',
        label: 'fails',
        resourceId: 'src/file.ts',
        line: 19,
        status: 'failed',
      },
    });
    await flushPromises();
    const glyphClasses = fakeEditor.decorations.current.map((decoration) => (
      decoration.options.glyphMarginClassName
    ));
    expect(glyphClasses).toContain(RUN_DEBUG_DECORATION_CLASS_NAMES.breakpointGlyph);
    expect(glyphClasses).toContain(RUN_DEBUG_DECORATION_CLASS_NAMES.currentFrameGlyph);
    expect(glyphClasses).toContain(RUN_DEBUG_DECORATION_CLASS_NAMES.testFailureGlyph);

    fakeEditor.mouseListener?.({
      target: {
        type: 2,
        position: { lineNumber: 7, column: 1 },
      },
    } as unknown as editor.IEditorMouseEvent);
    await flushPromises();
    expect(services.breakpointRequests).toEqual([{
      workspaceId: WORKSPACE_ID,
      resourceId: 'src/file.ts',
      lines: [3, 7],
      expectedSessionId: 'debug-2',
      expectedGeneration: 2,
    }]);

    adapter.dispose();
    expect(fakeEditor.disposedListeners).toBe(2);
    expect(fakeEditor.decorations.current).toEqual([]);
    expect(services.subscriptions).toEqual({ tasks: 0, debug: 0, tests: 0 });
    expect(fakeEditor.mouseListener).toBeUndefined();
  });

  test('guards breakpoint preconfiguration against a session starting after an absent snapshot', async () => {
    const services = createServices();
    bindRunDebugServices(services.apis);
    const fakeEditor = new FakeEditor();
    const adapter = createRunDebugEditorAdapter({
      editor: fakeEditor as unknown as editor.IStandaloneCodeEditor,
      identity: { workspaceId: WORKSPACE_ID, resourceId: 'src/file.ts' },
      monaco: {
        editor: { MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 } },
      } as unknown as MonacoRuntime,
    });
    await flushPromises();
    fakeEditor.mouseListener?.({
      target: {
        type: 2,
        position: { lineNumber: 5, column: 1 },
      },
    } as unknown as editor.IEditorMouseEvent);
    await flushPromises();
    expect(services.breakpointRequests).toEqual([{
      workspaceId: WORKSPACE_ID,
      resourceId: 'src/file.ts',
      lines: [5],
      expectedSessionId: null,
      expectedGeneration: null,
    }]);
    adapter.dispose();
  });
});
