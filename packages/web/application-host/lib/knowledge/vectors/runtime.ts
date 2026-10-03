/**
 * Background knowledge-vector builder.
 *
 * Knowledge is authoritative in knowledge/store.ts.  This runtime owns only
 * derived semantic generations, and shares the semantic store's transaction,
 * cache, scheduler, cancellation, and late-publication rules.
 */

import type { SemanticEmbedder } from "../semantic/embedder.js";
import type { EmbedScheduler } from "../semantic/embed-scheduler.js";
import { spaceIdOf } from "../semantic/identity.js";
import type { SemanticVectorCache } from "../semantic/vector-cache.js";
import { waitWithSignal } from "../../cancellation.js";
import { packPlainText } from "../semantic/chunker.js";
import type { Knowledge, KnowledgeScope, KnowledgeStore, NodeId } from "../store.js";
import {
  createKnowledgeVectorStore,
  type KnowledgeVectorHit,
  type KnowledgeVectorStore,
} from "./store.js";
import { knowledgeContentRevision, knowledgeEmbedText } from "./identity.js";

export type KnowledgeVectorStatus = "unconfigured" | "unavailable" | "failed" | "empty" | "partial" | "used";

export type KnowledgeEmbedderResolution =
  | { status: "unconfigured" }
  | { status: "unavailable" | "invalid" | "failed"; message?: string }
  | { status: "ready"; embedder: SemanticEmbedder };

type Registration = {
  authority: KnowledgeStore;
  scope: KnowledgeScope;
  scopeId: string;
  workspaceId: string;
  pendingFull: boolean;
  dirtyIds: Set<NodeId>;
  workVersion: number;
  spaceId?: string;
  status: KnowledgeVectorStatus;
};

export type KnowledgeVectorScopeSearch = {
  authority: KnowledgeStore;
  scope: KnowledgeScope;
  scopeId: string;
};

const eligible = (item: Knowledge, scope: KnowledgeScope): boolean => (
  item.scope === scope && item.status === "accepted" && item.invalidAt === undefined
);

const knowledgeDocumentId = (id: NodeId): string => String(id);

const registrationKey = (scope: KnowledgeScope, scopeId: string, workspaceId: string): string => (
  `${scope}\0${scopeId}\0${workspaceId}`
);

const storeKey = (scope: KnowledgeScope, scopeId: string, spaceId: string): string => (
  `${scope}\0${scopeId}\0${spaceId}`
);

const statusForResolution = (resolution: KnowledgeEmbedderResolution): KnowledgeVectorStatus => {
  if (resolution.status === "unconfigured") return "unconfigured";
  if (resolution.status === "ready") return "empty";
  return resolution.status === "failed" ? "failed" : "unavailable";
};

export function createKnowledgeVectorRuntime(options: {
  dataDir: string;
  hostId: string;
  scheduler: EmbedScheduler;
  cache: SemanticVectorCache;
  resolveEmbedder: (workspaceId: string) => Promise<KnowledgeEmbedderResolution>;
  onError?: (error: unknown) => void;
}) {
  const stores = new Map<string, KnowledgeVectorStore>();
  const registrations = new Map<string, Registration>();
  const builds = new Map<string, Promise<void>>();
  const queryInFlight = new Map<string, { promise: Promise<number[]>; controller: AbortController; waiters: number }>();
  const documentTokens = new Map<string, number>();
  const dimensionBootstraps = new WeakMap<SemanticEmbedder, Promise<number[]>>();
  const lifecycleController = new AbortController();
  const activeSearches = new Set<Promise<unknown>>();
  const activeQueryWorks = new Set<Promise<unknown>>();
  let tokenClock = 0;
  let disposed = false;
  let closePromise: Promise<void> | null = null;

  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* diagnostics cannot break indexing */ }
  };

  const trackSearch = <T>(promise: Promise<T>): Promise<T> => {
    activeSearches.add(promise);
    void promise.then(
      () => { activeSearches.delete(promise); },
      () => { activeSearches.delete(promise); },
    );
    return promise;
  };

  const storeFor = (scope: KnowledgeScope, scopeId: string, embedder: SemanticEmbedder): KnowledgeVectorStore => {
    if (disposed) throw new DOMException("Knowledge vector runtime is closed", "AbortError");
    const key = storeKey(scope, scopeId, spaceIdOf(embedder.space));
    const existing = stores.get(key);
    if (existing) return existing;
    const created = createKnowledgeVectorStore({
      dataDir: options.dataDir,
      hostId: options.hostId,
      scope,
      scopeId,
      embedder,
      cache: options.cache,
      scheduler: options.scheduler,
    });
    stores.set(key, created);
    return created;
  };

  const tokenKey = (scope: KnowledgeScope, scopeId: string, id: NodeId): string => (
    `${scope}\0${scopeId}\0${id}`
  );

  const nextToken = (scope: KnowledgeScope, scopeId: string, id: NodeId): number => {
    const key = tokenKey(scope, scopeId, id);
    const token = ++tokenClock;
    documentTokens.set(key, token);
    return token;
  };

  const currentToken = (scope: KnowledgeScope, scopeId: string, id: NodeId): number => (
    documentTokens.get(tokenKey(scope, scopeId, id)) ?? 0
  );

  const registrationFor = (
    authority: KnowledgeStore,
    scope: KnowledgeScope,
    scopeId: string,
    workspaceId: string,
    forceFull = false,
  ): Registration => {
    const key = registrationKey(scope, scopeId, workspaceId);
    const existing = registrations.get(key);
    if (existing) {
      if (existing.authority !== authority) {
        existing.pendingFull = true;
        existing.dirtyIds.clear();
        existing.workVersion += 1;
      }
      existing.authority = authority;
      if (forceFull) {
        existing.pendingFull = true;
        existing.dirtyIds.clear();
        existing.workVersion += 1;
      }
      return existing;
    }
    const created: Registration = {
      authority,
      scope,
      scopeId,
      workspaceId,
      pendingFull: true,
      dirtyIds: new Set(),
      workVersion: 1,
      status: "empty",
    };
    registrations.set(key, created);
    return created;
  };

  /** Resolve automatic dimensions from an actual knowledge/query input. */
  const ensureDimension = async (
    embedder: SemanticEmbedder,
    sample: string,
    purpose: "document" | "query",
    signal?: AbortSignal,
  ): Promise<void> => {
    if (embedder.space.dim > 0) return;
    let bootstrap = dimensionBootstraps.get(embedder);
    if (!bootstrap) {
      bootstrap = options.scheduler.enqueue(purpose === "query" ? "foreground" : "background", async () => {
        lifecycleController.signal.throwIfAborted();
        await embedder.prepare();
        lifecycleController.signal.throwIfAborted();
        const vectors = await embedder.embed([sample], {
          purpose,
          signal: lifecycleController.signal,
        });
        lifecycleController.signal.throwIfAborted();
        const vector = vectors[0];
        if (!vector || embedder.space.dim <= 0 || vector.length !== embedder.space.dim) {
          throw new Error("Knowledge embedder did not resolve a valid vector dimension.");
        }
        options.cache.set({
          spaceId: spaceIdOf(embedder.space),
          purpose,
          embedText: sample,
        }, vector);
        return vector;
      });
      dimensionBootstraps.set(embedder, bootstrap);
      void bootstrap.catch(() => {
        if (dimensionBootstraps.get(embedder) === bootstrap) dimensionBootstraps.delete(embedder);
      });
    }
    await waitWithSignal(bootstrap, signal);
  };

  const embedQuery = async (
    embedder: SemanticEmbedder,
    text: string,
    signal?: AbortSignal,
  ): Promise<number[]> => {
    const spaceId = spaceIdOf(embedder.space);
    const cacheInput = { spaceId, purpose: "query" as const, embedText: text };
    const cached = options.cache.get(cacheInput);
    if (cached) return cached;
    const localKey = `${spaceId}\0${text}`;
    const local = queryInFlight.get(localKey);
    if (local) {
      local.waiters += 1;
      try {
        return await waitWithSignal(local.promise, signal);
      } finally {
        local.waiters -= 1;
        if (local.waiters === 0) local.controller.abort(signal?.reason);
      }
    }
    const claim = options.cache.claim(cacheInput);
    if (!claim.owner) return waitWithSignal(claim.promise, signal);
    const controller = new AbortController();
    const entry = { promise: claim.promise, controller, waiters: 1 };
    queryInFlight.set(localKey, entry);
    const work = options.scheduler.enqueue("foreground", async () => {
      lifecycleController.signal.throwIfAborted();
      await embedder.prepare();
      lifecycleController.signal.throwIfAborted();
      const requestSignal = AbortSignal.any([lifecycleController.signal, controller.signal]);
      const vectors = await embedder.embed([text], { purpose: "query", signal: requestSignal });
      const vector = vectors[0];
      if (!vector || vector.length !== embedder.space.dim) throw new Error("Knowledge query embedding has an invalid dimension.");
      options.cache.set(cacheInput, vector);
      claim.resolve(vector);
      return vector;
    });
    const handledWork = work.then(() => undefined, (error) => { claim.reject(error); }).finally(() => {
      if (queryInFlight.get(localKey) === entry) queryInFlight.delete(localKey);
      activeQueryWorks.delete(handledWork);
    });
    activeQueryWorks.add(handledWork);
    void handledWork.catch(() => undefined);
    try {
      return await waitWithSignal(claim.promise, signal);
    } finally {
      entry.waiters -= 1;
      if (entry.waiters === 0) controller.abort(signal?.reason);
    }
  };

  const chunksFor = (item: Knowledge, embedder: SemanticEmbedder) => {
    const embedText = knowledgeEmbedText(item.content, item.trigger);
    return packPlainText({
      documentId: knowledgeDocumentId(item.id),
      text: embedText,
      maxTokens: embedder.space.maxTokens,
      countTokens: (text) => embedder.countTokens(text),
    });
  };

  const removeKnowledge = async (
    registration: Registration,
    store: KnowledgeVectorStore,
    id: NodeId,
    token?: number,
  ): Promise<void> => {
    const publishToken = token ?? nextToken(registration.scope, registration.scopeId, id);
    await store.removeDocument(knowledgeDocumentId(id), publishToken);
  };

  const publishKnowledge = async (
    registration: Registration,
    store: KnowledgeVectorStore,
    item: Knowledge,
    embedder: SemanticEmbedder,
  ): Promise<void> => {
    const revision = knowledgeContentRevision(item.content, item.trigger);
    const documentId = knowledgeDocumentId(item.id);
    const current = await store.publishedRevision(documentId);
    if (current?.revision === revision && current.recipeId === store.recipeId) return;
    const token = nextToken(registration.scope, registration.scopeId, item.id);
    const latest = await registration.authority.getKnowledge(item.id);
    if (!latest || !eligible(latest, registration.scope)
      || knowledgeContentRevision(latest.content, latest.trigger) !== revision) return;
    const chunks = chunksFor(latest, embedder);
    await store.publishDocument({ documentId, revision, chunks, publishToken: token }, lifecycleController.signal);
    if (currentToken(registration.scope, registration.scopeId, item.id) !== token) return;
    const after = await registration.authority.getKnowledge(item.id);
    if (!after || !eligible(after, registration.scope)
      || knowledgeContentRevision(after.content, after.trigger) !== revision) {
      await removeKnowledge(registration, store, item.id);
    }
  };

  const listAccepted = async (registration: Registration): Promise<Knowledge[]> => (
    (await registration.authority.listKnowledge({ status: "accepted", activeOnly: true }))
      .filter((item) => eligible(item, registration.scope))
  );

  const reconcileFull = async (
    registration: Registration,
    store: KnowledgeVectorStore,
    embedder: SemanticEmbedder,
    accepted: Knowledge[],
  ): Promise<void> => {
    const byId = new Map(accepted.map((item) => [item.id, item]));
    for (const documentId of await store.listDocumentIds()) {
      const id = Number(documentId);
      const current = Number.isSafeInteger(id) ? byId.get(id) : undefined;
      const published = current ? await store.publishedRevision(documentId) : null;
      if (!current || published?.revision !== knowledgeContentRevision(current.content, current.trigger)) {
        if (Number.isSafeInteger(id)) await removeKnowledge(registration, store, id);
        else await store.removeDocument(documentId);
      }
    }
    const publications = [] as Array<{
      documentId: string;
      revision: string;
      chunks: ReturnType<typeof chunksFor>;
      publishToken: number;
    }>;
    for (const item of accepted) {
      const current = await registration.authority.getKnowledge(item.id);
      if (!current || !eligible(current, registration.scope)) continue;
      const revision = knowledgeContentRevision(current.content, current.trigger);
      const published = await store.publishedRevision(knowledgeDocumentId(current.id));
      if (published?.revision === revision && published.recipeId === store.recipeId) continue;
      const token = nextToken(registration.scope, registration.scopeId, current.id);
      const latest = await registration.authority.getKnowledge(current.id);
      if (!latest || !eligible(latest, registration.scope)
        || knowledgeContentRevision(latest.content, latest.trigger) !== revision) continue;
      publications.push({
        documentId: knowledgeDocumentId(latest.id),
        revision,
        chunks: chunksFor(latest, embedder),
        publishToken: token,
      });
    }
    if (publications.length > 0) {
      await store.publishDocuments(publications, lifecycleController.signal);
      for (const publication of publications) {
        const id = Number(publication.documentId);
        if (!Number.isSafeInteger(id) || currentToken(registration.scope, registration.scopeId, id) !== publication.publishToken) continue;
        const current = await registration.authority.getKnowledge(id);
        if (!current || !eligible(current, registration.scope)
          || knowledgeContentRevision(current.content, current.trigger) !== publication.revision) {
          await removeKnowledge(registration, store, id);
        }
      }
    }
  };

  const reconcileRegistration = async (registration: Registration): Promise<void> => {
    const resolved = await waitWithSignal(
      options.resolveEmbedder(registration.workspaceId),
      lifecycleController.signal,
    );
    if (resolved.status !== "ready") {
      registration.status = statusForResolution(resolved);
      return;
    }
    const embedder = resolved.embedder;
    if (embedder.status !== "ready") {
      registration.status = "unavailable";
      return;
    }
    if (embedder.space.dim <= 0) {
      const candidates = registration.pendingFull
        ? await listAccepted(registration)
        : (await Promise.all([...registration.dirtyIds].map((id) => registration.authority.getKnowledge(id))))
          .filter((item): item is Knowledge => item !== null && eligible(item, registration.scope));
      const first = candidates[0];
      if (!first) {
        registration.status = "empty";
        return;
      }
      const firstChunk = chunksFor(first, embedder)[0];
      if (!firstChunk) {
        registration.status = "empty";
        return;
      }
      await ensureDimension(embedder, firstChunk.embedText, "document");
    }
    if (disposed || lifecycleController.signal.aborted || embedder.space.dim <= 0) return;
    const resolvedSpaceId = spaceIdOf(embedder.space);
    if (registration.spaceId !== undefined && registration.spaceId !== resolvedSpaceId) {
      registration.pendingFull = true;
      registration.dirtyIds.clear();
      registration.workVersion += 1;
    }
    registration.spaceId = resolvedSpaceId;
    const store = storeFor(registration.scope, registration.scopeId, embedder);
    const full = registration.pendingFull;
    const ids = [...registration.dirtyIds];
    registration.pendingFull = false;
    registration.dirtyIds.clear();
    await store.markBuilding(store.lifecycle === "ready" ? "rebuilding" : "building");
    const accepted = full ? await listAccepted(registration) : [];
    if (full) await reconcileFull(registration, store, embedder, accepted);
    else {
      for (const id of ids) {
        const current = await registration.authority.getKnowledge(id);
        if (current && eligible(current, registration.scope)) await publishKnowledge(registration, store, current, embedder);
        else await removeKnowledge(registration, store, id);
      }
    }
    const published = await store.listDocumentIds();
    await store.markReady(registration.pendingFull || registration.dirtyIds.size > 0 ? false : true);
    registration.status = published.length === 0 && accepted.length === 0 ? "empty" : "used";
  };

  const kick = (registration: Registration): void => {
    if (disposed) return;
    const key = registrationKey(registration.scope, registration.scopeId, registration.workspaceId);
    if (!registration.pendingFull && registration.dirtyIds.size === 0) return;
    if (builds.has(key)) return;
    const workVersion = registration.workVersion;
    const run = (async () => {
      registration.status = registration.status === "empty" ? "partial" : registration.status;
      try {
        await reconcileRegistration(registration);
      } catch (error) {
        if (!lifecycleController.signal.aborted && !disposed) {
          registration.status = "failed";
          reportError(error);
        }
      }
    })();
    builds.set(key, run);
    void run.then(() => undefined, () => undefined).finally(() => {
      if (builds.get(key) === run) builds.delete(key);
      if (!disposed && registration.workVersion !== workVersion) kick(registration);
    }).catch(() => undefined);
  };

  const searchScope = async (
    registration: Registration,
    embedder: SemanticEmbedder,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{ status: KnowledgeVectorStatus; spaceId?: string; hits: KnowledgeVectorHit[] }> => {
    if (disposed) return { status: "unavailable", hits: [] };
    const accepted = await listAccepted(registration);
    if (embedder.space.dim <= 0) {
      await ensureDimension(embedder, query, "query", signal);
    }
    if (embedder.space.dim <= 0) return { status: "failed", hits: [] };
    const spaceId = spaceIdOf(embedder.space);
    if (registration.spaceId !== undefined && registration.spaceId !== spaceId) {
      registration.pendingFull = true;
      registration.dirtyIds.clear();
      registration.workVersion += 1;
    }
    const retryingFailure = registration.status === "failed";
    if (registration.status === "failed" || registration.status === "unavailable" || registration.status === "unconfigured") {
      registration.pendingFull = true;
      registration.dirtyIds.clear();
      registration.workVersion += 1;
    }
    registration.spaceId = spaceId;
    if (disposed) return { status: "unavailable", hits: [] };
    const store = storeFor(registration.scope, registration.scopeId, embedder);
    kick(registration);
    if (accepted.length === 0) return { status: "empty", spaceId, hits: [] };
    const queryVector = await embedQuery(embedder, query, signal);
    const publishedIds = await store.listDocumentIds();
    const byDocument = new Map(accepted.map((item) => [knowledgeDocumentId(item.id), item]));
    const validDocuments = new Set<string>();
    for (const documentId of publishedIds) {
      const item = byDocument.get(documentId);
      const published = item ? await store.publishedRevision(documentId) : null;
      if (item && published?.revision === knowledgeContentRevision(item.content, item.trigger)) validDocuments.add(documentId);
    }
    const maskPaths = publishedIds.filter((documentId) => !validDocuments.has(documentId));
    if (validDocuments.size === 0) {
      return { status: "partial", spaceId, hits: [] };
    }
    const semanticHits = await store.search(queryVector, Number.MAX_SAFE_INTEGER, { maskPaths });
    const bestByKnowledge = new Map<number, { revision: string; similarity: number }>();
    for (const hit of semanticHits) {
      const id = Number(hit.documentId);
      if (!Number.isSafeInteger(id) || !validDocuments.has(hit.documentId)) continue;
      const item = byDocument.get(hit.documentId);
      if (!item || hit.revision !== knowledgeContentRevision(item.content, item.trigger)) continue;
      const previous = bestByKnowledge.get(id);
      if (!previous || hit.similarity > previous.similarity) {
        bestByKnowledge.set(id, { revision: hit.revision, similarity: hit.similarity });
      }
    }
    const hits = [...bestByKnowledge.entries()]
      .sort((left, right) => right[1].similarity - left[1].similarity || left[0] - right[0])
      .slice(0, limit)
      .map(([knowledgeId, value], index) => ({
        knowledgeId,
        contentRevision: value.revision,
        similarity: value.similarity,
        rank: index + 1,
        spaceId,
      }));
    const building = builds.has(registrationKey(registration.scope, registration.scopeId, registration.workspaceId))
      || registration.pendingFull || registration.dirtyIds.size > 0;
    return {
      status: retryingFailure ? "failed" : building || validDocuments.size < accepted.length ? "partial" : "used",
      spaceId,
      hits,
    };
  };

  const resolveAndSearch = async (
    scopes: readonly KnowledgeVectorScopeSearch[],
    workspaceId: string,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Array<{ scope: KnowledgeScope; result: Awaited<ReturnType<typeof searchScope>> }>> => {
    if (disposed) return scopes.map((scope) => ({ scope: scope.scope, result: { status: "unavailable", hits: [] } }));
    const resolveSignal = signal
      ? AbortSignal.any([signal, lifecycleController.signal])
      : lifecycleController.signal;
    const resolved = await waitWithSignal(options.resolveEmbedder(workspaceId), resolveSignal);
    if (disposed) return scopes.map((scope) => ({ scope: scope.scope, result: { status: "unavailable", hits: [] } }));
    if (resolved.status !== "ready" || resolved.embedder.status !== "ready") {
      const status = resolved.status === "ready" ? "unavailable" : statusForResolution(resolved);
      return scopes.map((scope) => ({ scope: scope.scope, result: { status, hits: [] } }));
    }
    const embedder = resolved.embedder;
    const result: Array<{ scope: KnowledgeScope; result: Awaited<ReturnType<typeof searchScope>> }> = [];
    for (const scope of scopes) {
      const registration = registrationFor(scope.authority, scope.scope, scope.scopeId, workspaceId);
      try {
        result.push({ scope: scope.scope, result: await searchScope(registration, embedder, query, limit, signal) });
      } catch (error) {
        if (signal?.aborted) throw error;
        reportError(error);
        result.push({ scope: scope.scope, result: { status: "failed", hits: [] } });
      }
    }
    return result;
  };

  const search = async (input: {
    authority: KnowledgeStore;
    scope: KnowledgeScope;
    scopeId: string;
    workspaceId: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<{ status: KnowledgeVectorStatus; spaceId?: string; hits: KnowledgeVectorHit[] }> => {
    return trackSearch((async () => {
      if (disposed) return { status: "unavailable", hits: [] };
      try {
        const [result] = await resolveAndSearch([input], input.workspaceId, input.query, input.limit, input.signal);
        return result?.result ?? { status: "failed", hits: [] };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        reportError(error);
        return { status: "failed", hits: [] };
      }
    })());
  };

  const searchScopes = async (input: {
    scopes: readonly KnowledgeVectorScopeSearch[];
    workspaceId: string;
    query: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<Array<{ scope: KnowledgeScope; result: Awaited<ReturnType<typeof searchScope>> }>> => {
    return trackSearch((async () => {
      if (disposed) return input.scopes.map((scope) => ({ scope: scope.scope, result: { status: "unavailable", hits: [] } }));
      try {
        return await resolveAndSearch(input.scopes, input.workspaceId, input.query, input.limit, input.signal);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        reportError(error);
        return input.scopes.map((scope) => ({ scope: scope.scope, result: { status: "failed", hits: [] } }));
      }
    })());
  };

  const notify = (
    authority: KnowledgeStore,
    scope: KnowledgeScope,
    scopeId: string,
    workspaceId: string | undefined,
    ids: readonly NodeId[],
  ): void => {
    if (disposed) return;
    const targets = [...registrations.values()].filter((registration) => (
      registration.authority === authority
      && registration.scope === scope
      && registration.scopeId === scopeId
      && (workspaceId === undefined ? scope === "user" : registration.workspaceId === workspaceId)
    ));
    if (targets.length === 0 && workspaceId !== undefined) {
      targets.push(registrationFor(authority, scope, scopeId, workspaceId));
    }
    for (const registration of targets) {
      for (const id of new Set(ids)) {
        registration.dirtyIds.add(id);
        registration.workVersion += 1;
        const token = nextToken(scope, scopeId, id);
        for (const [key, store] of stores) {
          if (!key.startsWith(`${scope}\0${scopeId}\0`)) continue;
          void store.removeDocument(knowledgeDocumentId(id), token).catch((error) => reportError(error));
        }
      }
      kick(registration);
    }
  };

  const scheduleReconcile = (
    authority: KnowledgeStore,
    scope: KnowledgeScope,
    scopeId: string,
    workspaceId: string,
  ): void => {
    if (disposed) return;
    const registration = registrationFor(authority, scope, scopeId, workspaceId);
    kick(registration);
  };

  const refreshWorkspace = (workspaceId: string): void => {
    if (disposed) return;
    for (const registration of registrations.values()) {
      if (registration.workspaceId !== workspaceId) continue;
      registration.pendingFull = true;
      registration.dirtyIds.clear();
      registration.workVersion += 1;
      kick(registration);
    }
  };

  // The embedding binding is global: a change under the shared inference scope
  // invalidates every registration, regardless of its owning scope.
  const refreshAll = (): void => {
    if (disposed) return;
    for (const registration of registrations.values()) {
      registration.pendingFull = true;
      registration.dirtyIds.clear();
      registration.workVersion += 1;
      kick(registration);
    }
  };

  const waitForBuild = (scope: KnowledgeScope, scopeId: string, workspaceId: string): Promise<void> => (
    builds.get(registrationKey(scope, scopeId, workspaceId)) ?? Promise.resolve()
  );

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    disposed = true;
    lifecycleController.abort();
    closePromise = (async () => {
      await Promise.allSettled([
        ...builds.values(),
        ...activeSearches,
        ...activeQueryWorks,
      ]);
      await Promise.allSettled([...stores.values()].map((store) => store.close()));
      stores.clear();
      registrations.clear();
      builds.clear();
    })();
    return closePromise;
  };

  return {
    scheduleReconcile,
    notify,
    refreshWorkspace,
    refreshAll,
    search,
    searchScopes,
    waitForBuild,
    close,
  };
}

export type KnowledgeVectorRuntime = ReturnType<typeof createKnowledgeVectorRuntime>;
