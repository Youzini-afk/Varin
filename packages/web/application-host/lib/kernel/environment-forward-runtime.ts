/** Native tools share the original Host listener owner. Catalog remains the only execution ledger. */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ENVIRONMENT_FORWARD_CAPABILITY, ENVIRONMENT_FORWARD_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { EnvironmentServiceAccess } from '@varin/protocol';
import { compileToolJsonSchema } from '../models/schema.js';
import { managedEndpointIdentity, type ManagedRemoteTargetRegistry, type ManagedTarget } from '../harness/managed-remote-client.js';
import type { EnvironmentForwardOwner, EnvironmentForwardRuntime } from '../harness/environment-forwards.js';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { HostJobBinding, HostJobPending, HostJobSource, Operation, Effect, OperationCallCompletion, ResolvedMedia, KernelMethod, KernelMethodParams, SourceResourceOwner } from './protocol.generated.js';
import { runToolDomainCall, type ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
export { ENVIRONMENT_FORWARD_CAPABILITY };
const declarations = new Map(ENVIRONMENT_FORWARD_TOOL_DECLARATIONS.map(declaration => [declaration.id.slice('varin.environment.'.length),
  { declaration, validate: compileToolJsonSchema(declaration.tool!.inputSchema) }]));
const DOMAIN = 'environment.forward';
type Subject = Extract<HostJobBinding['subject'], { kind: 'environment_forward' }>;
const result = (data: unknown, effect: Effect = 'none', stopped = true,
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate' = 'succeeded'): ToolExecutionReceipt =>
  ({ executor_stopped: stopped, completion: { kind: 'result', outcome, effect, content: { data, parts: [] } } });
const ownerOf = (binding: HostJobBinding): EnvironmentForwardOwner => {
  if (binding.subject.kind !== 'environment_forward') throw new Error('Original service-forward subject is unavailable');
  return { runtime: 'agent', operationId: binding.operationId, hostEpoch: binding.subject.hostEpoch };
};
const subjectOf = (binding: HostJobBinding): Subject => {
  if (binding.domain !== DOMAIN || binding.domainVersion !== 1 || binding.subject.kind !== 'environment_forward')
    throw new Error('Original operation is not a service-forward Job');
  return binding.subject;
};
const accepted = (operationId: string, data: unknown): ToolExecutionReceipt => ({ executor_stopped: false,
  completion: { kind: 'job_accepted', operation_id: operationId, phase: 'accepted', effect: 'confirmed', lifetime: 'thread', content: { data, parts: [] } } });

export function createEnvironmentForwardJobRuntime(options: {
  kernel: KernelClient; runtime: AgentRuntimeClient; forwards: EnvironmentForwardRuntime;
  targets: Pick<ManagedRemoteTargetRegistry, 'forwardTarget' | 'selectForwardTarget'>;
  onError?: (error: Error) => void;
}) {
  const { kernel, runtime, forwards, targets } = options;
  const admitting = new Set<string>();
  // Only current invocation flights, never a second listener or persistent Job table.
  const active = new Set<{ runId: string; work: Promise<ToolExecutionReceipt> }>();
  const removers: Array<() => void> = [];
  const settling = new Map<string, { next: HostJobPending; dirty: boolean; work: Promise<void> }>();
  const reconciliations = new Set<Promise<void>>();
  let started = false, closing = false, disposed = false, disposal: Promise<void> | undefined;
  const report = (error: unknown) => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const rpc = <T, M extends Extract<KernelMethod, `runtime.${string}`>>(method: M, params: KernelMethodParams[M], signal?: AbortSignal): Promise<T> =>
    kernel.agentRuntimeRequest<T, M>(method, params, signal);
  const currentHost = (subject: Subject) => subject.hostId === runtime.coordinatorHostId && subject.hostEpoch === forwards.epoch;
  const dataFor = (binding: HostJobBinding, access: EnvironmentServiceAccess | null, listenerState: string) => ({
    operationId: binding.operationId, owner: subjectOf(binding), access, listenerState,
    accessLocation: 'coordinating_host', serviceProcess: 'not_observed', remoteServiceReachability: 'not_observed',
    detail: listenerState === 'unknown'
      ? 'The original Host listener owner is unavailable. Inspect or stop that Host before concluding its access path has closed; no replacement was opened.'
      : 'Closing this access path closes only its listener and streams; it does not stop the target service process.',
  });
  const settle = async (op: HostJobPending): Promise<void> => {
    const subject = subjectOf(op.binding), owner = ownerOf(op.binding);
    if (admitting.has(op.binding.operationId)) return;
    const original = await runtime.operation(op.binding.operationId);
    if (!isDeepStrictEqual(original.host_job?.binding, op.binding)) throw new Error('Original forward binding changed');
    op = { ...op, accepted: original.host_job!.acceptanceRef !== null, cancelRequested: original.cancel_requested,
      executorStopped: original.external_receipt?.executor_stopped ?? false, phase: original.phase };
    if (op.executorStopped && op.phase === 'terminal') {
      if (currentHost(subject) && forwards.inspect(owner).state === 'stopped') forwards.release(owner);
      return;
    }
    if (!currentHost(subject)) {
      if (original.external_receipt?.effect === 'unknown') return;
      await rpc('runtime.host_job.terminal', { binding: op.binding, outcome: 'indeterminate', effect: 'unknown', executorStopped: false,
        content: { data: dataFor(op.binding, null, 'unknown'), parts: [] } });
      return;
    }
    let evidence = forwards.inspect(owner);
    if (op.cancelRequested && evidence.state !== 'absent' && evidence.state !== 'stopped') {
      await forwards.closeOwner(owner); evidence = forwards.inspect(owner);
    }
    if (evidence.access && !op.accepted) {
      op = await rpc<HostJobPending, 'runtime.host_job.accept'>('runtime.host_job.accept', { binding: op.binding,
        content: { data: dataFor(op.binding, evidence.access, evidence.state), parts: [] } });
      if (op.cancelRequested && evidence.state !== 'stopped') { await forwards.closeOwner(owner); evidence = forwards.inspect(owner); }
    }
    if (evidence.state === 'live' || evidence.state === 'opening' || evidence.state === 'stopping') return;
    if (!op.executorStopped || op.phase !== 'terminal') {
      await rpc('runtime.host_job.terminal', { binding: op.binding, outcome: op.cancelRequested ? 'cancelled' : 'failed',
        effect: evidence.access || op.accepted ? 'confirmed' : 'none', executorStopped: true,
        content: { data: dataFor(op.binding, evidence.access, evidence.access || op.accepted ? 'stopped' : 'not_started'), parts: [] } });
      await runtime.reconcileObservations();
    }
    forwards.release(owner);
  };
  const sameOriginalOwner = (binding: HostJobBinding, owner: EnvironmentForwardOwner) => currentHost(subjectOf(binding)) && isDeepStrictEqual(ownerOf(binding), owner);
  const pending = async () => (await rpc<HostJobPending[], 'runtime.host_job.pending'>('runtime.host_job.pending', {})).filter(op => op.binding.domain === DOMAIN);
  const settleOriginal = (op: HostJobPending): Promise<void> => {
    const id = op.binding.operationId, existing = settling.get(id);
    if (existing) { existing.next = op; existing.dirty = true; return existing.work; }
    const entry = { next: op, dirty: true, work: Promise.resolve() };
    settling.set(id, entry);
    entry.work = Promise.resolve().then(async () => {
      while (entry.dirty) { entry.dirty = false; await settle(entry.next); }
    }).finally(() => {
      settling.delete(id);
      if (entry.dirty && !disposed) void settleOriginal(entry.next).catch(report);
    });
    return entry.work;
  };
  const reconcile = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    // Independent listeners start cleanup independently, including while another owner's drain is pending.
    const scan = (async () => {
      const operations = await pending(), known = new Set(operations.map(op => op.binding.operationId));
      await Promise.all([
        ...operations.map(op => settleOriginal(op).catch(report)),
        ...forwards.owners('agent').filter(owner => owner.runtime === 'agent' && !known.has(owner.operationId)).map(async owner => {
          if (owner.runtime !== 'agent' || forwards.inspect(owner).state !== 'stopped') return;
          try {
            // A committed terminal may disappear from pending before its acknowledgement arrived.
            const original = await runtime.operation(owner.operationId), binding = original.host_job?.binding;
            if (binding && binding.domain === DOMAIN && sameOriginalOwner(binding, owner)
              && original.phase === 'terminal' && original.external_receipt?.executor_stopped) forwards.release(owner);
          } catch (error) { report(error); }
        }),
      ]);
    })();
    reconciliations.add(scan);
    void scan.finally(() => { reconciliations.delete(scan); }).catch(() => undefined);
    return scan;
  };
  const reconcileOperation = async (operationId: string) => { const op = (await pending()).find(entry => entry.binding.operationId === operationId); if (op) await settleOriginal(op); };
  const wake = () => { if (started && !disposed) void reconcile().catch(report); };
  const originalAcceptance = async (operationId: string) => {
    const completion = await rpc<OperationCallCompletion<ResolvedMedia>, 'runtime.host_job.acceptance'>('runtime.host_job.acceptance', { operationId });
    // The forward producer publishes metadata only. Preserve the canonical JSON unchanged.
    if (completion.kind !== 'job_accepted' || completion.operation_id !== operationId || completion.content?.parts.length)
      throw new Error('Original canonical forward acceptance is unavailable');
    return completion;
  };
  const view = async (operation: Operation) => {
    const binding = operation.host_job?.binding;
    if (!binding) throw new Error('Original service-forward Job is unavailable');
    const subject = subjectOf(binding);
    const local = currentHost(subject) ? forwards.inspect(ownerOf(binding)) : null;
    const stopped = operation.external_receipt?.executor_stopped === true;
    const original = operation.host_job?.acceptanceRef != null
      ? await originalAcceptance(operation.id) : null;
    return { ...dataFor(binding, local?.access ?? null, stopped ? 'stopped' : local && local.state !== 'absent' ? local.state : 'unknown'),
      accepted: operation.host_job?.acceptanceRef !== null, originalAcceptance: original?.kind === 'job_accepted' ? original.content?.data ?? null : null,
      executorStopped: stopped, cancelRequested: operation.cancel_requested, phase: operation.phase, outcome: operation.outcome };
  };
  const recoverCall = async (operation: Operation): Promise<ToolExecutionReceipt> => {
    const binding = operation.host_job?.binding;
    if (!binding) throw new Error('Original forward Job binding is unavailable');
    subjectOf(binding);
    await reconcileOperation(operation.id);
    const actual = await runtime.operation(operation.id);
    if (actual.host_job?.acceptanceRef != null) {
      const completion = await originalAcceptance(operation.id);
      return { executor_stopped: false, completion };
    }
    return result(await view(actual), actual.external_receipt?.effect ?? 'unknown', actual.external_receipt?.executor_stopped ?? false,
      actual.external_receipt?.executor_stopped ? 'failed' : 'indeterminate');
  };
  const submit = async (authority: ToolInvocationAuthority, params: Record<string, unknown>, signal: AbortSignal): Promise<ToolExecutionReceipt> => {
    let binding: HostJobBinding | undefined;
    let fresh = false, knownAccepted = false;
    try {
      signal.throwIfAborted();
      const original = await runtime.operation(authority.operationId, signal);
      if (original.host_job) {
        binding = original.host_job.binding;
        knownAccepted = original.host_job.acceptanceRef !== null;
        return await recoverCall(original);
      }
      fresh = true;
      if (authority.completion !== 'job') throw new Error('A selected Thread Job declaration is required');
      const host = typeof params.host === 'string' ? params.host.trim() : '127.0.0.1', port = Number(params.port);
      if (!host || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('A non-empty service host and valid port are required');
      const explicit = typeof params.target === 'string' ? params.target.trim() : undefined;
      if (params.target !== undefined && !explicit) throw new Error('target must identify a configured machine or connection');
      let target: ManagedTarget | undefined;
      if (explicit && explicit !== 'local') target = await targets.selectForwardTarget(explicit, signal);
      else if (!explicit && authority.source?.resource_owner.kind === 'managed_host')
        target = await targets.forwardTarget(authority.source.resource_owner, signal);
      if (!target) {
        const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
        const access: EnvironmentServiceAccess = { id: `envsvc:${randomUUID()}`, service: { machineId: 'local', host, port },
          access: { kind: 'direct', machineId: 'local', host, port, url: `http://${address}:${port}` }, threadId: authority.threadId, createdAt: new Date().toISOString() };
        return result({ access, listenerState: 'not_created', accessLocation: 'coordinating_host', serviceProcess: 'not_observed',
          remoteServiceReachability: 'not_observed', detail: 'This is the service address on the coordinating Host. No forward was created or service connectivity tested.' });
      }
      const targetOwner: SourceResourceOwner = { kind: 'managed_host', hostId: target.hostId,
        connectionId: target.connection.id, endpointIdentity: managedEndpointIdentity(target.connection) };
      if (!explicit && authority.source && !isDeepStrictEqual(authority.source.resource_owner, targetOwner)) throw new Error('The accepted environment target changed');
      binding = { operationId: authority.operationId, executionOwner: authority.executorOwner, domain: DOMAIN, domainVersion: 1,
        subject: { kind: 'environment_forward', hostId: runtime.coordinatorHostId, hostEpoch: forwards.epoch, target: targetOwner, serviceHost: host, servicePort: port } };
      if (closing) throw new Error('Service-forward owner is closing');
      admitting.add(authority.operationId);
      const planned = binding;
      const before = await rpc<HostJobPending, 'runtime.host_job.begin'>('runtime.host_job.begin', { binding });
      binding = before.binding; knownAccepted = before.accepted;
      if (!isDeepStrictEqual(before.binding, planned) || before.accepted || before.cancelRequested || before.phase === 'terminal')
        throw new Error('Original service-forward dispatch is no longer available; reconcile it instead of opening again');
      signal.throwIfAborted();
      const access = await forwards.open({ target, host, port, owner: ownerOf(binding), threadId: authority.threadId, signal });
      const acceptanceData = dataFor(binding, access, 'live');
      const receipt = await rpc<HostJobPending, 'runtime.host_job.accept'>('runtime.host_job.accept', { binding,
        content: { data: acceptanceData, parts: [] } });
      if (receipt.cancelRequested) await forwards.closeOwner(ownerOf(binding));
      return accepted(authority.operationId, acceptanceData);
    } catch (error) {
      const local = binding && currentHost(subjectOf(binding)) ? forwards.inspect(ownerOf(binding)) : null;
      const stopped = binding ? local !== null && (local.state === 'absent' || local.state === 'stopped') : fresh;
      return result({ error: error instanceof Error ? error.message : 'Service-forward admission failed',
        ...(binding ? dataFor(binding, local?.access ?? null, stopped ? local?.access || knownAccepted ? 'stopped' : 'not_started' : local?.state ?? 'unknown') : {}) },
      stopped ? local?.access || knownAccepted ? 'confirmed' : 'none' : 'unknown', stopped, stopped ? signal.aborted ? 'cancelled' : 'failed' : 'indeterminate');
    } finally { admitting.delete(authority.operationId); wake(); }
  };
  const capability: HostCapabilityHandler = async (method, input, context) => {
    if (disposed || closing) throw new Error('Service-forward owner is detached');
    const selected = declarations.get(method);
    if (!selected || !selected.validate(input)) throw new Error('Arguments do not match the selected environment-forward tool');
    const params = parseVarinToolJson(input) as Record<string, unknown>;
    return runToolDomainCall(context, { domain: DOMAIN, operation: selected.declaration.tool!.operation,
      toolName: selected.declaration.tool!.name, arguments: parseVarinToolJson(input) }, authority => {
      const work = (async (): Promise<ToolExecutionReceipt> => {
        if (method === 'forward') return submit(authority, params, context.signal);
        if (method === 'forwards') {
          void reconcile().catch(report);
          const sources = await rpc<HostJobSource[], 'runtime.host_job.sources'>('runtime.host_job.sources', { runId: authority.runId }, context.signal);
          const jobs = await Promise.all(sources.filter(source => source.binding.domain === DOMAIN).map(async source =>
            view(await rpc<Operation, 'runtime.host_job.access'>('runtime.host_job.access', { runId: authority.runId, targetOperationId: source.binding.operationId, control: false }, context.signal))));
          return result({ jobs });
        }
        const operationId = String(params.operationId);
        let operation = await rpc<Operation, 'runtime.host_job.access'>('runtime.host_job.access', {
          runId: authority.runId, targetOperationId: operationId, control: method === 'forward_close' }, context.signal);
        if (!operation.host_job) throw new Error('Original service-forward Job is unavailable');
        subjectOf(operation.host_job.binding);
        if (method === 'forward_wait') {
          const observation = await rpc<Operation, 'runtime.host_job.observe'>('runtime.host_job.observe', {
            operationId: authority.operationId, targetOperationId: operationId, mode: 'stopped' }, context.signal);
          return { executor_stopped: false, completion: await runtime.inlineCompletion(observation) };
        }
        if (method === 'forward_close') await runtime.cancelOperation(operationId);
        await reconcileOperation(operationId);
        operation = await runtime.operation(operationId);
        return result(await view(operation), method === 'forward_close' ? 'confirmed' : 'none');
      })();
      const entry = { runId: authority.runId, work }; active.add(entry);
      void work.finally(() => { active.delete(entry); wake(); }).catch(() => undefined);
      return work;
    });
  };
  const drainRuns = async (runIds: ReadonlySet<string>): Promise<void> => {
    // Bot admission has already been suspended by the caller. Drain original jobs, never create replacements.
    const close = async () => {
      await Promise.all((await pending()).filter(op => runIds.has(op.runId)).map(async op => {
        await runtime.cancelOperation(op.binding.operationId);
        if (currentHost(subjectOf(op.binding))) await forwards.closeOwner(ownerOf(op.binding));
      }));
    };
    await close();
    await Promise.allSettled([...active].filter(entry => runIds.has(entry.runId)).map(entry => entry.work));
    await close();
    await Promise.all((await pending()).filter(op => runIds.has(op.runId)).map(settleOriginal));
    const unresolved = (await pending()).filter(op => runIds.has(op.runId) && !op.executorStopped);
    if (unresolved.length) throw new Error(`Original service-forward listener drain is unconfirmed: ${unresolved.map(op => op.binding.operationId).join(', ')}`);
  };
  return { capability, reconcile, drainRuns,
    start() { if (started || closing || disposed) return; started = true; removers.push(runtime.onReady(wake), runtime.onEvent(event => { if (event.stream === 'durable') wake(); }), forwards.onChanged(wake)); wake(); },
    dispose(): Promise<void> {
      if (disposal) return disposal;
      closing = true; started = false;
      for (const remove of removers.splice(0)) remove();
      disposal = (async () => {
        // Fence new calls first; retain reconciliation until actual listener/stream drains finish.
        await forwards.closeRuntime('agent');
        await Promise.allSettled([...active].map(entry => entry.work));
        await forwards.closeRuntime('agent');
        await reconcile(); disposed = true;
        await Promise.allSettled([...reconciliations, ...[...settling.values()].map(entry => entry.work)]);
      })();
      return disposal;
    },
  };
}
