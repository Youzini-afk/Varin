import { createHash } from 'node:crypto';
import type { ApplicationExtensionRuntime } from '@varin/extension-host';
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
import type { SemanticInferenceReceipt } from '../knowledge/semantic/runtime-inference.js';
import type { RetrievalQuery } from './protocol.generated.js';

export interface RetrievalCompositionScope {
  threadId: string;
  projectId?: string;
  /** The existing service-routing workspace identity is the canonical directory, not a ID. */
  workspaceId?: string;
  /** Original Run identity for the capability owner; never sent to the declaration extension. */
  query?: RetrievalQuery;
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
  inferenceReceipts?(): readonly SemanticInferenceReceipt[];
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
  current?: { selectedKey: string; selection: Readonly<RetrievalSelection>; declaration: Readonly<VarinRetrievalPlan> };
  publishing?: { identity: string; result: Promise<void> };
}

/** Resolve existing scoped routing, prepare an isolated declaration, then publish a frozen plan.
 * This cache owns no index, parser, configuration file, filesystem or model capability. Every
 * query retains its own real Host service generation pin until its caller releases the binding. */
export function createRetrievalComposition(runtime: ApplicationExtensionRuntime, options: {
  structure?: NonNullable<RetrievalPipelineConfiguration['structure']>['implementation'];
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
      const prepareOptions = { defaultProviderKey: VARIN_BUILTIN_RETRIEVAL_DEFAULT_PROVIDER_KEY };
      const selected = await waitWithSignal(runtime.prepareService(request, prepareOptions), signal);
      signal?.throwIfAborted();
      const pin = selected.pin();
      let semantic: RetrievalSemanticLease | undefined;
      try {
        const provider = runtime.services.getSnapshot().providers.find(item => item.providerId === selected.providerId && item.status === 'active');
        const artifactId = provider && runtime.supervisor.getActiveArtifactIdentity(provider);
        if (!provider || !artifactId) throw new Error('Retrieval executing artifact identity is unavailable');
        const selectedKey = JSON.stringify([selected.providerId, artifactId]);
        // An older request finishing activation cannot supersede a newer admitted selection.
        // The exact provider/artifact is still checked below; completion order is not authority.
        const selectedRouting = await waitWithSignal(runtime.routing.read(), signal);
        if (!selectedRouting.authoritative || selectedRouting.document.revision !== routing.document.revision
          || (admission < state.candidateAdmission && state.candidateKey !== selectedKey)) {
          throw new Error('Retrieval plan preparation was superseded');
        }
        pin.assertAvailable();
        if (runtime.supervisor.getActiveArtifactIdentity(provider) !== artifactId) throw new Error('Retrieval executing artifact changed during preparation');
        if (state.candidateKey !== selectedKey) { state.candidateKey = selectedKey; state.candidate += 1; }
        state.candidateAdmission = Math.max(state.candidateAdmission, admission);
        const ticket = state.candidate;
        const assertCandidate = (): void => {
          signal?.throwIfAborted();
          pin.assertAvailable();
          if (state.candidate !== ticket) throw new Error('Retrieval plan preparation was superseded');
        };
        const assertSelection = async (): Promise<void> => {
          const current = await waitWithSignal(runtime.prepareService(request, prepareOptions), signal);
          const currentRouting = await waitWithSignal(runtime.routing.read(), signal);
          assertCandidate();
          if (!currentRouting.authoritative || currentRouting.document.revision !== routing.document.revision
            || current.providerId !== selected.providerId || runtime.supervisor.getActiveArtifactIdentity(provider) !== artifactId) {
            throw new Error('Retrieval plan selection changed during preparation');
          }
        };
        const acquireSemantic = async (declaration: Readonly<VarinRetrievalPlan>): Promise<RetrievalSemanticLease | undefined> => {
          if (declaration.semantic !== 'builtin' || !options.prepareSemantic) return undefined;
          const preparing = options.prepareSemantic(scope, signal);
          let acquired: RetrievalSemanticLease;
          try { acquired = await waitWithSignal(preparing, signal); }
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
          const declaration = parseVarinRetrievalPlan(await waitWithSignal(pin.invoke(VARIN_RETRIEVAL_PLAN_METHOD, [], signal), signal));
          await assertSelection();
          semantic = await acquireSemantic(declaration);
          const selection = Object.freeze({ providerId: selected.providerId, providerKey: selected.providerKey,
            artifactId, configurationId: declaration.configurationId, selectionRevision: routing.document.revision });
          // Unrelated routing edits do not change the effective immutable declaration identity.
          const identity = createHash('sha256').update(JSON.stringify({ providerId: selected.providerId,
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
                  state.current = { selectedKey, selection, declaration: Object.freeze({ ...declaration }) };
                } finally { publicationPin.release(); }
              };
              const publishing = { identity, result: publish() };
              state.publishing = publishing;
              void publishing.result.finally(() => { if (state.publishing === publishing) delete state.publishing; }).catch(() => {});
            }
            await waitWithSignal(state.publishing.result, signal);
          }
        } else {
          await assertSelection();
          semantic = await acquireSemantic(state.current.declaration);
        }
        assertCandidate();
        if (state.current?.selectedKey !== selectedKey || !state.owner) throw new Error('Retrieval plan preparation was superseded');
        const pipeline = state.owner.capture();
        const selection = state.current.selection;
        // Query resources never enter the shared publication. Each query captures and owns its
        // real backend/reader lease, including independently acquired refs for identical plans.
        const semanticStage = semantic?.stage;
        const stages = semanticStage ? Object.freeze(pipeline.plan.stages.map(stage => stage.kind === 'semantic'
          ? Object.freeze({ kind: 'semantic' as const, providerId: semanticStage.providerId,
            configurationId: semanticStage.configurationId, status: semanticStage.status }) : stage)) : pipeline.plan.stages;
        const metadata = semantic ? Object.freeze({ ...semantic.metadata,
          ...(semantic.metadata.credential ? { credential: Object.freeze({ ...semantic.metadata.credential }) } : {}) }) : undefined;
        const id = metadata ? createHash('sha256').update(JSON.stringify([pipeline.plan.id, stages, metadata])).digest('hex') : pipeline.plan.id;
        const implementation = semanticStage?.status === 'ready' ? semanticStage.implementation : undefined;
        const lease = semantic;
        let released = false;
        const assertAvailable = (): void => {
          if (released) throw new Error('Retrieval query binding was released');
          signal?.throwIfAborted();
          pin.assertAvailable();
          lease?.assertAvailable();
        };
        return Object.freeze({ ...pipeline,
          ...(implementation ? { semantic: Object.freeze({ search: implementation.search.bind(implementation) }) } : {}),
          plan: Object.freeze({ ...pipeline.plan, id, stages, selection, ...(metadata ? { semantic: metadata } : {}) }), selection,
          assertAvailable,
          validateAvailable: async (validationSignal?: AbortSignal) => {
            assertAvailable(); validationSignal?.throwIfAborted();
            await lease?.validateAvailable(validationSignal ?? signal);
            assertAvailable(); validationSignal?.throwIfAborted();
          },
          ...(lease?.inferenceReceipts ? { inferenceReceipts: () => lease.inferenceReceipts!() } : {}),
          release: () => { if (released) return; released = true; try { lease?.release(); } finally { pin.release(); } },
        });
      } catch (error) { try { semantic?.release(); } finally { pin.release(); } throw error; }
    },
  };
}
