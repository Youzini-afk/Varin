/** Explicit research provenance and authorization. These are constructed by trusted owners only. */
import type { ExecutorOwner, LaunchSource, ToolOrigin } from '../kernel/protocol.generated.js';
import type { KernelRecordResult } from '../kernel/protocol.generated.js';
import { HarnessServiceError } from './service-error.js';
export type ResearchOwner = {
  runtime: 'agent';
  actor: {
    kind: 'tool';
    origin: ToolOrigin;
    callId: string;
    toolName: string;
    schemaVersion: string;
  } | {
    kind: 'user';
    key: string;
  };
  rootThreadId: string;
  threadId: string;
  branchId: string;
  runId: string;
  operationId: string;
  executionOwner: ExecutorOwner;
  source: LaunchSource;
};
export type ResearchReader = {
  runtime: 'agent';
  actor: {
    kind: 'reader';
  };
  rootThreadId: string;
  threadId: string;
  branchId: string;
  runId: string;
  source: LaunchSource;
};
export function requireResearchOwner(caller: ExperimentCaller): ResearchOwner {
  if (caller.owner.runtime !== 'agent' || !('operationId' in caller.owner))
    throw new HarnessServiceError('denied', 'A read scope cannot create research work');
  if (!validOwner(caller.owner) || caller.owner.source.workspace_id !== caller.workspaceId || caller.owner.source.execution_workspace_id !== caller.executionWorkspaceId)
    throw new HarnessServiceError('denied', 'Research work requires its original native owner and source');
  return caller.owner;
}
export interface ExperimentCaller {
  workspaceId: string;
  executionWorkspaceId: string;
  owner: ResearchOwner | ResearchReader;
  workspaceScope?: readonly string[];
  access: {
    kind: 'family';
    readThreadIds: readonly string[];
    controlThreadIds: readonly string[];
  } | {
    kind: 'maintenance';
  };
}
export const researchNamespace = (caller: ExperimentCaller): string => `agent:${caller.owner.rootThreadId}`;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validSource = (source: unknown): source is LaunchSource => {
  if (!object(source) || !nonempty(source.workspace_id) || !nonempty(source.execution_workspace_id) || !object(source.resource_owner)) return false;
  const resource = source.resource_owner;
  if (resource.kind !== 'local' && !(resource.kind === 'managed_host' && nonempty(resource.hostId) && nonempty(resource.connectionId) && nonempty(resource.endpointIdentity))) return false;
  if (source.mode === 'live_root') return source.branch_id === null && source.revision === null && object(source.live_root)
    && nonempty(source.live_root.hostId) && nonempty(source.live_root.rootId) && nonempty(source.live_root.canonicalRoot);
  if(source.mode==='native_workspace')return nonempty(source.branch_id)&&source.revision===null&&source.live_root===null
    && (source.native_scope===undefined||nonempty(source.native_scope)&&source.native_scope.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!part.includes('\\')));
  return ['fixed_branch', 'materialized'].includes(String(source.mode)) && nonempty(source.branch_id)
    && Number.isSafeInteger(source.revision) && Number(source.revision) >= 0 && source.live_root === null;
};
const validActor = (actor: unknown): boolean => {
  if (!object(actor)) return false;
  if (actor.kind === 'user') return nonempty(actor.key);
  if (actor.kind !== 'tool' || !nonempty(actor.callId) || !nonempty(actor.toolName) || !nonempty(actor.schemaVersion) || !object(actor.origin)) return false;
  const origin = actor.origin;
  return origin.kind === 'model_step' ? nonempty(origin.request_id)
    : origin.kind === 'policy_action' ? nonempty(origin.action_id) && nonempty(origin.node_id)
    : origin.kind === 'nested_call' && nonempty(origin.parent_operation_id);
};
const validOwner = (owner: unknown): owner is ResearchOwner => object(owner) && owner.runtime === 'agent'
  && !('sessionId' in owner) && !('rootSessionId' in owner)
  && ['rootThreadId', 'threadId', 'branchId', 'runId', 'operationId'].every(key => nonempty(owner[key]))
  && validSource(owner.source) && validActor(owner.actor) && object(owner.executionOwner)
  && (owner.executionOwner.kind === 'kernel' || (owner.executionOwner.kind === 'external' && nonempty(owner.executionOwner.identity) && nonempty(owner.executionOwner.epoch)));
export function researchOwner(record: KernelRecordResult): ResearchOwner {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(record.payloadJson) as Record<string, unknown>;
  }
  catch {
    throw new HarnessServiceError('unavailable', 'Research record provenance is unreadable');
  }
  if (!object(payload)) throw new HarnessServiceError('unavailable', 'Research record provenance is unreadable');
  const owner = payload.researchOwner;
  if (!validOwner(owner)
    || owner.threadId !== record.threadId || owner.runId !== record.runId
    || (record.sessionId !== undefined && record.sessionId !== null)
    || owner.source.workspace_id !== record.workspaceId || owner.source.execution_workspace_id !== payload.executionWorkspaceId) {
    throw new HarnessServiceError('unavailable', 'Research record has no valid original runtime owner');
  }
  return owner;
}
export function mayAccessResearch(caller: ExperimentCaller, record: KernelRecordResult, control = false): boolean {
  const owner = researchOwner(record);
  if (caller.access.kind === 'maintenance')
    return true;
  if (`agent:${owner.rootThreadId}` !== researchNamespace(caller)) return false;
  const selected = control ? caller.access.controlThreadIds : caller.access.readThreadIds;
  return selected.includes(owner.threadId);
}
/** Recovery acts only on the record's actual provenance. The explicit tag cannot come from a request. */
export function researchMaintenanceCaller(workspaceId: string, record: KernelRecordResult): ExperimentCaller {
  const owner = researchOwner(record);
  if (workspaceId !== record.workspaceId) throw new HarnessServiceError('unavailable', 'Research recovery workspace differs from its original owner');
  const payload = JSON.parse(record.payloadJson) as Record<string, unknown>;
  if (typeof payload.executionWorkspaceId !== 'string' || !payload.executionWorkspaceId)
    throw new HarnessServiceError('unavailable', 'Research execution workspace is missing');
  return { workspaceId, executionWorkspaceId: payload.executionWorkspaceId, owner, access: { kind: 'maintenance' },
    workspaceScope: Array.isArray(payload.workspaceScope) ? payload.workspaceScope as string[] : [] };
}
