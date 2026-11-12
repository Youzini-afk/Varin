import { createAgentResourceAuthority, type AgentResourceRead } from '../agent-resources/authority.js';
import type { ResourceFailureStatus } from '../agent-resources/source-reader.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { AttachmentSelection, AgentResourceRequest, ResourceSnapshotParams } from './protocol.generated.js';
import { resourceThreadSource } from './thread-context.js';
import { ResourceScopeError, type ThreadResourceScope } from './thread-resource-scope.js';
import type { InteractiveUiRuntime } from '../interactive-ui/runtime.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { ThreadAttachmentOwner } from './thread-attachments.js';
import { UiContentError } from '../interactive-ui/store.js';

export type AttachmentOwnerRequest =
  | { kind: 'attachment_prepare'; operationId: string; targetThreadId: string; targetBranchId?: string; attachments: AttachmentSelection[] }
  | { kind: 'attachment_report'; refs: string[]; sourceThreadId?: string; sourceBranchId?: string }
  | { kind: 'attachment_release'; operationId: string; targetThreadId: string; targetBranchId?: string }
  | { kind: 'attachment'; ref: string; view?: 'path' | 'content' | 'bytes'; offset?: number; limit?: number };
export interface OrganizationOwnerRequest { kind: 'organization'; operationId: string; action: 'create_bot_conversation' | 'external_metadata' | 'labels' | 'create_conversation' | 'ensure_initialized'; input: Record<string, unknown> }
export interface ResourceQuery extends Omit<ResourceSnapshotParams, 'activationId' | 'resourceCheckpointId'> { resourceCheckpointId?: string | null; request: AgentResourceRequest | AttachmentOwnerRequest | OrganizationOwnerRequest }
export type ResourceToolResult = (AgentResourceRead | ({ status: 'ready' } & Record<string, unknown>)) & { snapshotId?: string; resourceCheckpointId?: string };
export type ResourceOwner = (query: ResourceQuery, signal: AbortSignal) => Promise<ResourceToolResult>;
export function resourceQueryFailure(status: ResourceFailureStatus, reason: string, query?: ResourceQuery, snapshotId?: string, code?: string): ResourceToolResult {
  const target = query?.request.kind === 'organization' ? query.request.operationId : query?.request.kind === 'attachment' ? query.request.ref : query?.request.kind === 'attachment_prepare' || query?.request.kind === 'attachment_release' || query?.request.kind === 'attachment_report' ? '' : query?.request.kind === 'ui' ? query.request.ref : query?.request.kind === 'instruction-scope' ? query.request.targetPath
    : query?.request.kind === 'skill-resource' ? query.request.relativePath : query?.request.resourceId ?? '';
  return { status, reason, ...(code ? { code } : {}), domainId: 'agent-resources', viewId: snapshotId ?? query?.resourceCheckpointId ?? 'unbound', path: target,
    ...(snapshotId ? { snapshotId } : {}), ...(query?.resourceCheckpointId ? { resourceCheckpointId: query.resourceCheckpointId } : {}) };
}
/** No Host snapshot cache: each call resolves the immutable checkpoint selected by its actual origin. */
export function createResourceOwner(options: {
  runtime: Pick<AgentRuntimeClient, 'run' | 'resourceSnapshot'> & Partial<Pick<AgentRuntimeClient, 'organizationInvocation'>>;
  resources: ThreadResourceScope;
  ui?: InteractiveUiRuntime;
  attachments?: ThreadAttachmentOwner;
  organization?: (request: OrganizationOwnerRequest, run: Awaited<ReturnType<AgentRuntimeClient['run']>>, signal: AbortSignal) => Promise<Record<string, unknown>>;
}): ResourceOwner {
  const authority = createAgentResourceAuthority();
  return async (incoming, signal) => {
    // Organization metadata has no filesystem Source. Only the exact original
    // invocation can authorize it; absence of a file snapshot is not a permit.
    if (incoming.request.kind === 'organization') {
      let run:Awaited<ReturnType<AgentRuntimeClient['run']>>;
      try {
        signal.throwIfAborted();
        if (!options.runtime.organizationInvocation || !options.organization) return resourceQueryFailure('unavailable','Organization invocation owner is unavailable',incoming);
        run=await options.runtime.organizationInvocation({runId:incoming.runId,origin:incoming.origin,callId:incoming.callId,operationId:incoming.request.operationId},signal);
        if(run.cancel_requested || ['completed','failed','cancelled'].includes(run.state))return resourceQueryFailure('cancelled','Organization invocation Run is closed',incoming);
      } catch(error) {
        if(signal.aborted)return resourceQueryFailure('cancelled','Organization invocation was cancelled',incoming);
        return resourceQueryFailure('denied',error instanceof Error?error.message:'Organization invocation is unavailable',incoming);
      }
      try { return {status:'ready',...await options.organization(incoming.request,run,signal)}; }
      catch(error) {
        // Owner work may already have committed. Do not relabel a lost receipt
        // as an authorization denial or as proof that the action never started.
        return resourceQueryFailure('unavailable',error instanceof Error?error.message:'Organization owner could not confirm the original result',incoming);
      }
    }
    if (!incoming.resourceCheckpointId) return resourceQueryFailure('denied','A bound resource checkpoint is required',incoming);
    const query:Omit<ResourceQuery,'request'> & {resourceCheckpointId:string;request:Exclude<ResourceQuery['request'],OrganizationOwnerRequest>}={...incoming,request:incoming.request,resourceCheckpointId:incoming.resourceCheckpointId};
    let snapshotId: string | undefined;
    try {
      signal.throwIfAborted();
      if (query.request.kind === 'attachment_prepare' || query.request.kind === 'attachment_release' || query.request.kind === 'attachment_report' || query.request.kind === 'attachment') {
        if (!options.attachments) return resourceQueryFailure('unavailable', 'The original attachment owner is unavailable', query);
        if (query.request.kind === 'attachment_report') return { status: 'ready', ...await options.attachments.reportQuery({ ...query, request: query.request }, signal) };
        if (query.request.kind === 'attachment_release') { await options.attachments.releaseQuery({ ...query, request: query.request }, signal); return { status: 'ready', released: true }; }
        if (query.request.kind === 'attachment_prepare') return { status: 'ready', attachments: await options.attachments.prepareQuery({ ...query, request: query.request }, signal) };
        const frozen = await options.runtime.resourceSnapshot({ runId: query.runId, origin: query.origin, callId: query.callId, resourceCheckpointId: query.resourceCheckpointId }, signal);
        const run = await options.runtime.run(query.runId, signal);
        const identity = { runtime: 'agent' as const, threadId: run.thread_id, branchId: run.branch_id };
        const request = query.request;
        if (request.view === 'path') return { status: 'ready', ...await options.attachments.path(identity, request.ref, query.runId, signal, frozen.source) };
        const chunk = await options.attachments.readChunk(identity, request.ref, request.offset, request.limit, signal);
        if (request.view === 'content') {
          try { return { status: 'ready', attachment: chunk.attachment, content: { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(chunk.bytesBase64, 'base64')), offset: chunk.offset, nextOffset: chunk.nextOffset, byteLength: chunk.attachment.byteLength, eof: chunk.eof } }; }
          catch { return { status: 'ready', attachment: chunk.attachment, content: { bytesBase64: chunk.bytesBase64, offset: chunk.offset, nextOffset: chunk.nextOffset, byteLength: chunk.attachment.byteLength, eof: chunk.eof } }; }
        }
        return { status: 'ready', ...chunk };
      }
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
      if (error instanceof HarnessServiceError) return resourceQueryFailure(error.harnessCode === 'forbidden' ? 'denied' : error.harnessCode === 'not-found' ? 'missing' : error.harnessCode === 'invalid-params' ? 'invalid' : 'unavailable', error.message, query);
      if (error instanceof UiContentError) return resourceQueryFailure(error.status === 404 ? 'missing' : error.status === 409 ? 'stale' : error.status === 400 ? 'invalid' : 'unavailable', error.message, query, snapshotId, error.code);
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
