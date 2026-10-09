/** A declarative stage selection, not permission to read files, query an index or call a model.
 * The native retrieval owner supplies and authorizes the selected stage implementations. */
export const VARIN_RETRIEVAL_PLAN_SERVICE_ID = 'varin.retrieval.plan';
export const VARIN_RETRIEVAL_PLAN_VERSION = 1 as const;
export const VARIN_RETRIEVAL_PLAN_METHOD = 'describe' as const;

export interface VarinRetrievalPlan {
  /** Immutable, author-defined configuration identity within this package artifact. */
  configurationId: string;
  structure: 'native' | 'disabled';
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
      structure: { enum: ['native', 'disabled'] },
    },
  },
} as const;

export function parseVarinRetrievalPlan(value: unknown): VarinRetrievalPlan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['configurationId', 'structure'].includes(key))
    || !('configurationId' in value) || typeof value.configurationId !== 'string' || !value.configurationId.trim()
    || !('structure' in value) || (value.structure !== 'native' && value.structure !== 'disabled')) {
    throw new Error('Retrieval plan must contain only a configurationId and a supported structure selection');
  }
  return { configurationId: value.configurationId, structure: value.structure };
}
