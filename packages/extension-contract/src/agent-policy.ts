import type { JsonValue } from './types.js';

export const VARIN_AGENT_POLICY_SERVICE_ID = 'varin.agent.policy';
export const VARIN_AGENT_POLICY_VERSION = 1 as const;
export interface VarinAgentPolicyIdentity { name: string; version: string }
/** A detached projection, never an editable conversation or a model/credential capability. */
export interface VarinAgentPolicyInput {
  view: { run_id: string; state: string; history_count: number; history_head_id: string | null; pending_tool_calls: number };
  event: { kind: 'started' } | { kind: 'input_delivered'; input_ids: string[] }
    | { kind: 'model_completed'; reason: 'stop' | 'tool_calls' | 'length' | 'content_filter'; tool_calls: number }
    | { kind: 'tools_completed'; results: { request_id: string; call_id: string; completion: JsonValue }[] };
  state: JsonValue;
}
/** Tools means only the already registered model exchange; core admission/permissions still apply. */
export type VarinAgentPolicyAction = { kind: 'request_model' | 'execute_tools' | 'complete' }
  | { kind: 'fail'; reason: string } | { kind: 'wait'; wait_id: string };
export interface VarinAgentPolicyDecision { action: VarinAgentPolicyAction; state: JsonValue }
export const VARIN_AGENT_POLICY_CONTRACT = {
  id: VARIN_AGENT_POLICY_SERVICE_ID, version: VARIN_AGENT_POLICY_VERSION, participation: 'decision',
  methods: ['describe', 'decide'],
  describe: {
    inputSchema: { type: 'array', maxItems: 0 },
    outputSchema: { type: 'object', additionalProperties: false, required: ['identity', 'configuration'], properties: {
      identity: { type: 'object', additionalProperties: false, required: ['name', 'version'], properties: { name: { type: 'string', minLength: 1 }, version: { type: 'string', minLength: 1 } } }, configuration: {},
    } },
  },
  decide: {
    inputSchema: { type: 'array', minItems: 1, maxItems: 1, items: {
      type: 'object', additionalProperties: false, required: ['view', 'event', 'state'], properties: {
        view: { type: 'object', additionalProperties: false, required: ['run_id', 'state', 'history_count', 'history_head_id', 'pending_tool_calls'], properties: {
          run_id: { type: 'string', minLength: 1 }, state: { type: 'string' }, history_count: { type: 'integer', minimum: 0 },
          history_head_id: { type: ['string', 'null'] }, pending_tool_calls: { type: 'integer', minimum: 0 },
        } },
        event: { oneOf: [
          { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { const: 'started' } } },
          { type: 'object', additionalProperties: false, required: ['kind', 'input_ids'], properties: { kind: { const: 'input_delivered' }, input_ids: { type: 'array', items: { type: 'string', minLength: 1 } } } },
          { type: 'object', additionalProperties: false, required: ['kind', 'reason', 'tool_calls'], properties: { kind: { const: 'model_completed' }, reason: { enum: ['stop', 'tool_calls', 'length', 'content_filter'] }, tool_calls: { type: 'integer', minimum: 0 } } },
          { type: 'object', additionalProperties: false, required: ['kind', 'results'], properties: { kind: { const: 'tools_completed' }, results: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['request_id', 'call_id', 'completion'], properties: { request_id: { type: 'string' }, call_id: { type: 'string' }, completion: { type: 'object' } } } } } },
        ] }, state: {},
      },
    } },
    outputSchema: { type: 'object', additionalProperties: false, required: ['action', 'state'], properties: {
      action: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['kind'], properties: { kind: { enum: ['request_model', 'execute_tools', 'complete'] } } },
        { type: 'object', additionalProperties: false, required: ['kind', 'reason'], properties: { kind: { const: 'fail' }, reason: { type: 'string', minLength: 1 } } },
        { type: 'object', additionalProperties: false, required: ['kind', 'wait_id'], properties: { kind: { const: 'wait' }, wait_id: { type: 'string', minLength: 1 } } },
      ] }, state: {},
    } },
  },
  boundary: 'between_committed_execution_events',
  actions: ['request_model', 'execute_tools', 'wait', 'complete', 'fail'],
  checkpoint: 'identity_versioned_private_json',
  cancellation: 'abort_discards_decision_without_claiming_tool_cancellation',
} as const;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
function json(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(json); return; }
  if (object(value)) { Object.values(value).forEach(json); return; }
  throw new Error('Agent policy requires JSON data');
}
export function parseVarinAgentPolicyIdentity(value: unknown): VarinAgentPolicyIdentity {
  if (!object(value) || !exact(value, ['name', 'version']) || !text(value.name) || !text(value.version)) throw new Error('Invalid agent policy identity');
  return { name: value.name, version: value.version };
}
export function parseVarinAgentPolicyDecision(value: unknown): VarinAgentPolicyDecision {
  if (!object(value) || !exact(value, ['action', 'state']) || !('state' in value) || !object(value.action)) throw new Error('Invalid agent policy decision');
  const action = value.action;
  if (typeof action.kind === 'string' && ['request_model', 'execute_tools', 'complete'].includes(action.kind)) {
    if (!exact(action, ['kind'])) throw new Error('Invalid agent policy action');
  } else if (action.kind === 'fail') {
    if (!exact(action, ['kind', 'reason']) || !text(action.reason)) throw new Error('Invalid policy failure');
  } else if (action.kind === 'wait') {
    if (!exact(action, ['kind', 'wait_id']) || !text(action.wait_id)) throw new Error('Invalid policy wait');
  } else throw new Error('Unknown agent policy action');
  json(value.state);
  return structuredClone(value) as unknown as VarinAgentPolicyDecision;
}
export function parseVarinAgentPolicyInput(value: unknown): VarinAgentPolicyInput {
  if (!object(value) || !exact(value, ['view', 'event', 'state']) || !object(value.view) || !object(value.event)
    || !('state' in value)) throw new Error('Invalid agent policy input');
  const { view, event } = value;
  if (!exact(view, ['run_id', 'state', 'history_count', 'history_head_id', 'pending_tool_calls']) || !text(view.run_id) || !text(view.state)
    || !Number.isSafeInteger(view.history_count) || Number(view.history_count) < 0 || !(view.history_head_id === null || text(view.history_head_id)) || !Number.isSafeInteger(view.pending_tool_calls) || Number(view.pending_tool_calls) < 0) throw new Error('Invalid agent policy view');
  switch (event.kind) {
    case 'started': if (!exact(event, ['kind'])) throw new Error('Invalid policy event'); break;
    case 'input_delivered': if (!exact(event, ['kind', 'input_ids']) || !Array.isArray(event.input_ids) || !event.input_ids.every(text)) throw new Error('Invalid policy input event'); break;
    case 'model_completed': if (!exact(event, ['kind', 'reason', 'tool_calls']) || (typeof event.reason !== 'string' || !['stop', 'tool_calls', 'length', 'content_filter'].includes(event.reason))
      || !Number.isSafeInteger(event.tool_calls) || Number(event.tool_calls) < 0) throw new Error('Invalid policy model event'); break;
    case 'tools_completed': if (!exact(event, ['kind', 'results']) || !Array.isArray(event.results) || !event.results.every(result => object(result)
      && exact(result, ['request_id', 'call_id', 'completion']) && text(result.request_id) && text(result.call_id) && 'completion' in result)) throw new Error('Invalid policy tool event'); break;
    default: throw new Error('Unknown agent policy event');
  }
  json(value);
  return structuredClone(value) as unknown as VarinAgentPolicyInput;
}
