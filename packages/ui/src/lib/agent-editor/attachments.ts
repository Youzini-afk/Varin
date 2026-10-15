import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import type { EditorContextAttachment } from './types';

const listeners = new Set<() => void>();
let attachments: EditorContextAttachment[] = [];
let revision = 0;

const emit = (): void => {
  revision += 1;
  for (const listener of listeners) listener();
};

export const getEditorContextAttachmentsRevision = (): number => revision;

export const subscribeEditorContextAttachments = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const listEditorContextAttachments = (
  runtimeKey: string,
  threadKey: string,
  workspaceId?: string,
): EditorContextAttachment[] => (
  attachments.filter((item) => (
    item.runtimeKey === runtimeKey
    && item.threadKey === threadKey
    && (!workspaceId || item.workspaceId === workspaceId)
  ))
);

export const addEditorContextAttachment = (
  attachment: EditorContextAttachment,
): EditorContextAttachment | { status: 'wrong-runtime' } => {
  if (attachment.runtimeKey !== getRuntimeKey()) return { status: 'wrong-runtime' };
  const logicalIndex = attachments.findIndex((item) => (
    item.runtimeKey === attachment.runtimeKey
    && item.threadKey === attachment.threadKey
    && item.kind === attachment.kind
    && item.resourceId === attachment.resourceId
    && item.documentInstanceId === attachment.documentInstanceId
    && item.source === attachment.source
    && item.range?.startLine === attachment.range?.startLine
    && item.range?.startColumn === attachment.range?.startColumn
    && item.range?.endLine === attachment.range?.endLine
    && item.range?.endColumn === attachment.range?.endColumn
    && item.diagnosticMessage === attachment.diagnosticMessage
    && item.patch === attachment.patch
  ));
  const previous = logicalIndex >= 0 ? attachments[logicalIndex] : undefined;
  if (
    previous
    && previous.documentRevision === attachment.documentRevision
    && previous.localEditRevision === attachment.localEditRevision
    && previous.text === attachment.text
  ) return previous;
  if (previous) {
    const updated = { ...attachment, id: previous.id };
    attachments = attachments.map((item, index) => index === logicalIndex ? updated : item);
    emit();
    return updated;
  }
  attachments = [...attachments, attachment];
  emit();
  return attachment;
};

export const removeEditorContextAttachment = (id: string, runtimeKey: string, threadKey: string): void => {
  const next = attachments.filter((item) => (
    item.id !== id || item.runtimeKey !== runtimeKey || item.threadKey !== threadKey
  ));
  if (next.length === attachments.length) return;
  attachments = next;
  emit();
};

export const consumeEditorContextAttachments = (
  runtimeKey: string,
  threadKey: string,
  workspaceId?: string,
): EditorContextAttachment[] => {
  const taken = listEditorContextAttachments(runtimeKey, threadKey, workspaceId);
  if (taken.length === 0) return [];
  const takenIds = new Set(taken.map((item) => item.id));
  attachments = attachments.filter((item) => !takenIds.has(item.id));
  emit();
  return taken;
};

export const restoreEditorContextAttachments = (items: readonly EditorContextAttachment[]): void => {
  if (items.length === 0) return;
  const runtimeKey = getRuntimeKey();
  const restored = items.filter((item) => item.runtimeKey === runtimeKey);
  if (restored.length === 0) return;
  const seen = new Set(attachments.map((item) => item.id));
  attachments = [...attachments, ...restored.filter((item) => !seen.has(item.id))];
  emit();
};

export const resetEditorContextAttachments = (): void => {
  if (attachments.length === 0) return;
  attachments = [];
  emit();
};

/** A receipt acknowledges only captured revisions; later edits remain attached. */
export const acknowledgeEditorContextAttachments = (captured: readonly EditorContextAttachment[]): void => {
  const received = new Set(captured);
  const remaining = attachments.filter(item => !received.has(item));
  if (remaining.length === attachments.length) return;
  attachments = remaining; emit();
};
