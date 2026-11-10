import { removeDraftMarker } from '@/lib/agent-editor/contentReferences';
import { getRuntimeEndpointGeneration } from '@varin/application-client';
import type { Attachment, AttachmentSelection } from '@varin/protocol';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { useThreadDraftStore, type DraftSelectedAttachment } from '@/stores/useThreadDraftStore';
import type { ComposerReference } from '../editor/references';

/** Metadata only. Selecting a path never reads bytes or pretends it is already a fixed attachment. */
export function selectComposerFile(draftKey: string, reference: ComposerReference): void {
  const target = reference.target;
  if (target.kind !== 'file' && target.kind !== 'attachment') return;
  const selected: DraftSelectedAttachment = { id: reference.id, host: reference.host,
    filename: target.kind === 'attachment' ? target.attachment.filename : target.path.split(/[\\/]/).at(-1) ?? target.path,
    selection: target.kind === 'attachment' ? { ref: target.attachment.ref } : { path: target.path },
    ...(target.kind === 'attachment' ? { attachment: target.attachment } : { sourceKey: target.sourceKey }) };
  useThreadDraftStore.getState().patch(draftKey, draft => ({ selectedAttachments: [...(draft.selectedAttachments ?? []).filter(item =>
    !(item.host === selected.host && item.sourceKey === selected.sourceKey && JSON.stringify(item.selection) === JSON.stringify(selected.selection))), selected] }));
}
export function removeComposerFile(draftKey: string, id: string): void {
  const draft = useThreadDraftStore.getState().drafts[draftKey];
  const selected = draft?.selectedAttachments?.find(file => file.id === id);
  const marker = draft?.markerObjects?.find(object => object.payload.kind === 'attachment-image' && object.payload.attachment.ref === selected?.selection.ref);
  if (marker) { removeDraftMarker(draftKey, marker.id); return; }
  useThreadDraftStore.getState().patch(draftKey, draft => {
    const selected = draft.selectedAttachments?.find(item => item.id === id);
    return { selectedAttachments: draft.selectedAttachments?.filter(item => item.id !== id), references: draft.references?.filter(item => !selected || !(
      item.host === selected.host && item.target.kind === 'file' && 'path' in selected.selection && item.target.path === selected.selection.path && item.target.sourceKey === selected.sourceKey
      || item.host === selected.host && item.target.kind === 'attachment' && 'ref' in selected.selection && item.target.attachment.ref === selected.selection.ref)) };
  });
}
export function composerFileSelections(selected: readonly DraftSelectedAttachment[] = [], sourceKey: string): AttachmentSelection[] {
  for (const file of selected) {
    if (file.host !== getRuntimeEndpointGeneration()) throw new Error('The selected attachment belongs to a different Host. Select it again.');
    if ('path' in file.selection && file.sourceKey !== sourceKey) throw new Error('The selected file belongs to an earlier source. Remove it or select it again.');
  }
  return [...new Map(selected.map(file => [JSON.stringify(file.selection), file.selection])).values()];
}
/** Walk declared public holders only, never infer an attachment from opaque model/tool JSON. */
export function composerHistoryAttachments(items: ReadonlyArray<{ source: string; content: unknown }>): Attachment[] {
  const files = new Map<string, Attachment>();
  for (const item of items) for (const part of historyParts(item.content, item.source)) {
    if (part.kind === 'attachment') files.set(part.attachment.ref, part.attachment);
    if (part.kind === 'output') for (const output of part.output.parts) if (output.kind === 'attachment') files.set(output.attachment.ref, output.attachment);
  }
  return [...files.values()].reverse();
}
