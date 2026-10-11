/** Explicit research provenance and authorization. These are constructed by trusted owners only. */
import type { ExecutorOwner, LaunchSource, ToolOrigin } from '../kernel/protocol.generated.js';
import type { KernelRecordResult } from '../kernel/protocol.generated.js';
import { HarnessServiceError } from './service-error.js';
export type ResearchOwner = {
  runtime: 'pi';
  rootSessionId: string;
  sessionId?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
} | {
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
  if (caller.owner.runtime === 'agent' && !('operationId' in caller.owner))
    throw new HarnessServiceError('denied', 'A read scope cannot create research work');
  return caller.owner as ResearchOwner;
}
export interface ExperimentCaller {
  workspaceId: string;
  executionWorkspaceId: string;
  owner: ResearchOwner | ResearchReader;
  /** Actual Pi attribution only; native identities never populate these fields. */
  sessionId?: string | undefined;
  rootSessionId?: string | undefined;
  threadId?: string | undefined;
  runId?: string | undefined;
  workspaceScope?: readonly string[];
  access: {
    kind: 'family';
    readThreadIds: readonly string[];
    controlThreadIds: readonly string[];
  } | {
    kind: 'maintenance';
  };
}
export const researchNamespace = (caller: ExperimentCaller): string => caller.owner.runtime === 'agent'
  ? `agent:${caller.owner.rootThreadId}` : `pi:${caller.owner.rootSessionId}`;
export function researchOwner(record: KernelRecordResult): ResearchOwner {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(record.payloadJson) as Record<string, unknown>;
  }
  catch {
    throw new HarnessServiceError('unavailable', 'Research record provenance is unreadable');
  }
  const owner = payload.researchOwner as ResearchOwner | undefined;
  if (!owner || (owner.runtime !== 'pi' && owner.runtime !== 'agent')
    || (owner.runtime === 'pi' ? !owner.rootSessionId : !owner.rootThreadId || !owner.threadId || !owner.runId || !owner.operationId || !owner.source || !owner.executionOwner || !owner.actor)
    || (owner.threadId ?? undefined) !== (record.threadId ?? undefined) || (owner.runId ?? undefined) !== (record.runId ?? undefined)
    || (owner.runtime === 'agent' && record.sessionId !== undefined && record.sessionId !== null)) {
    throw new HarnessServiceError('unavailable', 'Research record has no valid original runtime owner');
  }
  return owner;
}
export function mayAccessResearch(caller: ExperimentCaller, record: KernelRecordResult, control = false): boolean {
  const owner = researchOwner(record);
  if (caller.access.kind === 'maintenance')
    return true;
  if (owner.runtime !== caller.owner.runtime)
    return false;
  const root = owner.runtime === 'agent' ? `agent:${owner.rootThreadId}` : `pi:${owner.rootSessionId}`;
  if (root !== researchNamespace(caller))
    return false;
  const selected = control ? caller.access.controlThreadIds : caller.access.readThreadIds;
  if (owner.threadId)
    return selected.includes(owner.threadId);
  return owner.runtime === 'pi' && caller.owner.runtime === 'pi'
    && !!owner.sessionId && [caller.owner.sessionId, caller.owner.rootSessionId].includes(owner.sessionId);
}
/** Recovery acts only on the record's actual provenance. The explicit tag cannot come from a request. */
export function researchMaintenanceCaller(workspaceId: string, record: KernelRecordResult): ExperimentCaller {
  const owner = researchOwner(record);
  const payload = JSON.parse(record.payloadJson) as Record<string, unknown>;
  if (typeof payload.executionWorkspaceId !== 'string' || !payload.executionWorkspaceId)
    throw new HarnessServiceError('unavailable', 'Research execution workspace is missing');
  return { workspaceId, executionWorkspaceId: payload.executionWorkspaceId, owner, access: { kind: 'maintenance' },
    ...(owner.runtime === 'pi' ? { rootSessionId: owner.rootSessionId, sessionId: owner.sessionId } : {}),
    threadId: owner.threadId, runId: owner.runId,
    workspaceScope: Array.isArray(payload.workspaceScope) ? payload.workspaceScope as string[] : [] };
}
