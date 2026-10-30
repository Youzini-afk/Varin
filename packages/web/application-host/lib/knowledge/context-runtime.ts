import type { DocumentMutationObservation } from "../documents/authority.js";
import { randomUUID } from 'node:crypto';
import { waitWithSignal } from "../cancellation.js";
import type { ContextObservationSource } from '../kernel/protocol.generated.js';
import type { KnowledgeRecallItem, KnowledgeRecallMaterial } from "./recall-material.js";
import { createObservers, type DiagnosticEvent, type GitStatusEvent, type Observers, type TerminalCommandEvent, type TerminalExitEvent } from "./observers.js";
import type { KnowledgeScope, KnowledgeStore, RecallResult, StoredEvent } from "./store.js";
import type { BotRecallContext, BotRecallWork } from '../memory/bot-recall-context.js';
import type { MemoryRecallAssociation } from './vectors/index.js';

/** Only the original admitted native launch can establish an observation owner. */
export interface ThreadObservationIdentity { threadId: string; branchId: string; runId: string }
export type ThreadObservationSource = ContextObservationSource;
export interface ThreadObservationMaterial {
  owner: ThreadObservationSource;
  eventCursor: number;
  events: Array<{ ref: string; event: StoredEvent }>;
}
/** Only storage reads are optional during request preparation; identity and receipt fences are not. */
export class ObservationStoreUnavailableError extends Error {
  readonly reason: 'corrupt' | 'unavailable';
  constructor(readonly workspaceId: string, cause: unknown) {
    super('Workspace change notifications are unavailable', { cause });
    this.name = 'ObservationStoreUnavailableError';
    this.reason = cause instanceof Error && cause.message.startsWith('TDB_ERROR:') && cause.message.includes('Corrupted file')
      ? 'corrupt' : 'unavailable';
  }
}
interface ObservationBinding extends ThreadObservationSource {
  workspaceId: string;
  fingerprint: string;
  gitFingerprint: string | null;
  observers: Promise<Observers | null> | null;
  pendingUserPaths: Set<string>;
  tail: Promise<void>;
}
export interface KnowledgeContextRuntimeOptions {
  getStore(workspaceId: string): Promise<KnowledgeStore | null>;
  getUserStore?: () => Promise<KnowledgeStore | null>;
  getThreadStore?: (threadId: string) => Promise<KnowledgeStore | null>;
  goalForThread?: (threadId: string) => Promise<string | undefined>;
  recallContextForThread?: (input: { threadId: string; query: string; work?: readonly BotRecallWork[]; signal?: AbortSignal }) => Promise<BotRecallContext>;
  recallForThread?: (input: { workspaceId: string; store: KnowledgeStore; threadId: string; query: string; associated?: MemoryRecallAssociation; goal?: string; signal?: AbortSignal }) => Promise<RecallResult[]>;
  /** Reads original launch identities. No renderer or path-derived conversation binding. */
  threadSources?(): Promise<ThreadObservationSource[]>;
  /** Fires after the original Knowledge write settles, outside its source tail. */
  onObservation?(owner: ThreadObservationSource): Promise<void>;
  onError?: (error: unknown) => void;
}
const emptyMaterial = (): KnowledgeRecallMaterial => ({ knowledge: [] });

export function createKnowledgeContextRuntime(options: KnowledgeContextRuntimeOptions) {
  const bindings = new Map<string, ObservationBinding>();
  const pending = new Set<Promise<void>>();
  let disposed = false;
  let refresh: Promise<void> | undefined;
  const track = (task: Promise<void>): void => {
    pending.add(task);
    void task.catch(error => options.onError?.(error)).finally(() => pending.delete(task));
  };
  const refreshBindings = (): Promise<void> => {
    if (refresh) return refresh;
    const task = (async () => {
      if (disposed) return;
      const sources = await options.threadSources?.() ?? [];
      if (disposed) return;
      const retained = new Set<string>();
      for (const owner of sources) {
        // Fixed/remote resources never borrow a local cwd or its notifications.
        if (owner.source.resource_owner.kind !== 'local' || owner.source.mode === 'fixed_branch') continue;
        const workspaceId = owner.source.execution_workspace_id;
        if (!owner.threadId || !owner.branchId || !owner.runId || !workspaceId) throw new Error('Invalid admitted observation owner');
        if (retained.has(owner.runId)) throw new Error('Ambiguous original Run observation source');
        retained.add(owner.runId);
        const fingerprint = JSON.stringify([owner.threadId, owner.branchId, owner.runId, owner.anchorId, owner.source]);
        const current = bindings.get(owner.runId);
        if (current?.fingerprint === fingerprint) { current.epoch = owner.epoch; continue; }
        if (current) throw new Error('Original Run observation source changed');
        bindings.set(owner.runId, { ...structuredClone(owner), workspaceId, fingerprint, gitFingerprint: null,
          observers: null, pendingUserPaths: new Set(), tail: Promise.resolve() });
      }
      for (const id of bindings.keys()) if (!retained.has(id)) bindings.delete(id);
    })();
    refresh = task;
    void task.finally(() => { if (refresh === task) refresh = undefined; }).catch(() => {});
    return task;
  };
  const forWorkspace = async (workspaceId: string, visit: (observers: Observers, binding: ObservationBinding) => Promise<void>, target?: ThreadObservationIdentity, publish = false): Promise<void> => {
    await refreshBindings();
    await Promise.all([...bindings.values()].filter(binding => binding.workspaceId === workspaceId && (!target || binding.runId === target.runId && binding.threadId === target.threadId && binding.branchId === target.branchId)).map(binding => {
      const task = binding.tail.then(async () => {
        if (disposed) return;
        const loading = binding.observers ??= options.getStore(binding.workspaceId).then(store => store ? createObservers({ store, sessionId: binding.runId }) : null);
        let observers: Observers | null;
        try { observers = await loading; } catch (error) { if (binding.observers === loading) binding.observers = null; throw error; }
        if (observers) await visit(observers, binding);
      });
      binding.tail = task.catch(() => undefined);
      return task.then(async () => {
        if (!disposed && publish) await options.onObservation?.({ threadId: binding.threadId, branchId: binding.branchId,
          runId: binding.runId, anchorId: binding.anchorId, source: binding.source, epoch: binding.epoch });
      });
    }));
  };
  const observeDocumentMutation = (event: DocumentMutationObservation): void => {
    if (disposed) return;
    const changeId = `document:${randomUUID()}`;
    const agentWriterActive = event.owner.kind === 'harness' || event.owner.kind.startsWith('harness-') || event.owner.kind.startsWith('agent-') || event.owner.kind === 'agent-runtime';
    track(forWorkspace(event.workspaceId, (observers, binding) => {
      if (agentWriterActive) binding.pendingUserPaths.delete(event.resourceId); else binding.pendingUserPaths.add(event.resourceId);
      return observers.onDocumentWrite({ workspaceId: event.workspaceId, path: event.resourceId, kind: event.kind, agentWriterActive, owner: event.owner, changeId,
        source: agentWriterActive ? 'agent' : ['web-route', 'workspace-edit', 'resource-editor', 'recovery'].includes(event.owner.kind) ? 'user' : 'external' });
    }, undefined, !agentWriterActive));
  };
  const observeTerminalCommand = async (event: TerminalCommandEvent | TerminalExitEvent, target?: ThreadObservationIdentity): Promise<boolean> => {
    if (disposed) return false;
    let inserted = false;
    const task = forWorkspace(event.workspaceId, async observers => { inserted = await observers.onTerminalExit(event) || inserted; }, target, event.source === 'user');
    track(task); await task; return inserted;
  };
  const observeDiagnostics = (event: DiagnosticEvent): void => {
    if (disposed) return;
    track(forWorkspace(event.workspaceId, async (observers, binding) => {
      if (!binding.pendingUserPaths.delete(event.path)) return;
      await observers.onDiagnostics(event);
    }, undefined, true));
  };
  const observeGitStatus = (event: GitStatusEvent): void => {
    if (disposed) return;
    const fingerprint = JSON.stringify([event.branch ?? null, event.changed ?? null, event.note ?? null]);
    const changeId = `git:${randomUUID()}`;
    track(forWorkspace(event.workspaceId, async (observers, binding) => {
      if (binding.gitFingerprint === fingerprint) return;
      const branchChanged = binding.gitFingerprint !== null && JSON.parse(binding.gitFingerprint)[0] !== (event.branch ?? null);
      await observers.onGitStatus({ ...event, changeId, notifyAssistant: branchChanged }); binding.gitFingerprint = fingerprint;
    }, undefined, true));
  };
  const drain = async (): Promise<void> => { while (pending.size) await Promise.allSettled([...pending]); };
  const observationsForSource = async (owner: ThreadObservationSource, request: { afterEventId?: number; signal?: AbortSignal } = {}): Promise<ThreadObservationMaterial> => {
    if (owner.source.resource_owner.kind !== 'local' || owner.source.mode === 'fixed_branch') throw new Error('Observation source is not a local live resource');
    const binding = bindings.get(owner.runId);
    if (binding) {
      if (JSON.stringify([binding.threadId, binding.branchId, binding.anchorId, binding.source]) !== JSON.stringify([owner.threadId, owner.branchId, owner.anchorId, owner.source])) throw new Error('Observation request changed original Run');
      await waitWithSignal(binding.tail, request.signal);
    }
    let events: StoredEvent[];
    try {
      const store = await waitWithSignal(options.getStore(owner.source.execution_workspace_id), request.signal);
      if (!store) throw new Error('Observation source store is unavailable');
      events = await waitWithSignal(store.listEvents({ sessionId: owner.runId, ...(request.afterEventId === undefined ? {} : { afterId: request.afterEventId }) }), request.signal);
    } catch (error) {
      request.signal?.throwIfAborted();
      throw new ObservationStoreUnavailableError(owner.source.execution_workspace_id, error);
    }
    request.signal?.throwIfAborted();
    return { owner: structuredClone(owner), eventCursor: events.at(-1)?.id ?? request.afterEventId ?? 0,
      events: events.map(event => ({ ref: `observation:${owner.runId}:${event.id}`, event })) };
  };
  const observationsForRun = async (request: ThreadObservationIdentity & { afterEventId?: number; signal?: AbortSignal }): Promise<ThreadObservationMaterial | null> => {
    await waitWithSignal(refreshBindings(), request.signal);
    const binding = bindings.get(request.runId);
    if (!binding) return null;
    if (binding.threadId !== request.threadId || binding.branchId !== request.branchId) throw new Error('Observation request changed original Run');
    return observationsForSource({ threadId: binding.threadId, branchId: binding.branchId, runId: binding.runId, anchorId: binding.anchorId, epoch: binding.epoch, source: binding.source }, request);
  };
  type RecallRequest = { threadId: string; query?: string; work?: BotRecallWork[]; knownMaterial?: Record<string, string>; signal?: AbortSignal };
  type RecallBinding = { workspaceId: string; recallCache: { query: string; workspaceRevision: string; userRevision: string | null; sessionRevision: string | null; results: RecallResult[] } | null };
  const threadBindings = new Map<string, RecallBinding>();
  const recallMaterial = async (request: RecallRequest, binding: RecallBinding, store: KnowledgeStore, material: KnowledgeRecallMaterial): Promise<void> => {
    const wait = <T>(work: Promise<T>): Promise<T> => waitWithSignal(work, request.signal);
    const query = request.query?.trim();
    const goal = await wait(options.goalForThread?.(request.threadId) ?? Promise.resolve(undefined));
    // BC3: the recall query carries the owning work's goal plus the latest
    // message, so "continue" still reaches the memories bound to that work.
    const baseQuery = [goal, query].filter((part) => part !== undefined && part.length > 0).join("\n");
    const projection = await wait(options.recallContextForThread?.({ threadId: request.threadId, query: baseQuery,
      ...(request.work ? { work: request.work } : {}), ...(request.signal ? { signal: request.signal } : {}) }) ?? Promise.resolve(undefined));
    const recallQuery = projection?.query || baseQuery || undefined;
    const recallKey = JSON.stringify([recallQuery, projection?.revision]);
    const retainedKnowledge = Object.keys(request.knownMaterial ?? {}).flatMap((key) => {
      const match = /^knowledge:(workspace|user|bot|session):(\d+)$/.exec(key);
      if (!match) return [];
      return [{ scope: match[1] as KnowledgeScope, id: Number(match[2]) }];
    });
    const userStore = (recallQuery || retainedKnowledge.length > 0) && options.getUserStore
      ? await wait(options.getUserStore())
      : null;
    // Owner-scope rows (workspace/bot/session) live in `store`; only `user`
    // rows resolve against the user store.
    const sessionStore = await wait(options.getThreadStore?.(request.threadId) ?? Promise.resolve(null));
    const storeForScope = (scope: KnowledgeScope) => scope === "user" ? userStore
      : scope === "session" && sessionStore ? sessionStore : store;
    if (retainedKnowledge.length > 0) {
      const invalidations = (await wait(Promise.all(retainedKnowledge.map(async ({ scope, id }) => {
        const source = storeForScope(scope);
        if (!source) return [];
        const current = await wait(source.getKnowledge(id));
        return !current || current.scope !== scope || current.invalidAt !== undefined || current.status !== "accepted"
          ? [{ id, scope }]
          : [];
      })))).flat();
      if (invalidations.length > 0) {
        (material as KnowledgeRecallMaterial & { knowledgeInvalidations: typeof invalidations }).knowledgeInvalidations = invalidations;
      }
    }
    if (recallQuery) {
      // Recall is a query operation, not a per-request poll. Store-owned
      // knowledge revisions invalidate the cache in O(1), while the cached
      // RecallResult retains its source scope/payload (workspace and user
      // stores may legally reuse numeric node IDs).
      const workspaceRevision = store.knowledgeRevision();
      const userRevision = userStore ? userStore.knowledgeRevision() : null;
      const sessionRevision = sessionStore ? sessionStore.knowledgeRevision() : null;
      const cached = binding.recallCache;
      const sameQuery = cached?.query === recallKey;
      const revisionsChanged = !cached
        || cached.workspaceRevision !== workspaceRevision
        || cached.userRevision !== userRevision || cached.sessionRevision !== sessionRevision;
      if (sameQuery && revisionsChanged) {
        const invalidations = (await wait(Promise.all(cached.results.flatMap(async (result) => {
          if (result.node.type !== "knowledge") return [];
          const payload = result.node.payload;
          const scope = payload.scope as KnowledgeScope;
          const source = storeForScope(scope);
          if (!source) return [];
          const current = await wait(source.getKnowledge(result.node.id));
          return !current || current.invalidAt !== undefined || current.status !== "accepted"
            ? [{ id: result.node.id, scope }]
            : [];
        })))).flat();
        if (invalidations.length > 0) {
          // Preserve this explicit fact on the material object until the
          // formatter/receipt selector has represented it in history.
          const prior = material.knowledgeInvalidations ?? [];
          (material as KnowledgeRecallMaterial & { knowledgeInvalidations: typeof invalidations }).knowledgeInvalidations = [...prior, ...invalidations];
        }
      }
      let recalled: RecallResult[];
      if (cached?.query === recallKey
        && cached.workspaceRevision === workspaceRevision
        && cached.userRevision === userRevision && cached.sessionRevision === sessionRevision) {
        recalled = cached.results;
      } else {
        const input = { workspaceId: binding.workspaceId, store, query: recallQuery,
          ...(projection ? { associated: projection.associated } : {}),
          ...(goal !== undefined ? { goal } : {}), ...(request.signal ? { signal: request.signal } : {}) };
        recalled = options.recallForThread ? await wait(options.recallForThread({ ...input, threadId: request.threadId })) : await wait(store.recall(recallQuery, 5));
        request.signal?.throwIfAborted();
        binding.recallCache = { query: recallKey, workspaceRevision, userRevision, sessionRevision, results: recalled };
      }
      material.knowledge = recalled.flatMap((result) => {
        if (result.node.type !== "knowledge") return [];
        const content = result.node.payload.content;
        const trigger = result.node.payload.trigger;
        return typeof content === "string" && typeof trigger === "string"
          ? [{
              id: result.node.id,
              title: content,
              trigger,
              ...(typeof result.node.payload.nature === "string" ? { nature: result.node.payload.nature } : {}),
              ...(result.node.payload.source && typeof result.node.payload.source === "object"
                ? { sourceKind: String((result.node.payload.source as { kind?: string }).kind ?? "") } : {}),
              ...(typeof result.node.payload.scope === "string"
                ? { scope: result.node.payload.scope as NonNullable<KnowledgeRecallItem["scope"]> }
                : {}),
            }]
          : [];
      });
    }
    // A human-corrected or organizer-superseded row reaches the request as an
    // explicit update, not as another invalidation (BC3): the accepted
    // successor is delivered beside the removal.
    const deliveredInvalidations = material.knowledgeInvalidations ?? [];
    if (deliveredInvalidations.length > 0) {
      const corrections = (await wait(Promise.all(deliveredInvalidations.map(async ({ scope, id }) => {
        const source = storeForScope(scope);
        if (!source) return [];
        const chain = await wait(source.getSupersedeChain(id, scope).catch(() => null));
        const successor = chain?.successors
          .filter((item) => item.status === "accepted" && item.invalidAt === undefined)
          .at(-1);
        return successor ? [{ id: successor.id, scope, supersedes: id, title: successor.content, trigger: successor.trigger,
          ...(successor.nature ? { nature: successor.nature } : {}), ...(successor.source ? { sourceKind: successor.source.kind } : {}) }] : [];
      })))).flat();
      if (corrections.length > 0) material.knowledgeCorrections = corrections;
    }
  };
  const knowledgeForThread = async (request: RecallRequest & { scopeId: string; query: string }): Promise<KnowledgeRecallMaterial> => {
    request.signal?.throwIfAborted();
    const existing = threadBindings.get(request.threadId);
    const binding: RecallBinding = existing?.workspaceId === request.scopeId ? existing : { workspaceId: request.scopeId, recallCache: null };
    threadBindings.set(request.threadId, binding);
    const store = await options.getStore(request.scopeId);
    if (!store) throw new Error('Bot knowledge owner is unavailable');
    const material = emptyMaterial();
    await recallMaterial(request, binding, store, material);
    return material;
  };

  return {
    knowledgeForThread, observationsForRun, observationsForSource, observeDocumentMutation, observeDiagnostics, observeGitStatus,
    observeTerminalCommand, observeTerminalExit: observeTerminalCommand, drain,
    listBoundOwners: async (workspaceId: string): Promise<ThreadObservationIdentity[]> => { await refreshBindings(); return [...bindings.values()].filter(binding => binding.workspaceId === workspaceId).map(({ threadId, branchId, runId }) => ({ threadId, branchId, runId })); },
    dispose: async (): Promise<void> => { disposed = true; bindings.clear(); threadBindings.clear(); await drain(); },
  };
}
export type KnowledgeContextRuntime = ReturnType<typeof createKnowledgeContextRuntime>;
