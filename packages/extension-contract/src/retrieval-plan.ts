/** A declarative stage selection, not permission to read files, query an index or call a model.
 * The retrieval owner supplies and authorizes the selected stage implementations. */
export const VARIN_RETRIEVAL_PLAN_SERVICE_ID = 'varin.retrieval.plan';
export const VARIN_RETRIEVAL_PLAN_VERSION = 1 as const;
export const VARIN_RETRIEVAL_PLAN_METHOD = 'describe' as const;

export interface VarinRetrievalPlan {
  /** Immutable, author-defined configuration identity within this package artifact. */
  configurationId: string;
  structure: 'builtin' | 'disabled';
  /** An explicit built-in stage; omitted means disabled, never an inferred model choice. */
  semantic?: 'builtin' | 'disabled';
}

export const VARIN_RETRIEVAL_PLAN_CONTRACT = {
  id: VARIN_RETRIEVAL_PLAN_SERVICE_ID,
  version: VARIN_RETRIEVAL_PLAN_VERSION,
  participation: 'transform',
  method: VARIN_RETRIEVAL_PLAN_METHOD,
  inputSchema: { type: 'array', maxItems: 0 },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['configurationId', 'structure'],
    properties: {
      configurationId: { type: 'string', minLength: 1, pattern: '\\S' },
      structure: { enum: ['builtin', 'disabled'] },
      semantic: { enum: ['builtin', 'disabled'] },
    },
  },
} as const;

export function parseVarinRetrievalPlan(value: unknown): VarinRetrievalPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['configurationId', 'structure', 'semantic'].includes(key))
    || !('configurationId' in value) || typeof value.configurationId !== 'string' || !value.configurationId.trim()
    || !('structure' in value) || (value.structure !== 'builtin' && value.structure !== 'disabled')
    || ('semantic' in value && value.semantic !== 'builtin' && value.semantic !== 'disabled')) {
    throw new Error('Retrieval plan must contain only a configurationId and supported structure/semantic selections');
  }
  return { configurationId: value.configurationId, structure: value.structure,
    ...('semantic' in value ? { semantic: value.semantic as 'builtin' | 'disabled' } : {}) };
}
