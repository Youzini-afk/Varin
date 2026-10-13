/** Closed source-local MCP requests. No paths, credentials or arbitrary Host method names. */
import type { McpAuthorityBinding, McpAuthorityService, McpServiceRequest } from '@varin/pi-host/mcp-authority';
import type { McpBinding } from '../kernel/protocol.generated.js';

export type ManagedMcpAction =
  | { kind: 'snapshot'; handleId: string; creationRequestId: string; selection?: McpBinding }
  | { kind: 'changed'; incarnation: string; after: number }
  | { kind: 'release'; handleId: string; creationRequestId: string }
  | { kind: 'discover'; handleId: string; server: string }
  | { kind: 'prepare_tool'; handleId: string; server: string; tool: string; schemaVersion: string }
  | { kind: 'discover_services'; handleId: string; server: string }
  | { kind: 'prepare_service'; handleId: string; server: string; serviceKind: McpAuthorityService['kind']; schemaVersion: string }
  | { kind: 'prepare_prompt'; handleId: string; server: string; name: string; schemaVersion: string }
  | { kind: 'call'; handleId: string; name: string; schemaVersion: string; arguments: Record<string, unknown> }
  | { kind: 'service'; handleId: string; service: McpAuthorityService; request: McpServiceRequest };
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
  | { ok: false; error: { code: string; dispatched: boolean; settlement: 'unknown' | 'session_expired' | 'rpc_response'; protocolError?: Record<string, unknown>; interactionProblem?: string }; executorStopped: boolean };
