import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { stripWindowsNamespacePrefix } from '../workspace/path-safety.js';
import { attachmentMimeType } from '@varin/protocol';
import type { KernelClient } from './kernel-client.js';
import type { KernelBranchState } from './protocol.generated.js';
import type { FileContentReadOptions } from './file-content-transfer.js';
import type { KernelObjectSlice } from './protocol.generated.js';

export interface CapturedAttachmentFile {
  filename: string; mimeType: string; byteLength: number; contentHash: string; chunks: AsyncIterable<Uint8Array>;
  readPage(offset: number, length: number, view?: FileContentReadOptions): Promise<KernelObjectSlice>;
  release(committed?: boolean): Promise<void>;
}
export class AttachmentCaptureError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

interface CaptureOwner { id: string; captureScope?: string }
const captureRecordId = (owner: CaptureOwner, key: string) => `${owner.captureScope ? 'attachment-managed-capture' : 'attachment-capture'}:${createHash('sha256').update(JSON.stringify([owner.id, key])).digest('hex')}`;

/** Reuses the admitted execution root and Rust's consistent single-file capture. */
export async function captureOwnedAttachment(kernel: KernelClient, conversation: CaptureOwner, key: string, selectedPath: string,
  source: { workspaceId: string; executionWorkspaceId: string; canonicalRoot: string }, signal?: AbortSignal, recoverOnly = false, captureOperationId?: string): Promise<CapturedAttachmentFile> {
  // Windows Rust canonicalize returns verbatim drive/UNC paths while Node's
  // admitted Documents path may use the equivalent ordinary spelling. Remove
  // only that namespace syntax on the resource Host; never case-fold roots.
  const localPath = (value: string) => path.sep === '\\' ? stripWindowsNamespacePrefix(value) : value;
  const target = path.resolve(localPath(source.canonicalRoot), localPath(selectedPath));
  const relative = path.relative(localPath(source.canonicalRoot), target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new AttachmentCaptureError('attachment_source', 'Select a file within this admitted execution source');
  const recordId = captureRecordId(conversation, key);
  const grant = await kernel.issueGrant({ grantId: `attachment-owner:${randomUUID()}`, threadId: conversation.id,
    owningWorkspace: source.workspaceId, executionWorkspace: source.executionWorkspaceId,
    capabilities: ['storage.read', 'storage.write'], pathScopes: [relative.replaceAll('\\', '/')] }, signal);
  const actor = kernel.scoped(grant);
  let closed = false;
  const release = async (committed = false) => {
    if (closed) return;
    try { if (committed) await actor.releaseRecord(`release:${recordId}`, source.workspaceId, recordId); }
    finally { closed = true; await kernel.revokeGrant(grant.grantId); }
  };
  try {
    let retained = await actor.getRecord(source.workspaceId, recordId, signal);
    let admittedCanonicalRoot = source.canonicalRoot;
    if (!retained && recoverOnly) throw new AttachmentCaptureError('attachment_source', 'The retained original capture was released during recovery');
    if (!retained) {
      const root = await actor.fileRootRegister({ workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, canonicalRoot: source.canonicalRoot }, signal);
      admittedCanonicalRoot = root.canonicalRoot;
      await actor.fileCapture({ operationId: captureOperationId ?? recordId, workspaceId: source.workspaceId, rootId: root.rootId, path: relative.replaceAll('\\', '/'), store: true, retentionRecordId: recordId }, signal);
      retained = await actor.getRecord(source.workspaceId, recordId, signal);
    }
    if (!retained || retained.state === 'released') throw new AttachmentCaptureError('attachment_source', 'The retained original file is unavailable');
    const receipt = JSON.parse(retained.payloadJson) as { path: string; stateJson: string; executionWorkspaceId: string; canonicalRoot: string };
    if (retained.recordType !== 'attachment.capture' || retained.threadId !== conversation.id || receipt.executionWorkspaceId !== source.executionWorkspaceId || receipt.path !== relative.replaceAll('\\', '/')) throw new AttachmentCaptureError('attachment_changed', 'This capture key belongs to another selected path');
    if (localPath(receipt.canonicalRoot) !== localPath(admittedCanonicalRoot)) {
      // A spelling difference beyond the Windows namespace (including case or
      // symlinks) needs the original root owner to prove identity. Recovery from
      // a retained receipt never reopens the mutable path or invents that proof.
      if (recoverOnly) throw new AttachmentCaptureError('attachment_changed', 'This capture key belongs to another selected path');
      const root = await actor.fileRootRegister({ workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, canonicalRoot: source.canonicalRoot }, signal);
      if (localPath(receipt.canonicalRoot) !== localPath(root.canonicalRoot)) throw new AttachmentCaptureError('attachment_changed', 'This capture key belongs to another selected path');
    }
    const state = JSON.parse(receipt.stateJson) as KernelBranchState;
    if (state.kind !== 'regular-file') throw new AttachmentCaptureError('attachment_source', `The selected attachment is ${state.kind}, not a regular file`);
    const { objectHash, byteLength } = state;
    const chunks = (async function* () {
      let offset = 0;
      do {
        signal?.throwIfAborted();
        const page = await actor.getBlob(objectHash, { recordId, slot: 'source' }, { offset, length: Math.min(256 * 1024, byteLength - offset), ...(signal ? { signal } : {}) });
        const bytes = Buffer.from(page.bytesBase64, 'base64');
        if (page.hash !== objectHash || page.byteLength !== byteLength || page.offset !== offset || page.nextOffset !== offset + bytes.length || page.eof !== (page.nextOffset === byteLength) || !page.eof && !bytes.length)
          throw new AttachmentCaptureError('attachment_incomplete', 'The original file transfer is incomplete');
        offset = page.nextOffset;
        if (bytes.length) yield bytes;
        if (page.eof) break;
      } while (offset < byteLength);
    })();
    const readPage = (offset: number, length: number, view: FileContentReadOptions = {}) =>
      actor.getBlob(view.rangeObject ?? objectHash, { recordId, slot: 'source' }, { offset, length,
        ...(view.representation ? { representation: view.representation } : {}), ...(view.rangeObject ? { rangeRoot: objectHash } : {}), ...(signal ? { signal } : {}) });
    return { filename: path.basename(target), mimeType: attachmentMimeType(target), byteLength, contentHash: objectHash, chunks, readPage, release };
  } catch (error) { await release(); throw error; }
}


/** Called only after the original processes are closed and Catalog marks the owner deleted. */
export async function releaseCapturedAttachments(kernel: KernelClient, conversationId: string): Promise<void> {
  const discovery = await kernel.issueGrant({ grantId: `attachment-owner-discovery:${randomUUID()}`,
    owningWorkspace: null, executionWorkspace: null, capabilities: ['storage.read', 'storage.maintenance'], pathScopes: [] });
  try {
    const { workspaceIds } = await kernel.recordWorkspaces({ recordType: 'attachment.capture' }, discovery);
    for (const workspaceId of workspaceIds) {
      const grant = await kernel.issueGrant({ grantId: `attachment-owner-release:${randomUUID()}`, threadId: conversationId,
        owningWorkspace: workspaceId, executionWorkspace: workspaceId, capabilities: ['storage.read', 'storage.maintenance'], pathScopes: [] });
      try {
        const actor = kernel.scoped(grant);
        const ids: string[] = [];
        let cursor: number | undefined;
        do {
          const page = await actor.listRecords({ workspaceId, recordType: 'attachment.capture', threadId: conversationId,
            ...(cursor === undefined ? {} : { cursor }) });
          for (const record of page.records) if (record.state !== 'released' && record.recordId.startsWith('attachment-capture:')) ids.push(record.recordId);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        // The native cursor is an offset. Collect identities before deleting any
        // row so a release cannot shift the unread portion of the same page set.
        for (const id of ids) await actor.releaseRecord(`owner-delete:${conversationId}:${id}`, workspaceId, id);
      } finally { await kernel.revokeGrant(grant.grantId); }
    }
  } finally { await kernel.revokeGrant(discovery.grantId); }
}


/** Recover a fixed selection before reopening a mutable execution directory. */
export async function restoreCapturedAttachment(kernel: KernelClient, conversation: CaptureOwner, key: string,
  selectedPath: string, signal?: AbortSignal): Promise<CapturedAttachmentFile | undefined> {
  const discovery = await kernel.issueGrant({ grantId: `attachment-owner-restore:${randomUUID()}`,
    owningWorkspace: null, executionWorkspace: null, capabilities: ['storage.read', 'storage.maintenance'], pathScopes: [] }, signal);
  let source: { workspaceId: string; executionWorkspaceId: string; canonicalRoot: string } | undefined;
  try {
    const { workspaceIds } = await kernel.recordWorkspaces({ recordType: 'attachment.capture' }, discovery, signal);
    for (const workspaceId of workspaceIds) {
      const grant = await kernel.issueGrant({ grantId: `attachment-owner-receipt:${randomUUID()}`, threadId: conversation.id,
        owningWorkspace: workspaceId, executionWorkspace: workspaceId, capabilities: ['storage.read'], pathScopes: [] }, signal);
      try {
        const record = await kernel.scoped(grant).getRecord(workspaceId, captureRecordId(conversation, key), signal);
        if (!record || record.state === 'released') continue;
        if (record.recordType !== 'attachment.capture' || record.threadId !== conversation.id) throw new AttachmentCaptureError('attachment_changed', 'The retained file belongs to another original owner');
        const value = JSON.parse(record.payloadJson) as { executionWorkspaceId: string; canonicalRoot: string };
        if (source || typeof value.executionWorkspaceId !== 'string' || typeof value.canonicalRoot !== 'string' || !path.isAbsolute(value.canonicalRoot))
          throw new AttachmentCaptureError('attachment_changed', 'The original capture source is unavailable or ambiguous');
        source = { workspaceId, executionWorkspaceId: value.executionWorkspaceId, canonicalRoot: value.canonicalRoot };
      } finally { await kernel.revokeGrant(grant.grantId); }
    }
  } finally { await kernel.revokeGrant(discovery.grantId); }
  return source ? captureOwnedAttachment(kernel, conversation, key, selectedPath, source, signal, true) : undefined;
}
