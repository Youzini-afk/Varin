import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import type { EditorContextAttachment } from './types';
import type { ThreadIdentity, ContentReference } from '@varin/application-client';
import { threadComposerKey } from '@/stores/useThreadStore';
import { formatMessage, useI18nStore } from '@/lib/i18n';

const listeners = new Set<() => void>();
let attachments: EditorContextAttachment[] = [];
let revision = 0;
const ordinals = new Map<string, number>();
export function addContentReference(identity: ThreadIdentity, reference: ContentReference) {
  const runtimeKey = getRuntimeKey(), threadKey = threadComposerKey(runtimeKey, identity);
  const ordinal = (ordinals.get(threadKey) ?? 0) + 1; ordinals.set(threadKey, ordinal);
  return addEditorContextAttachment({ id: crypto.randomUUID(), runtimeKey, threadKey, workspaceId: '', resourceId: reference.ref,
    label: formatMessage(useI18nStore.getState().dictionary, 'ui.content.reference', { number: ordinal }), documentInstanceId: null, documentRevision: null, localEditRevision: 0,
    source: 'saved', kind: 'reference', reference, ordinal, ...(reference.text === undefined ? {} : { text: reference.text }) });
}

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
  if (attachment.ordinal) ordinals.set(attachment.threadKey, Math.max(ordinals.get(attachment.threadKey) ?? 0, attachment.ordinal));
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
  for (const item of restored) if (item.ordinal) ordinals.set(item.threadKey, Math.max(ordinals.get(item.threadKey) ?? 0, item.ordinal));
  emit();
};

export const resetEditorContextAttachments = (): void => {
  ordinals.clear();
  if (attachments.length === 0) return;
  attachments = [];
  emit();
};

/** A receipt acknowledges only captured revisions; later edits remain attached. */
export const acknowledgeEditorContextAttachments = (captured: readonly EditorContextAttachment[], draftKey?: string): void => {
  const received = new Set(captured);
  const remaining = attachments.filter(item => !received.has(item));
  const keys = new Set(captured.filter(item => item.reference).map(item => item.threadKey));
  if (draftKey) keys.add(draftKey);
  for (const key of keys) if (!remaining.some(next => next.threadKey === key && next.reference)) ordinals.delete(key);
  if (remaining.length === attachments.length) return;
  attachments = remaining; emit();
};
