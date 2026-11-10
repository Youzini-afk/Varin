import type { ComposerMarkerObject } from '@/components/chat/composer/editor/markers';
import { getRuntimeEndpointGeneration, type ContentReferenceInput, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import type { Attachment, AttachmentSelection } from '@varin/protocol';
import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';

type QuotedFiles = ContentReferenceInput & { attachments?: AttachmentSelection[]; attachmentImageReferences?: Record<string, number> };
/** A copied quote retains its original reader. Reuse the existing upload/delivery owner
 * when its recipient belongs to another Thread or external conversation; source IDs
 * alone never become a target-side read grant. Upload keys retain exact retry intent. */
export async function prepareQuotedFiles(input: QuotedFiles, target: ThreadIdentity | undefined,
  upload: (input: { key: string; filename: string; mimeType: string; data: Blob }) => Promise<Attachment>,
  reader: Pick<ThreadsAPI, 'attachments'> | undefined = getRegisteredRuntimeAPIs()?.threads, objects?: readonly ComposerMarkerObject[]): Promise<QuotedFiles> {
  const host = getRuntimeEndpointGeneration();
  const current = () => { if (host !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed while transferring quoted files'); };
  const copies = new Map<string, Attachment>();
  const references = [];
  const replacements = new Map<string, string>();
  for (const reference of input.contentReferences ?? []) {
    const selection = reference.attachment;
    const object = objects?.find(object => object.id === reference.ref);
    const source = object?.attachmentOwner ?? (object?.payload.kind === 'attachment-image' ? object.payload.identity : undefined) ?? ('thread' in reference.source ? reference.source.thread : undefined);
    if (!selection?.ref || !source || target?.runtime === source.runtime && target.threadId === source.threadId) { references.push(reference); continue; }
    if (!reader) throw new Error('The original quoted file reader is unavailable. Reopen its conversation and select the file again.');
    const key = JSON.stringify([source.runtime, source.threadId, source.branchId, selection.ref]);
    let attachment = copies.get(key);
    if (!attachment) {
      const blob = await reader.attachments.read(source, { ref: selection.ref }); current();
      attachment = await upload({ key: `quoted-file:${key}`, filename: reference.title, mimeType: blob.type || 'application/octet-stream', data: blob }); current();
      copies.set(key, attachment);
    }
    replacements.set(selection.ref, attachment.ref);
    const { attachmentRef: _previous, ...rest } = reference;
    references.push({ ...rest, attachment: { ref: attachment.ref } });
  }
  current();
  return { ...input, ...(input.contentReferences ? { contentReferences: references } : {}),
    ...(input.attachments ? { attachments: input.attachments.map(selection => selection.ref && replacements.has(selection.ref) ? { ref: replacements.get(selection.ref)! } : selection) } : {}),
    ...(input.attachmentImageReferences ? { attachmentImageReferences: Object.fromEntries(Object.entries(input.attachmentImageReferences).map(([ref, number]) => [replacements.get(ref) ?? ref, number])) } : {}) };
}
