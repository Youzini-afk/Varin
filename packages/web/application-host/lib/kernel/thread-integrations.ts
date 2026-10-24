/** User review of a fixed child publication, using the same source and file journal as tools. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ThreadIntegrationCommand, ThreadIntegrationState, ThreadIdentity } from '@varin/application-client';
import type { IntegrationCoordinator, IntegrationOperationReceipt, IntegrationPlanInput } from '../harness/working-state/integration-coordinator.js';
import type { IntegrationOperationBinding } from '../recovery/durable-file-operation.js';
import type { ManagedSourceServiceHandler } from '../harness/managed-remote-types.js';
import type { HostJobPending } from './protocol.generated.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import { openScopedIntegrationTarget, type IntegrationTargetScope, type IntegrationTargetOwners } from './integration-tool-owner.js';
import { sourcePathMap, type SourcePathMap } from './source-path-map.js';

export type UserIntegrationBinding = Extract<IntegrationOperationBinding, { kind: 'user_operation' }>;
export interface UserIntegrationRequest {
  pathMapping?: SourcePathMap;
  binding: UserIntegrationBinding;
  command: ThreadIntegrationCommand;
  /** A previous accepted request is inspected, never silently replayed. */
  inspectOnly: boolean;
}
export interface UserIntegrationResult {
  state: ThreadIntegrationState;
  effect: 'none' | 'confirmed' | 'partial' | 'unknown';
  executorStopped: boolean;
}
type Owners = IntegrationTargetOwners & { coordinator: IntegrationCoordinator };
const project = (rows: IntegrationOperationReceipt[]): ThreadIntegrationState['operations'] => rows.map(row => ({
  operationId: row.operationId, state: row.receipt!.state,
  sourceRunId: row.sourceRunId!,
  appliedPaths: row.appliedPaths, conflictPaths: row.conflictPaths, needsAttentionPaths: row.needsAttentionPaths ?? [],
  effect: row.effect!, executorStopped: row.executorStopped!,
  ...(row.failure ? { failure: row.failure } : {}),
}));

async function execute(coordinator: IntegrationCoordinator, target: IntegrationTargetScope, request: UserIntegrationRequest): Promise<UserIntegrationResult> {
  const { binding, command } = request;
  const input: IntegrationPlanInput = { operationId: `integration:${binding.operationId}`,
    ...(request.pathMapping ? { pathMapping: request.pathMapping } : {}),
    workspaceId: binding.result.workspaceId, threadId: binding.childThreadId,
    branchId: binding.result.branchId, resultRevision: binding.result.resultRevision,
    operationBinding: binding, scopedWorkingStates: target.workingStates,
    parentAuthority: { kind: 'directory', directory: target.directory, workspaceId: target.documentWorkspaceId },
    ...(command.sourceOwner ? { sourceOwner: command.sourceOwner } : {}) };
  if (command.action === 'preview') {
    const preview = await coordinator.previewResult(input);
    return { state: { preview, operations: project(await coordinator.listIntegrations(input)) }, effect: 'none', executorStopped: true };
  }
  const before = await coordinator.listIntegrations(input);
  if (request.inspectOnly) {
    const original = before.find(row => row.operationId === (command.action === 'undo' ? command.operationId : input.operationId));
    return { state: { operations: project(before), ...(!original || original.effect === 'unknown'
      ? { problem: 'The original integration has not settled. Its files have not been replayed.' } : {}) },
      effect: original?.effect ?? 'unknown', executorStopped: original?.executorStopped ?? false };
  }
  try {
    if (command.action === 'apply') {
      const applied = await coordinator.mergeResult({ ...input, expectedBindingFingerprint: command.expectedBindingFingerprint, resolutions: command.resolutions });
      if (applied.status !== 'applied') return { state: { operations: project(await coordinator.listIntegrations(input)),
        problem: applied.failure ?? applied.text }, effect: applied.effect ?? 'unknown', executorStopped: applied.executorStopped ?? false };
    } else {
      if (!before.some(row => row.operationId === command.operationId)) throw new Error('Integration does not belong to this child result and parent source');
      await coordinator.undoIntegration({ workspaceId: input.workspaceId, threadId: input.threadId,
        operationId: command.operationId, scopedWorkingStates: target.workingStates,
        parentAuthority: input.parentAuthority, ...(input.sourceOwner ? { sourceOwner: input.sourceOwner } : {}) });
    }
    const rows = await coordinator.listIntegrations(input);
    const original = rows.find(row => row.operationId === (command.action === 'undo' ? command.operationId : input.operationId));
    return { state: { operations: project(rows) }, effect: original?.effect ?? 'unknown', executorStopped: original?.executorStopped ?? false };
  } catch (error) {
    const rows = await coordinator.listIntegrations(input);
    const original = rows.find(row => row.operationId === (command.action === 'undo' ? command.operationId : input.operationId));
    return { state: { operations: project(rows), problem: error instanceof Error ? error.message : String(error) },
      effect: original?.effect ?? 'none', executorStopped: original?.executorStopped ?? true };
  }
}

/** Remote input is validated against the admitted source; it never names an arbitrary directory. */
export function createUserIntegrationService(options: Omit<Owners, 'runtime' | 'resolveLiveSource'>): ManagedSourceServiceHandler {
  return async (scope, operation, signal = new AbortController().signal) => {
    if (operation.kind !== 'user_integration') throw new Error('Unsupported integration service');
    const { binding, command } = operation.request;
    if (!scope.principal.capabilities.includes('filesystem:write') || scope.scope.kind !== 'run' || !scope.physicalRoot
      || scope.scope.runId !== binding.parentRunId || scope.scope.threadId !== binding.parentThreadId
      || scope.operationId !== binding.operationId || !isDeepStrictEqual(scope.source, binding.target)
      || binding.kind !== 'user_operation' || binding.parentThreadId !== command.threadId || binding.parentBranchId !== command.branchId
      || binding.key !== command.key || binding.childExecutionId !== command.executionId
      || binding.result.publicationId !== command.publicationId || binding.result.workspaceId !== scope.source.workspace_id) {
      throw new Error('User integration differs from its admitted source or fixed publication');
    }
    const target = await openScopedIntegrationTarget(options, { runId: binding.parentRunId, threadId: binding.parentThreadId },
      savedSourceLaunch(binding.parentRunId, scope.source, []),
      { grant: scope.grant, rootId: scope.physicalRoot.rootId, canonicalRoot: scope.physicalRoot.canonicalRoot }, async () => {}, signal);
    return execute(options.coordinator, target, operation.request);
  };
}

export function createThreadIntegrations(options: Owners & {
  requireIdentity(identity: ThreadIdentity): Promise<unknown>;
  onError(error: unknown): void;
}) {
  const active = new Map<string, { input: ThreadIntegrationCommand; promise: Promise<ThreadIntegrationState> }>();
  let closed = false;
  const run = async (command: ThreadIntegrationCommand): Promise<ThreadIntegrationState> => {
    if (closed) throw new Error('Integration owner is closed');
    await options.requireIdentity(command);
    const child = await options.runtime.childExecution(command.executionId);
    if (child.parent_thread_id !== command.threadId || child.parent_branch_id !== command.branchId
      || child.code_result.kind !== 'published' || child.code_result.result.publication_id !== command.publicationId) {
      throw new Error('Published result does not belong to this parent branch');
    }
    const sourceRunId = command.action === 'undo' ? command.sourceRunId : child.parent_run_id;
    const sourceRun = await options.runtime.run(sourceRunId);
    if (sourceRun.thread_id !== command.threadId || sourceRun.branch_id !== command.branchId) throw new Error('Integration source belongs to another parent branch');
    const launch = await options.runtime.launch(sourceRunId);
    const source = launch?.selection.source;
    if (!launch || !source || source.mode === 'fixed_branch' || child.source?.kind !== 'ready'
      || !isDeepStrictEqual(source.resource_owner, child.source.selection.resource_owner)
      || source.workspace_id !== child.code_result.result.workspace_id) throw new Error('Original writable parent source is unavailable');
    const op: HostJobPending = await options.kernel.agentRuntimeRequest('runtime.host_job.user', {
      threadId: command.threadId, branchId: command.branchId, sourceRunId,
      key: command.key, domain: 'integrate_child', domainVersion: 1,
      subjectId: createHash('sha256').update(JSON.stringify([command.threadId, command.branchId, command.key])).digest('hex'), request: command,
    });
    if (op.phase === 'terminal') {
      const original = await options.runtime.operation(op.binding.operationId);
      if (original.result?.kind === 'output') return original.result.output.data as unknown as ThreadIntegrationState;
      throw new Error('Original integration result is unavailable');
    }
    if (op.cancelRequested) {
      if (op.accepted) return { operations: [], problem: 'Cancellation was requested. Refresh the preview to read the original file result.' };
      const result: ThreadIntegrationState = { operations: [], problem: 'Integration was cancelled.' };
      await options.kernel.agentRuntimeRequest('runtime.host_job.terminal', { binding: op.binding, outcome: 'cancelled',
        effect: 'none', executorStopped: true, content: { data: result, parts: [] } });
      return result;
    }
    const fixed = child.code_result.result;
    const binding: UserIntegrationBinding = { kind: 'user_operation', operationId: op.binding.operationId, key: command.key,
      parentThreadId: command.threadId, parentBranchId: command.branchId, parentRunId: sourceRunId,
      childThreadId: child.child_thread_id, childExecutionId: child.execution_id, childOperationId: child.child_operation_id,
      result: { workspaceId: fixed.workspace_id, branchId: fixed.branch_id, resultRevision: fixed.result_revision,
        root: fixed.root, publicationId: fixed.publication_id }, target: source };
    const signal = new AbortController().signal;
    let admission: Awaited<ReturnType<typeof admitRunSourceAuthority>> | undefined;
    let dispatched = false;
    let result: UserIntegrationResult;
    try {
      const selected = savedSourceLaunch(sourceRunId, source, sourceToolSchemas(launch.selection).map(tool => tool.name));
      admission = await admitRunSourceAuthority(options.kernel, options.runtime, selected, { signal,
        purpose: 'integration', operationId: binding.operationId, retention: 'caller', resolveLiveSource: options.resolveLiveSource });
      if (!op.accepted && command.action !== 'preview') await options.kernel.agentRuntimeRequest('runtime.host_job.accept', {
        binding: op.binding, content: { data: { action: command.action, executionId: child.execution_id }, parts: [] },
      });
      const request: UserIntegrationRequest = { binding, command, inspectOnly: op.accepted,
        ...(child.receipt ? { pathMapping: await sourcePathMap(options.runtime,
          { runId: child.receipt.run_id, source: child.source.selection }, { runId: sourceRunId, source }, signal) } : {}) };
      if (admission.kind === 'managed') {
        dispatched = true;
        result = await admission.service.service({ coordinatorHostId: options.runtime.coordinatorHostId,
          authorityId: admission.binding.authorityId, resourceEpoch: admission.binding.resourceEpoch,
          requestId: randomUUID(), operation: { kind: 'user_integration', request } }, signal) as UserIntegrationResult;
      } else {
        const target = await openScopedIntegrationTarget(options, { runId: sourceRunId, threadId: command.threadId },
          selected, admission, async () => {}, signal);
        dispatched = true;
        result = await execute(options.coordinator, target, request);
      }
    } catch (error) {
      result = { state: { operations: [], problem: error instanceof Error ? error.message : String(error) },
        effect: dispatched && command.action !== 'preview' ? 'unknown' : 'none', executorStopped: !dispatched || command.action === 'preview' };
    } finally {
      try { await admission?.release(); } catch (error) { options.onError(error); }
    }
    const unknown = result.effect === 'unknown';
    await options.kernel.agentRuntimeRequest('runtime.host_job.terminal', { binding: op.binding,
      outcome: unknown ? 'indeterminate' : result.state.problem ? 'failed' : 'succeeded',
      effect: result.effect, executorStopped: result.executorStopped, content: { data: result.state, parts: [] } });
    // Reading an original journal can settle a response lost before Catalog recorded it.
    // This never runs an apply/undo again, nor infers stop from an HTTP connection closing.
    for (const row of result.state.operations) {
      if (row.effect === 'unknown' || !row.executorStopped) continue;
      try {
        const original = await options.runtime.findOperation(row.operationId.slice('integration:'.length));
        if (!original?.host_job || original.host_job.binding.domain !== 'integrate_child'
          || original.effect !== 'unknown' || original.id === op.binding.operationId) continue;
        const intent = original.intent as { kind?: string; request?: ThreadIntegrationCommand };
        if (intent.kind !== 'user_host_job' || intent.request?.action !== 'apply') continue;
        await options.kernel.agentRuntimeRequest('runtime.host_job.terminal', { binding: original.host_job.binding,
          outcome: row.state === 'complete' ? 'succeeded' : 'failed', effect: row.effect, executorStopped: true,
          content: { data: { operations: [row] }, parts: [] } });
      } catch (error) { options.onError(error); }
    }
    return result.state;
  };
  return {
    submit(command: ThreadIntegrationCommand) {
      const key = JSON.stringify([command.threadId, command.branchId, command.key]);
      const current = active.get(key);
      if (current) {
        if (!isDeepStrictEqual(current.input, command)) return Promise.reject(new Error('Integration request identity changed'));
        return current.promise;
      }
      const promise = run(command);
      active.set(key, { input: command, promise });
      void promise.finally(() => active.delete(key)).catch(() => undefined);
      return promise;
    },
    async dispose() { closed = true; await Promise.allSettled([...active.values()].map(value => value.promise)); },
  };
}
