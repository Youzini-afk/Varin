/** Closed source-local MCP requests. No paths, credentials or arbitrary Host method names. */
import type { McpAuthorityBinding, McpAuthorityService, McpServiceRequest, McpInteractionOrigin } from '@varin/pi-host/mcp-authority';
import type { McpBinding, McpEndpoint, McpResourceBinding, McpInteractionBinding, SourceMcpDeliveryReceipt, SourceMcpHolderBinding, SourceMcpCreationOutcome } from '../kernel/protocol.generated.js';

/** The body projection crosses the content lane, never an authority control snapshot. */
export interface ManagedMcpTaskCreationReceipt { requestHash: string; outcome: SourceMcpCreationOutcome | null }
export type ManagedMcpTaskAction =
  | { kind: 'task_prepare'; handleId: string; server: string; endpoint?: McpEndpoint }
  | { kind: 'task_start'; handleId: string; binding: SourceMcpHolderBinding; name: string; schemaVersion: string; arguments: Record<string, unknown>; ttl?: number }
  | { kind: 'task_inspect'; binding: SourceMcpHolderBinding; fenceUnstarted?: boolean }
  | { kind: 'task_get' | 'task_result' | 'task_cancel'; binding: SourceMcpHolderBinding; taskId: string }
  | { kind: 'task_release'; binding: SourceMcpHolderBinding };
export function isManagedMcpTaskContinuation(action: ManagedMcpAction): action is Exclude<ManagedMcpTaskAction, { kind: 'task_prepare' | 'task_start' }> {
  return ['task_inspect', 'task_get', 'task_result', 'task_cancel', 'task_release'].includes(action.kind);
}
export type ManagedMcpResourceAction =
  | { kind: 'resource_subscribe'; handleId: string; binding: McpResourceBinding; service: McpAuthorityService }
  | { kind: 'resource_inspect'; binding: McpResourceBinding; fenceUnstarted?: boolean }
  | { kind: 'resource_watch'; binding: McpResourceBinding; listenerId: string; after: number }
  | { kind: 'resource_release'; binding: McpResourceBinding; interaction?: McpInteractionOrigin };
export function isManagedMcpResourceContinuation(action: ManagedMcpAction): action is Exclude<ManagedMcpResourceAction, { kind: 'resource_subscribe' }> {
  return ['resource_inspect', 'resource_watch', 'resource_release'].includes(action.kind);
}
export interface ManagedMcpResourceSnapshot {
  listenerId: string;
  revision: number;
  changes: Array<{ revision: number; change: import('@varin/pi-host/mcp-authority').McpResourceChange }>;
}
/** Original SDK responders are observed over the authenticated Source address. */
export type ManagedMcpInteractionResponse =
  | { kind: 'result'; value: Record<string, unknown> }
  | { kind: 'sampling_rejected' };
export type ManagedMcpInteractionAction =
  | { kind: 'interaction_watch'; incarnation?: string; after: number }
  | { kind: 'interaction_read' | 'interaction_inspect'; deliveryId: string; binding: McpInteractionBinding }
  | { kind: 'interaction_respond'; deliveryId: string; binding: McpInteractionBinding; response: ManagedMcpInteractionResponse }
  | { kind: 'interaction_ack' | 'interaction_release'; deliveryId: string; binding: McpInteractionBinding; revision: number }
  | { kind: 'interaction_close'; deliveryId: string; binding: McpInteractionBinding; availability: 'rpc_closed' | 'connection_lost' | 'owner_unavailable' | 'cancelled' };
export function isManagedMcpInteractionContinuation(action: ManagedMcpAction): action is ManagedMcpInteractionAction {
  return action.kind.startsWith('interaction_');
}
export interface ManagedMcpInteractionSnapshot {
  incarnation: string;
  revision: number;
  deliveries: Array<{ receipt: SourceMcpDeliveryReceipt; live: boolean }>;
}
export interface ManagedMcpInteractionInspection {
  receipt: SourceMcpDeliveryReceipt;
  live: boolean;
}
export type ManagedMcpInteractionBody =
  | { kind: 'elicitation' | 'sampling'; deliveryId: string; binding: McpInteractionBinding; request: Record<string, unknown> }
  | { kind: 'error'; request: Record<string, unknown>; items: Array<{ deliveryId: string; binding: McpInteractionBinding;
      presentation: Extract<import('@varin/protocol').McpElicitationPresentation, { mode: 'url' }> }> };
export type ManagedMcpAction = ManagedMcpTaskAction | ManagedMcpResourceAction | ManagedMcpInteractionAction
  | { kind: 'snapshot'; handleId: string; creationRequestId: string; selection?: McpBinding }
  | { kind: 'changed'; incarnation: string; after: number }
  | { kind: 'release'; handleId: string; creationRequestId: string }
  | { kind: 'discover'; handleId: string; server: string }
  | { kind: 'prepare_tool'; handleId: string; server: string; tool: string; schemaVersion: string }
  | { kind: 'discover_services'; handleId: string; server: string }
  | { kind: 'prepare_service'; handleId: string; server: string; serviceKind: McpAuthorityService['kind']; schemaVersion: string }
  | { kind: 'prepare_prompt'; handleId: string; server: string; name: string; schemaVersion: string }
  | { kind: 'call'; handleId: string; name: string; schemaVersion: string; arguments: Record<string, unknown>; interaction?: McpInteractionOrigin }
  | { kind: 'service'; handleId: string; service: McpAuthorityService; request: McpServiceRequest; interaction?: McpInteractionOrigin };
export interface ManagedMcpRevocations {
  tools: Array<{ name: string; schemaVersion: string }>;
  services: Array<{ server: string; schemaVersion: string }>;
}
export function isManagedMcpRevocations(value: unknown): value is ManagedMcpRevocations {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const facts = value as Record<string, unknown>;
  return (['tools', 'services'] as const).every(kind => Array.isArray(facts[kind]) && facts[kind].every(target =>
    target && typeof target === 'object' && !Array.isArray(target)
      && typeof target[kind === 'tools' ? 'name' : 'server'] === 'string'
      && Boolean(target[kind === 'tools' ? 'name' : 'server'])
      && typeof target.schemaVersion === 'string' && Boolean(target.schemaVersion)));
}
export interface ManagedMcpSnapshot {
  revocations: ManagedMcpRevocations;
  incarnation: string;
  revision: number;
  binding: McpAuthorityBinding;
  implementationIdentity: string;
}
export type ManagedMcpReply =
  | { ok: true; value: unknown; executorStopped: true }
  | { ok: false; error: { code: string; dispatched: boolean; settlement: 'unknown' | 'session_expired' | 'rpc_response'; protocolError?: Record<string, unknown>; interactionProblem?: string; taskKind?: 'protocol' | 'transport' | 'unsupported' | 'owner'; rpcCode?: number }; executorStopped: boolean };
