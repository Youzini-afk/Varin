import type { InferenceCall } from '../knowledge/semantic/inference-requests.js';
import { createHash } from 'node:crypto';
import type { ApplicationExtensionRuntime, HostServicePin } from '@varin/extension-host';
import { VARIN_BUILTIN_RETRIEVAL_DEFAULT_PROVIDER_KEY } from '@varin/extension-builtins';
import {
  parseVarinRetrievalPlan, VARIN_RETRIEVAL_PLAN_METHOD, VARIN_RETRIEVAL_PLAN_SERVICE_ID,
  VARIN_RETRIEVAL_PLAN_VERSION, type VarinRetrievalPlan,
} from '@varin/extension-contract';
import { waitWithSignal } from '../cancellation.js';
import {
  createRetrievalPipelineOwner, type BoundRetrievalPipeline, type RetrievalPipelineConfiguration,
  type RetrievalPipelineOwner, type RetrievalSemanticMetadata,
} from '../harness/retrieval-pipeline.js';
import type { RetrievalQuery } from './protocol.generated.js';

export interface RetrievalCompositionScope {
  threadId: string;
  projectId?: string;
  /** The existing service-routing workspace identity is the canonical directory, not a ID. */
  workspaceId?: string;
  /** Original Run identity for the capability owner; never sent to the declaration extension. */
  query?: RetrievalQuery;
  /** Query-owned request session; private to the bound consumers, never extension arguments. */
  inference?: InferenceCall | undefined;
}
export interface RetrievalSelection {
  readonly providerId: string;
  readonly providerKey: string;
  readonly artifactId: string;
  readonly configurationId: string;
  readonly selectionRevision: number;
}
export interface RetrievalSemanticLease {
  readonly stage: NonNullable<RetrievalPipelineConfiguration['semantic']>;
  readonly metadata: Readonly<RetrievalSemanticMetadata>;
  assertAvailable(): void;
  validateAvailable(signal?: AbortSignal): Promise<void>;
  release(): void;
}
export interface RetrievalModelLease {
  readonly stage: NonNullable<RetrievalPipelineConfiguration['model']>;
  assertAvailable(): void;
  validateAvailable(signal?: AbortSignal): Promise<void>;
  release(): void;
}
export interface RetrievalPipelineBinding extends BoundRetrievalPipeline {
  readonly selection: Readonly<RetrievalSelection>;
  assertAvailable(): void;
  release(): void;
}
interface ScopeCache {
  requests: number;
  candidateAdmission: number;
  candidateKey?: string;
  candidate: number;
  owner?: RetrievalPipelineOwner;
  current?: { selectedKey: string; declaration: Readonly<VarinRetrievalPlan> };
  publishing?: { identity: string; result: Promise<void> };
}

/** Resolve existing scoped routing, prepare an isolated declaration, then publish a frozen plan.
 * This cache owns no index, parser, configuration file, filesystem or model capability. Every
 * query retains its own real Host service generation pin until its caller releases the binding. */
export function createRetrievalComposition(runtime: ApplicationExtensionRuntime, options: {
  prepareModel?: (scope: RetrievalCompositionScope, signal?: AbortSignal) => Promise<RetrievalModelLease>;
  structure?: NonNullable<RetrievalPipelineConfiguration['structure']>['implementation'];
  /** Same native syntax provider, without a live-project LSP fallback. */
  syntax?: NonNullable<RetrievalPipelineConfiguration['structure']>['implementation'];
  /** Capture only; preparation never embeds the question, reads candidate text or starts indexing. */
  prepareSemantic?: (scope: RetrievalCompositionScope, signal?: AbortSignal) => Promise<RetrievalSemanticLease>;
}) {
  const scopes = new Map<string, ScopeCache>();
  return {
    async prepare(scope: RetrievalCompositionScope, signal?: AbortSignal): Promise<RetrievalPipelineBinding> {
      signal?.throwIfAborted();
      if (!scope.threadId.trim()) throw new Error('Retrieval requires a Thread identity');
      const routingScope = { userId: 'default', sessionId: scope.threadId,
        ...(scope.projectId ? { projectId: scope.projectId } : {}),
        ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}) };
      const scopeKey = JSON.stringify(routingScope);
      let cache = scopes.get(scopeKey);
      if (!cache) { cache = { requests: 0, candidateAdmission: 0, candidate: 0 }; scopes.set(scopeKey, cache); }
      const state = cache;
      const admission = ++state.requests;
      const routing = await waitWithSignal(runtime.routing.read(), signal);
      if (!routing.authoritative) throw new Error('Retrieval plan routing is unavailable');
      const request = { serviceId: VARIN_RETRIEVAL_PLAN_SERVICE_ID, version: VARIN_RETRIEVAL_PLAN_VERSION,
        method: VARIN_RETRIEVAL_PLAN_METHOD, args: [], routing: routingScope };
      const prepareOptions = { defaultProviderKey: VARIN_BUILTIN_RETRIEVAL_DEFAULT_PROVIDER_KEY,
        expectedRoutingRevision: routing.document.revision, ...(signal ? { signal } : {}) };
      const selected = await runtime.prepareService(request, prepareOptions);
      let pin: HostServicePin | undefined;
      let semantic: RetrievalSemanticLease | undefined;
      let model: RetrievalModelLease | undefined;
      try {
        signal?.throwIfAborted();
        pin = selected.pin();
        const queryPin = pin;
        const callSignal = signal ? AbortSignal.any([signal, queryPin.revocationSignal]) : queryPin.revocationSignal;
        const provider = runtime.services.getSnapshot().providers.find(item => item.providerId === selected.providerId && item.status === 'active');
        const artifactId = provider && runtime.supervisor.getActiveArtifactIdentity(provider);
        if (!provider || !artifactId) throw new Error('Retrieval executing artifact identity is unavailable');
        if (!selected.composition) throw new Error('Retrieval composition identity is unavailable');
        const compositionRoot = selected.composition.root;
        const selectedKey = JSON.stringify([selected.providerKey, compositionRoot]);
        // An older request finishing activation cannot supersede a newer admitted selection.
        // The exact provider/artifact is still checked below; completion order is not authority.
        const selectedRouting = await waitWithSignal(runtime.routing.read(), callSignal);
        if (!selectedRouting.authoritative || selectedRouting.document.revision !== routing.document.revision
          || (admission < state.candidateAdmission && state.candidateKey !== selectedKey)) {
          throw new Error('Retrieval plan preparation was superseded');
        }
        queryPin.assertAvailable();
        if (runtime.supervisor.getActiveArtifactIdentity(provider) !== artifactId) throw new Error('Retrieval executing artifact changed during preparation');
        if (state.candidateKey !== selectedKey) { state.candidateKey = selectedKey; state.candidate += 1; }
        state.candidateAdmission = Math.max(state.candidateAdmission, admission);
        const ticket = state.candidate;
        const assertCandidate = (): void => {
          signal?.throwIfAborted();
          queryPin.assertAvailable();
          if (state.candidate !== ticket) throw new Error('Retrieval plan preparation was superseded');
        };
        const assertSelection = async (): Promise<void> => {
          const current = await runtime.resolveServiceCompositions(request, { ...prepareOptions, signal: callSignal });
          assertCandidate();
          if (current.services.length !== 1 || current.services[0]!.providerKey !== selected.providerKey
            || current.services[0]!.composition.root !== compositionRoot
            || runtime.supervisor.getActiveArtifactIdentity(provider) !== artifactId) {
            throw new Error('Retrieval plan selection changed during preparation');
          }
        };
        const acquireSemantic = async (declaration: Readonly<VarinRetrievalPlan>): Promise<RetrievalSemanticLease | undefined> => {
          if (declaration.semantic !== 'builtin' || !options.prepareSemantic) return undefined;
          const preparing = options.prepareSemantic(scope, callSignal);
          let acquired: RetrievalSemanticLease;
          try { acquired = await waitWithSignal(preparing, callSignal); }
          catch (error) { void preparing.then(late => late.release(), () => {}); throw error; }
          try {
            await assertSelection();
            acquired.assertAvailable();
            const stage = acquired.stage;
            if (!stage.providerId.trim() || !stage.configurationId.trim()
              || !['ready', 'disabled', 'unavailable', 'unsupported'].includes(stage.status)
              || (stage.status === 'ready' && !stage.implementation)) {
              throw new Error('Invalid semantic lease stage');
            }
            return acquired;
          } catch (error) { acquired.release(); throw error; }
        };
        if (state.current?.selectedKey !== selectedKey) {
          const declaration = parseVarinRetrievalPlan(await waitWithSignal(queryPin.invoke(VARIN_RETRIEVAL_PLAN_METHOD, [], callSignal), callSignal));
          await assertSelection();
          semantic = await acquireSemantic(declaration);
          // Unrelated routing edits do not change the effective immutable declaration identity.
          const identity = createHash('sha256').update(JSON.stringify({ compositionRoot,
            providerKey: selected.providerKey, artifactId, declaration })).digest('hex');
          const configuration: RetrievalPipelineConfiguration = {
            configurationId: identity,
            structure: { providerId: declaration.structure === 'builtin' ? 'varin.kernel.structure' : 'none',
              configurationId: identity, status: declaration.structure === 'disabled' ? 'disabled' : options.structure ? 'ready' : 'unavailable',
              ...(declaration.structure === 'builtin' && options.structure ? { implementation: options.structure } : {}) },
            ...(declaration.semantic === 'builtin' ? { semantic: { providerId: 'varin.semantic',
              configurationId: 'semantic-v1', status: 'unavailable' as const } } : {}),
          };
          // Concurrent first queries of the same selected generation share only this short
          // publication. Their describe calls, cancellation and lifetime pins stay independent.
          if (state.current?.selectedKey !== selectedKey) {
            if (!state.publishing || state.publishing.identity !== identity) {
              assertCandidate();
              const publicationPin = selected.pin();
              const assertPublication = (): void => {
                publicationPin.assertAvailable();
                if (state.candidate !== ticket) throw new Error('Retrieval plan preparation was superseded');
              };
              const publish = async (): Promise<void> => {
                try {
                  assertPublication();
                  if (state.owner) await state.owner.replace(async () => configuration, assertPublication);
                  else state.owner = createRetrievalPipelineOwner(configuration);
                  state.current = { selectedKey, declaration: Object.freeze({ ...declaration }) };
                } finally { publicationPin.release(); }
              };
              const publishing = { identity, result: publish() };
              state.publishing = publishing;
              void publishing.result.finally(() => { if (state.publishing === publishing) delete state.publishing; }).catch(() => {});
            }
            await waitWithSignal(state.publishing.result, callSignal);
          }
        } else {
          await assertSelection();
          semantic = await acquireSemantic(state.current.declaration);
        }
        assertCandidate();
        if (state.current?.selectedKey !== selectedKey || !state.owner) throw new Error('Retrieval plan preparation was superseded');
        if (options.prepareModel) {
          const preparing = options.prepareModel(scope, callSignal);
          try { model = await waitWithSignal(preparing, callSignal); }
          catch (error) { void preparing.then(late => late.release(), () => {}); throw error; }
          await assertSelection();
          model.assertAvailable();
        }
        const pipeline = state.owner.capture();
        const selection = Object.freeze({ providerId: selected.providerId, providerKey: selected.providerKey,
          artifactId, configurationId: state.current.declaration.configurationId, selectionRevision: routing.document.revision });
        // Query resources never enter the shared publication. Each query captures and owns its
        // real backend/reader lease, including independently acquired refs for identical plans.
        const semanticStage = semantic?.stage;
        const sourceLimited = !!scope.query && (scope.query.source.mode !== 'live_root'
          || scope.query.source.resource_owner.kind === 'managed_host');
        const syntax = sourceLimited && state.current.declaration.structure === 'builtin' ? options.syntax : undefined;
        const sourceStages = sourceLimited ? Object.freeze(pipeline.plan.stages.map(stage => {
          if (stage.kind === 'structure' && stage.status !== 'disabled') return Object.freeze({ ...stage,
            providerId: 'varin.kernel.tree-sitter', status: syntax ? 'ready' as const : 'unavailable' as const });
          return stage;
        })) : pipeline.plan.stages;
        const semanticStages = semanticStage ? Object.freeze(sourceStages.map(stage => stage.kind === 'semantic'
          ? Object.freeze({ kind: 'semantic' as const, providerId: semanticStage.providerId,
            configurationId: semanticStage.configurationId, status: semanticStage.status }) : stage)) : sourceStages;
        const modelStage = model?.stage;
        const stages = modelStage ? Object.freeze(semanticStages.map(stage => stage.kind === 'model'
          ? Object.freeze({ kind: 'model' as const, providerId: modelStage.providerId, configurationId: modelStage.configurationId, status: modelStage.status }) : stage)) : semanticStages;
        const metadata = semantic ? Object.freeze({ ...semantic.metadata,
          ...(semantic.metadata.credential ? { credential: Object.freeze({ ...semantic.metadata.credential }) } : {}) }) : undefined;
        const id = sourceLimited || metadata || modelStage ? createHash('sha256').update(JSON.stringify([pipeline.plan.id, stages, metadata])).digest('hex') : pipeline.plan.id;
        const implementation = semanticStage?.status === 'ready' ? semanticStage.implementation : undefined;
        const lease = semantic;
        const modelLease = model;
        let released = false;
        const assertAvailable = (): void => {
          if (released) throw new Error('Retrieval query binding was released');
          signal?.throwIfAborted();
          queryPin.assertAvailable();
          lease?.assertAvailable();
          modelLease?.assertAvailable();
        };
        const { structure: originalStructure, ...sourcePipeline } = pipeline;
        const structure = sourceLimited ? syntax : originalStructure;
        return Object.freeze({ ...sourcePipeline,
          ...(structure ? { structure } : {}),
          ...(modelStage?.status === 'ready' && modelStage.implementation ? { model: modelStage.implementation } : {}),
          ...(implementation ? { semantic: Object.freeze({ search: implementation.search.bind(implementation) }) } : {}),
          plan: Object.freeze({ ...pipeline.plan, id, stages, selection, ...(metadata ? { semantic: metadata } : {}) }), selection,
          assertAvailable,
          validateAvailable: async (validationSignal?: AbortSignal) => {
            assertAvailable(); validationSignal?.throwIfAborted();
            await lease?.validateAvailable(validationSignal ?? signal);
            await modelLease?.validateAvailable(validationSignal ?? signal);
            assertAvailable(); validationSignal?.throwIfAborted();
          },
          release: () => { if (released) return; released = true; try { lease?.release(); } finally { try { modelLease?.release(); } finally { queryPin.release(); } } },
        });
      } catch (error) { try { semantic?.release(); } finally { try { model?.release(); } finally { pin?.release(); } } throw error; }
      finally { selected.release(); }
    },
  };
}
