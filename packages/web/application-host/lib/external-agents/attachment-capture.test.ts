import { describe, expect, it, vi } from 'vitest';
import type { KernelClient, KernelScopedClient } from '../kernel/kernel-client.js';
import { captureExternalFile, releaseExternalCaptures, restoreExternalCapture } from './attachment-capture.js';
import { createAbsoluteAttachmentCapture } from '../kernel/attachment-absolute.js';

const source = { workspaceId: 'original-workspace', executionWorkspaceId: 'original-execution', canonicalRoot: '/source' };
const conversation = { id: 'external:actual' };
function fixture() {
  let retained: unknown = null;
  let registeredSource = source;
  const getBlob = vi.fn(async (hash: string, proof: unknown, range: { offset: number; length: number }) => {
    const bytes = Buffer.from('fixed').subarray(range.offset, range.offset + range.length);
    return { hash, byteLength: 5, offset: range.offset, nextOffset: range.offset + bytes.length, eof: range.offset + bytes.length === 5, bytesBase64: bytes.toString('base64') };
  });
  const actor = {
    getRecord: vi.fn(async () => retained), fileRootRegister: vi.fn<KernelScopedClient['fileRootRegister']>(async value => {
      registeredSource = value;
      return { rootId: 'original-root', canonicalRoot: value.canonicalRoot, executionWorkspaceId: value.executionWorkspaceId,
        reconciledOperations: 0, pendingOperations: 0 };
    }),
    fileCapture: vi.fn(async (input: { retentionRecordId: string; path: string }) => {
      retained = { recordId: input.retentionRecordId, recordType: 'attachment.capture', state: 'retained', threadId: conversation.id, payloadJson: JSON.stringify({
        ...registeredSource, path: input.path, stateJson: JSON.stringify({ kind: 'regular-file', objectHash: 'sha256-original', byteLength: 5 }),
      }) };
      return {};
    }), getBlob, releaseRecord: vi.fn(async () => ({})),
    listRecords: vi.fn<(...args: unknown[]) => Promise<{ records: Array<{ recordId: string; state: string }>; nextCursor: number | null }>>(async () => ({ records: [{ recordId: 'attachment-capture:original', state: 'retained' }], nextCursor: null })),
  };
  let sequence = 0;
  const kernel = {
    issueGrant: vi.fn(async () => ({ grantId: `grant-${++sequence}` })), scoped: vi.fn(() => actor), revokeGrant: vi.fn(async () => ({})),
    recordWorkspaces: vi.fn(async () => ({ workspaceIds: [source.workspaceId] })),
  };
  return { actor, kernel, owner: kernel as unknown as KernelClient };
}

describe('external original file capture owner', () => {
  it('recovers the original atomic receipt after transfer failure without reading a changed path again', async () => {
    const f = fixture();
    const first = await captureExternalFile(f.owner, conversation, 'same-input-slot', 'data.bin', source);
    await first.release();
    expect(f.actor.releaseRecord).not.toHaveBeenCalled();
    const retry = (await restoreExternalCapture(f.owner, conversation, 'same-input-slot', 'data.bin'))!;
    expect(f.actor.fileCapture).toHaveBeenCalledOnce();
    expect(f.actor.fileRootRegister).toHaveBeenCalledOnce();
    const received: Uint8Array[] = [];
    for await (const chunk of retry.chunks) received.push(chunk);
    expect(Buffer.concat(received).toString()).toBe('fixed');
    await retry.readPage(0, 32, { representation: 'manifest' });
    expect(f.actor.getBlob).toHaveBeenLastCalledWith('sha256-original', expect.objectContaining({ slot: 'source' }), expect.objectContaining({ representation: 'manifest' }));
    await retry.readPage(0, 32, { rangeObject: 'sha256-range' });
    expect(f.actor.getBlob).toHaveBeenLastCalledWith('sha256-range', expect.objectContaining({ slot: 'source' }), expect.objectContaining({ rangeRoot: 'sha256-original' }));
    await retry.release(true);
    expect(f.actor.releaseRecord).toHaveBeenCalledOnce();
    expect(f.kernel.revokeGrant).toHaveBeenCalledTimes(4);
  });
  it('does not change the selection or execution owner of an already fixed input slot', async () => {
    const f = fixture();
    await (await captureExternalFile(f.owner, conversation, 'same-input-slot', 'data.bin', source)).release();
    await expect(captureExternalFile(f.owner, conversation, 'same-input-slot', 'replacement.bin', source)).rejects.toMatchObject({ code: 'attachment_changed' });
    await expect(captureExternalFile(f.owner, conversation, 'same-input-slot', 'data.bin', { ...source, executionWorkspaceId: 'replacement' })).rejects.toMatchObject({ code: 'attachment_changed' });
    expect(f.actor.fileCapture).toHaveBeenCalledOnce();
    await expect(captureExternalFile(f.owner, conversation, 'outside', '../secret', source)).rejects.toMatchObject({ code: 'attachment_source' });
  });
  it('releases deleted conversation captures in their original workspaces, not only the shared attachment workspace', async () => {
    const f = fixture();
    await releaseExternalCaptures(f.owner, conversation.id);
    expect(f.kernel.recordWorkspaces).toHaveBeenCalledWith({ recordType: 'attachment.capture' }, expect.anything());
    expect(f.actor.listRecords).toHaveBeenCalledWith({ workspaceId: source.workspaceId, recordType: 'attachment.capture', threadId: conversation.id });
    expect(f.actor.releaseRecord).toHaveBeenCalledWith('owner-delete:external:actual:attachment-capture:original', source.workspaceId, 'attachment-capture:original');
    expect(f.kernel.revokeGrant).toHaveBeenCalledTimes(2);
  });
});


it('captures a separately admitted absolute file and resumes its fixed version without reopening the directory', async () => {
  const f = fixture();
  const resolveWorkspace = vi.fn(async () => ({ workspaceId: source.workspaceId, canonicalRoot: source.canonicalRoot }));
  const capture = createAbsoluteAttachmentCapture({ kernel: f.owner, resolveWorkspace });
  const input = { threadId: conversation.id, operationId: 'original-send', ref: 'attachment:slot', selectedPath: '/source/data.bin' };
  await (await capture(input)).release();
  expect(resolveWorkspace).toHaveBeenCalledWith('/source', undefined);
  resolveWorkspace.mockRejectedValue(new Error('The mutable directory was removed'));
  const retry = await capture(input);
  expect(retry.byteLength).toBe(5);
  expect(resolveWorkspace).toHaveBeenCalledOnce();
  expect(f.actor.fileCapture).toHaveBeenCalledOnce();
  await retry.release(true);
});


it('does not skip retained capture pages while deleting rows with offset cursors', async () => {
  const f = fixture(), ids = ['attachment-capture:first', 'attachment-capture:second', 'attachment-capture:third'];
  f.actor.listRecords.mockImplementation(async (...args: unknown[]) => {
    const cursor = (args[0] as { cursor?: number }).cursor ?? 0;
    return { records: ids.slice(cursor, cursor + 1).map(recordId => ({ recordId, state: 'retained' })), nextCursor: cursor + 1 < ids.length ? cursor + 1 : null };
  });
  f.actor.releaseRecord.mockImplementation(async (...args: unknown[]) => { ids.splice(ids.indexOf(String(args[2])), 1); return {}; });
  await releaseExternalCaptures(f.owner, conversation.id);
  expect(ids).toEqual([]);
  expect(f.actor.releaseRecord).toHaveBeenCalledTimes(3);
});


it('never recaptures a mutable path when a fixed receipt disappears during recovery', async () => {
  const f = fixture();
  await (await captureExternalFile(f.owner, conversation, 'fixed-slot', 'data.bin', source)).release();
  const originalRead = f.actor.getRecord.getMockImplementation()!;
  let reads = 0;
  f.actor.getRecord.mockImplementation(async () => ++reads === 1 ? originalRead() : null);
  await expect(restoreExternalCapture(f.owner, conversation, 'fixed-slot', 'data.bin')).rejects.toMatchObject({ code: 'attachment_source' });
  expect(f.actor.fileRootRegister).toHaveBeenCalledOnce();
  expect(f.actor.fileCapture).toHaveBeenCalledOnce();
});


it('does not sweep a managed absolute capture with the same local conversation ID', async () => {
  const f = fixture();
  f.actor.listRecords.mockResolvedValue({ records: [
    { recordId: 'attachment-capture:local', state: 'retained' },
    { recordId: 'attachment-managed-capture:foreign', state: 'retained' },
  ], nextCursor: null });
  await releaseExternalCaptures(f.owner, conversation.id);
  expect(f.actor.releaseRecord).toHaveBeenCalledExactlyOnceWith('owner-delete:external:actual:attachment-capture:local', source.workspaceId, 'attachment-capture:local');
});
