import type { JsonValue } from './types.js';

export const VARIN_AGENT_POLICY_SERVICE_ID = 'varin.agent.policy';
export const VARIN_AGENT_POLICY_VERSION = 3 as const;
export interface VarinAgentPolicyIdentity { name: string; version: string }
/** A capability-scoped association. A content hash alone never authorizes a read. */
export interface VarinAgentPolicyEvidenceRef { action_id: string; node_id: string; content_ref: string }
export interface VarinAgentPolicyToolNode {
  id: string;
  depends_on: string[];
  call: { call_id: string; name: string; schema_version: string; arguments: JsonValue };
}
export type VarinAgentPolicyToolEffect = 'none' | 'dispatched' | 'partial' | 'confirmed' | 'unknown';
/** A call's completion is distinct from the later terminal outcome of an accepted job. */
export type VarinAgentPolicyToolCompletion =
  | { kind: 'not_dispatched'; reason: string }
  | { kind: 'result'; outcome: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate'; effect: VarinAgentPolicyToolEffect; output: VarinAgentPolicyEvidenceRef }
  | { kind: 'job_accepted'; operation_id: string; phase: string; effect: VarinAgentPolicyToolEffect; lifetime: 'call' | 'run' | 'thread' | 'environment' };
export interface VarinAgentPolicyNodeReceipt {
  node_id: string;
  completion: VarinAgentPolicyToolCompletion;
}
/** Public admission metadata only; no provider configuration or credential handle. */
export interface VarinAgentPolicyModelCapability {
  capability_id: string;
  purpose: 'planning';
  status: 'available' | 'disabled' | 'unconfigured' | 'invalid' | 'unavailable';
  supported_operation: 'tool_free_text';
}
export interface VarinAgentPolicyModelUsage {
  measurement: 'missing' | 'estimated' | 'actual';
  input_tokens: number | null;
  output_tokens: number | null;
  cached_input_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  raw: JsonValue;
  pricing_version: string | null;
}
export interface VarinAgentPolicyModelReceipt {
  dispatch: 'prepared' | 'dispatched' | 'completed' | 'interrupted';
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate';
  output: VarinAgentPolicyEvidenceRef | null;
  usage: VarinAgentPolicyModelUsage;
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  failure: { code: string; message: string; retry_after_ms: number | null; provider_request_id: string | null } | null;
  usable: boolean;
}
/** Detached committed facts, never editable conversation or a model/credential capability. */
export interface VarinAgentPolicyInput {
  view: { run_id: string; state: string; history_count: number; history_head_id: string | null; pending_tool_calls: number; model_capabilities: VarinAgentPolicyModelCapability[] };
  event: { kind: 'started' } | { kind: 'input_delivered'; input_ids: string[] }
    | { kind: 'model_completed'; reason: 'stop' | 'tool_calls' | 'length' | 'content_filter'; tool_calls: number }
    | { kind: 'tools_completed'; results: { request_id: string; call_id: string; completion: JsonValue }[] }
    | { kind: 'delivered'; action_id: string; item_id: string }
    | { kind: 'resumed'; action_id: string; wait_id: string }
    | { kind: 'model_job_completed'; action_id: string; receipt: VarinAgentPolicyModelReceipt }
    | { kind: 'tool_graph_completed'; action_id: string; receipts: VarinAgentPolicyNodeReceipt[] }
    | { kind: 'result_chunk'; reference: VarinAgentPolicyEvidenceRef; index: number; total_chunks: number; total_bytes: number; bytes: number[] };
  state: JsonValue;
}
/** Core admits and authorizes every action. Graph eligibility comes from the trusted executor. */
export type VarinAgentPolicyAction = { kind: 'request_model' | 'execute_tools' | 'complete' }
  | { kind: 'request_model_job'; capability_id: string; instructions: string[]; evidence: VarinAgentPolicyEvidenceRef[] }
  | { kind: 'tool_graph'; nodes: VarinAgentPolicyToolNode[] }
  | { kind: 'read_result'; reference: VarinAgentPolicyEvidenceRef; index: number }
  | { kind: 'request_model_with_evidence'; evidence: VarinAgentPolicyEvidenceRef[] }
  | { kind: 'deliver'; text: string } | { kind: 'pause'; reason: string }
  | { kind: 'fail'; reason: string } | { kind: 'wait'; wait_id: string };
export interface VarinAgentPolicyDecision { action: VarinAgentPolicyAction; state: JsonValue }
export interface VarinAgentPolicyDescription {
  identity: VarinAgentPolicyIdentity;
  configuration: JsonValue;
  modelRoles: 'agentPlanning'[];
  stateTransition: 'unsupported' | 'explicit';
}
/** Core captures the checkpoint and commit fence. This is only the source implementation's data. */
export interface VarinAgentPolicyTransitionInput extends VarinAgentPolicyInput {
  from: { identity: VarinAgentPolicyIdentity; declaredIdentity: VarinAgentPolicyIdentity | null };
}
/** Compatibility is asserted by the implementation, never automatically proven by JSON validation. */
export type VarinAgentPolicyTransition =
  | { kind: 'compatible'; state: JsonValue }
  | { kind: 'incompatible'; reason: string };
const stringSchema = { type: 'string', minLength: 1 } as const;
const integerSchema = { type: 'integer', minimum: 0 } as const;
const objectSchema = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arraySchema = (items: unknown) => ({ type: 'array', items });
const referenceSchema = objectSchema({ action_id: stringSchema, node_id: stringSchema, content_ref: stringSchema });
const nodeSchema = objectSchema({ id: stringSchema, depends_on: arraySchema(stringSchema),
  call: objectSchema({ call_id: stringSchema, name: stringSchema, schema_version: stringSchema, arguments: {} }) });
const effectSchema = { enum: ['none', 'dispatched', 'partial', 'confirmed', 'unknown'] };
const toolCompletionSchema = { oneOf: [
  objectSchema({ kind: { const: 'not_dispatched' }, reason: stringSchema }),
  objectSchema({ kind: { const: 'result' }, outcome: { enum: ['succeeded', 'failed', 'cancelled', 'indeterminate'] }, effect: effectSchema, output: referenceSchema }),
  objectSchema({ kind: { const: 'job_accepted' }, operation_id: stringSchema, phase: stringSchema, effect: effectSchema, lifetime: { enum: ['call', 'run', 'thread', 'environment'] } }),
] };
const capabilitySchema = objectSchema({ capability_id: stringSchema, purpose: { const: 'planning' },
  status: { enum: ['available', 'disabled', 'unconfigured', 'invalid', 'unavailable'] }, supported_operation: { const: 'tool_free_text' } });
const nullableIntegerSchema = { anyOf: [integerSchema, { type: 'null' }] };
const usageSchema = objectSchema({ measurement: { enum: ['missing', 'estimated', 'actual'] }, input_tokens: nullableIntegerSchema,
  output_tokens: nullableIntegerSchema, cached_input_tokens: nullableIntegerSchema, cache_write_tokens: nullableIntegerSchema,
  reasoning_tokens: nullableIntegerSchema, raw: {}, pricing_version: { type: ['string', 'null'] } });
const modelReceiptSchema = objectSchema({ dispatch: { enum: ['prepared', 'dispatched', 'completed', 'interrupted'] }, outcome: { enum: ['succeeded', 'failed', 'cancelled', 'indeterminate'] },
  output: { anyOf: [referenceSchema, { type: 'null' }] }, usage: usageSchema,
  finish_reason: { enum: ['stop', 'tool_calls', 'length', 'content_filter', null] },
  failure: { anyOf: [objectSchema({ code: stringSchema, message: { type: 'string' }, retry_after_ms: nullableIntegerSchema,
    provider_request_id: { type: ['string', 'null'] } }), { type: 'null' }] }, usable: { type: 'boolean' } });
const eventSchema = { oneOf: [
  objectSchema({ kind: { const: 'started' } }),
  objectSchema({ kind: { const: 'delivered' }, action_id: stringSchema, item_id: stringSchema }),
  objectSchema({ kind: { const: 'resumed' }, action_id: stringSchema, wait_id: stringSchema }),
  objectSchema({ kind: { const: 'model_job_completed' }, action_id: stringSchema, receipt: modelReceiptSchema }),
  objectSchema({ kind: { const: 'input_delivered' }, input_ids: arraySchema(stringSchema) }),
  objectSchema({ kind: { const: 'model_completed' }, reason: { enum: ['stop', 'tool_calls', 'length', 'content_filter'] }, tool_calls: integerSchema }),
  objectSchema({ kind: { const: 'tools_completed' }, results: arraySchema(objectSchema({ request_id: stringSchema, call_id: stringSchema, completion: { type: 'object' } })) }),
  objectSchema({ kind: { const: 'tool_graph_completed' }, action_id: stringSchema, receipts: arraySchema(objectSchema({ node_id: stringSchema, completion: toolCompletionSchema })) }),
  objectSchema({ kind: { const: 'result_chunk' }, reference: referenceSchema, index: integerSchema, total_chunks: { type: 'integer', minimum: 1 }, total_bytes: integerSchema,
    bytes: arraySchema({ type: 'integer', minimum: 0, maximum: 255 }) }),
] };
const actionSchema = { oneOf: [
  objectSchema({ kind: { enum: ['request_model', 'execute_tools', 'complete'] } }),
  objectSchema({ kind: { const: 'request_model_job' }, capability_id: stringSchema, instructions: { ...arraySchema(stringSchema), minItems: 1 }, evidence: arraySchema(referenceSchema) }),
  objectSchema({ kind: { const: 'tool_graph' }, nodes: arraySchema(nodeSchema) }),
  objectSchema({ kind: { const: 'read_result' }, reference: referenceSchema, index: integerSchema }),
  objectSchema({ kind: { const: 'request_model_with_evidence' }, evidence: arraySchema(referenceSchema) }),
  objectSchema({ kind: { const: 'deliver' }, text: { type: 'string' } }),
  objectSchema({ kind: { const: 'pause' }, reason: { type: 'string' } }),
  objectSchema({ kind: { const: 'fail' }, reason: stringSchema }),
  objectSchema({ kind: { const: 'wait' }, wait_id: stringSchema }),
] };
const identitySchema = objectSchema({ name: stringSchema, version: stringSchema });
const viewSchema = objectSchema({ run_id: stringSchema, state: stringSchema, history_count: integerSchema, history_head_id: { type: ['string', 'null'] }, pending_tool_calls: integerSchema, model_capabilities: arraySchema(capabilitySchema) });
const transitionSchema = { oneOf: [
  objectSchema({ kind: { const: 'compatible' }, state: {} }),
  objectSchema({ kind: { const: 'incompatible' }, reason: stringSchema }),
] };
export const VARIN_AGENT_POLICY_CONTRACT = {
  id: VARIN_AGENT_POLICY_SERVICE_ID, version: VARIN_AGENT_POLICY_VERSION, participation: 'decision', methods: ['describe', 'decide', 'transitionState'],
  describe: { inputSchema: { type: 'array', maxItems: 0 }, outputSchema: objectSchema({ identity: identitySchema, configuration: {}, modelRoles: { type: 'array', uniqueItems: true, items: { const: 'agentPlanning' } }, stateTransition: { enum: ['unsupported', 'explicit'] } }) },
  decide: { inputSchema: { type: 'array', minItems: 1, maxItems: 1, items: objectSchema({
    view: viewSchema, event: eventSchema, state: {},
  }) }, outputSchema: objectSchema({ action: actionSchema, state: {} }) },
  transitionState: { inputSchema: { type: 'array', minItems: 1, maxItems: 1, items: objectSchema({
    from: objectSchema({ identity: identitySchema, declaredIdentity: { anyOf: [identitySchema, { type: 'null' }] } }),
    view: viewSchema, event: eventSchema, state: {},
  }) }, outputSchema: transitionSchema },
  boundary: 'between_committed_execution_events',
  actions: ['request_model', 'request_model_job', 'execute_tools', 'tool_graph', 'read_result', 'request_model_with_evidence', 'wait', 'deliver', 'pause', 'complete', 'fail'],
  outputAccess: 'own_run_action_node_committed_content_chunks',
  checkpoint: 'identity_versioned_private_json', cancellation: 'abort_discards_decision_without_claiming_tool_cancellation',
} as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function json(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(json); return; }
  if (object(value)) { Object.values(value).forEach(json); return; }
  throw new Error('Agent policy requires JSON data');
}
function reference(value: unknown): value is VarinAgentPolicyEvidenceRef {
  return object(value) && exact(value, ['action_id', 'node_id', 'content_ref']) && text(value.action_id) && text(value.node_id) && text(value.content_ref);
}
function node(value: unknown): boolean {
  return object(value) && exact(value, ['id', 'depends_on', 'call']) && text(value.id)
    && Array.isArray(value.depends_on) && value.depends_on.every(text) && object(value.call)
    && exact(value.call, ['call_id', 'name', 'schema_version', 'arguments']) && value.call.call_id === value.id && text(value.call.name) && text(value.call.schema_version);
}
function toolCompletion(value: unknown): boolean {
  if (!object(value)) return false;
  if (value.kind === 'not_dispatched') return exact(value, ['kind', 'reason']) && text(value.reason);
  if (typeof value.effect !== 'string' || !['none', 'dispatched', 'partial', 'confirmed', 'unknown'].includes(value.effect)) return false;
  if (value.kind === 'result') return exact(value, ['kind', 'outcome', 'effect', 'output'])
    && typeof value.outcome === 'string' && ['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(value.outcome) && reference(value.output);
  if (value.kind === 'job_accepted') return exact(value, ['kind', 'operation_id', 'phase', 'effect', 'lifetime'])
    && text(value.operation_id) && text(value.phase) && typeof value.lifetime === 'string' && ['call', 'run', 'thread', 'environment'].includes(value.lifetime);
  return false;
}
function capability(value: unknown): boolean {
  return object(value) && exact(value, ['capability_id', 'purpose', 'status', 'supported_operation']) && text(value.capability_id)
    && value.purpose === 'planning' && value.supported_operation === 'tool_free_text' && typeof value.status === 'string'
    && ['available', 'disabled', 'unconfigured', 'invalid', 'unavailable'].includes(value.status);
}
function modelReceipt(value: unknown): boolean {
  if (!object(value) || !exact(value, ['dispatch', 'outcome', 'output', 'usage', 'finish_reason', 'failure', 'usable'])
    || typeof value.dispatch !== 'string' || !['prepared', 'dispatched', 'completed', 'interrupted'].includes(value.dispatch)
    || typeof value.outcome !== 'string' || !['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(value.outcome)
    || !(value.output === null || reference(value.output)) || typeof value.usable !== 'boolean'
    || !(value.finish_reason === null || typeof value.finish_reason === 'string' && ['stop', 'tool_calls', 'length', 'content_filter'].includes(value.finish_reason))) return false;
  const usage = value.usage;
  if (!object(usage) || !exact(usage, ['measurement', 'input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens', 'raw', 'pricing_version'])
    || typeof usage.measurement !== 'string' || !['missing', 'estimated', 'actual'].includes(usage.measurement)
    || !['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens', 'reasoning_tokens'].every(key => usage[key] === null || integer(usage[key]))
    || !(usage.pricing_version === null || typeof usage.pricing_version === 'string')) return false;
  const failure = value.failure;
  return failure === null || object(failure) && exact(failure, ['code', 'message', 'retry_after_ms', 'provider_request_id'])
    && text(failure.code) && typeof failure.message === 'string' && (failure.retry_after_ms === null || integer(failure.retry_after_ms))
    && (failure.provider_request_id === null || typeof failure.provider_request_id === 'string');
}
export function parseVarinAgentPolicyIdentity(value: unknown): VarinAgentPolicyIdentity {
  if (!object(value) || !exact(value, ['name', 'version']) || !text(value.name) || !text(value.version)) throw new Error('Invalid agent policy identity');
  return { name: value.name, version: value.version };
}
export function parseVarinAgentPolicyDecision(value: unknown): VarinAgentPolicyDecision {
  if (!object(value) || !exact(value, ['action', 'state']) || !object(value.action)) throw new Error('Invalid agent policy decision');
  const action = value.action;
  if (typeof action.kind === 'string' && ['request_model', 'execute_tools', 'complete'].includes(action.kind)) {
    if (!exact(action, ['kind'])) throw new Error('Invalid agent policy action');
  } else if (action.kind === 'request_model_job') {
    if (!exact(action, ['kind', 'capability_id', 'instructions', 'evidence']) || !text(action.capability_id)
      || !Array.isArray(action.instructions) || action.instructions.length === 0 || !action.instructions.every(text)
      || !Array.isArray(action.evidence) || !action.evidence.every(reference)) throw new Error('Invalid policy model job');
  } else if (action.kind === 'tool_graph') {
    if (!exact(action, ['kind', 'nodes']) || !Array.isArray(action.nodes) || !action.nodes.every(node)) throw new Error('Invalid policy tool graph');
  } else if (action.kind === 'read_result') {
    if (!exact(action, ['kind', 'reference', 'index']) || !reference(action.reference) || !integer(action.index)) throw new Error('Invalid policy result read');
  } else if (action.kind === 'request_model_with_evidence') {
    if (!exact(action, ['kind', 'evidence']) || !Array.isArray(action.evidence) || !action.evidence.every(reference)) throw new Error('Invalid policy evidence');
  } else if (action.kind === 'deliver') {
    if (!exact(action, ['kind', 'text']) || typeof action.text !== 'string') throw new Error('Invalid policy delivery');
  } else if (action.kind === 'pause') {
    if (!exact(action, ['kind', 'reason']) || typeof action.reason !== 'string') throw new Error('Invalid policy pause');
  } else if (action.kind === 'fail') {
    if (!exact(action, ['kind', 'reason']) || !text(action.reason)) throw new Error('Invalid policy failure');
  } else if (action.kind === 'wait') {
    if (!exact(action, ['kind', 'wait_id']) || !text(action.wait_id)) throw new Error('Invalid policy wait');
  } else throw new Error('Unknown agent policy action');
  json(value);
  return structuredClone(value) as unknown as VarinAgentPolicyDecision;
}
export function parseVarinAgentPolicyInput(value: unknown): VarinAgentPolicyInput {
  if (!object(value) || !exact(value, ['view', 'event', 'state']) || !object(value.view) || !object(value.event)) throw new Error('Invalid agent policy input');
  const { view, event } = value;
  if (!exact(view, ['run_id', 'state', 'history_count', 'history_head_id', 'pending_tool_calls', 'model_capabilities']) || !text(view.run_id) || !text(view.state)
    || !integer(view.history_count) || !(view.history_head_id === null || text(view.history_head_id)) || !integer(view.pending_tool_calls) || !Array.isArray(view.model_capabilities) || !view.model_capabilities.every(capability)) throw new Error('Invalid agent policy view');
  switch (event.kind) {
    case 'started': if (!exact(event, ['kind'])) throw new Error('Invalid policy event'); break;
    case 'delivered': if (!exact(event, ['kind', 'action_id', 'item_id']) || !text(event.action_id) || !text(event.item_id)) throw new Error('Invalid policy delivery receipt'); break;
    case 'resumed': if (!exact(event, ['kind', 'action_id', 'wait_id']) || !text(event.action_id) || !text(event.wait_id)) throw new Error('Invalid policy resume receipt'); break;
    case 'input_delivered': if (!exact(event, ['kind', 'input_ids']) || !Array.isArray(event.input_ids) || !event.input_ids.every(text)) throw new Error('Invalid policy input event'); break;
    case 'model_job_completed': if (!exact(event, ['kind', 'action_id', 'receipt']) || !text(event.action_id) || !modelReceipt(event.receipt)) throw new Error('Invalid policy model job receipt'); break;
    case 'model_completed': if (!exact(event, ['kind', 'reason', 'tool_calls']) || typeof event.reason !== 'string' || !['stop', 'tool_calls', 'length', 'content_filter'].includes(event.reason)
      || !integer(event.tool_calls)) throw new Error('Invalid policy model event'); break;
    case 'tools_completed': if (!exact(event, ['kind', 'results']) || !Array.isArray(event.results) || !event.results.every(result => object(result)
      && exact(result, ['request_id', 'call_id', 'completion']) && text(result.request_id) && text(result.call_id))) throw new Error('Invalid policy tool event'); break;
    case 'tool_graph_completed': if (!exact(event, ['kind', 'action_id', 'receipts']) || !text(event.action_id) || !Array.isArray(event.receipts) || !event.receipts.every(receipt => object(receipt)
      && exact(receipt, ['node_id', 'completion']) && text(receipt.node_id) && toolCompletion(receipt.completion))) throw new Error('Invalid policy graph receipts'); break;
    case 'result_chunk': if (!exact(event, ['kind', 'reference', 'index', 'total_chunks', 'total_bytes', 'bytes']) || !reference(event.reference)
      || !integer(event.index) || !integer(event.total_chunks) || event.total_chunks === 0 || event.index >= event.total_chunks || !integer(event.total_bytes)
      || !Array.isArray(event.bytes) || !event.bytes.every(byte => integer(byte) && byte <= 255)) throw new Error('Invalid policy result chunk'); break;
    default: throw new Error('Unknown agent policy event');
  }
  json(value);
  return structuredClone(value) as unknown as VarinAgentPolicyInput;
}

export function parseVarinAgentPolicyDescription(value: unknown): VarinAgentPolicyDescription {
  if (!object(value) || !exact(value, ['identity', 'configuration', 'modelRoles', 'stateTransition'])
    || !Array.isArray(value.modelRoles) || value.modelRoles.some(role => role !== 'agentPlanning')
    || new Set(value.modelRoles).size !== value.modelRoles.length
    || !['unsupported', 'explicit'].includes(String(value.stateTransition))) throw new Error('Invalid agent policy description');
  parseVarinAgentPolicyIdentity(value.identity);
  json(value.configuration);
  return structuredClone(value) as unknown as VarinAgentPolicyDescription;
}
export function parseVarinAgentPolicyTransitionInput(value: unknown): VarinAgentPolicyTransitionInput {
  if (!object(value) || !exact(value, ['from', 'view', 'event', 'state']) || !object(value.from)
    || !exact(value.from, ['identity', 'declaredIdentity'])) throw new Error('Invalid agent policy transition input');
  const identity = parseVarinAgentPolicyIdentity(value.from.identity);
  const declaredIdentity = value.from.declaredIdentity === null ? null : parseVarinAgentPolicyIdentity(value.from.declaredIdentity);
  const input = parseVarinAgentPolicyInput({ view: value.view, event: value.event, state: value.state });
  return { from: { identity, declaredIdentity }, ...input };
}
export function parseVarinAgentPolicyTransition(value: unknown): VarinAgentPolicyTransition {
  if (!object(value)) throw new Error('Invalid agent policy transition');
  if (value.kind === 'compatible' && exact(value, ['kind', 'state'])) {
    json(value.state);
    return { kind: 'compatible', state: structuredClone(value.state) };
  }
  if (value.kind === 'incompatible' && exact(value, ['kind', 'reason']) && text(value.reason)) return { kind: 'incompatible', reason: value.reason };
  throw new Error('Invalid agent policy transition');
}
