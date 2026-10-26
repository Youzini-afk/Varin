/** Coalesce active captures, retaining their own native grant until the actual
 * worker drains. No baseline cache, content store or durable job lives in TS. */
import { randomUUID } from 'node:crypto';
import { captureStableSourceBaseline, type StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';
import { waitWithSignal } from '../cancellation.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from './storage-adapter.js';
import type { KernelClient, KernelGrantHandle } from './kernel-client.js';
import type { ChildPreparationProgress, ChildSourceProvenance, DelegatedExecution, ChildSourceHandoff } from './protocol.generated.js';

export type ChildPhysicalCapture = (input: { child: DelegatedExecution; directory: string; rootId: string;
  captureWorkspaceId: string; signal: AbortSignal; onProgress?: ((value: ChildPreparationProgress) => void) | undefined }) => Promise<ChildSourceProvenance>;

export function createChildPhysicalCapture(kernel: KernelClient, storage: KernelStorageAdapter, owners: StableSourcePreparationOwners): ChildPhysicalCapture {
  const capture = createPhysicalSourceCapture(kernel, storage, owners);
  return input => {
    const source = input.child.source;
    const handoff = source && source.kind !== 'absent' ? source.handoff : null;
    if (!handoff) return Promise.reject(new Error('Physical capture requires its admitted source handoff'));
    const { child, ...rest } = input;
    return capture({ ...rest, handoff, ownerId: child.child_thread_id, executionId: child.execution_id, selectionIdentity: child.launch });
  };
}

/** Coalesces the actual file-source observation independently of the Agent execution backend. */
export function createPhysicalSourceCapture(kernel: KernelClient, storage: KernelStorageAdapter, owners: StableSourcePreparationOwners) {
  type Job = { controller: AbortController; users: Set<(progress: ChildPreparationProgress) => void>;
    consumers: Set<Promise<unknown>>;
    progress?: ChildPreparationProgress; grant?: KernelGrantHandle; store?: KernelWorkingStateRootStore;
    branchId: string; work: Promise<Awaited<ReturnType<typeof captureStableSourceBaseline>>>; cleanup?: Promise<void> };
  const active = new Map<string, Job>();
  return async (input: Omit<Parameters<ChildPhysicalCapture>[0], 'child'> & { handoff: ChildSourceHandoff; ownerId: string; executionId: string; selectionIdentity: unknown }) => {
    const handoff = input.handoff;
    const token = await owners.documents.beginCapture(input.captureWorkspaceId, {}, input.signal);
    // beginCapture flushes original Documents observations. Include the exact
    // frozen resource selection; a later write/observer generation cannot join.
    const key = JSON.stringify([handoff.source.resource_owner, input.rootId, input.directory,
      handoff.source.workspace_id, handoff.source.execution_workspace_id, input.selectionIdentity,
      token.epoch, token.mutationRevision, token.writerRevision, token.watchRevision, token.watch]);
    if (input.signal.aborted) { owners.documents.discardCapture(token); input.signal.throwIfAborted(); }
    let job = active.get(key);
    if (!job) {
      const controller = new AbortController();
      job = { controller, users: new Set(), consumers: new Set(), branchId: `source-capture:${randomUUID()}`, work: undefined! };
      const current = job;
      active.set(key, current);
      current.work = (async () => {
        const grant = await kernel.issueGrant({ grantId: current.branchId, threadId: input.ownerId,
          owningWorkspace: handoff.source.workspace_id, executionWorkspace: handoff.source.execution_workspace_id,
          capabilities: ['storage.read', 'storage.write'], pathScopes: [''] }, controller.signal);
        current.grant = grant;
        current.store = new KernelWorkingStateRootStore(await storage.contextFromSourceGrant({ grant,
          owningWorkspaceId: handoff.source.workspace_id, executionWorkspaceId: handoff.source.execution_workspace_id,
          rootId: input.rootId, canonicalRoot: input.directory }));
        let phase: ChildPreparationProgress['phase'] = 'inventory';
        const progress = (value: ChildPreparationProgress) => {
          current.progress = value;
          for (const listener of current.users) listener(value);
        };
        return captureStableSourceBaseline({ store: current.store, workspaceId: handoff.source.workspace_id,
          captureWorkspaceId: input.captureWorkspaceId, directory: input.directory, branchId: current.branchId,
          captureScopes: [], content: { mode: 'saved-files' }, signal: controller.signal,
          onPhase: value => { phase = value; progress({ phase }); },
          onDiscovered: completed => progress({ phase, completed }),
          onProgress: (completed, total) => progress({ phase, completed, total }) }, owners);
      })().finally(() => { if (active.get(key) === current) active.delete(key); });
      void current.work.catch(() => undefined);
    } else input.onProgress?.({ phase: 'source_wait' });
    const listener = (value: ChildPreparationProgress) => input.onProgress?.(value);
    job.users.add(listener);
    if (job.progress) listener(job.progress);
    const current = job;
    const leave = async () => {
      if (!current.users.delete(listener) || current.users.size) return;
      current.controller.abort();
      current.cleanup ??= (async () => {
        await current.work.catch(() => undefined); // actual capture stop, not reader abort
        await Promise.allSettled([...current.consumers]);
        try { await current.store?.deleteBranch(current.branchId); }
        finally { if (current.grant) await kernel.revokeGrant(current.grant.grantId); }
      })();
      await current.cleanup;
    };
    let abandoned: Promise<void> | undefined;
    const abort = () => { abandoned ??= leave(); void abandoned.catch(() => undefined); };
    input.signal.addEventListener('abort', abort, { once: true });
    try {
      const captured = await waitWithSignal(current.work, input.signal);
      input.signal.throwIfAborted();
      const consume = (async () => {
        const pin = await current.store!.pinBranch(current.branchId, { revision: 0, signal: input.signal });
        try {
          await current.store!.createBranchFromPin(handoff.source.workspace_id, `child-source:${input.executionId}`, pin,
            pin.root, undefined, [], { sourceProvenance: captured.provenance });
        } finally { await pin.release(); }
      })();
      current.consumers.add(consume);
      try { await consume; } finally { current.consumers.delete(consume); }
      return captured.provenance;
    } finally {
      input.signal.removeEventListener('abort', abort);
      try { await (abandoned ?? leave()); } finally { owners.documents.discardCapture(token); }
    }
  };
}
