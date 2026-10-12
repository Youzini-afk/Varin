/** Trusted research handoff. Catalog owns invocation, ExperimentService owns every attempt.
* Reopening this bridge only inspects original subjects; it never submits replacement work. */
import { createMetricObserver } from './metric-followups.js';
import { createResearchArtifactObserver } from './research-artifact-followups.js';
import { isDeepStrictEqual } from 'node:util';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { ThreadResearchAPI, ThreadResearchSelection } from '@varin/application-client';
import type { ExperimentSubmitParams, ExperimentListParams, ExperimentLogsParams, ExperimentArtifactReadParams, SourceListParams, SourceRegisterParams } from '@varin/protocol';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { HostJobBinding, HostJobPending, Operation, ResearchScope, KernelMethod, KernelMethodParams } from './protocol.generated.js';
import type { ExperimentService } from '../harness/experiments.js';
import type { SourceService } from '../harness/sources.js';
import type { ResourceService } from '../harness/resources.js';
import type { ExperimentCaller, ResearchOwner } from '../harness/research-identity.js';
import { HarnessServiceError } from '../harness/service-error.js';
import { requireToolInvocation, runToolDomainCall } from './tool-invocation.js';
import { createResearchAccess, researchCaller as caller } from './research-access.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import { decodeResearchParams, type ResearchMethod } from './research-params.js';
export { createResearchSourceAuthority } from './research-source.js';
export const RESEARCH_CAPABILITY = 'research.experiments';
const DOMAIN = 'research.experiment';
const DOMAIN_VERSION = 1;
type Receipt = NonNullable<Awaited<ReturnType<ExperimentService['nativeReceipt']>>>;
const result = (content: unknown, effect: 'none' | 'confirmed' = 'none'): ToolExecutionReceipt => ({ executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect, content: { data: content, parts: [] } } });
export function createResearchRuntime(options: {
  kernel: KernelClient;
  runtime: AgentRuntimeClient;
  experiments: ExperimentService;
  sources: SourceService;
  resources: ResourceService;
  onError?: (error: Error) => void;
}) {
  const { kernel, runtime, experiments, sources, resources } = options;
  let disposed = false, started = false, dirty = false, work: Promise<void> | undefined;
  const active = new Set<Promise<unknown>>();
  const admitting = new Set<string>();
  const userAdmissions = new Map<string, number>();
  const subjectKey = (workspaceId: string, subjectId: string) => JSON.stringify([workspaceId, subjectId]);
  const stops: Array<() => void> = [];
  const report = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const ensure = () => { if (disposed)
    throw new HarnessServiceError('unavailable', 'Research runtime is detached'); };
  const request = <T, M extends Extract<KernelMethod, `runtime.${string}`>>(method: M, params: KernelMethodParams[M], signal?: AbortSignal): Promise<T> => kernel.agentRuntimeRequest<T, M>(method, params, signal);
  const access = createResearchAccess(kernel, runtime);
  const { scopes, toolScope } = access;
  const selected = async (selection: ThreadResearchSelection, signal?: AbortSignal) => {
    ensure();
    return access.selected(selection, signal);
  };
  const binding = (receipt: Receipt): HostJobBinding => ({ operationId: receipt.owner.operationId, executionOwner: receipt.owner.executionOwner, domain: DOMAIN, domainVersion: DOMAIN_VERSION, subject: { kind: 'workspace', workspaceId: receipt.caller.workspaceId, subjectId: receipt.attempt.attemptId } });
  const handoff = async (receipt: Receipt, known?: HostJobPending): Promise<HostJobPending> => {
    let op = known?.accepted ? known : await request<HostJobPending, 'runtime.host_job.accept'>('runtime.host_job.accept', { binding: binding(receipt), content: { data: receipt.accepted, parts: [] } });
    if (receipt.attempt.cancelRequested && !op.cancelRequested) {
      await runtime.cancelOperation(op.binding.operationId);
      op = { ...op, cancelRequested: true };
    }
    if (op.cancelRequested && !receipt.attempt.cancelRequested)
      await experiments.cancel(receipt.caller, receipt.attempt.attemptId);
    if (receipt.executorStopped && !op.executorStopped) {
      const state = receipt.attempt.state;
      op = await request<HostJobPending, 'runtime.host_job.terminal'>('runtime.host_job.terminal', { binding: binding(receipt), outcome: state === 'completed' ? 'succeeded' : state === 'cancelled' ? 'cancelled' : 'failed', effect: 'confirmed', content: { data: { attempt: receipt.attempt }, parts: [] }, executorStopped: true });
      await runtime.reconcileObservations();
    }
    return op;
  };
  const originalCaller = async (op: HostJobPending): Promise<ExperimentCaller> => {
    const run = await runtime.run(op.runId);
    const scope = (await scopes({ runtime: 'agent', threadId: run.thread_id, branchId: run.branch_id }, run.id))[0];
    if (!scope)
      throw new Error('Original job source attribution missing');
    const actor: Extract<ResearchOwner, {
      runtime: 'agent';
    }>['actor'] = op.origin.kind === 'user'
      ? { kind: 'user', key: op.origin.key } : { kind: 'tool', origin: op.origin.origin, callId: op.origin.call_id, toolName: op.origin.tool_name, schemaVersion: op.origin.schema_version };
    return caller(scope, { runtime: 'agent', actor, rootThreadId: scope.rootThreadId, threadId: run.thread_id, branchId: run.branch_id, runId: run.id, operationId: op.binding.operationId, executionOwner: op.binding.executionOwner, source: scope.source });
  };
  const metrics = createMetricObserver({ kernel, resources, onError: report, onAccepted: () => runtime.reconcileObservations() });
  const artifacts = createResearchArtifactObserver({ kernel, experiments, onError: report, onAccepted: () => runtime.reconcileObservations() });
  const sync = async () => {
    const pending = await request<HostJobPending[], 'runtime.host_job.pending'>('runtime.host_job.pending', {});
    for (const op of pending) {
      if (op.binding.domain !== DOMAIN)
        continue;
      try {
        const subject = op.binding.subject;
        if (subject.kind !== 'workspace')
          throw new Error('Original research job requires a workspace subject');
        const receipt = await experiments.nativeReceipt(subject.workspaceId, subject.subjectId);
        if (receipt) {
          if (!isDeepStrictEqual(binding(receipt), op.binding))
            throw new Error('Original domain subject owner changed');
          await handoff(receipt, op);
        }
        else if (op.accepted)
          throw new Error('Accepted original experiment subject is unavailable');
        else if (!admitting.has(op.binding.operationId) && !userAdmissions.has(subjectKey(subject.workspaceId, subject.subjectId)) && await experiments.reconcileUnaccepted(await originalCaller(op), subject.subjectId)) {
          await request<HostJobPending, 'runtime.host_job.terminal'>('runtime.host_job.terminal', { binding: op.binding, outcome: op.cancelRequested ? 'cancelled' : 'failed', effect: 'none', executorStopped: true, content: { data: { status: 'not_accepted', sourceAdmissionDrained: true }, parts: [] } });
        }
      }
      catch (error) {
        report(error);
      }
    }
  };
  const reconcileControl = (): Promise<void> => {
    if (disposed)
      return Promise.resolve();
    dirty = true;
    if (work)
      return work;
    work = (async () => { while (dirty && !disposed) {
      dirty = false;
      await sync();
    } })().finally(() => { work = undefined; if (dirty && !disposed)
      wake(); });
    return work;
  };
  const wake = () => {
    if (started && !disposed) {
      // Metadata observation never owns the original cancellation/acceptance flight.
      void reconcileControl().catch(report);
      void metrics.reconcile().catch(error => { if (!disposed) report(error); });
      void artifacts.reconcile().catch(error => { if (!disposed) report(error); });
    }
  };
  const reconcile = async (): Promise<void> => { await Promise.all([reconcileControl(), artifacts.reconcile(), metrics.reconcile()]); };
  const own = <T>(pending: Promise<T>): Promise<T> => { active.add(pending); void pending.finally(() => { active.delete(pending); wake(); }).catch(() => undefined); return pending; };
  const submit = async (scope: ResearchScope, owner: ResearchOwner, params: ExperimentSubmitParams, signal?: AbortSignal) => {
    if (owner.runtime !== 'agent')
      throw new Error('Actual native submission owner required');
    // The User operation or tool invocation already exists before this check. Tree-stop is
    // serialized with that admission; a late domain receipt stays attached to this operation.
    const actor = caller(scope, owner);
    if (!params.requestId)
      throw new Error('Research handoff requires its stable request identity');
    const subjectId = experiments.submissionId(actor, params.requestId);
    const planned: HostJobBinding = { operationId: owner.operationId, executionOwner: owner.executionOwner, domain: DOMAIN, domainVersion: DOMAIN_VERSION, subject: { kind: 'workspace', workspaceId: scope.source.workspace_id, subjectId } };
    admitting.add(owner.operationId);
    try {
      const before = await request<HostJobPending, 'runtime.host_job.begin'>('runtime.host_job.begin', { binding: planned });
      if (before.cancelRequested || before.phase === 'terminal') {
        const existing = await experiments.nativeReceipt(scope.source.workspace_id, subjectId);
        if (!existing)
          throw new HarnessServiceError('unavailable', 'Original research dispatch is cancelled or has already drained without acceptance');
      }
      if (before.binding.operationId !== owner.operationId && !await experiments.nativeReceipt(scope.source.workspace_id, subjectId))
        throw new HarnessServiceError('unavailable', 'Original submission requires reconciliation, never replacement');
      const accepted = await experiments.submit(caller(scope, owner), params, signal);
      const receipt = await experiments.nativeReceipt(scope.source.workspace_id, accepted.attempt.attemptId);
      if (!receipt)
        throw new HarnessServiceError('unavailable', 'Original accepted experiment receipt is unavailable');
      await handoff(receipt);
      wake();
      return { accepted, receipt };
    }
    finally {
      admitting.delete(owner.operationId);
      wake();
    }
  };
  const read = async (method: ResearchMethod, actor: ExperimentCaller, params: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'list': return experiments.list(actor, params as ExperimentListParams);
      case 'get': return experiments.get(actor, params.attemptId as string);
      case 'logs': return experiments.logs(actor, params as unknown as ExperimentLogsParams);
      case 'artifact': return experiments.readArtifactPage(actor, params as unknown as ExperimentArtifactReadParams);
      case 'resources': return resources.list(actor.workspaceId);
      case 'sources': return sources.list(actor.workspaceId, params as SourceListParams, actor);
      case 'cancel': return { attempt: await experiments.cancel(actor, params.attemptId as string) };
      case 'collect': return experiments.collect(actor, params.attemptId as string);
      case 'register': return { source: await sources.register(actor.workspaceId, params as unknown as SourceRegisterParams, actor) };
      default: throw new HarnessServiceError('invalid-params', 'Research method requires a job handoff');
    }
  };
  const user: ThreadResearchAPI = {
    async scopes(identity, signal) { ensure(); return (await scopes(identity, undefined, undefined, signal)).map(scope => ({ sourceRunId: scope.sourceRunId, workspaceId: scope.source.workspace_id, executionWorkspaceId: scope.source.execution_workspace_id, source: scope.source, canSubmit: scope.canSubmit })); },
    async list(s, p = {}, signal) { const params = decodeResearchParams('list', p); return experiments.list(caller(await selected(s, signal)), params as ExperimentListParams); },
    async get(s, id, signal) { decodeResearchParams('get', { attemptId: id }); return experiments.get(caller(await selected(s, signal)), id); },
    async logs(s, p, signal) { const params = decodeResearchParams('logs', p); return experiments.logs(caller(await selected(s, signal)), params as unknown as ExperimentLogsParams); },
    async artifact(s, p, signal) { const params = decodeResearchParams('artifact', p); return experiments.readArtifactPage(caller(await selected(s, signal)), params as unknown as ExperimentArtifactReadParams); },
    async cancel(s, id) { decodeResearchParams('cancel', { attemptId: id }); const value = await experiments.cancel(caller(await selected(s)), id); wake(); return { attempt: value }; },
    async collect(s, id) { decodeResearchParams('collect', { attemptId: id }); return experiments.collect(caller(await selected(s)), id); },
    async resources(s, signal) { decodeResearchParams('resources', {}); return resources.list((await selected(s, signal)).source.workspace_id); },
    async sources(s, p = {}, signal) { const params = decodeResearchParams('sources', p), actor = caller(await selected(s, signal)); return sources.list(actor.workspaceId, params as SourceListParams, actor); },
    submit(s, p) {
      return own((async () => {
        const params = decodeResearchParams('submit', p) as ExperimentSubmitParams;
        if (typeof params.requestId !== 'string' || !params.requestId.trim())
          throw new HarnessServiceError('invalid-params', 'A stable User requestId is required');
        const scope = await selected(s);
        const subjectId = experiments.submissionId(caller(scope), params.requestId), key = subjectKey(scope.source.workspace_id, subjectId);
        userAdmissions.set(key, (userAdmissions.get(key) ?? 0) + 1);
        try {
          const op = await request<HostJobPending, 'runtime.host_job.user'>('runtime.host_job.user', { subjectId, threadId: s.threadId, branchId: s.branchId, sourceRunId: s.sourceRunId, key: params.requestId, domain: DOMAIN, domainVersion: DOMAIN_VERSION, request: params });
          const owner: ResearchOwner = { runtime: 'agent', actor: { kind: 'user', key: params.requestId }, rootThreadId: scope.rootThreadId, threadId: scope.threadId, branchId: scope.branchId, runId: scope.sourceRunId, operationId: op.binding.operationId, executionOwner: op.binding.executionOwner, source: scope.source };
          return (await submit(scope, owner, params)).receipt.accepted;
        }
        finally {
          const count = userAdmissions.get(key)! - 1;
          if (count)
            userAdmissions.set(key, count);
          else
            userAdmissions.delete(key);
          wake();
        }
      })());
    },
  };
  const capability: HostCapabilityHandler = async (method, input, context) => {
    ensure();
    const params = decodeResearchParams(method as ResearchMethod, input), authority = requireToolInvocation(context);
    if (!isDeepStrictEqual(authority.arguments, input))
      throw new Error('Research call differs from its original arguments');
    const effect = ['submit', 'wait', 'cancel', 'collect', 'register'].includes(method);
    if (!effect) {
      if (authority.operation !== 'read')
        throw new Error('Research read requires its declared read operation');
      const { scope, owner } = await toolScope(authority);
      return parseVarinToolJson(await read(method as ResearchMethod, caller(scope, owner), params));
    }
    return runToolDomainCall(context, { operation: 'effect', domain: RESEARCH_CAPABILITY, toolName: authority.toolName, arguments: input }, a => own((async () => {
      const { scope, owner, contract } = await toolScope(a);
      if (method === 'submit' || method === 'wait') {
        if (contract.completion !== 'job' || contract.lifetime !== 'thread')
          throw new Error('Research work requires its selected Thread Job declaration');
        if (method === 'submit') {
          const submitted = await submit(scope, owner, { ...params, requestId: typeof params.requestId === 'string' ? params.requestId : a.operationId }, context.signal);
          if (submitted.receipt.owner.operationId !== a.operationId)
            return result({ ...submitted.accepted, operationId: submitted.receipt.owner.operationId }, 'confirmed');
          return { executor_stopped: false, completion: { kind: 'job_accepted', operation_id: a.operationId, phase: 'accepted', effect: 'confirmed', lifetime: 'thread', content: { data: submitted.receipt.accepted, parts: [] } } };
        }
        await experiments.get(caller(scope, owner), params.attemptId as string);
        const target = await experiments.nativeReceipt(scope.source.workspace_id, params.attemptId as string);
        if (!target)
          throw new HarnessServiceError('unavailable', 'Original job binding is unavailable');
        await handoff(target);
        const op = await request<Operation, 'runtime.host_job.observe'>('runtime.host_job.observe', { operationId: a.operationId, targetOperationId: target.owner.operationId });
        wake();
        return { executor_stopped: false, completion: { kind: 'job_accepted', operation_id: op.id, phase: 'awaiting_job', effect: 'none', lifetime: 'thread' } };
      }
      if (contract.completion !== 'result')
        throw new Error('Research mutation requires its selected Result declaration');
      const output = await read(method as ResearchMethod, caller(scope, owner), params);
      wake();
      return result(output, 'confirmed');
    })()));
  };
  return { user, capability, reconcile, start() { if (started || disposed)
      return; started = true; metrics.start(); stops.push(runtime.onReady(wake), runtime.onEvent(wake), experiments.subscribeAttempts(wake)); wake(); },
    async dispose() { disposed = true; const artifactDrain = artifacts.dispose(); const metricDrain = metrics.dispose(); for (const stop of stops.splice(0))
      stop(); await Promise.allSettled([artifactDrain, metricDrain, ...active, ...(work ? [work] : [])]); } };
}
