import { createHash } from 'node:crypto';
import type { ExploreDeps } from './explore.js';
import type { NativeSemanticInferenceReceipt } from '../knowledge/semantic/native-inference.js';

export type RetrievalStageKind = 'keyword' | 'structure' | 'semantic' | 'model';
export type RetrievalStageStatus = 'ready' | 'empty' | 'partial' | 'unavailable' | 'unsupported' | 'failed' | 'cancelled' | 'stale' | 'disabled';
export interface PipelineStage {
  readonly kind: RetrievalStageKind;
  readonly providerId: string;
  readonly configurationId: string;
  readonly status: 'ready' | 'disabled' | 'unavailable' | 'unsupported';
}
/** Nonsecret identity of the exact backend and published reader retained for this query. */
export interface NativeRetrievalSemanticMetadata {
  readonly bindingState: 'ready' | 'unconfigured' | 'disabled' | 'invalid' | 'unavailable';
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly configurationId: string | null;
  readonly spaceId: string | null;
  readonly recipeId: string | null;
  readonly publishedRevision: string | null;
  readonly processEpoch: string | null;
  readonly coverage: 'empty' | 'partial' | 'complete';
  readonly lifecycle: 'idle' | 'building' | 'rebuilding' | 'ready';
  readonly credential?: Readonly<{ reference: string; authority: string; account: string; generation: number }>;
}
export interface PipelinePlan {
  readonly id: string;
  readonly configurationGeneration: number;
  readonly stages: readonly PipelineStage[];
  readonly semantic?: Readonly<NativeRetrievalSemanticMetadata>;
  readonly selection?: Readonly<{ providerId: string; providerKey: string; artifactId: string; configurationId: string; selectionRevision: number }>;
}
export interface RetrievalSnippet { path: string; revision: string; startLine: number; endLine: number; content: string }
export interface RetrievalStageBinding<T> {
  providerId: string;
  configurationId: string;
  /** Selected unavailable stages retain their identity and do not silently fall back. */
  status: PipelineStage['status'];
  implementation?: T;
}
export interface RetrievalPipelineConfiguration {
  configurationId: string;
  structure?: RetrievalStageBinding<NonNullable<ExploreDeps['structure']>>;
  semantic?: RetrievalStageBinding<NonNullable<ExploreDeps['semantic']>>;
  /** Explicitly selected model may select/reorder only already-authorized snippets. No implicit model. */
  model?: RetrievalStageBinding<(input: { question: string; snippets: readonly RetrievalSnippet[] }, signal: AbortSignal) => Promise<readonly number[]>>;
}
export interface BoundRetrievalPipeline {
  readonly plan: PipelinePlan;
  readonly assertAvailable?: () => void;
  readonly validateAvailable?: (signal?: AbortSignal) => Promise<void>;
  readonly inferenceReceipts?: () => readonly NativeSemanticInferenceReceipt[];
  readonly release?: () => void;
  readonly structure?: NonNullable<ExploreDeps['structure']>;
  readonly semantic?: NonNullable<ExploreDeps['semantic']>;
  readonly model?: NonNullable<RetrievalPipelineConfiguration['model']>['implementation'];
}
function bind(configuration: RetrievalPipelineConfiguration, generation: number): BoundRetrievalPipeline {
  if (!configuration.configurationId.trim()) throw new Error('Retrieval configuration identity is required');
  const stages: PipelineStage[] = [{ kind: 'keyword', providerId: 'varin.kernel.search', configurationId: 'native-search-v1', status: 'ready' }];
  const implementations: Pick<BoundRetrievalPipeline, 'structure' | 'semantic' | 'model'> = {};
  for (const kind of ['structure', 'semantic', 'model'] as const) {
    const selected = configuration[kind];
    if (!selected) { stages.push(Object.freeze({ kind, providerId: 'none', configurationId: 'disabled', status: 'disabled' })); continue; }
    if (!selected.providerId.trim() || !selected.configurationId.trim() || !['ready','disabled','unavailable','unsupported'].includes(selected.status)) {
      throw new Error('Invalid retrieval stage identity or availability');
    }
    if (selected.status === 'ready' && !selected.implementation) throw new Error(`Selected ${kind} stage has no implementation`);
    stages.push(Object.freeze({ kind, providerId: selected.providerId, configurationId: selected.configurationId, status: selected.status }));
    // Capture method handles now. Mutation of a caller's configuration object cannot rebind an old query.
    if (selected.status === 'ready') {
      if (kind === 'structure') {
        const source = configuration.structure!.implementation!;
        Object.assign(implementations, { structure: Object.freeze({ outline: source.outline.bind(source), classifyHits: source.classifyHits.bind(source),
          ...(source.literalCalls ? { literalCalls: source.literalCalls.bind(source) } : {}) }) });
      } else if (kind === 'semantic') {
        const source = configuration.semantic!.implementation!;
        Object.assign(implementations, { semantic: Object.freeze({ search: source.search.bind(source) }) });
      } else Object.assign(implementations, { model: configuration.model!.implementation! });
    }
  }
  const id = createHash('sha256').update(JSON.stringify([configuration.configurationId, generation, stages])).digest('hex');
  return Object.freeze({ plan: Object.freeze({ id, configurationGeneration: generation, stages: Object.freeze(stages.map(stage => Object.freeze(stage))) }), ...implementations });
}

/** Query-local bindings over existing providers. This owns no index, parser, model, or configuration file.
 * The caller prepares a candidate through its real capability owner before publishing it here.
 * In-flight queries hold the old immutable plan; a rejected/superseded candidate leaves it active.
 */
export function createRetrievalPipelineOwner(initial: RetrievalPipelineConfiguration) {
  let generation = 1;
  let current = bind(initial, generation);
  let candidate = 0;
  return {
    capture: (): BoundRetrievalPipeline => current,
    async replace(prepare: () => Promise<RetrievalPipelineConfiguration>, assertCurrent?: () => void): Promise<PipelinePlan> {
      const ticket = ++candidate;
      const configuration = await prepare();
      assertCurrent?.();
      const next = bind(configuration, generation + 1);
      if (ticket !== candidate) throw new Error('Retrieval configuration preparation was superseded');
      generation += 1;
      current = next;
      return next.plan;
    },
  };
}
export type RetrievalPipelineOwner = ReturnType<typeof createRetrievalPipelineOwner>;
