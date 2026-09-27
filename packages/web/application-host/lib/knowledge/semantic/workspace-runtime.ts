import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { PiRuntimeBroker, PiRuntimeBrokerEvent } from '@varin/runtime-broker';
import { FAST_DECISION_PURPOSES } from '@varin/protocol';
import type { HarnessInferenceBindingSnapshot, PiSettingsSnapshot } from '@varin/protocol';
import type { DocumentAuthority, DocumentMutationObservation } from '../../documents/authority.js';
import type { HarnessServiceHost } from '../../harness/service-host.js';
import type { createWorkingBranchLookups } from '../../harness/working-state/working-branch-lookups.js';
import type { ThreadExecutionViewRegistry } from '../../harness/working-state/execution-view.js';
import { createSemanticBackend } from './backend.js';
import type { SemanticEmbedder } from './embedder.js';
import { waitWithSignal } from './cancellation.js';
import { workspaceScope } from './identity.js';
import { pinSemanticQueryView } from './query-view.js';
import { createSemanticIndexRuntime, type SemanticIndexRuntimeOptions } from './runtime.js';
import { requestWorkspaceInference, resolveInferenceBinding } from './workspace-inference.js';

type InferenceBroker = Pick<PiRuntimeBroker, 'requestForWorkspace' | 'watchConfig' | 'unwatchConfig'>;
type PathMutation = Pick<DocumentMutationObservation, 'workspaceId' | 'resourceId' | 'kind'>;

export interface WorkspaceSemanticRuntimeOptions extends Omit<SemanticIndexRuntimeOptions, 'getEmbedder' | 'documents'> {
  documents: Pick<DocumentAuthority, 'read' | 'inspectWorkspace' | 'agentInputDraftPaths' | 'readAgentInputSnapshot'>;
  getBroker(): InferenceBroker | null;
  /**
   * HR3: one shared worker directory for settings/inference transport. Harness
   * inference resolves global configuration only (project scope never feeds
   * embedding/rerank/fast-decision), so every resource root can reuse the same
   * worker instead of spawning a workspace worker per indexed directory.
   * Root cwd still owns document reads and scan addressing.
   */
  configCwd: string;
  executionViews: Pick<ThreadExecutionViewRegistry, 'get'>;
  workingBranches: Pick<ReturnType<typeof createWorkingBranchLookups>, 'pinQuery'>;
  onBindingChanged?: (workspaceId: string) => void;
}

type WorkspaceState = {
  workspaceId: string;
  backend: ReturnType<typeof createSemanticBackend>;
  runtime: ReturnType<typeof createSemanticIndexRuntime>;
  binding: HarnessInferenceBindingSnapshot;
  snapshot: PiSettingsSnapshot | null;
  bindingKey: string;
  needsRefresh: boolean;
  refreshTail: Promise<void>;
  watches: Array<{ id: string; broker: InferenceBroker }>;
  watching: Promise<void> | null;
};

/** The production owner of workspace settings, inference transport and query views. */
export function createWorkspaceSemanticRuntime(options: WorkspaceSemanticRuntimeOptions) {
  let localEmbedder = options.embedder;
  const states = new Map<string, WorkspaceState>();
  const loads = new Map<string, Promise<WorkspaceState>>();
  const watchWorkspaces = new Map<string, string>();
  const pending = new Set<Promise<unknown>>();
  let epoch = 0;
  let disposed = false;
  const report = (error: unknown): void => { try { options.onError?.(error); } catch { /* observation only */ } };
  const track = (task: Promise<unknown>): void => {
    pending.add(task);
    void task.catch(report).finally(() => pending.delete(task));
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
    const retrying = state.needsRefresh;
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
    if (scanWhenChanged && (changed || retrying)) track(state.runtime.scanWorkspace(state.workspaceId));
  };
  const refresh = (state: WorkspaceState, scanWhenChanged = false): Promise<void> => {
    const task = state.refreshTail.then(() => refreshNow(state, scanWhenChanged));
    state.refreshTail = task.then(() => undefined, () => undefined);
    return task;
  };
  const watch = async (state: WorkspaceState): Promise<void> => {
    if (disposed || state.watches.length > 0) return;
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
  const getWorkspace = async (workspaceId: string, autoScan = true): Promise<WorkspaceState> => {
    assertActive();
    const loading = loads.get(workspaceId);
    if (loading) return loading;
    const existing = states.get(workspaceId);
    if (existing) {
      await watch(existing);
      // Also wait for a refresh already queued by config.changed.
      if (existing.needsRefresh) await refresh(existing, autoScan);
      else await existing.refreshTail;
      assertActive();
      return existing;
    }
    const task = (async () => {
      // Resolve the resource root so missing/unavailable directories fail here,
      // not inside an inference or scan task.
      await options.documents.inspectWorkspace(workspaceId);
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
        workspaceId, backend, runtime,
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
        watches: [], watching: null,
      };
      // Never let a query run against the local backend before settings resolve.
      markUnavailable(state);
      states.set(workspaceId, state);
      // Register observation before reading settings, so changes made while a
      // watch is being created are included in the first binding snapshot.
      await watch(state);
      await refresh(state);
      if (autoScan && !disposed) track(runtime.scanWorkspace(workspaceId));
      await state.refreshTail;
      assertActive();
      return state;
    })();
    loads.set(workspaceId, task);
    try { return await task; } finally { if (loads.get(workspaceId) === task) loads.delete(workspaceId); }
  };

  const semanticRecall: NonNullable<HarnessServiceHost['semanticRecall']> = async (workspaceId, question, limit, searchOptions) => {
    searchOptions?.signal?.throwIfAborted();
    const state = await waitWithSignal(getWorkspace(workspaceId), searchOptions?.signal);
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
      const draftPaths = sessionId ? options.documents.agentInputDraftPaths(sessionId, inputContext)
        : inputContext.source === 'surface' ? inputContext.dirtyPaths : undefined;
      const view = await pinSemanticQueryView({
        inputContext,
        ...(draftPaths === undefined ? {} : { draftPaths }),
        ...(threadQuery ? { threadDocuments: [] } : threadDocuments ? { threadDocuments } : sessionId ? {
          readDraft: (resourceId: string) => options.documents.readAgentInputSnapshot(sessionId, inputContext, resourceId),
        } : {}),
      });
      const result = await state.runtime.search(workspaceScope(workspaceId), question, limit, {
        ...(searchOptions?.signal ? { signal: searchOptions.signal } : {}),
        ...(searchOptions?.roots ? { roots: searchOptions.roots } : {}),
        overlays: view.overlays, view: view.view,
        ...(threadQuery ? { threadQuery } : {}),
      });
      return {
        status: result.status.status, coverage: result.status.coverage,
        ...(result.status.generation ? { generation: result.status.generation } : {}),
        ...(result.status.spaceId ? { spaceId: result.status.spaceId } : {}),
        scope: result.status.scope, lifecycle: result.status.lifecycle, hits: result.hits,
        ...(result.gaps.length > 0 ? { gaps: result.gaps } : {}),
      };
    } finally {
      await threadSnapshot?.release();
    }
  };
  const harnessSettings: NonNullable<HarnessServiceHost['harnessSettings']> = async (workspaceId) => (await getWorkspace(workspaceId)).snapshot;
  const rerankExploreViews: NonNullable<HarnessServiceHost['rerankExploreViews']> = async (input) => {
    input.signal?.throwIfAborted();
    const state = await waitWithSignal(getWorkspace(input.workspaceId), input.signal);
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
    const state = await getWorkspace(workspaceId);
    return state.binding.fastDecision?.purposes?.[purpose] ?? { status: 'unavailable' as const };
  };
  const fastDecision: NonNullable<HarnessServiceHost['fastDecision']> = async (input) => {
    input.signal?.throwIfAborted();
    const state = await waitWithSignal(getWorkspace(input.workspaceId), input.signal);
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
      protocol: 'typesafe-systemone',
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
    if (state && !loads.has(event.workspaceId) && !state.needsRefresh) state.runtime.observeDocumentMutation(event);
    else track(getWorkspace(event.workspaceId).then((ready) => ready.runtime.observeDocumentMutation(event)));
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
    if (event.kind === 'worker.exit' && event.role === 'workspace') {
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
    semanticRecall, harnessSettings, rerankExploreViews, fastDecisionStatus, fastDecision, observeDocumentMutation, observeToolWrite, processEvent,
    scanWorkspace: async (workspaceId: string) => (await getWorkspace(workspaceId, false)).runtime.scanWorkspace(workspaceId),
    refreshLocalSemantic: (next: SemanticEmbedder): void => {
      localEmbedder = next;
      for (const state of states.values()) {
        state.backend.replaceLocal(next);
        if (state.backend.kind !== 'local') continue;
        state.runtime.cancelScans();
        track(state.runtime.scanWorkspace(state.workspaceId));
      }
    },
    resolveKnowledgeEmbedder: async (workspaceId: string) => {
      const state = await getWorkspace(workspaceId);
      if (state.binding.embedding.status === 'ready') return { status: 'ready' as const, embedder: state.backend.embedder };
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
      await Promise.allSettled([...states.values()].map((state) => state.runtime.dispose()));
      await Promise.allSettled([...loads.values(), ...pending]);
      await Promise.allSettled([...states.values()].map(async (state) => {
        await state.refreshTail;
        await state.watching;
        await unwatch(state);
      }));
      states.clear();
    },
  };
}
