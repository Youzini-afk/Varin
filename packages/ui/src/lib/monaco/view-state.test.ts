import { describe, expect, test, vi } from 'vitest';
import type { editor } from 'monaco-editor/editor';

import { createLegacyTextEditorViewState, textEditorSummaryFromViewState } from '@/lib/workbench/editors/view-state-core';
import { applyMonacoEditorViewState, captureMonacoEditorViewState, createMonacoNavigationViewState } from './view-state';

const editorStub = (overrides: Partial<editor.IStandaloneCodeEditor> = {}): editor.IStandaloneCodeEditor => ({
  getPosition: () => ({ lineNumber: 4, column: 7 }),
  getModel: () => null,
  getSelection: () => ({
    startLineNumber: 3,
    startColumn: 2,
    endLineNumber: 4,
    endColumn: 7,
    positionLineNumber: 4,
    positionColumn: 7,
    selectionStartLineNumber: 3,
    selectionStartColumn: 2,
    isEmpty: () => false,
  }) as editor.IStandaloneCodeEditor['getSelection'] extends () => infer T ? T : never,
  restoreViewState: vi.fn(),
  revealPositionInCenter: vi.fn(),
  revealRangeInCenter: vi.fn(),
  saveViewState: () => ({ cursorState: [], viewState: { scrollTop: 42 }, contributionsState: {} }),
  setPosition: vi.fn(),
  setScrollPosition: vi.fn(),
  setSelection: vi.fn(),
  ...overrides,
} as unknown as editor.IStandaloneCodeEditor);

describe('Monaco provider view state', () => {
  test('captures serializable Monaco state with a framework-neutral selection summary', () => {
    const viewState = captureMonacoEditorViewState(editorStub());
    expect(viewState.providerState?.schemaVersion).toBe(2);
    expect(textEditorSummaryFromViewState(viewState)).toEqual({
      cursor: { line: 4, column: 7 },
      selection: {
        start: { line: 3, column: 2 },
        end: { line: 4, column: 7 },
      },
    });
  });

  test('restores Monaco state and translates a migrated legacy position', () => {
    const restoreViewState = vi.fn();
    const setPosition = vi.fn();
    const setScrollPosition = vi.fn();
    const editorInstance = editorStub({ restoreViewState, setPosition, setScrollPosition });
    const captured = captureMonacoEditorViewState(editorStub());
    applyMonacoEditorViewState(editorInstance, captured);
    expect(restoreViewState).toHaveBeenCalledTimes(1);

    applyMonacoEditorViewState(editorInstance, createLegacyTextEditorViewState({
      cursorLine: 8,
      cursorColumn: 3,
      scrollTop: 120,
    }));
    expect(setPosition).toHaveBeenCalledWith({ lineNumber: 8, column: 3 });
    expect(setScrollPosition).toHaveBeenCalledWith({ scrollTop: 120 });

    const navigation = createMonacoNavigationViewState({
      startLineNumber: 12,
      startColumn: 4,
      endLineNumber: 12,
      endColumn: 9,
    });
    applyMonacoEditorViewState(editorInstance, navigation);
    expect(editorInstance.setSelection).toHaveBeenLastCalledWith({
      startLineNumber: 12,
      startColumn: 4,
      endLineNumber: 12,
      endColumn: 9,
    });
  });
});
