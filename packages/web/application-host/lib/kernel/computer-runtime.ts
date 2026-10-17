import type { OutputPart, IncomingMedia } from './protocol.generated.js';
import type { ComputerDesktopPrepareParams, ComputerObservation, ComputerBrowserParams, ComputerOfficeParams, ComputerOpenParams, ComputerFileWriteParams, ComputerInstallSoftwareParams } from '@varin/protocol';
/** Native callers use the original Computer owner. Catalog owns identity and ToolCall settlement. */
import { randomUUID } from 'node:crypto';
import { COMPUTER_CAPABILITY, COMPUTER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { ThreadComputerAPI, ThreadIdentity } from '@varin/application-client';
import { computerWorkKey, sameComputerExecution, parseComputerWorkRef, type ComputerActParams, type ComputerObserveParams, type ComputerWorkRef, type ComputerActor, type ComputerAccessRequest, type ComputerExecutionRef, type ComputerWorkScope } from '@varin/protocol';
import { compileToolJsonSchema } from '../models/schema.js';
import { ComputerEffectError, type ComputerService, type ComputerExecutionEvidence } from '../computer/computer-service.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { PendingComputerControlEvent, PendingComputerControlCancellation } from '../computer/computer-records.js';
import { ComputerError, ComputerReleaseUnconfirmed } from '../computer/computer-error.js';
import type { ComputerWorkResolution } from '../computer/computer-actor.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import type { ComputerScope, Effect, Run, ComputerRequestRecord, ComputerRequestView, ComputerEventReceipt, ComputerDecisionActor, KernelMethod, KernelMethodParams, Operation } from './protocol.generated.js';
import type { ExtensionToolOwnerOptions } from './extension-tool-owner.js';
import { extendToolConfiguration } from './extension-tool-owner.js';
import { requireToolInvocation, runToolDomainCall, noteInvocationComputerUse, assertNoScriptComputerStopCycle } from './tool-invocation.js';
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
const result = (content: unknown, effect: Effect = 'none', stopped = true, outcome: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate' = 'succeeded', parts: OutputPart<IncomingMedia>[] = []): ToolExecutionReceipt =>
  ({ executor_stopped: stopped, completion: { kind: 'result', outcome, effect, content: { data: content, parts } } });

/** Only the Computer producer knows its screenshot field. Preserve every other observation fact. */
function observationOutput(observation: ComputerObservation, parts: OutputPart<IncomingMedia>[]) {
  const { screenshot, ...metadata } = observation;
  if (!screenshot) return metadata;
  const { base64, ...imageMetadata } = screenshot;
  const partIndex = parts.length;
  parts.push({ kind: 'media', media: { media_type: screenshot.mime, data_base64: base64 } });
  return { ...metadata, screenshot: { ...imageMetadata, partIndex } };
}
function applicationResult(data: unknown, evidence: ComputerExecutionEvidence, accepted: boolean, cancelled = false, parts: OutputPart<IncomingMedia>[] = []) {
  const effect = evidence.receipt.effect === 'verified' ? 'confirmed' : evidence.receipt.effect;
  return result(data, effect, evidence.inputWriterStopped, effect === 'unknown' ? 'indeterminate' : cancelled ? 'cancelled' : accepted ? 'succeeded' : 'failed', parts);
}

export function createComputerRuntime({ kernel, runtime, computers, enabled }: { kernel: KernelClient; runtime: AgentRuntimeClient; computers: ComputerService; enabled(runId: string): Promise<boolean> }) {
  const scope = async (work: ComputerWorkRef, runId?: string, operationId?: string, signal?: AbortSignal): Promise<ComputerScope> => {
    if (work.runtime !== 'agent') throw new ComputerError('computer-request-invalid', 'An Agent Thread and branch are required');
    try { return await kernel.agentRuntimeRequest<ComputerScope, 'runtime.computer.scope'>('runtime.computer.scope', {
      threadId: work.threadId, branchId: work.branchId, ...(runId ? { runId } : {}), ...(operationId ? { operationId } : {}),
    }, signal); } catch (error) {
      if (error instanceof KernelClientError && error.code === 'not-found') throw new ComputerError('computer-work-not-found', 'The original Computer Thread, branch or execution no longer exists');
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
      actor: value.canExecute && execution ? { execution, rootWork, rootExecution,
        label: value.threadId === value.rootThreadId ? 'Main agent' : 'Worker' } : null };
  };
  const prepareConfiguration: NonNullable<ExtensionToolOwnerOptions['prepareConfiguration']> = async (run, required) => {
    // Required bindings are the original immutable configuration, even after settings change.
    const capturedDefault = required.length ? { value: null } : await computers.defaultDesktop().then(
      value => ({ value }), error => ({ error }),
    );
    const available = required.length > 0 || await enabled(run.runId);
    return extendToolConfiguration(undefined, (descriptor, original) => {
      if (!COMPUTER_TOOL_DECLARATIONS.some(entry => entry.id === descriptor.id && entry.version === descriptor.version)) return original ?? null;
      if (original !== undefined) { configuration(original); return original; }
      if ('error' in capturedDefault) throw capturedDefault.error;
      return JSON.stringify({ version: 1, defaultDesktopId: capturedDefault.value });
    }, descriptor => COMPUTER_TOOL_DECLARATIONS.some(entry => entry.id === descriptor.id && entry.version === descriptor.version) ? available : undefined);
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
     label: 'Worker' });
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
        if (method === 'environment') return result({ source: original.source, defaultDesktopId: configured.defaultDesktopId,
          assignment: await computers.automation.snapshot(work),
          placementChanges: { available: false, detail: 'This Run keeps its accepted source/environment. Select a source for a new execution to change file/process placement. Desktop assignments do not change that source.' } });
        if (method === 'wait') {
          const accepted = await rpc<Operation, 'runtime.computer.request.wait'>('runtime.computer.request.wait', { operationId: original.operationId, requestId: String(params.requestId) });
          return { executor_stopped: false, completion: await runtime.inlineCompletion(accepted) };
        }
        if (method === 'grant' || method === 'deny') {
          inputCallStarted = true;
          const decision = await decideRequest(work, { requestId: String(params.requestId), decision: method === 'grant' ? 'grant' : 'deny', ...(typeof params.reason === 'string' ? { reason: params.reason } : {}) }, { kind: 'tool', operationId: original.operationId }, context.signal);
          await runtime.reconcileObservations();
          return result({ request: decision }, decision.status === 'indeterminate' ? 'unknown' : 'confirmed', true, decision.status === 'indeterminate' ? 'indeterminate' : 'succeeded');
        }
        const desktopId = method === 'prepare'
          ? (await computers.preparationTarget(typeof params.connectionId === 'string' ? params.connectionId : undefined)).id
          : await computers.resolveDesktop(typeof params.desktopId === 'string' ? params.desktopId : computers.automation.desktopFor(execution) ?? undefined, configured.defaultDesktopId);
        if (method === 'request') return computers.automation.manage(work, execution, async stopSignal => {
          inputCallStarted = true;
          const accepted = await rpc<ComputerRequestRecord, 'runtime.computer.request.create'>('runtime.computer.request.create', { operationId: original.operationId, desktopId, access: params.access as 'observe' | 'control', reason: String(params.reason) });
          if (context.signal.aborted || stopSignal.aborted) await cancelRequests([accepted.id]);
          await runtime.reconcileObservations();
          return result({ requestId: accepted.id, status: context.signal.aborted || stopSignal.aborted ? 'cancelled' : accepted.status, revision: accepted.revision }, 'confirmed');
        }, desktopId);
        if (method === 'release' || method === 'cancel') {
          if (method === 'cancel') assertNoScriptComputerStopCycle(context, desktopId);
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
          const admission = computers.automation.context.getStore();
          if (!admission) throw new Error('computer_admission_unavailable');
          // Closing an ancestor script must reach this actual dispatch before any Catalog
          // cancellation round trip. Keep its original assignment live for the stop channel;
          // aborting that authority first would prevent the owner from releasing its own input.
          const dispatch = new AbortController();
          const signal = AbortSignal.any([context.signal, dispatch.signal]);
          const releaseScriptDispatch = noteInvocationComputerUse(context, desktopId, reason => dispatch.abort(reason));
          try { switch (method) {
            case 'apps': return result({ apps: await computers.listApps(desktopId) });
            case 'prepare': {
              const changed = await computers.prepareDesktop(params as ComputerDesktopPrepareParams, { automated: true, desktopId, signal });
              return applicationResult(changed, changed, changed.desktop.status === 'available', changed.cancelled);
            }
            case 'desktop_lifecycle': {
              const changed = await computers.desktopLifecycle(desktopId, params.action as 'start' | 'stop', {
                automated: true, ...(typeof params.automationEpoch === 'string' ? { automationEpoch: params.automationEpoch } : {}), signal });
              return applicationResult(changed, changed, changed.desktop.status === (params.action === 'stop' ? 'stopped' : 'available'), changed.cancelled);
            }
            case 'artifact': return result({ artifact: await computers.registerArtifact(work, desktopId, String(params.relativePath)) }, 'confirmed');

            case 'control': {
              // authorize(control) has already awaited this exact local/peer reservation.
              // Reading the projection cannot undo the accepted assignment if it fails.
              const assignment = admission.lease;
              if (!assignment || assignment.access !== 'control') throw new ComputerError('computer-owner-unavailable', 'The original control assignment is unavailable');
              try { return result({ assignment, control: await computers.control(desktopId) }, 'confirmed'); }
              catch (error) { return result({ assignment, error: { code: 'computer-owner-unavailable', message: error instanceof Error ? error.message : String(error) } }, 'confirmed', true, 'failed'); }
            }
            case 'evidence': return result(await computers.evidence({ ...params, desktopId, signal }));
            case 'open': {
              const opened = await computers.open({ ...params as unknown as ComputerOpenParams, desktopId, signal });
              return applicationResult({ result: opened }, opened, opened.accepted, opened.cancelled);
            }
            case 'browser_read':
            case 'browser': {
              const browser = await computers.browser({ ...params as unknown as ComputerBrowserParams, desktopId, signal });
              const parts: OutputPart<IncomingMedia>[] = [];
              const { image, ...metadata } = browser;
              let imageMetadata: { partIndex: number; mediaType: string } | undefined;
              if (image !== undefined) {
                const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(image);
                if (!match) return applicationResult({ result: metadata, error: { code: 'computer-owner-unavailable', message: 'The original browser returned an invalid screenshot payload; request a fresh screenshot.' } }, browser, false, browser.cancelled);
                parts.push({ kind: 'media', media: { media_type: match[1]!, data_base64: match[2]! } });
                imageMetadata = { partIndex: 0, mediaType: match[1]! };
              }
              return applicationResult({ result: { ...metadata, ...(imageMetadata ? { image: imageMetadata } : {}) } }, browser, browser.ok, browser.cancelled, parts);
            }
            case 'office_read':
            case 'office': {
              const office = await computers.office({ ...params as unknown as ComputerOfficeParams, desktopId, signal });
              return applicationResult({ result: office }, office, office.ok, office.cancelled);
            }
            case 'put': return result(await computers.fileWrite({ ...params as unknown as ComputerFileWriteParams, desktopId, signal }), 'confirmed');
            case 'install': {
              const installed = await computers.installSoftware({ ...params as unknown as ComputerInstallSoftwareParams, desktopId, signal });
              const complete = installed.results.every(entry => entry.state === 'installed');
              const partial = installed.results.some(entry => entry.state === 'installed');
              return result(installed, complete ? 'confirmed' : partial ? 'partial' : 'unknown', true, complete ? 'succeeded' : partial ? 'failed' : 'indeterminate');
            }
            case 'observe': {
              const parts: OutputPart<IncomingMedia>[] = [];
              const observation = observationOutput(await computers.observe({ ...params as unknown as ComputerObserveParams, desktopId, signal }), parts);
              return result({ observation }, 'none', true, 'succeeded', parts);
            }
            case 'act': {
              inputCallStarted = true;
              const action = await computers.act({ ...params as unknown as ComputerActParams, desktopId, signal });
              const effect = action.receipt?.effect === 'verified' ? 'confirmed' : action.receipt?.effect ?? 'unknown';
              const parts: OutputPart<IncomingMedia>[] = [];
              const data = { ...action, ...(action.observation ? { observation: observationOutput(action.observation, parts) } : {}) };
              return result({ result: data }, effect, action.inputWriterStopped,
                effect === 'unknown' ? 'indeterminate' : action.cancelled ? 'cancelled' : action.accepted ? 'succeeded' : 'failed', parts);
            }
            default: throw new ComputerError('computer-request-invalid', 'The selected Computer method is unavailable');
          } } finally { releaseScriptDispatch(); }
        }, execution).catch(async error => {
          if (method !== 'control') throw error;
          // A lost reservation ACK followed by an unconfirmed drop is owned by the
          // original assignment cleanup. It is not a pre-dispatch application failure.
          const state = await computers.automation.snapshot(work).catch(evidenceError => { throw new ComputerEffectError(evidenceError, false); });
          if (state.cleanups.some(cleanup => cleanup.desktopId === desktopId && sameComputerExecution(cleanup.execution, execution))) {
            throw new ComputerEffectError(error, false);
          }
          const assignment = state.leases.find(lease => lease.desktopId === desktopId && lease.access === 'control' && sameComputerExecution(lease.actor.execution, execution));
          if (assignment) return result({ assignment, error: { code: 'computer-owner-unavailable', message: error instanceof Error ? error.message : String(error) } }, 'confirmed', true, context.signal.aborted ? 'cancelled' : 'failed');
          throw error;
        });
      } catch (error) {
        if (error instanceof ComputerEffectError) return result({ error: { code: error.harnessCode, message: error.message } }, 'unknown', error.inputWriterStopped, 'indeterminate');
        if (inputCallStarted) throw error;
        return result({ error: { code: error instanceof ComputerError ? error.computerCode : error instanceof HarnessServiceError ? error.harnessCode : 'computer-request-invalid',
          message: error instanceof Error ? error.message : String(error) } }, 'none', true, context.signal.aborted ? 'cancelled' : 'failed');
      }
    });
  };
  // Original Computer assignments select the work to reconcile. Notifications are wake-ups,
  // never proof of Run completion or input release, including a Tool owner generation change.
  let stopped = false, dirty = false, planning: Promise<Set<Promise<void>>> | undefined;
  const requestTasks = new Map<string, Promise<void>>();
  const executionTasks = new Map<string, Promise<void>>();
  const track = (tasks: Map<string, Promise<void>>, key: string, action: () => Promise<void>): Promise<void> => {
    const existing = tasks.get(key);
    if (existing) return existing;
    const task = action();
    tasks.set(key, task);
    void task.finally(() => { if (tasks.get(key) === task) tasks.delete(key); }).catch(() => undefined);
    return task;
  };
  const removers: Array<() => void> = [];
  const reconcileExecutions = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    dirty = true;
    planning ??= (async () => {
      const tasks = new Set<Promise<void>>();
      while (dirty && !stopped) {
        dirty = false;
        for (const execution of computers.automation.acceptedExecutions()) {
          const originalWork = execution.work;
          if (originalWork.runtime !== 'agent') continue;
          tasks.add(track(executionTasks, `${computerWorkKey(execution.work)}\0${execution.runId}`, async () => {
            // Pure Catalog inspection: AgentRuntimeClient.run itself withdraws Tool owners on terminal.
            const run = await kernel.agentRuntimeRequest<Run, 'runtime.run.inspect'>('runtime.run.inspect', { runId: execution.runId });
            if (stopped) return;
            if (run.thread_id !== originalWork.threadId || run.branch_id !== originalWork.branchId) throw new ComputerError('computer-owner-unavailable', 'Accepted Computer execution no longer matches its original Thread and branch');
            if (['completed', 'failed', 'cancelled'].includes(run.state)) await computers.finishExecution(execution);
          }));
        }
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
            tasks.add(track(requestTasks, claim.assignmentId, async () => {
              if (request.status === 'granted') computers.automation.confirmRequest(claim.assignmentId);
              else if (request.status === 'granting' && !decisions.has(request.id)) {
                const settled = await rpc<ComputerRequestRecord, 'runtime.computer.decision.settle'>('runtime.computer.decision.settle', { requestId: request.id, claim, status: 'granted' });
                if (settled.status === 'granted') computers.automation.confirmRequest(claim.assignmentId);
                else await computers.automation.releaseRequest(claim.assignmentId);
              } else if (!['pending', 'granting'].includes(request.status)) await computers.automation.releaseRequest(claim.assignmentId);
            }));
          }
        } catch (error) {
          const failed = Promise.reject<void>(error); void failed.catch(() => undefined); tasks.add(failed);
        }
      }
      return tasks;
    })().finally(() => { planning = undefined; });
    // Only short Catalog planning is shared. A pending release retains its own
    // assignment and cannot prevent a later wake from scheduling another desktop.
    return planning.then(async tasks => {
      // A wake can arrive after the final loop check but before planning settles.
      const next = dirty && !stopped ? reconcileExecutions() : Promise.resolve();
      const settled = await Promise.allSettled([...tasks, next]);
      const errors = settled.flatMap(value => value.status === 'rejected' ? [value.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Some original Computer executions remain unconfirmed; other accepted work was still reconciled');
    });
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
