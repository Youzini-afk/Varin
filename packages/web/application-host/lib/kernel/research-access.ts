/** Shared projection of Catalog's original research scope and invocation. No local ACL or job ledger. */
import { isDeepStrictEqual } from 'node:util';
import type { ThreadIdentity, ThreadResearchSelection } from '@varin/application-client';
import type { ExperimentCaller, ResearchOwner } from '../harness/research-identity.js';
import { HarnessServiceError } from '../harness/service-error.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { Operation, ResearchScope } from './protocol.generated.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';

export function researchCaller(scope: ResearchScope, owner?: ResearchOwner): ExperimentCaller {
  return { workspaceId: scope.source.workspace_id, executionWorkspaceId: scope.source.execution_workspace_id,
    owner: owner ?? { runtime: 'agent', actor: { kind: 'reader' }, rootThreadId: scope.rootThreadId,
      threadId: scope.threadId, branchId: scope.branchId, runId: scope.sourceRunId, source: scope.source },
    threadId: scope.threadId, runId: scope.sourceRunId, workspaceScope: [''],
    access: { kind: 'family', readThreadIds: scope.readThreadIds, controlThreadIds: scope.controlThreadIds } };
}

export function createResearchAccess(kernel: KernelClient, runtime: Pick<AgentRuntimeClient, 'run'>) {
  const scopes = (identity: ThreadIdentity, sourceRunId?: string, operationId?: string, signal?: AbortSignal) => {
    if (identity.runtime !== 'agent') throw new HarnessServiceError('denied', 'A real native Thread identity is required');
    return kernel.agentRuntimeRequest<ResearchScope[], 'runtime.research.scopes'>('runtime.research.scopes', {
      threadId: identity.threadId, branchId: identity.branchId, ...(sourceRunId ? { sourceRunId } : {}),
      ...(operationId ? { operationId } : {}),
    }, signal);
  };
  const selected = async (selection: ThreadResearchSelection, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const scope = (await scopes(selection, selection.sourceRunId, undefined, signal))[0];
    if (!scope) throw new HarnessServiceError('unavailable', 'Original research source is unavailable');
    return scope;
  };
  const toolScope = async (authority: ToolInvocationAuthority, signal?: AbortSignal) => {
    const run = await runtime.run(authority.runId, signal);
    const scope = (await scopes({ runtime: 'agent', threadId: authority.threadId, branchId: run.branch_id },
      authority.runId, authority.operationId, signal))[0];
    if (!scope || !isDeepStrictEqual(scope.source, authority.source)) throw new Error('Original research source differs from the admitted invocation');
    const op = await kernel.agentRuntimeRequest<Operation, 'runtime.operation.inspect'>('runtime.operation.inspect', { operationId: authority.operationId }, signal);
    if (!op.execution_owner) throw new Error('Original tool execution owner missing');
    const intent = op.intent as { call: { call_id: string; schema_version: string }; contract: { completion: string; lifetime: string } };
    const owner: ResearchOwner = { runtime: 'agent', actor: { kind: 'tool', origin: authority.origin,
      callId: intent.call.call_id, toolName: authority.toolName, schemaVersion: intent.call.schema_version },
      rootThreadId: scope.rootThreadId, threadId: scope.threadId, branchId: scope.branchId, runId: scope.sourceRunId,
      operationId: op.id, executionOwner: op.execution_owner, source: scope.source };
    return { scope, owner, op, contract: intent.contract };
  };
  return { scopes, selected, toolScope };
}
