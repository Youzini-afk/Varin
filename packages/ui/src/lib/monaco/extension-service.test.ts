import { afterEach, describe, expect, test } from 'vitest';
import type { editor } from 'monaco-editor/editor';

import {
  createMonacoExtensionExternalService,
  getMonacoExtensionInspectorSnapshot,
  registerMonacoExtensionView,
  resetMonacoExtensionServiceForTests,
} from './extension-service';

const owner = {
  desiredRevision: 1,
  entrypointId: 'main',
  extensionId: 'dev.example.editor-tools',
  extensionVersion: '1.0.0',
  generation: 4,
  hostId: '2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a',
  realmId: 'window-test',
};

const fakeEditor = () => {
  const listeners: Array<() => void> = [];
  const decorationCalls: Array<{ old: string[]; next: unknown[] }> = [];
  const disposable = (listener: () => void) => {
    listeners.push(listener);
    return { dispose: () => undefined };
  };
  const model = {
    getLanguageId: () => 'typescript',
    validateRange: (range: unknown) => range,
  };
  const value = {
    deltaDecorations: (old: string[], next: unknown[]) => {
      decorationCalls.push({ old, next });
      return next.map((_, index) => `decoration-${index}`);
    },
    focus: () => undefined,
    getAction: () => ({ isSupported: () => true, run: async () => undefined }),
    getModel: () => model,
    getSelection: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    }),
    hasWidgetFocus: () => true,
    onDidChangeModel: disposable,
    onDidChangeCursorSelection: disposable,
    onDidFocusEditorWidget: disposable,
    revealRangeInCenter: () => undefined,
    setSelection: () => undefined,
  } as unknown as editor.IStandaloneCodeEditor;
  return { decorationCalls, editor: value, listeners };
};

afterEach(() => resetMonacoExtensionServiceForTests());

describe('Monaco extension service', () => {
  test('returns a serializable active view, streams lifecycle revisions, and rejects stale generations', async () => {
    const fake = fakeEditor();
    const disposeView = registerMonacoExtensionView({
      editor: fake.editor,
      getDocumentVersion: () => 0,
      identity: { workspaceId: 'workspace-1', resourceId: 'src/main.ts' },
      kind: 'text',
      providerId: 'varin.builtin.text',
      viewId: 'view-1',
    });
    const external = createMonacoExtensionExternalService(owner) as unknown as {
      dispose(): void;
      implementation: {
        getActiveView(): { status: string; view: { generation: number; resource: { resourceId: string } } };
        getState(): { status: string; state: { revision: number } };
        focus(request: { expectedViewGeneration: number }): { status: string; reason?: string };
        waitForState(request: { afterRevision: number }): Promise<{
          status: string;
          state?: { revision: number };
          reason?: string;
        }>;
      };
    };

    const active = external.implementation.getActiveView();
    expect(active.status).toBe('ready');
    expect(active.view.resource.resourceId).toBe('src/main.ts');
    expect(external.implementation.focus({ expectedViewGeneration: active.view.generation + 1 })).toEqual({
      status: 'stale',
      reason: 'view-generation-changed',
    });

    const state = external.implementation.getState();
    const changedState = external.implementation.waitForState({ afterRevision: state.state.revision });
    fake.listeners[1]?.();
    expect((await changedState).state?.revision).toBeGreaterThan(state.state.revision);

    const latest = external.implementation.getState();
    const cancelledState = external.implementation.waitForState({ afterRevision: latest.state.revision });
    external.dispose();
    expect(await cancelledState).toEqual({
      status: 'stale',
      reason: 'owner-generation-changed',
    });
    expect(external.implementation.getActiveView()).toEqual({
      status: 'stale',
      reason: 'owner-generation-changed',
    });
    disposeView();
  });

  test('owns decorations by extension generation and clears them on disposal', () => {
    const fake = fakeEditor();
    const disposeView = registerMonacoExtensionView({
      editor: fake.editor,
      getDocumentVersion: () => 0,
      identity: { workspaceId: 'workspace-1', resourceId: 'src/main.ts' },
      kind: 'text',
      providerId: 'varin.builtin.text',
      viewId: 'view-1',
    });
    const external = createMonacoExtensionExternalService(owner) as unknown as {
      dispose(): void;
      implementation: {
        setDecorations(request: Record<string, unknown>): { status: string };
      };
    };

    expect(external.implementation.setDecorations({
      sourceId: 'warnings',
      expectedDocumentVersion: 0,
      decorations: [{
        range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
        isWholeLine: true,
        className: 'dev-example-warning',
      }],
    }).status).toBe('ready');
    expect(getMonacoExtensionInspectorSnapshot().owners).toEqual([{
      entrypointId: owner.entrypointId,
      extensionId: owner.extensionId,
      generation: owner.generation,
      realmId: owner.realmId,
      registrationCount: 1,
    }]);

    external.dispose();
    expect(fake.decorationCalls.at(-1)).toEqual({ old: ['decoration-0'], next: [] });
    expect(getMonacoExtensionInspectorSnapshot().owners).toEqual([]);
    disposeView();
  });
});
