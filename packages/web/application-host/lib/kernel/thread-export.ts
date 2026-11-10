import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { conversationContentText, type ThreadExportSelection, type ThreadIdentity } from '@varin/application-client';
import type { Attachment, HistoryItem, HistoryReference, StoredMedia } from '@varin/protocol';
import type { AgentRuntimeClient } from './agent-runtime-client.js';

type FileAttachment = Attachment;
interface ExportAttachment { filename: string; mimeType: string; byteLength?: number; media?: StoredMedia; partIndex?: number; file?: FileAttachment }
interface PublicMessage { text: string; details?: unknown; modelData?: unknown; attachments: ExportAttachment[] }
export interface ThreadExportOwners {
  runtime: Pick<AgentRuntimeClient, 'thread' | 'historyPage' | 'historyItem' | 'mediaRead' | 'exportModelReferences'>;
  attachments?: { read(identity: ThreadIdentity, ref: string, signal?: AbortSignal): Promise<{ attachment: FileAttachment; stream: AsyncIterable<Uint8Array> }> };
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const file = (value: unknown): value is FileAttachment => { const item = object(value); return typeof item.ref === 'string' && item.ref.startsWith('attachment:') && typeof item.filename === 'string' && typeof item.mimeType === 'string' && Number.isSafeInteger(item.byteLength) && Number(item.byteLength) >= 0; };
const media = (value: unknown): value is StoredMedia => typeof object(value).media_type === 'string' && typeof object(object(value).content_ref).content_object === 'string';

/** Only named public semantic boundaries are exported. Provider originals, opaque continuations,
 * resource snapshots, checkpoints and arbitrary outer history fields never enter this projection. */
export function exportPublicMessage(item: HistoryItem, includeTools: boolean, format: ThreadExportSelection['format'] = 'json'): PublicMessage | null {
  if (item.source === 'compaction' || item.source === 'tool' && !includeTools) return null;
  const result: PublicMessage = { text: '', attachments: [] };
  const addMedia = (value: unknown, partIndex: number) => { if (media(value)) result.attachments.push({ filename: `media-${partIndex + 1}.${value.media_type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin'}`, mimeType: value.media_type, media: value, partIndex }); };
  const addFile = (value: unknown) => { if (file(value)) result.attachments.push({ filename: value.filename, mimeType: value.mimeType, byteLength: value.byteLength, file: { ref: value.ref, filename: value.filename, mimeType: value.mimeType, byteLength: value.byteLength, ...(typeof value.modelRef === 'string' ? { modelRef: value.modelRef } : {}) } }); };
  const readable = (text: string) => format === 'markdown' && item.source === 'assistant' ? conversationContentText(text, { role: 'assistant' }) : text;
  const output = (value: unknown, assistantBody = false) => {
    const body = object(value);
    if (includeTools && body.data !== undefined) result.details = body.data;
    if (includeTools && body.model_data !== undefined) result.modelData = body.model_data;
    if (Array.isArray(body.parts)) body.parts.forEach((part, index) => {
      const entry = object(part);
      if (entry.kind === 'text' && typeof entry.text === 'string') result.text += `${result.text ? '\n' : ''}${assistantBody ? readable(entry.text) : entry.text}`;
      if (entry.kind === 'media') addMedia(entry.media, index);
      if (entry.kind === 'attachment') addFile(entry.attachment);
    });
  };
  if (item.source === 'user') {
    const input = object(item.content);
    result.text = typeof item.content === 'string' ? item.content : typeof input.userText === 'string' ? input.userText : typeof input.text === 'string' ? input.text : '';
    if (Array.isArray(input.attachments)) input.attachments.forEach(addMedia);
    if (Array.isArray(input.fileAttachments)) input.fileAttachments.forEach(addFile);
    return result;
  }
  const content = object(object(item.content).content);
  switch (content.kind) {
    case 'text': result.text = typeof content.text === 'string' ? readable(content.text) : ''; break;
    case 'reasoning_summary': result.text = typeof content.text === 'string' ? content.text : ''; break;
    case 'media': addMedia(content.media, 0); break;
    case 'output': output(content.output, true); break;
    case 'tool_call': if (!includeTools) return null; result.details = content.call; break;
    case 'tool_result': {
      if (!includeTools) return null;
      const completion = object(object(content.result).completion);
      const { content: body, ...facts } = completion;
      output(body); result.details = { completion: facts, data: result.details }; break;
    }
    default: return null;
  }
  return result;
}

/** Metadata pages are spooled to disk in reverse arrival order. History bodies and original media
 * are then read one at a time, chronologically, with consumer backpressure. */
export async function* exportThreadConversation(owners: ThreadExportOwners, selection: ThreadExportSelection, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  if (selection?.runtime !== 'agent' || !selection.threadId || !selection.branchId || !['json', 'markdown'].includes(selection.format)
    || selection.headId !== null && (typeof selection.headId !== 'string' || !selection.headId)
    || typeof selection.includeTools !== 'boolean' || typeof selection.includeAttachments !== 'boolean'
    || selection.firstItemId !== undefined && (typeof selection.firstItemId !== 'string' || !selection.firstItemId)
    || selection.lastItemId !== undefined && (typeof selection.lastItemId !== 'string' || !selection.lastItemId)) throw new Error('Choose an original history cut and export format');
  const thread = await owners.runtime.thread(selection.threadId, signal);
  if (thread.deleted_at_ms != null || !thread.branches.some(branch => branch.branch_id === selection.branchId)) throw new Error('The export conversation is unavailable');
  const directory = await mkdtemp(path.join(tmpdir(), 'varin-conversation-export-'));
  const spool = await open(path.join(directory, 'references'), 'w+', 0o600);
  const pages: Array<{ offset: number; bytes: number }> = [];
  let offset = 0, before: string | undefined, foundLast = !selection.lastItemId, foundFirst = !selection.firstItemId;
  try {
    if (selection.headId) do {
      signal?.throwIfAborted();
      const page = await owners.runtime.historyPage({ branchId: selection.branchId, headId: selection.headId, ...(before ? { beforeId: before } : {}), limit: 100 }, signal);
      if (page.head !== selection.headId || page.boundary_reset) throw new Error('The selected history range changed');
      const selected: HistoryReference[] = [];
      for (const reference of [...page.items].reverse()) {
        if (!foundLast) { if (reference.id !== selection.lastItemId) continue; foundLast = true; }
        selected.unshift(reference);
        if (reference.id === selection.firstItemId) { foundFirst = true; break; }
      }
      if (selected.length) { const bytes = Buffer.from(JSON.stringify(selected)); await spool.write(bytes, 0, bytes.length, offset); pages.push({ offset, bytes: bytes.length }); offset += bytes.length; }
      if (selection.firstItemId && foundFirst) break;
      if (page.previous && page.previous === before) throw new Error('The history reader did not advance');
      before = page.previous ?? undefined;
    } while (before);
    if (!foundLast || !foundFirst || !selection.headId && (selection.firstItemId || selection.lastItemId)) throw new Error('Selected messages do not belong to the pinned history range');
    const encode = (value: string) => Buffer.from(value, 'utf8');
    const metadata = { threadId: selection.threadId, branchId: selection.branchId, headId: selection.headId, firstItemId: selection.firstItemId ?? null, lastItemId: selection.lastItemId ?? selection.headId };
    yield encode(selection.format === 'json' ? `{"version":2,"selection":${JSON.stringify(metadata)},"messages":[` : `# Conversation\n\nThread: ${selection.threadId}\nBranch: ${selection.branchId}\nHistory: ${selection.headId ?? '(empty)'}\n\n`);
    let first = true;
    const exportedItemIds: string[] = [];
    for (const page of pages.reverse()) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(page.bytes); await spool.read(buffer, 0, buffer.length, page.offset);
      for (const reference of JSON.parse(buffer.toString('utf8')) as HistoryReference[]) {
        signal?.throwIfAborted();
        if (reference.source === 'compaction' || reference.source === 'tool' && !selection.includeTools) continue;
        const item = await owners.runtime.historyItem(reference, signal);
        const message = exportPublicMessage(item, selection.includeTools, selection.format); if (!message) continue;
        const record = { id: item.id, source: item.source, runId: item.run_id, text: message.text,
          ...(message.details !== undefined ? { details: message.details } : {}),
          ...(message.modelData !== undefined ? { modelData: message.modelData } : {}) };
        if (selection.format === 'json') exportedItemIds.push(item.id);
        if (selection.format === 'json') yield encode(`${first ? '' : ','}\n${JSON.stringify(record).slice(0, -1)},"attachments":[`);
        else {
          yield encode(`## ${item.source}\n\n${message.text}\n\n`);
          if (message.details !== undefined) { const detail = JSON.stringify(message.details, null, 2); const fence = '`'.repeat(Math.max(3, ...Array.from(detail.matchAll(/`+/g), match => match[0].length + 1))); yield encode(`${fence}json\n${detail}\n${fence}\n\n`); }
        }
        first = false;
        for (const [index, attachment] of message.attachments.entries()) {
          const info = { filename: attachment.filename, mimeType: attachment.mimeType, ...(attachment.byteLength !== undefined ? { byteLength: attachment.byteLength } : {}),
            ...(attachment.file ? { attachment: attachment.file } : attachment.media ? { media: attachment.media } : {}) };
          if (selection.format === 'json') yield encode(`${index ? ',' : ''}${JSON.stringify(info).slice(0, -1)}${selection.includeAttachments ? ',"dataBase64":"' : '}'}`);
          else yield encode(selection.includeAttachments ? `[${attachment.filename.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')}](data:${attachment.mimeType.replace(/[^a-z0-9.+/-]/gi, '')};base64,` : `Attachment: ${attachment.filename}\n\n`);
          if (!selection.includeAttachments) continue;
          const stream = attachment.file ? await readFile(owners, selection, attachment.file, signal) : readMedia(owners, selection, item.id, attachment, signal);
          for await (const chunk of base64(stream)) yield encode(chunk);
          yield encode(selection.format === 'json' ? '"}' : ')\n\n');
        }
        if (selection.format === 'json') yield encode(']}');
      }
    }
    if (selection.format === 'json') {
      signal?.throwIfAborted();
      // Snapshot only the public records emitted above. In particular, an assistant
      // tool_call hidden by includeTools must not expose its invocation bindings.
      const modelReferences = await owners.runtime.exportModelReferences({
        threadId: selection.threadId, branchId: selection.branchId, headId: selection.headId,
        itemIds: exportedItemIds, includeTools: selection.includeTools,
      }, signal);
      yield encode(`\n],"modelReferences":${JSON.stringify(modelReferences)}}\n`);
    }
  } finally { await spool.close(); await rm(directory, { recursive: true, force: true }); }
}
async function readFile(owners: ThreadExportOwners, identity: ThreadIdentity, file: FileAttachment, signal?: AbortSignal) {
  if (!owners.attachments) throw new Error('Original attachment export is unavailable');
  const read = await owners.attachments.read(identity, file.ref, signal);
  if (read.attachment.ref !== file.ref || read.attachment.byteLength !== file.byteLength || read.attachment.filename !== file.filename || read.attachment.mimeType !== file.mimeType) throw new Error('Original attachment identity changed');
  return read.stream;
}
async function* readMedia(owners: ThreadExportOwners, identity: ThreadIdentity, itemId: string, attachment: ExportAttachment, signal?: AbortSignal) {
  if (!attachment.media || attachment.partIndex === undefined) throw new Error('Original media identity is missing');
  let count = 1, total = 0, read = 0;
  for (let chunkIndex = 0; chunkIndex < count; chunkIndex++) {
    const chunk = await owners.runtime.mediaRead({ threadId: identity.threadId, branchId: identity.branchId, holder: { kind: 'history', itemId },
      partIndex: attachment.partIndex, chunkIndex, expectedContentRef: attachment.media.content_ref.content_object }, signal);
    if (chunk.chunkIndex !== chunkIndex || chunk.partIndex !== attachment.partIndex || chunk.media.content_ref.content_object !== attachment.media.content_ref.content_object || chunk.media.media_type !== attachment.mimeType
      || chunk.chunkCount < 1 || chunkIndex > 0 && (count !== chunk.chunkCount || total !== chunk.totalBytes)) throw new Error('Original media identity changed');
    count = chunk.chunkCount; total = chunk.totalBytes;
    const bytes = Buffer.from(chunk.bytesBase64, 'base64'); read += bytes.byteLength; yield bytes;
  }
  if (read !== total) throw new Error('Original media export is incomplete');
}
async function* base64(stream: AsyncIterable<Uint8Array>) {
  let carry = Buffer.alloc(0);
  for await (const value of stream) { const chunk = Buffer.concat([carry, value]); const end = chunk.length - chunk.length % 3;
    if (end) yield chunk.subarray(0, end).toString('base64'); carry = Buffer.from(chunk.subarray(end)); }
  if (carry.length) yield carry.toString('base64');
}
