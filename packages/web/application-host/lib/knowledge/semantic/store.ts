/** Embedding orchestration stays in the Host; all native index work is owned by
 * the private semantic storage process, including recovery and checkpoints. */
import { knowledgeStoreProcess } from "../store-process.js";
import { readSemanticCheckpoint } from "./checkpoint.js";
import { defaultRecipeIdentity, recipeIdOf, semanticSpaceDir, spaceIdOf,
  type IndexRecipeIdentity, type SemanticScopeKey, type VectorSpaceIdentity } from "./identity.js";
import { createVectorCache, type SemanticVectorCache } from "./vector-cache.js";
import { embedInScheduledBatches, type EmbedPriority, type EmbedScheduler } from "./embed-scheduler.js";
import type { SemanticEmbedder } from "./embedder.js";
import { waitWithSignal } from "../../cancellation.js";
import type { SemanticStoreMethod } from "./store-protocol.js";
import type { SemanticCheckpoint, SemanticDocumentPublication, SemanticHit, SemanticSearchOptions,
  SemanticDocumentState, SemanticSourceMetadataUpdate, SemanticDocumentExpectation, SemanticDocumentScores,
  SemanticPublishedReader, SemanticPublishedReaderStats } from "./store-contract.js";
export type { SemanticIndexLifecycle, SemanticQueryCoverage, SemanticHit, SemanticCheckpoint,
  SemanticDocumentPublication, SemanticOverlayBlock, SemanticSearchOptions,
  SemanticPublishedReader, SemanticPublishedReaderStats } from "./store-contract.js";
export { readSemanticCheckpoint } from "./checkpoint.js";

export function createSemanticGenerationStore(options: {
  dataDir: string; hostId: string; scope: SemanticScopeKey; embedder: SemanticEmbedder;
  recipe?: IndexRecipeIdentity; vectorCache?: SemanticVectorCache;
  scheduler?: EmbedScheduler; embedPriority?: EmbedPriority;
}) {
  const space = { ...options.embedder.space };
  let embedder = options.embedder;
  const spaceId = spaceIdOf(space);
  const recipeId = recipeIdOf(options.recipe ?? defaultRecipeIdentity());
  let checkpoint = readSemanticCheckpoint(semanticSpaceDir(options.dataDir, options.hostId, options.scope, spaceId));
  const vectorCache = options.vectorCache ?? createVectorCache();
  const latestPublish = new Map<string, number>();
  const pending = new Set<Promise<unknown>>();
  const retainedReaders = new Set<string>();
  let owner: ReturnType<typeof knowledgeStoreProcess> | null = null;
  let storeId = 0;
  let openTask: Promise<void> | null = null;
  let initialized = false;
  let initializationFailed = false;
  let closed = false;
  let closing: Promise<void> | null = null;

  const open = (): Promise<void> => {
    if (openTask) return openTask;
    owner = knowledgeStoreProcess("semantic");
    storeId = owner.register({ revision: () => {}, notify: message => {
      if (message.type === "persistence-error") console.error("[SemanticStore] Deferred checkpoint failed; pending data retained for retry");
    } });
    const activeOwner = owner;
    openTask = activeOwner.request(storeId, "semantic", ["open", {
      dataDir: options.dataDir, hostId: options.hostId, scope: options.scope, space, recipe: options.recipe,
    }]).then(result => {
      checkpoint = (result as { checkpoint: SemanticCheckpoint | null }).checkpoint;
      initialized = true;
    }).catch(async error => {
      initializationFailed = true;
      await activeOwner.release(storeId);
      throw error;
    });
    return openTask;
  };
  const call = async <T>(method: SemanticStoreMethod, args: unknown[], signal?: AbortSignal): Promise<T> => {
    await open();
    const result = await owner!.request(storeId, "semantic", [method, ...args], signal) as {
      value: T; checkpoint: SemanticCheckpoint | null;
    };
    checkpoint = result.checkpoint;
    return result.value;
  };
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed || closing) return Promise.reject(new Error("Semantic store is closing or closed"));
    const task = Promise.resolve().then(work);
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };

  const publishDocuments = (inputs: readonly SemanticDocumentPublication[], signal?: AbortSignal): Promise<void> => {
    if (closed || closing) return Promise.reject(new Error("Semantic store is closing or closed"));
    // Same-space credential/binding changes affect future admissions only.
    const admittedEmbedder = embedder;
    if (admittedEmbedder.status !== "ready" || inputs.length === 0) return Promise.resolve();
    const byDocument = new Map<string, SemanticDocumentPublication>();
    for (const input of inputs) {
      const token = input.publishToken ?? 0;
      if (token < (latestPublish.get(input.documentId) ?? 0)) continue;
      latestPublish.set(input.documentId, token);
      byDocument.set(input.documentId, structuredClone(input));
    }
    const publications = [...byDocument.values()];
    if (publications.length === 0) return Promise.resolve();
    return track(async () => {
      signal?.throwIfAborted();
      await admittedEmbedder.prepare();
      const chunks = publications.flatMap(input => input.chunks);
      const reused = await call<Array<number[] | undefined>>("lookupVectors", [chunks.map(chunk => chunk.embedText)], signal);
      const claims: Array<ReturnType<SemanticVectorCache["claim"]> | undefined> = [];
      const owners: Array<{ claim: ReturnType<SemanticVectorCache["claim"]>; text: string }> = [];
      for (const [index, chunk] of chunks.entries()) {
        if (reused[index]) continue;
        const claim = vectorCache.claim({ spaceId, purpose: "document", embedText: chunk.embedText });
        claims[index] = claim;
        if (claim.owner) owners.push({ claim, text: chunk.embedText });
      }
      try {
        if (owners.length > 0) {
          const fresh = await embedInScheduledBatches({ embedder: admittedEmbedder,
            texts: owners.map(owner => owner.text), ...(options.scheduler ? { scheduler: options.scheduler } : {}),
            priority: options.embedPriority ?? "background", purpose: "document", ...(signal ? { signal } : {}) });
          if (fresh.length !== owners.length || fresh.some(vector => vector.length !== space.dim || vector.some(value => !Number.isFinite(value)))) {
            throw new Error(`Semantic embedder returned ${fresh.length} vectors for ${owners.length} chunks in ${space.dim} dimensions.`);
          }
          for (const [index, entry] of owners.entries()) {
            vectorCache.set({ spaceId, purpose: "document", embedText: entry.text }, fresh[index]!);
            entry.claim.resolve(fresh[index]!);
          }
        }
      } catch (error) {
        for (const entry of owners) entry.claim.reject(error);
        await Promise.allSettled(owners.map(entry => entry.claim.promise));
        throw error;
      }
      for (const [index, claim] of claims.entries()) {
        if (claim) reused[index] = await waitWithSignal(claim.promise, signal);
      }
      signal?.throwIfAborted();
      const vectors = reused.map((vector, index) => {
        if (!vector) throw new Error(`Semantic embedder missed a vector for chunk ${index}.`);
        return vector;
      });
      let offset = 0;
      const prepared = publications.flatMap(input => {
        const selected = vectors.slice(offset, offset + input.chunks.length);
        offset += input.chunks.length;
        return (latestPublish.get(input.documentId) ?? 0) > (input.publishToken ?? 0) ? [] : [{ ...input, vectors: selected }];
      });
      if (prepared.length > 0) await call<void>("publishDocuments", [prepared], signal);
    });
  };

  const assertPublishedReaderAvailable = (token: string): void => {
    if (closed || closing || owner?.failed || !retainedReaders.has(token)) {
      throw new Error("Semantic reader is no longer available");
    }
  };
  const releasePinned = (token: string): Promise<void> => {
    if (!retainedReaders.delete(token)) return Promise.resolve();
    // Close owns all still-retained native handles, including a raced release.
    if (closed || closing || owner?.failed) return closing ?? Promise.resolve();
    return track(() => call<void>("releasePinned", [token]));
  };
  const retainPublished = (signal?: AbortSignal): Promise<SemanticPublishedReader | null> => {
    const acquisition = track(async () => {
      signal?.throwIfAborted();
      if (initializationFailed || owner?.failed) throw new Error("Semantic storage owner is unavailable");
      // Initialization may recover and checkpoint existing data. Only the
      // background/explicit ready path may start or await that work; a query
      // acquires the currently available publication or reports a cold source.
      if (!initialized) return null;
      const reader = await call<SemanticPublishedReader | null>("retainPublished", [], signal);
      // IPC may already have admitted an acquire when cancellation or close
      // arrives. Observe its late result and release it before ending this task.
      if (reader && (signal?.aborted || closed || closing)) {
        await call<void>("releasePinned", [reader.token]);
        signal?.throwIfAborted();
        throw new Error("Semantic store is closing or closed");
      }
      signal?.throwIfAborted();
      if (reader) retainedReaders.add(reader.token);
      return reader;
    });
    return waitWithSignal(acquisition, signal).catch(error => {
      // Also cover cancellation between adoption and resolving the caller's
      // wait. The full acquisition remains tracked until late cleanup finishes.
      void acquisition.then(reader => reader ? releasePinned(reader.token) : undefined).catch(() => {});
      throw error;
    });
  };

  return {
    scope: options.scope, space, spaceId, recipeId,
    get lifecycle() { return checkpoint?.lifecycle ?? "idle"; },
    get coverage() { return checkpoint?.coverage ?? "empty"; },
    get generation() { return checkpoint?.generation ?? "g1"; },
    checkpoint: (): SemanticCheckpoint | null => checkpoint ? { ...checkpoint } : null,
    setEmbedder(next: SemanticEmbedder): void {
      if (closed || closing) throw new Error("Semantic store is closing or closed");
      if (spaceIdOf(next.space) !== spaceId) throw new Error("Semantic embedder vector space changed");
      embedder = next;
    },
    ready: (): Promise<void> => track(open),
    markBuilding: (kind: "building" | "rebuilding"): Promise<void> => track(() => call("markBuilding", [kind])),
    markReady: (complete: boolean): Promise<void> => track(() => call("markReady", [complete])),
    publishedRevision: (documentId: string): Promise<{ revision: string; recipeId: string } | null> =>
      track(() => call("publishedRevision", [documentId])),
    publishDocument: (input: SemanticDocumentPublication, signal?: AbortSignal) => publishDocuments([input], signal),
    publishDocuments,
    listDocumentIds: (): Promise<string[]> => track(() => call("listDocumentIds", [])),
    listDocumentStates: (): Promise<SemanticDocumentState[]> => track(() => call("listDocumentStates", [])),
    recordSourceMetadata: (updates: readonly SemanticSourceMetadataUpdate[], signal?: AbortSignal): Promise<void> =>
      track(() => call("recordSourceMetadata", [updates], signal)),
    removeDocument: (documentId: string, publishToken?: number): Promise<void> => {
      const token = publishToken ?? ((latestPublish.get(documentId) ?? 0) + 1);
      latestPublish.set(documentId, Math.max(latestPublish.get(documentId) ?? 0, token));
      return track(() => call("removeDocument", [documentId, token]));
    },
    search: (query: number[], limit: number, searchOptions?: readonly string[] | SemanticSearchOptions): Promise<SemanticHit[]> =>
      track(() => call("search", [query, limit, searchOptions])),
    retainPublished,
    assertPublishedReaderAvailable,
    searchPinned: (token: string, query: number[], limit: number,
      searchOptions?: readonly string[] | SemanticSearchOptions, signal?: AbortSignal): Promise<SemanticHit[]> =>
      track(() => {
        assertPublishedReaderAvailable(token);
        return call("searchPinned", [token, query, limit, searchOptions], signal);
      }),
    releasePinned,
    publishedReaderStats: (): Promise<SemanticPublishedReaderStats> => closed
      ? Promise.resolve({ activeReaders: 0, retainedPublications: 0 })
      : track(() => call("publishedReaderStats", [])),
    searchDocumentScores: (query: number[], documents: readonly SemanticDocumentExpectation[], limit: number,
      signal?: AbortSignal): Promise<SemanticDocumentScores> =>
      track(() => call("searchDocumentScores", [query, documents, limit], signal)),
    close: (): Promise<void> => {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      retainedReaders.clear();
      closing = (async () => {
        await Promise.allSettled([...pending]);
        if (openTask && !initializationFailed) {
          try {
            await openTask;
            await call("close", []);
          } catch (error) {
            if (owner?.failed) {
              closed = true;
              await owner.release(storeId);
            }
            throw error;
          }
          await owner!.release(storeId);
        }
        closed = true;
      })().catch(error => { closing = null; throw error; });
      return closing;
    },
  };
}
export type SemanticGenerationStore = ReturnType<typeof createSemanticGenerationStore>;
export const spaceIdentityOf = (space: VectorSpaceIdentity): string => spaceIdOf(space);
