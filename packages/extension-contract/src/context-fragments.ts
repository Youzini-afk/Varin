/** Declarative context contribution. Preparing this contract must not perform external effects,
 * model calls or retrieval. Those belong to explicit operations, not a pure context transform. */
export const VARIN_CONTEXT_FRAGMENTS_SERVICE_ID = 'varin.context.fragments';
export const VARIN_CONTEXT_FRAGMENTS_VERSION = 1 as const;
export const VARIN_CONTEXT_FRAGMENTS_METHOD = 'describe' as const;
export interface VarinContextFragment {
  name: string;
  kind: 'instruction' | 'data';
  content: string;
}
export interface VarinContextFragments {
  sections: VarinContextFragment[];
}
/** Same metadata supplies author tooling, inspection and the preparation boundary validator. */
export const VARIN_CONTEXT_FRAGMENTS_CONTRACT = {
  id: VARIN_CONTEXT_FRAGMENTS_SERVICE_ID,
  version: VARIN_CONTEXT_FRAGMENTS_VERSION,
  participation: 'transform',
  method: VARIN_CONTEXT_FRAGMENTS_METHOD,
  inputSchema: { type: 'array', maxItems: 0 },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['sections'],
    properties: { sections: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['name', 'kind', 'content'],
      properties: { name: { type: 'string', minLength: 1, pattern: '\\S' }, kind: { enum: ['instruction', 'data'] }, content: { type: 'string' } },
    } } },
  },
} as const;
export function parseVarinContextFragments(value: unknown): VarinContextFragments {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'sections') || !('sections' in value) || !Array.isArray(value.sections)) {
    throw new Error('Context fragments must contain only a sections array');
  }
  const names = new Set<string>();
  const sections = value.sections.map((item: unknown): VarinContextFragment => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !['name', 'kind', 'content'].includes(key))
      || !('name' in item) || typeof item.name !== 'string' || !item.name.trim()
      || !('kind' in item) || typeof item.kind !== 'string' || !['instruction', 'data'].includes(item.kind)
      || !('content' in item) || typeof item.content !== 'string') throw new Error('Invalid context fragment');
    if (names.has(item.name)) throw new Error(`Duplicate context fragment: ${item.name}`);
    names.add(item.name);
    return { name: item.name, kind: item.kind as VarinContextFragment['kind'], content: item.content };
  });
  return { sections };
}
