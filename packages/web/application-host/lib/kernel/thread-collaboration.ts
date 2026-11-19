import { isDeepStrictEqual } from 'node:util';
import { releaseManagedChildDerivations } from './managed-child-mcp-preparation.js';
import { releaseManagedChildDependencies } from './managed-mcp-child-retention.js';
import { preparationFailure } from './preparation-failure.js';
import { parseExplicitSkillCommand } from '../agent-resources/activation.js';
import { ResourceScopeError } from './thread-resource-scope.js';
import type { ThreadSkillInputPreparer } from './thread-skill-input.js';
import { randomUUID } from 'node:crypto';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import { captureContinuationStage, prepareChildSourceStore, prepareContinuationSourceStore, prepareRefreshedContinuationSourceStore, releaseRefreshScratch } from './child-source-store.js';
import { withManagedChildSource, releaseManagedUnacceptedSource, type ChildSourcePreparation } from './managed-source-collaboration.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from './storage-adapter.js';
import type { LiveSourceResolver } from './live-source.js';
import { type StableSourcePreparationOwners } from '../harness/working-state/source-preparation.js';
import { isAbortError, waitWithSignal } from '../cancellation.js';
import { createChildPhysicalCapture, type ChildPhysicalCapture } from './child-source-capture.js';
import { requireNativeWorkspaceBackend } from './native-workspaces.js';
import type { ThreadIdentity, ThreadSource } from '@varin/application-client';
import type { DocumentAuthority } from '../documents/authority.js';
import type { ContextPreparer } from './thread-context.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ChildPreparationProgress, DelegatedExecution, InputResourcePreparation, KernelWorkingResultCandidate, RuntimeEvent, SourceResourceOwner, UnacceptedChildDependencies } from './protocol.generated.js';
import type { ManagedHostSourceOwner } from '../harness/managed-remote-types.js';

export interface ThreadCollaborationOwners {
  prepareProjectSource?: import('./child-project-source.js').ChildProjectSourcePreparer;
  kernel: KernelClient;
  storageAdapter: KernelStorageAdapter;
  resolveLiveSource: LiveSourceResolver;
  sourceCaptureOwners: StableSourcePreparationOwners & { documents: Pick<DocumentAuthority, 'admitWorkspaceRegistration'> };
  runtime: AgentRuntimeClient;
  continueRun(runId: string, signal: AbortSignal): Promise<void>;
  canExecuteThread?(threadId: string, botSubjects?: ReadonlySet<string>): Promise<boolean>;
  recoverLaunches(signal: AbortSignal): Promise<void>;
  recoverColdBotWork?(signal: AbortSignal): Promise<void>;
  onWorkChanged?(): void;
  recoverCheckpoints?(signal: AbortSignal): Promise<void>;
  settleRunCheckpoints?(runId: string, signal: AbortSignal): Promise<void>;
  prepareContext: ContextPreparer;
  prepareModel?(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution>;
  prepareSkillInput?: ThreadSkillInputPreparer;
  prepareMaterials?(threadId: string, signal: AbortSignal): Promise<void>;
  reconcileDomainReceipts?(signal: AbortSignal): Promise<void>;
  onError(operationId: string | undefined, error: unknown, stage: string): void;
}

const childWakeEvents = new Set(['child.accepted', 'child.execution_accepted', 'child.report_ready', 'child.cancel_requested']);
const writerStoppedEvents = new Set(['operation.executor_stopped', 'operation.kernel_executor_stopped', 'operation.invocation_executor_stopped']);
const dispatchExecutors = new Set(['dispatch', 'code_retrieval', 'user_dispatch']);
const arrangementChanges = new Set(['calendar.definition_changed', 'followup.changed', 'followup.source_status_changed']);
const dependencyCleanupPending = 'child.dependencies_cleanup_pending';
const childScopeChanges = new Set(['operation.settled', 'goal.changed', 'bot.execution_gate_published', 'mcp.resource_holder_released', 'mcp.resource_source_retired']);

function mcpSourceOwners(selection: DelegatedExecution['launch']['mcp_binding']): SourceResourceOwner[] {
  return Object.values(selection?.provenance.servers ?? {}).map(server => server.owner.resource_owner);
}

function childSourceOwners(child: DelegatedExecution): (SourceResourceOwner | undefined)[] {
  return [child.launch.source?.resource_owner, child.source_basis?.source.resource_owner,
    child.source_basis?.kind === 'refreshed' ? child.source_basis.incoming.source.resource_owner : undefined,
    child.source?.kind !== 'absent' ? child.source?.handoff?.source.resource_owner : undefined,
    child.source?.kind === 'ready' || child.source?.kind === 'shared' ? child.source.selection.resource_owner : undefined,
    ...mcpSourceOwners(child.launch.mcp_binding)];
}

function affectsChild(child: DelegatedExecution, event: RuntimeEvent): boolean {
  if (childWakeEvents.has(event.kind)) return event.subject === child.execution_id;
  if (event.kind === 'goal.changed')
    return !child.report && (event.branch_id === child.child_branch_id || event.branch_id === child.parent_branch_id);
  if (arrangementChanges.has(event.kind)) {
    if (child.report || child.receipt) return false;
    return event.kind === 'calendar.definition_changed'
      ? child.trigger.kind === 'calendar' && child.trigger.definition_id === event.subject
      : child.trigger.kind === 'followup' && child.trigger.followup_id === event.subject;
  }
  if (!child.receipt || event.branch_id !== child.child_branch_id) return false;
  const runId = (event.data as { run_id?: string } | null)?.run_id;
  if (writerStoppedEvents.has(event.kind)) return !runId || runId === child.receipt.run_id;
  if (event.kind === 'mcp.resource_source_retired') return Boolean(child.report) && event.subject === child.receipt.run_id;
  if (event.kind === 'mcp.resource_holder_released') return Boolean(child.report);
  return Boolean(child.report) && event.kind === 'operation.settled' && runId === child.receipt.run_id;
}

interface ReachedSource {
  owner: ManagedHostSourceOwner;
  active: ReadonlySet<string>;
}
/** Consumes committed child/process-wait/follow-up facts, including startup backlog. Maps hold only cancellable live
 * work; Catalog owns task identities, preparation receipts, reports and Wait delivery. */
export class ThreadCollaboration {
  private readonly capturePhysical: ChildPhysicalCapture;
  private readonly tasks = new Map<string, { controller: AbortController; work: Promise<void>; revision: number; preparing: boolean; recheck: boolean }>();
  private readonly cleaningSources = new Map<string, Promise<void>>();
  private readonly retiringThreads = new Set<string>();
  private readonly removers: Array<() => void>;
  private epoch = new AbortController();
  private stopped = false;
  private suspended = false;
  private pumping = false;
  private dirty = false;
  private discoverPending = false;
  private readonly reachedSources: ReachedSource[] = [];
  private readonly recheckChildren = new Set<string>();
  private domainRecoveryNeeded = true;
  private domainRecovery: Promise<void> | undefined;
  private launchCursor: number | undefined;
  constructor(private readonly owners: ThreadCollaborationOwners) {
    this.capturePhysical = createChildPhysicalCapture(owners.kernel, owners.storageAdapter, owners.sourceCaptureOwners);
    const runtime = owners.runtime;
    this.removers = [runtime.onEvent(event => {
      if (event.stream === 'resync') { this.resumeEpoch(); void this.recover(); }
      if (event.stream === 'durable') { this.resumeEpoch(); void this.pump(); }
    }), runtime.onExit(() => {
      this.suspended = true; this.epoch.abort();
      for (const task of this.tasks.values()) task.controller.abort();
      this.tasks.clear(); this.cleaningSources.clear(); this.recheckChildren.clear(); this.reachedSources.length = 0;
      this.launchCursor = undefined; this.domainRecoveryNeeded = true;
    }), runtime.onReady(() => { this.resumeEpoch(); void this.recover(); })];
  }
  private resumeEpoch(): void {
    if (!this.suspended || this.stopped) return;
    this.epoch = new AbortController(); this.suspended = false;
  }
  /** A real Source connection recovery makes original domain receipts readable again.
   * Preserve a wake arriving during discovery; the existing owner coalesces its next pass. */
  sourceReached(owner?: ManagedHostSourceOwner): void {
    this.domainRecoveryNeeded = true;
    // An attempt can announce reachability while resolving its own connection.
    // It is already using that connection and must not wake itself.
    if (owner) this.reachedSources.push({ owner, active: new Set([...this.tasks.keys(), ...this.cleaningSources.keys()]) });
    void this.pump();
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
    const sources = await this.owners.runtime.unacceptedChildDependencies(this.epoch.signal);
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
      for (const source of await this.owners.runtime.unacceptedChildDependencies(signal)) {
        if (!threadIds.has(source.parent_thread_id)) continue;
        const active = this.cleaningSources.get(source.operation_id);
        if (active) await active;
        // Re-read the original receipt after joining; failed release stays retryable.
        if (!(await this.owners.runtime.unacceptedChildDependencies(signal)).some(current => current.operation_id === source.operation_id)) continue;
        await this.releaseUnacceptedSource(source, signal);
      }
    } finally {
      for (const id of threadIds) this.retiringThreads.delete(id);
    }
  }
  /** Registration precedes discovery. Real events drive subsequent passes; no idle polling. */
  async recover(): Promise<void> {
    this.discoverPending = true;
    await this.pump();
  }

  private recoverDomainReceipts(): void {
    if (!this.domainRecoveryNeeded || this.domainRecovery || this.stopped || this.suspended || !this.owners.reconcileDomainReceipts) return;
    this.domainRecoveryNeeded = false;
    const signal = this.epoch.signal;
    this.domainRecovery = this.owners.reconcileDomainReceipts(signal).catch(error => {
      if (!signal.aborted) this.owners.onError(undefined, error, 'Recover domain receipts');
    }).finally(() => {
      this.domainRecovery = undefined;
      this.recoverDomainReceipts();
    });
  }

  private async pump(): Promise<void> {
    if (this.stopped || this.suspended) return;
    this.dirty = true;
    if (this.pumping) return;
    this.pumping = true;
    const epoch = this.epoch;
    try {
      while (this.dirty && !epoch.signal.aborted) {
        this.dirty = false;
        // Capture before discovery. A child or saved launch admitted while a
        // startup scan is in flight will still be picked up by event replay.
        const fromCursor = this.launchCursor ?? (await this.owners.runtime.status(epoch.signal)).eventCursor;
        epoch.signal.throwIfAborted();
        const discoverPending = this.discoverPending;
        this.discoverPending = false;
        const reached = this.reachedSources.splice(0);
        const recheck = new Set(this.recheckChildren);
        this.recheckChildren.clear();
        this.recoverDomainReceipts();
        let resumed: string[] | undefined;
        try { resumed = await this.owners.runtime.reconcileObservations(epoch.signal); }
        catch (error) {
          // The native owner can commit independent ready work while preserving another
          // observation's error. Original saved launches/events still require discovery.
          if (!epoch.signal.aborted) this.owners.onError(undefined, error, 'Reconcile observations');
        }
        epoch.signal.throwIfAborted();
        if (discoverPending) await this.recoverChildren(true, [], [], new Set(), epoch.signal);
        const changes: RuntimeEvent[] = [];
        try { await this.discoverLaunches(epoch.signal, fromCursor, changes); }
        catch (error) {
          if (!epoch.signal.aborted) this.owners.onError(undefined, error, 'Replay collaboration changes');
        }
        epoch.signal.throwIfAborted();
        this.recoverDomainReceipts();
        if (changes.length || reached.length || recheck.size)
          await this.recoverChildren(false, changes, reached, recheck, epoch.signal);
        await this.owners.recoverColdBotWork?.(epoch.signal);
        for (const runId of resumed ?? []) void this.continueRun(runId, epoch.signal).catch(error => {
          if (!epoch.signal.aborted) this.owners.onError(runId, error, 'Resume observed Run');
        });
      }
    } catch (error) {
      if (!epoch.signal.aborted) this.owners.onError(undefined, error, 'Discover collaboration changes');
    } finally {
      this.pumping = false;
      if (this.dirty && !this.stopped && !this.suspended) void this.pump();
    }
  }

  private async recoverChildren(all: boolean, changes: readonly RuntimeEvent[], reached: readonly ReachedSource[],
    recheck: ReadonlySet<string>, signal: AbortSignal): Promise<void> {
    const { runtime, kernel, canExecuteThread } = this.owners;
    const gates = new Set(changes.filter(event => event.kind === 'bot.execution_gate_published'
      && (event.data as { permitted?: boolean } | null)?.permitted).map(event => event.subject));
    const dispatches = new Set(changes.filter(event => event.kind === dependencyCleanupPending || (event.kind === 'operation.settled'
      && dispatchExecutors.has(String((event.data as { executor?: unknown } | null)?.executor)))).map(event => event.subject));
    const hasSource = (id: string, owners: (SourceResourceOwner | undefined)[]) => reached.some(source =>
      !source.active.has(id) && owners.some(owner => isDeepStrictEqual(owner, source.owner)));
    const onError = (id: string | undefined, error: unknown, stage: string) => {
      if (!signal.aborted) this.owners.onError(id, error, stage);
    };
    if (all || changes.some(event => childWakeEvents.has(event.kind))) {
      try { await kernel.reconcileChildToolHandoffs(signal); }
      catch (error) { onError(undefined, error, 'Discover retained child handoffs'); }
    }
    signal.throwIfAborted();
    if (all || dispatches.size || gates.size || reached.length) {
      let unaccepted: UnacceptedChildDependencies[] = [];
      try { unaccepted = await runtime.unacceptedChildDependencies(signal, all || gates.size || reached.length ? undefined : [...dispatches]); }
      catch (error) { onError(undefined, error, 'Discover unaccepted child dependencies'); }
      signal.throwIfAborted();
      for (const source of unaccepted) {
        const id = source.operation_id;
        if (this.cleaningSources.has(id)) continue;
        const matches = all || dispatches.has(id) || hasSource(id, [source.source_pin?.source.resource_owner, ...mcpSourceOwners(source.mcp_binding)]);
        if (!matches && (!canExecuteThread || !gates.size)) continue;
        try {
          if (canExecuteThread && !await canExecuteThread(source.parent_thread_id, matches ? undefined : gates)) continue;
          signal.throwIfAborted();
          const cleanup = this.releaseUnacceptedSource(source, signal).catch(error => {
            onError(id, error, 'Release unaccepted child dependencies');
          }).finally(() => { if (this.cleaningSources.get(id) === cleanup) this.cleaningSources.delete(id); });
          this.cleaningSources.set(id, cleanup);
        } catch (error) { onError(id, error, 'Check parent execution gate'); }
      }
    }
    const wholeQueue = all || reached.length > 0 || gates.size > 0 || changes.some(event => arrangementChanges.has(event.kind));
    const executionIds = new Set(recheck), branchIds = new Set<string>();
    for (const event of changes) {
      if (childWakeEvents.has(event.kind)) executionIds.add(event.subject);
      else if (event.branch_id) branchIds.add(event.branch_id);
    }
    if (!wholeQueue && !executionIds.size && !branchIds.size) return;
    let executions: DelegatedExecution[];
    try {
      executions = await runtime.childExecutions(undefined, signal, {
        pendingOnly: true, ...(wholeQueue ? {} : { executionIds: [...executionIds], branchIds: [...branchIds] }),
      });
    }
    catch (error) { onError(undefined, error, 'Discover pending child executions'); return; }
    signal.throwIfAborted();
    for (const child of executions) {
      const id = child.execution_id;
      if (this.retiringThreads.has(child.child_thread_id) || child.resources_released && child.report
        && !(child.receipt && ['pending', 'settling', 'candidate'].includes(child.code_result.kind))) continue;
      const changed = changes.some(event => affectsChild(child, event));
      const matches = all || changed || recheck.has(id) || reached.length > 0 && hasSource(id, childSourceOwners(child));
      if (!matches && (!canExecuteThread || !gates.size)) continue;
      try {
        if (canExecuteThread && !await canExecuteThread(child.child_thread_id, matches ? undefined : gates)) continue;
        signal.throwIfAborted();
      } catch (error) { onError(id, error, 'Check child execution gate'); continue; }
      const active = this.tasks.get(id);
      if (active) {
        if (child.report && active.preparing) { active.recheck = true; active.controller.abort(); }
        if (changed || !matches || child.revision > active.revision) active.recheck = true;
        continue;
      }
      const controller = new AbortController();
      const taskSignal = AbortSignal.any([signal, controller.signal]);
      const task = { controller, work: Promise.resolve(), revision: child.revision, preparing: !child.report, recheck: false };
      this.tasks.set(id, task);
      task.work = this.advance(child, taskSignal, signal, (error, stage) => onError(id, error, stage)).finally(() => {
        if (this.tasks.get(id) !== task) return;
        this.tasks.delete(id);
        if (task.recheck && !signal.aborted) { this.recheckChildren.add(id); void this.pump(); }
      });
    }
  }
  /** A stale background wake can lose its preparation to this exact terminal Run.
   * Join the original Host work before recognizing that no-op; an abort/request
   * alone proves neither successful preparation nor native/resource stop. */
  private async continueRun(runId: string, signal: AbortSignal): Promise<void> {
    try { await this.owners.continueRun(runId, signal); }
    catch (error) {
      if (signal.aborted || !isAbortError(error)) throw error;
      const settled = this.owners.kernel.runPreparationCancellation(runId, error);
      if (!settled) throw error;
      await waitWithSignal(settled, signal);
      let run;
      try { run = await this.owners.runtime.run(runId, signal); }
      catch (readError) { throw new AggregateError([error, readError], 'Cannot verify cancelled Run preparation'); }
      if (run.id !== runId || !['completed', 'cancelled', 'failed'].includes(run.state)) throw error;
    }
  }
  private async discoverLaunches(signal: AbortSignal, fromCursor: number, changes: RuntimeEvent[]): Promise<void> {
    const { runtime } = this.owners;
    if (this.launchCursor === undefined) {
      // The cursor predates the pending scan, so changes committed while it was reading are replayed.
      await this.owners.recoverLaunches(signal);
      await this.owners.recoverCheckpoints?.(signal);
      signal.throwIfAborted();
      this.launchCursor = fromCursor;
    }
    let events;
    do {
      events = await runtime.events(this.launchCursor, 256, signal);
      signal.throwIfAborted();
      if (events.some(event => event.kind.startsWith('followup.') || ['bot.matter.updated', 'bot.work_queued', 'child.accepted', 'child.report_ready', 'ingress.run_ready', 'ingress.preparation_hold', 'run.changed', 'thread.deleted'].includes(event.kind)
        || event.kind === 'execution.committed' && (event.data as { kind?: string })?.kind === 'state_changed')) this.owners.onWorkChanged?.();
      for (const event of events) {
        if (event.kind === dependencyCleanupPending || childWakeEvents.has(event.kind) || writerStoppedEvents.has(event.kind)
          || childScopeChanges.has(event.kind) || arrangementChanges.has(event.kind)) changes.push(event);
        if (event.kind.startsWith('operation.')) this.domainRecoveryNeeded = true;
        if (event.kind === 'run.cancel_requested') this.owners.kernel.cancelRunPreparation(event.subject);
        if (event.kind === 'run.changed' || event.kind === 'run.failed'
          || event.kind === 'execution.committed' && ['state_changed', 'context_preparation_failed', 'execution_failed'].includes(String((event.data as { kind?: string })?.kind))) {
          void this.owners.settleRunCheckpoints?.(event.subject, signal).catch(error => {
            if (!signal.aborted) this.owners.onError(event.subject, error, 'Settle Run checkpoints');
          });
        }
        const data = event.data as { run_id?: unknown } | null;
        if ((event.kind === 'policy.resumed' || event.kind === 'ingress.run_ready' || event.kind === 'goal.run_ready' || event.kind === 'observation.run_ready') && data && typeof data.run_id === 'string') {
          const runId = data.run_id;
          void this.continueRun(runId, signal).catch(error => {
            if (!signal.aborted) this.owners.onError(runId, error, 'Continue saved Run');
          });
        }
        this.launchCursor = event.cursor;
      }
    } while (events.length === 256);
  }
  private async releaseUnacceptedSource(dependencies: import('./protocol.generated.js').UnacceptedChildDependencies,
    signal: AbortSignal): Promise<void> {
    const pin = dependencies.source_pin;
    if (pin) {
      const source = { ...pin, operation_id: dependencies.operation_id,
        parent_run_id: dependencies.parent_run_id, parent_thread_id: dependencies.parent_thread_id };
      if (pin.source.resource_owner.kind === 'managed_host') {
        await releaseManagedUnacceptedSource(this.owners.runtime, source, signal);
      } else {
        await this.withSourceStore(pin.source, dependencies.parent_thread_id, signal, async (store, client) => {
          if (!store.releaseBranchHandoffPin) throw new Error('Durable source pin release is unavailable');
          const receipt = await client.getOperation(`child-source-handoff:${dependencies.operation_id}`, signal);
          if (!receipt) return;
          if (receipt.kind !== 'source.handoff' || receipt.state !== 'committed') throw new Error('Original source handoff has not settled');
          const handoff = receipt.result as import('./protocol.generated.js').ChildSourceHandoff;
          if (handoff.operation_id !== `child-source-handoff:${dependencies.operation_id}`
            || handoff.source.workspace_id !== pin.source.workspace_id
            || !isDeepStrictEqual(handoff.source.resource_owner, pin.source.resource_owner)) throw new Error('Original source handoff owner changed');
          const retained = handoff.retention_pin ?? (handoff.root.kind === 'fixed' || handoff.root.kind === 'native' || handoff.root.kind === 'derived' ? handoff.root.pin : null);
          if (retained) {
            if (retained.pin_id !== pin.pin_id || !retained.source.branch_id) throw new Error('Original source pin identity changed');
            await store.releaseBranchHandoffPin(retained.source.branch_id, retained.pin_id);
          }
        });
      }
    }
    await releaseManagedChildDependencies(this.owners.runtime, {
      operationId: dependencies.operation_id, parentRunId: dependencies.parent_run_id,
      executionOwner: dependencies.execution_owner, executionEpoch: dependencies.execution_epoch,
    }, dependencies.mcp_binding, signal);
    signal.throwIfAborted();
    await this.owners.runtime.releaseUnacceptedChildDependencies(dependencies.operation_id, signal);
  }
  /** Catalog-selected branch work never acquires a physical project root or tool capability. */
  private async withSourceStore<T>(source: { workspace_id: string; execution_workspace_id: string }, threadId: string,
    signal: AbortSignal, consume: (store: KernelWorkingStateRootStore, client: ReturnType<KernelClient['scoped']>) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const { kernel, storageAdapter } = this.owners;
    const grant = await kernel.issueGrant({ grantId: `child-branch:${randomUUID()}`, threadId,
      owningWorkspace: source.workspace_id, executionWorkspace: source.execution_workspace_id,
      capabilities: ['storage.read', 'storage.write', 'storage.maintenance'], pathScopes: [''] }, signal);
    try {
      const context = await storageAdapter.contextFromBranchGrant({ grant, owningWorkspaceId: source.workspace_id,
        executionWorkspaceId: source.execution_workspace_id });
      signal.throwIfAborted();
      return await consume(new KernelWorkingStateRootStore(context), kernel.scoped(grant));
    } finally { await kernel.revokeGrant(grant.grantId); }
  }
  private async admitSourceRegistrations(source: { workspace_id: string; execution_workspace_id: string }, signal: AbortSignal): Promise<void> {
    const documents = this.owners.sourceCaptureOwners.documents;
    await documents.admitWorkspaceRegistration(source.workspace_id, signal);
    if (source.execution_workspace_id !== source.workspace_id) await documents.admitWorkspaceRegistration(source.execution_workspace_id, signal);
  }
  private childSource(child: DelegatedExecution): ThreadSource | null {
    if (child.source?.kind === 'absent') return null;
    if (child.source?.kind !== 'ready' && child.source?.kind !== 'shared') throw new Error('Child source is not ready');
    const fixed = child.source.selection;
    // A continuation's retained launch template has no source. Hybrid file tools
    // follow its separately prepared child selection without rewriting that template.
    const tools = sourceToolSchemas({ ...child.launch, source: fixed }).map(tool => tool.name as ThreadSource['tools'][number]);
    if (fixed.mode === 'live_root' && fixed.live_root) return {
      resourceOwner: fixed.resource_owner, mode: fixed.mode, liveRoot: fixed.live_root,
      workspaceId: fixed.workspace_id, executionWorkspaceId: fixed.execution_workspace_id, tools,
    };
    if(fixed.mode==='native_workspace'&&fixed.branch_id)return {resourceOwner:fixed.resource_owner,mode:'native_workspace',workspaceId:fixed.workspace_id,
      executionWorkspaceId:fixed.execution_workspace_id,branchId:fixed.branch_id,...(fixed.native_scope?{nativeScope:fixed.native_scope}:{}),tools};
    if ((fixed.mode !== 'fixed_branch' && fixed.mode !== 'materialized') || !fixed.branch_id || fixed.revision === null) throw new Error('Child source is not fixed');
    return { resourceOwner: fixed.resource_owner, mode: fixed.mode, workspaceId: fixed.workspace_id, executionWorkspaceId: fixed.execution_workspace_id,
      branchId: fixed.branch_id, revision: fixed.revision, tools,
      ...(fixed.environment_run_id ? { environmentRunId: fixed.environment_run_id } : {}) };
  }
  private async prepareSource(child: DelegatedExecution, signal: AbortSignal, onProgress?: (progress: ChildPreparationProgress) => void): Promise<DelegatedExecution> {
    if (child.source?.kind === 'project') {
      if (!this.owners.prepareProjectSource) throw new Error('Registered project source preparation is unavailable');
      const identity: ThreadIdentity = { runtime: 'agent', threadId: child.child_thread_id, branchId: child.child_branch_id };
      const prepared = await this.owners.prepareProjectSource(child.source.project, identity, `child-project:${child.execution_id}`,
        child.selected_profile.work_mode, child.source.source_path, signal);
      const source = prepared.source;
      let pin: import('./protocol.generated.js').ChildSourcePin | null = null;
      if (child.selected_profile.work_mode === 'isolated_write') {
        if (source.mode !== 'native_workspace' || !source.branchId) throw new Error('Project has no independent native workspace');
        pin = await this.withSourceStore({ workspace_id: source.workspaceId, execution_workspace_id: source.executionWorkspaceId }, child.child_thread_id, signal,
          async store => {
            const value = await store.pinBranchHandoff!(source.branchId!, `child-source-pin:${child.execution_id}`, { revision: 0, signal });
            return { pin_id: value.pinId, root: value.root, source: { resource_owner: source.resourceOwner, workspace_id: source.workspaceId,
              execution_workspace_id: source.executionWorkspaceId, mode: 'fixed_branch', branch_id: source.branchId!, revision: 0, live_root: null } };
          });
      }
      return this.owners.runtime.readyChildSource({ executionId: child.execution_id, pin, provenance: prepared.provenance ?? null,
        source: { resourceOwner: source.resourceOwner, mode: source.mode, workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId,
          branchId: source.branchId ?? null, revision: source.revision ?? null, liveRoot: source.liveRoot ?? null,
          ...(source.mode === 'native_workspace' && source.nativeScope ? { nativeScope: source.nativeScope } : {}) } }, signal);
    }
    if (child.source?.kind === 'ready' || child.source?.kind === 'shared' || child.source?.kind === 'absent') return child;
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
      if (child.selected_profile.work_mode === 'isolated_write') await requireNativeWorkspaceBackend(kernel.scoped(grant), signal);
      const context = await storageAdapter.contextFromBranchGrant({ grant, owningWorkspaceId: workspace, executionWorkspaceId: handoff.source.execution_workspace_id });
      const prepared = await prepareChildSourceStore(child, {
        store: new KernelWorkingStateRootStore(context), capture: sourceCaptureOwners, capturePhysical: this.capturePhysical, ...(onProgress ? { onProgress } : {}),
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
    } finally { await kernel.revokeGrant(grant.grantId).catch(error => { if (!signal.aborted) this.owners.onError(child.execution_id, error, 'Release child preparation grant'); }); }
  }
  private async prepareContinuationSource(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution> {
    const basis = child.source_basis;
    if (!basis || basis.source.branch_id === null || basis.source.revision === null) throw new Error('Continuation has no exact immutable source');
    await this.admitSourceRegistrations(basis.source, signal);
    return this.withSourceStore(basis.source, child.child_thread_id, signal, async store => {
      if (basis.kind === 'refreshed' && !await store.readSourcePreparation(`child-source:${child.execution_id}`, { signal })) {
        const incoming = basis.incoming;
        if (incoming.source.mode === 'fixed_branch') {
          await captureContinuationStage(child, { store, capture: this.owners.sourceCaptureOwners,nativeWorkspaces:this.owners.kernel.nativeWorkspaces,
            physical: async () => { throw new Error('Fixed source has no physical directory'); } }, incoming.source, undefined, signal);
        } else {
        const launch = await this.owners.runtime.launch(incoming.run_id, signal);
        if (!launch || !isDeepStrictEqual(launch.selection.source, incoming.source)) throw new Error('Selected Agent source changed');
        const admitted = await admitRunSourceAuthority(this.owners.kernel, this.owners.runtime,
          savedSourceLaunch(incoming.run_id, incoming.source, sourceToolSchemas(launch.selection).map(t => t.name)),
          { signal, resolveLiveSource: this.owners.resolveLiveSource });
        try {
          if (admitted.kind !== 'local') throw new Error('Selected source changed resource Host');
          if (child.selected_profile.work_mode === 'isolated_write') await requireNativeWorkspaceBackend(this.owners.kernel.scoped(admitted.grant), signal);
          await captureContinuationStage(child, { store, capture: this.owners.sourceCaptureOwners,nativeWorkspaces:this.owners.kernel.nativeWorkspaces,
            physical: async root => new KernelWorkingStateRootStore(await this.owners.storageAdapter.contextFromSourceGrant({
              grant: admitted.grant, owningWorkspaceId: incoming.source.workspace_id, executionWorkspaceId: incoming.source.execution_workspace_id,
              rootId: root.rootId, canonicalRoot: root.canonicalRoot })) }, incoming.source,
            admitted.rootId && admitted.canonicalRoot ? { rootId: admitted.rootId, canonicalRoot: admitted.canonicalRoot } : undefined, signal);
        } finally { await admitted.release(); }
        }
      }
      const prepared = basis.kind === 'refreshed' ? await prepareRefreshedContinuationSourceStore(child, store, signal)
        : await prepareContinuationSourceStore(child, store, signal);
      await this.admitSourceRegistrations(basis.source, signal);
      return this.owners.runtime.readyChildSource({ executionId: child.execution_id,
        source: { resourceOwner: prepared.source.resource_owner, mode: prepared.source.mode, liveRoot: prepared.source.live_root,
          workspaceId: prepared.source.workspace_id, executionWorkspaceId: prepared.source.execution_workspace_id,
          branchId: prepared.source.branch_id, revision: prepared.source.revision },
        pin: prepared.pin, provenance: prepared.provenance }, signal);
    });
  }
  private async settle(child: DelegatedExecution, signal: AbortSignal): Promise<DelegatedExecution> {
    if (!child.receipt || child.source?.kind !== 'ready' || !['materialized','fixed_branch','native_workspace'].includes(child.source.selection.mode)) return child;
    const { kernel, runtime, storageAdapter, resolveLiveSource } = this.owners;
    const source = this.childSource(child);
    if (!source || source.mode === 'live_root' || !source.branchId) throw new Error('Child lost its original source');
    const runId = child.receipt.run_id;
    // The terminal notification withdraws this Run's language reference, but is not
    // a process exit receipt. Capture waits on the same supervisor's actual drain.
    if (source.resourceOwner.kind === 'local') await waitWithSignal(kernel.releaseLanguageSource(runId), signal);
    signal.throwIfAborted();
    const publicationId = `child-result:${child.execution_id}`;
    const phases = child.code_result.kind === 'pending' ? ['source'] as const : ['result', 'source'] as const;
    for (const purpose of phases) {
      const authority = await admitRunSourceAuthority(kernel, runtime, { ...source, runId }, { signal, resolveLiveSource, purpose, allowMaterialization: false });
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
          if(source.mode==='native_workspace'){
            const entry=await kernel.nativeWorkspaces!.open({workspace_id:source.workspaceId,execution_workspace_id:source.executionWorkspaceId,branch_id:source.branchId},signal);
            candidate=await authority.client.prepareWorkspaceResult({branchId:source.branchId,generation:entry.view.binding.generation,publicationId},signal);
          } else if (!authority.rootId || !authority.canonicalRoot) {
            candidate = await store.prepareResultCandidate({ publicationId, branchId: source.branchId, source: { kind: 'head' }, signal });
          } else {
          store = new KernelWorkingStateRootStore(await storageAdapter.contextFromSourceGrant({ grant: authority.grant,
            owningWorkspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId,
            rootId: authority.rootId, canonicalRoot: authority.canonicalRoot }));
          candidate = await store.prepareResultCandidate({ publicationId, branchId: source.branchId,
            source: { kind: 'directory', directory: authority.canonicalRoot }, signal });
          }
        }
        if (child.code_result.kind === 'settling') {
          child = await runtime.attachChildCandidate({ executionId: child.execution_id, toolBinding: authority.toolBinding,
            candidateOperationId: candidate.candidateOperationId }, signal);
        }
        if (child.code_result.kind === 'candidate') {
          // Original WorkingState publication also confirms release of its candidate pins.
          await store.publishPreparedResult(publicationId, child.code_result.candidate, { signal });
          if (source.mode === 'materialized' && !source.environmentRunId) await authority.client.settleChildEnvironment({
            workspaceId: source.workspaceId, branchId: source.branchId, publicationId }, signal);
          child = await runtime.attachChildResult({ executionId: child.execution_id, toolBinding: authority.toolBinding, publicationId }, signal);
        }
        return child;
      } finally { await authority.release(); }
    }
    return child;
  }
  private async releaseHandoff(child: DelegatedExecution, signal: AbortSignal): Promise<void> {
    if (child.resources_released || (!child.receipt && !child.report) || (child.source?.kind !== 'ready' && child.source?.kind !== 'shared' && child.source?.kind !== 'absent' && !child.report)) return;
    const { kernel, runtime } = this.owners;
    const originalHandoff = child.trigger.kind === 'dispatch' && child.source && child.source.kind !== 'absent' ? child.source.handoff : null;
    const rootPin = originalHandoff?.root.kind === 'fixed' || originalHandoff?.root.kind === 'native'
      || originalHandoff?.root.kind === 'derived' ? originalHandoff.root.pin : null;
    const retained = originalHandoff?.retention_pin ?? rootPin;
    const shared = child.source?.kind === 'absent' || child.source?.kind === 'shared';
    // The normal dispatch cleanup releases the root pin below. A separate
    // retention pin (or a shared source without that cleanup) still owns a release.
    if (retained && child.report && originalHandoff?.source.resource_owner.kind === 'local'
      && (shared || retained.pin_id !== rootPin?.pin_id || retained.source.branch_id !== rootPin?.source.branch_id)) {
      const handoff=originalHandoff;
      const grant=await kernel.claimChildSource({handoffOperationId:handoff.operation_id,grantId:`child-retention-release:${randomUUID()}`,
        childThreadId:child.child_thread_id,childBranchId:child.child_branch_id},signal);
      try {await kernel.scoped(grant).unpinBranch({operationId:`child-retention-release:${child.execution_id}`,
        branchId:retained.source.branch_id!,pinId:retained.pin_id},signal);} finally {await kernel.revokeGrant(grant.grantId);}
    }
    // Completed children must detach their original observers before releasing
    // the source handoff. A failed fence retains that same source for retry.
    if (child.report && child.receipt) await runtime.releaseMcpResourceSource(child.receipt.run_id);
    const selection = child.launch.mcp_binding;
    const managed = selection && Object.values(selection.provenance.servers).some(server => server.owner.resource_owner.kind === 'managed_host');
    // A Run receipt precedes source/credential/MCP preparation. Keep the original
    // definition cut until Catalog publishes its independent child binding.
    const current = !child.report && child.receipt && managed
      ? await runtime.launch(child.receipt.run_id, signal) : null;
    const transferred = Boolean(child.report || current?.selection.mcp_binding
      && !isDeepStrictEqual(current.selection.mcp_binding, selection));
    if (transferred && managed) await releaseManagedChildDerivations(runtime, child, signal);
    if (child.trigger.kind === 'dispatch') {
      if (transferred && managed) {
        const original = await runtime.operation(child.child_operation_id, signal);
        if (original.id !== child.child_operation_id || original.run_id !== child.parent_run_id || !original.execution_owner)
          throw new Error('Original child dependency owner is unavailable');
        await releaseManagedChildDependencies(runtime, { operationId: original.id, parentRunId: original.run_id,
          executionOwner: original.execution_owner, executionEpoch: original.epoch }, selection, signal);
      }
      // MCP commit alone does not transfer separately prepared extension pins.
      // Successful startRun owns the fast path; terminal discovery owns its retry.
      if (child.report) await kernel.releaseChildToolHandoff(child.parent_run_id, child.child_operation_id);
    }
    if (shared) {
      if (!child.report) return;
      if (retained && originalHandoff?.source.resource_owner.kind === 'managed_host') {
        await withManagedChildSource(runtime, child, signal, (service, address) =>
          service.service({ ...address, requestId: randomUUID(), operation: { kind: 'child_release', execution: child } }, signal));
      }
      if (child.receipt) await runtime.retireSourceGrants(child.receipt.run_id);
      signal.throwIfAborted();
      await runtime.releaseChildResources(child.execution_id, signal);
      return;
    }
    const original = child.trigger.kind === 'dispatch' ? originalHandoff?.source : child.source_basis?.source;
    if (original?.resource_owner.kind === 'managed_host') {
      await withManagedChildSource(runtime, child, signal, async (service, address) => {
        await service.service({ ...address, requestId: randomUUID(),
          operation: { kind: 'child_release', execution: child } }, signal);
      });
    } else if (child.trigger.kind !== 'dispatch') {
      if (child.source_basis && (!child.receipt || child.source_basis.kind === 'refreshed')) {
        await this.withSourceStore(child.source_basis.source, child.child_thread_id, signal, async store => {
          if (child.source_basis?.kind === 'refreshed') {
            await releaseRefreshScratch(child,store);
          }
          if (child.receipt) return;
          if (!store.releaseBranchHandoffPin) throw new Error('Durable source pin release is unavailable');
          const branchId = `child-source:${child.execution_id}`;
          const branch = await store.getBranchRoot(branchId);
          if (branch) {
            if (child.source_basis!.kind !== 'refreshed' && branch.baseRoot !== child.source_basis!.root) throw new Error('Unused continuation source identity changed');
            await store.releaseBranchHandoffPin(branchId, `child-source-pin:${child.execution_id}`);
            await store.deleteBranch(branchId);
          }
        });
      }
    } else if (child.source?.kind === 'project' || child.source?.kind === 'ready' && !child.source.handoff) {
      // The project preparation belongs to this child Thread, not the parent's source handoff.
      // The original source retirement owner reclaims prepared branches when the Thread is deleted.
      if (child.source.kind === 'ready' && !child.receipt) {
        const { pin, selection } = child.source;
        await this.withSourceStore(selection, child.child_thread_id, signal, async store => {
          await store.releaseBranchHandoffPin!(pin.source.branch_id!, pin.pin_id);
        });
      }
    } else {
      const handoff = originalHandoff;
      if (!handoff) throw new Error('Original dispatch handoff is unavailable');
      const grant = await kernel.claimChildSource({ handoffOperationId: handoff.operation_id, grantId: `child-release:${randomUUID()}`,
        childThreadId: child.child_thread_id, childBranchId: child.child_branch_id }, signal);
      try {
        if (handoff.root.kind === 'fixed' || handoff.root.kind === 'native' || handoff.root.kind === 'derived') {
          await kernel.scoped(grant).unpinBranch({ operationId: `child-handoff-release:${child.execution_id}`,
            branchId: handoff.root.pin.source.branch_id!, pinId: handoff.root.pin.pin_id }, signal);
          if(handoff.root.kind==='native')await kernel.scoped(grant).deleteBranch({operationId:`child-handoff-delete:${child.execution_id}`,branchId:handoff.root.pin.source.branch_id!},signal);
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
  private async advance(admitted: DelegatedExecution, signal: AbortSignal, ownerSignal: AbortSignal,
    reportError?: (error: unknown, stage: string) => void): Promise<void> {
    const { runtime, prepareContext } = this.owners;
    let child = admitted;
    let stage = 'Preparing child source';
    let pendingProgress: ChildPreparationProgress | undefined;
    let writingProgress: Promise<void> | undefined;
    let progressKey = '';
    const drainProgress = (): Promise<void> => {
      if (writingProgress) return writingProgress;
      writingProgress = (async () => {
        while (pendingProgress && !signal.aborted) {
          const value = pendingProgress; pendingProgress = undefined;
          try { await runtime.childPreparationProgress(admitted.execution_id, value, signal); }
          catch (error) { if (!signal.aborted) this.owners.onError(admitted.execution_id, error, 'Record child preparation progress'); }
        }
      })().finally(() => { writingProgress = undefined; if (pendingProgress && !signal.aborted) void drainProgress(); });
      return writingProgress;
    };
    const progress = (value: ChildPreparationProgress) => {
      // Persist visible percentage changes and phase boundaries, coalescing fast
      // file batches into the latest observation instead of one event per file.
      const key = `${value.phase}:${value.total === undefined ? value.completed ?? '' : value.total ? Math.floor(100 * value.completed! / value.total) : 100}`;
      if (key === progressKey || signal.aborted) return;
      progressKey = key; pendingProgress = value; void drainProgress();
    };
    try {
      if (child.state === 'preparing' && !child.receipt && !child.report) {
        if (child.selected_profile.model_selection_required && child.trigger.kind === 'dispatch') {
          stage = 'Selecting child execution model'; progress({ phase: 'model_selection' });
          if (!this.owners.prepareModel) throw new Error('Delegated model preparation is unavailable');
          child = await this.owners.prepareModel(child, signal);
          signal.throwIfAborted();
        }
        stage = 'Preparing child source';
        progress({ phase: 'source' });
        child = await this.prepareSource(child, signal, progress);
        stage = 'Preparing child context';
        progress({ phase: 'context' });
        await this.owners.prepareMaterials?.(child.child_thread_id, signal);
        const source = this.childSource(child);
        const identity: ThreadIdentity = { runtime: 'agent', threadId: child.child_thread_id, branchId: child.child_branch_id };
        const checkpoint = child.trigger.kind !== 'dispatch' ? await runtime.context(child.child_branch_id, signal) : null;
        if (child.trigger.kind !== 'dispatch' && (!checkpoint || !prepareContext.forSource)) throw new Error('Continuation context provenance is unavailable');
        const context = await waitWithSignal(checkpoint
          ? prepareContext.forSource!(checkpoint, source, signal)
          : prepareContext(identity, source, { mode: (await runtime.thread(child.child_thread_id, signal)).bot_id ? 'bot' : 'agent', threadRole: 'worker', projectId: child.project_id, childProfile: child.selected_profile }, signal), signal);
        let inputPreparation: InputResourcePreparation | undefined;
        if (child.trigger.kind === 'user_continuation' && !child.input_prepared) {
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
        stage = 'Admitting child execution';
        progress({ phase: 'admission' });
        while (writingProgress || pendingProgress && !signal.aborted) await drainProgress();
        child = await runtime.prepareChild({ executionId: child.execution_id, source: source ? { resourceOwner: source.resourceOwner, mode: source.mode, liveRoot: source.liveRoot ?? null,
          workspaceId: source.workspaceId, executionWorkspaceId: source.executionWorkspaceId, branchId: source.branchId ?? null, revision: source.revision ?? null,
          ...(source.mode === 'native_workspace' && source.nativeScope ? { nativeScope: source.nativeScope } : {}),
          ...(source.environmentRunId ? { environmentRunId: source.environmentRunId } : {}) } : null,
          context, expectedContextCheckpoint: checkpoint?.id ?? null, ...(inputPreparation ? { inputPreparation } : {}) }, signal);
      }
      if (child.receipt && child.state === 'ready') {
        stage = 'Starting child execution';
        const launch = await runtime.launch(child.receipt.run_id, signal);
        // A recorded preparation failure is the Retry boundary. Its own durable event
        // must not repeatedly re-enter the same failed launch.
        if (!launch?.preparation_failure) await this.continueRun(child.receipt.run_id, signal);
      }
      if (child.report && child.receipt && ['pending', 'settling', 'candidate'].includes(child.code_result.kind)) {
        stage = 'Publish child result';
        child = await this.settle(child, signal);
      }
    } catch (error) {
      // A current definition/Goal pause can arrive after source preparation but before the
      // original submission transaction. Keep this exact pending execution for its next event.
      if (error instanceof KernelClientError && (error.code === 'activation-held' || error.code === 'bot-suspended')) return;
      if (!signal.aborted) {
        reportError?.(error, stage);
        try {
          const current = await runtime.childExecution(child.execution_id, ownerSignal);
          // An admitted Run's unknown effects remain recoverable; preparation failure cannot erase them.
          if (!current.receipt && !current.report) {
            const { code, detail, failure } = preparationFailure(error, stage);
            child = await runtime.failChild(child.execution_id, code, detail, ownerSignal, failure);
          }
        } catch (recordingError) {
          if (!reportError) throw recordingError;
          reportError(recordingError, 'Record child preparation failure');
        }
      }
      if (!reportError) throw error;
    } finally {
      pendingProgress = undefined;
      await writingProgress;
      if (!ownerSignal.aborted) {
        try {
          child = await runtime.childExecution(child.execution_id, ownerSignal);
          await this.releaseHandoff(child, ownerSignal);
        } catch (error) {
          if (!reportError) throw error;
          reportError(error, 'Release child resources');
        }
      }
    }
  }
}
