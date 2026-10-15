/** Recall/retire the original schedule receipt. Never re-admit a Source or dispatch assets. */
import { isDeepStrictEqual } from 'node:util';
import type { ManagedSourceClient } from '../harness/managed-remote-client.js';
import type { ManagedSourceReceipt } from '../harness/managed-remote-types.js';
import type { LaunchSource } from './protocol.generated.js';

export interface ManagedScheduleReceiptQuery {
  kind: 'schedule_receipt';
  phase: 'observe' | 'release';
  source: LaunchSource;
  runId: string;
  threadId: string;
  operationId: string;
}
export async function recallManagedScheduleReceipt(client: Pick<ManagedSourceClient, 'inspectScope' | 'observe' | 'releaseReceipt'>,
  coordinatorHostId: string, query: ManagedScheduleReceiptQuery): Promise<ManagedSourceReceipt | { operationId: string; released: true } | null> {
  if (query.source.resource_owner.kind !== 'managed_host' || !query.runId || !query.threadId || !query.operationId
    || !['observe', 'release'].includes(query.phase)) throw new Error('Original schedule receipt address is incomplete');
  const authorities = await client.inspectScope({ coordinatorHostId, runId: query.runId, threadId: query.threadId });
  let found: ManagedSourceReceipt | undefined;
  let released = false;
  const failures: unknown[] = [];
  for (const authority of authorities) {
    if (authority.purpose !== 'source' || !isDeepStrictEqual(authority.binding.source, query.source)) continue;
    if (authority.scope.kind !== 'run' || authority.scope.runId !== query.runId || authority.scope.threadId !== query.threadId)
      throw new Error('Original schedule receipt scope changed');
    const address = { coordinatorHostId, authorityId: authority.binding.authorityId,
      resourceEpoch: authority.binding.resourceEpoch, operationId: query.operationId };
    // A Run can have several Source views. Storage rejects every non-owning
    // authority; only an exact original operation/grant receipt is consumable.
    let receipt;
    try { receipt = await client[query.phase === 'release' ? 'releaseReceipt' : 'observe'](address); }
    catch (error) { failures.push(error); continue; }
    if (receipt.operationId !== query.operationId || receipt.resourceEpoch !== address.resourceEpoch
      || !isDeepStrictEqual(receipt.executionOwner, authority.binding.executionOwner)) throw new Error('Original schedule receipt owner changed');
    if (query.phase === 'release') {
      if (!('released' in receipt) || receipt.released !== true) throw new Error('Original schedule receipt release is pending');
      released = true;
    } else {
      if (!('accepted' in receipt) || typeof receipt.executorStopped !== 'boolean') throw new Error('Original schedule receipt is malformed');
      if (!receipt.accepted) continue;
      if (found) throw new Error('Original schedule receipt has multiple resource owners');
      found = receipt;
    }
  }
  if (query.phase === 'release' && released) return { operationId: query.operationId, released: true };
  if (found) return found;
  if (failures.length) throw new AggregateError(failures, 'Original schedule receipt remains unavailable');
  // No accepted Source means no B receipt to collect (e.g. pre-admission failure).
  return query.phase === 'release' ? { operationId: query.operationId, released: true } : null;
}
