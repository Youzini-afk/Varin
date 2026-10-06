import type { JsonObject, JsonValue } from '@varin/extension-contract';
import type { editor } from 'monaco-editor/editor';

import type { EditorViewState } from '@/lib/workbench/editors/types';
import {
  isJsonObject,
  legacyTextValueFromViewState,
  MONACO_TEXT_EDITOR_VIEW_STATE_SCHEMA_VERSION,
  TEXT_EDITOR_VIEW_STATE_PROVIDER_ID,
} from '@/lib/workbench/editors/view-state-core';

const jsonClone = (value: unknown): JsonValue | undefined => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : JSON.parse(serialized) as JsonValue;
  } catch {
    return undefined;
  }
};

export const captureMonacoEditorViewState = (
  editorInstance: editor.IStandaloneCodeEditor,
  languageName?: string,
): EditorViewState => {
  const position = editorInstance.getPosition();
  const model = editorInstance.getModel();
  const selection = editorInstance.getSelection();
  const summary: JsonObject = {
    cursor: {
      line: position?.lineNumber ?? 1,
      column: position?.column ?? 1,
    },
  };
  if (selection && !selection.isEmpty()) {
    summary.selection = {
      start: { line: selection.startLineNumber, column: selection.startColumn },
      end: { line: selection.endLineNumber, column: selection.endColumn },
    };
  }
  const value: JsonObject = { summary };
  const state = jsonClone(editorInstance.saveViewState());
  if (state !== undefined) value.state = state;
  return {
    ...(position && model ? { editorInfo: {
      line: position.lineNumber, column: position.column,
      languageId: model.getLanguageId(),
      ...(languageName ? { languageName } : {}),
      tabSize: model.getOptions().tabSize,
      insertSpaces: model.getOptions().insertSpaces,
    } } : {}),
    providerState: {
      providerId: TEXT_EDITOR_VIEW_STATE_PROVIDER_ID,
      schemaVersion: MONACO_TEXT_EDITOR_VIEW_STATE_SCHEMA_VERSION,
      value,
    },
  };
};

export const applyMonacoEditorViewState = (
  editorInstance: editor.IStandaloneCodeEditor,
  viewState: EditorViewState,
): void => {
  const provider = viewState.providerState;
  if (!provider || provider.providerId !== TEXT_EDITOR_VIEW_STATE_PROVIDER_ID) return;
  if (provider.schemaVersion === MONACO_TEXT_EDITOR_VIEW_STATE_SCHEMA_VERSION) {
    if (!isJsonObject(provider.value)) return;
    if (isJsonObject(provider.value.state)) {
      editorInstance.restoreViewState(provider.value.state as unknown as editor.ICodeEditorViewState);
    }
    const summary = provider.value.summary;
    if (!isJsonObject(summary)) return;
    const selection = summary.selection;
    const cursor = summary.cursor;
    if (isJsonObject(selection) && isJsonObject(selection.start) && isJsonObject(selection.end)) {
      const range = {
        startLineNumber: Number(selection.start.line),
        startColumn: Number(selection.start.column),
        endLineNumber: Number(selection.end.line),
        endColumn: Number(selection.end.column),
      };
      if (Object.values(range).every((value) => Number.isInteger(value) && value > 0)) {
        editorInstance.setSelection(range);
        editorInstance.revealRangeInCenter(range);
      }
    } else if (isJsonObject(cursor)) {
      const position = { lineNumber: Number(cursor.line), column: Number(cursor.column) };
      if (Number.isInteger(position.lineNumber) && position.lineNumber > 0 && Number.isInteger(position.column) && position.column > 0) {
        editorInstance.setPosition(position);
        editorInstance.revealPositionInCenter(position);
      }
    }
    return;
  }
  const legacy = legacyTextValueFromViewState(viewState);
  if (!legacy) return;
  if (
    legacy.selectionStartLine
    && legacy.selectionStartColumn
    && legacy.selectionEndLine
    && legacy.selectionEndColumn
  ) {
    editorInstance.setSelection({
      startLineNumber: legacy.selectionStartLine,
      startColumn: legacy.selectionStartColumn,
      endLineNumber: legacy.selectionEndLine,
      endColumn: legacy.selectionEndColumn,
    });
  } else if (legacy.cursorLine) {
    editorInstance.setPosition({
      lineNumber: legacy.cursorLine,
      column: legacy.cursorColumn ?? 1,
    });
  }
  editorInstance.setScrollPosition({
    ...(typeof legacy.scrollTop === 'number' ? { scrollTop: legacy.scrollTop } : {}),
    ...(typeof legacy.scrollLeft === 'number' ? { scrollLeft: legacy.scrollLeft } : {}),
  });
};

export const createMonacoNavigationViewState = (range: {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}): EditorViewState => ({
  providerState: {
    providerId: TEXT_EDITOR_VIEW_STATE_PROVIDER_ID,
    schemaVersion: MONACO_TEXT_EDITOR_VIEW_STATE_SCHEMA_VERSION,
    value: {
      summary: {
        cursor: { line: range.startLineNumber, column: range.startColumn },
        selection: {
          start: { line: range.startLineNumber, column: range.startColumn },
          end: { line: range.endLineNumber, column: range.endColumn },
        },
      },
    },
  },
});
