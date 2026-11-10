/** Adapter input is derived from an admitted, immutable file, never from an untrusted path. */
import path from 'node:path';
import { projectContentReferenceText, ExternalAgentError, type ExternalAgentCapabilities, type ExternalConversation, type ExternalInput } from '@varin/application-client';
import { parseAttachmentSelections, type Attachment, type AttachmentSelection } from '@varin/protocol';
import type { HarnessInput } from './adapter.js';
import type { KernelObjectSlice } from '../kernel/protocol.generated.js';
import type { FileContentReadOptions } from '../kernel/file-content-transfer.js';

export type AttachmentConversation = Pick<ExternalConversation, 'id' | 'parent'>;
export interface ExternalCapturedFile {
  filename: string; mimeType: string; byteLength: number; contentHash: string;
  chunks: AsyncIterable<Uint8Array>;
  readPage(offset: number, length: number, view?: FileContentReadOptions): Promise<KernelObjectSlice>;
  release(committed?: boolean): Promise<void>;
}
export type ExternalPathCapture = (conversation: AttachmentConversation, key: string, path: string, signal?: AbortSignal) => Promise<ExternalCapturedFile>;
export interface ExternalAttachmentOwner {
  bindExternalPathCapture?(capture: ExternalPathCapture): void;
  prepareExternal(conversation: AttachmentConversation, key: string, selections: readonly AttachmentSelection[], signal?: AbortSignal): Promise<Attachment[]>;
  externalPath(conversation: AttachmentConversation, ref: string, signal?: AbortSignal): Promise<{ path: string; kernelEpoch: string }>;
  readExternal(conversation: AttachmentConversation, ref: string, signal?: AbortSignal): Promise<{ attachment: Attachment; stream: AsyncIterable<Uint8Array> }>;
  uploadExternal(conversation: AttachmentConversation, metadata: { key: string; filename: string; mimeType: string; byteLength: number }, chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<Attachment>;
  releaseExternal(conversation: AttachmentConversation): Promise<void>;
}
export interface AcceptedExternalInput extends Omit<ExternalInput, 'attachments'> {
  attachments?: Attachment[];
  /** Runtime-composed preceding informs do not move the original stored user ranges. */
  _quoteTextOffset?: number;
  _quoteTextLength?: number;
  /** Original selectors are only for comparing a retry of the same public input. */
  _attachmentSelections?: AttachmentSelection[];
}

export function parseExternalAttachmentSelections(value: unknown): AttachmentSelection[] | undefined {
  try { return parseAttachmentSelections(value); }
  catch (error) { throw new ExternalAgentError('invalid_attachments', error instanceof Error ? error.message : 'Invalid attachments'); }
}

export function fileInputText(input: HarnessInput): string {
  if (!input.files?.length) return input.text;
  const files = input.files.map(({ attachment, path }) => ({ ...attachment, path }));
  const notice = input.files.some(file => file.attachment.mimeType.startsWith('image/'))
    ? '\nImages listed as files were not supplied as direct visual input.' : '';
  return `${input.text}${input.text ? '\n\n' : ''}Attached files (fixed read-only delivery versions; choose a separate output path to edit):\n${JSON.stringify(files)}${notice}`;
}

/** Capability conversion happens after connection negotiation and before durable dispatch intent. */
export async function prepareHarnessInput(
  input: AcceptedExternalInput,
  conversation: AttachmentConversation,
  capabilities: ExternalAgentCapabilities,
  owner?: ExternalAttachmentOwner,
  signal?: AbortSignal,
): Promise<HarnessInput> {
  const { attachments = [], _attachmentSelections: _selections, attachmentImageReferences, contentReferences: _contentReferences, contentReferenceOccurrences: _contentReferenceOccurrences, _quoteTextOffset = 0, _quoteTextLength, ...original } = input;
  const end = _quoteTextLength === undefined ? original.text.length : _quoteTextOffset + _quoteTextLength;
  const projected = projectContentReferenceText(original.text.slice(_quoteTextOffset, end), input);
  const plain = { ...original, text: original.text.slice(0, _quoteTextOffset) + projected + original.text.slice(end) };
  if (!attachments.length && !input.images?.some(image => image.reference !== undefined)) return plain;
  if (attachments.length && !owner) throw new ExternalAgentError('attachments_unavailable', 'The original attachment owner is unavailable');
  const boundImages = { ...attachmentImageReferences };
  for (const quote of input.contentReferences ?? []) if (quote.attachmentRef && quote.imageReference !== undefined) {
    const existing = boundImages[quote.attachmentRef];
    if (existing !== undefined && existing !== quote.imageReference) {
      if (input.images?.some(image => image.reference === quote.imageReference)) continue;
      throw new ExternalAgentError('invalid_input', 'Quoted image disagrees with the original file binding');
    }
    boundImages[quote.attachmentRef] = quote.imageReference;
  }
  const images = [...(input.images ?? [])];
  const files: NonNullable<HarnessInput['files']> = [];
  const imageLabels: string[] = [];
  for (const attachment of attachments) {
    signal?.throwIfAborted();
    // These are the image formats accepted by the existing native adapter protocols. Other
    // formats remain original files; lack of a model parser never prevents file delivery.
    if (capabilities.images && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mimeType)) {
      const reference = boundImages[attachment.ref];
      if (reference !== undefined && images.some(image => image.reference === reference)) continue;
      const original = await owner!.readExternal(conversation, attachment.ref, signal);
      if (original.attachment.ref !== attachment.ref || original.attachment.byteLength !== attachment.byteLength || original.attachment.mimeType !== attachment.mimeType)
        throw new ExternalAgentError('attachment_changed', `The retained descriptor for ${attachment.filename} changed`);
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of original.stream) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); length += chunk.byteLength; }
      if (length !== attachment.byteLength) throw new ExternalAgentError('attachment_incomplete', `The original image ${attachment.filename} is incomplete`);
      images.push({ data: Buffer.concat(chunks).toString('base64'), mimeType: attachment.mimeType, ...(reference === undefined ? {} : { reference }) });
    } else {
      if (!capabilities.files) throw new ExternalAgentError('attachment_unsupported', `This Agent cannot receive ${attachment.filename}: neither a supported native block nor an execution-host file path is available`);
      const prepared = await owner!.externalPath(conversation, attachment.ref, signal);
      if (!path.isAbsolute(prepared.path) || !prepared.kernelEpoch) throw new ExternalAgentError('attachment_path_unavailable', `No current execution-host path is available for ${attachment.filename}`);
      files.push({ attachment, path: prepared.path });
      const reference = boundImages[attachment.ref];
      if (reference !== undefined) imageLabels.push(`[Image ${reference}] / [图片${reference}]: ${JSON.stringify(attachment.filename)}`);
    }
  }
  const orderedReferences = (input.contentReferenceOccurrences ?? []).slice().sort((a, b) => a.start - b.start)
    .map(occurrence => occurrence.kind === 'image' ? occurrence.reference : input.contentReferences?.find(reference => reference.ref === occurrence.ref)?.imageReference);
  const order = [...new Set([...orderedReferences, ...(input.contentReferences ?? []).map(reference => reference.imageReference)].filter((reference): reference is number => reference !== undefined))];
  if (order.length) images.sort((a, b) => {
    const left = a.reference === undefined ? -1 : order.indexOf(a.reference), right = b.reference === undefined ? -1 : order.indexOf(b.reference);
    return (left < 0 ? order.length : left) - (right < 0 ? order.length : right);
  });
  images.forEach((image, index) => { if (image.reference !== undefined) imageLabels.push(`Attached image ${index + 1}: [Image ${image.reference}] / [图片${image.reference}]`); });
  return { ...plain, ...(imageLabels.length ? { text: [plain.text, imageLabels.join('\n')].filter(Boolean).join('\n\n') } : {}), ...(images.length ? { images: images.map(({ data, mimeType }) => ({ data, mimeType })) } : {}), ...(files.length ? { files } : {}) };
}
