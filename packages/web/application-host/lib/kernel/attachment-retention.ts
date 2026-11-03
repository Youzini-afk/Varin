import path from 'node:path';
import { parseAttachmentSelections } from '@varin/protocol';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { withManagedAttachmentResult } from './managed-attachment-result.js';
import type { KernelClient } from './kernel-client.js';
import type { MaterialRetention } from './protocol.generated.js';

/** Catalog has proven these Threads have no surviving execution. Recipients must
 * first retain independent material records; source cleanup never follows UI close. */
export async function releaseDeletedAttachmentSources(kernel: KernelClient, runtime: AgentRuntimeClient, plan: MaterialRetention, signal?: AbortSignal): Promise<{ pending: boolean }> {
  const deleted = new Set(plan.threads.filter(thread => thread.release).map(thread => thread.threadId));
  let pending = false;
  const retained = new Set(plan.attachments.flatMap(edge => edge.attachments.map(item => item.ref)));
  const discovery = await kernel.issueGrant({ grantId: `attachment-discovery:${randomUUID()}`, owningWorkspace: null, executionWorkspace: null,
    capabilities: ['storage.read', 'storage.maintenance'], pathScopes: [] }, signal);
  try {
    for (const recordType of ['attachment.capture', 'attachment.file']) {
      const { workspaceIds } = await kernel.recordWorkspaces({ recordType }, discovery, signal);
      for (const workspaceId of workspaceIds) {
        // This namespace is reconciled by the original material lifecycle. A live
        // recipient can still require its descriptor after the sender is deleted.
        if (workspaceId.startsWith('thread-materials:')) continue;
        signal?.throwIfAborted();
        const grant = await kernel.issueGrant({ grantId: `attachment-source-release:${randomUUID()}`,
          owningWorkspace: workspaceId, executionWorkspace: workspaceId, capabilities: ['storage.read', 'storage.maintenance'], pathScopes: [] }, signal);
        try {
          const actor = kernel.scoped(grant);
          let cursor: number | undefined;
          const records: Array<{ recordId: string; threadId: string }> = [];
          do {
            const page = await actor.listRecords({ workspaceId, recordType, ...(cursor === undefined ? {} : { cursor }) }, signal);
            for (const record of page.records) {
              if (!record.threadId || record.recordType !== recordType || record.state === 'released') continue;
              const payload = JSON.parse(record.payloadJson) as { operationId?: string; managedSource?: boolean; captureId?: string; path?: string; canonicalRoot?: string };
              // A resource Host can also coordinate its own Threads. Equal
              // threadIds do not authorize cleanup of another coordinator's data.
              if (payload.managedSource !== false || payload.captureId || record.recordId.startsWith('attachment-managed-capture:') || record.recordId.startsWith('attachment.capture:')) continue;
              if (deleted.has(record.threadId)) { records.push({ recordId: record.recordId, threadId: record.threadId }); continue; }
              if (recordType !== 'attachment.capture') continue;
              const match = /^attachment-preparation:([a-zA-Z0-9_-]+):(?:(\d+)|ref:([a-zA-Z0-9_-]+))$/.exec(payload.operationId ?? '');
              if (!match) continue;
              const operationId = Buffer.from(match[1]!, 'base64url').toString('utf8');
              if (Buffer.from(operationId).toString('base64url') !== match[1]) continue;
              let operation;
              try { operation = await runtime.operation(operationId, signal); } catch { signal?.throwIfAborted(); continue; }
              if (operation.phase !== 'terminal') { pending = true; continue; }
              if (!['failed', 'cancelled'].includes(operation.outcome ?? '') || operation.effect !== 'none') continue;
              const call = (operation.intent as { call?: { arguments?: { attachments?: unknown } } }).call;
              let selections;
              try { selections = parseAttachmentSelections(call?.arguments?.attachments); } catch { continue; }
              const encodedRef = match[3] ? Buffer.from(match[3], 'base64url').toString('utf8') : undefined;
              if (encodedRef && Buffer.from(encodedRef).toString('base64url') !== match[3]) continue;
              const index = encodedRef ? selections?.findIndex((_selection, index) => `attachment:${createHash('sha256').update(JSON.stringify([record.threadId, operationId, index])).digest('hex')}` === encodedRef) : Number(match[2]);
              if (index === undefined || index < 0 || !Number.isSafeInteger(index) || !selections?.[index]?.path) continue;
              const ref = encodedRef ?? `attachment:${createHash('sha256').update(JSON.stringify([record.threadId, operationId, index])).digest('hex')}`;
              if (retained.has(ref) || !payload.canonicalRoot || !payload.path || path.resolve(payload.canonicalRoot, selections[index]!.path!) !== path.resolve(payload.canonicalRoot, payload.path)) continue;
              if ((await runtime.run(operation.run_id, signal)).thread_id === record.threadId) records.push({ recordId: record.recordId, threadId: record.threadId });
            }
            cursor = page.nextCursor ?? undefined;
          } while (cursor !== undefined);
          for (const record of records) await actor.releaseRecord(`attachment-retire:${record.threadId}:${record.recordId}`, workspaceId, record.recordId, signal);
        } finally { await kernel.revokeGrant(grant.grantId); }
      }
    }
  } finally { await kernel.revokeGrant(discovery.grantId); }
  for (const preparation of plan.attachmentPreparations ?? []) {
    if (preparation.source.resource_owner.kind !== 'managed_host') continue;
    const selections = preparation.attachments.filter(attachment => !retained.has(attachment.ref));
    if (!selections.length) continue;
    try {
      await withManagedAttachmentResult(runtime, preparation, `attachment-discard:${preparation.operationId}`, async ({ client, binding }) => {
        for (const selection of selections) await client.service({ coordinatorHostId: runtime.coordinatorHostId,
          authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch,
          requestId: `attachment-discard:${preparation.operationId}:${selection.ref}`,
          operation: { kind: 'attachment_discard', operationId: preparation.operationId, ...selection } }, signal);
      }, signal);
    } catch { signal?.throwIfAborted(); pending = true; }
    // The resource owner fences the exact capture writer. A terminal Catalog
    // outcome alone must never retire unrelated live work in the same Run.
  }
  const groups = new Map<string, MaterialRetention['attachmentSources']>();
  for (const original of plan.attachmentSources ?? []) {
    if (!deleted.has(original.threadId) || original.source.resource_owner.kind !== 'managed_host') continue;
    const key = JSON.stringify([original.threadId, original.source.resource_owner, original.source.workspace_id]);
    const group = groups.get(key) ?? []; group.push(original); groups.set(key, group);
  }
  for (const originals of groups.values()) {
    let drained = true;
    for (const original of originals) {
      try {
        if (original.source.resource_owner.kind !== 'managed_host') throw new Error('Original managed owner changed');
        const client = await runtime.managedSource(original.source.resource_owner, signal);
        const stopped = await client.releaseScope({ coordinatorHostId: runtime.coordinatorHostId, threadId: original.threadId, runId: original.runId, mode: 'retire' }, signal) as { pendingAuthorities?: unknown };
        if (!Array.isArray(stopped.pendingAuthorities) || stopped.pendingAuthorities.length) drained = false;
      } catch { signal?.throwIfAborted(); drained = false; }
    }
    // Thread-owned records have no runId. All writers in this actual Source
    // workspace must stop before any one result authority can remove them.
    if (!drained) { pending = true; continue; }
    for (const original of originals) {
      try {
        await withManagedAttachmentResult(runtime, original, `attachment-cleanup:${original.runId}`, async ({ client, binding }) => {
          await client.service({ coordinatorHostId: runtime.coordinatorHostId, authorityId: binding.authorityId,
            resourceEpoch: binding.resourceEpoch, requestId: `attachment-cleanup:${original.runId}`, operation: { kind: 'attachment_cleanup' } }, signal);
        }, signal);
      } catch { signal?.throwIfAborted(); pending = true; }
    }
  }
  // Offline/revoked targets remain represented by the Catalog projection for a
  // later cleanup pass. Never treat coordinator observation loss as remote stop.
  return { pending };
}
