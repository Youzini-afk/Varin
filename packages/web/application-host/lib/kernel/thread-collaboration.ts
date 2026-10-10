import { randomUUID } from 'node:crypto';
import { admitRunSourceAuthority } from './source-launch.js';
import type { KernelClient } from './kernel-client.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from './storage-adapter.js';
import type { LiveSourceResolver } from './live-source.js';
import { captureStableSourceBaseline, type StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';
import { waitWithSignal } from '../cancellation.js';
import type { ThreadIdentity, ThreadSource } from '@varin/application-client';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import type { ContextPreparer } from './thread-context.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ChildTask, ChildSourceProvenance } from './protocol.generated.js';

export interface ThreadCollaborationOwners {
  kernel: KernelClient;
  storageAdapter: KernelStorageAdapter;
  resolveLiveSource: LiveSourceResolver;
  sourceCaptureOwners: StableSourcePreparationOwners;
  runtime: AgentRuntimeClient;
  continueRun(runId: string, signal: AbortSignal): Promise<void>;
  recoverLaunches(signal: AbortSignal): Promise<void>;
  workingStates: WorkspaceWorkingStateRootAccess;
  prepareContext: ContextPreparer;
  reconcileDomainReceipts?(signal: AbortSignal): Promise<void>;
  onError(operationId: string | undefined, error: unknown): void;
}
/** Consumes committed child/process-wait/follow-up facts, including startup backlog. Maps hold only cancellable live
 * work; Catalog owns task identities, preparation receipts, reports and Wait delivery. */
export class ThreadCollaboration {
  private readonly tasks = new Map<string, { controller: AbortController; work: Promise<void>; revision: number; recheck: boolean }>();
  private readonly cleaningSources = new Set<string>();
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
        const resumed = [...new Set([...await this.owners.runtime.reconcileChildren(epoch.signal), ...await this.owners.runtime.reconcileProcessWaits(epoch.signal)])];
        const children = await this.owners.runtime.children(epoch.signal);
        const unaccepted = await this.owners.runtime.unacceptedChildSources(epoch.signal);
        for (const source of unaccepted) {
          if (this.cleaningSources.has(source.operation_id)) continue;
          this.cleaningSources.add(source.operation_id);
          void this.owners.workingStates.withBranchStore(source.source.workspace_id, 'child-orphan-release', async store => {
            if (!store.releaseBranchHandoffPin) throw new Error('Durable source pin release is unavailable');
            await store.releaseBranchHandoffPin(source.source.branch_id!, source.pin_id);
            epoch.signal.throwIfAborted();
            await this.owners.runtime.releaseUnacceptedChildSource(source.operation_id, epoch.signal);
          }, 'shared', { threadId: source.parent_thread_id }).catch(error => {
            if (!epoch.signal.aborted) this.owners.onError(source.operation_id, error);
          }).finally(() => this.cleaningSources.delete(source.operation_id));
        }
        epoch.signal.throwIfAborted();
        for (const child of children) {
          if (child.report && !child.receipt) this.tasks.get(child.operation_id)?.controller.abort();
          const active = this.tasks.get(child.operation_id);
          if (active && child.revision > active.revision) active.recheck = true;
          if (!active && (!child.resources_released || child.state === 'preparing' || child.state === 'ready' || Boolean(child.report && child.receipt && ['pending', 'settling', 'candidate'].includes(child.code_result.kind)))) {
            const controller = new AbortController();
            const signal = AbortSignal.any([epoch.signal, controller.signal]);
            const task = { controller, work: Promise.resolve(), revision: child.revision, recheck: false };
            this.tasks.set(child.operation_id, task);
            task.work = this.advance(child, signal, epoch.signal).catch(error => {
              if (!signal.aborted) this.owners.onError(child.operation_id, error);
            }).finally(() => {
              if (this.tasks.get(child.operation_id) !== task) return;
              this.tasks.delete(child.operation_id);
              if (task.recheck && !this.stopped && !this.suspended) void this.recover();
            });
          }
        }
        await this.discoverLaunches(epoch.signal);
        for (const runId of resumed) void this.owners.continueRun(runId, epoch.signal).catch(error => {
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
        if (event.kind.startsWith('operation.')) { this.domainRecoveryNeeded = true; this.dirty = true; }
        const data = event.data as { run_id?: unknown } | null;
        if ((event.kind === 'policy.resumed' || event.kind === 'followup.admitted') && data && typeof data.run_id === 'string') {
          void this.owners.continueRun(data.run_id, signal).catch(error => {
            if (!signal.aborted) this.owners.onError(undefined, error);
          });
        }
        this.launchCursor = event.cursor;
      }
    } while (events.length === 256);
  }
  private childSource(child: ChildTask): ThreadSource {
    if (child.source.kind !== 'ready') throw new Error('Child source is not ready');
    const fixed = child.source.selection;
    if ((fixed.mode !== 'fixed_branch' && fixed.mode !== 'materialized') || !fixed.branch_id || fixed.revision === null) throw new Error('Child source is not fixed');
    const tools = child.launch.tools.map(tool => {
      if (!['file_read', 'file_list', 'file_search', 'file_write', 'file_edit'].includes(tool.name)) throw new Error('Child contains an unadmitted capability');
      return tool.name as ThreadSource['tools'][number];
    });
    return { mode: fixed.mode, workspaceId: fixed.workspace_id, executionWorkspaceId: fixed.execution_workspace_id,
      branchId: fixed.branch_id, revision: fixed.revision, tools,
      ...(fixed.environment_run_id ? { environmentRunId: fixed.environment_run_id } : {}) };
  }
  private async prepareSource(child: ChildTask, signal: AbortSignal): Promise<ChildTask> {
    if (child.source.kind === 'ready') return child;
    const { kernel, storageAdapter, runtime, sourceCaptureOwners } = this.owners;
    const handoff = child.source.handoff;
    const workspace = handoff.source.workspace_id;
    const grant = await kernel.claimChildSource({ handoffOperationId: handoff.operation_id, grantId: `child-source:${randomUUID()}`,
      childThreadId: child.child_thread_id, childBranchId: child.child_branch_id }, signal);
    try {
      const context = await storageAdapter.contextFromBranchGrant({ grant, owningWorkspaceId: workspace, executionWorkspaceId: handoff.source.execution_workspace_id });
      let store = new KernelWorkingStateRootStore(context);
      const sourceBranch = `child-source:${child.operation_id}`;
      let provenance: ChildSourceProvenance;
      if (handoff.root.kind === 'fixed') {
        const fixed = handoff.root.pin;
        if (!fixed.source.branch_id || fixed.source.revision === null) throw new Error('Fixed child source has incomplete identity');
        const pin = await store.openBranchHandoffPin(fixed.source.branch_id, fixed.pin_id,
          { root: fixed.root, revision: fixed.source.revision, writeRevision: fixed.source.revision }, signal);
        const branch = await store.createBranchFromPin(workspace, sourceBranch, pin, `${fixed.source.branch_id}@${fixed.source.revision}`);
        if (branch.baseRoot !== fixed.root) throw new Error('Child source root changed');
        provenance = { consistency: 'fixed-root', root: fixed.root };
      } else {
        const restored = await store.readSourcePreparation(sourceBranch, { signal });
        if (restored) provenance = restored.provenance;
        else {
          const directory = handoff.root.root.canonicalRoot;
          const resolved = await sourceCaptureOwners.documents.resolveWorkspace({ path: directory });
          if ((await sourceCaptureOwners.documents.inspectWorkspace(resolved.workspaceId)).root !== directory) throw new Error('Child source Documents authority changed');
          const physical = await storageAdapter.contextFromSourceGrant({ grant, owningWorkspaceId: workspace,
            executionWorkspaceId: handoff.source.execution_workspace_id, rootId: handoff.root.root.rootId, canonicalRoot: directory });
          store = new KernelWorkingStateRootStore(physical);
          const captured = await captureStableSourceBaseline({ store, workspaceId: workspace, captureWorkspaceId: resolved.workspaceId,
            branchId: sourceBranch, directory, captureScopes: [], content: { mode: 'saved-files' }, signal }, sourceCaptureOwners);
          provenance = captured.provenance;
        }
      }
      const pin = await store.pinBranchHandoff(sourceBranch, `child-source-pin:${child.operation_id}`, { revision: 0, signal });
      signal.throwIfAborted();
      const source = { mode: child.code_result.kind === 'no_changes' ? 'fixed_branch' as const : 'materialized' as const,
        liveRoot: null, workspaceId: workspace, executionWorkspaceId: handoff.source.execution_workspace_id, branchId: sourceBranch, revision: 0 };
      return await runtime.readyChildSource({ operationId: child.operation_id, source,
        pin: { pin_id: pin.pinId, root: pin.root, source: { mode: 'fixed_branch', live_root: null,
          workspace_id: workspace, execution_workspace_id: handoff.source.execution_workspace_id, branch_id: sourceBranch, revision: 0 } }, provenance }, signal);
    } finally { await kernel.revokeGrant(grant.grantId).catch(error => { if (!signal.aborted) this.owners.onError(child.operation_id, error); }); }
  }
  private async settle(child: ChildTask, signal: AbortSignal): Promise<ChildTask> {
    if (!child.receipt || child.source.kind !== 'ready' || child.source.selection.mode !== 'materialized') return child;
    const { kernel, runtime, storageAdapter, resolveLiveSource } = this.owners;
    const source = this.childSource(child);
    if (source.mode !== 'materialized') throw new Error('Writable child lost its private source');
    const runId = child.receipt.run_id;
    const publicationId = `child-result:${child.operation_id}`;
    const phases = child.code_result.kind === 'pending' ? ['source'] as const : ['result', 'source'] as const;
    for (const purpose of phases) {
      const authority = await admitRunSourceAuthority(kernel, runtime, { ...source, runId }, { signal, resolveLiveSource, purpose });
      try {
        const context = await storageAdapter.contextFromBranchGrant({ grant: authority.grant,
          owningWorkspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId });
        let store = new KernelWorkingStateRootStore(context);
        let candidate = await store.readResultCandidate(source.branchId, publicationId, { signal });
        if (!candidate) {
          if (purpose === 'result') continue;
          child = await runtime.settleChild({ operationId: child.operation_id, toolBinding: authority.toolBinding }, signal);
          if (!authority.rootId || !authority.canonicalRoot) throw new Error('Child has no original private execution root');
          store = new KernelWorkingStateRootStore(await storageAdapter.contextFromSourceGrant({ grant: authority.grant,
            owningWorkspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId,
            rootId: authority.rootId, canonicalRoot: authority.canonicalRoot }));
          candidate = await store.prepareResultCandidate({ publicationId, branchId: source.branchId,
            source: { kind: 'directory', directory: authority.canonicalRoot }, signal });
        }
        if (child.code_result.kind === 'settling') {
          child = await runtime.attachChildCandidate({ operationId: child.operation_id, toolBinding: authority.toolBinding,
            candidateOperationId: candidate.candidateOperationId }, signal);
        }
        if (child.code_result.kind === 'candidate') {
          // Original WorkingState publication also confirms release of its candidate pins.
          await store.publishPreparedResult(publicationId, child.code_result.candidate, { signal });
          child = await runtime.attachChildResult({ operationId: child.operation_id, toolBinding: authority.toolBinding, publicationId }, signal);
        }
        return child;
      } finally { await authority.release(); }
    }
    return child;
  }
  private async releaseHandoff(child: ChildTask, signal: AbortSignal): Promise<void> {
    if (child.resources_released || (child.source.kind !== 'ready' && !child.report)) return;
    const { kernel, runtime } = this.owners;
    const handoff = child.source.handoff;
    const grant = await kernel.claimChildSource({ handoffOperationId: handoff.operation_id, grantId: `child-release:${randomUUID()}`,
      childThreadId: child.child_thread_id, childBranchId: child.child_branch_id }, signal);
    try {
      if (handoff.root.kind === 'fixed') {
        await kernel.scoped(grant).unpinBranch({ operationId: `child-handoff-release:${child.operation_id}`,
          branchId: handoff.root.pin.source.branch_id!, pinId: handoff.root.pin.pin_id }, signal);
      }
      if (!child.receipt) {
        const branchId = `child-source:${child.operation_id}`;
        const client = kernel.scoped(grant);
        await client.unpinBranch({ operationId: `child-unused-source-unpin:${child.operation_id}`, branchId,
          pinId: `child-source-pin:${child.operation_id}` }, signal);
        await client.deleteBranch({ operationId: `child-unused-source-delete:${child.operation_id}`, branchId }, signal);
      }
      await runtime.releaseChildResources(child.operation_id, signal);
    } finally { await kernel.revokeGrant(grant.grantId); }
  }
  private async advance(admitted: ChildTask, signal: AbortSignal, ownerSignal: AbortSignal): Promise<void> {
    const { runtime, prepareContext } = this.owners;
    let child = admitted;
    try {
      if (child.state === 'preparing' && !child.receipt && !child.report) {
        child = await this.prepareSource(child, signal);
        const source = this.childSource(child);
        const identity: ThreadIdentity = { runtime: 'agent', threadId: child.child_thread_id, branchId: child.child_branch_id };
        const context = await waitWithSignal(prepareContext(identity, source, { mode: 'agent', threadRole: 'worker', projectId: child.project_id }), signal);
        signal.throwIfAborted();
        if (source.mode === 'live_root') throw new Error('Child source is not isolated');
        child = await runtime.prepareChild({ operationId: child.operation_id, source: { mode: source.mode, liveRoot: null,
          workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, branchId: source.branchId, revision: source.revision }, context }, signal);
      }
      if (child.receipt && child.state === 'ready') await this.owners.continueRun(child.receipt.run_id, signal);
      if (child.report && child.receipt && ['pending', 'settling', 'candidate'].includes(child.code_result.kind)) child = await this.settle(child, signal);
    } catch (error) {
      if (!signal.aborted) {
        const current = await runtime.child(child.operation_id);
        // An admitted Run's unknown effects remain recoverable; preparation failure cannot erase them.
        if (!current.receipt && !current.report) child = await runtime.failChild(child.operation_id, 'preparation_failed');
      }
      throw error;
    } finally {
      if (!ownerSignal.aborted) {
        child = await runtime.child(child.operation_id, ownerSignal);
        await this.releaseHandoff(child, ownerSignal);
        if (child.report && child.receipt && ['published', 'no_changes', 'unavailable'].includes(child.code_result.kind)) await runtime.releaseSourceGrants(child.receipt.run_id);
      }
    }
  }
}
