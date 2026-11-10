import { ChangeSet } from '@codemirror/state';
import { findMarkerComposer } from '@/components/chat/composer/editor/markerComposerRegistry';
import { ComposerClosedError } from '@/components/chat/composer/editor/interactionRanges';
import { threadHostKey as getRuntimeKey } from '@/stores/useThreadStore';
import type { EditorContextAttachment } from './types';
import type { ThreadIdentity, ContentReference } from '@varin/application-client';
import { threadComposerKey } from '@/stores/useThreadStore';
import { insertDraftMarker, insertDraftMarkerAt, referenceMarkerObject, removeDraftMarker } from './contentReferences';
import { useThreadDraftStore } from '@/stores/useThreadDraftStore';
import { releaseUiSelection } from '@/lib/interactive-ui/selection-lifetime';

const listeners = new Set<() => void>();
let attachments: EditorContextAttachment[] = [];
let revision = 0;
const ordinals = new Map<string, number>();
export function addContentReference(identity: ThreadIdentity, reference: ContentReference) {
  const runtimeKey = getRuntimeKey(), threadKey = threadComposerKey(runtimeKey, identity);
  const object = referenceMarkerObject(reference);
  void insertDraftMarker(threadKey, object).catch(error => {
    useThreadDraftStore.getState().patch(threadKey, { sendError: error instanceof Error ? error.message : String(error) });
  });
  // Keep the old action receipt shape while all capture entry points share the draft owner.
  return { id: object.id, runtimeKey, threadKey };

}

const emit = (): void => {
  revision += 1;
  for (const listener of listeners) listener();
};
const releaseRemoved = (removed: readonly EditorContextAttachment[]) => {
  for (const item of removed) if (item.runtimeKey === getRuntimeKey() && item.reference
    && !attachments.some(other => other.runtimeKey === item.runtimeKey && other.reference?.ref === item.reference?.ref)) releaseUiSelection(item.reference);
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
  if (runtimeKey === getRuntimeKey() && useThreadDraftStore.getState().drafts[threadKey]?.markerObjects?.some(object => object.id === id)) { removeDraftMarker(threadKey, id); return; }
  const previous = attachments;
  const next = attachments.filter((item) => (
    item.id !== id || item.runtimeKey !== runtimeKey || item.threadKey !== threadKey
  ));
  if (next.length === attachments.length) return;
  attachments = next;
  releaseRemoved(previous.filter(item => !next.includes(item)));
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
  const previous = attachments; attachments = [];
  releaseRemoved(previous);
  emit();
};

/** A receipt acknowledges only captured revisions; later edits remain attached. */
export const acknowledgeEditorContextAttachments = (captured: readonly EditorContextAttachment[], draftKey?: string): void => {
  const received = new Set(captured);
  const remaining = attachments.filter(item => !received.has(item));
  const keys = new Set(captured.filter(item => item.reference).map(item => item.threadKey));
  if (draftKey) keys.add(draftKey);
  for (const key of keys) if (!remaining.some(next => next.threadKey === key && next.reference)) ordinals.delete(key);
  const changed = remaining.length !== attachments.length;
  attachments = remaining; releaseRemoved(captured);
  if (changed) emit();
};

/** Freeze the original draft and mapped caret before asynchronous source capture. */
export function beginContentReferenceInsertion(identity: ThreadIdentity) {
  const runtimeKey = getRuntimeKey(), threadKey = threadComposerKey(runtimeKey, identity);
  useThreadDraftStore.getState().patch(threadKey, {});
  const handle = findMarkerComposer(threadKey);
  const anchor = handle?.captureMarkerInsertion();
  const initial = useThreadDraftStore.getState().drafts[threadKey];
  let cursor = initial?.editorState?.selection.main.head ?? initial?.text.length ?? 0;
  let active = true, transferred = false;
  const unsubscribe = useThreadDraftStore.subscribe((state, previous) => {
    const before = previous.drafts[threadKey]?.text ?? '', after = state.drafts[threadKey]?.text ?? '';
    if (before === after) return;
    let from = 0, to = before.length, end = after.length;
    while (from < to && from < end && before[from] === after[from]) from++;
    while (to > from && end > from && before[to - 1] === after[end - 1]) { to--; end--; }
    cursor = ChangeSet.of({ from, to, insert: after.slice(from, end) }, before.length).mapPos(cursor, 1);
  });
  const release = () => { active = false; anchor?.dispose(); unsubscribe(); };
  return {
    dispose() { if (!transferred) release(); },
    add(reference: ContentReference) {
      if (!active || runtimeKey !== getRuntimeKey()) { release(); return { status: 'wrong-runtime' as const }; }
      transferred = true;
      const object = referenceMarkerObject(reference);
      const work = anchor ? anchor.insertMarker(object) : Promise.resolve(insertDraftMarkerAt(threadKey, object, cursor));
      void work.catch(error => {
        if (error instanceof ComposerClosedError && runtimeKey === getRuntimeKey()) return insertDraftMarkerAt(threadKey, object, cursor);
        useThreadDraftStore.getState().patch(threadKey, { sendError: error instanceof Error ? error.message : String(error) });
      }).finally(release);
      return { id: object.id, runtimeKey, threadKey };
    },
  };
}
