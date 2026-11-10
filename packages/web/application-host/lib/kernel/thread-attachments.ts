import { isDeepStrictEqual } from 'node:util';
import { createHostModelReferences, resolveFileReference, type FileReferenceTarget } from './model-references.js';
/** Attachment admission is a material-owner adapter. Rust Storage owns every byte,
 * record, upload receipt and prepared execution path; Catalog owns delivery. */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { attachmentMimeType, materialAttachmentRef, parseWebSourceCitation, parseAttachmentSelections, type Attachment, type AttachmentSelection } from '@varin/protocol';
import type { ExternalConversation, ThreadIdentity } from '@varin/application-client';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient, KernelScopedClient, KernelBlobReadSource } from './kernel-client.js';
import type { KernelStorageContext } from './storage-adapter.js';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import type { WebMaterialStore } from '../harness/web-materials.js';
import type { LiveSourceResolver } from './live-source.js';
import type { KernelBranchState, LaunchSource, ToolOrigin, MaterialRetention, KernelObjectSlice } from './protocol.generated.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import { copyRangeContent, type FileContentReadOptions } from './file-content-transfer.js';
import { withManagedAttachmentResult } from './managed-attachment-result.js';
import { prepareManagedAttachmentPath } from './managed-attachment-path.js';
import { resourceThreadSource } from './thread-context.js';
import { beginMaterialActivity, createMaterialLifecycle } from '../harness/material-lifecycle.js';
import { threadMaterialScope } from './material-storage.js';
import { HarnessServiceError } from '../harness/service-error.js';

export const ATTACHMENT_FILE = 'attachment.file';
export const ATTACHMENT_DELIVERY = 'attachment.delivery';
const PAGE = 256 * 1024;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const recordId = (ref: string) => {
  if (!/^attachment:[a-zA-Z0-9_-]+$/.test(ref)) throw new HarnessServiceError('invalid-params', 'Select an original attachment reference');
  return ref;
};
const filename = (value: string) => {
  if (!value.trim() || value === '.' || value === '..' || /[\\/]/.test(value) || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new HarnessServiceError('invalid-params', 'The attachment filename is invalid');
  return value;
};
interface Scope { workspaceId: string; threadId: string }
interface StoredAttachment { attachment: Attachment; contentHash: string; selection?: AttachmentSelection; operationId?: string; materials?: Array<{ snapshotId: string; contentHash: string; sourceHash?: string }> }
type RecordValue = Awaited<ReturnType<KernelStorageContext['records']['get']>>;
export interface AttachmentUpload { key: string; filename: string; mimeType: string; byteLength: number }
export interface AttachmentRead { attachment: Attachment; stream: AsyncIterable<Uint8Array> }
export interface EventAttachmentCapture {
  attachment: Attachment; contentHash: string; readPage(offset: number, length: number): Promise<KernelObjectSlice>;
}
export interface ExternalAttachmentCapture {
  filename: string; mimeType: string; byteLength: number; contentHash: string; chunks: AsyncIterable<Uint8Array>; readPage(offset: number, length: number, view?: FileContentReadOptions): Promise<KernelObjectSlice>; release(committed?: boolean): Promise<void>;
}
type ExternalIdentity = Pick<ExternalConversation, 'id' | 'parent'>;
export interface AttachmentPreparationQuery {
  runId: string; origin: ToolOrigin; callId: string; resourceCheckpointId: string;
  request: { kind: 'attachment_prepare'; operationId: string; targetThreadId: string; targetBranchId?: string; attachments: AttachmentSelection[] };
}

export function createThreadAttachments(options: {
  kernel: KernelClient; runtime: AgentRuntimeClient; storage: WorkspaceWorkingStateRootAccess;
  materials: WebMaterialStore; resolveLiveSource: LiveSourceResolver; requestMaintenance?(): void;
}) {
  let eventCapture: ((threadId: string, ref: string, signal?: AbortSignal) => Promise<EventAttachmentCapture>) | undefined;
  let absoluteCapture: ((identity: { threadId: string; operationId: string; ref: string; selectedPath: string }, signal?: AbortSignal) => Promise<ExternalAttachmentCapture>) | undefined;
  let externalCapture: ((conversation: ExternalIdentity, key: string, path: string, signal?: AbortSignal) => Promise<ExternalAttachmentCapture>) | undefined;
  const inScope = <T>(scope: Scope, purpose: string, action: (context: KernelStorageContext) => Promise<T>) =>
    options.storage.withBranchStore(scope.workspaceId, purpose, (_store, context) => {
      if (!context?.client || !context.records) throw new HarnessServiceError('unavailable', 'Original attachment storage is unavailable');
      return action(context as KernelStorageContext);
    }, 'shared', { threadId: scope.threadId });
  const scopeFor = async (identity: ThreadIdentity, signal?: AbortSignal, allowDeleted = false): Promise<Scope> => {
    if (identity.runtime !== 'agent') throw new HarnessServiceError('forbidden', 'Select a native Thread');
    const [family, thread] = await Promise.all([
      options.runtime.familyList({ callerThreadId: identity.threadId, includeSelf: true }, signal), options.runtime.thread(identity.threadId, signal),
    ]);
    if (!allowDeleted && thread.deleted_at_ms != null) throw new HarnessServiceError('not-found', 'The attachment Thread has been deleted');
    if (!thread.branches.some(branch => branch.branch_id === identity.branchId)) throw new HarnessServiceError('forbidden', 'The attachment branch does not belong to this Thread');
    return { workspaceId: threadMaterialScope(family.rootThreadId), threadId: identity.threadId };
  };
  const nativeActivity = async <T>(identity: ThreadIdentity, scope: Scope, action: () => Promise<T>, signal?: AbortSignal) => {
    const stopped = beginMaterialActivity(scope.workspaceId, scope.threadId);
    try {
      const thread = await options.runtime.thread(identity.threadId, signal);
      if (thread.deleted_at_ms != null || !thread.branches.some(branch => branch.branch_id === identity.branchId)) throw new HarnessServiceError('not-found', 'The attachment Thread has been deleted');
      signal?.throwIfAborted();
      return await action();
    } finally { stopped(); }
  };
  const externalScope = async (conversation: ExternalIdentity, signal?: AbortSignal, allowDeleted = false): Promise<Scope> => {
    const parent = conversation.parent;
    const scope = parent ? await scopeFor({ runtime: 'agent', threadId: parent.threadId, branchId: parent.branchId }, signal, allowDeleted)
      : { workspaceId: threadMaterialScope(`external:${conversation.id}`) };
    return { workspaceId: scope.workspaceId, threadId: conversation.id };
  };
  const stored = (record: NonNullable<RecordValue>): StoredAttachment => {
    let value: StoredAttachment;
    try { value = JSON.parse(record.payloadJson); } catch { throw new HarnessServiceError('unavailable', 'The attachment record is corrupt'); }
    if (record.recordType !== ATTACHMENT_FILE || !value.attachment || value.attachment.ref !== record.recordId
      || typeof value.contentHash !== 'string' || !Number.isSafeInteger(value.attachment.byteLength) || value.attachment.byteLength < 0
      || !record.references.some(reference => reference.slot === 'source' && reference.objectHash === value.contentHash))
      throw new HarnessServiceError('unavailable', 'The attachment record is incomplete');
    return value;
  };
  const accessible = async (context: KernelStorageContext, scope: Scope, ref: string): Promise<StoredAttachment> => {
    const record = await context.records.get(recordId(ref));
    if (!record || record.state === 'released') throw new HarnessServiceError('not-found', 'The original attachment is no longer available');
    if (record.threadId !== scope.threadId) {
      const grants = await context.records.list({ recordType: ATTACHMENT_DELIVERY, threadId: scope.threadId });
      const allowed = grants.some(grant => {
        if (grant.state === 'released' || grant.threadId !== scope.threadId) return false;
        try { const value = JSON.parse(grant.payloadJson); return value.toThreadId === scope.threadId && Array.isArray(value.attachmentRefs) && value.attachmentRefs.includes(ref); }
        catch { return false; }
      });
      if (!allowed) throw new HarnessServiceError('forbidden', 'This Thread has not received the selected attachment');
    }
    return stored(record);
  };
  const write = async (context: KernelStorageContext, scope: Scope, value: StoredAttachment, ownerIds: string[] = []) => {
    await context.records.put({ operationId: `retain:${value.attachment.ref}`, recordId: value.attachment.ref,
      recordType: ATTACHMENT_FILE, state: 'temporary', threadId: scope.threadId, payloadJson: JSON.stringify(value), ownerIds,
      references: [{ slot: 'source', objectHash: value.contentHash }, ...(value.materials ?? []).flatMap((material, index) => [
        { slot: `material:${index}:body`, objectHash: material.contentHash }, ...(material.sourceHash ? [{ slot: `material:${index}:source`, objectHash: material.sourceHash }] : [])])] });
    return value.attachment;
  };
  const chunks = async function* (client: KernelScopedClient, hash: string, byteLength: number, source: KernelBlobReadSource, signal?: AbortSignal) {
    let offset = 0;
    do {
      signal?.throwIfAborted();
      const page = await client.getBlob(hash, source, { offset, length: Math.min(PAGE, byteLength - offset), signal });
      const bytes = Buffer.from(page.bytesBase64, 'base64');
      if (page.hash !== hash || page.offset !== offset || page.byteLength !== byteLength || page.nextOffset !== offset + bytes.byteLength
        || page.eof !== (page.nextOffset === byteLength) || !page.eof && !bytes.length)
        throw new HarnessServiceError('unavailable', 'The original attachment read was incomplete');
      offset = page.nextOffset;
      if (bytes.length) yield bytes;
      if (page.eof) break;
    } while (offset < byteLength);
  };
  const transferPages = (target: KernelScopedClient, hash: string, byteLength: number,
    read: (offset: number, length: number, view?: FileContentReadOptions) => Promise<KernelObjectSlice>, operationId: string, signal?: AbortSignal) => {
    if (hash.startsWith('ranges-')) return copyRangeContent(target, hash, byteLength, read, signal, operationId);
    const stream = (async function* () {
      let offset = 0;
      do {
        signal?.throwIfAborted();
        const page = await read(offset, Math.min(PAGE, byteLength - offset)), body = Buffer.from(page.bytesBase64, 'base64');
        if (page.hash !== hash || page.offset !== offset || page.byteLength !== byteLength || page.nextOffset !== offset + body.length
          || page.eof !== (page.nextOffset === page.byteLength) || !page.eof && !body.length) throw new HarnessServiceError('unavailable', 'The original attachment transfer was incomplete');
        offset = page.nextOffset; if (body.length) yield body; if (page.eof) break;
      } while (offset < byteLength);
    })();
    return target.putBlobStream(stream, { operationId, byteLength, expectedHash: hash }, signal);
  };
  const transfer = (target: KernelScopedClient, source: KernelScopedClient, hash: string, byteLength: number, proof: KernelBlobReadSource, operationId: string, signal?: AbortSignal) =>
    transferPages(target, hash, byteLength, (offset, length, view = {}) => source.getBlob(view.rangeObject ?? hash, proof,
      { offset, length, ...(view.representation ? { representation: view.representation } : {}), ...(view.rangeObject ? { rangeRoot: hash } : {}), signal }), operationId, signal);
  const upload = async (scope: Scope, request: AttachmentUpload, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<Attachment> => {
    filename(request.filename);
    if (!request.key || !Number.isSafeInteger(request.byteLength) || request.byteLength < 0) throw new HarnessServiceError('invalid-params', 'The attachment upload metadata is invalid');
    const ref = `attachment:${digest([scope.threadId, 'upload', request.key])}`;
    const attachment = { ref, filename: request.filename, mimeType: attachmentMimeType(request.filename, request.mimeType), byteLength: request.byteLength };
    return inScope(scope, 'attachment-write', async context => {
      const existing = await context.records.get(ref);
      if (existing) {
        const original = stored(existing);
        if (JSON.stringify(original.attachment) !== JSON.stringify(attachment)) throw new HarnessServiceError('conflict', 'The upload retry changed its filename, type or size');
        const hash = createHash('sha256'); let length = 0;
        for await (const bytes of source) { signal?.throwIfAborted(); length += bytes.byteLength; hash.update(bytes); }
        if (length !== request.byteLength || `sha256-${hash.digest('hex')}` !== original.contentHash) throw new HarnessServiceError('conflict', 'The upload retry changed its original bytes');
        return original.attachment;
      }
      const object = await context.client.putBlobStream(source, { operationId: `upload:${ref}`, byteLength: request.byteLength }, signal);
      return write(context, scope, { attachment, contentHash: object.hash }, [object.ownerId]);
    });
  };
  const captureEvent = async (scope: Scope, ref: string, signal?: AbortSignal): Promise<Attachment> => {
    if (!eventCapture) throw new HarnessServiceError('unavailable', 'Original event attachment storage is unavailable');
    // The callback is a trusted Catalog reader, never a plugin-provided reference or hash.
    const original = await eventCapture(scope.threadId, ref, signal);
    if (original.attachment.ref !== ref) throw new HarnessServiceError('unavailable', 'The original event attachment changed identity');
    filename(original.attachment.filename);
    return inScope(scope, 'attachment-write', async context => {
      const existing = await context.records.get(ref);
      if (existing && existing.state !== 'released') {
        const value = stored(existing);
        if (value.contentHash !== original.contentHash || JSON.stringify(value.attachment) !== JSON.stringify(original.attachment))
          throw new HarnessServiceError('conflict', 'The event attachment changed its original content');
      } else {
        const object = await transferPages(context.client, original.contentHash, original.attachment.byteLength,
          original.readPage, `event-attachment:${digest([scope.workspaceId, ref])}`, signal);
        await write(context, scope, { attachment: original.attachment, contentHash: object.hash }, [object.ownerId]);
      }
      // A shared family store may already hold this file for another recipient. Only the
      // Catalog-authorized reader above can grant this Thread its independent delivery.
      const id = `attachment-delivery:${digest(['event', scope.threadId, ref])}`;
      const grant = await context.records.get(id);
      if (!grant || grant.state === 'released') await context.records.put({ operationId: grant ? `retain:${id}:${grant.recordRevision}` : `retain:${id}`,
        recordId: id, recordType: ATTACHMENT_DELIVERY, ...(grant ? { expectedRecordRevision: grant.recordRevision } : {}),
        state: 'temporary', threadId: scope.threadId,
        payloadJson: JSON.stringify({ fromThreadId: scope.threadId, toThreadId: scope.threadId, attachmentRefs: [ref], operationId: `event:${ref}` }),
        references: [{ slot: 'attachment:0', objectHash: original.contentHash }] });
      return original.attachment;
    });
  };
  const references = createHostModelReferences(options.kernel);
  const capture = async (scope: Scope, selection: AttachmentSelection, operationId: string, index: number, runId: string | undefined, signal?: AbortSignal, frozenSource?: LaunchSource | null,
    observed?: {reference:string;target:Extract<FileReferenceTarget,{kind:'observation'}>}): Promise<Attachment> => {
    const originalSelection: AttachmentSelection = observed ? {ref:observed.reference} : selection;
    const verifyObservation = async (state: KernelBranchState, path: string, rootId?: string, readVersion?: string) => {
      if (!observed) return;
      await options.kernel.agentRuntimeRequest('runtime.model_reference.file_state', {source:observed.target.source,path,state,
        ...(rootId ? {rootId}:{}),...(readVersion ? {readVersion}:{}),expectedReadVersion:observed.target.readVersion},signal);
    };
    if (typeof selection.ref === 'string') {
      const selectedRef = selection.ref;
      if (selectedRef.startsWith('file:')) {
        const target = await resolveFileReference(references,selectedRef,signal);
        if (target.kind === 'attachment') return capture(scope,{ref:target.reference},operationId,index,runId,signal,frozenSource);
        if (!runId) throw new HarnessServiceError('unavailable','A file observation needs its original execution source');
        const source = frozenSource ?? (await options.runtime.launch(runId,signal))?.selection.source;
        if (!isDeepStrictEqual(source,target.source)) throw new HarnessServiceError('conflict','This file observation belongs to a different source; read the path in the selected source to choose a new observation');
        return capture(scope,{path:target.path},operationId,index,runId,signal,source,{reference:selectedRef,target});
      }
      if (selectedRef.startsWith('attachment:')) {
        const existing = await inScope(scope, 'attachment-read', async context => context.records.get(recordId(selectedRef)));
        if (existing) {
          try { return await inScope(scope, 'attachment-read', async context => (await accessible(context, scope, selectedRef)).attachment); }
          catch (error) { if (selectedRef.startsWith('attachment:event_')) return captureEvent(scope, selectedRef, signal); if (!await retainReportReference(scope, selectedRef, signal)) throw error; return inScope(scope, 'attachment-read', async context => (await accessible(context, scope, selectedRef)).attachment); }
        }
        if (selectedRef.startsWith('attachment:event_')) return captureEvent(scope, selectedRef, signal);
        if (!selectedRef.startsWith('attachment:operation_')) throw new HarnessServiceError('not-found', 'The original attachment is not available');
        const operationId = Buffer.from(selectedRef.slice('attachment:operation_'.length), 'base64url').toString('utf8');
        if (`attachment:operation_${Buffer.from(operationId).toString('base64url')}` !== selectedRef) throw new HarnessServiceError('invalid-params', 'The original attachment receipt is invalid');
        const operation = await options.runtime.operation(operationId, signal);
        const originalRun = await options.runtime.run(operation.run_id, signal);
        if (originalRun.thread_id !== scope.threadId) {
          if (!await retainReportReference(scope, selectedRef, signal)) throw new HarnessServiceError('forbidden', 'This file receipt has not been delivered to the current Thread');
          return inScope(scope, 'attachment-read', async context => (await accessible(context, scope, selectedRef)).attachment);
        }
        const launch = await options.runtime.launch(originalRun.id, signal);
        const originalSource = launch?.selection.source;
        if (!originalSource) throw new HarnessServiceError('unavailable', 'The original file receipt Host is unavailable');
        if (originalSource.resource_owner.kind === 'managed_host') return withManagedAttachmentResult(options.runtime, { threadId: originalRun.thread_id, runId: originalRun.id, epoch: originalRun.epoch, source: originalSource }, `attachment-read:${selectedRef}`, async ({ client, binding }) => {
          const address = { coordinatorHostId: options.runtime.coordinatorHostId, authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
          const original = await client.service({ ...address, requestId: `describe:${selectedRef}`, operation: { kind: 'attachment_describe', ref: selectedRef } }, signal);
          if (original.attachment.ref !== selectedRef) throw new HarnessServiceError('unavailable', 'The original file receipt changed identity');
          return inScope(scope, 'attachment-write', async context => {
            const object = await transferPages(context.client, original.contentHash, original.attachment.byteLength, (offset, length, view = {}) =>
              client.service({ ...address, requestId: `receipt-read:${randomUUID()}`, operation: { kind: 'attachment_read', ref: selectedRef, offset, length, ...view } }, signal), `receipt-transfer:${selectedRef}`, signal);
            return write(context, scope, { attachment: original.attachment, contentHash: object.hash, operationId }, [object.ownerId]);
          });
        }, signal);
        await options.runtime.admitSourceRegistration({ resourceOwner: originalSource.resource_owner, workspaceId: originalSource.workspace_id, executionWorkspaceId: originalSource.execution_workspace_id }, signal);
        const grant = await options.kernel.issueGrant({ grantId: `attachment-receipt:${randomUUID()}`, owningWorkspace: originalSource.workspace_id,
          executionWorkspace: originalSource.execution_workspace_id, threadId: scope.threadId, capabilities: ['storage.read', 'storage.maintenance'], pathScopes: [] }, signal);
        try {
          const client = options.kernel.scoped(grant);
          const record = await client.getRecord(originalSource.workspace_id, selectedRef, signal);
          if (!record || record.state === 'released' || record.threadId !== scope.threadId) throw new HarnessServiceError('forbidden', 'The original file receipt is not readable by this Thread');
          const original = stored(record);
          if (original.operationId !== operationId) throw new HarnessServiceError('forbidden', 'The original file receipt belongs to another operation');
          return await inScope(scope, 'attachment-write', async context => {
            const object = await transfer(context.client, client, original.contentHash, original.attachment.byteLength, { recordId: selectedRef, slot: 'source' }, `receipt-transfer:${selectedRef}`, signal);
            return write(context, scope, original, [object.ownerId]);
          });
        } finally { await options.kernel.revokeGrant(grant.grantId); }
      }
      // Legacy document IDs are resolved by their original ACL, never scanned from prose.
      const citation = parseWebSourceCitation(selection.ref);
      if (selection.ref.startsWith('varin-material://') && !citation) throw new HarnessServiceError('invalid-params', 'The source citation is invalid');
      const material = await options.materials.read(scope.workspaceId, citation?.snapshotId ?? selection.ref, { kind: 'thread', owningWorkspaceId: scope.workspaceId, threadId: scope.threadId }, { byteRange: { offset: 0, length: 0 }, ...(signal ? { signal } : {}) });
      if (!material) throw new HarnessServiceError('forbidden', 'The selected material is not readable by this Thread');
      if (citation?.contentHash && citation.contentHash !== material.ref.contentHash) throw new HarnessServiceError('conflict', 'The source citation revision changed');
      const retainedMaterials: NonNullable<StoredAttachment['materials']> = [{ snapshotId: material.ref.snapshotId, contentHash: material.ref.contentHash, ...(material.ref.document?.source ? { sourceHash: material.ref.document.source.contentHash } : {}) }];
      if (material.ref.document?.sourceSnapshotId && material.ref.document.sourceSnapshotId !== material.ref.snapshotId) {
        const original = await options.materials.read(scope.workspaceId, material.ref.document.sourceSnapshotId, { kind: 'thread', owningWorkspaceId: scope.workspaceId, threadId: scope.threadId }, { byteRange: { offset: 0, length: 0 }, ...(signal ? { signal } : {}) });
        if (!original) throw new HarnessServiceError('forbidden', 'The original source snapshot is not readable');
        retainedMaterials.push({ snapshotId: original.ref.snapshotId, contentHash: original.ref.contentHash, ...(original.ref.document?.source ? { sourceHash: original.ref.document.source.contentHash } : {}) });
      }
      const source = material.ref.document?.source ?? { contentHash: material.ref.contentHash, byteLength: material.ref.byteLength, contentType: material.ref.contentType ?? 'text/plain' };
      const ref = materialAttachmentRef(material.ref.snapshotId);
      return inScope(scope, 'attachment-write', async context => {
        const previous = await context.records.get(ref);
        if (previous && previous.state !== 'released') return stored(previous).attachment;
        return write(context, scope, { attachment: { ref, filename: path.basename((material.ref.title ?? 'document').replaceAll('\\', '/')).split('').filter(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127).join('') || 'document', mimeType: source.contentType, byteLength: source.byteLength }, contentHash: source.contentHash, materials: retainedMaterials });
      });
    }
    const ref = `attachment:${digest([scope.threadId, operationId, index])}`;
    const cached = await inScope(scope, 'attachment-read', async context => {
      const record = await context.records.get(ref); return record && record.state !== 'released' ? stored(record) : null;
    });
    if (cached) {
      if (JSON.stringify(cached.selection) !== JSON.stringify(originalSelection)) throw new HarnessServiceError('conflict', 'The attachment retry changed its original selection');
      return cached.attachment;
    }
    const importAbsolute = async () => {
      if (observed) throw new HarnessServiceError('unavailable','The original file observation must be captured by its source owner');
      if (!absoluteCapture) throw new HarnessServiceError('unavailable', 'The selected absolute file requires its original directory owner');
      const original = await absoluteCapture({ threadId: scope.threadId, operationId, ref, selectedPath: selection.path }, signal);
      let committed = false;
      try {
        const attachment = await inScope(scope, 'attachment-write', async context => {
          const object = await transferPages(context.client, original.contentHash, original.byteLength, original.readPage, `absolute-transfer:${ref}`, signal);
          return write(context, scope, { attachment: { ref, filename: filename(original.filename), mimeType: original.mimeType, byteLength: original.byteLength }, contentHash: object.hash, selection: originalSelection, operationId }, [object.ownerId]);
        });
        committed = true; return attachment;
      } finally { await original.release(committed); }
    };
    if (!runId) {
      if (path.isAbsolute(selection.path)) return importAbsolute();
      throw new HarnessServiceError('unavailable', 'Select an execution source before attaching a server file path');
    }
    const run = await options.runtime.run(runId, signal), launch = await options.runtime.launch(runId, signal);
    if (run.thread_id !== scope.threadId) throw new HarnessServiceError('forbidden', 'The original attachment Source is unavailable');
    const source = frozenSource ?? launch?.selection.source;
    if (!source) { if (path.isAbsolute(selection.path)) return importAbsolute(); throw new HarnessServiceError('unavailable', 'Select an execution source before attaching a server file path'); }
    if (source.resource_owner.kind === 'managed_host') {
      const consume = async (access: { client: import('../harness/managed-remote-client.js').ManagedSourceClient; binding: import('../harness/managed-remote-types.js').ManagedSourceBinding }, restore: boolean) => {
        const { client, binding } = access;
        const address = { coordinatorHostId: options.runtime.coordinatorHostId, authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
        const original = await client.service({ ...address, requestId: `${restore ? 'recover' : 'capture'}:${ref}`, operation: {
          kind: restore ? 'attachment_recover' : 'attachment_capture', operationId, ref, path: selection.path, ...(observed ? {expectedReadVersion:observed.target.readVersion}:{}) } }, signal);
        if (!original) return null;
        if (original.attachment.ref !== ref) throw new HarnessServiceError('unavailable', 'The remote attachment owner changed the original reference');
        const attachment = await inScope(scope, 'attachment-write', async context => {
          const read = (offset: number, length: number, view: FileContentReadOptions = {}) => client.service({ ...address, requestId: `attachment-read:${randomUUID()}`,
            operation: { kind: 'attachment_read', ref, offset, length, ...view } }, signal);
          const object = await transferPages(context.client, original.contentHash, original.attachment.byteLength, read, `remote-transfer:${ref}`, signal);
          return write(context, scope, { attachment: original.attachment, contentHash: object.hash, selection: originalSelection, operationId }, [object.ownerId]);
        });
        await client.service({ ...address, requestId: `release:${ref}`, operation: { kind: 'attachment_release', ref } });
        return attachment;
      };
      const recovered = await withManagedAttachmentResult(options.runtime, { threadId: run.thread_id, runId: run.id, epoch: run.epoch, source },
        `attachment-recover:${ref}`, access => consume(access, true), signal);
      if (recovered) return recovered;
      const captured = await options.runtime.withManagedSourceAuthority(runId, resourceThreadSource(source)!, access => consume(access, false), signal);
      if (!captured) throw new HarnessServiceError('unavailable', 'The original remote attachment capture is incomplete');
      return captured;
    }
    const captureRecordId = `attachment-capture:${digest([scope.threadId, operationId, index])}`;
    const captureOperationId = `attachment-preparation:${Buffer.from(operationId).toString('base64url')}:${index}`;
    // Recover the original capture before touching the live root. A deleted or
    // changed pathname cannot replace bytes already selected by this operation.
    const retainedGrant = await options.kernel.issueGrant({ grantId: `attachment-capture-read:${randomUUID()}`, threadId: scope.threadId,
      owningWorkspace: source.workspace_id, executionWorkspace: source.execution_workspace_id, capabilities: ['storage.read', 'storage.maintenance'], pathScopes: [] }, signal);
    try {
      const client = options.kernel.scoped(retainedGrant), record = await client.getRecord(source.workspace_id, captureRecordId, signal);
      if (record && record.state !== 'released') {
        const receipt = JSON.parse(record.payloadJson) as { path: string; stateJson: string; readVersion?:string; operationId: string; canonicalRoot: string; executionWorkspaceId: string };
        const relative = path.isAbsolute(selection.path) ? path.relative(receipt.canonicalRoot, selection.path) : selection.path;
        const selectedPath = (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? selection.path : relative).replaceAll('\\', '/');
        if (record.recordType !== 'attachment.capture' || record.threadId !== scope.threadId || receipt.operationId !== captureOperationId
          || receipt.executionWorkspaceId !== source.execution_workspace_id || receipt.path !== selectedPath
          || source.mode === 'live_root' && receipt.canonicalRoot !== source.live_root?.canonicalRoot) throw new HarnessServiceError('conflict', 'The attachment retry changed its original Source or path');
        const state = JSON.parse(receipt.stateJson) as KernelBranchState;
        await verifyObservation(state,receipt.path,source.live_root?.rootId,receipt.readVersion);
        if (state.kind !== 'regular-file') throw new HarnessServiceError('unavailable', 'The retained attachment capture is incomplete');
        const attachment = await inScope(scope, 'attachment-write', async context => {
          const object = await transfer(context.client, client, state.objectHash, state.byteLength, { recordId: captureRecordId, slot: 'source' }, `capture-transfer:${ref}`, signal);
          return write(context, scope, { attachment: { ref, filename: path.basename(receipt.path), mimeType: attachmentMimeType(receipt.path), byteLength: state.byteLength }, contentHash: object.hash, selection: originalSelection, operationId }, [object.ownerId]);
        });
        await client.releaseRecord(`release:${captureRecordId}`, source.workspace_id, captureRecordId);
        return attachment;
      }
    } finally { await options.kernel.revokeGrant(retainedGrant.grantId); }
    const authority = await admitRunSourceAuthority(options.kernel, options.runtime, savedSourceLaunch(runId, source, sourceToolSchemas(launch!.selection).map(tool => tool.name)), { resolveLiveSource: options.resolveLiveSource, allowMaterialization: false, ...(signal ? { signal } : {}) });
    let committed = false;
    try {
      if (authority.kind !== 'local') throw new HarnessServiceError('unavailable', 'The attachment Source Host is unavailable');
      let state: KernelBranchState; let proof: KernelBlobReadSource; let sourcePath = selection.path;
      if (path.isAbsolute(sourcePath)) {
        if (!authority.canonicalRoot) return await importAbsolute();
        const relative = path.relative(authority.canonicalRoot, sourcePath);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { if (!observed) return await importAbsolute(); }
        else sourcePath = relative.replaceAll('\\', '/');
      }
      const captured = await authority.client.getRecord(source.workspace_id, captureRecordId, signal);
      if (captured && captured.state !== 'released') {
        const original = JSON.parse(captured.payloadJson) as { path: string; stateJson: string; readVersion?:string; operationId: string; executionWorkspaceId: string; canonicalRoot: string };
        if (captured.recordType !== 'attachment.capture' || original.operationId !== captureOperationId || original.executionWorkspaceId !== source.execution_workspace_id
          || original.canonicalRoot !== authority.canonicalRoot || original.path !== sourcePath.replaceAll('\\', '/')) throw new HarnessServiceError('conflict', 'The attachment retry changed its original Source or selected path');
        state = JSON.parse(original.stateJson); sourcePath = original.path;
        await verifyObservation(state,sourcePath,authority.rootId,original.readVersion);
        proof = { recordId: captureRecordId, slot: 'source' };
      } else if (source.mode === 'fixed_branch' || source.mode === 'materialized' && !authority.rootId) {
        const read = await authority.client.readBranch({ branchId: source.branch_id!, revision: source.revision!, paths: [sourcePath], includeEntries: true }, signal);
        state = read.entries[0]?.state ?? { kind: 'missing' }; sourcePath = read.entries[0]?.path ?? sourcePath;
        proof = { branchId: source.branch_id!, revision: source.revision!, path: sourcePath };
      } else {
        if (!authority.rootId) throw new HarnessServiceError('unavailable', 'The attachment execution root is unavailable');
        const read = await authority.client.fileCapture({ operationId: captureOperationId, workspaceId: source.workspace_id, rootId: authority.rootId,
          path: sourcePath, store: true, retentionRecordId: captureRecordId, ...(observed ? {expectedReadVersion:observed.target.readVersion}:{}) }, signal);
        if (typeof read.stateJson !== 'string') throw new HarnessServiceError('unavailable', 'The original attachment capture is incomplete');
        state = JSON.parse(read.stateJson); proof = { recordId: captureRecordId, slot: 'source' };
        if (typeof read.path === 'string') sourcePath = read.path;
      }
      if (source.mode === 'fixed_branch') await verifyObservation(state,sourcePath);
      if (state.kind !== 'regular-file') throw new HarnessServiceError(state.kind === 'missing' ? 'not-found' : 'invalid-params', `The selected attachment is ${state.kind}, not a regular file`);
      const file = state;
      const attachment = await inScope(scope, 'attachment-write', async context => {
        // The original capture record survives response loss, failure and restart until
        // the recipient's independent durable object record has committed.
        const object = await transfer(context.client, authority.client, file.objectHash, file.byteLength, proof, `capture-transfer:${ref}`, signal);
        return write(context, scope, { attachment: { ref, filename: path.basename(sourcePath), mimeType: attachmentMimeType(sourcePath), byteLength: file.byteLength },
          contentHash: object.hash, selection: originalSelection, operationId }, [object.ownerId]);
      });
      committed = true;
      return attachment;
    } finally {
      if (authority.kind === 'local' && committed) {
        const record = await authority.client.getRecord(source.workspace_id, captureRecordId);
        if (record && record.state !== 'released') await authority.client.releaseRecord(`release:${captureRecordId}`, source.workspace_id, captureRecordId);
      }
      await authority.release();
    }
  };
  const prepare = async (scope: Scope, selections: readonly AttachmentSelection[], operationId: string, targetThreadId: string, runId?: string, signal?: AbortSignal, frozenSource?: LaunchSource | null): Promise<Attachment[]> => {
    const targetStopped = beginMaterialActivity(scope.workspaceId, targetThreadId);
    try {
      if (!targetThreadId.startsWith('external:')) {
        try { if ((await options.runtime.thread(targetThreadId, signal)).deleted_at_ms != null) throw new HarnessServiceError('not-found', 'The attachment recipient has been deleted'); }
        catch (error) { if (error instanceof HarnessServiceError || !targetThreadId.startsWith('thread:child:')) throw error; }
      }
    const selected = parseAttachmentSelections(selections)!;
    const attachments: Attachment[] = [];
    for (const [index, selection] of selected.entries()) {
      signal?.throwIfAborted();
      try { attachments.push(await capture(scope, selection, operationId, index, runId, signal, frozenSource)); }
      catch (error) { throw new HarnessServiceError(error instanceof HarnessServiceError ? error.harnessCode : 'unavailable', `Attachment ${index + 1}: ${error instanceof Error ? error.message : 'original source unavailable'}`); }
    }
    if (!attachments.length) return attachments;
    // Recipient owns the relation: deleting the original sender cannot revoke delivery.
    await inScope({ ...scope, threadId: targetThreadId }, 'attachment-write', async context => {
      const id = `attachment-delivery:${digest([scope.threadId, operationId, targetThreadId])}`;
      const sources = [];
      for (const attachment of attachments) {
        const record = await context.records.get(attachment.ref);
        if (!record || record.state === 'released') throw new HarnessServiceError('unavailable', 'A prepared attachment was released before delivery');
        sources.push(stored(record));
      }
      const snapshotIds = [...new Set(sources.flatMap(source => (source.materials ?? []).map(material => material.snapshotId)))];
      const payloadJson = JSON.stringify({ fromThreadId: scope.threadId, toThreadId: targetThreadId, attachmentRefs: attachments.map(item => item.ref), operationId,
        ...(snapshotIds.length ? { snapshotIds } : {}) });
      const existing = await context.records.get(id);
      if (existing) {
        if (existing.payloadJson !== payloadJson) throw new HarnessServiceError('conflict', 'The attachment delivery retry changed its original intent');
        if (existing.state !== 'released') return;
      }
      const references = [];
      for (const [index, attachment] of attachments.entries()) {
        const record = await context.records.get(attachment.ref);
        if (!record || record.state === 'released') throw new HarnessServiceError('unavailable', 'A prepared attachment was released before delivery');
        const source = stored(record);
        references.push({ slot: `attachment:${index}`, objectHash: source.contentHash });
        for (const [materialIndex, material] of (source.materials ?? []).entries()) {
          references.push({ slot: `attachment:${index}:material:${materialIndex}:body`, objectHash: material.contentHash });
          if (material.sourceHash) references.push({ slot: `attachment:${index}:material:${materialIndex}:source`, objectHash: material.sourceHash });
        }
      }
      await context.records.put({ operationId: existing ? `retain:${id}:${existing.recordRevision}` : `retain:${id}`, recordId: id, recordType: ATTACHMENT_DELIVERY,
        ...(existing ? { expectedRecordRevision: existing.recordRevision } : {}), state: 'temporary', threadId: targetThreadId, payloadJson, references });
    });
    if (signal?.aborted) { await releaseUnpublished(scope, operationId, targetThreadId, attachments.map(item => item.ref)); signal.throwIfAborted(); }
    return attachments;
    } finally { targetStopped(); }
  };
  const read = async (scope: Scope, ref: string, signal?: AbortSignal): Promise<AttachmentRead> => {
    await capture(scope, { ref }, `read:${ref}`, 0, undefined, signal);
    const value = await inScope(scope, 'attachment-read', context => accessible(context, scope, ref));
    return { attachment: value.attachment, stream: (async function* () {
      let release!: () => void; let ready!: (context: KernelStorageContext) => void; let failed!: (error: unknown) => void;
      const gate = new Promise<KernelStorageContext>((resolve, reject) => { ready = resolve; failed = reject; });
      const lifetime = inScope(scope, 'attachment-read', async context => {
        await accessible(context, scope, ref); ready(context); await new Promise<void>(resolve => { release = resolve; });
      });
      void lifetime.catch(failed);
      const context = await gate;
      let stopReading: (() => void) | undefined;
      try { stopReading = beginMaterialActivity(scope.workspaceId, scope.threadId); yield* chunks(context.client, value.contentHash, value.attachment.byteLength, { recordId: ref, slot: 'source' }, signal); }
      finally { stopReading?.(); release(); await lifetime; }
    })() };
  };
  const preparedPath = async (scope: Scope, ref: string, execution: { runId: string } | { externalConversationId: string }, signal?: AbortSignal) =>
    inScope(scope, 'attachment-write', async context => {
      await capture(scope, { ref }, `path:${ref}`, 0, undefined, signal);
      const value = await accessible(context, scope, ref);
      return context.client.objectViewPrepare({ workspaceId: scope.workspaceId, executionWorkspaceId: scope.workspaceId,
        recordId: ref, slot: 'source', viewId: `attachment-view:${digest([scope.threadId, ref, execution])}`, filename: value.attachment.filename, ...execution }, signal);
    });
  const release = async (scope: Scope, operationId: string, targetThreadId: string) =>
    inScope({ ...scope, threadId: targetThreadId }, 'attachment-write', async context => {
      const id = `attachment-delivery:${digest([scope.threadId, operationId, targetThreadId])}`;
      const record = await context.records.get(id);
      if (record && record.state !== 'released') await context.records.release(`release:${id}`, id);
    });
  const releaseUnpublished = async (scope: Scope, operationId: string, targetThreadId: string, refs: readonly string[]) => {
    // Retrying an already accepted send cannot revoke its original recipient.
    // If Catalog cannot be inspected, leave the fixed preparation recoverable.
    const retained = await options.runtime.materialRetention();
    if (refs.length && retained.attachments.some(edge => edge.threadId === targetThreadId && refs.every(ref => edge.attachments.some(item => item.ref === ref)))) return;
    await release(scope, operationId, targetThreadId);
  };
  const retainPlan = async (plan: MaterialRetention, signal?: AbortSignal) => {
    for (const edge of plan.attachments ?? []) {
      if (!['context', 'report'].includes(edge.holderKind) || !edge.attachments.length || plan.threads.find(thread => thread.threadId === edge.threadId)?.release) continue;
      let sender = edge.sourceThreadId;
      if (!sender && edge.holderKind === 'context') {
        const relation = await options.runtime.child(edge.holderId, signal);
        if (relation.child_thread_id !== edge.threadId || relation.child_branch_id !== edge.branchId) throw new HarnessServiceError('forbidden', 'The attachment context recipient does not match its original child relation');
        sender = relation.parent_thread_id;
      }
      const root = plan.threads.find(thread => thread.threadId === edge.threadId)?.rootThreadId;
      if (!root || !sender) throw new HarnessServiceError('unavailable', 'The retained attachment lineage is unavailable');
      await prepare({ workspaceId: threadMaterialScope(root), threadId: sender }, edge.attachments.map(item => ({ ref: item.ref })),
        `${edge.holderKind}:${edge.holderId}`, edge.threadId, undefined, signal);
    }
  };
  const retainReportReference = async (scope: Scope, ref: string, signal?: AbortSignal) => {
    const plan = await options.runtime.materialRetention(undefined, signal);
    const edges = plan.attachments.filter(edge => edge.holderKind === 'report' && edge.threadId === scope.threadId && edge.attachments.some(item => item.ref === ref));
    if (!edges.length) return false;
    await retainPlan({ ...plan, attachments: edges }, signal);
    return true;
  };
  return {
    scope: scopeFor,
    bindEventAttachmentCapture(capture: NonNullable<typeof eventCapture>) { eventCapture = capture; },
    bindAbsolutePathCapture(capture: NonNullable<typeof absoluteCapture>) { absoluteCapture = capture; },
    bindExternalPathCapture(capture: NonNullable<typeof externalCapture>) { externalCapture = capture; },
    async releaseUnpublished(identity: ThreadIdentity, operationId: string, targetThreadId: string, refs: readonly string[]) {
      await releaseUnpublished(await scopeFor(identity), operationId, targetThreadId, refs);
    },
    async releaseQuery(query: Omit<AttachmentPreparationQuery, 'request'> & { request: { operationId: string; targetThreadId: string } }, signal: AbortSignal) {
      const run = await options.runtime.run(query.runId, signal);
      const scope = await scopeFor({ runtime: 'agent', threadId: run.thread_id, branchId: run.branch_id }, signal);
      const delivery = await inScope(scope, 'attachment-read', context => context.records.get(`attachment-delivery:${digest([scope.threadId, query.request.operationId, query.request.targetThreadId])}`));
      const refs = delivery ? (JSON.parse(delivery.payloadJson) as { attachmentRefs: string[] }).attachmentRefs : [];
      await releaseUnpublished(scope, query.request.operationId, query.request.targetThreadId, refs);
    },
    async readChunk(identity: ThreadIdentity, ref: string, offset = 0, limit = PAGE, signal?: AbortSignal) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new HarnessServiceError('invalid-params', 'Invalid attachment byte range');
      const scope = await scopeFor(identity, signal);
      return nativeActivity(identity, scope, async () => {
      await capture(scope, { ref }, `read:${ref}`, 0, undefined, signal);
      return inScope(scope, 'attachment-read', async context => {
        const value = await accessible(context, scope, ref);
        if (offset > value.attachment.byteLength) throw new HarnessServiceError('invalid-params', 'The attachment offset is past its end');
        const page = await context.client.getBlob(value.contentHash, { recordId: ref, slot: 'source' }, { offset, length: Math.min(PAGE, limit, value.attachment.byteLength - offset), signal });
        return { attachment: value.attachment, bytesBase64: page.bytesBase64, offset, nextOffset: page.nextOffset, eof: page.eof };
      });
      }, signal);
    },
    async retainMaterial(identity: ThreadIdentity, snapshotId: string, signal?: AbortSignal) {
      const scope = await scopeFor(identity, signal);
      return nativeActivity(identity, scope, async () => {
        if (await options.materials.read(scope.workspaceId, snapshotId, { kind: 'thread', owningWorkspaceId: scope.workspaceId, threadId: scope.threadId }, { byteRange: { offset: 0, length: 0 }, ...(signal ? { signal } : {}) })) return;
        await capture(scope, { ref: materialAttachmentRef(snapshotId) }, `source-read:${snapshotId}`, 0, undefined, signal);
      }, signal);
    },
    retain: retainPlan,
    async reconcilePreparations(plan: MaterialRetention, signal?: AbortSignal) {
      const retained = new Set(plan.attachments.flatMap(edge => edge.attachments.map(item => item.ref)));
      const roots = new Map(plan.threads.map(thread => [thread.rootThreadId, thread.threadId]));
      let pending = false;
      for (const [root, threadId] of roots) await inScope({ workspaceId: threadMaterialScope(root), threadId }, 'attachment-write', async context => {
        const deliveries = await context.records.list({ recordType: ATTACHMENT_DELIVERY });
        const released = new Set<string>();
        for (const delivery of deliveries) {
          if (delivery.state === 'released') continue;
          const value = JSON.parse(delivery.payloadJson) as { operationId: string; fromThreadId: string; toThreadId: string; attachmentRefs: string[] };
          if (plan.attachments.some(edge => edge.threadId === value.toThreadId && value.attachmentRefs.every(ref => edge.attachments.some(attachment => attachment.ref === ref)))) continue;
          let operation;
          try { operation = await options.runtime.operation(value.operationId, signal); }
          catch { signal?.throwIfAborted(); continue; }
          if (operation.phase !== 'terminal') { pending = true; continue; }
          if (!['failed', 'cancelled'].includes(operation.outcome ?? '') || operation.effect !== 'none'
            || (await options.runtime.run(operation.run_id, signal)).thread_id !== value.fromThreadId) continue;
          await context.records.release(`failed-delivery:${operation.id}:${delivery.recordId}`, delivery.recordId);
          released.add(delivery.recordId);
        }
        for (const record of await context.records.list({ recordType: ATTACHMENT_FILE })) {
          if (record.state === 'released') continue;
          const value = stored(record);
          if (!value.selection?.path || !value.operationId || retained.has(value.attachment.ref)) continue;
          if (deliveries.some(delivery => delivery.state !== 'released' && !released.has(delivery.recordId) && (JSON.parse(delivery.payloadJson) as { attachmentRefs: string[] }).attachmentRefs.includes(value.attachment.ref))) continue;
          let operation;
          try { operation = await options.runtime.operation(value.operationId, signal); }
          catch { signal?.throwIfAborted(); continue; } // User uploads and external keys are not native Operations.
          if (operation.phase !== 'terminal') { pending = true; continue; }
          if (!['failed', 'cancelled'].includes(operation.outcome ?? '') || operation.effect !== 'none') continue;
          const run = await options.runtime.run(operation.run_id, signal);
          if (run.thread_id !== record.threadId) continue;
          await context.records.release(`failed-preparation:${operation.id}:${record.recordId}`, record.recordId);
        }
      });
      return { pending };
    },
    async reportQuery(query: Omit<AttachmentPreparationQuery, 'request'> & { request: { refs: string[]; sourceThreadId?: string; sourceBranchId?: string } }, signal: AbortSignal) {
      await options.runtime.resourceSnapshot({ runId: query.runId, origin: query.origin, callId: query.callId, resourceCheckpointId: query.resourceCheckpointId }, signal);
      const run = await options.runtime.run(query.runId, signal);
      const scope = await scopeFor({ runtime: 'agent', threadId: run.thread_id, branchId: run.branch_id }, signal);
      let sourceScope: Scope | undefined;
      if (query.request.sourceThreadId && query.request.sourceBranchId) {
        // Only the private kernel bridge can submit this mode, after its actual
        // typed history read. Catalog independently rechecks family-read access.
        await options.runtime.familyRead({ callerThreadId: run.thread_id, threadId: query.request.sourceThreadId, branchId: query.request.sourceBranchId, query: { kind: 'recent', limit: 1 } }, signal);
        sourceScope = await scopeFor({ runtime: 'agent', threadId: query.request.sourceThreadId, branchId: query.request.sourceBranchId }, signal);
        if (sourceScope.workspaceId !== scope.workspaceId) throw new HarnessServiceError('forbidden', 'History attachment transfer requires the original task family');
      }
      const attachments: Attachment[] = [], attachmentAccess: Array<{ ref: string; status: 'ready' | 'unreadable'; reason?: string }> = [];
      for (const ref of query.request.refs) {
        try {
          const values = sourceScope ? await prepare(sourceScope, [{ ref }], `history:${query.runId}:${query.callId}:${ref}`, scope.threadId, undefined, signal)
            : [await capture(scope, { ref }, `report:${ref}`, 0, undefined, signal)];
          attachments.push(...values); attachmentAccess.push({ ref, status: 'ready' });
        } catch (error) { signal.throwIfAborted(); attachmentAccess.push({ ref, status: 'unreadable', reason: error instanceof HarnessServiceError ? error.message : 'The original attachment owner is unavailable' }); }
      }
      return { attachments, attachmentAccess };
    },
    async releaseExternal(conversation: ExternalIdentity) {
      const scope = await externalScope(conversation, undefined, true);
      // The caller has closed the actual harness process. Retire its cache copies
      // before releasing recipient-owned edges; other recipients keep their bytes.
      await inScope(scope, 'attachment-write', async context => {
        for (const record of await context.records.list({ recordType: ATTACHMENT_FILE })) {
          if (record.state === 'released') continue;
          let value: StoredAttachment;
          try { value = await accessible(context, scope, record.recordId); } catch { continue; }
          await context.client.objectViewRelease({ workspaceId: scope.workspaceId,
            viewId: `attachment-view:${digest([scope.threadId, value.attachment.ref, { externalConversationId: conversation.id }])}` });
        }
      });
      const actorStorage: WorkspaceWorkingStateRootAccess = { withBranchStore: (workspaceId, purpose, consume, mode) => options.storage.withBranchStore(workspaceId, purpose, consume, mode, { threadId: scope.threadId }) };
      await createMaterialLifecycle(actorStorage).releaseThreadMaterials(scope.workspaceId, scope.threadId);
    },
    async upload(identity: ThreadIdentity, request: AttachmentUpload, source: AsyncIterable<Uint8Array>, signal?: AbortSignal) { const scope = await scopeFor(identity, signal); return nativeActivity(identity, scope, () => upload(scope, request, source, signal), signal); },
    async read(identity: ThreadIdentity, ref: string, signal?: AbortSignal) { if (ref.startsWith('file:')) { const selected = await resolveFileReference(references,ref,signal); if (selected.kind !== 'attachment') throw new HarnessServiceError('invalid-params','Read this file observation through its original source'); ref = selected.reference; } const scope = await scopeFor(identity, signal); return nativeActivity(identity, scope, () => read(scope, ref, signal), signal); },
    async prepare(identity: ThreadIdentity, selections: readonly AttachmentSelection[], operationId: string, targetThreadId = identity.threadId, signal?: AbortSignal) {
      const thread = await options.runtime.thread(identity.threadId, signal);
      const branch = thread.branches.find(branch => branch.branch_id === identity.branchId);
      const scope = await scopeFor(identity, signal);
      return nativeActivity(identity, scope, () => prepare(scope, selections, operationId, targetThreadId, branch?.active_run_id ?? branch?.latest_run?.id, signal), signal);
    },
    async prepareForRun(authority: {runId:string;threadId:string;operationId:string;source:LaunchSource | null}, ref: string, signal?: AbortSignal) {
      const run = await options.runtime.run(authority.runId,signal);
      if (run.thread_id !== authority.threadId) throw new HarnessServiceError('forbidden','The file observation belongs to another invocation');
      const identity = {runtime:'agent' as const,threadId:run.thread_id,branchId:run.branch_id};
      const scope = await scopeFor(identity,signal);
      return nativeActivity(identity,scope,() => prepare(scope,[{ref}],`file-reader:${authority.operationId}:${ref}`,scope.threadId,authority.runId,signal,authority.source),signal);
    },
    async prepareQuery(query: AttachmentPreparationQuery, signal: AbortSignal) {
      const frozen = await options.runtime.resourceSnapshot({ runId: query.runId, origin: query.origin, callId: query.callId, resourceCheckpointId: query.resourceCheckpointId }, signal);
      const run = await options.runtime.run(query.runId, signal);
      if (query.request.attachments.some(item => typeof item.ref === 'string' && !item.ref.startsWith('attachment:') && !item.ref.startsWith('file:') && !parseWebSourceCitation(item.ref))) throw new HarnessServiceError('invalid-params', 'Use the canonical attachment reference returned by the original file or document tool');
      const identity = { runtime: 'agent' as const, threadId: run.thread_id, branchId: run.branch_id }, scope = await scopeFor(identity, signal);
      try { return await nativeActivity(identity, scope, () => prepare(scope, query.request.attachments,
        query.request.operationId, query.request.targetThreadId, query.runId, signal, frozen.source), signal); }
      finally { options.requestMaintenance?.(); }
    },
    async path(identity: ThreadIdentity, ref: string, runId: string, signal?: AbortSignal, frozenSource?: LaunchSource | null) {
      const run = await options.runtime.run(runId, signal);
      if (run.thread_id !== identity.threadId || run.branch_id !== identity.branchId) throw new HarnessServiceError('forbidden', 'The attachment execution belongs to another Thread');
      const launch = await options.runtime.launch(runId, signal);
      const source = frozenSource ?? launch?.selection.source;
      const scope = await scopeFor(identity, signal);
      return nativeActivity(identity, scope, async () => {
      await capture(scope, { ref }, `path:${ref}`, 0, undefined, signal);
      if (source?.resource_owner.kind === 'managed_host') return inScope(scope, 'attachment-read', async context => {
        const value = await accessible(context, scope, ref);
        const stopReading = beginMaterialActivity(scope.workspaceId, scope.threadId);
        try { return await prepareManagedAttachmentPath({ runtime: options.runtime, runId, source, attachment: value.attachment, contentHash: value.contentHash, signal,
          readPage: (offset, length, view = {}) => context.client.getBlob(view.rangeObject ?? value.contentHash, { recordId: ref, slot: 'source' },
            { offset, length, ...(view.representation ? { representation: view.representation } : {}), ...(view.rangeObject ? { rangeRoot: value.contentHash } : {}), signal }) }); }
        finally { stopReading(); }
      });
      return preparedPath(scope, ref, { runId }, signal);
      }, signal);
    },
    async prepareExternal(conversation: ExternalIdentity, key: string, selections: readonly AttachmentSelection[], signal?: AbortSignal) {
      const scope = await externalScope(conversation, signal);
      const resolved: AttachmentSelection[] = [];
      for (const [index, selection] of (parseAttachmentSelections(selections) ?? []).entries()) {
        if (typeof selection.ref === 'string') { resolved.push(selection); continue; }
        const captureKey = digest([key, index]);
        const ref = `attachment:${digest([scope.threadId, 'external-path', key, index])}`;
        const cached = await inScope(scope, 'attachment-read', async context => {
          const record = await context.records.get(ref); return record && record.state !== 'released' ? stored(record) : null;
        });
        if (cached) {
          if (JSON.stringify(cached.selection) !== JSON.stringify(selection)) throw new HarnessServiceError('conflict', 'The external attachment retry changed its original path');
          resolved.push({ ref }); continue;
        }
        if (!externalCapture) throw new HarnessServiceError('unavailable', 'This external Agent cannot capture its actual execution files');
        const original = await externalCapture(conversation, captureKey, selection.path, signal);
        let committed = false;
        try {
          await inScope(scope, 'attachment-write', async context => {
            const object = original.contentHash.startsWith('ranges-') ? await copyRangeContent(context.client, original.contentHash, original.byteLength, original.readPage, signal, `external-capture:${ref}`)
              : await context.client.putBlobStream(original.chunks, { operationId: `external-capture:${ref}`, byteLength: original.byteLength, expectedHash: original.contentHash }, signal);
            await write(context, scope, { attachment: { ref, filename: filename(original.filename), mimeType: original.mimeType, byteLength: original.byteLength }, contentHash: object.hash, selection }, [object.ownerId]);
          });
          committed = true;
        } finally { await original.release(committed); }
        resolved.push({ ref });
      }
      return prepare(scope, resolved, `external:${key}`, conversation.id, undefined, signal);
    },
    async externalPath(conversation: ExternalIdentity, ref: string, signal?: AbortSignal) { return preparedPath(await externalScope(conversation, signal), ref, { externalConversationId: conversation.id }, signal); },
    async readExternal(conversation: ExternalIdentity, ref: string, signal?: AbortSignal) { return read(await externalScope(conversation, signal), ref, signal); },
    async uploadExternal(conversation: ExternalIdentity, request: AttachmentUpload, source: AsyncIterable<Uint8Array>, signal?: AbortSignal) { return upload(await externalScope(conversation, signal), request, source, signal); },
  };
}
export type ThreadAttachmentOwner = ReturnType<typeof createThreadAttachments>;
