import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import { resourceIdFromWorkspacePath } from '@/lib/documents/path';
import type { DocumentIdentity } from '@/lib/documents/types';
import type { AgentFileChangeHint, AgentFileChangeKind, ToolFileChange } from './types';

const listeners = new Set<() => void>();
const hints = new Map<string, AgentFileChangeHint>();
let snapshotRevision = 0;
const snapshotCache = new Map<string, { revision: number; value: AgentFileChangeHint[] }>();

const hintKey = (workspaceId: string, resourceId: string): string => `${workspaceId}\0${resourceId}`;

const resourceIdForHint = (workspaceRoot: string, filePath: string): string | undefined => {
  const fromAbsolute = resourceIdFromWorkspacePath(workspaceRoot, filePath);
  if (fromAbsolute !== null) return fromAbsolute || undefined;
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return undefined;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return undefined;
  return segments.join('/');
};

const emit = (): void => {
  snapshotRevision += 1;
  snapshotCache.clear();
  for (const listener of listeners) listener();
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const stringField = (record: Record<string, unknown>, keys: readonly string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
};

const APPLY_PATCH_FILE = /^\*\*\*\s+(Add File|Update File|Delete File|Move to):\s+(.+)$/;

export const extractToolFileChanges = (toolName: string, args: unknown): ToolFileChange[] => {
  if (toolName === 'bash' || toolName === 'grep' || toolName === 'read') return [];
  if (!isRecord(args) && typeof args !== 'string') return [];
  if (toolName === 'apply_patch') {
    const patch = isRecord(args)
      ? stringField(args, ['patchText', 'patch_text', 'patch']) ?? ''
      : args;
    const found: ToolFileChange[] = [];
    for (const line of patch.split('\n')) {
      const match = line.match(APPLY_PATCH_FILE);
      if (!match) continue;
      const action = match[1];
      const path = match[2]?.trim();
      if (!path) continue;
      if (action === 'Move to') {
        const previous = found.at(-1);
        if (previous) {
          previous.kind = 'move';
          previous.fromPath = previous.path;
          previous.path = path;
        }
        continue;
      }
      found.push({
        path,
        kind: action === 'Delete File' ? 'delete' : action === 'Add File' ? 'write' : 'patch',
      });
    }
    return found;
  }
  if (!isRecord(args)) return [];
  const path = stringField(args, ['path', 'filePath', 'file_path', 'filename']);
  const fromPath = stringField(args, ['oldPath', 'old_path', 'from', 'source']);
  const toPath = stringField(args, ['newPath', 'new_path', 'to', 'dest', 'destination']);
  if (toolName === 'delete' || toolName === 'remove') {
    return path ? [{ path, kind: 'delete' }] : [];
  }
  if (toolName === 'move' || toolName === 'rename') {
    const from = fromPath ?? path;
    const to = toPath ?? path;
    if (!from || !to) return [];
    return [{ path: to, kind: 'move', fromPath: from }];
  }
  if (!path) return [];
  const kind: AgentFileChangeKind = toolName === 'write' ? 'write' : toolName === 'apply_patch' ? 'patch' : 'edit';
  return [{ path, kind }];
};

export const subscribeAgentFileChangeHints = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const listAgentFileChangeHints = (workspaceId: string): AgentFileChangeHint[] => {
  const cached = snapshotCache.get(workspaceId);
  if (cached?.revision === snapshotRevision) return cached.value;
  const items: AgentFileChangeHint[] = [];
  for (const hint of hints.values()) {
    if (hint.workspaceId === workspaceId) items.push(hint);
  }
  const value = items.sort((left, right) => right.at - left.at || left.resourceId.localeCompare(right.resourceId));
  snapshotCache.set(workspaceId, { revision: snapshotRevision, value });
  return value;
};

export const peekAgentFileChangeHint = (identity: DocumentIdentity): AgentFileChangeHint | undefined => (
  hints.get(hintKey(identity.workspaceId, identity.resourceId))
);

const recordAgentFileChangeHint = (hint: AgentFileChangeHint): AgentFileChangeHint | undefined => {
  if (hint.runtimeKey !== getRuntimeKey()) return undefined;
  const existing = hints.get(hintKey(hint.workspaceId, hint.resourceId));
  if (
    existing
    && existing.runtimeKey === hint.runtimeKey
    && existing.threadKey === hint.threadKey
    && existing.toolCallId === hint.toolCallId
  ) {
    return existing;
  }
  hints.set(hintKey(hint.workspaceId, hint.resourceId), hint);
  if (hint.fromResourceId) hints.delete(hintKey(hint.workspaceId, hint.fromResourceId));
  emit();
  return hint;
};

export const recordHintsFromToolCall = (input: {
  runtimeKey: string;
  threadKey: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  workspaceId: string;
  workspaceRoot: string;
  entryId?: string;
  at?: number;
}): AgentFileChangeHint[] => {
  const recorded: AgentFileChangeHint[] = [];
  for (const change of extractToolFileChanges(input.toolName, input.args)) {
    const resourceId = resourceIdForHint(input.workspaceRoot, change.path);
    if (!resourceId) continue;
    const fromResourceId = change.fromPath
      ? resourceIdForHint(input.workspaceRoot, change.fromPath)
      : undefined;
    const hint: AgentFileChangeHint = {
      runtimeKey: input.runtimeKey,
      threadKey: input.threadKey,
      toolCallId: input.toolCallId,
      workspaceId: input.workspaceId,
      resourceId,
      kind: change.kind,
      at: input.at ?? Date.now(),
    };
    if (fromResourceId) hint.fromResourceId = fromResourceId;
    if (input.entryId) hint.entryId = input.entryId;
    const stored = recordAgentFileChangeHint(hint);
    if (stored) recorded.push(stored);
  }
  return recorded;
};

export const resetAgentFileChangeHints = (): void => {
  if (hints.size === 0) return;
  hints.clear();
  emit();
};
