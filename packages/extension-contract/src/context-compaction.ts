import type { JsonValue } from './types.js';
import type { ResolvedMedia } from './nested-tools.generated.js';
import { parseVarinToolJson } from './tools.js';

/** Pure algorithm Provider. Core owns the source cut, model execution and checkpoint commit. */
export const VARIN_CONTEXT_COMPACTION_SERVICE_ID = 'varin.context.compaction';
export const VARIN_CONTEXT_COMPACTION_VERSION = 1 as const;
export interface VarinContextCompactionDescription {
  identity: { name: string; version: string };
  configuration: JsonValue;
}
export interface VarinContextCompactionSource {
  sourceId: string;
  /** Unbudgeted quotation. Text retains original item identity/provenance, never active instructions. */
  item: {
    id: string;
    provenance: { kind: 'external_data'; source: string };
    content: { kind: 'text'; text: string } | { kind: 'media'; media: ResolvedMedia };
    opaque: null;
  };
}
export interface VarinContextCompactionInput {
  sourceCutHash: string;
  sources: VarinContextCompactionSource[];
  modelBudget: {
    contextWindowTokens: number | null;
    maxOutputTokens: number | null;
    sourceBudgetTokens: number | null;
  };
}
export type VarinContextCompactionNodeInput =
  | { kind: 'source'; sourceId: string; range: { start: number; end: number } | null }
  | { kind: 'node_output'; nodeId: string };
export interface VarinContextCompactionNode {
  id: string;
  instructions: string | null;
  inputs: VarinContextCompactionNodeInput[];
}
export type VarinContextCompactionPlan =
  | { kind: 'text'; sourceCutHash: string; text: string }
  | { kind: 'model_plan'; sourceCutHash: string; nodes: VarinContextCompactionNode[]; finalNodeId: string };

const textSchema = { type: 'string', minLength: 1, pattern: '\\S' };
const integerSchema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableIntegerSchema = { anyOf: [integerSchema, { type: 'null' }] };
const objectSchema = (properties: Record<string, JsonValue>) => ({
  type: 'object', additionalProperties: false, properties, required: Object.keys(properties),
});
const descriptionSchema = objectSchema({ identity: objectSchema({ name: textSchema, version: textSchema }), configuration: {} });
const sourceSchema = objectSchema({ sourceId: textSchema, item: objectSchema({
  id: textSchema, provenance: objectSchema({ kind: { const: 'external_data' }, source: textSchema }), opaque: { type: 'null' },
  content: { oneOf: [objectSchema({ kind: { const: 'text' }, text: { type: 'string' } }),
    objectSchema({ kind: { const: 'media' }, media: objectSchema({ media_type: textSchema, data_base64: { type: 'string' }, source: { type: 'object' } }) })] },
}) });
const inputSchema = objectSchema({ sourceCutHash: textSchema, sources: { type: 'array', minItems: 1, items: sourceSchema },
  modelBudget: objectSchema({ contextWindowTokens: nullableIntegerSchema, maxOutputTokens: nullableIntegerSchema, sourceBudgetTokens: nullableIntegerSchema }),
});
const nodeInputSchema = { oneOf: [objectSchema({ kind: { const: 'source' }, sourceId: textSchema,
  range: { anyOf: [{ type: 'null' }, objectSchema({ start: integerSchema, end: integerSchema })] },
}), objectSchema({ kind: { const: 'node_output' }, nodeId: textSchema })] };
const planSchema = { oneOf: [objectSchema({ kind: { const: 'text' }, sourceCutHash: textSchema, text: textSchema }),
  objectSchema({ kind: { const: 'model_plan' }, sourceCutHash: textSchema,
    nodes: { type: 'array', minItems: 1, items: objectSchema({ id: textSchema, instructions: { type: ['string', 'null'] },
      inputs: { type: 'array', minItems: 1, items: nodeInputSchema } }) }, finalNodeId: textSchema })] };
export const VARIN_CONTEXT_COMPACTION_CONTRACT = {
  id: VARIN_CONTEXT_COMPACTION_SERVICE_ID, version: VARIN_CONTEXT_COMPACTION_VERSION, participation: 'provider',
  methods: ['describe', 'prepare'],
  describe: { inputSchema: { type: 'array', maxItems: 0 }, outputSchema: descriptionSchema },
  prepare: { inputSchema: { type: 'array', minItems: 1, maxItems: 1, items: inputSchema }, outputSchema: planSchema },
  cancellation: 'discard_unaccepted_plan', sourceAccess: 'immutable_quoted_cut', execution: 'core_owned_serial_model_steps',
  rangeUnit: 'utf8_bytes',
} as const;
/** One declaration for package manifests, SDK registration and service discovery. */
export const VARIN_CONTEXT_COMPACTION_SERVICE = {
  id: VARIN_CONTEXT_COMPACTION_SERVICE_ID, version: VARIN_CONTEXT_COMPACTION_VERSION, multiple: true,
  contract: { participation: VARIN_CONTEXT_COMPACTION_CONTRACT.participation, methods: {
    describe: VARIN_CONTEXT_COMPACTION_CONTRACT.describe, prepare: VARIN_CONTEXT_COMPACTION_CONTRACT.prepare,
  } },
} as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableInteger = (value: unknown) => value === null || integer(value);
export function parseVarinContextCompactionDescription(value: unknown): VarinContextCompactionDescription {
  if (!record(value) || !exact(value, ['identity', 'configuration']) || !record(value.identity)
    || !exact(value.identity, ['name', 'version']) || !text(value.identity.name) || !text(value.identity.version)) throw new Error('Invalid context compaction description');
  return { identity: { name: value.identity.name, version: value.identity.version }, configuration: parseVarinToolJson(value.configuration) };
}
export function parseVarinContextCompactionInput(value: unknown): VarinContextCompactionInput {
  if (!record(value) || !exact(value, ['sourceCutHash', 'sources', 'modelBudget']) || !text(value.sourceCutHash)
    || !Array.isArray(value.sources) || !value.sources.length || !record(value.modelBudget)
    || !exact(value.modelBudget, ['contextWindowTokens', 'maxOutputTokens', 'sourceBudgetTokens'])
    || !Object.values(value.modelBudget).every(nullableInteger)) throw new Error('Invalid context compaction input');
  const seen = new Set<string>();
  for (const source of value.sources) {
    if (!record(source) || !exact(source, ['sourceId', 'item']) || !text(source.sourceId) || seen.has(source.sourceId)
      || !record(source.item) || !exact(source.item, ['id', 'provenance', 'content', 'opaque']) || !text(source.item.id)
      || source.item.opaque !== null || !record(source.item.provenance) || !exact(source.item.provenance, ['kind', 'source'])
      || source.item.provenance.kind !== 'external_data' || !text(source.item.provenance.source)
      || !record(source.item.content)) throw new Error('Invalid context compaction source');
    seen.add(source.sourceId);
    const content = source.item.content;
    if (content.kind === 'text' && exact(content, ['kind', 'text']) && typeof content.text === 'string') continue;
    if (content.kind !== 'media' || !exact(content, ['kind', 'media']) || !record(content.media)
      || !exact(content.media, ['media_type', 'data_base64', 'source']) || !text(content.media.media_type)
      || typeof content.media.data_base64 !== 'string' || !record(content.media.source)) throw new Error('Invalid context compaction source content');
  }
  // Core supplies validated resolved media provenance. Preserve it without inventing another role vocabulary.
  return parseVarinToolJson(value) as unknown as VarinContextCompactionInput;
}
/** Validate structure/topological order, and (when supplied) the exact source cut and UTF-8 ranges. */
export function parseVarinContextCompactionPlan(value: unknown, input?: VarinContextCompactionInput): VarinContextCompactionPlan {
  if (!record(value) || !text(value.sourceCutHash) || input && value.sourceCutHash !== input.sourceCutHash) throw new Error('Invalid context compaction source cut');
  if (value.kind === 'text' && exact(value, ['kind', 'sourceCutHash', 'text']) && text(value.text)) {
    return { kind: 'text', sourceCutHash: value.sourceCutHash, text: value.text };
  }
  if (value.kind !== 'model_plan' || !exact(value, ['kind', 'sourceCutHash', 'nodes', 'finalNodeId']) || !Array.isArray(value.nodes)
    || !value.nodes.length || !text(value.finalNodeId)) throw new Error('Invalid context compaction plan');
  const previous = new Set<string>();
  const sources = input && new Map(input.sources.map(source => [source.sourceId, source]));
  for (const node of value.nodes) {
    if (!record(node) || !exact(node, ['id', 'instructions', 'inputs']) || !text(node.id) || previous.has(node.id)
      || !(node.instructions === null || typeof node.instructions === 'string') || !Array.isArray(node.inputs) || !node.inputs.length) throw new Error('Invalid context compaction node');
    for (const reference of node.inputs) {
      if (!record(reference)) throw new Error('Invalid context compaction node input');
      if (reference.kind === 'node_output' && exact(reference, ['kind', 'nodeId']) && text(reference.nodeId) && previous.has(reference.nodeId)) continue;
      if (reference.kind !== 'source' || !exact(reference, ['kind', 'sourceId', 'range']) || !text(reference.sourceId)) throw new Error('Invalid context compaction node dependency');
      const source = sources?.get(reference.sourceId);
      if (sources && !source) throw new Error('Unknown context compaction source');
      if (reference.range === null) continue;
      const range = reference.range;
      if (!record(range) || !exact(range, ['start', 'end']) || !integer(range.start) || !integer(range.end) || range.start >= range.end) throw new Error('Invalid context compaction source range');
      if (source) {
        if (source.item.content.kind !== 'text') throw new Error('Media context compaction source requires a whole-item reference');
        const bytes = new TextEncoder().encode(source.item.content.text);
        const boundary = (offset: number) => offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80;
        if (range.end > bytes.length || !boundary(range.start) || !boundary(range.end)) throw new Error('Invalid context compaction UTF-8 range');
      }
    }
    previous.add(node.id);
  }
  if (!previous.has(value.finalNodeId)) throw new Error('Unknown final context compaction node');
  const nodes = value.nodes as VarinContextCompactionNode[];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const reachable = new Set<string>();
  const pending = [value.finalNodeId];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const reference of byId.get(id)!.inputs) if (reference.kind === 'node_output') pending.push(reference.nodeId);
  }
  if (reachable.size !== nodes.length) throw new Error('Context compaction plan contains unused model nodes');
  return parseVarinToolJson(value) as unknown as VarinContextCompactionPlan;
}
