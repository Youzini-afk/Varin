import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContentReference, ThreadsAPI } from '@varin/application-client';
import type { Attachment, Operation, StoredMedia } from '@varin/protocol';
import { addChatObjectReference, captureAttachmentReference, captureMediaReference, captureToolReference } from './chatQuoteObjects';
import type { ChatToolCall, ChatToolExecutionState } from './types';

const effects = vi.hoisted(() => ({ host: 'original', add: vi.fn(), begin: vi.fn(), dispose: vi.fn(), readMedia: vi.fn() }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeKey: () => effects.host, readThreadMedia: effects.readMedia }));
vi.mock('@/lib/agent-editor/attachments', () => ({ addContentReference: (identity: unknown, reference: ContentReference) => effects.add(identity, reference),
  beginContentReferenceInsertion: (identity: unknown) => { effects.begin(identity); return { add: (reference: ContentReference) => effects.add(identity, reference), dispose: effects.dispose }; } }));
vi.mock('@/components/chat/composer/imageAttachments', () => ({ fileToImageAttachment: async (file: File) => ({ mimeType: file.type, data: btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer()))) }) }));
const identity = { runtime: 'agent' as const, threadId: 'original-thread', branchId: 'original-branch' };
const image: Attachment = { ref: 'attachment:original', filename: 'original.png', mimeType: 'image/png', byteLength: 3 };
const media: StoredMedia = { media_type: 'image/png', content_ref: { content_object: 'original-content' }, source: { kind: 'operation', operation_id: 'original-op' } };
const call: ChatToolCall = { type: 'toolCall', id: 'actual-call', name: 'capture', arguments: { unmodified_argument: 'exact' } };
const reader = () => ({ attachments: { read: vi.fn(async () => new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' })), upload: vi.fn() } as unknown as ThreadsAPI['attachments'], mediaRead: vi.fn() });
beforeEach(() => { vi.clearAllMocks(); effects.host = 'original'; effects.readMedia.mockResolvedValue(Uint8Array.of(1, 2, 3)); });
afterEach(() => vi.unstubAllGlobals());
it('quotes an existing attachment image once as actual image bytes while retaining its original file owner', async () => {
  const api = reader(), snapshot = captureAttachmentReference(identity, image, 'source-message');
  await addChatObjectReference(identity, snapshot, api);
  expect(effects.begin).toHaveBeenCalledWith(identity);
  expect(api.attachments.read).toHaveBeenCalledWith(identity, { ref: image.ref });
  expect(effects.add).toHaveBeenCalledTimes(1);
  expect(effects.add).toHaveBeenCalledWith(identity, expect.objectContaining({ image: { mimeType: 'image/png', data: 'AQID' }, attachment: { ref: image.ref }, source: expect.objectContaining({ itemId: 'source-message' }) }));
});
it('preserves a plain file resource without expanding its contents', async () => {
  const api = reader(), file = { ...image, filename: 'large.pdf', mimeType: 'application/pdf' };
  const snapshot = captureAttachmentReference(identity, file);
  await addChatObjectReference(identity, snapshot, api);
  expect(api.attachments.read).not.toHaveBeenCalled(); expect(api.attachments.upload).not.toHaveBeenCalled();
  expect(effects.add).toHaveBeenCalledWith(identity, snapshot); expect(snapshot.text).toBeUndefined();
});
it('freezes the actual running tool and retains only declared resources, never media-looking result JSON', async () => {
  const operation = { id: 'actual-op', call_completion: { kind: 'result', content: { parts: [{ kind: 'attachment', attachment: image }], data: null } } } as unknown as Operation;
  const execution: ChatToolExecutionState = { toolCallId: call.id, name: call.name, args: call.arguments, status: 'running', partialResult: { incomplete: true, missing: ['tail'], next: 'continue', auth_token: 'meaningful-result-field' } };
  const snapshot = captureToolReference(identity, call, execution);
  execution.partialResult = { overwritten: true }; execution.status = 'success';
  expect(snapshot.text).toContain('meaningful-result-field'); expect(snapshot.text).toContain('"missing"'); expect(snapshot.text).not.toContain('overwritten');
  expect(snapshot.source).toMatchObject({ kind: 'tool', toolCallId: call.id, status: 'running' });
  const typed = captureToolReference(identity, call, undefined, { role: 'toolResult', toolCallId: call.id, toolName: call.name, timestamp: 0, isError: false,
    content: [{ type: 'text', text: 'Actual output' }], details: { pretend: { kind: 'media', media: JSON.parse(JSON.stringify(media)) } }, operation });
  const api = reader(); await addChatObjectReference(identity, typed, api);
  expect(effects.readMedia).not.toHaveBeenCalled(); expect(api.attachments.read).toHaveBeenCalledWith(identity, { ref: image.ref });
  expect(effects.add).toHaveBeenCalledTimes(2);
  expect(effects.add.mock.calls.map(args => args[1].text)).toEqual([expect.stringContaining('Actual output'), undefined]);
});
it('follows the actual live gateway target rather than a stale accepted transport receipt', () => {
  const gatewayCall: ChatToolCall = { type: 'toolCall', id: 'gateway', name: 'tool_invoke', arguments: { name: 'shell', arguments: { command: 'build' } } };
  const operation = { id: 'child-operation', phase: 'terminal', outcome: 'succeeded', revision: 3, intent: { call: { name: 'shell', arguments: { command: 'build' } } },
    call_completion: { kind: 'result', outcome: 'succeeded', content: { parts: [{ kind: 'text', text: 'Actual completed build' }], data: { exitCode: 0 } } } } as unknown as Operation;
  const snapshot = captureToolReference(identity, gatewayCall, undefined, { role: 'toolResult', toolCallId: 'gateway', toolName: 'tool_invoke', timestamp: 0, isError: false,
    status: 'background', content: [{ type: 'text', text: 'Stale receipt' }], details: { name: 'shell', operationId: operation.id, completion: { kind: 'job_accepted' } } }, false, 'original-item',
    { child: { toolCallId: 'child', operationId: operation.id, name: 'shell', args: {}, status: 'success', operation } });
  expect(snapshot.text).toContain('Actual completed build'); expect(snapshot.text).not.toContain('Stale receipt');
  expect(snapshot.source).toMatchObject({ toolCallId: 'gateway', operationId: 'child-operation', status: 'success' });
});
it('quotes a standalone typed media part using its exact holder and no empty extra quote object', async () => {
  const holder = { kind: 'history' as const, itemId: 'source-item' }, api = reader();
  await addChatObjectReference(identity, captureMediaReference(identity, holder, media, 4), api);
  expect(effects.readMedia).toHaveBeenCalledWith({ mediaRead: api.mediaRead }, { ...identity, holder, partIndex: 4 }, media);
  expect(effects.add).toHaveBeenCalledTimes(1);
  expect(effects.add.mock.calls[0]![1]).toMatchObject({ image: { data: 'AQID' }, source: { itemId: 'source-item' } });
});
it('captures the insertion anchor before an asynchronous read and rejects late bytes after Host changes', async () => {
  const api = reader();
  let complete!: (blob: Blob) => void;
  vi.mocked(api.attachments.read).mockImplementation(() => new Promise(resolve => { expect(effects.begin).toHaveBeenCalledTimes(1); complete = resolve; }));
  const promise = addChatObjectReference(identity, captureAttachmentReference(identity, image), api);
  effects.host = 'replacement'; complete(new Blob(['late']));
  await expect(promise).rejects.toMatchObject({ name: 'AbortError' }); expect(effects.add).not.toHaveBeenCalled(); expect(effects.dispose).toHaveBeenCalledTimes(1);
});
