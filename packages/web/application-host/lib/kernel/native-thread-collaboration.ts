import { waitWithSignal } from '../cancellation.js';
import type { NativeThreadIdentity, NativeThreadSource } from '@varin/application-client';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import type { NativeThreadModelAuthority } from './native-thread-adapter.js';
import type { NativeContextPreparer } from './native-thread-context.js';
import type { NativeRuntimeClient } from './native-runtime-client.js';
import type { NativeChildTask, NativeModelSessionConfiguration } from './protocol.generated.js';

interface Owners {
  runtime: NativeRuntimeClient;
  models: NativeThreadModelAuthority;
  workingStates: WorkspaceWorkingStateRootAccess;
  prepareContext: NativeContextPreparer;
  admitSource(source: NativeThreadSource, identity: NativeThreadIdentity): Promise<void>;
  onError(operationId: string | undefined, error: unknown): void;
}
/** Consumes committed child facts, including startup backlog. Maps hold only cancellable live
 * work; Catalog owns task identities, preparation receipts, reports and Wait delivery. */
export class NativeThreadCollaboration {
  private readonly tasks = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private readonly launching = new Set<string>();
  private readonly cleaningSources = new Set<string>();
  private readonly startedRuns = new Set<string>();
  private readonly removers: Array<() => void>;
  private epoch = new AbortController();
  private stopped = false;
  private suspended = false;
  private pumping = false;
  private dirty = false;
  constructor(private readonly owners: Owners) {
    const runtime = owners.runtime;
    this.removers = [runtime.onEvent(event => {
      if (event.stream !== 'durable') return;
      this.resumeEpoch(); void this.recover();
    }), runtime.onExit(() => {
      this.suspended = true; this.epoch.abort();
      for (const task of this.tasks.values()) task.controller.abort();
      this.tasks.clear(); this.launching.clear(); this.startedRuns.clear();
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
        const resumed = await this.owners.runtime.reconcileChildren(epoch.signal);
        const children = await this.owners.runtime.children(epoch.signal);
        const unaccepted = await this.owners.runtime.unacceptedChildSources(epoch.signal);
        for (const source of unaccepted) {
          if (this.cleaningSources.has(source.operation_id)) continue;
          this.cleaningSources.add(source.operation_id);
          void this.owners.workingStates.withBranchStore(source.source.workspace_id, 'native-child-orphan-release', async store => {
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
          if (child.report) this.tasks.get(child.operation_id)?.controller.abort();
          if (!this.tasks.has(child.operation_id) && (!child.resources_released || child.state === 'preparing' || child.state === 'ready' || Boolean(child.report && child.receipt))) {
            const controller = new AbortController();
            const signal = AbortSignal.any([epoch.signal, controller.signal]);
            const task = { controller, work: Promise.resolve() };
            this.tasks.set(child.operation_id, task);
            task.work = this.advance(child, signal, epoch.signal).catch(error => {
              if (!signal.aborted) this.owners.onError(child.operation_id, error);
            }).finally(() => { if (this.tasks.get(child.operation_id) === task) this.tasks.delete(child.operation_id); });
          }
        }
        for (const runId of resumed) void this.resumeRun(runId, epoch.signal).catch(error => {
          if (!epoch.signal.aborted) this.owners.onError(undefined, error);
        });
      }
    } catch (error) {
      if (!epoch.signal.aborted) this.owners.onError(undefined, error);
    } finally { this.pumping = false; }
  }
  private async advance(admitted: NativeChildTask, signal: AbortSignal, ownerSignal: AbortSignal): Promise<void> {
    const { runtime, workingStates, prepareContext } = this.owners;
    let child = admitted;
    try {
      if (child.state === 'preparing' && !child.receipt) {
        const fixed = child.source_pin.source;
        if (fixed.mode !== 'fixed_branch' || fixed.branch_id === null || fixed.revision === null) throw new Error('Child source is not fixed');
        const sourceBranch = `native-child-source:${child.operation_id}`;
        await workingStates.withBranchStore(fixed.workspace_id, 'native-child-source', async store => {
          if (!store.openBranchHandoffPin) throw new Error('Durable source pins are unavailable');
          const pin = await store.openBranchHandoffPin(fixed.branch_id!, child.source_pin.pin_id,
            { root: child.source_pin.root, revision: fixed.revision!, writeRevision: fixed.revision! }, signal);
          signal.throwIfAborted();
          const branch = await store.createBranchFromPin(fixed.workspace_id, sourceBranch, pin, `${fixed.branch_id}@${fixed.revision}`);
          if (branch.baseRoot !== child.source_pin.root) throw new Error('Child source root changed');
          signal.throwIfAborted();
        }, 'shared', { threadId: child.child_thread_id });
        const tools = child.launch.tools.map(tool => {
          const kind = tool.name.replace(/^native_/, '');
          if (kind !== 'file_read' && kind !== 'file_list' && kind !== 'file_search') throw new Error('Child profile contains an unadmitted capability');
          return kind;
        });
        const source: NativeThreadSource = { mode: 'fixed_branch', workspaceId: fixed.workspace_id,
          executionWorkspaceId: fixed.execution_workspace_id, branchId: sourceBranch, revision: 0, tools };
        const identity: NativeThreadIdentity = { runtime: 'nativeThread', threadId: child.child_thread_id, branchId: child.child_branch_id };
        const context = await waitWithSignal(prepareContext(identity, source, { mode: 'agent', threadRole: 'worker', projectId: child.project_id }), signal);
        signal.throwIfAborted();
        child = await runtime.prepareChild({ operationId: child.operation_id, source: { mode: 'fixed_branch', liveRoot: null,
          workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, branchId: sourceBranch, revision: 0 }, context }, signal);
      }
      if (child.receipt && child.state === 'ready') await this.resumeRun(child.receipt.run_id, signal);
    } catch (error) {
      if (!signal.aborted) {
        const current = await runtime.child(child.operation_id);
        if (!current.report) {
          if (current.receipt) await runtime.failLaunch(current.receipt.run_id, 'preparation_failed');
          child = await runtime.failChild(child.operation_id, 'preparation_failed');
        } else child = current;
      }
      throw error;
    } finally {
      // Cancelling preparation detaches its wait, not its resource cleanup. Epoch loss instead
      // leaves the durable cleanup fact for the new Host; late old-owner work cannot publish.
      if (!ownerSignal.aborted) {
        child = await runtime.child(child.operation_id, ownerSignal);
        if (child.report && child.receipt) await runtime.releaseSourceGrants(child.receipt.run_id);
        if (!child.resources_released && (child.receipt || child.report)) {
          const fixed = child.source_pin.source;
          await workingStates.withBranchStore(fixed.workspace_id, 'native-child-release', async store => {
            if (!store.releaseBranchHandoffPin) throw new Error('Durable source pin release is unavailable');
            await store.releaseBranchHandoffPin(fixed.branch_id!, child.source_pin.pin_id);
            if (!child.receipt) {
              const branchId = `native-child-source:${child.operation_id}`;
              if (await store.getBranchRoot(branchId)) await store.deleteBranch(branchId);
            }
          }, 'shared', { threadId: child.child_thread_id });
          ownerSignal.throwIfAborted();
          await runtime.releaseChildResources(child.operation_id, ownerSignal);
        }
      }
    }
  }
  private async resumeRun(runId: string, signal: AbortSignal): Promise<void> {
    if (this.launching.has(runId)) return;
    this.launching.add(runId);
    try {
      const { runtime, models } = this.owners;
      const run = await runtime.run(runId, signal);
      if (run.cancel_requested || ['completed', 'failed', 'cancelled', 'generating', 'executing'].includes(run.state)
        || (run.state === 'waiting' && !run.waiting_on?.startsWith('recovery:'))) return;
      const launch = await runtime.launch(runId, signal);
      if (!launch?.selection.credential_scope) throw new Error('Native child/continuation has no exact credential scope');
      // A still-owned worker is not a reason to release its live credential binding.
      if (!launch.requires_rebind && this.startedRuns.has(runId)) return;
      const source = launch.selection.source;
      if (source?.mode === 'fixed_branch' && source.branch_id !== null && source.revision !== null) {
        const child = await runtime.childForThread(run.thread_id, signal);
        if (child) await this.owners.workingStates.withBranchStore(source.workspace_id, 'native-child-source-check', async store => {
          const pin = await store.pinBranch(source.branch_id!, { revision: source.revision!, signal });
          try { if (pin.root !== child.source_pin.root) throw new Error('Child fixed source no longer matches its admitted root'); }
          finally { await pin.release(); }
        }, 'shared', { threadId: run.thread_id });
        await waitWithSignal(this.owners.admitSource({ mode: 'fixed_branch', workspaceId: source.workspace_id,
          executionWorkspaceId: source.execution_workspace_id, branchId: source.branch_id, revision: source.revision, tools: [] },
        { runtime: 'nativeThread', threadId: run.thread_id, branchId: run.branch_id }), signal);
      }
      const owner = await waitWithSignal(models.rebindModel(run.configuration as NativeModelSessionConfiguration, launch.selection.credential_scope), signal);
      signal.throwIfAborted();
      if (run.state === 'runnable') runtime.releaseRunCredentialOwner(runId);
      await runtime.rebindLaunch(runId, { credentialOwner: owner, signal });
      this.startedRuns.add(runId);
    } finally { this.launching.delete(runId); }
  }
}
