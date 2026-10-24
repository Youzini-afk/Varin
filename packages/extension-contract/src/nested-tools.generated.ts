// Generated from kernel/protocol/schema.json. Do not hand-edit.

export interface ExecutionError {code:string;message:string;tool_name?:string;details?:unknown;}

export type Outcome = "succeeded" | "failed" | "cancelled" | "indeterminate";

export type Effect = "none" | "dispatched" | "partial" | "confirmed" | "unknown";

export type Lifetime = "call" | "run" | "thread" | "environment";

export type OperationCallCompletion<M = StoredMedia> =
  | { kind: 'not_dispatched'; reason: string; error?: ExecutionError }
  | { kind: 'result'; outcome: Outcome; effect: Effect; content: OutputBody<M> }
  | { kind: 'job_accepted'; operation_id: string; phase: string; effect: Effect; lifetime: Lifetime; content?: OutputBody<M> };

export interface NestedToolInput {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface NestedToolReceipt {
  operationId: string;
  completion: OperationCallCompletion<ResolvedMedia>;
  error?: ExecutionError;
}

export interface NestedToolSummary {
  name: string;
  version: string;
  description: string;
}

export type NestedToolInspection = {
  origin: 'accepted_run'; permission: 'checked_on_invocation'; runId: string; generation: number;
} & ({ action: 'list'; tools: NestedToolSummary[] } | { action: 'describe'; tool: LaunchTool | null });

export interface LaunchTool {
  name: string;
  version: string;
  description: string;
  schema: unknown;
  output_schema: unknown;
  metadata: ToolMetadata | null;
  requirements?: ToolRequirements;
}

export interface ToolMetadata { always_declared?: boolean; service_id: string; service_version: number; completion: 'result' | 'job'; lifetime?: 'thread' | 'environment'; operation: 'read' | 'effect'; examples?: unknown[]; source?: {path: string; line?: number}; }

export interface ToolRequirements { source: 'source' | 'physical' | 'live'; process: boolean; }

export interface OutputEvidenceRef { action_id: string; node_id: string; content_ref: string }

export type ContentProvenance = {kind:'system_instruction';source:string} | {kind:'goal_instruction';goal_id:string;generation:number} | {kind:'user_instruction';input_id:string} | {kind:'sampling';interaction_id:string;role:'system'|'user'|'assistant'} | {kind:'assistant'} | {kind:'policy_output';action_id:string;identity:{name:string;version:string}} | {kind:'tool_data';call_id:string} | {kind:'policy_tool_data';reference:OutputEvidenceRef} | {kind:'external_data';source:string} | {kind:'agent_message';thread_id:string} | {kind:'environment_fact';event_id:string};

export type OutputSource = {kind:'conversation';provenance:ContentProvenance} | {kind:'tool';context:{run_id:string;origin:ToolOrigin;operation_id:string}} | {kind:'operation';operation_id:string};

export interface ContentRef { content_object: string }

export interface IncomingMedia { media_type: string; data_base64: string }

export interface StoredMedia { media_type: string; source: OutputSource; content_ref: ContentRef }

export interface ResolvedMedia { media_type: string; source: OutputSource; data_base64: string }

export type OutputPart<M = StoredMedia> = {kind:'text';text:string} | {kind:'media';media:M};

export interface OutputBody<M = StoredMedia> { data: unknown; parts: OutputPart<M>[] }

export type ToolOrigin = {kind: 'model_step'; request_id: string} | {kind: 'policy_action'; action_id: string; node_id: string} | {kind: 'nested_call'; parent_operation_id: string};
/** Canonical invocation identity shared by all public/Host consumers. */
export function toolOperationId(origin: ToolOrigin, callId: string): string {
  switch (origin.kind) {
    case 'model_step': return `${origin.request_id}:tool:${callId}`;
    case 'policy_action': return `${origin.action_id}:node:${origin.node_id}`;
    case 'nested_call': return `nested:${new TextEncoder().encode(origin.parent_operation_id).length}:${origin.parent_operation_id}:${callId}`;
  }
}
export function validToolOrigin(value: unknown): value is ToolOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const text = (key: string) => typeof v[key] === 'string' && (v[key] as string).length > 0;
  const keys = v.kind === 'model_step' ? ['kind', 'request_id'] : v.kind === 'policy_action' ? ['kind', 'action_id', 'node_id'] : v.kind === 'nested_call' ? ['kind', 'parent_operation_id'] : [];
  return keys.length > 0 && Object.keys(v).length === keys.length && Object.keys(v).every(key => keys.includes(key)) && keys.every(key => key === 'kind' || text(key));
}
