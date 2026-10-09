import { resolveScopedIndexRoots } from '../index-scope.js';
import { createHash } from 'node:crypto';
import { createRemoteEmbedder } from './remote-embedder.js';
import { DEFAULT_SEMANTIC_RECALL } from '../../harness/explore.js';
import { SemanticInferenceError, type createSemanticInference, type SemanticInferenceLease, type SemanticInferenceReceipt, type SemanticInferenceDescription } from './runtime-inference.js';
import type { RetrievalSemanticLease } from '../../kernel/retrieval-composition.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PiRuntimeBroker, PiRuntimeBrokerEvent } from '@varin/runtime-broker';
import { FAST_DECISION_PURPOSES } from '@varin/protocol';
import type { AgentInputContext, HarnessInferenceBindingSnapshot, PiSettingsSnapshot } from '@varin/protocol';
import type { DocumentAuthority, DocumentMutationObservation } from '../../documents/authority.js';
import type { HarnessServiceHost } from '../../harness/service-host.js';
import type { createWorkingBranchLookups } from '../../harness/working-state/working-branch-lookups.js';
import type { ThreadExecutionViewRegistry } from '../../harness/working-state/execution-view.js';
import { createSemanticBackend } from './backend.js';
import type { SemanticEmbedder } from './embedder.js';
import { isAbortError, waitWithSignal } from '../../cancellation.js';
import { workspaceScope, defaultRecipeIdentity, recipeIdOf, spaceIdOf } from './identity.js';
import type { RetrievalInvocation } from '../../kernel/protocol.generated.js';
import { pinSemanticQueryView, type SemanticDraftReadResult } from './query-view.js';
import { createSemanticIndexRuntime, resolveSemanticScanRoots, type SemanticIndexRuntimeOptions, type SemanticScanOptions } from './runtime.js';
import { requestWorkspaceInference, resolveInferenceBinding } from './workspace-inference.js';
import { isBotScopeId, isSessionScopeId } from '../../harness/owner-scope.js';

type InferenceBroker = Pick<PiRuntimeBroker, 'requestForWorkspace' | 'watchConfig' | 'unwatchConfig'>;
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
  isBotScopeId(scopeId) || isSessionScopeId(scopeId) || scopeId === 'user' ? GLOBAL_INFERENCE_SCOPE : scopeId
);

export interface WorkspaceSemanticRuntimeOptions extends Omit<SemanticIndexRuntimeOptions, 'getEmbedder' | 'documents'> {
  /** Override the quiet first/retry interval in hosts that need different pacing. */
  reconcileMinimumIntervalMs?: number;
  documents: Pick<DocumentAuthority, 'read' | 'inspectWorkspace' | 'watch' | 'agentInputDraftPaths' | 'readAgentInputSnapshot'>;
  readDraft?: (
    sessionId: string,
    inputContext: AgentInputContext,
    resourceId: string,
    workspaceId: string,
  ) => SemanticDraftReadResult | Promise<SemanticDraftReadResult>;
  getBroker(): InferenceBroker | null;
  /**
   * HR3: one shared worker directory for settings/inference transport. Harness
   * inference resolves global configuration only (project scope never feeds
   * embedding/rerank/fast-decision), so every resource root can reuse the same
   * worker instead of spawning a workspace worker per indexed directory.
   * Root cwd still owns document reads and scan addressing.
   */
  configCwd: string;
  /** Shared Host configuration/credential owner; never a Pi session or worker. */
  runtimeInference?: ReturnType<typeof createSemanticInference>;
  executionViews: Pick<ThreadExecutionViewRegistry, 'get'>;
  workingBranches: Pick<ReturnType<typeof createWorkingBranchLookups>, 'pinQuery'>;
  onBindingChanged?: (workspaceId: string) => void;
}

type WorkspaceState = {
  workspaceId: string;
  root: string;
  indexingEnabled: boolean;
  backend: ReturnType<typeof createSemanticBackend>;
  runtime: ReturnType<typeof createSemanticIndexRuntime>;
  binding: HarnessInferenceBindingSnapshot;
  snapshot: PiSettingsSnapshot | null;
  bindingKey: string;
  needsRefresh: boolean;
  refreshTail: Promise<void>;
  watches: Array<{ id: string; broker: InferenceBroker }>;
  watching: Promise<void> | null;
  documentWatch: { ready: Promise<boolean>; close(): void } | null;
  documentWatchReady: boolean;
  queryEmbedding?: SemanticInferenceLease;
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
  let localEmbedder = options.embedder;
  // Retained query bindings keep their model identity across component changes.
  // All local runtimes are released after workspace work closes at Host shutdown.
  const localEmbedders = new Set([localEmbedder]);
  const states = new Map<string, WorkspaceState>();
  const loads = new Map<string, Promise<WorkspaceState>>();
  const maintenance = new Map<string, Promise<unknown>>();
  const watchWorkspaces = new Map<string, string>();
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
  const unwatch = async (state: WorkspaceState): Promise<void> => {
    await Promise.allSettled(state.watches.splice(0).map(({ id, broker }) => {
      watchWorkspaces.delete(id);
      return broker.unwatchConfig(id);
    }));
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
    state.backend.unavailable(new Error('Pi workspace binding is unavailable'));
    state.runtime.cancelScans();
  };
  const refreshNow = async (state: WorkspaceState, scanWhenChanged: boolean): Promise<void> => {
    if (disposed) return;
    if (options.runtimeInference) {
      const startedEpoch = epoch;
      let candidate: SemanticInferenceLease | undefined;
      try {
        const settings = await options.runtimeInference.readGlobalSettings();
        state.snapshot = { global: settings as PiSettingsSnapshot['global'],
          globalRevision: createHash('sha256').update(JSON.stringify(settings)).digest('hex'),
          project: {}, projectRevision: '', projectTrusted: false };
        const described = await options.runtimeInference.describe();
        if (described.status === 'ready') candidate = await options.runtimeInference.capture();
        if (disposed || startedEpoch !== epoch || states.get(state.workspaceId) !== state) { candidate?.release(); return; }
        const key = candidate ? JSON.stringify([candidate.binding, candidate.identity.credentialScope]) : described.status;
        const changed = key !== state.bindingKey;
        state.needsRefresh = described.status === 'unavailable';
        state.retrievalBindingState = described.status;
        if (candidate) {
          state.binding.embedding = { status: 'ready', binding: candidate.binding };
          if (changed || !state.queryEmbedding) {
            const previous = state.queryEmbedding;
            state.queryEmbedding = candidate;
            const retained = candidate;
            state.backend.bindRetained(createRemoteEmbedder({ binding: retained.binding,
              client: { embed: async params => {
                // Retiring the selection releases only its owner reference.
                // A dispatched batch owns a separate handle until settlement.
                const call = retained.retain();
                try { return await call.embed({ ...params, operationIdentity: {
                  kind: 'index-build', hostId: options.hostId, workspaceId: state.workspaceId,
                  recipeId: recipeIdOf(defaultRecipeIdentity()), stage: 'document-embedding',
                } }); } finally { call.release(); }
              } } }));
            candidate = undefined;
            previous?.release();
          }
        } else {
          state.binding.embedding = { status: described.status === 'disabled' || described.status === 'ready' ? 'unavailable' : described.status,
            ...(described.status === 'ready' ? {} : { message: described.reason }) };
          state.queryEmbedding?.release(); delete state.queryEmbedding;
          // Existing Pi consumers retain their installed-local unconfigured
          // behavior. Native acquisition below requires an explicit remote lease.
          if (described.status === 'unconfigured') state.backend.bind(undefined);
          else state.backend.unavailable(new Error('Selected Host embedding binding is unavailable'));
        }
        candidate?.release();
        state.bindingKey = key;
        if (changed) {
          state.runtime.cancelScans();
          try { options.onBindingChanged?.(state.workspaceId); } catch (error) { report(error); }
          if (state.indexingEnabled && scanWhenChanged) track(state.runtime.scanWorkspace(state.workspaceId));
        }
      } catch (error) {
        candidate?.release();
        if (disposed || startedEpoch !== epoch) return;
        state.needsRefresh = true;
        state.retrievalBindingState = error instanceof SemanticInferenceError ? error.status
          : error && typeof error === 'object' && 'code' in error && error.code === 'inference-settings-invalid' ? 'invalid' : 'unavailable';
        state.bindingKey = '';
        state.binding.embedding = { status: 'unavailable', message: 'Host embedding configuration is unavailable' };
        state.backend.unavailable(new Error('Host embedding configuration is unavailable'));
        state.runtime.cancelScans();
        // Existing accepted query leases remain independent. A new query does
        // not fall back to the prior backend after a failed candidate.
        state.queryEmbedding?.release(); delete state.queryEmbedding;
      }
      return;
    }
    const retrying = state.needsRefresh && state.binding.embedding.status === 'unavailable';
    const startedEpoch = epoch;
    const broker = options.getBroker();
    if (!broker) { markUnavailable(state); return; }
    const [settings, binding] = await Promise.allSettled([
      broker.requestForWorkspace(options.configCwd, 'settings.get', {}),
      broker.requestForWorkspace(options.configCwd, 'harness.inference.describe', {}),
    ]);
    // A worker replacement cannot publish the old worker's settings as current.
    if (disposed || startedEpoch !== epoch || broker !== options.getBroker()) return;
    state.snapshot = settings.status === 'fulfilled' ? settings.value : null;
    state.needsRefresh = settings.status !== 'fulfilled' || binding.status !== 'fulfilled';
    const next = resolveInferenceBinding(settings, binding);
    // A describe response can succeed while a provider could not yet bind.
    // Do not cache that transient failure until the next settings edit.
    state.needsRefresh ||= next.embedding.status === 'unavailable' || next.rerank.status === 'unavailable'
      || Object.values(next.fastDecision?.purposes ?? {}).some(status => status.status === 'unavailable');
    const key = JSON.stringify(next.embedding);
    const changed = key !== state.bindingKey;
    state.binding = next;
    state.bindingKey = key;
    if (changed) state.runtime.cancelScans();
    if (next.embedding.status === 'ready') state.backend.bind(next.embedding.binding);
    else if (next.embedding.status === 'unconfigured') state.backend.bind(undefined);
    else state.backend.unavailable(new Error(next.embedding.message ?? 'Embedding binding is unavailable'));
    if (changed) {
      try { options.onBindingChanged?.(state.workspaceId); } catch (error) { report(error); }
    }
    if (state.indexingEnabled && scanWhenChanged && (changed || retrying)) track(state.runtime.scanWorkspace(state.workspaceId));
  };
  const refresh = (state: WorkspaceState, scanWhenChanged = false): Promise<void> => {
    const task = state.refreshTail.then(() => refreshNow(state, scanWhenChanged));
    state.refreshTail = task.then(() => undefined, () => undefined);
    return task;
  };
  const ensureDocumentWatch = async (state: WorkspaceState, reconcileOnRecovery: boolean): Promise<boolean> => {
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
        if (event.kind === 'reset') {
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
      state.documentWatchReady = await documentWatch.ready;
      if (disposed) {
        documentWatch.close();
        state.documentWatch = null;
        state.documentWatchReady = false;
        return false;
      }
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
  const watch = async (state: WorkspaceState): Promise<void> => {
    if (disposed || options.runtimeInference || state.watches.length > 0) return;
    if (state.watching) return state.watching;
    const broker = options.getBroker();
    if (!broker) return;
    const startedEpoch = epoch;
    // A new subscription follows a period without reliable notifications.
    // Read bindings again once it is registered, including on watch recovery.
    state.needsRefresh = true;
    state.watching = (async () => {
      const results = await Promise.allSettled([
        broker.watchConfig({ cwd: options.configCwd }, { kind: 'settings', scope: 'global' }),
        broker.watchConfig({ cwd: options.configCwd }, { kind: 'document', path: 'models.json', scope: 'global' }),
      ]);
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const id = result.value.watchId;
        if (disposed || startedEpoch !== epoch || broker !== options.getBroker()) {
          await broker.unwatchConfig(id).catch(report);
          continue;
        }
        state.watches.push({ id, broker });
        watchWorkspaces.set(id, state.workspaceId);
      }
      if (!disposed && state.watches.length !== results.length) {
        state.needsRefresh = true;
        await unwatch(state);
      }
    })();
    try { await state.watching; } finally { state.watching = null; }
  };
  const getWorkspace = async (workspaceId: string, autoScan = true, queryOnly = false): Promise<WorkspaceState> => {
    await maintenance.get(workspaceId);
    assertActive();
    const loading = loads.get(workspaceId);
    if (loading) return loading;
    const existing = states.get(workspaceId);
    if (existing) {
      existing.indexingEnabled = workspaceId !== GLOBAL_INFERENCE_SCOPE
        && (await selectedRoots(existing.root)).length > 0;
      if (existing.indexingEnabled && !queryOnly) await ensureDocumentWatch(existing, true);
      await watch(existing);
      // Also wait for a refresh already queued by config.changed.
      if (existing.needsRefresh || options.runtimeInference) await refresh(existing, autoScan);
      else await existing.refreshTail;
      assertActive();
      return existing;
    }
    const task = (async () => {
      // Resolve the resource root so missing/unavailable directories fail here,
      // not inside an inference or scan task. The shared inference state has no
      // resource root at all — bindings resolve global configuration only.
      const inspected = workspaceId === GLOBAL_INFERENCE_SCOPE
        ? { root: '' }
        : await options.documents.inspectWorkspace(workspaceId);
      const indexingEnabled = workspaceId !== GLOBAL_INFERENCE_SCOPE
        && (await selectedRoots(inspected.root)).length > 0;
      assertActive();
      const backend = createSemanticBackend({
        local: localEmbedder,
        embedClient: {
          embed: (params) => {
            const broker = options.getBroker();
            if (!broker) throw new Error('Pi workspace binding is unavailable');
            return requestWorkspaceInference(broker, options.configCwd, 'harness.embed', {
              purpose: params.purpose, providerId: params.providerId, modelId: params.modelId,
              protocol: 'openai-compatible', configurationId: params.configurationId,
              items: params.items, batchId: params.batchId, maxTokens: params.maxTokens,
              ...(params.dimensions === undefined ? {} : { dimensions: params.dimensions }),
            }, params.signal);
          },
        },
      });
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
        watches: [], watching: null, documentWatch: null, documentWatchReady: false,
      };
      // Never let a query run against the local backend before settings resolve.
      markUnavailable(state);
      states.set(workspaceId, state);
      if (!queryOnly) scheduleReconcile();
      // Subscribe before the first scan so writes during enumeration are either
      // observed incrementally or cause the scope to be reconciled.
      if (indexingEnabled && !queryOnly) await ensureDocumentWatch(state, false);
      // Register observation before reading settings, so changes made while a
      // watch is being created are included in the first binding snapshot.
      await watch(state);
      await refresh(state);
      if (autoScan && indexingEnabled && !disposed) track(runtime.scanWorkspace(workspaceId));
      await state.refreshTail;
      assertActive();
      return state;
    })();
    loads.set(workspaceId, task);
    try { return await task; } finally { if (loads.get(workspaceId) === task) loads.delete(workspaceId); }
  };

  const legacyEmbedderFor = (state: WorkspaceState): SemanticEmbedder | undefined => {
    if (!options.runtimeInference || state.binding.embedding.status !== 'ready') return undefined;
    return createRemoteEmbedder({ binding: state.binding.embedding.binding,
      knownDimensions: state.backend.embedder.space.dim, client: { embed: params => {
        const broker = options.getBroker();
        if (!broker) throw new Error('Pi workspace inference is unavailable');
        const { signal, ...request } = params;
        return requestWorkspaceInference(broker, options.configCwd, 'harness.embed', request, signal);
      } } });
  };
  const semanticRecall: NonNullable<HarnessServiceHost['semanticRecall']> = async (workspaceId, question, limit, searchOptions) => {
    searchOptions?.signal?.throwIfAborted();
    const state = await waitWithSignal(getWorkspace(workspaceId), searchOptions?.signal);
    const queryScope = options.getIndexScope?.();
    if (queryScope ? (await resolveScopedIndexRoots(state.root, queryScope, true)).length === 0 : !state.indexingEnabled) return {
      status: 'unavailable', coverage: 'empty', lifecycle: 'idle', hits: [],
      note: 'This resource root is outside the selected semantic index directories.',
    };
    const sessionId = searchOptions?.sessionId;
    const inputContext = searchOptions?.inputContext ?? { source: 'disk' as const };
    const execution = sessionId ? options.executionViews.get(sessionId) : undefined;
    const threadSnapshot = searchOptions?.threadDocuments || searchOptions?.threadQuery || execution?.mode !== 'virtual' || !sessionId
      ? undefined
      : await options.workingBranches.pinQuery(sessionId, {
          ...(searchOptions?.roots ? { roots: searchOptions.roots } : {}),
          ...(searchOptions?.signal ? { signal: searchOptions.signal } : {}),
        });
    try {
      const threadDocuments = searchOptions?.threadDocuments;
      const threadQuery = searchOptions?.threadQuery ?? threadSnapshot ?? undefined;
      if (execution?.mode === 'virtual' && !threadDocuments && !threadQuery) throw new Error('Working-branch query view is unavailable');
      const draftPaths = sessionId ? options.documents.agentInputDraftPaths(sessionId, inputContext, workspaceId)
        : inputContext.source === 'surface'
          ? inputContext.roots.find((root) => root.workspaceId === workspaceId)?.dirtyPaths ?? []
          : undefined;
      const view = await pinSemanticQueryView({
        inputContext,
        workspaceId,
        ...(draftPaths === undefined ? {} : { draftPaths }),
        ...(threadQuery ? { threadDocuments: [] } : threadDocuments ? { threadDocuments } : sessionId ? {
          readDraft: (resourceId: string) => options.readDraft
            ? options.readDraft(sessionId, inputContext, resourceId, workspaceId)
            : options.documents.readAgentInputSnapshot(sessionId, inputContext, resourceId, workspaceId),
        } : {}),
      });
      // Existing Pi callers retain their own query purpose/invocation transport.
      // They share this index and the neutral wire implementation, never a fake
      // native Run or a second workspace index. Native queries do not enter here.
      const legacyEmbedder = legacyEmbedderFor(state);
      const result = await state.runtime.search(workspaceScope(workspaceId), question, limit, {
        ...(legacyEmbedder ? { embedder: legacyEmbedder } : {}),
        ...(searchOptions?.signal ? { signal: searchOptions.signal } : {}),
        ...(searchOptions?.roots ? { roots: searchOptions.roots } : {}),
        ...(reconcilingWorkspaceId === workspaceId ? { waitForFirstPublish: false } : {}),
        overlays: view.overlays, view: view.view,
        ...(threadQuery ? { threadQuery } : {}),
      });
      const gaps = [...result.gaps];
      const status = { ...result.status };
      if (!state.documentWatchReady && !gaps.some((gap) => gap.reason === 'index-watch-unavailable')) {
        gaps.push({ path: '.', reason: 'index-watch-unavailable' as const });
        status.status = status.status === 'failed' || status.status === 'unavailable' ? status.status : 'incomplete';
        if (status.coverage === 'complete') status.coverage = 'partial';
      }
      return {
        status: status.status, coverage: status.coverage,
        ...(result.status.generation ? { generation: result.status.generation } : {}),
        ...(result.status.spaceId ? { spaceId: result.status.spaceId } : {}),
        scope: result.status.scope, lifecycle: result.status.lifecycle, hits: result.hits,
        ...(gaps.length > 0 ? { gaps } : {}),
        note: !state.documentWatchReady
          ? 'Filesystem watching is unavailable; changes and additions may be absent until periodic root reconciliation.'
          : gaps.some((gap) => gap.reason === 'content-changed')
            ? 'Changed indexed files were omitted and queued for reindexing. Periodic metadata reconciliation also discovers new files.'
            : 'Disk hit revisions are checked against Documents. Periodic root reconciliation discovers additions missed by filesystem observation.',
      };
    } finally {
      await threadSnapshot?.release();
    }
  };
  const acquireQuery = async (input: {
    workspaceId: string;
    threadId: string;
    runId: string;
    invocation: RetrievalInvocation;
    /** Synchronous Run-owner fence after asynchronous credential/source checks. */
    assertAuthorized(): void;
    roots: readonly string[];
    signal?: AbortSignal;
    authorize(signal: AbortSignal): Promise<void>;
  }): Promise<RetrievalSemanticLease> => {
    if (!options.runtimeInference) throw new Error('Native semantic inference owner is unavailable');
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    // This admission only refreshes cheap configuration bindings. It neither
    // enrolls a folder nor starts or waits for its background index build.
    const state = await waitWithSignal(getWorkspace(input.workspaceId, false, true), signal);
    const current = state.queryEmbedding;
    if (!current || state.binding.embedding.status !== 'ready') {
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
    const inference = current.retain();
    const queryHandle = {};
    retrievalQueries.add(queryHandle);
    const receipts: SemanticInferenceReceipt[] = [];
    let released = false;
    let pinned: Awaited<ReturnType<typeof state.runtime.acquirePublishedQuery>> | undefined;
    const assertAvailable = (): void => {
      signal.throwIfAborted(); assertActive(); input.assertAuthorized();
      if (released || states.get(input.workspaceId) !== state || maintenance.has(input.workspaceId)) {
        throw new Error('Native semantic source lease is unavailable');
      }
      pinned?.assertAvailable();
    };
    const validateAvailable = async (active: AbortSignal = signal): Promise<void> => {
      active.throwIfAborted(); assertAvailable();
      await input.authorize(active);
      await inference.assertAvailable(active);
      active.throwIfAborted(); assertAvailable();
    };
    const onReceipt = (receipt: SemanticInferenceReceipt): void => {
      const previous = receipts.findIndex(item => item.batchId === receipt.batchId);
      if (previous < 0) receipts.push(receipt); else receipts[previous] = receipt;
    };
    const knownDimensions = state.backend.embedder.space.dim;
    const knownSpaceId = spaceIdOf(state.backend.embedder.space);
    const makeQueryEmbedder = (cached?: number[]): SemanticEmbedder => createRemoteEmbedder({ binding: inference.binding,
      knownDimensions,
      client: { embed: params => inference.embed({ ...params, operationIdentity: {
          kind: 'retrieval-query', hostId: options.hostId, threadId: input.threadId, runId: input.runId,
          invocation: input.invocation, stage: 'code-retrieval.semantic.query-embedding',
        },
        ...(cached ? { cachedResult: { batchId: params.batchId,
          space: { providerId: params.providerId, modelId: params.modelId, protocol: params.protocol,
            configurationId: params.configurationId, maxTokens: params.maxTokens, dim: cached.length,
            spaceId: knownSpaceId },
          items: params.items.map((item, index) => ({ id: item.id, index, vector: cached })),
        } } : {}),
        guard: () => validateAvailable(params.signal ?? signal), onReceipt,
      }) } });
    const embedder = makeQueryEmbedder();
    try {
      pinned = await state.runtime.acquirePublishedQuery(workspaceScope(input.workspaceId), {
        embedder, roots: input.roots, signal,
        queryVector: async (question, cached, active) => {
          const [vector] = await makeQueryEmbedder(cached).embed([question], { purpose: 'query', signal: active });
          if (!vector) throw new Error('Native query embedding is missing');
          return vector;
        },
        assertAvailable: () => {
          signal.throwIfAborted(); assertActive(); input.assertAuthorized();
          if (released || states.get(input.workspaceId) !== state || maintenance.has(input.workspaceId)) {
            throw new Error('Native semantic source lease is unavailable');
          }
        },
        authorize: async active => {
          await input.authorize(active); await inference.assertAvailable(active);
        },
      });
      await validateAvailable();
      const reader = pinned.reader;
      const selected = pinned;
      return {
        stage: { providerId: 'varin.semantic', configurationId: inference.binding.configurationId, status: 'ready',
          implementation: { search: async (question, limit, active) => {
            const response = await selected.search(question, limit ?? DEFAULT_SEMANTIC_RECALL, active);
            const watchUnavailable = !state.documentWatchReady;
            return { status: watchUnavailable && ['ready', 'empty'].includes(response.status.status) ? 'incomplete' : response.status.status,
              coverage: watchUnavailable && response.status.coverage === 'complete' ? 'partial' : response.status.coverage,
              lifecycle: response.status.lifecycle, ...(response.status.generation ? { generation: response.status.generation } : {}),
              ...(response.status.spaceId ? { spaceId: response.status.spaceId } : {}),
              scope: response.status.scope, hits: response.hits,
              gaps: watchUnavailable ? [...response.gaps, { path: '.', reason: 'index-watch-unavailable' }] : response.gaps };
          } } },
        metadata: { bindingState: 'ready', coverage: pinned.status.coverage, lifecycle: pinned.status.lifecycle,
          providerId: inference.binding.providerId, modelId: inference.binding.modelId,
          configurationId: inference.binding.configurationId, spaceId: reader?.checkpoint.spaceId ?? null,
          recipeId: reader?.checkpoint.recipeId ?? null, publishedRevision: reader?.publicationId ?? null,
          processEpoch: reader?.ownerEpoch ?? null, credential: { ...inference.identity.credentialScope } },
        assertAvailable,
        validateAvailable,
        inferenceReceipts: () => receipts.map(receipt => structuredClone(receipt)),
        release: () => {
          if (released) return;
          released = true;
          retrievalQueries.delete(queryHandle);
          inference.release();
          track(selected.release());
        },
      };
    } catch (error) {
      released = true; retrievalQueries.delete(queryHandle); inference.release();
      if (pinned) await pinned.release();
      throw error;
    }
  };
  const refreshLegacyInference = async (state: WorkspaceState): Promise<void> => {
    if (!options.runtimeInference) return;
    const broker = options.getBroker();
    if (!broker) throw new Error('Legacy inference binding is unavailable');
    const binding = await broker.requestForWorkspace(options.configCwd, 'harness.inference.describe', {});
    state.binding.rerank = binding.rerank;
    if (binding.fastDecision) state.binding.fastDecision = binding.fastDecision;
    else delete state.binding.fastDecision;
  };
  const harnessSettings: NonNullable<HarnessServiceHost['harnessSettings']> = async (workspaceId) => (
    await getWorkspace(inferenceScopeId(workspaceId))
  ).snapshot;
  const rerankExploreViews: NonNullable<HarnessServiceHost['rerankExploreViews']> = async (input) => {
    input.signal?.throwIfAborted();
    const state = await waitWithSignal(getWorkspace(inferenceScopeId(input.workspaceId)), input.signal);
    await refreshLegacyInference(state);
    const broker = options.getBroker();
    if (!broker) throw new Error('Pi workspace binding is unavailable');
    const configured = state.binding.rerank.status === 'ready' ? state.binding.rerank.binding : undefined;
    if (!configured) throw new Error('Rerank is not configured');
    if (configured.protocol !== input.settings.protocol || configured.providerId !== input.settings.providerId
      || configured.modelId !== input.settings.modelId || configured.endpoint !== input.settings.endpoint
      || configured.maxDocumentTokens !== input.settings.maxDocumentTokens) {
      throw new Error('Rerank settings changed after the query view was frozen');
    }
    const batchId = randomUUID();
    const result = await requestWorkspaceInference(broker, options.configCwd, 'harness.rerank', {
      providerId: configured.providerId, modelId: configured.modelId, protocol: 'http-rerank',
      configurationId: configured.configurationId, query: input.query, documents: input.documents, batchId,
      ...(configured.endpoint ? { endpoint: configured.endpoint } : {}),
      ...(configured.maxDocumentTokens ? { maxDocumentTokens: configured.maxDocumentTokens } : {}),
    }, input.signal);
    if (result.batchId !== batchId || result.providerId !== configured.providerId || result.modelId !== configured.modelId) {
      throw new Error('Rerank response does not match the submitted batch binding');
    }
    const seen = new Set<number>();
    for (const score of result.scores) {
      if (!Number.isInteger(score.index) || score.index < 0 || score.index >= input.documents.length
        || seen.has(score.index) || score.id !== input.documents[score.index]?.id || !Number.isFinite(score.score)) {
        throw new Error('Rerank response contains an invalid score identity');
      }
      seen.add(score.index);
    }
    if (seen.size === 0) throw new Error('Rerank response did not score any submitted document');
    return result;
  };
  const fastDecisionStatus: NonNullable<HarnessServiceHost['fastDecisionStatus']> = async (
    workspaceId,
    purpose,
  ) => {
    const state = await getWorkspace(inferenceScopeId(workspaceId));
    await refreshLegacyInference(state);
    return state.binding.fastDecision?.purposes?.[purpose] ?? { status: 'unavailable' as const };
  };
  const fastDecision: NonNullable<HarnessServiceHost['fastDecision']> = async (input) => {
    input.signal?.throwIfAborted();
    const state = await waitWithSignal(getWorkspace(inferenceScopeId(input.workspaceId)), input.signal);
    await refreshLegacyInference(state);
    const broker = options.getBroker();
    if (!broker) throw new Error('Pi workspace binding is unavailable');
    const purposeStatus = state.binding.fastDecision?.purposes?.[input.purpose];
    if (!purposeStatus || purposeStatus.status !== 'ready') {
      throw new Error(
        `Fast decision is ${purposeStatus?.status ?? 'unavailable'} for ${input.purpose}`,
      );
    }
    const configured = purposeStatus.binding;
    // The caller's binding was frozen at query start; a mid-flight settings or
    // provider change is a mismatch, not a silent redirect.
    if (configured.protocol !== input.settings.protocol
      || configured.providerId !== input.settings.providerId
      || configured.modelId !== input.settings.modelId
      || configured.configurationId !== input.settings.configurationId
      || configured.endpoint !== input.settings.endpoint) {
      throw new Error('Fast decision settings changed after the query binding was frozen');
    }
    const batchId = randomUUID();
    const result = await requestWorkspaceInference(broker, options.configCwd, 'harness.fastDecision', {
      providerId: input.settings.providerId,
      modelId: input.settings.modelId,
      protocol: 'pi-classifier',
      configurationId: input.settings.configurationId,
      purpose: input.purpose,
      goal: input.goal,
      materials: input.materials,
      questions: input.questions,
      batchId,
      ...(input.settings.endpoint ? { endpoint: input.settings.endpoint } : {}),
    }, input.signal);
    if (result.batchId !== batchId || result.providerId !== configured.providerId || result.modelId !== configured.modelId) {
      throw new Error('Fast decision response does not match the submitted batch binding');
    }
    return result;
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
  const processEvent = (event: PiRuntimeBrokerEvent): void => {
    if (disposed) return;
    if (event.kind === 'worker.exit' && event.role === 'workspace' && !options.runtimeInference) {
      epoch++;
      for (const state of states.values()) { markUnavailable(state); track(unwatch(state)); }
    } else if (event.kind === 'host' && event.envelope.event === 'config.changed') {
      const id = watchWorkspaces.get(event.envelope.data.watchId);
      const state = id ? states.get(id) : undefined;
      if (state) { state.needsRefresh = true; track(refresh(state, true)); }
    } else if (event.kind === 'host' && event.envelope.event === 'provider.config.changed') {
      for (const state of states.values()) { state.needsRefresh = true; track(refresh(state, true)); }
    }
  };
  return {
    queryStats: async () => {
      const values = await Promise.all([...states.values()].map(state => state.runtime.publishedReaderStats()));
      return { activeQueries: retrievalQueries.size, ...values.reduce((total, value) => ({
        activeReaders: total.activeReaders + value.activeReaders,
        retainedPublications: total.retainedPublications + value.retainedPublications,
      }), { activeReaders: 0, retainedPublications: 0 }) };
    },
    acquireQuery, semanticRecall, harnessSettings, rerankExploreViews, fastDecisionStatus, fastDecision, observeDocumentMutation, observeToolWrite, processEvent,
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
        await prior;
        await loads.get(workspaceId);
        const state = states.get(workspaceId);
        states.delete(workspaceId);
        if (state) {
          state.documentWatch?.close();
          await state.runtime.dispose();
          state.queryEmbedding?.release();
          await state.refreshTail;
          await state.watching;
          await unwatch(state);
        }
        return work();
      })();
      maintenance.set(workspaceId, task);
      try { return await task; }
      finally { if (maintenance.get(workspaceId) === task) maintenance.delete(workspaceId); }
    },
    refreshLocalSemantic: (next: SemanticEmbedder): void => {
      localEmbedders.add(next);
      localEmbedder = next;
      for (const state of states.values()) {
        state.backend.replaceLocal(next);
        if (!state.indexingEnabled || state.backend.kind !== 'local') continue;
        state.runtime.cancelScans();
        track(state.runtime.scanWorkspace(state.workspaceId));
      }
    },
    resolveKnowledgeEmbedder: async (scopeId: string) => {
      const state = await getWorkspace(inferenceScopeId(scopeId));
      if (state.binding.embedding.status === 'ready') return { status: 'ready' as const,
        embedder: legacyEmbedderFor(state) ?? state.backend.embedder };
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
      epoch++;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      reconcileTimer = null;
      for (const state of states.values()) state.documentWatch?.close();
      const closedStates = new Set<WorkspaceState>();
      const closeResults = await Promise.allSettled([...states.values()].map(async state => {
        await state.runtime.dispose(); closedStates.add(state);
      }));
      await Promise.allSettled([...loads.values(), ...pending]);
      await Promise.allSettled([...states.values()].map(async (state) => {
        await state.refreshTail;
        await state.watching;
        await unwatch(state);
      }));
      for (const [id, state] of states) {
        state.queryEmbedding?.release();
        if (closedStates.has(state)) states.delete(id);
      }
      await Promise.allSettled([...localEmbedders].map(embedder => embedder.dispose?.()));
      localEmbedders.clear();
      const failed = closeResults.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Semantic runtime shutdown failed');
    },
  };
}
