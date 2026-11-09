/** Deferred delivery belongs to the original native Job, not a second scheduler. */
import type { ThreadIdentity, ThreadQueuedExchange } from '@varin/application-client';
import type { CodeExchangeOwners, CodeParticipant } from './code-exchange.js';
import { codeIntegration, openExchangeScope, openFixedCodeSource } from './code-exchange.js';
import { exchangeManagedCode } from './managed-code-exchange.js';
import { exchangeExternalCode } from '../external-agents/code-exchange.js';
import { integrationCompletion } from './integration-tool-owner.js';
import type { WorkingResult } from '../harness/working-state/types.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import type { ExternalChild, HostJobBinding, HostJobPending, KernelMethod, KernelMethodParams, Operation, OperationCallCompletion, ResolvedMedia } from './protocol.generated.js';

type Participant = Omit<CodeParticipant, 'launch'>;
type Delivery<P> = { kind: 'native'; source: P; target: P; result: WorkingResult }
  | { kind: 'external'; self: P; child: ExternalChild; direction: 'send' | 'receive'; result: WorkingResult };
type StoredDelivery = Delivery<Participant> & { authority: ToolInvocationAuthority; branchId: string };
export interface CodeExchangeQueueOwner {
  enqueue(authority: ToolInvocationAuthority, branchId: string, delivery: Delivery<CodeParticipant>): Promise<ToolExecutionReceipt>;
  release(operationId: string): void;
}
const compact = ({ launch: _launch, ...participant }: CodeParticipant): Participant => participant;
const DOMAIN = 'collaboration.code';
export function createCodeExchangeQueue(owners: CodeExchangeOwners) {
  const { kernel, runtime } = owners;
  const admitting = new Set<string>(), active = new Map<string, { dirty: boolean; work: Promise<void> }>();
  const unresolved = new Set<string>();
  const removers: Array<() => void> = [];
  let started = false, closing = false, dirty = false, scan: Promise<void> | undefined;
  const rpc = <T, M extends Extract<KernelMethod, `runtime.${string}`>>(method: M, params: KernelMethodParams[M], signal?: AbortSignal): Promise<T> =>
    kernel.agentRuntimeRequest<T, M>(method, params, signal);
  const pending = () => rpc<HostJobPending[], 'runtime.host_job.code_exchange.pending'>('runtime.host_job.code_exchange.pending', {});
  const original = async (id: string): Promise<StoredDelivery> => {
    const body = await rpc<OperationCallCompletion<ResolvedMedia>, 'runtime.host_job.code_exchange.request'>('runtime.host_job.code_exchange.request', { operationId: id });
    if (body.kind !== 'result') throw new Error('Original file delivery is unavailable');
    return body.content.data as StoredDelivery;
  };
  const restore = async (value: Participant, signal: AbortSignal): Promise<CodeParticipant> => {
    const launch = await runtime.launch(value.runId, signal);
    if (!launch) throw new Error('Original file source launch is unavailable');
    return { ...value, launch };
  };
  const releaseSnapshot = async (authority: ToolInvocationAuthority, source: Participant, result: { branchId: string; resultRevision?: number }) => {
    // WorkingResult objects live on their original storage Host, independent of mounts.
    if (source.source.resource_owner.kind === 'managed_host') {
      const { releaseManagedCodeResult } = await import('./managed-code-exchange.js');
      await releaseManagedCodeResult(owners, authority, result);
    } else {
      const scope = await openFixedCodeSource(owners, authority, source.source, new AbortController().signal);
      try {
        const revisions = result.resultRevision === undefined ? (await scope.store.listResults(result.branchId)).map(result => result.resultRevision) : [result.resultRevision];
        await scope.store.deleteResults(result.branchId, revisions);
        await scope.store.deleteBranch(result.branchId);
      } finally { await scope.release(); }
    }
  };
  const releaseResult = (delivery: StoredDelivery) => releaseSnapshot(delivery.authority, delivery.kind === 'native' ? delivery.source : delivery.self, delivery.result);
  const terminal = async (binding: HostJobBinding, receipt: ToolExecutionReceipt) => {
    if (receipt.completion.kind !== 'result') throw new Error('File delivery did not return its actual result');
    await rpc('runtime.host_job.terminal', { binding, outcome: receipt.completion.outcome, effect: receipt.completion.effect,
      executorStopped: receipt.executor_stopped, content: receipt.completion.content });
    if (receipt.executor_stopped) await runtime.reconcileHostTool({ operationId: binding.operationId, executionOwner: binding.executionOwner });
  };
  const settle = async (job: HostJobPending) => {
    const id = job.binding.operationId;
    if (admitting.has(id) || closing) return;
    let op = await runtime.operation(id);
    if (op.phase === 'terminal' && op.external_receipt?.executor_stopped) return;
    const queue = op.host_job?.codeExchange;
    if (!queue) {
      // A Host stopped between beginning the Job and recording its delivery.
      // There was no target write. Release only its deterministic saved snapshot.
      const [run, launch] = await Promise.all([runtime.run(job.runId), runtime.launch(job.runId)]);
      if (!launch?.selection.source || job.origin.kind !== 'tool') throw new Error('Original file preparation is unavailable');
      const authority: ToolInvocationAuthority = { invocationId: id, operationId: id, runId: job.runId, threadId: run.thread_id,
        callId: job.origin.call_id, origin: job.origin.origin, executorOwner: job.binding.executionOwner, toolName: job.origin.tool_name,
        source: launch.selection.source, operation: 'effect', completion: 'job', arguments: {} };
      await releaseSnapshot(authority, { runId: job.runId, branchId: run.branch_id, member: { threadId: run.thread_id } as Participant['member'], source: launch.selection.source }, { branchId: `code-exchange:${id}` });
      await terminal(job.binding, { executor_stopped: true, completion: { kind: 'result', outcome: 'failed', effect: 'none',
        content: { data: { code: 'code_exchange_preparation_interrupted', message: 'File exchange preparation stopped before delivery; no target files were changed.' }, parts: [] } } });
      return;
    }
    const delivery = await original(id);
    if (op.cancel_requested && !queue.started) {
      await releaseResult(delivery);
      await terminal(job.binding, { executor_stopped: true, completion: { kind: 'result', outcome: 'cancelled', effect: 'none',
        content: { data: { status: 'cancelled', message: 'Queued file exchange was withdrawn before application.' }, parts: [] } } });
      return;
    }
    // A crash after preparation but before public acceptance is recoverable from
    // the same immutable request; never recapture whatever happens to be on disk.
    if (!job.accepted) {
      await rpc('runtime.host_job.accept', { binding: job.binding, content: { data: publicData(delivery), parts: [] } });
      op = await runtime.operation(id);
    }
    if (!queue.started) {
      const revision = op.revision;
      try {
        op = await rpc<Operation, 'runtime.host_job.code_exchange.control'>('runtime.host_job.code_exchange.control', {
          threadId: delivery.authority.threadId, branchId: delivery.branchId, operationId: id, expectedRevision: revision, action: 'claim',
        });
      } catch (error) {
        if ((await runtime.operation(id)).revision !== revision) { wake(); return; }
        throw error;
      }
      if (!op.host_job?.codeExchange?.started) return;
    }
    const signal = new AbortController().signal;
    let receipt: ToolExecutionReceipt;
    let applying = false;
    try {
    if (delivery.kind === 'external') {
      receipt = await exchangeExternalCode(owners, delivery.authority, await restore(delivery.self, signal), delivery.child,
        delivery.direction, undefined, signal, { frozen: delivery.result });
    } else {
      const source = await restore(delivery.source, signal), target = await restore(delivery.target, signal);
      if (target.source.resource_owner.kind === 'managed_host') {
        const value = await exchangeManagedCode(owners, delivery.authority, delivery.branchId, source, target, undefined, signal, () => { applying = true; }, { frozen: delivery.result });
        receipt = integrationCompletion(value.merged!);
      } else {
        const scope = await openExchangeScope(owners, delivery.authority, target, signal);
        try {
          const input = codeIntegration(delivery.authority, delivery.branchId, source, target, delivery.result, scope, signal);
          try { applying = true; receipt = integrationCompletion(await owners.coordinator.mergeResult(input)); }
          catch (error) {
            const { signal: _signal, ...inspection } = input;
            const prior = await owners.coordinator.inspectIntegration(inspection);
            if (!prior) throw error;
            receipt = integrationCompletion(prior);
          }
        } finally { await scope.release(); }
      }
      if (receipt.completion.kind === 'result') receipt.completion.content = { data: {
        ...(receipt.completion.content.data as object), source: participantInfo(sender(delivery)), target: participantInfo(receiver(delivery)),
        result: { branchId: delivery.result.branchId, resultRevision: delivery.result.resultRevision, root: delivery.result.root },
      }, parts: receipt.completion.content.parts };
    }
    } catch (error) {
      applying ||= op.external_receipt?.effect === 'unknown';
      if (!applying) await releaseResult(delivery);
      receipt = { executor_stopped: !applying, completion: { kind: 'result', outcome: applying ? 'indeterminate' : 'failed', effect: applying ? 'unknown' : 'none',
        content: { data: { status: 'failed', code: 'code_exchange_failed', message: error instanceof Error ? error.message : String(error) }, parts: [] } } };
    }
    await terminal(job.binding, receipt);
    if (!receipt.executor_stopped) unresolved.add(id);
  };
  const wake = () => {
    dirty = true;
    for (const entry of active.values()) entry.dirty = true;
    if (!started || closing || scan) return;
    scan = (async () => {
      while (dirty && !closing) {
        dirty = false;
        for (const job of await pending()) {
          const id = job.binding.operationId;
          if (active.has(id) || admitting.has(id) || unresolved.has(id)) continue;
          const entry = { dirty: true, work: Promise.resolve() };
          active.set(id, entry);
          entry.work = Promise.resolve().then(async () => {
            while (entry.dirty && !closing && !unresolved.has(id)) { entry.dirty = false; await settle(job); }
          }).catch(error => owners.onCleanupError(id, error)).finally(() => { active.delete(id); if (entry.dirty && !closing && !unresolved.has(id)) wake(); });
        }
      }
    })().catch(error => owners.onCleanupError('queue', error)).finally(() => { scan = undefined; });
  };
  const sender = (value: Delivery<Participant>) => value.kind === 'native' ? value.source.member
    : value.direction === 'send' ? value.self.member : { threadId: value.child.conversation_id, name: value.child.name };
  const receiver = (value: Delivery<Participant>) => value.kind === 'native' ? value.target.member
    : value.direction === 'receive' ? value.self.member : { threadId: value.child.conversation_id, name: value.child.name };
  const participantInfo = (member: ReturnType<typeof sender>) => ({ threadId: member.threadId, name: member.name,
    ...('agentId' in member && member.agentId ? { agentId: member.agentId } : {}) });
  const publicData = (value: StoredDelivery) => ({ status: 'queued', operationId: value.authority.operationId,
    source: { threadId: sender(value).threadId, name: sender(value).name }, target: { threadId: receiver(value).threadId, name: receiver(value).name },
    files: value.result.changedPaths, message: 'The selected version is saved and will merge after the recipient’s current Run ends.' });
  const owner: CodeExchangeQueueOwner = {
    async enqueue(authority, branchId, value) {
      if (closing) throw new Error('File delivery owner is closing');
      admitting.add(authority.operationId);
      const payload: StoredDelivery = { ...(value.kind === 'native' ? { ...value, source: compact(value.source), target: compact(value.target) }
        : { ...value, self: compact(value.self) }), authority, branchId };
      const binding: HostJobBinding = { operationId: authority.operationId, executionOwner: authority.executorOwner,
        domain: DOMAIN, domainVersion: 1, subject: { kind: 'workspace', workspaceId: authority.source!.workspace_id, subjectId: authority.operationId } };
      let dispatched = false;
      try {
      dispatched = true;
      const target = value.kind === 'native' ? { threadId: value.target.member.threadId, branchId: value.target.branchId }
        : value.direction === 'receive' ? { threadId: value.self.member.threadId, branchId: value.self.branchId }
        : { threadId: value.child.parent_thread_id, branchId: value.child.parent_branch_id };
      await rpc('runtime.host_job.code_exchange.queue', { binding, ...target, afterCurrent: true, payload,
        ...(value.kind === 'external' && value.direction === 'send' ? { externalOperationId: value.child.operation_id } : {}) });
      const data = publicData(payload);
      await rpc('runtime.host_job.accept', { binding, content: { data, parts: [] } });
      return { executor_stopped: false, completion: { kind: 'job_accepted', operation_id: authority.operationId,
        phase: 'accepted', effect: 'confirmed', lifetime: 'thread', content: { data, parts: [] } } };
      } catch (error) {
        if (dispatched) {
          const original = await runtime.operation(authority.operationId).catch(() => null);
          if (original && !original.host_job?.codeExchange) dispatched = false;
        }
        if (!dispatched) await releaseResult(payload);
        // A lost acknowledgement must not turn retained work into a failed/no-effect
        // receipt. Recovery inspects the original Job and immutable snapshot.
        if (dispatched) return { executor_stopped: false, completion: { kind: 'result', outcome: 'indeterminate', effect: 'unknown',
          content: { data: { operationId: authority.operationId, status: 'preparing', message: error instanceof Error ? error.message : String(error) }, parts: [] } } };
        throw error;
      }
    },
    release(id) { admitting.delete(id); wake(); },
  };
  return { owner,
    async list(identity: ThreadIdentity, signal?: AbortSignal): Promise<ThreadQueuedExchange[]> {
      const roots = new Map<string, Promise<string>>();
      const root = (threadId: string) => {
        let selected = roots.get(threadId);
        if (!selected) { selected = runtime.familyList({ callerThreadId: threadId, includeSelf: true, scope: 'current', limit: 1 }, signal).then(page => page.rootThreadId); roots.set(threadId, selected); }
        return selected;
      };
      const room = await root(identity.threadId);
      const values = await Promise.all((await pending()).map(async job => {
        const op = await runtime.operation(job.binding.operationId, signal), queue = op.host_job?.codeExchange;
        if (!queue || !job.accepted) return [];
        const run = await runtime.run(job.runId, signal);
        if (await root(run.thread_id) !== room && await root(queue.targetThreadId) !== room) return [];
        const value = await original(op.id);
        return [{ operationId: op.id, revision: op.revision, senderThreadId: value.authority.threadId, senderBranchId: value.branchId,
          source: { threadId: sender(value).threadId, name: sender(value).name ?? sender(value).threadId },
          target: { threadId: receiver(value).threadId, name: receiver(value).name ?? receiver(value).threadId }, files: value.result.changedPaths,
          state: op.external_receipt?.effect === 'unknown' && !op.external_receipt.executor_stopped ? 'needs_attention' as const
            : queue.started ? 'applying' as const : op.cancel_requested ? 'withdrawing' as const : 'queued' as const,
          afterCurrent: Boolean(queue.afterRunId || queue.externalOperationId) }];
      }));
      return values.flat();
    },
    async control(identity: ThreadIdentity, request: { operationId: string; expectedRevision: number; action: 'send_now' | 'cancel' | 'retry' }, signal?: AbortSignal) {
      const { threadId, branchId } = identity;
      await rpc('runtime.host_job.code_exchange.control', { threadId, branchId, ...request }, signal); unresolved.delete(request.operationId); wake();
    },
    start() { if (started || closing) return; started = true;
      removers.push(runtime.onReady(() => { unresolved.clear(); wake(); }), runtime.onEvent(event => { if (event.stream === 'durable') wake(); })); wake();
    },
    async dispose() { closing = true; for (const remove of removers.splice(0)) remove(); await scan;
      await Promise.allSettled([...active.values()].map(entry => entry.work)); },
  };
}
