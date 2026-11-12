/** Source-bound attachment imports use Storage objects, records and single-file
 * views. No workspace tree, experiment material or target Catalog Run is made. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Readable } from 'node:stream';
import type { Attachment } from '@varin/protocol';
import type { KernelClient, KernelScopedClient } from '../kernel/kernel-client.js';
import type { KernelObjectView, KernelPutBlobResult, KernelRecordResult } from '../kernel/protocol.generated.js';
import { SourceAdmissionError } from '../kernel/source-admission-error.js';
import type { ManagedSourceAddress, ManagedSourceCleanupScope, ManagedSourceLocalScope } from './managed-remote-types.js';

export interface ManagedAttachmentRequest extends ManagedSourceAddress { operationId: string; attachment: Attachment; contentHash: string }
export interface ManagedAttachmentObjectRequest extends ManagedSourceAddress {
  operationId: string; ref: string; contentHash: string; objectHash: string; byteLength: number;
}
const recordType = 'attachment.import';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validHash = (value: string) => /^(?:ranges-)?sha256-[0-9a-f]{64}$/.test(value);
const scopeKey = (scope: Pick<ManagedSourceLocalScope, 'principal' | 'coordinatorHostId' | 'authorityId' | 'resourceEpoch'>) =>
  JSON.stringify([scope.principal.principalId, scope.coordinatorHostId, scope.authorityId, scope.resourceEpoch]);
const identity = (scope: ManagedSourceCleanupScope | ManagedSourceLocalScope, operationId: string): {
  principalId: string; coordinatorHostId: string; authorityId: string; threadId: string;
  runId?: string; externalTransportId?: string; operationId: string;
} => {
  if (scope.scope.kind === 'source_read' || !operationId) throw new SourceAdmissionError('source_authority_denied');
  return { principalId: scope.principal.principalId, coordinatorHostId: scope.coordinatorHostId, authorityId: scope.authorityId,
    threadId: scope.scope.kind === 'external' ? scope.scope.conversationId : scope.scope.threadId, ...(scope.scope.kind === 'run' ? {runId:scope.scope.runId} : {externalTransportId:scope.scope.transportId}), operationId };
};
const addresses = (owner: ReturnType<typeof identity>) => {
  const id = digest(owner);
  return { recordId: `attachment-import:${id}`, viewId: `attachment-import-view:${id}` };
};
type Intent = ReturnType<typeof identity> & { ref: string; attachment: Attachment; contentHash: string };

export function createManagedAttachmentImport(kernel: KernelClient) {
  const queues = new Map<string, Promise<unknown>>();
  const flights = new Map<string, { closing: boolean; pending: Set<Promise<unknown>>; controller: AbortController }>();
  const withWriter = async <T>(scope: ManagedSourceCleanupScope | ManagedSourceLocalScope,
    action: (client: KernelScopedClient) => Promise<T>, operationId?: string): Promise<T> => {
    if (scope.scope.kind === 'source_read') throw new SourceAdmissionError('source_authority_denied');
    const grant = await kernel.issueGrant({ grantId: `attachment-import:${randomUUID()}`,
      owningWorkspace: scope.source.workspace_id, executionWorkspace: scope.source.execution_workspace_id,
      threadId: scope.scope.kind === 'external' ? scope.scope.conversationId : scope.scope.threadId, ...(scope.scope.kind === 'run' ? {runId:scope.scope.runId} : {}),
      // External imports belong to the already admitted transport, not a native
      // operation/Run. The per-attachment key stays in its original record intent.
      ...(scope.scope.kind === 'external'
        ? { externalTransportId: scope.scope.transportId, operationId: scope.scope.transportId }
        : operationId ? { operationId: addresses(identity(scope, operationId)).recordId } : {}),
      capabilities: ['storage.read', 'storage.write', 'storage.maintenance'], pathScopes: [] });
    try { return await action(kernel.scoped(grant)); }
    finally { await kernel.retireGrant(grant.grantId); }
  };
  const run = <T>(scope: ManagedSourceLocalScope, operationId: string, signal: AbortSignal | undefined,
    action: (client: KernelScopedClient, signal: AbortSignal) => Promise<T>): Promise<T> => {
    const key = scopeKey(scope);
    let flight = flights.get(key);
    if (!flight) { flight = { closing: false, pending: new Set(), controller: new AbortController() }; flights.set(key, flight); }
    if (flight.closing) throw new SourceAdmissionError('source_authority_denied');
    const combined = signal ? AbortSignal.any([signal, flight.controller.signal]) : flight.controller.signal;
    const queueKey = `${key}:${operationId}`;
    const before = queues.get(queueKey) ?? Promise.resolve();
    const work = before.catch(() => undefined).then(() => withWriter(scope, client => { combined.throwIfAborted(); return action(client, combined); }, operationId));
    queues.set(queueKey, work);
    void work.finally(() => { if (queues.get(queueKey) === work) queues.delete(queueKey); }).catch(() => undefined);
    flight.pending.add(work);
    void work.finally(() => flight.pending.delete(work)).catch(() => undefined);
    return work;
  };
  const intent = async (client: KernelScopedClient, scope: ManagedSourceLocalScope, operationId: string, signal: AbortSignal): Promise<Intent> => {
    const expected = identity(scope, operationId);
    const record = await client.getRecord(scope.source.workspace_id, addresses(expected).recordId, signal);
    if (!record || record.recordType !== recordType || record.state !== 'preparing') throw new SourceAdmissionError('source_changed');
    const value = JSON.parse(record.payloadJson) as Intent;
    for (const [key, item] of Object.entries(expected)) if (value[key as keyof Intent] !== item) throw new SourceAdmissionError('source_authority_denied');
    return value;
  };
  return {
    begin(scope: ManagedSourceLocalScope, request: ManagedAttachmentRequest, signal?: AbortSignal): Promise<{ retained: true; complete: boolean }> {
      return run(scope, request.operationId, signal, async (client, signal) => {
        const owner = identity(scope, request.operationId), location = addresses(owner);
        const attachment = request.attachment;
        if (!attachment || typeof attachment.ref !== 'string' || !attachment.ref.startsWith('attachment:') || attachment.ref.length <= 11
          || typeof attachment.filename !== 'string' || !attachment.filename || /[/\\\0:]/.test(attachment.filename)
          || ['.', '..'].includes(attachment.filename) || typeof attachment.mimeType !== 'string' || !attachment.mimeType
          || !Number.isSafeInteger(attachment.byteLength) || attachment.byteLength < 0 || !validHash(request.contentHash))
          throw new Error('Invalid original attachment identity');
        const payload: Intent = { ...owner, ref: attachment.ref, attachment, contentHash: request.contentHash };
        const previous = await client.getRecord(scope.source.workspace_id, location.recordId, signal);
        if (previous) {
          if (previous.recordType !== recordType || previous.state !== 'preparing' || !isDeepStrictEqual(JSON.parse(previous.payloadJson), payload))
            throw new Error('Attachment import retry changed its original content or recipient');
        } else {
          await client.putRecord({ operationId: `begin:${location.recordId}`, workspaceId: scope.source.workspace_id,
            recordId: location.recordId, recordType, state: 'preparing', threadId: owner.threadId, ...(owner.runId ? {runId:owner.runId} : {}),
            payloadJson: JSON.stringify(payload), ownerIds: [], references: [] }, signal);
        }
        const root = await client.getRecord(scope.source.workspace_id, `${location.recordId}:${request.contentHash}`, signal);
        const complete = !!root && root.recordType === recordType && root.state === 'ready'
          && JSON.parse(root.payloadJson).byteLength === attachment.byteLength
          && root.references.some(reference => reference.slot === 'source' && reference.objectHash === request.contentHash);
        return { retained: true, complete };
      });
    },
    put(scope: ManagedSourceLocalScope, request: ManagedAttachmentObjectRequest, body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<KernelPutBlobResult> {
      return run(scope, request.operationId, signal, async (client, signal) => {
        const original = await intent(client, scope, request.operationId, signal);
        if (original.ref !== request.ref || original.contentHash !== request.contentHash || !validHash(request.objectHash)
          || request.objectHash !== original.contentHash && (!original.contentHash.startsWith('ranges-') || !request.objectHash.startsWith('sha256-'))
          || !Number.isSafeInteger(request.byteLength) || request.byteLength < 0)
          throw new Error('Attachment import object differs from its original intent');
        const id = `${addresses(identity(scope, request.operationId)).recordId}:${request.objectHash}`;
        const chunks = (async function* () {
          const incoming = Readable.from(body, { signal });
          try { for await (const bytes of incoming) yield bytes as Uint8Array; }
          finally { incoming.destroy(); }
        })();
        const previous = await client.getRecord(scope.source.workspace_id, id, signal);
        if (previous) {
          const payload = JSON.parse(previous.payloadJson);
          if (previous.recordType !== recordType || previous.state !== 'ready' || payload.contentHash !== original.contentHash
            || payload.objectHash !== request.objectHash || payload.wireByteLength !== request.byteLength)
            throw new Error('Attachment import retry changed its original object');
          const hash = createHash('sha256'); let length = 0;
          for await (const bytes of chunks) { signal.throwIfAborted(); length += bytes.byteLength;
            if (length > request.byteLength) throw new Error('Attachment import exceeded its original byte length');
            hash.update(bytes); }
          if (length !== request.byteLength || `sha256-${hash.digest('hex')}` !== request.objectHash.replace(/^ranges-/, ''))
            throw new Error('Attachment import retry changed its original bytes');
          return { hash: request.objectHash, byteLength: payload.byteLength, ownerId: '' };
        }
        const blob = await client.putBlobStream(chunks, { operationId: `upload:${id}:${randomUUID()}`, expectedHash: request.objectHash, byteLength: request.byteLength }, signal);
        await client.putRecord({ operationId: `retain:${id}`, workspaceId: scope.source.workspace_id, recordId: id, recordType,
          state: 'ready', threadId: original.threadId, ...(original.runId ? {runId:original.runId} : {}),
          payloadJson: JSON.stringify({ ...original, objectHash: blob.hash, byteLength: blob.byteLength, wireByteLength: request.byteLength }),
          ownerIds: [blob.ownerId], references: [{ slot: 'source', objectHash: blob.hash }] }, signal);
        return { hash: blob.hash, byteLength: blob.byteLength, ownerId: '' };
      });
    },
    path(scope: ManagedSourceLocalScope, request: ManagedAttachmentRequest, signal?: AbortSignal): Promise<KernelObjectView> {
      return run(scope, request.operationId, signal, async (client, signal) => {
        const original = await intent(client, scope, request.operationId, signal);
        if (!isDeepStrictEqual(original.attachment, request.attachment) || original.contentHash !== request.contentHash)
          throw new Error('Attachment path differs from its original import');
        const location = addresses(identity(scope, request.operationId));
        const recordId = `${location.recordId}:${original.contentHash}`;
        const record = await client.getRecord(scope.source.workspace_id, recordId, signal);
        if (!record || record.recordType !== recordType || record.state !== 'ready'
          || JSON.parse(record.payloadJson).byteLength !== original.attachment.byteLength)
          throw new Error('Original attachment import is incomplete');
        return client.objectViewPrepare({ workspaceId: scope.source.workspace_id, executionWorkspaceId: scope.source.execution_workspace_id,
          recordId, slot: 'source', viewId: location.viewId, filename: original.attachment.filename, ...(original.runId ? {runId:original.runId} : {externalConversationId:original.threadId}) }, signal);
      });
    },
    async drain(scope: ManagedSourceCleanupScope): Promise<void> {
      const key = scopeKey(scope);
      let flight = flights.get(key);
      if (!flight) { flight = { closing: true, pending: new Set(), controller: new AbortController() }; flights.set(key, flight); }
      flight.closing = true; flight.controller.abort();
      await Promise.allSettled([...flight.pending]);
    },
    /** Called after native retirement. The view owner independently refuses
     * deletion while any original process still lacks a confirmed exit. */
    async cleanup(scope: ManagedSourceCleanupScope): Promise<void> {
      if (scope.scope.kind === 'source_read') return;
      const runId = scope.scope.kind === 'run' ? scope.scope.runId : undefined;
      const threadId=scope.scope.kind==='external'?scope.scope.conversationId:scope.scope.threadId;
      await withWriter(scope, async client => {
        const owned: KernelRecordResult[] = [];
        let cursor: number | undefined;
        do {
          const page = await client.listRecords({ workspaceId: scope.source.workspace_id, recordType,
            threadId, ...(runId ? {runId} : {}), ...(cursor === undefined ? {} : { cursor }) });
          owned.push(...page.records.filter(record => {
            const value = JSON.parse(record.payloadJson);
            return value.principalId === scope.principal.principalId && value.coordinatorHostId === scope.coordinatorHostId && value.authorityId === scope.authorityId;
          }));
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        for (const record of owned.filter(record => record.state === 'preparing')) {
          const original = JSON.parse(record.payloadJson) as Intent;
          await client.objectViewRelease({ workspaceId: scope.source.workspace_id, viewId: addresses(identity(scope, original.operationId)).viewId });
        }
        for (const record of owned) await client.releaseRecord(`release:${record.recordId}`, scope.source.workspace_id, record.recordId);
      });
    },
  };
}
