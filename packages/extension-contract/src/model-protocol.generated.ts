// Generated from kernel/protocol/schema.json. Do not hand-edit.
import type { ExecutionError, Outcome, Effect, Lifetime, OutputBody, ResolvedMedia, ContentProvenance, LaunchTool } from './nested-tools.generated.js';

export interface HistoryRange { branch_id:string; ancestor_id:string|null; leaf_id:string|null }

export interface ModelOpaqueItem { connection_identity:string; family:string; adapter_version:string; value:unknown }

export interface ModelToolCall { call_id:string; name:string; schema_version:string; arguments:unknown }

export type ModelToolCompletion = {kind:'not_dispatched';reason:string;error?:ExecutionError} | {kind:'result';outcome:Outcome;effect:Effect;content:OutputBody<ResolvedMedia>} | {kind:'job_accepted';operation_id:string;phase:string;effect:Effect;lifetime:Lifetime;content?:OutputBody<ResolvedMedia>};

export type ModelContent = {kind:'text'|'reasoning_summary';text:string} | {kind:'media';media:ResolvedMedia} | {kind:'output';output:OutputBody<ResolvedMedia>} | {kind:'tool_call';call:ModelToolCall} | {kind:'tool_result';result:{request_id:string;call_id:string;completion:ModelToolCompletion}} | {kind:'provider_only'};

export interface ModelConversationItem { resource_activation?:ResourceActivation; id:string; provenance:ContentProvenance; content:ModelContent; opaque:ModelOpaqueItem|null }

export interface RequestBinding {tool_output_visible_bytes?:number|null;execution_environment?:unknown;direct_tools?:string[]|null; provider_id?:string|null; tokenizer?:TokenizerBinding; request_context?:{session_id:string;workspace_id:string|null}|null; child_dispatch:unknown|null; goal:{id:string;generation:number}|null; resource_activations:ResourceActivation[]; resource_checkpoint_id:string|null; connection_identity:string; provider_family:string; model:string; credential_ref:string|null; configuration_generation:number; tool_schema_generation:number; tools:LaunchTool[]; instruction_sources:string[]; memory_checkpoint:string|null; attachment_refs:string[]; environment_cursor:number; history_range:HistoryRange }

export type RequestOrigin = {kind:'auxiliary_inference';operation_id:string;parent_operation_id:string;purpose:string} | {kind:'mcp_sampling';interaction_id:string;operation_id:string;parent_operation_id:string} | {kind:'conversation';compaction:{planHash:string;nodeId:string}|null;step:number;history_range:HistoryRange} | {kind:'policy_model_job';action_id:string;purpose:string;boundary_id:string};

export interface RequestView { request_id:string; run_id:string; origin:RequestOrigin; binding:RequestBinding; history:ModelConversationItem[] }

export interface ModelUsageReceipt { measurement:'missing'|'estimated'|'actual'; input_tokens:number|null; output_tokens:number|null; cached_input_tokens:number|null; cache_write_tokens:number|null; reasoning_tokens:number|null; raw:unknown|null; pricing_version:string|null }

export type ProviderEvent = {kind:'text_delta'|'reasoning_delta';item_id:string;text:string} | {kind:'tool_call_started';call_id:string;name:string;request_id:string} | {kind:'tool_arguments_delta';call_id:string;delta:string} | {kind:'item_completed';item:{id:string;content:ModelContent;opaque:ModelOpaqueItem|null}} | {kind:'usage';receipt:ModelUsageReceipt};

export type FinishReason = 'stop'|'tool_calls'|'length'|'content_filter';

export type ModelProtocolCall = {kind:'serialize';configuration:ModelSessionConfiguration;request:RequestView} | {kind:'parse';request_id:string;run_id:string;connection_identity:string;frame:string|null;state:unknown};

export type ModelProtocolResult = {kind:'body';body:unknown} | {kind:'parsed';events:ProviderEvent[];state:unknown;finish:FinishReason|null};

export interface ModelSessionConfiguration {
  retry?: unknown;
  tokenizer?: TokenizerBinding;
  catalogModelId?: string;
  providerId?: string;
  providerFamily: string;
  model: string;
  endpoint: string;
  credentialEnvironment: string | null;
  allowAnonymous: boolean;
  acceptsImages?: boolean;
  toolOutputVisibleBytes?: number;
  configurationGeneration: number;
  maxOutputTokens: number | null;
  azureDeployment?: string | null;
  azureApiVersion?: string | null;
  legacyMaxTokens?: boolean;
  includeStreamUsage?: boolean;
  reasoningEffort?: string | null;
  anthropicOauth?: boolean;
  adapterId?: string;
  adapterVersion?: string;
  awsRegion?: string;
  adapterIdentity?: string;
  adapterBindingId?: string;
  connection?: ModelHttpConfiguration;
  contextWindowTokens?: number;
  thinkingLevel?: string;
  modelOptions?: unknown;
}

export type TokenizerBinding = {kind: 'encoding'; name: string} | {kind: 'file'; path: string; sha256: string}

export interface ModelHttpConfiguration { headers?:Record<string,string>; proxy?:{mode:"direct"}|{mode:"proxy";url:string} }

export interface ResourceActivation {
  activationId: string;
  inputId: string;
  inputRevision: number;
  ordinal: number;
  resourceCheckpointId: string;
  snapshotId: string;
  resourceId: string;
  reference: AgentResourceReference;
}

export interface AgentResourceReference {
  domainId: string;
  viewId: string;
  path: string;
  canonicalId: string;
  version: string;
}
