import { sourceFailureCode } from './source-admission-error.js';
import { parseExplicitSkillCommand } from '../agent-resources/activation.js';
import { ResourceScopeError } from './thread-resource-scope.js';
import type { ThreadSkillInputPreparer } from './thread-skill-input.js';
import { randomUUID } from 'node:crypto';
import { admitRunSourceAuthority, sourceToolSchemas } from './source-launch.js';
import { prepareChildSourceStore, prepareContinuationSourceStore } from './child-source-store.js';
import { withManagedChildSource, releaseManagedUnacceptedSource, type ChildSourcePreparation } from './managed-source-collaboration.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from './storage-adapter.js';
import type { LiveSourceResolver } from './live-source.js';
import { type StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';
import { waitWithSignal } from '../cancellation.js';
import type { ThreadIdentity, ThreadSource } from '@varin/application-client';
import type { DocumentAuthority } from '../documents/authority.js';
import type { ContextPreparer } from './thread-context.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { DelegatedExecution, InputResourcePreparation, KernelWorkingResultCandidate } from './protocol.generated.js';

export interface ThreadCollaborationOwners {
  kernel: KernelClient;
  storageAdapter: KernelStorageAdapter;
  resolveLiveSource: LiveSourceResolver;
  sourceCaptureOwners: StableSourcePreparationOwners & { documents: Pick<DocumentAuthority, 'admitWorkspaceRegistration'> };
  runtime: AgentRuntimeClient;
  continueRun(runId: string, signal: AbortSignal): Promise<void>;
  canExecuteThread?(threadId: string): Promise<boolean>;
  recoverLaunches(signal: AbortSignal): Promise<void>;
  prepareContext: ContextPreparer;
  prepareSkillInput?: ThreadSkillInputPreparer;
  reconcileDomainReceipts?(signal: AbortSignal): Promise<void>;
  onError(operationId: string | undefined, error: unknown): void;
}
/** Consumes committed child/process-wait/follow-up facts, including startup backlog. Maps hold only cancellable live
 * work; Catalog owns task identities, preparation receipts, reports and Wait delivery. */
export class ThreadCollaboration {
  private readonly tasks = new Map<string, { controller: AbortController; work: Promise<void>; revision: number; preparing: boolean; recheck: boolean }>();
  private readonly cleaningSources = new Map<string, Promise<void>>();
  private readonly retiringThreads = new Set<string>();
  private readonly removers: Array<() => void>;
  private epoch = new AbortController();
  private stopped = false;
  private suspended = false;
  private pumping = false;
  private dirty = false;
  private domainRecoveryNeeded = true;
  private domainRecovery: Promise<void> | undefined;
  private launchCursor: number | undefined;
  constructor(private readonly owners: ThreadCollaborationOwners) {
    const runtime = owners.runtime;
    this.removers = [runtime.onEvent(event => {
      if (event.stream !== 'durable') return;
      // Definition/Goal controls can release a hold without changing the child execution row.
      for (const task of this.tasks.values()) if (task.preparing) task.recheck = true;
      this.resumeEpoch(); void this.recover();
    }), runtime.onExit(() => {
      this.suspended = true; this.epoch.abort();
      for (const task of this.tasks.values()) task.controller.abort();
      this.tasks.clear(); this.launchCursor = undefined; this.domainRecoveryNeeded = true;
    }), runtime.onReady(() => { this.resumeEpoch(); void this.recover(); })];
  }
  private resumeEpoch(): void {
    if (!this.suspended || this.stopped) return;
    this.epoch = new AbortController(); this.suspended = false;
  }
  stop(): void {
    this.stopped = true; this.epoch.abort();
    for (const task of this.tasks.values()) task.controller.abort();
    for (const remove of this.removers) remove();
  }
  async suspendThreads(threadIds: ReadonlySet<string>): Promise<void> {
    const executions = await this.owners.runtime.childExecutions(undefined, this.epoch.signal);
    const scoped = executions.filter(child => threadIds.has(child.child_thread_id));
    const work = scoped.flatMap(child => {
      const active = this.tasks.get(child.execution_id);
      if (!active) return [];
      active.controller.abort(new DOMException('Bot work suspended', 'AbortError'));
      return [active.work];
    });
    const sources = await this.owners.runtime.unacceptedChildSources(this.epoch.signal);
    work.push(...sources.filter(source => threadIds.has(source.parent_thread_id))
      .flatMap(source => this.cleaningSources.get(source.operation_id) ?? []));
    await Promise.all(work);
  }
  /** Delete has already cancelled these original trees. Join their live owners and release
   * the same durable handoff/source references before Catalog removes their identities. */
  async releaseCancelledThreads(threadIds: ReadonlySet<string>): Promise<void> {
    const signal = this.epoch.signal;
    for (const id of threadIds) this.retiringThreads.add(id);
    try {
      const original = (await this.owners.runtime.childExecutions(undefined, signal))
        .filter(child => threadIds.has(child.child_thread_id));
      await Promise.all(original.flatMap(child => {
        const active = this.tasks.get(child.execution_id);
        return active ? [active.work] : [];
      }));
      for (const child of original) {
        const current = await this.owners.runtime.childExecution(child.execution_id, signal);
        if (!current.report) throw new Error(`Child ${child.execution_id} has no settled cancellation. Reconcile the original work, then retry Delete.`);
        await this.advance(current, signal, signal);
        const released = await this.owners.runtime.childExecution(child.execution_id, signal);
        if (!released.resources_released || (released.receipt && ['pending', 'settling', 'candidate'].includes(released.code_result.kind))) {
          throw new Error(`Child ${child.execution_id} still retains its original source or unpublished result. Reconcile that work, then retry Delete.`);
        }
      }
      for (const source of await this.owners.runtime.unacceptedChildSources(signal)) {
        if (!threadIds.has(source.parent_thread_id)) continue;
        const active = this.cleaningSources.get(source.operation_id);
        if (active) await active;
        // Re-read the original receipt after joining; failed release stays retryable.
        if (!(await this.owners.runtime.unacceptedChildSources(signal)).some(current => current.operation_id === source.operation_id)) continue;
        await this.releaseUnacceptedSource(source, signal);
      }
    } finally {
      for (const id of threadIds) this.retiringThreads.delete(id);
    }
  }
  /** Registration precedes discovery. Real events drive subsequent passes; no idle polling. */
  async recover(): Promise<void> {
    if (this.stopped || this.suspended) return;
    this.dirty = true;
    if (this.pumping) return;
    this.pumping = true;
    const epoch = this.epoch;
    try {
      while (this.dirty && !epoch.signal.aborted) {
        this.dirty = false;
        if (this.domainRecoveryNeeded && !this.domainRecovery && this.owners.reconcileDomainReceipts) {
          this.domainRecoveryNeeded = false;
          const work = this.owners.reconcileDomainReceipts(epoch.signal).catch(error => {
            if (!epoch.signal.aborted) this.owners.onError(undefined, error);
          }).finally(() => {
            if (this.domainRecovery === work) this.domainRecovery = undefined;
            if (this.domainRecoveryNeeded && !this.stopped && !this.suspended) void this.recover();
          });
          this.domainRecovery = work;
        }
        let resumed: string[] | undefined;
        try { resumed = await this.owners.runtime.reconcileObservations(epoch.signal); }
        catch (error) {
          // The native owner can commit independent ready work while preserving another
          // observation's error. Original saved launches/events still require discovery.
          if (!epoch.signal.aborted) this.owners.onError(undefined, error);
        }
        epoch.signal.throwIfAborted();
        const children = await this.owners.runtime.children(epoch.signal);
        this.owners.kernel.reconcileChildToolHandoffs(children);
        const executions = await this.owners.runtime.childExecutions(undefined, epoch.signal);
        const unaccepted = await this.owners.runtime.unacceptedChildSources(epoch.signal);
        for (const source of unaccepted) {
          if (this.cleaningSources.has(source.operation_id)) continue;
          if (this.owners.canExecuteThread && !await this.owners.canExecuteThread(source.parent_thread_id)) continue;
          const cleanup = this.releaseUnacceptedSource(source, epoch.signal).catch(error => {
            if (!epoch.signal.aborted) this.owners.onError(source.operation_id, error);
          }).finally(() => this.cleaningSources.delete(source.operation_id));
          this.cleaningSources.set(source.operation_id, cleanup);
        }
        epoch.signal.throwIfAborted();
        for (const child of executions) {
          if (this.retiringThreads.has(child.child_thread_id)) continue;
          if (this.owners.canExecuteThread && !await this.owners.canExecuteThread(child.child_thread_id)) continue;
          const active = this.tasks.get(child.execution_id);
          if (child.report && active?.preparing) {
            active.recheck = true; active.controller.abort();
          }
          if (active && child.revision > active.revision) active.recheck = true;
          if (!active && (!child.resources_released || child.state === 'preparing' || child.state === 'ready' || Boolean(child.report && child.receipt && ['pending', 'settling', 'candidate'].includes(child.code_result.kind)))) {
            const controller = new AbortController();
            const signal = AbortSignal.any([epoch.signal, controller.signal]);
            const task = { controller, work: Promise.resolve(), revision: child.revision, preparing: !child.report, recheck: false };
            this.tasks.set(child.execution_id, task);
            task.work = this.advance(child, signal, epoch.signal).catch(error => {
              if (!signal.aborted) this.owners.onError(child.execution_id, error);
            }).finally(() => {
              if (this.tasks.get(child.execution_id) !== task) return;
              this.tasks.delete(child.execution_id);
              if (task.recheck && !this.stopped && !this.suspended) void this.recover();
            });
          }
        }
        await this.discoverLaunches(epoch.signal);
        for (const runId of resumed ?? []) void this.owners.continueRun(runId, epoch.signal).catch(error => {
          if (!epoch.signal.aborted) this.owners.onError(undefined, error);
        });
      }
    } catch (error) {
      if (!epoch.signal.aborted) this.owners.onError(undefined, error);
    } finally {
      this.pumping = false;
      if (epoch !== this.epoch && this.dirty && !this.stopped && !this.suspended) void this.recover();
    }
  }
  private async discoverLaunches(signal: AbortSignal): Promise<void> {
    const { runtime } = this.owners;
    if (this.launchCursor === undefined) {
      // Capture before discovery so a resume or follow-up admitted during discovery is replayed.
      const cursor = (await runtime.status(signal)).eventCursor;
      await this.owners.recoverLaunches(signal);
      signal.throwIfAborted();
      this.launchCursor = cursor;
    }
    let events;
    do {
      events = await runtime.events(this.launchCursor, 256, signal);
      signal.throwIfAborted();
      for (const event of events) {
        if (event.kind.startsWith('operation.')) {
          this.domainRecoveryNeeded = true; this.dirty = true;
          // A process receipt can release a child's writer barrier without changing the
          // DelegatedExecution revision. Keep that wake even while its earlier check is draining.
          for (const task of this.tasks.values()) task.recheck = true;
        }
        if (event.kind === 'run.cancel_requested') this.owners.kernel.cancelRunPreparation(event.subject);
        const data = event.data as { run_id?: unknown } | null;
        if ((event.kind === 'policy.resumed' || event.kind === 'ingress.run_ready' || event.kind === 'goal.run_ready' || event.kind === 'observation.run_ready') && data && typeof data.run_id === 'string') {
          void this.owners.continueRun(data.run_id, signal).catch(error => {
            if (!signal.aborted) this.owners.onError(undefined, error);
          });
        }
        this.launchCursor = event.cursor;
      }
    } while (events.length === 256);
  }
  private async releaseUnacceptedSource(source: import('./protocol.generated.js').UnacceptedChildSource,
    signal: AbortSignal): Promise<void> {
    if (source.source.resource_owner.kind === 'managed_host') {
      await releaseManagedUnacceptedSource(this.owners.runtime, source, signal);
    } else {
      await this.withSourceStore(source.source, source.parent_thread_id, signal, async store => {
        if (!store.releaseBranchHandoffPin) throw new Error('Durable source pin release is unavailable');
        await store.releaseBranchHandoffPin(source.source.branch_id!, source.pin_id);
      });
    }
    signal.throwIfAborted();
    await this.owners.runtime.releaseUnacceptedChildSource(source.operation_id, signal);
  }
  /** Catalog-selected branch work never acquires a physical project root or tool capability. */
  private async withSourceStore<T>(source: { workspace_id: string; execution_workspace_id: string }, threadId: string,
    signal: AbortSignal, consume: (store: KernelWorkingStateRootStore) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const { kernel, storageAdapter } = this.owners;
    const grant = await kernel.issueGrant({ grantId: `child-branch:${randomUUID()}`, threadId,
      owningWorkspace: source.workspace_id, executionWorkspace: source.execution_workspace_id,
      capabilities: ['storage.read', 'storage.write', 'storage.maintenance'], pathScopes: [''] }, signal);
    try {
      const context = await storageAdapter.contextFromBranchGrant({ grant, owningWorkspaceId: source.workspace_id,
        executionWorkspaceId: source.execution_workspace_id });
      signal.throwIfAborted();
      return await consume(new KernelWorkingStateRootStore(context));
    } finally { await kernel.revokeGrant(grant.grantId); }
  }
  private async admitSourceRegistrations(source: { workspace_id: string; execution_workspace_id: string }, signal: AbortSignal): Promise<void> {
    const documents = this.owners.sourceCaptureOwners.documents;
    await documents.admitWorkspaceRegistration(source.workspace_id, signal);
    if (source.execution_workspace_id !== source.workspace_id) await documents.admitWorkspaceRegistration(source.execution_workspace_id, signal);
  }
  private childSource(child: DelegatedExecution): ThreadSource | null {
    if (child.source?.kind === 'absent') return null;
    if (child.source?.kind !== 'ready') throw new Error('Child source is not ready');
    const fixed = child.source.selection;
    if ((fixed.mode !== 'fixed_branch' && fixed.mode !== 'materialized') || !fixed.branch_id || fixed.revision === null) throw new Error('Child source is not fixed');
    const tools = sourceToolSchemas(child.launch).map(tool => tool.name as ThreadSource['tools'][number]);
    return { resourceOwner: fixed.resource_owner, mode: fixed.mode, workspaceId: fixed.workspace_id, executionWorkspaceId: fixed.execution_workspace_id,
      branchId: fixed.branch_id, revision: fixed.revision, tools,
      ...(fixed.environment_run_id ? { environmentRunId: fixed.environment_run_id } : {}) };
  }
  private async prepareSource(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution> {
    if (child.source?.kind === 'ready' || child.source?.kind === 'absent') return child;
    const original = child.trigger.kind === 'dispatch' ? child.source?.handoff?.source : child.source_basis?.source;
    if (original?.resource_owner.kind === 'managed_host') {
      return withManagedChildSource(this.owners.runtime, child, signal, async (service, address) => {
        const prepared = await service.service({ ...address, requestId: randomUUID(),
          operation: { kind: 'child_prepare', execution: child } }, signal) as ChildSourcePreparation;
        return this.owners.runtime.readyChildSource({ executionId: child.execution_id,
          source: { resourceOwner: prepared.source.resource_owner, mode: prepared.source.mode, liveRoot: prepared.source.live_root,
            workspaceId: prepared.source.workspace_id, executionWorkspaceId: prepared.source.execution_workspace_id,
            branchId: prepared.source.branch_id, revision: prepared.source.revision },
          pin: prepared.pin, provenance: prepared.provenance }, signal);
      });
    }
    if (child.trigger.kind !== 'dispatch') return this.prepareContinuationSource(child, signal);
    if (!child.source || !child.source.handoff) throw new Error('Dispatch source handoff is unavailable');
    const { kernel, storageAdapter, runtime, sourceCaptureOwners } = this.owners;
    const handoff = child.source.handoff;
    const workspace = handoff.source.workspace_id;
    await this.admitSourceRegistrations(handoff.source, signal);
    const grant = await kernel.claimChildSource({ handoffOperationId: handoff.operation_id, grantId: `child-source:${randomUUID()}`,
      childThreadId: child.child_thread_id, childBranchId: child.child_branch_id }, signal);
    try {
      const context = await storageAdapter.contextFromBranchGrant({ grant, owningWorkspaceId: workspace, executionWorkspaceId: handoff.source.execution_workspace_id });
      const prepared = await prepareChildSourceStore(child, {
        store: new KernelWorkingStateRootStore(context), capture: sourceCaptureOwners,
        physical: async root => new KernelWorkingStateRootStore(await storageAdapter.contextFromSourceGrant({
          grant, owningWorkspaceId: workspace, executionWorkspaceId: handoff.source.execution_workspace_id,
          rootId: root.rootId, canonicalRoot: root.canonicalRoot,
        })),
      }, signal);
      await this.admitSourceRegistrations(handoff.source, signal);
      return await runtime.readyChildSource({ executionId: child.execution_id,
        source: { resourceOwner: prepared.source.resource_owner, mode: prepared.source.mode, liveRoot: prepared.source.live_root,
          workspaceId: prepared.source.workspace_id, executionWorkspaceId: prepared.source.execution_workspace_id,
          branchId: prepared.source.branch_id, revision: prepared.source.revision },
        pin: prepared.pin, provenance: prepared.provenance }, signal);
    } finally { await kernel.revokeGrant(grant.grantId).catch(error => { if (!signal.aborted) this.owners.onError(child.execution_id, error); }); }
  }
  private async prepareContinuationSource(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution> {
    const basis = child.source_basis;
    if (!basis || basis.source.branch_id === null || basis.source.revision === null) throw new Error('Continuation has no exact immutable source');
    await this.admitSourceRegistrations(basis.source, signal);
    return this.withSourceStore(basis.source, child.child_thread_id, signal, async store => {
      const prepared = await prepareContinuationSourceStore(child, store, signal);
      await this.admitSourceRegistrations(basis.source, signal);
      return this.owners.runtime.readyChildSource({ executionId: child.execution_id,
        source: { resourceOwner: prepared.source.resource_owner, mode: prepared.source.mode, liveRoot: prepared.source.live_root,
          workspaceId: prepared.source.workspace_id, executionWorkspaceId: prepared.source.execution_workspace_id,
          branchId: prepared.source.branch_id, revision: prepared.source.revision },
        pin: prepared.pin, provenance: prepared.provenance }, signal);
    });
  }
  private async settle(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution> {
    if (!child.receipt || child.source?.kind !== 'ready' || child.source.selection.mode !== 'materialized') return child;
    const { kernel, runtime, storageAdapter, resolveLiveSource } = this.owners;
    const source = this.childSource(child);
    if (source?.mode !== 'materialized') throw new Error('Writable child lost its private source');
    const runId = child.receipt.run_id;
    // The terminal notification withdraws this Run's language reference, but is not
    // a process exit receipt. Capture waits on the same supervisor's actual drain.
    if (source.resourceOwner.kind === 'local') await waitWithSignal(kernel.releaseLanguageSource(runId), signal);
    signal.throwIfAborted();
    const publicationId = `child-result:${child.execution_id}`;
    const phases = child.code_result.kind === 'pending' ? ['source'] as const : ['result', 'source'] as const;
    for (const purpose of phases) {
      const authority = await admitRunSourceAuthority(kernel, runtime, { ...source, runId }, { signal, resolveLiveSource, purpose });
      try {
        if (authority.kind === 'managed') {
          const address = { coordinatorHostId: runtime.coordinatorHostId,
            authorityId: authority.binding.authorityId, resourceEpoch: authority.binding.resourceEpoch };
          await authority.service.service({ ...address, requestId: randomUUID(),
            operation: { kind: 'language_release' } }, signal);
          let candidate = await authority.service.service({ ...address, requestId: randomUUID(),
            operation: { kind: 'child_result_read', execution: child } }, signal) as KernelWorkingResultCandidate | null;
          if (!candidate) {
            if (purpose === 'result') continue;
            child = await runtime.settleChild({ executionId: child.execution_id, toolBinding: authority.toolBinding }, signal);
            if (child.code_result.kind !== 'settling') return child;
            candidate = await authority.service.service({ ...address, requestId: randomUUID(),
              operation: { kind: 'child_result_prepare', execution: child } }, signal) as KernelWorkingResultCandidate;
          }
          if (child.code_result.kind === 'settling') {
            child = await runtime.attachChildCandidate({ executionId: child.execution_id,
              toolBinding: authority.toolBinding, candidateOperationId: candidate.candidateOperationId }, signal);
          }
          if (child.code_result.kind === 'candidate') {
            await authority.service.service({ ...address, requestId: randomUUID(),
              operation: { kind: 'child_result_publish', execution: child } }, signal);
            child = await runtime.attachChildResult({ executionId: child.execution_id, toolBinding: authority.toolBinding, publicationId }, signal);
          }
          return child;
        }
        const context = await storageAdapter.contextFromBranchGrant({ grant: authority.grant,
          owningWorkspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId });
        let store = new KernelWorkingStateRootStore(context);
        let candidate = await store.readResultCandidate(source.branchId, publicationId, { signal });
        if (!candidate) {
          if (purpose === 'result') continue;
          child = await runtime.settleChild({ executionId: child.execution_id, toolBinding: authority.toolBinding }, signal);
          // A final report does not stop its accepted processes. Only the existing
          // settlement barrier authorizes freezing the private execution directory.
          if (child.code_result.kind !== 'settling') return child;
          if (!authority.rootId || !authority.canonicalRoot) throw new Error('Child has no original private execution root');
          store = new KernelWorkingStateRootStore(await storageAdapter.contextFromSourceGrant({ grant: authority.grant,
            owningWorkspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId,
            rootId: authority.rootId, canonicalRoot: authority.canonicalRoot }));
          candidate = await store.prepareResultCandidate({ publicationId, branchId: source.branchId,
            source: { kind: 'directory', directory: authority.canonicalRoot }, signal });
        }
        if (child.code_result.kind === 'settling') {
          child = await runtime.attachChildCandidate({ executionId: child.execution_id, toolBinding: authority.toolBinding,
            candidateOperationId: candidate.candidateOperationId }, signal);
        }
        if (child.code_result.kind === 'candidate') {
          // Original WorkingState publication also confirms release of its candidate pins.
          await store.publishPreparedResult(publicationId, child.code_result.candidate, { signal });
          child = await runtime.attachChildResult({ executionId: child.execution_id, toolBinding: authority.toolBinding, publicationId }, signal);
        }
        return child;
      } finally { await authority.release(); }
    }
    return child;
  }
  private async releaseHandoff(child: DelegatedExecution, signal: AbortSignal): Promise<void> {
    if (child.resources_released || (!child.receipt && !child.report) || (child.source?.kind !== 'ready' && child.source?.kind !== 'absent' && !child.report)) return;
    const { kernel, runtime } = this.owners;
    if (child.receipt && child.source?.kind !== 'absent') await runtime.releaseMcpResourceSource(child.receipt.run_id);
    if (child.source?.kind === 'absent') {
      signal.throwIfAborted();
      await runtime.releaseChildResources(child.execution_id, signal);
      return;
    }
    const original = child.trigger.kind === 'dispatch' ? child.source?.handoff?.source : child.source_basis?.source;
    if (original?.resource_owner.kind === 'managed_host') {
      await withManagedChildSource(runtime, child, signal, async (service, address) => {
        await service.service({ ...address, requestId: randomUUID(),
          operation: { kind: 'child_release', execution: child } }, signal);
      });
    } else if (child.trigger.kind !== 'dispatch') {
      if (!child.receipt && child.source_basis) {
        await this.withSourceStore(child.source_basis.source, child.child_thread_id, signal, async store => {
          if (!store.releaseBranchHandoffPin) throw new Error('Durable source pin release is unavailable');
          const branchId = `child-source:${child.execution_id}`;
          const branch = await store.getBranchRoot(branchId);
          if (branch) {
            if (branch.baseRoot !== child.source_basis!.root) throw new Error('Unused continuation source identity changed');
            await store.releaseBranchHandoffPin(branchId, `child-source-pin:${child.execution_id}`);
            await store.deleteBranch(branchId);
          }
        });
      }
    } else {
      const handoff = child.source?.handoff;
      if (!handoff) throw new Error('Original dispatch handoff is unavailable');
      const grant = await kernel.claimChildSource({ handoffOperationId: handoff.operation_id, grantId: `child-release:${randomUUID()}`,
        childThreadId: child.child_thread_id, childBranchId: child.child_branch_id }, signal);
      try {
        if (handoff.root.kind === 'fixed') {
          await kernel.scoped(grant).unpinBranch({ operationId: `child-handoff-release:${child.execution_id}`,
            branchId: handoff.root.pin.source.branch_id!, pinId: handoff.root.pin.pin_id }, signal);
        }
        if (!child.receipt) {
          const branchId = `child-source:${child.execution_id}`;
          const client = kernel.scoped(grant);
          await client.unpinBranch({ operationId: `child-unused-source-unpin:${child.execution_id}`, branchId,
            pinId: `child-source-pin:${child.execution_id}` }, signal);
          await client.deleteBranch({ operationId: `child-unused-source-delete:${child.execution_id}`, branchId }, signal);
        }
      } finally { await kernel.revokeGrant(grant.grantId); }
    }
    // The handoff can be released once a Run owns its source, but discovery must
    // retain this execution until result publication and original grant retirement
    // both finish. A failed release is retried through this same durable child.
    if (!child.report || (child.receipt && ['pending', 'settling', 'candidate'].includes(child.code_result.kind))) return;
    signal.throwIfAborted();
    if (child.receipt) await runtime.retireSourceGrants(child.receipt.run_id);
    signal.throwIfAborted();
    await runtime.releaseChildResources(child.execution_id, signal);
  }
  private async advance(admitted: DelegatedExecution, signal: AbortSignal, ownerSignal: AbortSignal): Promise<void> {
    const { runtime, prepareContext } = this.owners;
    let child = admitted;
    try {
      if (child.state === 'preparing' && !child.receipt && !child.report) {
        child = await this.prepareSource(child, signal);
        const source = this.childSource(child);
        const identity: ThreadIdentity = { runtime: 'agent', threadId: child.child_thread_id, branchId: child.child_branch_id };
        const checkpoint = child.trigger.kind !== 'dispatch' ? await runtime.context(child.child_branch_id, signal) : null;
        if (child.trigger.kind !== 'dispatch' && (!checkpoint || !prepareContext.forSource)) throw new Error('Continuation context provenance is unavailable');
        const context = await waitWithSignal(checkpoint
          ? prepareContext.forSource!(checkpoint, source, signal)
          : prepareContext(identity, source, { mode: (await runtime.thread(child.child_thread_id, signal)).bot_id ? 'bot' : 'agent', threadRole: 'worker', projectId: child.project_id, childProfile: child.selected_profile }, signal), signal);
        let inputPreparation: InputResourcePreparation | undefined;
        if (child.trigger.kind === 'user_continuation') {
          const input = child.input as { text?: unknown } | string;
          const text = typeof input === 'string' ? input : typeof input?.text === 'string' ? input.text : '';
          if (parseExplicitSkillCommand(text)) {
            if (!this.owners.prepareSkillInput) throw new Error('Skill input preparation is unavailable');
            const prepared = await this.owners.prepareSkillInput(identity, context.resources, text, signal);
            if (prepared.status !== 'ready') throw new ResourceScopeError(prepared);
            if (prepared.skill) inputPreparation = { expectedContextCheckpoint: null, skill: prepared.skill };
          }
        }
        signal.throwIfAborted();
        if (source?.mode === 'live_root') throw new Error('Child source is not isolated');
        child = await runtime.prepareChild({ executionId: child.execution_id, source: source ? { resourceOwner: source.resourceOwner, mode: source.mode, liveRoot: null,
          workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, branchId: source.branchId, revision: source.revision } : null,
          context, expectedContextCheckpoint: checkpoint?.id ?? null, ...(inputPreparation ? { inputPreparation } : {}) }, signal);
      }
      if (child.receipt && child.state === 'ready') await this.owners.continueRun(child.receipt.run_id, signal);
      if (child.report && child.receipt && ['pending', 'settling', 'candidate'].includes(child.code_result.kind)) child = await this.settle(child, signal);
    } catch (error) {
      // A current definition/Goal pause can arrive after source preparation but before the
      // original submission transaction. Keep this exact pending execution for its next event.
      if (error instanceof KernelClientError && (error.code === 'activation-held' || error.code === 'bot-suspended')) return;
      if (!signal.aborted) {
        const current = await runtime.childExecution(child.execution_id);
        // An admitted Run's unknown effects remain recoverable; preparation failure cannot erase them.
        if (!current.receipt && !current.report) child = await runtime.failChild(child.execution_id, sourceFailureCode(error) ?? 'preparation_failed');
      }
      throw error;
    } finally {
      if (!ownerSignal.aborted) {
        child = await runtime.childExecution(child.execution_id, ownerSignal);
        if (child.report && child.trigger.kind === 'dispatch') this.owners.kernel.releaseChildToolHandoff(child.parent_run_id, child.child_operation_id);
        await this.releaseHandoff(child, ownerSignal);
      }
    }
  }
}
