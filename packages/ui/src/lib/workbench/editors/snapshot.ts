import type { JsonValue } from '@varin/extension-contract';

import { listEditorGroups } from './groups';
import {
  EDITOR_WORKBENCH_SNAPSHOT_VERSION,
  type EditorGroupNode,
  type EditorProviderViewState,
  type EditorTab,
  type EditorViewState,
  type EditorWorkbenchState,
  type SnapshotRestoreResult,
} from './types';
import { createLegacyTextEditorViewState, type LegacyTextViewState } from './view-state-core';

type SnapshotEnvelope = {
  version: number;
  workspaceId: string;
  state: EditorWorkbenchState;
};

const isObject = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
};

const positiveInteger = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined
);

const nonNegativeNumber = (value: unknown): number | undefined => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
);

const normalizeProviderState = (value: unknown): EditorProviderViewState | undefined => {
  if (!isObject(value)) return undefined;
  if (
    typeof value.providerId !== 'string'
    || !value.providerId
    || !Number.isSafeInteger(value.schemaVersion)
    || Number(value.schemaVersion) < 1
    || !isJsonValue(value.value)
  ) return undefined;
  return {
    providerId: value.providerId,
    schemaVersion: Number(value.schemaVersion),
    value: value.value,
  };
};

const migrateLegacyViewState = (value: Record<string, unknown>): EditorProviderViewState | undefined => {
  const foldedLines = Array.isArray(value.foldedLines)
    ? value.foldedLines.filter((line): line is number => positiveInteger(line) !== undefined)
    : undefined;
  const legacy: LegacyTextViewState = {
    cursorLine: positiveInteger(value.cursorLine),
    cursorColumn: positiveInteger(value.cursorColumn),
    scrollTop: nonNegativeNumber(value.scrollTop),
    scrollLeft: nonNegativeNumber(value.scrollLeft),
    selectionStartLine: positiveInteger(value.selectionStartLine),
    selectionStartColumn: positiveInteger(value.selectionStartColumn),
    selectionEndLine: positiveInteger(value.selectionEndLine),
    selectionEndColumn: positiveInteger(value.selectionEndColumn),
    ...(foldedLines?.length ? { foldedLines } : {}),
  };
  if (Object.values(legacy).every((candidate) => candidate === undefined)) return undefined;
  return createLegacyTextEditorViewState(legacy).providerState;
};

const normalizeViewState = (value: unknown, snapshotVersion: number): EditorViewState => {
  if (!isObject(value)) return {};
  const viewState: EditorViewState = {};
  const previewScrollTop = nonNegativeNumber(value.previewScrollTop);
  if (previewScrollTop !== undefined) viewState.previewScrollTop = previewScrollTop;
  if (typeof value.browserTabId === 'string') viewState.browserTabId = value.browserTabId;
  if (typeof value.browserUrl === 'string') viewState.browserUrl = value.browserUrl;
  if (isObject(value.browserPosition) && typeof value.browserPosition.x === 'number' && Number.isFinite(value.browserPosition.x)
    && typeof value.browserPosition.y === 'number' && Number.isFinite(value.browserPosition.y)) {
    viewState.browserPosition = { x: value.browserPosition.x, y: value.browserPosition.y };
  }
  if (value.diffLayout === 'auto' || value.diffLayout === 'inline' || value.diffLayout === 'split') viewState.diffLayout = value.diffLayout;
  const info = value.editorInfo;
  if (isObject(info) && Number.isInteger(info.line) && Number(info.line) > 0
    && Number.isInteger(info.column) && Number(info.column) > 0 && typeof info.languageId === 'string'
    && Number.isInteger(info.tabSize) && Number(info.tabSize) > 0 && typeof info.insertSpaces === 'boolean') {
    viewState.editorInfo = { line: Number(info.line), column: Number(info.column), languageId: info.languageId,
      ...(typeof info.languageName === 'string' ? { languageName: info.languageName } : {}),
      tabSize: Number(info.tabSize), insertSpaces: info.insertSpaces };
  }
  if (value.diffScope === 'working' || value.diffScope === 'staged') viewState.diffScope = value.diffScope;
  if (typeof value.diffRepositoryResourceId === 'string') {
    const repositoryResourceId = value.diffRepositoryResourceId.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!repositoryResourceId.split('/').includes('..')) {
      viewState.diffRepositoryResourceId = repositoryResourceId;
    }
  }
  if (
    value.previewMode === 'preview'
    || value.previewMode === 'edit'
    || value.previewMode === 'tree'
    || value.previewMode === 'text'
  ) viewState.previewMode = value.previewMode;
  const providerState = normalizeProviderState(value.providerState)
    ?? (snapshotVersion === 1 ? migrateLegacyViewState(value) : undefined);
  if (providerState) viewState.providerState = providerState;
  return viewState;
};

const normalizeTab = (value: unknown, snapshotVersion: number): EditorTab | undefined => {
  if (
    !isObject(value)
    || typeof value.tabId !== 'string'
    || typeof value.viewId !== 'string'
    || typeof value.resourceId !== 'string'
    || typeof value.providerId !== 'string'
  ) return undefined;
  return {
    tabId: value.tabId,
    viewId: value.viewId,
    resourceId: value.resourceId,
    preview: value.preview === true,
    pinned: value.pinned === true,
    providerId: value.providerId,
    ...(value.providerPinned === true ? { providerPinned: true } : {}),
    viewState: normalizeViewState(value.viewState, snapshotVersion),
  };
};

const normalizeNode = (value: unknown, snapshotVersion: number): EditorGroupNode | undefined => {
  if (!isObject(value)) return undefined;
  if (value.type === 'group' && typeof value.groupId === 'string' && Array.isArray(value.tabs)) {
    const tabs = value.tabs.map((tab) => normalizeTab(tab, snapshotVersion));
    if (tabs.some((tab) => !tab)) return undefined;
    const normalizedTabs = tabs as EditorTab[];
    const activeTabId = typeof value.activeTabId === 'string'
      && normalizedTabs.some((tab) => tab.tabId === value.activeTabId)
      ? value.activeTabId
      : null;
    return { type: 'group', groupId: value.groupId, tabs: normalizedTabs, activeTabId };
  }
  if (
    value.type === 'split'
    && typeof value.splitId === 'string'
    && (value.direction === 'horizontal' || value.direction === 'vertical')
    && typeof value.ratio === 'number'
    && Number.isFinite(value.ratio)
    && value.ratio >= 0
    && value.ratio <= 1
  ) {
    const first = normalizeNode(value.first, snapshotVersion);
    const second = normalizeNode(value.second, snapshotVersion);
    if (!first || !second) return undefined;
    return {
      type: 'split',
      splitId: value.splitId,
      direction: value.direction,
      ratio: value.ratio,
      first,
      second,
    };
  }
  return undefined;
};

const normalizeWorkbench = (
  value: unknown,
  workspaceId: string,
  snapshotVersion: number,
): EditorWorkbenchState | undefined => {
  if (!isObject(value) || value.workspaceId !== workspaceId || typeof value.activeGroupId !== 'string') {
    return undefined;
  }
  const tree = normalizeNode(value.tree, snapshotVersion);
  if (!tree) return undefined;
  const ids = listEditorGroups(tree).map((group) => group.groupId);
  if (!ids.includes(value.activeGroupId)) return undefined;
  return { workspaceId, tree, activeGroupId: value.activeGroupId };
};

export const serializeEditorWorkbenchSnapshot = (state: EditorWorkbenchState): SnapshotEnvelope => ({
  version: EDITOR_WORKBENCH_SNAPSHOT_VERSION,
  workspaceId: state.workspaceId,
  state,
});

export const restoreEditorWorkbenchSnapshot = (
  raw: unknown,
  workspaceId: string,
): SnapshotRestoreResult => {
  if (raw === undefined || raw === null) return { status: 'missing' };
  if (raw === '' || (isObject(raw) && Object.keys(raw).length === 0)) return { status: 'empty' };
  try {
    const payload = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
    if (
      !isObject(payload)
      || (payload.version !== 1 && payload.version !== EDITOR_WORKBENCH_SNAPSHOT_VERSION)
      || payload.workspaceId !== workspaceId
    ) return { status: 'malformed' };
    const state = normalizeWorkbench(payload.state, workspaceId, payload.version);
    return state
      ? {
          status: 'ready',
          state,
          ...(payload.version === EDITOR_WORKBENCH_SNAPSHOT_VERSION ? {} : { migrated: true }),
        }
      : { status: 'malformed' };
  } catch (error) {
    return {
      status: 'failure',
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};
