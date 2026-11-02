import { waitWithSignal } from "../cancellation.js";
import type { KnowledgeRecallItem, KnowledgeRecallMaterial } from "./recall-material.js";
import type { KnowledgeScope, KnowledgeStore, RecallResult } from "./store.js";
import type { BotRecallContext, BotRecallWork } from '../memory/bot-recall-context.js';
import type { MemoryRecallAssociation } from './vectors/index.js';

export interface KnowledgeContextRuntimeOptions {
  getStore(workspaceId: string): Promise<KnowledgeStore | null>;
  getUserStore?: () => Promise<KnowledgeStore | null>;
  getThreadStore?: (threadId: string) => Promise<KnowledgeStore | null>;
  goalForThread?: (threadId: string) => Promise<string | undefined>;
  recallContextForThread?: (input: { threadId: string; query: string; work?: readonly BotRecallWork[]; signal?: AbortSignal }) => Promise<BotRecallContext>;
  recallForThread?: (input: { workspaceId: string; store: KnowledgeStore; threadId: string; query: string; associated?: MemoryRecallAssociation; goal?: string; signal?: AbortSignal }) => Promise<RecallResult[]>;
}
const emptyMaterial = (): KnowledgeRecallMaterial => ({ knowledge: [] });

/** Bot/user knowledge recall only. Environmental captures belong to the native Catalog. */
export function createKnowledgeContextRuntime(options: KnowledgeContextRuntimeOptions) {
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
        return (chain?.successors ?? [])
          .filter((item) => item.status === "accepted" && item.invalidAt === undefined)
          .map(successor => ({ id: successor.id, scope, supersedes: id, title: successor.content, trigger: successor.trigger,
          ...(successor.nature ? { nature: successor.nature } : {}), ...(successor.source ? { sourceKind: successor.source.kind } : {}) }));
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

  return { knowledgeForThread, dispose: async (): Promise<void> => { threadBindings.clear(); } };
}
export type KnowledgeContextRuntime = ReturnType<typeof createKnowledgeContextRuntime>;
