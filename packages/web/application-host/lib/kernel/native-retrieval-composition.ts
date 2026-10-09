import { createHash } from 'node:crypto';
import type { ApplicationExtensionRuntime } from '@varin/extension-host';
import { VARIN_BUILTIN_RETRIEVAL_DEFAULT_PROVIDER_KEY } from '@varin/extension-builtins';
import {
  parseVarinRetrievalPlan, VARIN_RETRIEVAL_PLAN_METHOD, VARIN_RETRIEVAL_PLAN_SERVICE_ID,
  VARIN_RETRIEVAL_PLAN_VERSION,
} from '@varin/extension-contract';
import { waitWithSignal } from '../cancellation.js';
import {
  createRetrievalPipelineOwner, type BoundRetrievalPipeline, type RetrievalPipelineConfiguration,
  type RetrievalPipelineOwner,
} from '../harness/retrieval-pipeline.js';

export interface NativeRetrievalCompositionScope {
  threadId: string;
  projectId?: string;
  /** The existing service-routing workspace identity is the canonical directory, not a native ID. */
  workspaceId?: string;
}
export interface NativeRetrievalSelection {
  readonly providerId: string;
  readonly providerKey: string;
  readonly artifactId: string;
  readonly configurationId: string;
  readonly selectionRevision: number;
}
export interface NativeRetrievalPipelineBinding extends BoundRetrievalPipeline {
  readonly selection: Readonly<NativeRetrievalSelection>;
  assertAvailable(): void;
  release(): void;
}
interface ScopeCache {
  requests: number;
  candidateAdmission: number;
  candidateKey?: string;
  candidate: number;
  owner?: RetrievalPipelineOwner;
  current?: { selectedKey: string; selection: Readonly<NativeRetrievalSelection> };
  publishing?: { identity: string; result: Promise<void> };
}

/** Resolve existing scoped routing, prepare an isolated declaration, then publish a frozen plan.
 * This cache owns no index, parser, configuration file, filesystem or model capability. Every
 * query retains its own real Host service generation pin until its caller releases the binding. */
export function createNativeRetrievalComposition(runtime: ApplicationExtensionRuntime, options: {
  structure?: NonNullable<RetrievalPipelineConfiguration['structure']>['implementation'];
}) {
  const scopes = new Map<string, ScopeCache>();
  return {
    async prepare(scope: NativeRetrievalCompositionScope, signal?: AbortSignal): Promise<NativeRetrievalPipelineBinding> {
      signal?.throwIfAborted();
      if (!scope.threadId.trim()) throw new Error('Native retrieval requires a Thread identity');
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
        if (state.current?.selectedKey !== selectedKey) {
          const declaration = parseVarinRetrievalPlan(await waitWithSignal(pin.invoke(VARIN_RETRIEVAL_PLAN_METHOD, [], signal), signal));
          await assertSelection();
          const selection = Object.freeze({ providerId: selected.providerId, providerKey: selected.providerKey,
            artifactId, configurationId: declaration.configurationId, selectionRevision: routing.document.revision });
          // Unrelated routing edits do not change the effective immutable declaration identity.
          const identity = createHash('sha256').update(JSON.stringify({ providerId: selected.providerId,
            providerKey: selected.providerKey, artifactId, declaration })).digest('hex');
          const configuration: RetrievalPipelineConfiguration = {
            configurationId: identity,
            structure: { providerId: declaration.structure === 'native' ? 'varin.kernel.structure' : 'none',
              configurationId: identity, status: declaration.structure === 'disabled' ? 'disabled' : options.structure ? 'ready' : 'unavailable',
              ...(declaration.structure === 'native' && options.structure ? { implementation: options.structure } : {}) },
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
                  state.current = { selectedKey, selection };
                } finally { publicationPin.release(); }
              };
              const publishing = { identity, result: publish() };
              state.publishing = publishing;
              void publishing.result.finally(() => { if (state.publishing === publishing) delete state.publishing; }).catch(() => {});
            }
            await waitWithSignal(state.publishing.result, signal);
          }
        } else await assertSelection();
        assertCandidate();
        if (state.current?.selectedKey !== selectedKey || !state.owner) throw new Error('Retrieval plan preparation was superseded');
        const pipeline = state.owner.capture();
        return Object.freeze({ ...pipeline, plan: Object.freeze({ ...pipeline.plan, selection: state.current.selection }), selection: state.current.selection,
          assertAvailable: () => pin.assertAvailable(), release: () => pin.release() });
      } catch (error) { pin.release(); throw error; }
    },
  };
}
