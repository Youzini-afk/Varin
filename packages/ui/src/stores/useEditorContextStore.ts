import { create } from 'zustand';

import { subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';

export interface EditorSelection {
  endColumn?: number;
  endLine: number;
  startColumn?: number;
  startLine: number;
  text: string;
}

export interface ActiveEditorFile {
  documentInstanceId: string;
  fileName: string;
  filePath: string;
  fileSize: number | null;
  relativePath: string;
  runtimeKey: string;
  selection: EditorSelection | null;
  dirty: boolean;
  viewId: string;
  workspaceId: string | null;
}

interface EditorContextStoreState {
  activeEditorFile: ActiveEditorFile | null;
}

const filesByOwner = new Map<string, ActiveEditorFile>();
let activeOwnerId: string | null = null;

const normalizedString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
};

const normalizeSelection = (value: unknown): EditorSelection | null => {
  if (!value || typeof value !== 'object') return null;
  const selection = value as Record<string, unknown>;
  const startLine = selection.startLine;
  const endLine = selection.endLine;
  if (
    !Number.isInteger(startLine)
    || !Number.isInteger(endLine)
    || (startLine as number) < 1
    || (endLine as number) < (startLine as number)
    || typeof selection.text !== 'string'
    || selection.text.length === 0
  ) return null;
  return {
    ...(Number.isInteger(selection.endColumn) && Number(selection.endColumn) >= 1
      ? { endColumn: Number(selection.endColumn) }
      : {}),
    endLine: endLine as number,
    ...(Number.isInteger(selection.startColumn) && Number(selection.startColumn) >= 1
      ? { startColumn: Number(selection.startColumn) }
      : {}),
    startLine: startLine as number,
    text: selection.text,
  };
};

export const normalizeActiveEditorFile = (value: unknown): ActiveEditorFile | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const fileName = normalizedString(record.fileName);
  const filePath = normalizedString(record.filePath);
  const relativePath = normalizedString(record.relativePath);
  const runtimeKey = normalizedString(record.runtimeKey);
  const workspaceIdIsNull = record.workspaceId === null;
  const workspaceId = workspaceIdIsNull ? null : normalizedString(record.workspaceId);
  const documentInstanceId = normalizedString(record.documentInstanceId);
  const viewId = normalizedString(record.viewId);
  if (
    !fileName
    || !filePath
    || !relativePath
    || !runtimeKey
    || (!workspaceIdIsNull && !workspaceId)
    || !documentInstanceId
    || !viewId
  ) {
    return null;
  }
  const fileSize = record.fileSize === null
    ? null
    : typeof record.fileSize === 'number' && Number.isFinite(record.fileSize) && record.fileSize >= 0
      ? record.fileSize
      : null;
  return {
    fileName,
    filePath,
    fileSize,
    relativePath,
    runtimeKey,
    selection: normalizeSelection(record.selection),
    dirty: record.dirty === true,
    documentInstanceId,
    viewId,
    workspaceId,
  };
};

const sameSelection = (left: EditorSelection | null, right: EditorSelection | null): boolean => (
  left === right
  || (left !== null
    && right !== null
    && left.startLine === right.startLine
    && left.endLine === right.endLine
    && left.startColumn === right.startColumn
    && left.endColumn === right.endColumn
    && left.text === right.text)
);

const sameActiveEditorFile = (left: ActiveEditorFile | null, right: ActiveEditorFile | null): boolean => (
  left === right
  || (left !== null
    && right !== null
    && left.fileName === right.fileName
    && left.filePath === right.filePath
    && left.fileSize === right.fileSize
    && left.relativePath === right.relativePath
    && left.runtimeKey === right.runtimeKey
    && left.workspaceId === right.workspaceId
    && left.documentInstanceId === right.documentInstanceId
    && left.viewId === right.viewId
    && left.dirty === right.dirty
    && sameSelection(left.selection, right.selection))
);

export const useEditorContextStore = create<EditorContextStoreState>(() => ({
  activeEditorFile: null,
}));

const publishActive = (file: ActiveEditorFile | null): void => {
  const current = useEditorContextStore.getState().activeEditorFile;
  if (sameActiveEditorFile(current, file)) return;
  useEditorContextStore.setState({ activeEditorFile: file });
};

export const publishEditorContext = (ownerId: string, value: ActiveEditorFile): void => {
  const file = normalizeActiveEditorFile(value);
  if (!ownerId || !file || file.runtimeKey !== getRuntimeKey()) return;
  filesByOwner.set(ownerId, file);
  if (activeOwnerId === ownerId) publishActive(file);
};

export const activateEditorContextOwner = (ownerId: string | null): void => {
  activeOwnerId = ownerId;
  publishActive(ownerId ? filesByOwner.get(ownerId) ?? null : null);
};

export const releaseEditorContextOwner = (ownerId: string): void => {
  filesByOwner.delete(ownerId);
  if (activeOwnerId !== ownerId) return;
  activeOwnerId = null;
  publishActive(null);
};

export const resetEditorContext = (): void => {
  filesByOwner.clear();
  activeOwnerId = null;
  publishActive(null);
};

subscribeRuntimeEndpointWillChange(resetEditorContext);
