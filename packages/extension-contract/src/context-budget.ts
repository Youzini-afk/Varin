import type { JsonValue } from './types.js';

/** A bounded metadata-only Decision. History, model access and tool authority stay with core. */
export const VARIN_CONTEXT_BUDGET_SERVICE_ID = 'varin.context.budget';
export const VARIN_CONTEXT_BUDGET_VERSION = 1 as const;
export interface VarinContextBudgetDescription {
  identity: { name: string; version: string };
  configuration: JsonValue;
}
export interface VarinContextBudgetEstimate {
  estimatedTokens: number;
  unmeasuredMedia: number;
  unmeasuredProviderItems: number;
  method: string;
}
export interface VarinContextBudgetCandidate {
  throughId: string;
  prefixEstimatedTokens: number;
  retainedEstimatedTokens: number;
}
export interface VarinContextBudgetInput {
  boundary: 'before_model_dispatch';
  requestId: string;
  estimate: VarinContextBudgetEstimate;
  capacityTokens: number;
  inputBudgetTokens: number;
  settings: { reserveTokens: number; keepRecentTokens: number; backgroundPreparation: boolean; preparationWaterline: number };
  candidates: VarinContextBudgetCandidate[];
  /** Already paid/admitted work. Compact may apply only this exact source and instructions. */
  acceptedCandidate?: { throughId: string; mode: 'background' | 'blocking'; summaryInstructions?: string };
}
export type VarinContextBudgetDecision = { kind: 'continue' } | {
  kind: 'compact'; throughId: string; mode: 'background' | 'blocking'; summaryInstructions?: string;
};
const textSchema = { type: 'string', minLength: 1, pattern: '\\S' };
const integerSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const objectSchema = (properties: Record<string, JsonValue>, optional: string[] = []) => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties).filter(key => !optional.includes(key)),
});
const descriptionSchema = objectSchema({ identity: objectSchema({ name: textSchema, version: textSchema }), configuration: {} });
const inputSchema = objectSchema({ boundary: { const: 'before_model_dispatch' }, requestId: textSchema,
  estimate: objectSchema({ estimatedTokens: integerSchema, unmeasuredMedia: integerSchema, unmeasuredProviderItems: integerSchema, method: textSchema }),
  capacityTokens: integerSchema, inputBudgetTokens: integerSchema,
  settings: objectSchema({ reserveTokens: integerSchema, keepRecentTokens: integerSchema, backgroundPreparation: { type: 'boolean' },
    preparationWaterline: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 } }),
  candidates: { type: 'array', items: objectSchema({ throughId: textSchema, prefixEstimatedTokens: integerSchema, retainedEstimatedTokens: integerSchema }) },
  acceptedCandidate: objectSchema({ throughId: textSchema, mode: { enum: ['background', 'blocking'] }, summaryInstructions: { type: 'string' } }, ['summaryInstructions']),
}, ['acceptedCandidate']);
const decisionSchema = { oneOf: [objectSchema({ kind: { const: 'continue' } }), objectSchema({ kind: { const: 'compact' },
  throughId: textSchema, mode: { enum: ['background', 'blocking'] }, summaryInstructions: { type: 'string' } }, ['summaryInstructions'])] };
export const VARIN_CONTEXT_BUDGET_CONTRACT = {
  id: VARIN_CONTEXT_BUDGET_SERVICE_ID, version: VARIN_CONTEXT_BUDGET_VERSION, participation: 'decision',
  boundary: 'before_model_dispatch', methods: ['describe', 'decide'],
  describe: { inputSchema: { type: 'array', maxItems: 0 }, outputSchema: descriptionSchema },
  decide: { inputSchema: { type: 'array', minItems: 1, maxItems: 1, items: inputSchema }, outputSchema: decisionSchema },
  cancellation: 'discard_unfinished_decision', historyAccess: 'legal_ancestor_metadata_only',
} as const;
/** Registration, package manifests, discovery and validators use one declared contract. */
export const VARIN_CONTEXT_BUDGET_SERVICE = {
  id: VARIN_CONTEXT_BUDGET_SERVICE_ID, version: VARIN_CONTEXT_BUDGET_VERSION, multiple: true,
  contract: { participation: VARIN_CONTEXT_BUDGET_CONTRACT.participation, methods: {
    describe: VARIN_CONTEXT_BUDGET_CONTRACT.describe, decide: VARIN_CONTEXT_BUDGET_CONTRACT.decide,
  } },
} as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[], optional: string[] = []) => Object.keys(value).every(key => keys.includes(key) || optional.includes(key)) && keys.every(key => key in value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function json(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(json); return; }
  if (record(value)) { Object.values(value).forEach(json); return; }
  throw new Error('Context budget requires JSON data');
}
export function parseVarinContextBudgetDescription(value: unknown): VarinContextBudgetDescription {
  if (!record(value) || !exact(value, ['identity', 'configuration']) || !record(value.identity)
    || !exact(value.identity, ['name', 'version']) || !text(value.identity.name) || !text(value.identity.version)) throw new Error('Invalid context budget description');
  json(value.configuration);
  return structuredClone(value) as unknown as VarinContextBudgetDescription;
}
export function parseVarinContextBudgetEstimate(value: unknown): VarinContextBudgetEstimate {
  if (!record(value) || !exact(value, ['estimatedTokens', 'unmeasuredMedia', 'unmeasuredProviderItems', 'method'])
    || !integer(value.estimatedTokens) || !integer(value.unmeasuredMedia) || !integer(value.unmeasuredProviderItems) || !text(value.method)) throw new Error('Invalid context estimate');
  return structuredClone(value) as unknown as VarinContextBudgetEstimate;
}
export function parseVarinContextBudgetCandidates(value: unknown): VarinContextBudgetCandidate[] {
  if (!Array.isArray(value) || value.some(candidate => !record(candidate) || !exact(candidate, ['throughId', 'prefixEstimatedTokens', 'retainedEstimatedTokens'])
    || !text(candidate.throughId) || !integer(candidate.prefixEstimatedTokens) || !integer(candidate.retainedEstimatedTokens))
    || new Set(value.map(candidate => candidate.throughId)).size !== value.length) throw new Error('Invalid context budget candidates');
  return structuredClone(value) as VarinContextBudgetCandidate[];
}
export function parseVarinContextBudgetInput(value: unknown): VarinContextBudgetInput {
  if (!record(value) || !exact(value, ['boundary', 'requestId', 'estimate', 'capacityTokens', 'inputBudgetTokens', 'settings', 'candidates'], ['acceptedCandidate'])
    || value.boundary !== 'before_model_dispatch' || !text(value.requestId) || !integer(value.capacityTokens) || !integer(value.inputBudgetTokens)
    || !record(value.settings) || !exact(value.settings, ['reserveTokens', 'keepRecentTokens', 'backgroundPreparation', 'preparationWaterline'])
    || !integer(value.settings.reserveTokens) || !integer(value.settings.keepRecentTokens) || typeof value.settings.backgroundPreparation !== 'boolean'
    || typeof value.settings.preparationWaterline !== 'number' || !(value.settings.preparationWaterline > 0 && value.settings.preparationWaterline < 1)) throw new Error('Invalid context budget input');
  parseVarinContextBudgetEstimate(value.estimate); parseVarinContextBudgetCandidates(value.candidates);
  if (value.acceptedCandidate !== undefined) {
    const accepted = value.acceptedCandidate;
    if (!record(accepted) || !exact(accepted, ['throughId', 'mode'], ['summaryInstructions'])
      || !text(accepted.throughId) || !['background', 'blocking'].includes(String(accepted.mode))
      || 'summaryInstructions' in accepted && typeof accepted.summaryInstructions !== 'string'
      || !(value.candidates as VarinContextBudgetCandidate[]).some(candidate => candidate.throughId === accepted.throughId)) {
      throw new Error('Invalid accepted context candidate');
    }
  }
  return structuredClone(value) as unknown as VarinContextBudgetInput;
}
export function parseVarinContextBudgetDecision(value: unknown): VarinContextBudgetDecision {
  if (!record(value) || !(value.kind === 'continue' && exact(value, ['kind'])
    || value.kind === 'compact' && exact(value, ['kind', 'throughId', 'mode'], ['summaryInstructions']) && text(value.throughId)
    && ['background', 'blocking'].includes(String(value.mode)) && (!('summaryInstructions' in value) || typeof value.summaryInstructions === 'string'))) throw new Error('Invalid context budget decision');
  return structuredClone(value) as unknown as VarinContextBudgetDecision;
}
