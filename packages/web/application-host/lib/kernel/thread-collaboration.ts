import { parseExplicitSkillCommand } from '../agent-resources/activation.js';
import { ResourceScopeError } from './thread-resource-scope.js';
import type { ThreadSkillInputPreparer } from './thread-skill-input.js';
import { randomUUID } from 'node:crypto';
import { admitRunSourceAuthority, sourceToolSchemas } from './source-launch.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from './storage-adapter.js';
import type { LiveSourceResolver } from './live-source.js';
import { captureStableSourceBaseline, type StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';
import { waitWithSignal } from '../cancellation.js';
import type { ThreadIdentity, ThreadSource } from '@varin/application-client';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import type { ContextPreparer } from './thread-context.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { DelegatedExecution, ChildSourceProvenance, InputResourcePreparation } from './protocol.generated.js';

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
  prepareSkillInput?: ThreadSkillInputPreparer;
  reconcileDomainReceipts?(signal: AbortSignal): Promise<void>;
  onError(operationId: string | undefined, error: unknown): void;
}
/** Consumes committed child/process-wait/follow-up facts, including startup backlog. Maps hold only cancellable live
 * work; Catalog owns task identities, preparation receipts, reports and Wait delivery. */
export class ThreadCollaboration {
  private readonly tasks = new Map<string, { controller: AbortController; work: Promise<void>; revision: number; preparing: boolean; recheck: boolean }>();
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
        for (const child of executions) {
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
  private childSource(child: DelegatedExecution): ThreadSource {
    if (child.source?.kind !== 'ready') throw new Error('Child source is not ready');
    const fixed = child.source.selection;
    if ((fixed.mode !== 'fixed_branch' && fixed.mode !== 'materialized') || !fixed.branch_id || fixed.revision === null) throw new Error('Child source is not fixed');
    const tools = sourceToolSchemas(child.launch).map(tool => tool.name as ThreadSource['tools'][number]);
    return { mode: fixed.mode, workspaceId: fixed.workspace_id, executionWorkspaceId: fixed.execution_workspace_id,
      branchId: fixed.branch_id, revision: fixed.revision, tools,
      ...(fixed.environment_run_id ? { environmentRunId: fixed.environment_run_id } : {}) };
  }
  private async prepareSource(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution> {
    if (child.source?.kind === 'ready') return child;
    if (child.trigger.kind !== 'dispatch') return this.prepareContinuationSource(child, signal);
    if (!child.source || !child.source.handoff) throw new Error('Dispatch source handoff is unavailable');
    const { kernel, storageAdapter, runtime, sourceCaptureOwners } = this.owners;
    const handoff = child.source.handoff;
    const workspace = handoff.source.workspace_id;
    const grant = await kernel.claimChildSource({ handoffOperationId: handoff.operation_id, grantId: `child-source:${randomUUID()}`,
      childThreadId: child.child_thread_id, childBranchId: child.child_branch_id }, signal);
    try {
      const context = await storageAdapter.contextFromBranchGrant({ grant, owningWorkspaceId: workspace, executionWorkspaceId: handoff.source.execution_workspace_id });
      let store = new KernelWorkingStateRootStore(context);
      const sourceBranch = `child-source:${child.execution_id}`;
      let provenance: ChildSourceProvenance;
      if (handoff.root.kind === 'fixed') {
        const fixed = handoff.root.pin;
        if (!fixed.source.branch_id || fixed.source.revision === null) throw new Error('Fixed child source has incomplete identity');
        const pin = await store.openBranchHandoffPin(fixed.source.branch_id, fixed.pin_id,
          { root: fixed.root, revision: fixed.source.revision, writeRevision: fixed.source.revision }, signal);
        const original = await store.readOriginalSource(fixed.source.branch_id, { signal });
        provenance = { consistency: 'fixed-root', root: fixed.root, ...(original?.provenance.resources ? { resources: original.provenance.resources } : {}) };
        const branch = await store.createBranchFromPin(workspace, sourceBranch, pin, `${fixed.source.branch_id}@${fixed.source.revision}`,
          undefined, [], { sourceProvenance: provenance });
        if (branch.baseRoot !== fixed.root) throw new Error('Child source root changed');
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
      const pin = await store.pinBranchHandoff(sourceBranch, `child-source-pin:${child.execution_id}`, { revision: 0, signal });
      signal.throwIfAborted();
      const source = { mode: child.code_result.kind === 'no_changes' ? 'fixed_branch' as const : 'materialized' as const,
        liveRoot: null, workspaceId: workspace, executionWorkspaceId: handoff.source.execution_workspace_id, branchId: sourceBranch, revision: 0 };
      return await runtime.readyChildSource({ executionId: child.execution_id, source,
        pin: { pin_id: pin.pinId, root: pin.root, source: { mode: 'fixed_branch', live_root: null,
          workspace_id: workspace, execution_workspace_id: handoff.source.execution_workspace_id, branch_id: sourceBranch, revision: 0 } }, provenance }, signal);
    } finally { await kernel.revokeGrant(grant.grantId).catch(error => { if (!signal.aborted) this.owners.onError(child.execution_id, error); }); }
  }
  private async prepareContinuationSource(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution> {
    const basis = child.source_basis;
    if (!basis || basis.source.branch_id === null || basis.source.revision === null) throw new Error('Continuation has no exact immutable source');
    const workspace = basis.source.workspace_id;
    return this.owners.workingStates.withBranchStore(workspace, 'child-continuation-source', async store => {
      if (!store.pinBranchHandoff) throw new Error('Durable source pin is unavailable');
      const pin = await store.pinBranch(basis.source.branch_id!, { revision: basis.source.revision!, signal });
      try {
        if (pin.root !== basis.root) throw new Error('Continuation source root changed');
        signal.throwIfAborted();
        const branchId = `child-source:${child.execution_id}`;
        const branch = await store.createBranchFromPin(workspace, branchId, pin,
          `${basis.source.branch_id}@${basis.source.revision}`, undefined, [], { sourceProvenance: basis.provenance });
        if (branch.baseRoot !== basis.root) throw new Error('Continuation branch has a different fixed baseline');
        const retained = await store.pinBranchHandoff(branchId, `child-source-pin:${child.execution_id}`, { revision: 0, signal });
        signal.throwIfAborted();
        return this.owners.runtime.readyChildSource({ executionId: child.execution_id,
          source: { mode: child.selected_profile.work_mode === 'read_only' ? 'fixed_branch' : 'materialized', liveRoot: null,
            workspaceId: workspace, executionWorkspaceId: basis.source.execution_workspace_id, branchId, revision: 0 },
          pin: { pin_id: retained.pinId, root: retained.root, source: { mode: 'fixed_branch', live_root: null,
            workspace_id: workspace, execution_workspace_id: basis.source.execution_workspace_id, branch_id: branchId, revision: 0 } },
          provenance: basis.provenance }, signal);
      } finally { await pin.release(); }
    }, 'shared', { threadId: child.child_thread_id });
  }
  private async settle(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution> {
    if (!child.receipt || child.source?.kind !== 'ready' || child.source.selection.mode !== 'materialized') return child;
    const { kernel, runtime, storageAdapter, resolveLiveSource } = this.owners;
    const source = this.childSource(child);
    if (source.mode !== 'materialized') throw new Error('Writable child lost its private source');
    const runId = child.receipt.run_id;
    const publicationId = `child-result:${child.execution_id}`;
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
    if (child.resources_released || (!child.receipt && !child.report) || (child.source?.kind !== 'ready' && !child.report)) return;
    const { kernel, runtime } = this.owners;
    if (child.trigger.kind !== 'dispatch') {
      if (!child.receipt && child.source_basis) {
        await this.owners.workingStates.withBranchStore(child.source_basis.source.workspace_id, 'child-unused-continuation-source', async store => {
          if (!store.releaseBranchHandoffPin) throw new Error('Durable source pin release is unavailable');
          const branchId = `child-source:${child.execution_id}`;
          const branch = await store.getBranchRoot(branchId);
          if (branch) {
            if (branch.baseRoot !== child.source_basis!.root) throw new Error('Unused continuation source identity changed');
            await store.releaseBranchHandoffPin(branchId, `child-source-pin:${child.execution_id}`);
            await store.deleteBranch(branchId);
          }
        }, 'shared', { threadId: child.child_thread_id });
      }
      signal.throwIfAborted();
      await runtime.releaseChildResources(child.execution_id, signal);
      return;
    }
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
      await runtime.releaseChildResources(child.execution_id, signal);
    } finally { await kernel.revokeGrant(grant.grantId); }
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
          : prepareContext(identity, source, { mode: 'agent', threadRole: 'worker', projectId: child.project_id, childProfile: child.selected_profile }), signal);
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
        if (source.mode === 'live_root') throw new Error('Child source is not isolated');
        child = await runtime.prepareChild({ executionId: child.execution_id, source: { mode: source.mode, liveRoot: null,
          workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, branchId: source.branchId, revision: source.revision },
          context, expectedContextCheckpoint: checkpoint?.id ?? null, ...(inputPreparation ? { inputPreparation } : {}) }, signal);
      }
      if (child.receipt && child.state === 'ready') await this.owners.continueRun(child.receipt.run_id, signal);
      if (child.report && child.receipt && ['pending', 'settling', 'candidate'].includes(child.code_result.kind)) child = await this.settle(child, signal);
    } catch (error) {
      // A current definition/Goal pause can arrive after source preparation but before the
      // original submission transaction. Keep this exact pending execution for its next event.
      if (error instanceof KernelClientError && error.code === 'activation-held') return;
      if (!signal.aborted) {
        const current = await runtime.childExecution(child.execution_id);
        // An admitted Run's unknown effects remain recoverable; preparation failure cannot erase them.
        if (!current.receipt && !current.report) child = await runtime.failChild(child.execution_id, 'preparation_failed');
      }
      throw error;
    } finally {
      if (!ownerSignal.aborted) {
        child = await runtime.childExecution(child.execution_id, ownerSignal);
        if (child.report && child.trigger.kind === 'dispatch') this.owners.kernel.releaseChildToolHandoff(child.parent_run_id, child.child_operation_id);
        await this.releaseHandoff(child, ownerSignal);
        if (child.report && child.receipt && ['published', 'no_changes', 'unavailable'].includes(child.code_result.kind)) await runtime.retireSourceGrants(child.receipt.run_id);
      }
    }
  }
}
