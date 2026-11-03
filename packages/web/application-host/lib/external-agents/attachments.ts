/** Adapter input is derived from an admitted, immutable file, never from an untrusted path. */
import path from 'node:path';
import { ExternalAgentError, type ExternalAgentCapabilities, type ExternalConversation, type ExternalInput } from '@varin/application-client';
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
  const { attachments = [], _attachmentSelections: _selections, ...plain } = input;
  if (!attachments.length) return plain;
  if (!owner) throw new ExternalAgentError('attachments_unavailable', 'The original attachment owner is unavailable');
  const images = [...(input.images ?? [])];
  const files: NonNullable<HarnessInput['files']> = [];
  for (const attachment of attachments) {
    signal?.throwIfAborted();
    // These are the image formats accepted by the existing native adapter protocols. Other
    // formats remain original files; lack of a model parser never prevents file delivery.
    if (capabilities.images && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mimeType)) {
      const original = await owner.readExternal(conversation, attachment.ref, signal);
      if (original.attachment.ref !== attachment.ref || original.attachment.byteLength !== attachment.byteLength || original.attachment.mimeType !== attachment.mimeType)
        throw new ExternalAgentError('attachment_changed', `The retained descriptor for ${attachment.filename} changed`);
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of original.stream) { signal?.throwIfAborted(); chunks.push(Buffer.from(chunk)); length += chunk.byteLength; }
      if (length !== attachment.byteLength) throw new ExternalAgentError('attachment_incomplete', `The original image ${attachment.filename} is incomplete`);
      images.push({ data: Buffer.concat(chunks).toString('base64'), mimeType: attachment.mimeType });
    } else {
      if (!capabilities.files) throw new ExternalAgentError('attachment_unsupported', `This Agent cannot receive ${attachment.filename}: neither a supported native block nor an execution-host file path is available`);
      const prepared = await owner.externalPath(conversation, attachment.ref, signal);
      if (!path.isAbsolute(prepared.path) || !prepared.kernelEpoch) throw new ExternalAgentError('attachment_path_unavailable', `No current execution-host path is available for ${attachment.filename}`);
      files.push({ attachment, path: prepared.path });
    }
  }
  return { ...plain, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) };
}
