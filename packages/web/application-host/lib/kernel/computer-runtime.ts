/** Native callers use the original Computer owner. Catalog owns identity and ToolCall settlement. */
import { COMPUTER_CAPABILITY, COMPUTER_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import type { ThreadComputerAPI, ThreadIdentity } from '@varin/application-client';
import { computerWorkKey, parseComputerWorkRef, type ComputerActParams, type ComputerObserveParams, type ComputerWorkRef } from '@varin/protocol';
import { compileToolJsonSchema } from '@varin/pi-host/tool-schema';
import type { ComputerService } from '../computer/computer-service.js';
import { ComputerError, ComputerReleaseUnconfirmed } from '../computer/computer-error.js';
import type { ComputerWorkResolution } from '../computer/computer-actor.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { KernelClientError, type KernelClient } from './kernel-client.js';
import type { ComputerScope, Effect, Run } from './protocol.generated.js';
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
        label: value.threadId === value.rootThreadId ? 'Main agent' : 'Worker', readOnly: false } : null };
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
  const user: ThreadComputerAPI = {
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
        const desktopId = await computers.resolveDesktop(typeof params.desktopId === 'string' ? params.desktopId : computers.automation.desktopFor(execution) ?? undefined, configured.defaultDesktopId);
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
            case 'cancel': {
              inputCallStarted = true;
              const stopped = await computers.cancel(desktopId);
              // This cancellation call has ended. The old assignment's key release is separate.
              return result(stopped, stopped.released ? 'confirmed' : 'unknown', true, stopped.released ? 'succeeded' : 'indeterminate');
            }
            case 'release':
              inputCallStarted = true;
              try { await computers.automation.release(work, desktopId); }
              catch (error) {
                if (error instanceof ComputerReleaseUnconfirmed) return result({ released: false, detail: error.message }, 'unknown', true, 'indeterminate');
                throw error;
              }
              return result({ released: true }, 'confirmed');
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
    const wake = () => { void reconcileExecutions().catch(onError); };
    removers.push(kernel.onToolReleased(wake), runtime.onReady(wake), runtime.onEvent(event => { if (event.stream === 'durable') wake(); }));
    wake();
  };
  const stop = () => { stopped = true; for (const remove of removers.splice(0)) remove(); };
  return { capability, user, resolve, prepareConfiguration, reconcileExecutions, start, stop };
}
