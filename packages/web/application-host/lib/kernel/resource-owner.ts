import { createAgentResourceAuthority, type AgentResourceRead } from '../agent-resources/authority.js';
import type { ResourceFailureStatus } from '../agent-resources/source-reader.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { AgentResourceRequest, ResourceSnapshotParams } from './protocol.generated.js';
import { resourceThreadSource } from './thread-context.js';
import { ResourceScopeError, type ThreadResourceScope } from './thread-resource-scope.js';
import type { InteractiveUiRuntime } from '../interactive-ui/runtime.js';
import { UiContentError } from '../interactive-ui/store.js';

export interface ResourceQuery extends Omit<ResourceSnapshotParams, 'activationId'> { request: AgentResourceRequest }
export type ResourceToolResult = (AgentResourceRead | ({ status: 'ready' } & Record<string, unknown>)) & { snapshotId?: string; resourceCheckpointId?: string };
export type ResourceOwner = (query: ResourceQuery, signal: AbortSignal) => Promise<ResourceToolResult>;
export function resourceQueryFailure(status: ResourceFailureStatus, reason: string, query?: ResourceQuery, snapshotId?: string): ResourceToolResult {
  const target = query?.request.kind === 'ui' ? query.request.ref : query?.request.kind === 'instruction-scope' ? query.request.targetPath
    : query?.request.kind === 'skill-resource' ? query.request.relativePath : query?.request.resourceId ?? '';
  return { status, reason, domainId: 'agent-resources', viewId: snapshotId ?? query?.resourceCheckpointId ?? 'unbound', path: target,
    ...(snapshotId ? { snapshotId } : {}), ...(query ? { resourceCheckpointId: query.resourceCheckpointId } : {}) };
}
/** No Host snapshot cache: each call resolves the immutable checkpoint selected by its actual origin. */
export function createResourceOwner(options: {
  runtime: Pick<AgentRuntimeClient, 'run' | 'resourceSnapshot'>;
  resources: ThreadResourceScope;
  ui?: InteractiveUiRuntime;
}): ResourceOwner {
  const authority = createAgentResourceAuthority();
  return async (query, signal) => {
    let snapshotId: string | undefined;
    try {
      signal.throwIfAborted();
      if (query.request.kind === 'ui') {
        // Original Catalog invocation/checkpoint validation still precedes this domain read.
        await options.runtime.resourceSnapshot({ runId: query.runId, origin: query.origin, callId: query.callId, resourceCheckpointId: query.resourceCheckpointId }, signal);
        const run = await options.runtime.run(query.runId, signal);
        if (!options.ui) return resourceQueryFailure('unavailable', 'Interactive content is unavailable', query);
        const result = await options.ui.read(await options.ui.scope(run.thread_id), query.request, signal);
        signal.throwIfAborted();
        return result as ResourceToolResult;
      }
      const activationId = query.request.kind === 'instruction-scope' ? undefined : query.request.activationId;
      const frozen = { runId: query.runId, origin: query.origin, callId: query.callId, resourceCheckpointId: query.resourceCheckpointId,
        ...(activationId ? { activationId } : {}) };
      const resources = await options.runtime.resourceSnapshot(frozen, signal);
      const snapshot = resources.snapshot; snapshotId = snapshot.id;
      const run = await options.runtime.run(query.runId, signal);
      if (run.cancel_requested || ['completed', 'failed', 'cancelled'].includes(run.state)) return resourceQueryFailure('cancelled', 'Resource Run is closed', query, snapshotId);
      if (run.thread_id !== snapshot.scope.threadId) return resourceQueryFailure('denied', 'Resource scope belongs to another Thread', query, snapshotId);
      const request = query.request;
      const result = await options.resources.withScope({ runtime: 'agent', threadId: run.thread_id, branchId: run.branch_id },
        resourceThreadSource(resources.source), snapshot.scope, async ({ readers }) => {
          signal.throwIfAborted();
          return authority.read({ snapshot, readers }, request, signal);
        }, { snapshot, signal, runId: query.runId, request: query.request });
      // A cancellation or revocation during owner work cannot publish a successful old read.
      const current = await options.runtime.run(query.runId, signal);
      signal.throwIfAborted();
      if (current.epoch !== run.epoch) return resourceQueryFailure('stale', 'Resource Run belongs to an earlier epoch', query, snapshotId);
      if (current.cancel_requested || ['completed', 'failed', 'cancelled'].includes(current.state)) return resourceQueryFailure('cancelled', 'Resource Run is closed', query, snapshotId);
      return { ...result, snapshotId, resourceCheckpointId: query.resourceCheckpointId };
    } catch (error) {
      if (error instanceof UiContentError) return resourceQueryFailure(error.status === 404 ? 'missing' : error.status === 409 ? 'stale' : error.status === 400 ? 'invalid' : 'unavailable', error.message, query, snapshotId);
      if (signal.aborted) return resourceQueryFailure('cancelled', 'Resource query was cancelled', query, snapshotId);
      const failure = error instanceof ResourceScopeError ? error.failure : undefined;
      if (failure) return { ...failure, ...(snapshotId ? { snapshotId } : {}), resourceCheckpointId: query.resourceCheckpointId };
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const status = code === 'cancelled' ? 'cancelled' : ['unauthorized', 'forbidden'].includes(String(code)) ? 'denied'
        : code === 'protocol-error' ? 'invalid' : code === 'kernel-grant-stale' ? 'stale' : 'unavailable';
      return resourceQueryFailure(status, status === 'denied' ? 'Resource authorization is no longer valid'
        : status === 'cancelled' ? 'Resource query was cancelled' : status === 'invalid' ? 'Resource binding is invalid'
          : status === 'stale' ? 'Resource owner belongs to an earlier epoch' : 'Resource owner could not read the bound view', query, snapshotId);
    }
  };
}
