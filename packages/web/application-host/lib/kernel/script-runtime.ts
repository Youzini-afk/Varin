/** Ordinary scripts use the original Storage process/guardian and original invocation scopes. */
import { isDeepStrictEqual } from 'node:util';
import { SCRIPT_CAPABILITY, SCRIPT_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson, type JsonValue, type NestedToolInput, type NestedToolReceipt } from '@varin/extension-contract';
import type { HostCapabilityCallContext, HostCapabilityHandler } from '@varin/extension-host';
import { SCRIPT_PROTOCOL_VERSION, ScriptFrameDecoder, encodeScriptFrame, parseScriptWorkerFrame, type ScriptHostFrame, type ScriptWorkerFrame } from '@varin/script-runtime';
import { compileToolJsonSchema } from '../models/schema.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { ExtensionToolOwnerOptions } from './extension-tool-owner.js';
import type { KernelMethod, KernelMethodParams, NodeBinding, Operation, OutputPart, IncomingMedia } from './protocol.generated.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';
import { undispatchedToolReceipt } from './tool-bridge.js';
import { scheduleAtDeadline } from '../deadline.js';
import { resolveScriptNodeBinding, scriptNodeSpawnInput } from './script-node-binding.js';
import { createManagedProcessClient } from './managed-process-client.js';
import { stopManagedScript } from './managed-script-source.js';
import { KernelManagedProcess } from './process-service.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import type { LiveSourceResolver } from './live-source.js';
import { assertNoScriptCellCycle, requireToolInvocation, runNestedToolCall, runToolDomainCall, withScriptCell, type ToolInvocationAuthority } from './tool-invocation.js';

export { SCRIPT_CAPABILITY };
const declarations = new Map(SCRIPT_TOOL_DECLARATIONS.map(declaration => [declaration.id.slice('varin.script.'.length),
  { declaration, validate: compileToolJsonSchema(declaration.tool!.inputSchema) }]));
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const result = (content: unknown, effect: 'none' | 'confirmed' | 'partial' | 'unknown', stopped: boolean, outcome: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate' = 'succeeded', parts: OutputPart<IncomingMedia>[] = []): ToolExecutionReceipt => ({
  completion: { kind: 'result', content: { data: content, parts }, effect, outcome }, executor_stopped: stopped,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
type CellResult = Extract<ScriptWorkerFrame, { type: 'completed' }>;
interface Cell {
  id: string; context: HostCapabilityCallContext; accepting: boolean; sent: boolean;
  callbacks: Set<Promise<unknown>>; computerCancellations: Set<(reason: unknown) => void>; desktops: Set<string>; output: OutputPart<IncomingMedia>[];
  completed: ReturnType<typeof deferred<CellResult>>;
}
type SourceAuthority = Awaited<ReturnType<typeof admitRunSourceAuthority>>;
interface Environment {
  id: string; runId: string; threadId: string; owner: ToolInvocationAuthority['executorOwner']; node: NodeBinding;
  source: SourceAuthority; process: KernelManagedProcess; ready: ReturnType<typeof deferred<void>>;
  accepting: boolean; accepted: boolean; cell?: Cell; tail: Promise<unknown>; closing?: Promise<ToolExecutionReceipt>;
  opening: ReturnType<typeof deferred<void>>;
  unsubscribe(): void;
}

export function createScriptRuntime(options: {
  kernel: KernelClient; runtime: AgentRuntimeClient; resolveLiveSource: LiveSourceResolver;
  onError(error: unknown): void;
}) {
  const { kernel, runtime } = options;
  const environments = new Map<string, Environment>();
  const openings = new Set<string>();
  const unaccepted = new Set<string>();
  const rpc = <T, M extends Extract<KernelMethod, `runtime.${string}`>>(method: M, params: KernelMethodParams[M], signal?: AbortSignal) => kernel.agentRuntimeRequest<T, M>(method, params, signal);
  const send = (environment: Environment, frame: Omit<ScriptHostFrame, 'v' | 'environmentId'>): Promise<void> =>
    new Promise((resolve, reject) => environment.process.stdin.write(encodeScriptFrame({ ...frame, v: SCRIPT_PROTOCOL_VERSION, environmentId: environment.id } as ScriptHostFrame), error => error ? reject(error) : resolve()));
  const sourceFor = async (operation: Operation): Promise<SourceAuthority> => {
    const launch = await runtime.launch(operation.run_id);
    if (!launch?.selection.source || launch.selection.source.mode === 'fixed_branch') throw new Error('Original physical script source is unavailable');
    const admitted = await admitRunSourceAuthority(kernel, runtime, savedSourceLaunch(operation.run_id, launch.selection.source,
      sourceToolSchemas(launch.selection).map(tool => tool.name) as Parameters<typeof savedSourceLaunch>[2]),
      { operationId: operation.id, retention: 'caller', purpose: 'script_environment', resolveLiveSource: options.resolveLiveSource });
    return admitted;
  };
  const fence = (environment: Environment, reason: unknown) => {
    environment.accepting = false;
    environment.ready.reject(reason);
    if (environment.cell) { environment.cell.accepting = false; environment.cell.completed.reject(reason); }
  };
  const close = (environment: Environment, reason: unknown): Promise<ToolExecutionReceipt> => {
    if (environment.closing) return environment.closing;
    fence(environment, reason);
    // Start the actual admitted Computer dispatch cancellation before any Catalog wait.
    for (const cancel of environment.cell?.computerCancellations ?? []) cancel(reason);
    // Physical stop starts before any Catalog or callback wait.
    const managedSource = environment.source.kind === 'managed' ? environment.source.binding.source : undefined;
    const physical = managedSource?.resource_owner.kind === 'managed_host'
      ? runtime.managedSource(managedSource.resource_owner).then(client => stopManagedScript(client, {
        coordinatorHostId: runtime.coordinatorHostId, processId: environment.id, runId: environment.runId,
        threadId: environment.threadId, source: managedSource }))
      : environment.process.requestTermination(true);
    const cell = environment.cell;
    const cancellations = [runtime.cancelOperation(environment.id), ...(cell ? [runtime.cancelOperation(cell.id)] : [])];
    environment.closing = (async () => {
      await Promise.allSettled([physical, ...cancellations, ...(environment.source.kind === 'local' ? [environment.process.completion] : []), ...(cell ? [...cell.callbacks] : [])]);
      await environment.opening.promise;
      let receipt: ToolExecutionReceipt;
      try {
        if (environment.source.kind === 'local' && environment.source.grant.kernelEpoch !== kernel.kernelEpoch) {
          const old = environment.source;
          environment.source = await sourceFor(await runtime.operation(environment.id));
          await old.release().catch(options.onError);
        }
        const original = await rpc<Operation, 'runtime.managed_process.terminal'>('runtime.managed_process.terminal', {
          operationId: environment.id, executionOwner: environment.owner, ...(environment.source.kind === 'local' ? { toolBinding: environment.source.toolBinding } : {}), callbacksStopped: true,
        });
        // The terminal may precede original Job acceptance. Preserve it on the same
        // Operation now; the caller's later handoff applies that already retained fact.
        const body = original.external_receipt ? original.external_receipt.result.data : original.result?.kind === 'output' ? original.result.output.data : undefined;
        const stopped = record(body) && record(body.process) && body.process.writerActive === false && body.callbacksStopped === true;
        receipt = result(body, stopped ? 'confirmed' : 'unknown', stopped,
          stopped ? environment.accepted ? 'succeeded' : original.external_receipt?.outcome ?? 'cancelled' : 'indeterminate');
      } catch (error) { receipt = result({ environmentId: environment.id, error: errorText(error), process: environment.process.snapshot }, 'unknown', false, 'indeterminate'); }
      if (receipt.executor_stopped) {
        environment.unsubscribe();
        await environment.process.detach().catch(options.onError);
        await environment.source.release().catch(options.onError);
        environments.delete(environment.id);
      }
      return receipt;
    })();
    const attempt = environment.closing;
    void attempt.then(receipt => {
      // Unknown is a revisable original receipt, never a permanent cached close result.
      if (!receipt.executor_stopped && environment.closing === attempt) delete environment.closing;
    });
    return attempt;
  };
  /** A missing heap is never re-created. Storage can stop its original tree; without
   * a retained live callback owner, a new Host cannot assert that old callbacks drained. */
  const recoverEnvironment = async (operation: Operation): Promise<ToolExecutionReceipt> => {
    if (operation.managed_process?.purpose.kind !== 'script_environment' || operation.execution_owner?.kind !== 'external') throw new Error('Original script environment is unavailable');
    const retained = operation.external_receipt;
    const body = retained?.result.data;
    // Original terminal evidence outlives the released source grant and live heap.
    // A repeated close reads that fact; it must not try to spawn new authority to kill it again.
    if (retained?.effect === 'confirmed' && record(body) && record(body.process)
      && body.process.writerActive === false && body.callbacksStopped === true) return result(body, 'confirmed', true, retained.outcome);
    let source: SourceAuthority | undefined;
    try {
      await runtime.cancelOperation(operation.id);
      const launch = await runtime.launch(operation.run_id);
      const originalSource = launch?.selection.source;
      if (originalSource?.resource_owner.kind === 'managed_host') {
        const run = await runtime.run(operation.run_id);
        await stopManagedScript(await runtime.managedSource(originalSource.resource_owner), { coordinatorHostId: runtime.coordinatorHostId,
          processId: operation.id, runId: operation.run_id, threadId: run.thread_id, source: originalSource });
      }
      if (originalSource?.resource_owner.kind !== 'managed_host') {
        source = await sourceFor(operation);
        if (source.kind !== 'local') throw new Error('Original script source owner changed');
        await source.client.processKill({ workspaceId: source.toolBinding.workspaceId, rootId: source.rootId!, processId: operation.id, force: true });
      }
      const original = await rpc<Operation, 'runtime.managed_process.terminal'>('runtime.managed_process.terminal', {
        operationId: operation.id, executionOwner: operation.execution_owner, ...(source ? { toolBinding: source.toolBinding } : {}),
        // Only a never-handed-off open can have no cells after its original Host callback
        // really ended. Missing/new Host evidence and accepted environments stay unknown.
        callbacksStopped: !operation.handed_off && operation.call_completion?.kind === 'result'
          && kernel.toolCallbackEnded(operation.run_id, operation.execution_owner, operation.id) === true,
      });
      const body = original.external_receipt ? original.external_receipt.result.data : original.result?.kind === 'output' ? original.result.output.data : undefined;
      const stopped = record(body) && record(body.process) && body.process.writerActive === false && body.callbacksStopped === true;
      return result(body, stopped ? 'confirmed' : 'unknown', stopped, stopped ? 'succeeded' : 'indeterminate');
    } catch (error) { return result({ environmentId: operation.id, error: errorText(error) }, 'unknown', false, 'indeterminate'); }
    finally { await source?.release().catch(options.onError); }
  };
  const receive = (environment: Environment, frame: ScriptWorkerFrame) => {
    if (frame.environmentId !== environment.id) throw new Error('script_environment_identity_changed');
    if (frame.type === 'ready') {
      if (frame.bindingIdentity !== environment.node.configuration_identity || !environment.accepting) throw new Error('script_binding_changed');
      environment.ready.resolve(); return;
    }
    const cell = environment.cell;
    if (!cell || frame.cellId !== cell.id || !cell.accepting) {
      if (frame.type === 'invoke') void send(environment, { type: 'rejected', cellId: frame.cellId, requestId: frame.requestId, error: { message: 'Script cell has ended' } } as Omit<ScriptHostFrame, 'v' | 'environmentId'>).catch(options.onError);
      return;
    }
    if (frame.type === 'output') { cell.output.push(frame.part); return; }
    if (frame.type === 'completed') { cell.accepting = false; cell.completed.resolve(frame); return; }
    const work = runNestedToolCall(cell.context, async authority => {
      const receipt = await rpc<NestedToolReceipt, 'runtime.tools.invoke'>('runtime.tools.invoke', {
        parentOperationId: authority.operationId, executorOwner: authority.executorOwner, call: frame.input as NestedToolInput,
      });
      if (environment.accepting) await send(environment, { type: 'receipt', cellId: cell.id, requestId: frame.requestId, receipt } as Omit<ScriptHostFrame, 'v' | 'environmentId'>);
    }).catch(async error => {
      if (environment.accepting) await send(environment, { type: 'rejected', cellId: cell.id, requestId: frame.requestId, error: { message: errorText(error) } } as Omit<ScriptHostFrame, 'v' | 'environmentId'>);
    });
    cell.callbacks.add(work);
    void work.finally(() => cell.callbacks.delete(work)).catch(options.onError);
  };
  const openEnvironment = async (authority: ToolInvocationAuthority, params: Record<string, JsonValue>, signal: AbortSignal): Promise<ToolExecutionReceipt> => {
    const requestedCwd = typeof params.cwd === 'string' ? params.cwd : '';
    if (requestedCwd.includes('\\') || requestedCwd.includes('\0') || requestedCwd.includes(':') || requestedCwd.startsWith('/')
      || requestedCwd.split('/').some(part => part === '.' || part === '..')) {
      return undispatchedToolReceipt('cwd must be relative to the selected source root, using forward slashes; use an empty string for the root');
    }
    await recovering;
    signal.throwIfAborted();
    if (environments.has(authority.operationId)) throw new Error('script_environment_already_open');
    const node = authority.source?.resource_owner.kind === 'managed_host'
      ? await (await runtime.managedSource(authority.source.resource_owner, signal)).scriptBinding({ coordinatorHostId: runtime.coordinatorHostId, source: authority.source }, signal)
      : await resolveScriptNodeBinding();
    if (node.configuration_identity !== authority.configurationIdentity) throw new Error('script_binding_changed');
    await rpc('runtime.managed_process.begin', { operationId: authority.operationId, executionOwner: authority.executorOwner, node }, signal);
    const launch = await runtime.launch(authority.runId, signal);
    if (!launch?.selection.source || launch.selection.source.mode === 'fixed_branch') throw new Error('Script environment requires the original physical source');
    const selection = savedSourceLaunch(authority.runId, launch.selection.source, sourceToolSchemas(launch.selection).map(tool => tool.name) as Parameters<typeof savedSourceLaunch>[2]);
    const source = await admitRunSourceAuthority(kernel, runtime, selection, { signal, operationId: authority.operationId, retention: 'caller', purpose: 'script_environment', resolveLiveSource: options.resolveLiveSource });
    let environment: Environment | undefined;
    let enteredProcess = false;
    try {
      signal.throwIfAborted();
      const rootId = source.kind === 'local' ? source.rootId : source.binding.physicalRoot?.rootId;
      if (!rootId) throw new Error('Original script physical source is unavailable');
      enteredProcess = true;
      const address = { coordinatorHostId: runtime.coordinatorHostId, authorityId: source.kind === 'managed' ? source.binding.authorityId : '',
        resourceEpoch: source.kind === 'managed' ? source.binding.resourceEpoch : '', processId: authority.operationId };
      const cwd = typeof params.cwd === 'string' ? params.cwd : '';
      const initial = source.kind === 'local'
        ? await source.client.processSpawn({ ...scriptNodeSpawnInput(node), processId: authority.operationId,
          workspaceId: selection.workspaceId, rootId, cwd })
        : await source.service.scriptSpawn({ ...address, node, cwd }, signal);
      if (initial.processId !== authority.operationId || initial.workspaceId !== selection.workspaceId || initial.mode !== 'pipe')
        throw new Error('Original script process identity changed');
      const client = source.kind === 'local' ? source.client : createManagedProcessClient(source.service, address,
        { workspaceId: selection.workspaceId, rootId });
      const projection = new KernelManagedProcess(client, { workspaceId: selection.workspaceId, rootId, processId: authority.operationId }, initial,
        options.onError, () => {}, { retainOutput: true, ...(source.kind === 'managed' ? {
          terminate: async () => { await stopManagedScript(source.service, { coordinatorHostId: runtime.coordinatorHostId,
            processId: authority.operationId, runId: authority.runId, threadId: authority.threadId, source: launch.selection.source! }); },
        } : {}) });
      environment = { id: authority.operationId, runId: authority.runId, threadId: authority.threadId, owner: authority.executorOwner, node, source, process: projection,
        ready: deferred<void>(), opening: deferred<void>(), accepting: true, accepted: false, tail: Promise.resolve(), unsubscribe: () => {} };
      const current = environment;
      environments.set(current.id, current);
      current.unsubscribe = kernel.subscribeExit(error => { projection.invalidate(error); fence(current, error); });
      const decoder = new ScriptFrameDecoder(parseScriptWorkerFrame);
      projection.stdout.on('data', chunk => { try { for (const frame of decoder.push(chunk)) receive(current, frame); } catch (error) { void close(current, error).catch(options.onError); } });
      projection.stdout.on('end', () => { try { decoder.end(); } catch (error) { void close(current, error).catch(options.onError); } });
      projection.stderr.resume();
      projection.on('error', error => { void close(current, error).catch(options.onError); });
      void projection.completion.then(() => close(current, new Error('Script process ended')), error => close(current, error)).catch(options.onError);
      const abort = () => { void close(current, signal.reason).catch(options.onError); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await projection.start();
        signal.throwIfAborted();
        await send(current, { type: 'initialize', bindingIdentity: node.configuration_identity } as Omit<ScriptHostFrame, 'v' | 'environmentId'>);
        await current.ready.promise;
        signal.throwIfAborted();
        const accepted = await rpc<Operation, 'runtime.managed_process.accept'>('runtime.managed_process.accept', { operationId: authority.operationId, executionOwner: authority.executorOwner, toolBinding: source.toolBinding });
        current.accepted = true;
        current.opening.resolve();
        return { completion: await runtime.inlineCompletion(accepted), executor_stopped: false };
      } finally { signal.removeEventListener('abort', abort); }
    } catch (error) {
      if (environment) {
        // Acceptance may have committed before its response was lost. Read the original
        // receipt, never dispatch again or replace a known JobAccepted with a Result.
        const original = await runtime.operation(environment.id).catch(() => undefined);
        if (original?.call_completion?.kind === 'job_accepted') environment.accepted = true;
        environment.opening.resolve();
        const stopped = await close(environment, error);
        return original?.call_completion?.kind === 'job_accepted'
          ? { completion: await runtime.inlineCompletion(original), executor_stopped: false } : stopped;
      }
      if (enteredProcess) {
        // Lost acceptance can follow a real spawn. Retain the original caller grant and
        // typed process identity; the guardian and original operation reconcile it.
        unaccepted.add(authority.operationId);
        void runtime.cancelOperation(authority.operationId).catch(options.onError);
        return result({ environmentId: authority.operationId, error: errorText(error) }, 'unknown', false, 'indeterminate');
      }
      await source.release().catch(options.onError);
      throw error;
    }
  };
  const open = async (...args: Parameters<typeof openEnvironment>): Promise<ToolExecutionReceipt> => {
    const id = args[0].operationId;
    if (openings.has(id)) throw new Error('script_environment_already_opening');
    openings.add(id);
    try { return await openEnvironment(...args); }
    finally { openings.delete(id); }
  };
  const evaluate = async (environment: Environment, authority: ToolInvocationAuthority, params: Record<string, JsonValue>, context: HostCapabilityCallContext): Promise<ToolExecutionReceipt> => {
    assertNoScriptCellCycle(context, environment.id);
    const task = environment.tail.catch(() => undefined).then(async () => {
      context.signal.throwIfAborted();
      if (!environment.accepting || environment.node.configuration_identity !== authority.configurationIdentity) throw new Error('script_environment_unavailable_or_binding_changed');
      await rpc('runtime.managed_process.cell', { operationId: authority.operationId, executionOwner: authority.executorOwner, environmentId: environment.id, closing: false }, context.signal);
      requireToolInvocation(context);
      const cell: Cell = { id: authority.operationId, context, accepting: true, sent: false, callbacks: new Set(), computerCancellations: new Set(), desktops: new Set(), output: [], completed: deferred<CellResult>() };
      environment.cell = cell;
      const abort = () => { void close(environment, context.signal.reason).catch(options.onError); };
      context.signal.addEventListener('abort', abort, { once: true });
      const cancelTimer = typeof params.timeoutMs === 'number' ? scheduleAtDeadline(Date.now() + params.timeoutMs, () => { void close(environment, new Error('Explicit script timeout elapsed')).catch(options.onError); }) : undefined;
      return withScriptCell(context, { environmentId: environment.id, computerCancellation(cancel) { cell.computerCancellations.add(cancel); return () => { cell.computerCancellations.delete(cancel); }; }, usesComputer: desktopId => cell.desktops.has(desktopId), computerUsed(desktopId) { if (!cell.accepting || !environment.accepting) throw new Error('script_cell_closed'); cell.desktops.add(desktopId); } }, async () => {
        try {
          context.signal.throwIfAborted();
          cell.sent = true;
          await send(environment, { type: 'eval', cellId: cell.id, script: params.script as string } as Omit<ScriptHostFrame, 'v' | 'environmentId'>);
          const evaluated = await cell.completed.promise;
          await Promise.allSettled(cell.callbacks);
          return result({ environmentId: environment.id, cellId: cell.id, ...(evaluated.valueText === undefined ? {} : { valueText: evaluated.valueText }), ...(evaluated.error ? { error: evaluated.error } : {}) }, evaluated.error ? 'partial' : 'confirmed', true, evaluated.error ? 'failed' : 'succeeded', cell.output);
        } catch (error) {
          const stopped = await close(environment, error);
          return result({ environmentId: environment.id, cellId: cell.id, error: errorText(error) }, stopped.executor_stopped ? cell.sent ? 'partial' : 'none' : 'unknown', stopped.executor_stopped, stopped.executor_stopped ? context.signal.aborted ? 'cancelled' : 'failed' : 'indeterminate', cell.output);
        } finally {
          cell.accepting = false; cancelTimer?.();
          context.signal.removeEventListener('abort', abort);
          await Promise.allSettled(cell.callbacks);
          if (environment.cell === cell) delete environment.cell;
        }
      });
    });
    environment.tail = task; return task;
  };
  const capability: HostCapabilityHandler = async (method, value, context) => {
    const selected = declarations.get(method);
    if (!selected || !selected.validate(value)) throw new Error('script_arguments_invalid');
    const input = parseVarinToolJson(value), params = input as Record<string, JsonValue>;
    return runToolDomainCall(context, { domain: SCRIPT_CAPABILITY, toolName: selected.declaration.tool!.name, operation: 'effect', arguments: input }, async authority => {
      try {
        if (method === 'open') return await open(authority, params, context.signal);
        const id = params.environmentId as string;
        assertNoScriptCellCycle(context, id);
        const environment = environments.get(id);
        if (method === 'run') {
          if (!environment || environment.runId !== authority.runId || environment.threadId !== authority.threadId) throw new Error('Script heap is unavailable; open a fresh environment');
          return await evaluate(environment, authority, params, context);
        }
        const original = await rpc<Operation, 'runtime.managed_process.cell'>('runtime.managed_process.cell', { operationId: authority.operationId, executionOwner: authority.executorOwner, environmentId: id, closing: true }, context.signal);
        if (environment && (environment.runId !== authority.runId || environment.threadId !== authority.threadId)) throw new Error('Script environment belongs to another Run');
        const target = environment ? await close(environment, new Error('Environment closed explicitly')) : await recoverEnvironment(original);
        // This ordinary control callback is finished. The target environment remains the
        // sole owner of any unresolved writer; do not duplicate its Unknown onto this call.
        return result({ environmentId: id, closeRequested: true, environmentStopped: target.executor_stopped,
          environmentReceipt: target.completion }, 'confirmed', true, target.executor_stopped ? 'succeeded' : 'failed');
      } catch (error) { return result({ error: errorText(error) }, 'none', true, 'failed'); }
    });
  };
  let reconciling: Promise<void> | undefined;
  let dirty = false;
  const reconcile = (): Promise<void> => {
    dirty = true;
    if (reconciling) return reconciling;
    reconciling = (async () => {
      do {
        dirty = false;
        // Only current Host lost-open hints are revisited here. The durable event
        // after the original callback ends supplies evidence that no cells escaped.
        for (const id of unaccepted) {
          if (openings.has(id) || recoveryTasks.has(id)) continue;
          const operation = await runtime.operation(id);
          if (operation.execution_owner && kernel.toolCallbackEnded(operation.run_id, operation.execution_owner, id) === true) {
            const task = recoverEnvironment(operation);
            recoveryTasks.set(id, task);
            void task.then(receipt => { if (receipt.executor_stopped) unaccepted.delete(id); })
              .finally(() => { if (recoveryTasks.get(id) === task) recoveryTasks.delete(id); }).catch(options.onError);
          }
        }
        await Promise.all([...environments.values()].map(async environment => {
          const [run, operation] = await Promise.all([runtime.run(environment.runId), runtime.operation(environment.id)]);
          if (operation.call_completion?.kind === 'job_accepted') environment.accepted = true;
          if (run.cancel_requested || ['completed', 'failed', 'cancelled'].includes(run.state) || operation.cancel_requested) {
            // Each original environment owns its drain. A slow callback in one environment
            // cannot delay physical stop of another or consume a later lifecycle wake.
            void close(environment, new Error('Original environment owner ended')).catch(options.onError);
          }
        }));
      } while (dirty);
    })().finally(() => { reconciling = undefined; if (dirty) void reconcile().catch(options.onError); });
    return reconciling;
  };
  const unsubscribeEvents = runtime.onEvent(() => { void reconcile().catch(options.onError); });
  let recovering: Promise<void> | undefined;
  const recoveryTasks = new Map<string, Promise<ToolExecutionReceipt>>();
  const recover = (sourceOwner?: import('../harness/managed-remote-types.js').ManagedHostSourceOwner): Promise<void> => {
    if (recovering) return recovering.then(() => recover(sourceOwner));
    recovering = (async () => {
      const pending = await rpc<Operation[], 'runtime.managed_process.pending'>('runtime.managed_process.pending', {});
      // Open waits for this inventory only, so its new environment cannot be
      // mistaken for a pre-existing process. Each old environment owns its drain.
      for (const operation of pending) {
        if (recoveryTasks.has(operation.id) || openings.has(operation.id)) continue;
        const environment = environments.get(operation.id);
        if (sourceOwner) {
          const launch = await runtime.launch(operation.run_id);
          if (!isDeepStrictEqual(launch?.selection.source?.resource_owner, sourceOwner) || environment?.accepting) continue;
        }
        const task = environment ? close(environment, new Error('Original process channel ended')) : recoverEnvironment(operation);
        recoveryTasks.set(operation.id, task);
        void task.finally(() => { if (recoveryTasks.get(operation.id) === task) recoveryTasks.delete(operation.id); }).catch(options.onError);
      }
    })().finally(() => { recovering = undefined; });
    return recovering;
  };
  const unsubscribeReady = runtime.onReady(() => { void recover().catch(options.onError); });
  if (kernel.kernelEpoch) void recover().catch(options.onError);

  return {
    capability,
    recoverSource: (owner: import('../harness/managed-remote-types.js').ManagedHostSourceOwner) => recover(owner),
    async prepareConfiguration(fallback: NonNullable<ExtensionToolOwnerOptions['configurationIdentity']>, source: import('./protocol.generated.js').LaunchSource | null): Promise<NonNullable<ExtensionToolOwnerOptions['configurationIdentity']>> {
      const captured = await (source?.resource_owner.kind === 'managed_host'
        ? runtime.managedSource(source.resource_owner).then(client => client.scriptBinding({ coordinatorHostId: runtime.coordinatorHostId, source }))
        : resolveScriptNodeBinding()).then(value => ({ value }), error => ({ error }));
      return Object.assign((descriptor: Parameters<typeof fallback>[0], original?: string | null) => {
        if (!SCRIPT_TOOL_DECLARATIONS.some(entry => entry.id === descriptor.id && entry.version === descriptor.version)) return fallback(descriptor, original);
        if ('error' in captured) throw captured.error;
        const node = captured.value;
        if (original !== undefined && original !== node.configuration_identity) throw new Error('Original script Node binding is unavailable');
        return node.configuration_identity;
      }, fallback);
    },
    async drainRuns(runIds: ReadonlySet<string>) {
      const pending = await rpc<Operation[], 'runtime.managed_process.pending'>('runtime.managed_process.pending', {});
      const ids = new Map(pending.filter(operation => runIds.has(operation.run_id)).map(operation => [operation.id, operation]));
      for (const environment of environments.values()) if (runIds.has(environment.runId) && !ids.has(environment.id)) ids.set(environment.id, await runtime.operation(environment.id));
      const results = await Promise.all([...ids.values()].map(operation => {
        const environment = environments.get(operation.id);
        return environment ? close(environment, new Error('Bot sleeping')) : recoverEnvironment(operation);
      }));
      if (results.some(receipt => !receipt.executor_stopped)) throw new Error('Bot script process or callback stop is unconfirmed; retry Sleep after reconciliation');
    },
    async cancelComputer(runId: string, desktopIds?: readonly string[]) {
      await Promise.all([...environments.values()].filter(environment => environment.runId === runId && environment.cell
        && (!desktopIds || desktopIds.some(id => environment.cell!.desktops.has(id)))).map(environment => close(environment, new Error('User stopped current Computer work'))));
    },
    async dispose() {
      unsubscribeEvents(); unsubscribeReady();
      await recovering;
      await Promise.allSettled([...recoveryTasks.values(), ...[...environments.values()].map(environment => close(environment, new Error('Script Host closed')))]);
    },
  };
}
