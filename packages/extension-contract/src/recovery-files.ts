import type { RecoveryConversation } from './recovery.js';

export interface FileRecoveryPoint {
  title?: string;
  sourcePath?: string;
  id: string;
  runId: string;
  sourceRunId: string;
  before: string;
  after: string;
  createdAt: string;
  state: string;
  label?: string;
  paths: string[];
  byteLength: number;
}
export interface FileRecoverySource {
  runId: string;
  workspaceId: string;
  path: string;
}
export interface FileRecoveryTextSlice {
  kind: 'text' | 'binary' | 'missing' | 'unsupported';
  text?: string;
  byteLength: number;
  nextOffset: number;
  eof: boolean;
  version?: string;
}
export interface FileRecoveryPreview {
  path: string;
  current: FileRecoveryTextSlice;
  target: FileRecoveryTextSlice;
}
export interface FileRecoveryPath {
  path: string;
  status?: 'applied' | 'unchanged' | 'conflict' | 'busy' | 'unavailable' | 'pending' | 'failed' | 'interrupted';
  message?: string;
  expected?: Record<string, unknown>;
  target?: Record<string, unknown>;
}
export interface FileRecoveryOperation {
  message?: string;
  point?: string;
  undoOf?: string;
  sourceRunId?: string;
  createdAt?: string;
  operationId: string;
  status: 'applied' | 'partial' | 'failed' | 'pending';
  appliedPaths: string[];
  conflictPaths: string[];
  files: FileRecoveryPath[];
}
export interface FileRecoveryRequest {
  conversation: RecoveryConversation;
  action: 'list' | 'history' | 'inspect' | 'preview' | 'storage' | 'operation' | 'restore' | 'undo' | 'name' | 'release';
  path?: string;
  currentOffset?: number;
  targetOffset?: number;
  sourceRunId?: string;
  point?: string;
  operationId?: string;
  requestId?: string;
  paths?: string[];
  overwritePaths?: string[];
  name?: string;
  cursor?: number;
  limit?: number;
}
export interface FileRecoveryResult {
  source?: FileRecoverySource;
  preview?: FileRecoveryPreview;
  storage?: { byteLength: number; objectCount: number };
  currentSourceRunId?: string;
  failures?: string[];
  points?: FileRecoveryPoint[];
  nextCursor?: number | null;
  files?: FileRecoveryPath[];
  operation?: FileRecoveryOperation;
  operations?: FileRecoveryOperation[];
  released?: boolean;
}

export function parseFileRecoveryRequest(input: unknown): FileRecoveryRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('File recovery request is required');
  const value = input as FileRecoveryRequest;
  if (!['list', 'history', 'inspect', 'preview', 'storage', 'operation', 'restore', 'undo', 'name', 'release'].includes(value.action)
    || value.conversation?.kind !== 'thread' || !value.conversation.threadId || !value.conversation.branchId) throw new Error('File recovery requires its conversation');
  for (const key of ['sourceRunId', 'point', 'operationId', 'requestId', 'name', 'path'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim())) throw new Error(`${key} must be a non-empty string`);
  }
  for (const key of ['paths', 'overwritePaths'] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(path => typeof path !== 'string' || !path))) throw new Error(`${key} must contain file paths`);
  }
  for (const key of ['cursor', 'limit', 'currentOffset', 'targetOffset'] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key]! < (key === 'limit' ? 1 : 0))) throw new Error(`${key} is invalid`);
  }
  if (['inspect', 'preview', 'restore', 'release'].includes(value.action) && !value.point) throw new Error('A recovery point is required');
  if (value.action === 'preview' && !value.path) throw new Error('Select a file to preview');
  if (['undo', 'operation'].includes(value.action) && !value.operationId) throw new Error('An original restore operation is required');
  if (value.action === 'name' && !value.name) throw new Error('A recovery point name is required');
  return {
    action: value.action,
    conversation: { kind: 'thread', threadId: value.conversation.threadId, branchId: value.conversation.branchId },
    ...Object.fromEntries(['sourceRunId', 'point', 'operationId', 'requestId', 'paths', 'overwritePaths', 'name', 'cursor', 'limit', 'path', 'currentOffset', 'targetOffset']
      .filter(key => (value as unknown as Record<string, unknown>)[key] !== undefined)
      .map(key => [key, (value as unknown as Record<string, unknown>)[key]])),
  };
}

export function parseFileRecoveryResult(input: unknown): FileRecoveryResult {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid file recovery response');
    return value as Record<string, unknown>;
  };
  const text = (value: unknown): string => { if (typeof value !== 'string') throw new Error('Invalid file recovery text'); return value; };
  const strings = (value: unknown): string[] => { if (!Array.isArray(value)) throw new Error('Invalid file recovery paths'); return value.map(text); };
  const files = (value: unknown): FileRecoveryPath[] => {
    if (!Array.isArray(value)) throw new Error('Invalid recovery files');
    return value.map(value => {
      const file = object(value);
      return { path: text(file.path), ...(file.status ? { status: text(file.status) as NonNullable<FileRecoveryPath['status']> } : {}),
        ...(file.message ? { message: text(file.message) } : {}), ...(file.expected ? { expected: object(file.expected) } : {}), ...(file.target ? { target: object(file.target) } : {}) };
    });
  };
  const operation = (value: unknown): FileRecoveryOperation => {
    const row = object(value);
    if (!['applied', 'partial', 'failed', 'pending'].includes(text(row.status))) throw new Error('Invalid restore status');
    return { operationId: text(row.operationId), status: row.status as FileRecoveryOperation['status'],
      appliedPaths: strings(row.appliedPaths), conflictPaths: strings(row.conflictPaths), files: files(row.files),
      ...Object.fromEntries(['sourceRunId', 'createdAt', 'point', 'undoOf', 'message'].filter(key => row[key] !== undefined && row[key] !== null).map(key => [key, text(row[key])])) };
  };
  const row = object(input);
  const result: FileRecoveryResult = {};
  if (row.storage !== undefined) {
    const storage = object(row.storage);
    if (![storage.byteLength, storage.objectCount].every(value => Number.isSafeInteger(value) && (value as number) >= 0)) throw new Error('Invalid recovery storage statistics');
    result.storage = { byteLength: storage.byteLength as number, objectCount: storage.objectCount as number };
  }
  if (row.source !== undefined) {
    const source = object(row.source);
    result.source = { runId: text(source.runId), workspaceId: text(source.workspaceId), path: text(source.path) };
  }
  if (row.preview !== undefined) {
    const preview = object(row.preview);
    const slice = (value: unknown): FileRecoveryTextSlice => {
      const part = object(value);
      if (!['text', 'binary', 'missing', 'unsupported'].includes(text(part.kind))
        || typeof part.eof !== 'boolean' || !Number.isSafeInteger(part.byteLength) || (part.byteLength as number) < 0
        || !Number.isSafeInteger(part.nextOffset) || (part.nextOffset as number) < 0) throw new Error('Invalid recovery content page');
      return { kind: part.kind as FileRecoveryTextSlice['kind'], byteLength: part.byteLength as number,
        nextOffset: part.nextOffset as number, eof: part.eof,
        ...(part.kind === 'text' ? { text: text(part.text) } : {}), ...(part.version ? { version: text(part.version) } : {}) };
    };
    result.preview = { path: text(preview.path), current: slice(preview.current), target: slice(preview.target) };
  }
  if (row.points !== undefined) {
    if (!Array.isArray(row.points)) throw new Error('Invalid recovery points');
    result.points = row.points.map(value => {
      const point = object(value);
      if (typeof point.byteLength !== 'number' || point.byteLength < 0) throw new Error('Invalid point size');
      return { id: text(point.id), runId: text(point.runId), sourceRunId: text(point.sourceRunId), before: text(point.before), after: text(point.after),
        createdAt: text(point.createdAt), state: text(point.state), paths: strings(point.paths), byteLength: point.byteLength,
        ...(point.sourcePath ? { sourcePath: text(point.sourcePath) } : {}),
        ...(point.title ? { title: text(point.title) } : {}),
        ...(point.label ? { label: text(point.label) } : {}) };
    });
  }
  if (row.nextCursor !== undefined) {
    if (row.nextCursor !== null && (!Number.isSafeInteger(row.nextCursor) || (row.nextCursor as number) < 0)) throw new Error('Invalid recovery cursor');
    result.nextCursor = row.nextCursor as number | null;
  }
  if (row.currentSourceRunId !== undefined) result.currentSourceRunId = text(row.currentSourceRunId);
  if (row.files !== undefined) result.files = files(row.files);
  if (row.operation !== undefined) result.operation = operation(row.operation);
  if (row.operations !== undefined) {
    if (!Array.isArray(row.operations)) throw new Error('Invalid restore history');
    result.operations = row.operations.map(operation);
  }
  if (row.failures !== undefined) result.failures = strings(row.failures);
  if (row.released !== undefined) {
    if (typeof row.released !== 'boolean') throw new Error('Invalid release result');
    result.released = row.released;
  }
  return result;
}
