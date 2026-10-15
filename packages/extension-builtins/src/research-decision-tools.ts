import type { JsonObject, VarinExtensionServiceProvision } from '@varin/extension-contract';
export const VARIN_BUILTIN_RESEARCH_DECISION_EXTENSION_ID = 'varin.builtin.research-decision';
export const RESEARCH_DECISION_CAPABILITY = 'research.decision';
const text = { type: 'string', minLength: 1 };
const object = (properties: JsonObject, required: string[]): JsonObject => ({ type: 'object', additionalProperties: false, properties, required });
/** One original declaration supplies the artifact, admission and Host argument decoder. */
export const RESEARCH_DECISION_TOOL_DECLARATIONS: readonly VarinExtensionServiceProvision[] = [{
  id: 'varin.research.decide', version: 1,
  tool: { name: 'research_decide', operation: 'read', completion: 'result',
    description: 'Judge the supplied URL, snapshot, paper, section or query candidates against a research goal with the configured fast-decision purpose. Scores and choices are model judgments; missing answers remain unevaluated. Disabled or unavailable inference preserves candidate order. Snapshot text is read with your current material access. No file workspace is required.',
    inputSchema: object({ goal: text, kind: { enum: ['relevance', 'reading-value', 'complementary', 'duplicate', 'continuation', 'next'] },
      purpose: { enum: ['web', 'scholarly'] }, candidates: { type: 'array', minItems: 1, items: object({
        id: text, kind: { enum: ['url', 'snapshot', 'paper', 'section', 'query'] }, title: { type: 'string' }, detail: { type: 'string' }, url: text,
        snapshotId: text, section: object({ snapshotId: text, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, label: { type: 'string' } }, ['snapshotId']),
        paper: object({ providerId: text, providerRecordId: text, doi: text }, ['providerId', 'providerRecordId']),
      }, ['id', 'kind']) } }, ['goal', 'kind', 'candidates']), outputSchema: { type: 'object' },
  },
}];
