import type { JsonValue } from './types.js';

export const VARIN_AGENT_POLICY_SERVICE_ID = 'varin.agent.policy';
export const VARIN_AGENT_POLICY_VERSION = 1 as const;
export interface VarinAgentPolicyIdentity { name: string; version: string }
/** A capability-scoped association. A content hash alone never authorizes a read. */
export interface VarinAgentPolicyEvidenceRef { action_id: string; node_id: string; content_ref: string }
export interface VarinAgentPolicyReadNode {
  id: string;
  depends_on: string[];
  call: { call_id: string; name: string; schema_version: string; arguments: JsonValue };
}
export interface VarinAgentPolicyNodeReceipt {
  node_id: string;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'indeterminate';
  output: VarinAgentPolicyEvidenceRef | null;
  non_execution: string | null;
}
/** Detached committed facts, never editable conversation or a model/credential capability. */
export interface VarinAgentPolicyInput {
  view: { run_id: string; state: string; history_count: number; history_head_id: string | null; pending_tool_calls: number };
  event: { kind: 'started' } | { kind: 'input_delivered'; input_ids: string[] }
    | { kind: 'model_completed'; reason: 'stop' | 'tool_calls' | 'length' | 'content_filter'; tool_calls: number }
    | { kind: 'tools_completed'; results: { request_id: string; call_id: string; completion: JsonValue }[] }
    | { kind: 'read_graph_completed'; action_id: string; receipts: VarinAgentPolicyNodeReceipt[] }
    | { kind: 'result_chunk'; reference: VarinAgentPolicyEvidenceRef; index: number; total_chunks: number; total_bytes: number; bytes: number[] };
  state: JsonValue;
}
/** Core admits and authorizes every action. Graph eligibility comes from the trusted executor. */
export type VarinAgentPolicyAction = { kind: 'request_model' | 'execute_tools' | 'complete' }
  | { kind: 'read_graph'; nodes: VarinAgentPolicyReadNode[] }
  | { kind: 'read_result'; reference: VarinAgentPolicyEvidenceRef; index: number }
  | { kind: 'request_model_with_evidence'; evidence: VarinAgentPolicyEvidenceRef[] }
  | { kind: 'fail'; reason: string } | { kind: 'wait'; wait_id: string };
export interface VarinAgentPolicyDecision { action: VarinAgentPolicyAction; state: JsonValue }
const stringSchema = { type: 'string', minLength: 1 } as const;
const integerSchema = { type: 'integer', minimum: 0 } as const;
const objectSchema = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const arraySchema = (items: unknown) => ({ type: 'array', items });
const referenceSchema = objectSchema({ action_id: stringSchema, node_id: stringSchema, content_ref: stringSchema });
const nodeSchema = objectSchema({ id: stringSchema, depends_on: arraySchema(stringSchema),
  call: objectSchema({ call_id: stringSchema, name: stringSchema, schema_version: stringSchema, arguments: {} }) });
const eventSchema = { oneOf: [
  objectSchema({ kind: { const: 'started' } }),
  objectSchema({ kind: { const: 'input_delivered' }, input_ids: arraySchema(stringSchema) }),
  objectSchema({ kind: { const: 'model_completed' }, reason: { enum: ['stop', 'tool_calls', 'length', 'content_filter'] }, tool_calls: integerSchema }),
  objectSchema({ kind: { const: 'tools_completed' }, results: arraySchema(objectSchema({ request_id: stringSchema, call_id: stringSchema, completion: { type: 'object' } })) }),
  objectSchema({ kind: { const: 'read_graph_completed' }, action_id: stringSchema, receipts: arraySchema(objectSchema({ node_id: stringSchema,
    outcome: { enum: ['succeeded', 'failed', 'cancelled', 'indeterminate'] }, output: { anyOf: [referenceSchema, { type: 'null' }] }, non_execution: { type: ['string', 'null'] } })) }),
  objectSchema({ kind: { const: 'result_chunk' }, reference: referenceSchema, index: integerSchema, total_chunks: { type: 'integer', minimum: 1 }, total_bytes: integerSchema,
    bytes: arraySchema({ type: 'integer', minimum: 0, maximum: 255 }) }),
] };
const actionSchema = { oneOf: [
  objectSchema({ kind: { enum: ['request_model', 'execute_tools', 'complete'] } }),
  objectSchema({ kind: { const: 'read_graph' }, nodes: arraySchema(nodeSchema) }),
  objectSchema({ kind: { const: 'read_result' }, reference: referenceSchema, index: integerSchema }),
  objectSchema({ kind: { const: 'request_model_with_evidence' }, evidence: arraySchema(referenceSchema) }),
  objectSchema({ kind: { const: 'fail' }, reason: stringSchema }),
  objectSchema({ kind: { const: 'wait' }, wait_id: stringSchema }),
] };
export const VARIN_AGENT_POLICY_CONTRACT = {
  id: VARIN_AGENT_POLICY_SERVICE_ID, version: VARIN_AGENT_POLICY_VERSION, participation: 'decision', methods: ['describe', 'decide'],
  describe: { inputSchema: { type: 'array', maxItems: 0 }, outputSchema: objectSchema({ identity: objectSchema({ name: stringSchema, version: stringSchema }), configuration: {} }) },
  decide: { inputSchema: { type: 'array', minItems: 1, maxItems: 1, items: objectSchema({
    view: objectSchema({ run_id: stringSchema, state: stringSchema, history_count: integerSchema, history_head_id: { type: ['string', 'null'] }, pending_tool_calls: integerSchema }), event: eventSchema, state: {},
  }) }, outputSchema: objectSchema({ action: actionSchema, state: {} }) },
  boundary: 'between_committed_execution_events',
  actions: ['request_model', 'execute_tools', 'read_graph', 'read_result', 'request_model_with_evidence', 'wait', 'complete', 'fail'],
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
export function parseVarinAgentPolicyIdentity(value: unknown): VarinAgentPolicyIdentity {
  if (!object(value) || !exact(value, ['name', 'version']) || !text(value.name) || !text(value.version)) throw new Error('Invalid agent policy identity');
  return { name: value.name, version: value.version };
}
export function parseVarinAgentPolicyDecision(value: unknown): VarinAgentPolicyDecision {
  if (!object(value) || !exact(value, ['action', 'state']) || !object(value.action)) throw new Error('Invalid agent policy decision');
  const action = value.action;
  if (typeof action.kind === 'string' && ['request_model', 'execute_tools', 'complete'].includes(action.kind)) {
    if (!exact(action, ['kind'])) throw new Error('Invalid agent policy action');
  } else if (action.kind === 'read_graph') {
    if (!exact(action, ['kind', 'nodes']) || !Array.isArray(action.nodes) || !action.nodes.every(node)) throw new Error('Invalid policy read graph');
  } else if (action.kind === 'read_result') {
    if (!exact(action, ['kind', 'reference', 'index']) || !reference(action.reference) || !integer(action.index)) throw new Error('Invalid policy result read');
  } else if (action.kind === 'request_model_with_evidence') {
    if (!exact(action, ['kind', 'evidence']) || !Array.isArray(action.evidence) || !action.evidence.every(reference)) throw new Error('Invalid policy evidence');
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
  if (!exact(view, ['run_id', 'state', 'history_count', 'history_head_id', 'pending_tool_calls']) || !text(view.run_id) || !text(view.state)
    || !integer(view.history_count) || !(view.history_head_id === null || text(view.history_head_id)) || !integer(view.pending_tool_calls)) throw new Error('Invalid agent policy view');
  switch (event.kind) {
    case 'started': if (!exact(event, ['kind'])) throw new Error('Invalid policy event'); break;
    case 'input_delivered': if (!exact(event, ['kind', 'input_ids']) || !Array.isArray(event.input_ids) || !event.input_ids.every(text)) throw new Error('Invalid policy input event'); break;
    case 'model_completed': if (!exact(event, ['kind', 'reason', 'tool_calls']) || typeof event.reason !== 'string' || !['stop', 'tool_calls', 'length', 'content_filter'].includes(event.reason)
      || !integer(event.tool_calls)) throw new Error('Invalid policy model event'); break;
    case 'tools_completed': if (!exact(event, ['kind', 'results']) || !Array.isArray(event.results) || !event.results.every(result => object(result)
      && exact(result, ['request_id', 'call_id', 'completion']) && text(result.request_id) && text(result.call_id))) throw new Error('Invalid policy tool event'); break;
    case 'read_graph_completed': if (!exact(event, ['kind', 'action_id', 'receipts']) || !text(event.action_id) || !Array.isArray(event.receipts) || !event.receipts.every(receipt => object(receipt)
      && exact(receipt, ['node_id', 'outcome', 'output', 'non_execution']) && text(receipt.node_id) && typeof receipt.outcome === 'string'
      && ['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(receipt.outcome) && (receipt.output === null || reference(receipt.output))
      && (receipt.non_execution === null || typeof receipt.non_execution === 'string'))) throw new Error('Invalid policy graph receipts'); break;
    case 'result_chunk': if (!exact(event, ['kind', 'reference', 'index', 'total_chunks', 'total_bytes', 'bytes']) || !reference(event.reference)
      || !integer(event.index) || !integer(event.total_chunks) || event.total_chunks === 0 || event.index >= event.total_chunks || !integer(event.total_bytes)
      || !Array.isArray(event.bytes) || !event.bytes.every(byte => integer(byte) && byte <= 255)) throw new Error('Invalid policy result chunk'); break;
    default: throw new Error('Unknown agent policy event');
  }
  json(value);
  return structuredClone(value) as unknown as VarinAgentPolicyInput;
}
