import { waitWithSignal } from '../cancellation.js';
import type { ThreadIdentity, ThreadSource } from '@varin/application-client';
import type { WorkspaceWorkingStateRootAccess } from '../harness/working-state/types.js';
import type { ContextPreparer } from './thread-context.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ChildTask } from './protocol.generated.js';

interface Owners {
  runtime: AgentRuntimeClient;
  continueRun(runId: string, signal: AbortSignal): Promise<void>;
  recoverLaunches(signal: AbortSignal): Promise<void>;
  workingStates: WorkspaceWorkingStateRootAccess;
  prepareContext: ContextPreparer;
  onError(operationId: string | undefined, error: unknown): void;
}
/** Consumes committed child/process-wait facts, including startup backlog. Maps hold only cancellable live
 * work; Catalog owns task identities, preparation receipts, reports and Wait delivery. */
export class ThreadCollaboration {
  private readonly tasks = new Map<string, { controller: AbortController; work: Promise<void> }>();
  private readonly cleaningSources = new Set<string>();
  private readonly removers: Array<() => void>;
  private epoch = new AbortController();
  private stopped = false;
  private suspended = false;
  private pumping = false;
  private dirty = false;
  private launchCursor: number | undefined;
  constructor(private readonly owners: Owners) {
    const runtime = owners.runtime;
    this.removers = [runtime.onEvent(event => {
      if (event.stream !== 'durable') return;
      this.resumeEpoch(); void this.recover();
    }), runtime.onExit(() => {
      this.suspended = true; this.epoch.abort();
      for (const task of this.tasks.values()) task.controller.abort();
      this.tasks.clear(); this.launchCursor = undefined;
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
      // Capture before discovery so a resume committed during discovery is read on the next pass.
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
        const data = event.data as { run_id?: unknown } | null;
        if (event.kind === 'policy.resumed' && data && typeof data.run_id === 'string') {
          void this.owners.continueRun(data.run_id, signal).catch(error => {
            if (!signal.aborted) this.owners.onError(undefined, error);
          });
        }
        this.launchCursor = event.cursor;
      }
    } while (events.length === 256);
  }
  private async advance(admitted: ChildTask, signal: AbortSignal, ownerSignal: AbortSignal): Promise<void> {
    const { runtime, workingStates, prepareContext } = this.owners;
    let child = admitted;
    try {
      if (child.state === 'preparing' && !child.receipt) {
        const fixed = child.source_pin.source;
        if (fixed.mode !== 'fixed_branch' || fixed.branch_id === null || fixed.revision === null) throw new Error('Child source is not fixed');
        const sourceBranch = `child-source:${child.operation_id}`;
        await workingStates.withBranchStore(fixed.workspace_id, 'child-source', async store => {
          if (!store.openBranchHandoffPin) throw new Error('Durable source pins are unavailable');
          const pin = await store.openBranchHandoffPin(fixed.branch_id!, child.source_pin.pin_id,
            { root: child.source_pin.root, revision: fixed.revision!, writeRevision: fixed.revision! }, signal);
          signal.throwIfAborted();
          const branch = await store.createBranchFromPin(fixed.workspace_id, sourceBranch, pin, `${fixed.branch_id}@${fixed.revision}`);
          if (branch.baseRoot !== child.source_pin.root) throw new Error('Child source root changed');
          signal.throwIfAborted();
        }, 'shared', { threadId: child.child_thread_id });
        const tools = child.launch.tools.map(tool => {
          const kind = tool.name;
          if (kind !== 'file_read' && kind !== 'file_list' && kind !== 'file_search') throw new Error('Child profile contains an unadmitted capability');
          return kind;
        });
        const source: ThreadSource = { mode: 'fixed_branch', workspaceId: fixed.workspace_id,
          executionWorkspaceId: fixed.execution_workspace_id, branchId: sourceBranch, revision: 0, tools };
        const identity: ThreadIdentity = { runtime: 'agent', threadId: child.child_thread_id, branchId: child.child_branch_id };
        const context = await waitWithSignal(prepareContext(identity, source, { mode: 'agent', threadRole: 'worker', projectId: child.project_id }), signal);
        signal.throwIfAborted();
        child = await runtime.prepareChild({ operationId: child.operation_id, source: { mode: 'fixed_branch', liveRoot: null,
          workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, branchId: sourceBranch, revision: 0 }, context }, signal);
      }
      if (child.receipt && child.state === 'ready') await this.owners.continueRun(child.receipt.run_id, signal);
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
          await workingStates.withBranchStore(fixed.workspace_id, 'child-release', async store => {
            if (!store.releaseBranchHandoffPin) throw new Error('Durable source pin release is unavailable');
            await store.releaseBranchHandoffPin(fixed.branch_id!, child.source_pin.pin_id);
            if (!child.receipt) {
              const branchId = `child-source:${child.operation_id}`;
              if (await store.getBranchRoot(branchId)) await store.deleteBranch(branchId);
            }
          }, 'shared', { threadId: child.child_thread_id });
          ownerSignal.throwIfAborted();
          await runtime.releaseChildResources(child.operation_id, ownerSignal);
        }
      }
    }
  }
}
