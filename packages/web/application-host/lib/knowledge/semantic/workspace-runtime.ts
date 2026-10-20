import { createKnowledgeInference } from '../vectors/inference.js';
import type { KernelClient } from '../../kernel/kernel-client.js';
import type { LocalInferenceLease } from './local-inference.js';
import { resolveScopedIndexRoots } from '../index-scope.js';
import { createHash } from 'node:crypto';
import { createRemoteEmbedder } from './remote-embedder.js';
import { DEFAULT_SEMANTIC_RECALL } from '../../harness/explore.js';
import { SemanticInferenceError, type createSemanticInference, type SemanticInferenceLease, type SemanticInferenceDescription } from './runtime-inference.js';
import type { RetrievalSemanticLease } from '../../kernel/retrieval-composition.js';
import path from 'node:path';
import { FAST_DECISION_PURPOSES } from '@varin/protocol';
import type { HarnessInferenceBindingSnapshot } from '@varin/protocol';
import type { AgentSettingsSnapshot } from '@varin/application-client';
import type { DocumentAuthority, DocumentMutationObservation } from '../../documents/authority.js';
import { createSemanticBackend } from './backend.js';
import type { SemanticEmbedder } from './embedder.js';
import { isAbortError, waitWithSignal } from '../../cancellation.js';
import { workspaceScope, defaultRecipeIdentity, recipeIdOf, spaceIdOf } from './identity.js';
import type { InferenceCall } from './inference-requests.js';
import type { SemanticSourceView } from './query-view.js';
import { createSemanticIndexRuntime, resolveSemanticScanRoots, type SemanticIndexRuntimeOptions, type SemanticScanOptions } from './runtime.js';
import { isBotScopeId, isThreadScopeId } from '../../harness/owner-scope.js';

type PathMutation = Pick<DocumentMutationObservation, 'workspaceId' | 'resourceId' | 'kind'>;

/**
 * Embedding/rerank/fast-decision bindings live in global configuration and are
 * resolved through `configCwd`; which resource root is being indexed is a
 * separate concern. Bot, session, and user knowledge scopes own no document
 * workspace, so they share this internal state: it keeps the same watch and
 * binding-refresh lifecycle but never inspects a root or scans files.
 */
export const GLOBAL_INFERENCE_SCOPE = 'inference:global';
const inferenceScopeId = (scopeId: string): string => (
  isBotScopeId(scopeId) || isThreadScopeId(scopeId) || scopeId === 'user' ? GLOBAL_INFERENCE_SCOPE : scopeId
);

export interface WorkspaceSemanticRuntimeOptions extends Omit<SemanticIndexRuntimeOptions, 'getEmbedder' | 'documents'> {
  /** Override the quiet first/retry interval in hosts that need different pacing. */
  reconcileMinimumIntervalMs?: number;
  documents: Pick<DocumentAuthority, 'read' | 'inspectWorkspace' | 'watch'>;
  runtimeInference: ReturnType<typeof createSemanticInference>;
  kernel?: Pick<KernelClient, 'agentRuntimeRequest'>;
  onBindingChanged?: (workspaceId: string) => void;
}

type QueryInferenceSelection = { kind: 'http'; lease: SemanticInferenceLease } | { kind: 'local_component'; lease: LocalInferenceLease };
type WorkspaceState = {
  workspaceId: string;
  root: string;
  indexingEnabled: boolean;
  backend: ReturnType<typeof createSemanticBackend>;
  runtime: ReturnType<typeof createSemanticIndexRuntime>;
  binding: HarnessInferenceBindingSnapshot;
  snapshot: AgentSettingsSnapshot | null;
  bindingKey: string;
  needsRefresh: boolean;
  refreshTail: Promise<void>;
  documentWatch: { ready: Promise<boolean>; close(): void } | null;
  documentWatchReady: boolean;
  documentWatchPreparation?: Promise<boolean>;
  queryInference?: QueryInferenceSelection;
  retrievalBindingState?: SemanticInferenceDescription['status'];
};

// Reconcile each active root only after a quiet first minute. Later intervals
// scale with the previous scan so inventory work stays near 1% of wall time.
const RECONCILE_MINIMUM_INTERVAL_MS = 60_000;
const RECONCILE_DUTY_FRACTION = 0.01;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The production owner of workspace settings, inference transport and query views. */
export function createWorkspaceSemanticRuntime(options: WorkspaceSemanticRuntimeOptions) {
  const selectedRoots = (root: string) => {
    const scope = options.getIndexScope?.();
    return scope ? resolveScopedIndexRoots(root, scope) : resolveSemanticScanRoots(root, options.indexDirectories);
  };
  const knowledgeInference = options.kernel ? createKnowledgeInference({ kernel: options.kernel, inference: options.runtimeInference }) : undefined;
  let localEmbedder = options.embedder;
  // Active and draining generations have explicit query/scan/worker pins. Retired
  // generations leave this shutdown-owner set after their actual work drains.
  const localEmbedders = new Set([localEmbedder]);
  const states = new Map<string, WorkspaceState>();
  const retiringStates = new Map<string, WorkspaceState>();
  const loads = new Map<string, Promise<WorkspaceState>>();
  const maintenance = new Map<string, Promise<unknown>>();
  const pending = new Set<Promise<unknown>>();
  const retrievalQueries = new Set<object>();
  let epoch = 0;
  let disposed = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconcileDueAt = 0;
  let reconcileCursor = 0;
  let reconcileRunning = false;
  let reconcilingWorkspaceId: string | null = null;
  const reconcileMinimumIntervalMs = typeof options.reconcileMinimumIntervalMs === 'number'
    && Number.isFinite(options.reconcileMinimumIntervalMs)
    && options.reconcileMinimumIntervalMs > 0
    ? options.reconcileMinimumIntervalMs
    : RECONCILE_MINIMUM_INTERVAL_MS;
  const report = (error: unknown): void => {
    if (disposed || isAbortError(error)) return;
    try { options.onError?.(error); } catch { /* observation only */ }
  };
  const track = (task: Promise<unknown>): void => {
    pending.add(task);
    void task.catch(report).finally(() => pending.delete(task));
  };
  const armReconcileTimer = (): void => {
    if (disposed || reconcileTimer || reconcileRunning || states.size === 0) return;
    const remaining = Math.max(0, reconcileDueAt - Date.now());
    // Node clamps larger timeouts to a near-immediate callback. Re-arm in
    // platform-sized pieces without imposing a cap on the intended interval.
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      if (disposed) return;
      if (reconcileDueAt - Date.now() > 0) {
        armReconcileTimer();
        return;
      }
      track(reconcileNextRoot());
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  const scheduleReconcile = (delayMs = reconcileMinimumIntervalMs): void => {
    if (disposed || !options.searchFilesystemFiles || reconcileTimer || reconcileRunning || states.size === 0) return;
    reconcileDueAt = Date.now() + Math.max(0, delayMs);
    armReconcileTimer();
  };
  const reconcileNextRoot = async (): Promise<void> => {
    if (disposed || states.size === 0) return;
    reconcileRunning = true;
    const workspaceIds = [...states.values()].filter((state) => state.indexingEnabled).map((state) => state.workspaceId);
    if (workspaceIds.length === 0) { reconcileRunning = false; return; }
    const workspaceId = workspaceIds[reconcileCursor % workspaceIds.length]!;
    reconcileCursor = (reconcileCursor + 1) % workspaceIds.length;
    const state = states.get(workspaceId);
    if (!state) {
      reconcileRunning = false;
      scheduleReconcile();
      return;
    }
    const startedAt = performance.now();
    reconcilingWorkspaceId = workspaceId;
    try {
      // scanWorkspace's default is metadata-only. Its per-scope in-flight map
      // also joins an initial or mutation-triggered scan already in progress.
      await state.runtime.scanWorkspace(workspaceId);
    } finally {
      if (reconcilingWorkspaceId === workspaceId) reconcilingWorkspaceId = null;
      reconcileRunning = false;
      if (!disposed) {
        const elapsedMs = Math.max(0, performance.now() - startedAt);
        const quietMs = elapsedMs * (1 - RECONCILE_DUTY_FRACTION) / RECONCILE_DUTY_FRACTION;
        scheduleReconcile(Math.max(reconcileMinimumIntervalMs, quietMs));
      }
    }
  };
  const assertActive = (): void => {
    if (disposed) throw new Error('Workspace semantic runtime is closed');
  };
  const markUnavailable = (state: WorkspaceState): void => {
    state.needsRefresh = true;
    state.snapshot = null;
    state.binding = {
      embedding: { status: 'unavailable' },
      rerank: { status: 'unavailable' },
      fastDecision: {
        purposes: Object.fromEntries(FAST_DECISION_PURPOSES.map((purpose) => [
          purpose,
          { status: 'unavailable' as const },
        ])),
      },
    };
    state.backend.unavailable(new Error('Native inference binding is unavailable'));
    state.runtime.cancelScans();
  };
  const refreshNow = async (state: WorkspaceState, scanWhenChanged: boolean): Promise<void> => {
    if (disposed) return;
const startedEpoch = epoch;
const selectedLocal = localEmbedder;
let candidate: QueryInferenceSelection | undefined;
try {
        const settings = await options.runtimeInference.readGlobalSettings();
        const snapshot: AgentSettingsSnapshot = { global: settings as AgentSettingsSnapshot['global'],
          globalRevision: createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
          project: {}, projectRevision: '', projectTrusted: false };
        const described = await options.runtimeInference.describe();
        if (described.status === 'ready') candidate = { kind: 'http', lease: await options.runtimeInference.capture() };
        else if (described.status === 'unconfigured' && selectedLocal.status === 'ready' && selectedLocal.localExecution) {
          candidate = { kind: 'local_component', lease: await options.runtimeInference.captureLocal(selectedLocal) };
        }
        // Both capture paths are asynchronous. A completed candidate may publish only to
        // its original workspace and component generation, including shutdown/replacement races.
        if (disposed || startedEpoch !== epoch || states.get(state.workspaceId) !== state || selectedLocal !== localEmbedder) {
          candidate?.lease.release(); return;
        }
        const key = candidate?.kind === 'http' ? JSON.stringify([candidate.lease.binding, candidate.lease.identity.credentialScope])
          : candidate?.kind === 'local_component' ? JSON.stringify(candidate.lease.identity) : described.status;
        const changed = key !== state.bindingKey;
        state.snapshot = snapshot;
        state.needsRefresh = described.status === 'unavailable';
        state.retrievalBindingState = described.status;
        if (candidate?.kind === 'http') {
          state.binding.embedding = { status: 'ready', binding: candidate.lease.binding };
          if (changed || !state.queryInference) {
            const retained = candidate.lease;
            state.backend.bindRetained(createRemoteEmbedder({ binding: retained.binding,
              client: { embed: async params => {
                const call = retained.retain();
                try { return await call.embed({ ...params, operationIdentity: {
                  kind: 'index-build', hostId: options.hostId, workspaceId: state.workspaceId,
                  recipeId: recipeIdOf(defaultRecipeIdentity()), stage: 'document-embedding',
                } }); } finally { call.release(); }
              } } }));
          }
        } else {
          state.binding.embedding = { status: described.status === 'disabled' || described.status === 'ready' ? 'unavailable' : described.status,
            ...(described.status === 'ready' ? {} : { message: described.reason }) };
          // The HTTP DTO remains unconfigured for index status consumers.
          if (described.status === 'unconfigured') state.backend.bind(undefined);
          else state.backend.unavailable(new Error('Selected Host embedding binding is unavailable'));
        }
        if (changed || !state.queryInference) {
          const previous = state.queryInference;
          if (candidate) state.queryInference = candidate;
          else delete state.queryInference;
          candidate = undefined;
          previous?.lease.release();
        }
        candidate?.lease.release(); candidate = undefined;
        state.bindingKey = key;
        if (changed) {
          state.runtime.cancelScans();
          try { options.onBindingChanged?.(state.workspaceId); } catch (error) { report(error); }
          if (state.indexingEnabled && scanWhenChanged) track(state.runtime.scanWorkspace(state.workspaceId));
        }
      } catch (error) {
        candidate?.lease.release();
        if (disposed || startedEpoch !== epoch || states.get(state.workspaceId) !== state || selectedLocal !== localEmbedder) return;
        state.needsRefresh = true;
        state.retrievalBindingState = error instanceof SemanticInferenceError ? error.status
          : error && typeof error === 'object' && 'code' in error && error.code === 'inference-settings-invalid' ? 'invalid' : 'unavailable';
        state.bindingKey = '';
        state.binding.embedding = { status: 'unavailable', message: 'Host embedding configuration is unavailable' };
        state.backend.unavailable(new Error('Host embedding configuration is unavailable'));
        state.runtime.cancelScans();
        state.queryInference?.lease.release(); delete state.queryInference;
      }
return;
  };
  const refresh = (state: WorkspaceState, scanWhenChanged = false): Promise<void> => {
    const task = state.refreshTail.then(() => refreshNow(state, scanWhenChanged));
    state.refreshTail = task.then(() => undefined, () => undefined);
    return task;
  };
  const prepareDocumentWatch = async (state: WorkspaceState, reconcileOnRecovery: boolean): Promise<boolean> => {
    const selected = await selectedRoots(state.root);
    // A resource root can be a drive or home directory. Do not recursively
    // watch that ancestor merely because a selected project lives below it.
    if (!selected.some((directory) => path.relative(state.root, directory) === '')) {
      state.documentWatch?.close();
      state.documentWatch = null;
      state.documentWatchReady = false;
      return false;
    }
    if (state.documentWatchReady && state.documentWatch) return true;
    state.documentWatch?.close();
    state.documentWatch = null;
    const wasReady = state.documentWatchReady;
    try {
      const documentWatch = options.documents.watch(state.workspaceId, (event) => {
        if (event.kind === 'reset' || event.kind === 'invalidated') {
          // A lost notification requires a new inventory, not a read of every
          // unchanged body. Persisted hints select changed files; query hits
          // still verify their content revision through Documents.
          track(state.runtime.scanWorkspace(state.workspaceId));
          return;
        }
        const resource = event.resource;
        if (!resource || resource.workspaceId !== state.workspaceId) return;
        state.runtime.observeDocumentMutation({
          workspaceId: state.workspaceId,
          resourceId: resource.resourceId,
          kind: event.kind === 'deleted' ? 'deleted' : 'modified',
        });
      });
      state.documentWatch = documentWatch;
      const ready = await documentWatch.ready;
      if (disposed || state.documentWatch !== documentWatch) {
        documentWatch.close();
        return false;
      }
      state.documentWatchReady = ready;
      if (!state.documentWatchReady) {
        documentWatch.close();
        state.documentWatch = null;
        return false;
      }
      // A root that was temporarily unavailable needs one reconciliation when
      // it becomes observable again; a successful retry is not a baseline.
      if (reconcileOnRecovery && !wasReady) track(state.runtime.scanWorkspace(state.workspaceId));
      return true;
    } catch {
      state.documentWatch?.close();
      state.documentWatch = null;
      state.documentWatchReady = false;
      return false;
    }
  };
  const ensureDocumentWatch = (state: WorkspaceState, reconcileOnRecovery: boolean): Promise<boolean> => {
    if (state.documentWatchPreparation) return state.documentWatchPreparation;
    const task = prepareDocumentWatch(state, reconcileOnRecovery).finally(() => {
      if (state.documentWatchPreparation === task) delete state.documentWatchPreparation;
    });
    state.documentWatchPreparation = task;
    return task;
  };
  const getWorkspace = async (workspaceId: string, autoScan = true, queryOnly = false, configurationRoot?: string): Promise<WorkspaceState> => {
    await maintenance.get(workspaceId);
    assertActive();
    if (retiringStates.has(workspaceId)) throw new Error('Semantic index cleanup needs to be retried');
    const loading = loads.get(workspaceId);
    if (loading) return loading;
    const existing = states.get(workspaceId);
    if (existing) {
      if (configurationRoot === undefined) existing.indexingEnabled = workspaceId !== GLOBAL_INFERENCE_SCOPE
        && (await selectedRoots(existing.root)).length > 0;
      if (existing.indexingEnabled && !queryOnly) track(ensureDocumentWatch(existing, true));
      // Also wait for a refresh already queued by config.changed.
      await refresh(existing, autoScan);
      assertActive();
      return existing;
    }
    const task = (async () => {
      // Resolve the resource root so missing/unavailable directories fail here,
      // not inside an inference or scan task. The shared inference state has no
      // resource root at all — bindings resolve global configuration only.
      const inspected = configurationRoot !== undefined ? { root: configurationRoot } : workspaceId === GLOBAL_INFERENCE_SCOPE
        ? { root: '' }
        : await options.documents.inspectWorkspace(workspaceId);
      const indexingEnabled = configurationRoot === undefined && workspaceId !== GLOBAL_INFERENCE_SCOPE
        && (await selectedRoots(inspected.root)).length > 0;
      assertActive();
      const backend = createSemanticBackend({ local: localEmbedder });
      const runtime = createSemanticIndexRuntime({ ...options, getEmbedder: () => backend.embedder });
      const state: WorkspaceState = {
        workspaceId, root: inspected.root, indexingEnabled, backend, runtime,
        binding: {
          embedding: { status: 'unconfigured' },
          rerank: { status: 'unconfigured' },
          fastDecision: {
            purposes: Object.fromEntries(FAST_DECISION_PURPOSES.map((purpose) => [
              purpose,
              { status: 'unconfigured' as const },
            ])),
          },
        },
        snapshot: null, bindingKey: '', needsRefresh: true, refreshTail: Promise.resolve(),
        documentWatch: null, documentWatchReady: false,
      };
      // Never let a query run against the local backend before settings resolve.
      markUnavailable(state);
      states.set(workspaceId, state);
      if (!queryOnly) scheduleReconcile();
      // Watch startup can enumerate a large tree. Keep it off foreground query
      // admission; hits remain partial until it is ready, then reconcile once.
      if (indexingEnabled && !queryOnly) track(ensureDocumentWatch(state, true));
      await refresh(state);
      if (autoScan && indexingEnabled && !disposed) track(runtime.scanWorkspace(workspaceId));
      await state.refreshTail;
      assertActive();
      return state;
    })();
    loads.set(workspaceId, task);
    try { return await task; } finally { if (loads.get(workspaceId) === task) loads.delete(workspaceId); }
  };
  const acquireQuery = async (input: {
    workspaceId: string;
    inference: InferenceCall;
    /** Synchronous Run-owner fence after asynchronous credential/source checks. */
    assertAuthorized(): void;
    roots: readonly string[];
    signal?: AbortSignal;
    authorize(signal: AbortSignal): Promise<void>;
    sourceView?: SemanticSourceView;
  }): Promise<RetrievalSemanticLease> => {
    if (!options.runtimeInference) throw new Error('Native semantic inference owner is unavailable');
    const cacheWorkspaceId = input.sourceView ? input.sourceView.cacheWorkspaceId : input.workspaceId;
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    // This admission only refreshes cheap configuration bindings. It neither
    // enrolls a folder nor starts or waits for its background index build.
    const state = await waitWithSignal(getWorkspace(cacheWorkspaceId, false, true, input.sourceView?.configurationRoot), signal);
    const current = state.queryInference;
    if (!current) {
      return {
        stage: { providerId: 'varin.semantic', configurationId: 'semantic-v1', status: 'unavailable' },
        metadata: { bindingState: state.retrievalBindingState ?? 'unavailable',
          providerId: null, modelId: null, configurationId: null,
          spaceId: null, recipeId: null, publishedRevision: null, processEpoch: null, coverage: 'empty', lifecycle: 'idle' },
        assertAvailable: () => { signal.throwIfAborted(); assertActive(); input.assertAuthorized(); },
        validateAvailable: async () => { signal.throwIfAborted(); assertActive(); await input.authorize(signal); },
        release: () => {},
      };
    }
    const selection: QueryInferenceSelection = current.kind === 'http'
      ? { kind: 'http', lease: current.lease.retain() } : { kind: 'local_component', lease: current.lease.retain() };
    const selectedInference = selection.lease;
    const identity = selection.kind === 'http'
      ? { providerId: selection.lease.binding.providerId, modelId: selection.lease.binding.modelId,
        configurationId: selection.lease.binding.configurationId, cacheAuthority: JSON.stringify(selection.lease.identity.credentialScope),
        credential: { ...selection.lease.identity.credentialScope } }
      : { providerId: selection.lease.space.provider, modelId: selection.lease.space.model,
        configurationId: selection.lease.space.configurationId, cacheAuthority: JSON.stringify(selection.lease.identity) };
    const queryHandle = {};
    retrievalQueries.add(queryHandle);
    let released = false;
    let pinned: Awaited<ReturnType<typeof state.runtime.acquirePublishedQuery>> | undefined;
    const assertAvailable = (): void => {
      signal.throwIfAborted(); assertActive(); input.assertAuthorized();
      if (released || states.get(cacheWorkspaceId) !== state || maintenance.has(cacheWorkspaceId)) {
        throw new Error('Native semantic source lease is unavailable');
      }
      pinned?.assertAvailable();
    };
    const validateAvailable = async (active: AbortSignal = signal): Promise<void> => {
      active.throwIfAborted(); assertAvailable();
      await input.authorize(active);
      await selectedInference.assertAvailable(active);
      active.throwIfAborted(); assertAvailable();
    };
    const knownDimensions = state.backend.embedder.space.dim;
    const makeQueryEmbedder = (cached?: number[], documents?: readonly { path: string; revision: string }[]): SemanticEmbedder => selection.kind === 'local_component'
      ? selection.lease.queryEmbedder(input.inference, { guard: active => validateAvailable(active), ...(cached ? { cached } : {}),
        ...(documents ? { beforeDispatch: (active: AbortSignal) => input.sourceView!.validateDocuments(documents, active) } : {}) })
      : createRemoteEmbedder({ binding: selection.lease.binding,
      knownDimensions: pinnedEmbedder?.space.dim || knownDimensions,
      client: { embed: params => selection.lease.consume(input.inference, { ...params,
        ...(cached ? { cachedResult: { batchId: params.batchId,
          space: { providerId: params.providerId, modelId: params.modelId, protocol: params.protocol,
            configurationId: params.configurationId, maxTokens: params.maxTokens, dim: cached.length,
            spaceId: spaceIdOf(pinnedEmbedder!.space) },
          items: params.items.map((item, index) => ({ id: item.id, index, vector: cached })),
        } } : {}),
        guard: () => validateAvailable(params.signal ?? signal),
        ...(documents ? { beforeDispatch: (active: AbortSignal) => input.sourceView!.validateDocuments(documents, active) } : {}),
      }) } });
    let pinnedEmbedder: SemanticEmbedder | undefined;
    const embedder = pinnedEmbedder = makeQueryEmbedder();
    try {
      pinned = await state.runtime.acquirePublishedQuery(workspaceScope(cacheWorkspaceId), {
        embedder, roots: input.roots, signal, cacheAuthority: identity.cacheAuthority,
        ...(input.sourceView ? { sourceView: input.sourceView,
          documentVectors: async (texts: readonly string[], documents: readonly { path: string; revision: string }[], active: AbortSignal) => {
            const documentEmbedder = makeQueryEmbedder(undefined, documents);
            const vectors = await documentEmbedder.embed(texts, { purpose: 'document', signal: active });
            await validateAvailable(active);
            Object.assign(embedder.space, documentEmbedder.space);
            // Remember a dimension learned from real source work in the same
            // current backend; this is not a paid preparation probe.
            if (state.queryInference === current && state.backend.embedder.space.dim === 0) {
              Object.assign(state.backend.embedder.space, documentEmbedder.space);
            }
            return vectors;
          } } : {}),
        queryVector: async (question, cached, active) => {
          const [vector] = await makeQueryEmbedder(cached).embed([question], { purpose: 'query', signal: active });
          if (!vector) throw new Error('Native query embedding is missing');
          return vector;
        },
        assertAvailable: () => {
          signal.throwIfAborted(); assertActive(); input.assertAuthorized();
          if (released || states.get(cacheWorkspaceId) !== state || maintenance.has(cacheWorkspaceId)) {
            throw new Error('Native semantic source lease is unavailable');
          }
        },
        authorize: async active => {
          await input.authorize(active); await selectedInference.assertAvailable(active);
        },
      });
      await validateAvailable();
      const reader = pinned.reader;
      const selected = pinned;
      return {
        stage: { providerId: 'varin.semantic', configurationId: identity.configurationId, status: 'ready',
          implementation: { search: async (question, limit, active) => {
            const response = await selected.search(question, limit ?? DEFAULT_SEMANTIC_RECALL, active);
            const watchUnavailable = !input.sourceView && !state.documentWatchReady;
            return { status: watchUnavailable && ['ready', 'empty'].includes(response.status.status) ? 'incomplete' : response.status.status,
              coverage: watchUnavailable && response.status.coverage === 'complete' ? 'partial' : response.status.coverage,
              lifecycle: response.status.lifecycle, ...(response.status.generation ? { generation: response.status.generation } : {}),
              ...(response.status.spaceId ? { spaceId: response.status.spaceId } : {}),
              scope: response.status.scope, hits: response.hits,
              gaps: watchUnavailable ? [...response.gaps, { path: '.', reason: 'index-watch-unavailable' }] : response.gaps };
          } } },
        metadata: { bindingState: 'ready', coverage: pinned.status.coverage, lifecycle: pinned.status.lifecycle,
          providerId: identity.providerId, modelId: identity.modelId,
          configurationId: identity.configurationId, spaceId: reader?.checkpoint.spaceId ?? null,
          recipeId: reader?.checkpoint.recipeId ?? null, publishedRevision: reader?.publicationId ?? null,
          processEpoch: reader?.ownerEpoch ?? null, ...('credential' in identity ? { credential: identity.credential } : {}) },
        assertAvailable,
        validateAvailable,
        release: () => {
          if (released) return;
          released = true;
          retrievalQueries.delete(queryHandle);
          selectedInference.release();
          track(selected.release());
        },
      };
    } catch (error) {
      released = true; retrievalQueries.delete(queryHandle); selectedInference.release();
      if (pinned) await pinned.release();
      throw error;
    }
  };
  const observeDocumentMutation = (event: PathMutation): void => {
    if (disposed) return;
    const state = states.get(event.workspaceId);
    // Mark stale vectors synchronously whenever this workspace is already open.
    if (state && !state.indexingEnabled) return;
    if (state && !loads.has(event.workspaceId) && !state.needsRefresh) state.runtime.observeDocumentMutation(event);
    else track(getWorkspace(event.workspaceId).then((ready) => {
      if (ready.indexingEnabled) ready.runtime.observeDocumentMutation(event);
    }));
  };
  const observeToolWrite = async (workspaceId: string, absolutePath: string): Promise<void> => {
    const { root } = await options.documents.inspectWorkspace(workspaceId);
    const relative = path.relative(root, absolutePath);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    const resourceId = relative.split(path.sep).join('/');
    // A successful native write is observed before its journal response. Mask
    // old vectors now; backend setup and embedding stay off the tool response.
    observeDocumentMutation({ workspaceId, resourceId, kind: 'modified' });
  };
  return {
    queryStats: async () => {
      const values = await Promise.all([...states.values()].map(state => state.runtime.publishedReaderStats()));
      return { activeQueries: retrievalQueries.size, ...values.reduce((total, value) => ({
        activeReaders: total.activeReaders + value.activeReaders,
        retainedPublications: total.retainedPublications + value.retainedPublications,
      }), { activeReaders: 0, retainedPublications: 0 }) };
    },
    acquireQuery, observeDocumentMutation, observeToolWrite,
    refreshIndexScope: async () => {
      for (const state of states.values()) {
        if (state.workspaceId === GLOBAL_INFERENCE_SCOPE) continue;
        state.runtime.cancelScans();
        state.indexingEnabled = (await selectedRoots(state.root)).length > 0;
        if (state.indexingEnabled) {
          await ensureDocumentWatch(state, false);
          track(state.runtime.scanWorkspace(state.workspaceId));
        } else {
          state.documentWatch?.close();
          state.documentWatch = null;
          state.documentWatchReady = false;
        }
      }
      scheduleReconcile();
    },
    indexStatuses: () => [...states.values()]
      .filter((state) => state.workspaceId !== GLOBAL_INFERENCE_SCOPE)
      .map((state) => ({
      workspaceId: state.workspaceId,
      root: state.root,
      indexingEnabled: state.indexingEnabled,
      binding: state.binding.embedding.status,
      status: state.runtime.statusFor(workspaceScope(state.workspaceId)),
      progress: state.runtime.scanProgress(workspaceScope(state.workspaceId)),
    })),
    scanWorkspace: async (workspaceId: string, scanOptions?: SemanticScanOptions) => {
      const state = await getWorkspace(workspaceId, false);
      const queryScope = options.getIndexScope?.();
      const manualAllowed = scanOptions?.manual && queryScope && (await resolveScopedIndexRoots(state.root, queryScope, true)).length > 0;
      if (state.indexingEnabled || manualAllowed) await state.runtime.scanWorkspace(workspaceId, scanOptions);
    },
    withIndexMaintenance: async <T>(workspaceId: string, work: () => Promise<T>): Promise<T> => {
      const prior = maintenance.get(workspaceId);
      const task = (async () => {
        await prior?.catch(() => undefined);
        await loads.get(workspaceId)?.catch(() => undefined);
        const state = retiringStates.get(workspaceId) ?? states.get(workspaceId);
        states.delete(workspaceId);
        if (state) {
          retiringStates.set(workspaceId, state);
          state.documentWatch?.close();
          await state.refreshTail;
          await state.runtime.dispose({ discard: true });
          state.queryInference?.lease.release();
          retiringStates.delete(workspaceId);
        }
        return work();
      })();
      maintenance.set(workspaceId, task);
      try { return await task; }
      finally { if (maintenance.get(workspaceId) === task) maintenance.delete(workspaceId); }
    },
    refreshLocalSemantic: (next: SemanticEmbedder): void => {
      const previous = localEmbedder;
      if (previous === next) return;
      if (previous.localExecution && next.localExecution
        && JSON.stringify(previous.localExecution.identity) === JSON.stringify(next.localExecution.identity)) {
        // Reimporting the same verified bytes does not create a second model generation.
        track(next.dispose?.() ?? Promise.resolve()); return;
      }
      localEmbedders.add(next);
      localEmbedder = next;
      for (const state of states.values()) {
        state.backend.replaceLocal(next);
        state.needsRefresh = true;
        track(refresh(state));
        if (!state.indexingEnabled || state.backend.kind !== 'local') continue;
        state.runtime.cancelScans();
        track(state.runtime.scanWorkspace(state.workspaceId));
      }
      // Retired generations leave the owner set after their true pins/worker work drain.
      track((previous.retire?.() ?? previous.dispose?.() ?? Promise.resolve()).then(() => { localEmbedders.delete(previous); }));
    },
    resolveKnowledgeEmbedder: async (workspaceId: string, scopeId = workspaceId) => {
      const state = await getWorkspace(inferenceScopeId(workspaceId));
      if (state.binding.embedding.status === 'ready') {
        if (!knowledgeInference || state.queryInference?.kind !== 'http') return { status: 'unavailable' as const, message: 'Native Knowledge inference owner is unavailable' };
        return { status: 'ready' as const, embedder: await knowledgeInference.resolve(scopeId, state.queryInference.lease) };
      }
      if (state.binding.embedding.status === 'unconfigured') return { status: 'unconfigured' as const };
      return { status: state.binding.embedding.status === 'invalid' ? 'invalid' as const : 'unavailable' as const,
        ...(state.binding.embedding.message === undefined ? {} : { message: state.binding.embedding.message }) };
    },
    drain: async () => {
      while (pending.size > 0 || loads.size > 0) await Promise.allSettled([...pending, ...loads.values()]);
      await Promise.all([...states.values()].map((state) => state.runtime.drain()));
    },
    dispose: async () => {
      disposed = true;
      await knowledgeInference?.close();
      epoch++;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileTimer = null;
      const allStates = new Set([...states.values(), ...retiringStates.values()]);
      for (const state of allStates) {
        state.documentWatch?.close();
        state.queryInference?.lease.release(); delete state.queryInference;
      }
      // Shutdown owns all local workers. Start real termination before waiting for
      // scans/query callbacks whose aborted observers cannot stop native forward.
      const localShutdown = Promise.allSettled([...localEmbedders].map(embedder => embedder.dispose?.()));
      const closedStates = new Set<WorkspaceState>();
      const closeResults = await Promise.allSettled([...allStates].map(async state => {
        await state.runtime.dispose(); closedStates.add(state);
      }));
      await Promise.allSettled([...loads.values(), ...pending]);
      await Promise.allSettled([...allStates].map(async (state) => {
        await state.refreshTail;
      }));
      for (const [id, state] of states) {
        state.queryInference?.lease.release();
        if (closedStates.has(state)) states.delete(id);
      }
      for (const [id, state] of retiringStates) if (closedStates.has(state)) retiringStates.delete(id);
      await localShutdown;
      localEmbedders.clear();
      const failed = closeResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Semantic runtime shutdown failed');
    },
  };
}
