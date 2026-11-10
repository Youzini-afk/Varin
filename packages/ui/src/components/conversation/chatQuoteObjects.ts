import React from 'react';
import { getRuntimeKey, readThreadMedia, type ContentReference, type ThreadIdentity, type ThreadsAPI } from '@varin/application-client';
import type { Attachment, OutputMediaHolder, StoredMedia } from '@varin/protocol';
import { fileToImageAttachment } from '@/components/chat/composer/imageAttachments';
import type { ChatToolCall, ChatToolExecutionState, ChatToolResultMessage } from './types';
import { invocationData, invocationGateway, invocationStatus, operationInvocation, presentInvocation, toolRecord } from './toolInvocation';
import { addContentReference, beginContentReferenceInsertion } from '@/lib/agent-editor/attachments';

const groups = new WeakMap<HTMLElement, () => ContentReference[]>();
export function useChatQuoteGroup(capture: (() => ContentReference[]) | undefined) {
  const previous = React.useRef<HTMLElement | null>(null);
  return React.useCallback((element: HTMLElement | null) => {
    if (previous.current) groups.delete(previous.current);
    previous.current = element;
    if (element && capture) groups.set(element, capture);
  }, [capture]);
}
export function captureChatQuoteGroup(element: Element) {
  const root = element.closest<HTMLElement>('[data-chat-quote-group]');
  return root && groups.get(root)?.();
}
const objects = new WeakMap<HTMLElement, () => ContentReference>();
export function useChatQuoteObject(capture: (() => ContentReference) | undefined) {
  const previous = React.useRef<HTMLElement | null>(null);
  return React.useCallback((element: HTMLElement | null) => {
    if (previous.current) objects.delete(previous.current);
    previous.current = element;
    if (element && capture) objects.set(element, capture);
  }, [capture]);
}
export function captureChatQuoteObject(element: Element) {
  const root = element.closest<HTMLElement>('[data-chat-quote-object]');
  return root && objects.get(root)?.();
}
type QuoteResource = { kind: 'attachment'; attachment: Attachment } | { kind: 'media'; media: StoredMedia; holder: OutputMediaHolder; partIndex: number }
  | { kind: 'image'; image: { mimeType: string; data: string } };
const attachmentImages = new WeakMap<ContentReference, Attachment>();
export function captureAttachmentReference(identity: ThreadIdentity, attachment: Attachment, itemId?: string): ContentReference {
  const reference: ContentReference = { ref: `attachment-selection:${crypto.randomUUID()}`, title: attachment.filename,
    attachment: { ref: attachment.ref }, source: { kind: 'chat', thread: { ...identity }, itemId, passages: [], capturedAt: new Date().toISOString() } };
  if (attachment.mimeType.startsWith('image/')) attachmentImages.set(reference, { ...attachment });
  return reference;
}
const quoteResources = new WeakMap<ContentReference, QuoteResource[]>();
const resourceOnly = new WeakSet<ContentReference>();
export function captureMediaReference(identity: ThreadIdentity, holder: OutputMediaHolder, media: StoredMedia, partIndex: number): ContentReference {
  const reference: ContentReference = { ref: `media-selection:${crypto.randomUUID()}`, title: media.media_type,
    source: { kind: 'chat', thread: { ...identity }, itemId: holder.kind === 'history' ? holder.itemId : undefined, passages: [], capturedAt: new Date().toISOString() } };
  quoteResources.set(reference, [{ kind: 'media', holder: structuredClone(holder), media: structuredClone(media), partIndex }]);
  resourceOnly.add(reference);
  return reference;
}
/** All resources are typed original output parts. JSON paths never confer access. */
export async function addChatObjectReference(identity: ThreadIdentity, reference: ContentReference, api: Pick<ThreadsAPI, 'attachments'> & Partial<Pick<ThreadsAPI, 'mediaRead'>>) {
  const host = getRuntimeKey();
  const assertCurrent = () => { if (getRuntimeKey() !== host) throw new DOMException('Host changed', 'AbortError'); };
  const resources = quoteResources.get(reference) ?? [];
  const attachmentImage = attachmentImages.get(reference);
  if (attachmentImage) {
    const insertion = beginContentReferenceInsertion(identity);
    try {
      const blob = await api.attachments.read(identity, { ref: attachmentImage.ref });
      assertCurrent();
      insertion.add({ ...reference, image: await fileToImageAttachment(new File([blob], attachmentImage.filename, { type: attachmentImage.mimeType })) });
    } finally { insertion.dispose(); }
    return;
  }
  if (!resources.length) { addContentReference(identity, reference); return; }
  const includeReference = !resourceOnly.has(reference);
  const insertions = [...(includeReference ? [reference] : []), ...resources].map(() => beginContentReferenceInsertion(identity));
  try {
    const prepared = await Promise.all(resources.map(async (resource, index): Promise<ContentReference> => {
      const base = { ref: `${reference.ref}:resource:${index}`, title: reference.title, source: reference.source };
      if (resource.kind === 'attachment') {
        const attachment = resource.attachment;
        const file = { ...base, title: attachment.filename, attachment: { ref: attachment.ref } };
        if (!attachment.mimeType.startsWith('image/')) return file;
        const blob = await api.attachments.read(identity, { ref: attachment.ref });
        return { ...file, image: await fileToImageAttachment(new File([blob], attachment.filename, { type: attachment.mimeType })) };
      }
      if (resource.kind === 'image') return { ...base, image: resource.image };
      if (!api.mediaRead) throw new Error('The original media reader is unavailable.');
      const bytes = await readThreadMedia({ mediaRead: api.mediaRead }, { ...identity, holder: resource.holder, partIndex: resource.partIndex }, resource.media);
      const blob = new Blob([bytes], { type: resource.media.media_type });
      const filename = `${reference.title}-${index + 1}.${resource.media.media_type.split('/')[1] || 'bin'}`;
      if (resource.media.media_type.startsWith('image/')) return { ...base, image: await fileToImageAttachment(new File([blob], filename, { type: blob.type })) };
      assertCurrent();
      const attachment = await api.attachments.upload(identity, { key: base.ref, filename, mimeType: blob.type, data: blob });
      return { ...base, title: filename, attachment: { ref: attachment.ref } };
    }));
    assertCurrent();
    [...(includeReference ? [reference] : []), ...prepared].forEach((item, index) => insertions[index]!.add(item));
  } finally { insertions.forEach(insertion => insertion.dispose()); }
}
const readable = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';
/** Quote the operation's input and actual result, never its folded display summary. */
export function captureToolReference(identity: ThreadIdentity, call: ChatToolCall, execution?: ChatToolExecutionState,
  result?: ChatToolResultMessage, generating = false, itemId?: string, executionById?: Record<string, ChatToolExecutionState>): ContentReference {
  const actual = presentInvocation(call);
  const gateway = invocationGateway(result?.originalDetails ?? result?.details, actual);
  const operationId = gateway?.operationId ?? execution?.operationId;
  const live = Object.values(executionById ?? {}).find(item => item.operationId === operationId);
  if (live) execution = live;
  // The visible gateway card follows the actual target operation, not its transport receipt.
  // Keep the same original call identity for navigation, but freeze the target's current output.
  const operation = execution?.operation;
  if (operation && (!gateway || operation.id === gateway.operationId)
    && !(actual.gateway && toolRecord(toolRecord(operation.intent).call).name === 'tool_invoke')) {
    result = operationInvocation(operation).result;
  }
  if (gateway && !execution) execution = { toolCallId: call.id, operationId: gateway.operationId,
    name: actual.name, args: actual.arguments, status: gateway.completion.kind === 'job_accepted' ? 'background' : invocationStatus(result) };
  const status = invocationStatus(result, execution, generating);
  const output = result?.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const data = invocationData(result?.details ?? execution?.result ?? execution?.partialResult, actual);
  const reference: ContentReference = { ref: `tool-selection:${crypto.randomUUID()}`, title: actual.name,
    text: [actual.name, `Status: ${status}`, `Input:\n${readable(actual.arguments)}`,
      output ? `Result:\n${output}` : '',
      data !== undefined && readable(data) !== output ? `Result data:\n${readable(data)}` : '',
      !output && data === undefined ? 'No result received.' : ''].filter(Boolean).join('\n\n'),
    source: { kind: 'tool', thread: { ...identity }, itemId, toolCallId: call.id, operationId: execution?.operationId ?? result?.operation?.id, name: actual.name, status, capturedAt: new Date().toISOString() } };
  const resources: QuoteResource[] = [];
  const retained = result?.operation ?? execution?.operation, completion = retained?.call_completion;
  if (retained && completion && completion.kind !== 'not_dispatched') for (const [partIndex, part] of (completion.content?.parts ?? []).entries()) {
    if (part.kind === 'attachment') resources.push({ kind: 'attachment', attachment: { ...part.attachment } });
    if (part.kind === 'media') resources.push({ kind: 'media', media: structuredClone(part.media), holder: { kind: 'operation', operationId: retained.id, output: 'completion' }, partIndex });
  }
  if (!resources.some(resource => resource.kind === 'media')) {
    if (result?.historyId && result.imageParts?.length) for (const part of result.imageParts) resources.push({ kind: 'media', media: structuredClone(part.media), holder: { kind: 'history', itemId: result.historyId }, partIndex: part.partIndex });
    else for (const part of result?.content ?? []) if (part.type === 'image') resources.push({ kind: 'image', image: { mimeType: part.mimeType, data: part.data } });
  }
  if (resources.length) quoteResources.set(reference, resources);
  return reference;
}
