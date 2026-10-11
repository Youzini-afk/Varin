/** Native callers use the original Computer owner. Catalog owns identity and ToolCall settlement. */
import { randomUUID } from 'node:crypto';
import { COMPUTER_CAPABILITY, COMPUTER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { ThreadComputerAPI, ThreadIdentity } from '@varin/application-client';
import { computerWorkKey, parseComputerWorkRef, type ComputerActParams, type ComputerObserveParams, type ComputerWorkRef, type ComputerActor, type ComputerAccessRequest, type ComputerExecutionRef, type ComputerWorkScope } from '@varin/protocol';
import { compileToolJsonSchema } from '@varin/pi-host/tool-schema';
import type { ComputerService } from '../computer/computer-service.js';
import type { PendingComputerControlEvent, PendingComputerControlCancellation } from '../computer/computer-records.js';
import { ComputerError, ComputerReleaseUnconfirmed } from '../computer/computer-error.js';
import type { ComputerWorkResolution } from '../computer/computer-actor.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import type { ComputerScope, Effect, Run, ComputerRequestRecord, ComputerRequestView, ComputerEventReceipt, ComputerDecisionActor, KernelMethod, KernelMethodParams, Operation } from './protocol.generated.js';
import type { ExtensionToolOwnerOptions } from './extension-tool-owner.js';
import { requireToolInvocation, runToolDomainCall } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';

export { COMPUTER_CAPABILITY };
const declarations = new Map(COMPUTER_TOOL_DECLARATIONS.map(declaration => [declaration.id.slice('varin.computer.'.length),
  { declaration, validate: compileToolJsonSchema(declaration.tool!.inputSchema) }]));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function configuration(identity: string | null | undefined): { version: 1; defaultDesktopId: string | null } {
  let value: unknown;
  try { value = identity ? JSON.parse(identity) : null; } catch { value = null; }
  if (!object(value) || value.version !== 1 || Object.keys(value).some(key => key !== 'version' && key !== 'defaultDesktopId')
    || value.defaultDesktopId !== null && (typeof value.defaultDesktopId !== 'string' || !value.defaultDesktopId.trim())) {
    throw new ComputerError('computer-owner-unavailable', 'The original Computer tool configuration is unavailable; prepare a new execution instead of changing its target');
  }
  return { version: 1, defaultDesktopId: value.defaultDesktopId };
}
const result = (content: unknown, effect: Effect = 'none', stopped = true, outcome: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate' = 'succeeded'): ToolExecutionReceipt =>
  ({ executor_stopped: stopped, completion: { kind: 'result', outcome, effect, content } });

export function createComputerRuntime({ kernel, runtime, computers, enabled }: { kernel: KernelClient; runtime: AgentRuntimeClient; computers: ComputerService; enabled(runId: string): Promise<boolean> }) {
  const scope = async (work: ComputerWorkRef, runId?: string, operationId?: string, signal?: AbortSignal): Promise<ComputerScope> => {
    if (work.runtime !== 'agent') throw new ComputerError('computer-request-invalid', 'An Agent Thread and branch are required');
    try { return await kernel.agentRuntimeRequest<ComputerScope, 'runtime.computer.scope'>('runtime.computer.scope', {
      threadId: work.threadId, branchId: work.branchId, ...(runId ? { runId } : {}), ...(operationId ? { operationId } : {}),
    }, signal); } catch (error) {
      if (error instanceof KernelClientError && error.code === 'operation-error' && error.message.includes('not found:')) throw new ComputerError('computer-work-not-found', 'The original Computer Thread, branch or execution no longer exists');
      if (error instanceof KernelClientError && error.code === 'operation-error' && error.message.includes('conflict:')) throw new ComputerError('computer-execution-stale', 'The original Computer execution changed; refresh before retrying');
      throw new ComputerError('computer-owner-unavailable', 'The Agent identity owner is unavailable; existing input cleanup remains reserved');
    }
  };
  const resolve = async (work: ComputerWorkRef): Promise<ComputerWorkResolution> => {
    const value = await scope(work);
    const rootWork: ComputerWorkRef = { runtime: 'agent', threadId: value.rootThreadId, branchId: value.rootBranchId };
    const execution = value.currentRunId ? { work, runId: value.currentRunId } : null;
    const rootExecution = value.currentRootRunId ? { work: rootWork, runId: value.currentRootRunId } : null;
    return { scope: { work, rootWork, currentExecution: execution, currentRootExecution: rootExecution },
      actor: value.canExecute && execution ? { execution, rootWork, rootExecution, registry: null,
        label: value.threadId === value.rootThreadId ? 'Main agent' : 'Worker', roleAccess: { kind: 'tool-invocation' } } : null };
  };
  const prepareConfiguration: NonNullable<ExtensionToolOwnerOptions['prepareConfiguration']> = async (_run, required) => {
    // Required bindings are the original immutable configuration, even after settings change.
    const capturedDefault = required.length ? { value: null } : await computers.defaultDesktop().then(
      value => ({ value }), error => ({ error }),
    );
    return (descriptor, original) => {
      if (!COMPUTER_TOOL_DECLARATIONS.some(entry => entry.id === descriptor.id && entry.version === descriptor.version)) return original ?? null;
      if (original !== undefined) { configuration(original); return original; }
      if ('error' in capturedDefault) throw capturedDefault.error;
      return JSON.stringify({ version: 1, defaultDesktopId: capturedDefault.value });
    };
  };
  const hostEpoch = computers.controlOwnerEpoch;
  const decisions = new Map<string, Promise<ComputerRequestRecord>>();
  const rpc = <T, M extends Extract<KernelMethod, `runtime.${string}`>>(method: M, params: KernelMethodParams[M], signal?: AbortSignal): Promise<T> => kernel.agentRuntimeRequest<T, M>(method, params, signal);
  const acceptControlEvent = async (event: PendingComputerControlEvent): Promise<ComputerEventReceipt> => {
    const execution = event.actor.execution;
    if (execution.work.runtime !== 'agent') throw new ComputerError('computer-request-invalid', 'An original Agent execution is required');
    // Root lineage and activation are derived by Catalog. Host does not invent a receiving Run.
    return rpc<ComputerEventReceipt, 'runtime.computer.event.accept'>('runtime.computer.event.accept', {
      fact: { id: event.id, kind: event.kind, desktopId: event.desktopId, at: event.at, releaseConfirmed: event.releaseConfirmed,
        execution: { threadId: execution.work.threadId, branchId: execution.work.branchId, runId: execution.runId } }, label: event.label,
    });
  };
  const cancelControlEvents = async (command: PendingComputerControlCancellation): Promise<void> => {
    const execution = command.actor.execution;
    if (execution.work.runtime !== 'agent') throw new ComputerError('computer-request-invalid', 'An original Agent execution is required');
    await rpc<void, 'runtime.computer.event.cancel'>('runtime.computer.event.cancel', {
      execution: { threadId: execution.work.threadId, branchId: execution.work.branchId, runId: execution.runId }, id: command.id, desktopId: command.desktopId, pendingEventIds: command.pendingEventIds,
    });
  };
  const refreshRequests = async (root?: ComputerWorkRef): Promise<ComputerRequestView[]> => {
    if (root && root.runtime !== 'agent') return [];
    return rpc<ComputerRequestView[], 'runtime.computer.request.list'>('runtime.computer.request.list', root ? { rootThreadId: root.threadId, rootBranchId: root.branchId } : {});
  };
  const reconcileRequests = () => rpc<ComputerRequestRecord[], 'runtime.computer.request.reconcile'>('runtime.computer.request.reconcile', { hostEpoch });
  const executionOf = (request: ComputerRequestRecord): ComputerExecutionRef => ({ work: { runtime: 'agent', threadId: request.requester.threadId, branchId: request.requester.branchId }, runId: request.requester.runId });
  const actorOf = (request: ComputerRequestRecord): ComputerActor => ({ execution: executionOf(request), rootWork: { runtime: 'agent', threadId: request.rootThreadId, branchId: request.rootBranchId },
    rootExecution: request.claim?.manager ? { work: { runtime: 'agent', threadId: request.claim.manager.threadId, branchId: request.claim.manager.branchId }, runId: request.claim.manager.runId } : null,
    registry: null, label: 'Worker', roleAccess: { kind: 'tool-invocation' } });
  const projectRequest = ({ request, reason, detail }: ComputerRequestView): ComputerAccessRequest => {
    const assignmentId = request.status === 'granted' ? request.claim?.assignmentId : undefined;
    const assignment = assignmentId ? computers.automation.assignmentState(assignmentId) : undefined;
    return { id: request.id, revision: request.revision, desktopId: request.desktopId, actor: actorOf(request), access: request.access, reason,
      status: request.status === 'granted' && assignment !== 'active' ? assignment === 'released' ? 'released' : 'unavailable' : request.status,
      createdAt: new Date(request.createdAtMs).toISOString(), ...(assignmentId ? { assignmentId } : {}), ...(detail ? { detail } : {}) };
  };
  const cancelRequests = (ids: string[]) => ids.length ? rpc<void, 'runtime.computer.request.cancel'>('runtime.computer.request.cancel', { target: { kind: 'requests', requestIds: ids } }) : Promise.resolve();
  computers.automation.attachRequests({
    snapshot: async (work: ComputerWorkScope) => (await refreshRequests(work.rootWork)).map(projectRequest),
    cancel(actor, desktopId, family) {
      const execution = actor.execution;
      if (execution.work.runtime !== 'agent') return Promise.resolve();
      return rpc<void, 'runtime.computer.request.cancel'>('runtime.computer.request.cancel', { target: { kind: 'execution', execution: { threadId: execution.work.threadId, branchId: execution.work.branchId, runId: execution.runId }, family, desktopId: desktopId ?? null } });
    },
  });
  const decideRequest = async (work: ComputerWorkRef, selection: { requestId: string; expectedRevision?: number; decision: 'grant' | 'deny'; reason?: string }, actor: ComputerDecisionActor, signal?: AbortSignal): Promise<ComputerRequestRecord> => {
    const actual = await scope(work);
    if (work.runtime !== 'agent' || actual.rootThreadId !== work.threadId || actual.rootBranchId !== work.branchId) throw new ComputerError('computer-request-invalid', 'Only the root conversation can decide its desktop requests');
    signal?.throwIfAborted();
    const entry = (await reconcileRequests()).find(request => request.id === selection.requestId && request.rootThreadId === work.threadId && request.rootBranchId === work.branchId);
    if (!entry) throw new ComputerError('computer-work-not-found', 'The desktop request does not belong to this root work');
    const apply = async (stopSignal?: AbortSignal): Promise<ComputerRequestRecord> => {
      signal?.throwIfAborted();
      // A User command survives its HTTP caller. Only the original Tool execution or
      // explicit Computer Stop can cancel assignment work after Catalog acceptance.
      const decisionSignal = actor.kind === 'tool' && signal
        ? stopSignal ? AbortSignal.any([signal, stopSignal]) : signal : stopSignal;
      const fresh = entry.status === 'pending';
      const accepted = await rpc<ComputerRequestRecord, 'runtime.computer.decision.begin'>('runtime.computer.decision.begin', {
        requestId: selection.requestId, expectedRevision: selection.expectedRevision ?? entry.revision, actor, approved: selection.decision === 'grant', hostEpoch,
        assignmentId: randomUUID(), ...(selection.reason === undefined ? {} : { reason: selection.reason }),
      });
      if (accepted.status !== 'granting') return accepted;
      const inFlight = decisions.get(accepted.id);
      if (inFlight) return inFlight;
      const claim = accepted.claim!;
      const flight = (async () => {
        let lease = computers.automation.assignment(claim.assignmentId);
        try {
          if (claim.hostEpoch !== hostEpoch || !fresh && !lease) {
            return await rpc<ComputerRequestRecord, 'runtime.computer.decision.settle'>('runtime.computer.decision.settle', { requestId: accepted.id, claim, status: 'indeterminate', reason: 'The original assignment admission is unavailable; it was not repeated.' });
          }
          if (!lease) {
            decisionSignal?.throwIfAborted();
            const requesting = actorOf(accepted);
            lease = await computers.automation.grantRequest(requesting.execution, requesting.rootWork, requesting.rootExecution, accepted.desktopId, accepted.access, claim.assignmentId, decisionSignal);
          }
          if (decisionSignal?.aborted) {
            await computers.automation.releaseRequest(claim.assignmentId);
            return await rpc<ComputerRequestRecord, 'runtime.computer.decision.settle'>('runtime.computer.decision.settle', { requestId: accepted.id, claim, status: 'cancelled', reason: 'The original decision was cancelled during assignment.' });
          }
          const settled = await rpc<ComputerRequestRecord, 'runtime.computer.decision.settle'>('runtime.computer.decision.settle', { requestId: accepted.id, claim, status: 'granted' });
          if (settled.status === 'granted') computers.automation.confirmRequest(claim.assignmentId);
          else await computers.automation.releaseRequest(claim.assignmentId);
          return settled;
        } catch (error) {
          // Keep the original assignment and claim if its durable decision could not be read or
          // published. Reconciliation addresses that exact identity, never another reservation.
          if (lease) throw error;
          return await rpc<ComputerRequestRecord, 'runtime.computer.decision.settle'>('runtime.computer.decision.settle', { requestId: accepted.id, claim, status: 'indeterminate', reason: error instanceof Error ? error.message : 'Original assignment admission failed' });
        }
      })();
      decisions.set(accepted.id, flight);
      try { return await flight; } finally { if (decisions.get(accepted.id) === flight) decisions.delete(accepted.id); }
    };
    const requester = executionOf(entry);
    return selection.decision === 'grant' && ['pending', 'granting'].includes(entry.status)
      ? computers.automation.manage(requester.work, requester, stopSignal => apply(stopSignal), entry.desktopId)
      : apply();
  };
  const user: ThreadComputerAPI = {
    async decide(identity, selection, signal) {
      const work = parseComputerWorkRef(identity);
      if (work.runtime !== 'agent') throw new ComputerError('computer-request-invalid', 'An Agent root conversation is required');
      await decideRequest(work, selection, { kind: 'user', threadId: work.threadId, branchId: work.branchId, key: selection.key }, signal);
      await runtime.reconcileObservations();
      return { state: await computers.automation.snapshot(work) };
    },
    async state(identity, signal) {
      signal?.throwIfAborted();
      const work = parseComputerWorkRef(identity);
      const state = await computers.automation.snapshot(work);
      const family = new Set([computerWorkKey(state.work), computerWorkKey(state.rootWork), ...state.leases.map(lease => computerWorkKey(lease.actor.execution.work)), ...state.cleanups.map(cleanup => computerWorkKey(cleanup.execution.work))]);
      return { state, activities: computers.activities().filter(entry => entry.activity.execution && family.has(computerWorkKey(entry.activity.execution.work))) };
    },
    async stop(identity, selection) {
      const work = parseComputerWorkRef(identity);
      if (!selection.runId?.trim()) throw new ComputerError('computer-request-invalid', 'Stop requires the execution shown by the conversation');
      return { state: await computers.automation.stop({ work, runId: selection.runId }, selection.desktopId) };
    },
  };
  const capability: HostCapabilityHandler = async (method, value, context) => {
    const selected = declarations.get(method);
    if (!selected || !selected.validate(value)) throw new ComputerError('computer-request-invalid', 'Arguments do not match the selected Computer capability');
    const input = parseVarinToolJson(value);
    const authority = requireToolInvocation(context);
    const configured = configuration(authority.configurationIdentity);
    return runToolDomainCall(context, { domain: COMPUTER_CAPABILITY, toolName: selected.declaration.tool!.name,
      operation: selected.declaration.tool!.operation, arguments: input }, async original => {
      // Until the original owner call starts, failures prove no input was dispatched.
      let inputCallStarted = false;
      try {
        context.signal.throwIfAborted();
        if (!await enabled(original.runId)) throw new ComputerError('computer-owner-unavailable', 'Computer Use is disabled in the current tool settings');
        const run = await runtime.run(original.runId);
        const work: ThreadIdentity = { runtime: 'agent', threadId: original.threadId, branchId: run.branch_id };
        await scope(work, original.runId, original.operationId, context.signal);
        const execution = { work, runId: original.runId };
        if (method === 'list') return await computers.automation.authorize(work, 'observe', undefined, async () => result(await computers.list()), execution);
        const params = input as Record<string, unknown>;
        if (method === 'access') return result(await computers.automation.snapshot(work));
        if (method === 'wait') {
          const accepted = await rpc<Operation, 'runtime.computer.request.wait'>('runtime.computer.request.wait', { operationId: original.operationId, requestId: String(params.requestId) });
          return { executor_stopped: false, completion: accepted.call_completion! };
        }
        if (method === 'grant' || method === 'deny') {
          inputCallStarted = true;
          const decision = await decideRequest(work, { requestId: String(params.requestId), decision: method === 'grant' ? 'grant' : 'deny', ...(typeof params.reason === 'string' ? { reason: params.reason } : {}) }, { kind: 'tool', operationId: original.operationId }, context.signal);
          await runtime.reconcileObservations();
          return result({ request: decision }, decision.status === 'indeterminate' ? 'unknown' : 'confirmed', true, decision.status === 'indeterminate' ? 'indeterminate' : 'succeeded');
        }
        const desktopId = await computers.resolveDesktop(typeof params.desktopId === 'string' ? params.desktopId : computers.automation.desktopFor(execution) ?? undefined, configured.defaultDesktopId);
        if (method === 'request') return computers.automation.manage(work, execution, async stopSignal => {
          inputCallStarted = true;
          const accepted = await rpc<ComputerRequestRecord, 'runtime.computer.request.create'>('runtime.computer.request.create', { operationId: original.operationId, desktopId, access: params.access as 'observe' | 'control', reason: String(params.reason) });
          if (context.signal.aborted || stopSignal.aborted) await cancelRequests([accepted.id]);
          await runtime.reconcileObservations();
          return result({ requestId: accepted.id, status: context.signal.aborted || stopSignal.aborted ? 'cancelled' : accepted.status, revision: accepted.revision }, 'confirmed');
        }, desktopId);
        if (method === 'release' || method === 'cancel') {
          inputCallStarted = true;
          try {
            if (method === 'release') await computers.automation.release(work, desktopId);
            else await computers.automation.cancelAssigned(work, execution, desktopId);
          } catch (error) {
            if (error instanceof ComputerReleaseUnconfirmed) return result({ released: false, detail: error.message }, 'unknown', true, 'indeterminate');
            throw error;
          }
          return result({ released: true }, 'confirmed');
        }
        return await computers.automation.authorize(work, selected.declaration.tool!.operation === 'read' ? 'observe' : 'control', desktopId, async () => {
          context.signal.throwIfAborted();
          switch (method) {
            case 'apps': return result({ apps: await computers.listApps(desktopId) });
            case 'observe': return result({ observation: await computers.observe({ ...params as unknown as ComputerObserveParams, desktopId, signal: context.signal }) });
            case 'act': {
              inputCallStarted = true;
              const action = await computers.act({ ...params as unknown as ComputerActParams, desktopId, signal: context.signal });
              const effect = action.receipt?.effect === 'verified' ? 'confirmed' : action.receipt?.effect ?? 'unknown';
              return result({ result: action }, effect, action.inputWriterStopped,
                effect === 'unknown' ? 'indeterminate' : action.cancelled ? 'cancelled' : action.accepted ? 'succeeded' : 'failed');
            }
            default: throw new ComputerError('computer-request-invalid', 'The selected Computer method is unavailable');
          }
        }, execution);
      } catch (error) {
        if (inputCallStarted) throw error;
        return result({ error: { code: error instanceof ComputerError ? error.computerCode : 'computer-request-invalid',
          message: error instanceof Error ? error.message : String(error) } }, 'none', true, context.signal.aborted ? 'cancelled' : 'failed');
      }
    });
  };
  // Original Computer assignments select the work to reconcile. Notifications are wake-ups,
  // never proof of Run completion or input release, including a Tool owner generation change.
  let stopped = false, dirty = false, reconciling: Promise<void> | undefined;
  const removers: Array<() => void> = [];
  const reconcileExecutions = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    dirty = true;
    if (reconciling) return reconciling;
    const work = (async () => {
      const errors: unknown[] = [];
      while (dirty && !stopped) {
        dirty = false;
        try {
          const requests = await reconcileRequests();
          // Durable notifications contain only a cursor. Derive affected family addresses from
          // the original short records, then invalidate asynchronously without hydrating bodies.
          const roots = new Map(requests.map(request => {
            const work: ComputerWorkRef = { runtime: 'agent', threadId: request.rootThreadId, branchId: request.rootBranchId };
            return [computerWorkKey(work), work] as const;
          }));
          queueMicrotask(() => { if (!stopped) for (const work of roots.values()) computers.automation.invalidate(work); });
          for (const request of requests) {
            const claim = request.claim;
            if (!claim || claim.hostEpoch !== hostEpoch) continue;
            const lease = computers.automation.assignment(claim.assignmentId);
            if (!lease) continue;
            try {
              if (request.status === 'granted') computers.automation.confirmRequest(claim.assignmentId);
              else if (request.status === 'granting' && !decisions.has(request.id)) {
                const settled = await rpc<ComputerRequestRecord, 'runtime.computer.decision.settle'>('runtime.computer.decision.settle', { requestId: request.id, claim, status: 'granted' });
                if (settled.status === 'granted') computers.automation.confirmRequest(claim.assignmentId);
                else await computers.automation.releaseRequest(claim.assignmentId);
              } else if (!['pending', 'granting'].includes(request.status)) await computers.automation.releaseRequest(claim.assignmentId);
            } catch (error) { errors.push(error); }
          }
        } catch (error) { errors.push(error); }
        for (const execution of computers.automation.acceptedExecutions()) {
          if (execution.work.runtime !== 'agent') continue;
          try {
            // Pure Catalog inspection: AgentRuntimeClient.run itself withdraws Tool owners on terminal.
            const run = await kernel.agentRuntimeRequest<Run, 'runtime.run.inspect'>('runtime.run.inspect', { runId: execution.runId });
            if (stopped) return;
            if (run.thread_id !== execution.work.threadId || run.branch_id !== execution.work.branchId) throw new ComputerError('computer-owner-unavailable', 'Accepted Computer execution no longer matches its original Thread and branch');
            if (['completed', 'failed', 'cancelled'].includes(run.state)) await computers.finishExecution(execution);
          } catch (error) { errors.push(error); }
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Some original Computer executions remain unconfirmed; other accepted work was still reconciled');
    })();
    reconciling = work;
    void work.finally(() => { if (reconciling === work) reconciling = undefined; }).catch(() => undefined);
    return work;
  };
  const start = (onError: (error: unknown) => void = () => {}) => {
    if (removers.length || stopped) return;
    const wake = () => { void reconcileExecutions().catch(onError); void computers.reconcileControlEvents().catch(onError); };
    removers.push(kernel.onToolReleased(wake), runtime.onReady(wake), runtime.onEvent(event => { if (event.stream === 'durable') wake(); }));
    wake();
  };
  const stop = () => { stopped = true; for (const remove of removers.splice(0)) remove(); };
  return { capability, user, resolve, prepareConfiguration, acceptControlEvent, cancelControlEvents, reconcileExecutions, start, stop };
}
