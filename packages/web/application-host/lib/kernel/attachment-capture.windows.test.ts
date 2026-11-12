import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { KernelClient } from './kernel-client.js';
import type { KernelRecordResult } from './protocol.generated.js';
// Exercise the actual Host capture adapter using Windows path semantics on every
// test platform. Storage still supplies its own canonical root and capture receipt.
vi.mock('node:path', async importOriginal => {
  const original = await importOriginal<typeof import('node:path')>();
  return { ...original, default: original.win32 };
});
import { captureOwnedAttachment, restoreCapturedAttachment } from './attachment-capture.js';
function fixture() {
  let record: KernelRecordResult | null = null;
  const canonical = (value: string) => value.startsWith('\\\\?\\') ? value : value.startsWith('\\\\') ? `\\\\?\\UNC\\${value.slice(2)}` : `\\\\?\\${value}`;
  const registered = new Map<string, string>();
  const fileRootRegister = vi.fn(async (input: { canonicalRoot: string }) => {
    const canonicalRoot = canonical(input.canonicalRoot), rootId = `root:${canonicalRoot}`;
    registered.set(rootId, canonicalRoot); return { rootId, canonicalRoot };
  });
  const hash = `sha256-${createHash('sha256').update('fixed').digest('hex')}`;
  const fileCapture = vi.fn(async (input: { rootId: string; path: string; retentionRecordId: string }) => {
    record = { recordId: input.retentionRecordId, workspaceId: 'workspace', recordType: 'attachment.capture', state: 'temporary', threadId: 'conversation',
      recordRevision: 1, createdAt: 1, updatedAt: 1,
      payloadJson: JSON.stringify({ path: input.path, executionWorkspaceId: 'execution', canonicalRoot: registered.get(input.rootId),
        stateJson: JSON.stringify({ kind: 'regular-file', objectHash: hash, byteLength: 5 }) }), references: [{ slot: 'source', objectHash: hash }] };
  });
  const actor = { fileRootRegister, fileCapture, getRecord: vi.fn(async () => record),
    getBlob: vi.fn(async () => ({ hash, byteLength: 5, offset: 0, nextOffset: 5, eof: true, bytesBase64: Buffer.from('fixed').toString('base64') })),
    releaseRecord: vi.fn(async () => { record = null; }) };
  const kernel = { issueGrant: vi.fn(async () => ({ grantId: 'grant' })), revokeGrant: vi.fn(async () => undefined),
    scoped: () => actor, recordWorkspaces: vi.fn(async () => ({ workspaceIds: ['workspace'] })) } as unknown as KernelClient;
  return { kernel, actor };
}
it.each(['C:\\Target\\Project', '\\\\server\\share\\Project'])('joins Rust canonical namespace receipts for %s and preserves immutable recovery', async root => {
  const f = fixture(), owner = { id: 'conversation' }, source = { workspaceId: 'workspace', executionWorkspaceId: 'execution', canonicalRoot: root };
  const capture = await captureOwnedAttachment(f.kernel, owner, 'original-key', 'file.txt', source);
  expect(await capture.readPage(0, 5)).toMatchObject({ bytesBase64: Buffer.from('fixed').toString('base64') });
  await capture.release();
  expect(f.actor.fileCapture).toHaveBeenCalledTimes(1);
  f.actor.fileRootRegister.mockRejectedValue(new Error('Original directory no longer exists'));
  const recovered = await restoreCapturedAttachment(f.kernel, owner, 'original-key', `${root}\\file.txt`);
  expect(recovered?.contentHash).toBe(capture.contentHash);
  expect(f.actor.fileRootRegister).toHaveBeenCalledTimes(1);
  await recovered?.release();
});
it('does not equate different roots, case-sensitive roots, execution owners or files under the same capture key', async () => {
  const f = fixture(), owner = { id: 'conversation' }, source = { workspaceId: 'workspace', executionWorkspaceId: 'execution', canonicalRoot: 'C:\\Target\\Project' };
  await (await captureOwnedAttachment(f.kernel, owner, 'key', 'file.txt', source)).release();
  for (const canonicalRoot of ['D:\\Other\\Project', 'C:\\target\\Project']) {
    await expect(captureOwnedAttachment(f.kernel, owner, 'key', 'file.txt', { ...source, canonicalRoot })).rejects.toMatchObject({ code: 'attachment_changed' });
  }
  await expect(captureOwnedAttachment(f.kernel, owner, 'key', 'file.txt', { ...source, executionWorkspaceId: 'foreign' })).rejects.toMatchObject({ code: 'attachment_changed' });
  await expect(captureOwnedAttachment(f.kernel, owner, 'key', 'another.txt', source)).rejects.toMatchObject({ code: 'attachment_changed' });
  expect(f.actor.fileCapture).toHaveBeenCalledTimes(1);
});
