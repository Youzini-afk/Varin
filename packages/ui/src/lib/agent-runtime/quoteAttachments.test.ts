import { freezeDraftContentReferences, restoreDraftReferences } from '@/lib/agent-editor/contentReferences';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContentReference, ThreadIdentity } from '@varin/application-client';
import { prepareQuotedFiles } from './quoteAttachments';
const endpoint = vi.hoisted(() => ({ generation: 1 }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => endpoint.generation }));
const source: ThreadIdentity = { runtime: 'agent', threadId: 'original', branchId: 'fixed-branch' };
const target: ThreadIdentity = { runtime: 'agent', threadId: 'recipient', branchId: 'recipient-branch' };
const reference: ContentReference = { ref: 'quote:file', title: 'source.png', imageReference: 7, attachment: { ref: 'attachment:original' },
  source: { kind: 'chat', thread: source, passages: [] } };
afterEach(() => { endpoint.generation = 1; });
it('hands a copied file from its verified original owner to another Thread exactly once', async () => {
  const blob = new Blob(['original bytes'], { type: 'image/png' });
  const read = vi.fn(async () => blob), upload = vi.fn(async () => ({ ref: 'attachment:recipient', filename: 'source.png', mimeType: 'image/png', byteLength: blob.size }));
  const input = { contentReferences: [reference, { ...reference, ref: 'quote:again' }], contentReferenceOccurrences: [], attachments: [{ ref: 'attachment:original' }], attachmentImageReferences: { 'attachment:original': 7 } };
  const prepared = await prepareQuotedFiles(input, target, upload, { attachments: { read, upload: vi.fn() } });
  expect(read).toHaveBeenCalledExactlyOnceWith(source, { ref: 'attachment:original' });
  expect(upload).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ data: blob, filename: 'source.png', mimeType: 'image/png' }));
  expect(prepared.attachments).toEqual([{ ref: 'attachment:recipient' }]);
  expect(prepared.attachmentImageReferences).toEqual({ 'attachment:recipient': 7 });
  expect(prepared.contentReferences?.map(value => value.attachment)).toEqual([{ ref: 'attachment:recipient' }, { ref: 'attachment:recipient' }]);
  expect(input.contentReferences[0]!.attachment).toEqual({ ref: 'attachment:original' });
  expect(prepared.contentReferences?.[0]?.source).toEqual(reference.source);
});
it('reuses same-Thread ownership without copying and transfers external files using the target uploader', async () => {
  const read = vi.fn(async () => new Blob(['fixed'], { type: 'image/png' })), upload = vi.fn(async () => ({ ref: 'attachment:external', filename: 'source.png', mimeType: 'image/png', byteLength: 5 }));
  const reader = { attachments: { read, upload: vi.fn() } };
  expect(await prepareQuotedFiles({ contentReferences: [reference] }, source, upload, reader)).toEqual({ contentReferences: [reference] });
  expect(read).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
  const external = await prepareQuotedFiles({ contentReferences: [reference] }, undefined, upload, reader);
  expect(external.contentReferences?.[0]?.attachment).toEqual({ ref: 'attachment:external' });
});
it('does not transfer a late read after a Host change or replace unavailable originals', async () => {
  const upload = vi.fn();
  const read = vi.fn(async () => { endpoint.generation++; return new Blob(['original']); });
  await expect(prepareQuotedFiles({ contentReferences: [reference] }, target, upload, { attachments: { read, upload: vi.fn() } })).rejects.toThrow('Host changed');
  expect(upload).not.toHaveBeenCalled();
  read.mockRejectedValueOnce(new Error('Original file unavailable'));
  await expect(prepareQuotedFiles({ contentReferences: [reference] }, target, upload, { attachments: { read, upload: vi.fn() } })).rejects.toThrow('Original file unavailable');
  expect(upload).not.toHaveBeenCalled();
});

it('restored files are read from their accepted holder without changing original-source navigation', async () => {
  const restored = restoreDraftReferences({ identity: target, editorText: '[Image 7]', editorContentReferences: [{ ...reference, attachmentRef: 'attachment:accepted-copy' }],
    editorAttachments: [{ ref: 'attachment:accepted-copy', filename: 'source.png', mimeType: 'image/png', byteLength: 5 }], editorAttachmentImageReferences: { 'attachment:accepted-copy': 7 } });
  const frozen = freezeDraftContentReferences({ text: restored.text!, references: restored.references, markerObjects: restored.markerObjects });
  expect(frozen.contentReferences?.[0]?.source).toEqual(reference.source);
  const read = vi.fn(async () => new Blob(['fixed'], { type: 'image/png' })), upload = vi.fn(async () => ({ ref: 'attachment:third', filename: 'source.png', mimeType: 'image/png', byteLength: 5 }));
  await prepareQuotedFiles(frozen, { ...target, threadId: 'third' }, upload, { attachments: { read, upload: vi.fn() } }, restored.markerObjects);
  expect(read).toHaveBeenCalledExactlyOnceWith(target, { ref: 'attachment:accepted-copy' });
});
