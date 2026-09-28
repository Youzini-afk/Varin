import { createStorePersistence, trackStoreMutations } from "../persistence.js";
/**
 * Independent semantic generation store. Not the authoritative workspace .tdb
 * (that file locks a single dim at open). Host is the only writer.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  defaultRecipeIdentity,
  recipeIdOf,
  semanticGenerationDir,
  semanticSpaceDir,
  spaceIdOf,
  type IndexRecipeIdentity,
  type SemanticScopeKey,
  type VectorSpaceIdentity,
} from "./identity.js";
import { cosineSimilarity, type SemanticEmbedder, type SemanticEmbedPurpose } from "./embedder.js";
import type { SemanticChunk } from "./chunker.js";
import { pathInRoots, rootsAreRestricted } from "../../workspace/path-scope.js";
import { embedTextKey } from "./identity.js";
import { createVectorCache, type SemanticVectorCache } from "./vector-cache.js";
import { waitWithSignal } from "./cancellation.js";
import type { EmbedPriority, EmbedScheduler } from "./embed-scheduler.js";

const require = createRequire(import.meta.url);
const { TriviumDB } = require("triviumdb") as typeof import("triviumdb");

const FLUSH_QUIET_MS = 250;
const FLUSH_MAX_DEFER_MS = 30_000;

export type SemanticIndexLifecycle = "idle" | "building" | "rebuilding" | "ready";
export type SemanticQueryCoverage = "empty" | "partial" | "complete";

export type SemanticHit = {
  documentId: string;
  revision: string;
  blockId: string;
  parentUnitId: string;
  parentName: string;
  parentKind: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  fallback: boolean;
  body: string;
  similarity: number;
  rank: number;
  scope: SemanticScopeKey;
  spaceId: string;
  generation: string;
};

export type SemanticCheckpoint = {
  generation: string;
  spaceId: string;
  recipeId: string;
  lifecycle: SemanticIndexLifecycle;
  coverage: SemanticQueryCoverage;
  publishedDocuments: number;
};

type BlockPayload = {
  type: "block";
  documentId: string;
  revision: string;
  blockId: string;
  parentUnitId: string;
  parentName: string;
  parentKind: string;
  parentSignature: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  fallback: boolean;
  body: string;
  embedText: string;
  embedKey: string;
};

type DocumentPayload = {
  type: "document";
  documentId: string;
  revision: string;
  recipeId: string;
  blockCount: number;
};

export type SemanticDocumentPublication = {
  documentId: string;
  revision: string;
  chunks: readonly SemanticChunk[];
  /** Monotonic per-document token. A lower token cannot overwrite a higher one. */
  publishToken?: number;
};

export type SemanticOverlayBlock = {
  documentId: string;
  revision: string;
  blockId: string;
  parentUnitId: string;
  parentName: string;
  parentKind: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  fallback: boolean;
  body: string;
  vector: number[];
};

export type SemanticSearchOptions = {
  roots?: readonly string[];
  maskPaths?: readonly string[];
  extras?: readonly SemanticOverlayBlock[];
  disk?: boolean;
};

const isRootList = (value: readonly string[] | SemanticSearchOptions): value is readonly string[] => (
  Array.isArray(value)
);

const resolveSemanticSearchOptions = (
  rootsOrOptions?: readonly string[] | SemanticSearchOptions,
): SemanticSearchOptions => {
  if (rootsOrOptions === undefined) return {};
  if (isRootList(rootsOrOptions)) return { roots: rootsOrOptions };
  return rootsOrOptions;
};

const checkpointPath = (spaceDir: string): string => join(spaceDir, "current.json");

export const readSemanticCheckpoint = (spaceDir: string): SemanticCheckpoint | null => {
  try {
    const raw = JSON.parse(readFileSync(checkpointPath(spaceDir), "utf8")) as SemanticCheckpoint;
    if (!raw.generation || !raw.spaceId || !raw.recipeId) return null;
    return raw;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const writeCheckpoint = (spaceDir: string, checkpoint: SemanticCheckpoint): void => {
  mkdirSync(spaceDir, { recursive: true });
  const target = checkpointPath(spaceDir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(checkpoint)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, target);
};

const openDb = (file: string, dim: number, accessMode: "readWrite" | "readOnly") => {
  const db = new TriviumDB(file, {
    dim,
    syncMode: "normal",
    loadTextIndex: false,
    // Derived generations are scanned and replaced in batches; keep parsed
    // payload memory out of each open generation until its workload warrants it.
    payloadCacheMb: 0,
    accessMode,
  });
  if (accessMode === "readWrite") {
    db.createIndex("type");
    db.createIndex("documentId");
    db.createIndex("blockId");
    db.createIndex("embedKey");
  }
  return db;
};

export function createSemanticGenerationStore(options: {
  dataDir: string;
  hostId: string;
  scope: SemanticScopeKey;
  embedder: SemanticEmbedder;
  recipe?: IndexRecipeIdentity;
  vectorCache?: SemanticVectorCache;
  scheduler?: EmbedScheduler;
  embedPriority?: EmbedPriority;
}) {
  const space = options.embedder.space;
  const spaceId = spaceIdOf(space);
  const vectorCache = options.vectorCache ?? createVectorCache();
  const latestPublish = new Map<string, number>();
  const recipe = options.recipe ?? defaultRecipeIdentity();
  const recipeId = recipeIdOf(recipe);
  const spaceDir = semanticSpaceDir(options.dataDir, options.hostId, options.scope, spaceId);
  let checkpoint = readSemanticCheckpoint(spaceDir);
  const generation = checkpoint?.generation ?? "g1";
  let lifecycle: SemanticIndexLifecycle = checkpoint?.lifecycle ?? "idle";
  let coverage: SemanticQueryCoverage = checkpoint?.coverage ?? "empty";
  const dbFile = () => join(semanticGenerationDir(options.dataDir, options.hostId, options.scope, spaceId, generation), "index.tdb");
  const maximumLookupResults = (db: InstanceType<typeof TriviumDB>): number => Math.max(1, db.nodeCount());
  let writer: InstanceType<typeof TriviumDB> | null = null;
  const countStoredDocuments = (): number => {
    if (!existsSync(dbFile())) return 0;
    // Host is the sole writer. A previous process may have left WAL recovery
    // pending, which readOnly rejects, so recover once here and keep this writer
    // for the scan's revision lookups instead of reopening the database per file.
    const db = openDb(dbFile(), space.dim, "readWrite");
    try {
      const count = db.indexedLookup({ type: "document" }, maximumLookupResults(db)).length;
      writer = db;
      return count;
    } catch (error) {
      db.close();
      throw error;
    }
  };
  // A checkpoint can lag the WAL when the process stops between a database
  // transaction and current.json. Reconcile once on open, then maintain the
  // count from each committed document replacement/removal.
  let publishedDocuments = 0;
  let writeTail: Promise<void> = Promise.resolve();
  let closeTask: Promise<void> | null = null;
  let disposed = false;
  // Scoped vector searches use the native graph-first exact search over block
  // IDs. Build the document -> block ID map lazily, then update only affected
  // document entries after publication/removal so stale candidates cannot
  // survive an index mutation.
  let documentBlockIdsCache: Map<string, number[]> | null = null;

  const enqueue = <T>(work: () => T): Promise<T> => {
    if (disposed || closeTask) return Promise.reject(new Error("Semantic store is closing or closed"));
    const admitted = (): T => { persistence.recover(); return work(); };
    const run = writeTail.then(admitted, admitted);
    writeTail = run.then(() => undefined, () => undefined);
    return run;
  };
  const persistence = createStorePersistence({
    flush: () => writer?.flush(),
    close: () => writer?.close(),
    enqueue,
    quietMs: FLUSH_QUIET_MS,
    maxDeferMs: FLUSH_MAX_DEFER_MS,
    onError: () => console.error("[SemanticStore] Deferred checkpoint failed; pending data retained for retry"),
  });
  publishedDocuments = countStoredDocuments();
  if (writer) writer = trackStoreMutations(writer, persistence);
  const scheduleFlush = (): void => persistence.defer();

  const refreshCheckpoint = (): SemanticCheckpoint => {
    const refreshed: SemanticCheckpoint = {
      generation,
      spaceId,
      recipeId,
      lifecycle,
      coverage,
      publishedDocuments,
    };
    checkpoint = refreshed;
    return refreshed;
  };

  const persistCheckpoint = (): void => {
    writeCheckpoint(spaceDir, refreshCheckpoint());
  };

  const ensureWriter = (): InstanceType<typeof TriviumDB> => {
    if (writer) return writer;
    mkdirSync(semanticGenerationDir(options.dataDir, options.hostId, options.scope, spaceId, generation), { recursive: true });
    writer = trackStoreMutations(openDb(dbFile(), space.dim, "readWrite"), persistence);
    return writer;
  };

  const lookupDocuments = (db: InstanceType<typeof TriviumDB>, documentId: string): number[] => (
    db.indexedLookup({ type: "document", documentId }, maximumLookupResults(db))
  );

  const lookupBlocks = (db: InstanceType<typeof TriviumDB>, documentId: string): number[] => (
    db.indexedLookup({ type: "block", documentId }, maximumLookupResults(db))
  );

  const documentBlockIds = (db: InstanceType<typeof TriviumDB>): Map<string, number[]> => {
    if (documentBlockIdsCache) return documentBlockIdsCache;
    const indexed = new Map<string, number[]>();
    // One block-index pass avoids one native lookup per document on the first
    // scoped query. The cache is then maintained incrementally by writes.
    for (const id of db.indexedLookup({ type: "block" }, maximumLookupResults(db))) {
      const payload = db.getPayload(id) as BlockPayload | null;
      if (!payload || payload.type !== "block" || typeof payload.documentId !== "string") continue;
      const ids = indexed.get(payload.documentId);
      if (ids) ids.push(id);
      else indexed.set(payload.documentId, [id]);
    }
    documentBlockIdsCache = indexed;
    return indexed;
  };

  const lookupVectorByEmbedText = (db: InstanceType<typeof TriviumDB> | null, embedText: string): number[] | undefined => {
    const cached = vectorCache.get({ spaceId, purpose: "document", embedText });
    if (cached) return cached;
    if (!db) return undefined;
    const ids = db.indexedLookup(
      { type: "block", embedKey: embedTextKey(embedText) },
      maximumLookupResults(db),
    );
    for (const id of ids) {
      const payload = db.getPayload(id) as BlockPayload | null;
      if (payload?.type !== "block" || payload.embedText !== embedText) continue;
      const node = db.get(id);
      if (!node || !Array.isArray(node.vector) || node.vector.length !== space.dim) continue;
      vectorCache.set({ spaceId, purpose: "document", embedText }, node.vector);
      return node.vector;
    }
    return undefined;
  };

  const embedMissing = async (
    texts: readonly string[],
    purpose: SemanticEmbedPurpose,
    signal?: AbortSignal,
  ): Promise<number[][]> => {
    if (texts.length === 0) return [];
    const run = async (): Promise<number[][]> => {
      signal?.throwIfAborted();
      await options.embedder.prepare();
      signal?.throwIfAborted();
      const vectors = await options.embedder.embed(texts, { purpose, ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      if (vectors.length !== texts.length || vectors.some((vector) => vector.length !== space.dim)) {
        throw new Error(`Semantic embedder returned ${vectors.length} vectors for ${texts.length} chunks in ${space.dim} dimensions.`);
      }
      return vectors;
    };
    return options.scheduler
      ? options.scheduler.enqueue(options.embedPriority ?? "background", run)
      : run();
  };

  const publishDocuments = async (
    inputs: readonly SemanticDocumentPublication[],
    signal?: AbortSignal,
  ): Promise<void> => {
    if (options.embedder.status !== "ready" || inputs.length === 0) return;
    const publicationsByDocument = new Map<string, SemanticDocumentPublication>();
    for (const input of inputs) {
      const token = input.publishToken ?? 0;
      const latest = latestPublish.get(input.documentId) ?? 0;
      if (token < latest) continue;
      latestPublish.set(input.documentId, token);
      publicationsByDocument.set(input.documentId, input);
    }
    const publications = [...publicationsByDocument.values()];
    if (publications.length === 0) return;
    signal?.throwIfAborted();
    await options.embedder.prepare();
    signal?.throwIfAborted();
    const dbForReuse = writer ?? (existsSync(dbFile()) ? ensureWriter() : null);
    const chunks = publications.flatMap((input) => input.chunks);
    const reused = new Array<number[] | undefined>(chunks.length);
    const claims: Array<ReturnType<SemanticVectorCache["claim"]> | undefined> = new Array(chunks.length);
    const owners: Array<{ claim: ReturnType<SemanticVectorCache["claim"]>; text: string }> = [];
    for (const [index, chunk] of chunks.entries()) {
      const existing = lookupVectorByEmbedText(dbForReuse, chunk.embedText);
      if (existing) reused[index] = existing;
      else {
        const claim = vectorCache.claim({ spaceId, purpose: "document", embedText: chunk.embedText });
        claims[index] = claim;
        if (claim.owner) owners.push({ claim, text: chunk.embedText });
      }
    }
    try {
      const fresh = await embedMissing(owners.map((owner) => owner.text), "document", signal);
      for (const [index, owner] of owners.entries()) {
        const vector = fresh[index]!;
        vectorCache.set({ spaceId, purpose: "document", embedText: owner.text }, vector);
        owner.claim.resolve(vector);
      }
    } catch (error) {
      for (const owner of owners) owner.claim.reject(error);
      await Promise.allSettled(owners.map((owner) => owner.claim.promise));
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
    if (vectors.length !== chunks.length || vectors.some((vector) => vector.length !== space.dim)) {
      throw new Error(`Semantic embedder returned ${vectors.length} vectors for ${chunks.length} chunks in ${space.dim} dimensions.`);
    }
    await enqueue(() => {
      signal?.throwIfAborted();
      const db = ensureWriter();
      const operations: import("triviumdb").TransactionOperation[] = [];
      const emptyVector = new Array(space.dim).fill(0);
      let vectorIndex = 0;
      let documentDelta = 0;
      for (const input of publications) {
        const token = input.publishToken ?? 0;
        if ((latestPublish.get(input.documentId) ?? 0) > token) {
          vectorIndex += input.chunks.length;
          continue;
        }
        const oldBlocks = lookupBlocks(db, input.documentId);
        const oldDocuments = lookupDocuments(db, input.documentId);
        documentDelta += 1 - oldDocuments.length;
        for (const id of [...oldBlocks, ...oldDocuments]) operations.push({ type: "delete", id });
        for (const chunk of input.chunks) {
          const payload: BlockPayload = {
            type: "block",
            documentId: input.documentId,
            revision: input.revision,
            blockId: chunk.blockId,
            parentUnitId: chunk.parentUnitId,
            parentName: chunk.parentName,
            parentKind: chunk.parentKind,
            parentSignature: chunk.parentSignature,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            contentHash: chunk.contentHash,
            fallback: chunk.fallback,
            body: chunk.body,
            embedText: chunk.embedText,
            embedKey: embedTextKey(chunk.embedText),
          };
          operations.push({ type: "insert", vector: vectors[vectorIndex]!, payload });
          vectorIndex += 1;
        }
        const document: DocumentPayload = {
          type: "document",
          documentId: input.documentId,
          revision: input.revision,
          recipeId,
          blockCount: input.chunks.length,
        };
        operations.push({ type: "insert", vector: emptyVector, payload: document });
      }
      db.commitTransaction(operations);
      if (documentBlockIdsCache) {
        for (const input of publications) {
          documentBlockIdsCache.set(input.documentId, lookupBlocks(db, input.documentId));
        }
      }
      publishedDocuments += documentDelta;
      const priorLifecycle = lifecycle;
      const priorCoverage = coverage;
      if (lifecycle === "idle") lifecycle = "building";
      if (coverage === "empty") coverage = "partial";
      scheduleFlush();
      if (documentDelta !== 0 || lifecycle !== priorLifecycle || coverage !== priorCoverage) persistCheckpoint();
      else refreshCheckpoint();
    });
  };

  return {
    scope: options.scope,
    space,
    spaceId,
    recipeId,
    get lifecycle() { return lifecycle; },
    get coverage() { return coverage; },
    get generation() { return generation; },
    checkpoint(): SemanticCheckpoint | null {
      if (!checkpoint) return null;
      refreshCheckpoint();
      return { ...checkpoint };
    },
    markBuilding(kind: "building" | "rebuilding"): void {
      lifecycle = kind;
      if (coverage === "empty") coverage = "partial";
      persistCheckpoint();
    },
    markReady(complete: boolean): void {
      lifecycle = "ready";
      coverage = complete ? "complete" : (publishedDocuments > 0 ? "partial" : "empty");
      persistCheckpoint();
    },
    async publishedRevision(documentId: string): Promise<{ revision: string; recipeId: string } | null> {
      return enqueue(() => {
        if (!existsSync(dbFile()) && !writer) return null;
        const db = writer ?? openDb(dbFile(), space.dim, writer ? "readWrite" : "readOnly");
        try {
          const ids = lookupDocuments(db, documentId);
          const payload = ids[0] !== undefined ? db.getPayload(ids[0]) as DocumentPayload | null : null;
          return payload ? { revision: payload.revision, recipeId: payload.recipeId } : null;
        } finally {
          if (db !== writer) db.close();
        }
      });
    },
    publishDocument(input: SemanticDocumentPublication, signal?: AbortSignal): Promise<void> {
      return publishDocuments([input], signal);
    },
    publishDocuments(inputs: readonly SemanticDocumentPublication[], signal?: AbortSignal): Promise<void> {
      return publishDocuments(inputs, signal);
    },
    async listDocumentIds(): Promise<string[]> {
      return enqueue(() => {
        if (!existsSync(dbFile()) && !writer) return [];
        const db = writer ?? openDb(dbFile(), space.dim, writer ? "readWrite" : "readOnly");
        try {
          const ids = new Set<string>();
          for (const id of db.indexedLookup({ type: "document" }, maximumLookupResults(db))) {
            const payload = db.getPayload(id) as DocumentPayload | null;
            if (payload?.documentId) ids.add(payload.documentId);
          }
          return [...ids];
        } finally {
          if (db !== writer) db.close();
        }
      });
    },
    async removeDocument(documentId: string, publishToken?: number): Promise<void> {
      const token = publishToken ?? ((latestPublish.get(documentId) ?? 0) + 1);
      latestPublish.set(documentId, Math.max(latestPublish.get(documentId) ?? 0, token));
      await enqueue(() => {
        if ((latestPublish.get(documentId) ?? 0) > token) return;
        if (!existsSync(dbFile()) && !writer) return;
        const db = ensureWriter();
        const operations: import("triviumdb").TransactionOperation[] = [];
        const oldDocuments = lookupDocuments(db, documentId);
        for (const id of [...lookupBlocks(db, documentId), ...oldDocuments]) {
          operations.push({ type: "delete", id });
        }
        if (operations.length === 0) return;
        db.commitTransaction(operations);
        if (documentBlockIdsCache) documentBlockIdsCache.delete(documentId);
        publishedDocuments = Math.max(0, publishedDocuments - oldDocuments.length);
        scheduleFlush();
        if (oldDocuments.length > 0) persistCheckpoint();
      });
    },
    async search(query: number[], limit: number, rootsOrOptions?: readonly string[] | SemanticSearchOptions): Promise<SemanticHit[]> {
      if (query.length !== space.dim) {
        throw new Error(`Semantic query vector has dimension ${query.length}; expected ${space.dim}.`);
      }
      const searchOptions = resolveSemanticSearchOptions(rootsOrOptions);
      const roots = searchOptions.roots;
      const mask = new Set(searchOptions.maskPaths ?? []);
      const includeDisk = searchOptions.disk !== false;
      const restricted = rootsAreRestricted(roots);
      const allowedDisk = (documentId: string): boolean => (
        !mask.has(documentId) && (!restricted || pathInRoots(documentId, roots))
      );
      const allowedExtra = (documentId: string): boolean => (
        !restricted || pathInRoots(documentId, roots)
      );
      return enqueue(() => {
        const extras = (searchOptions.extras ?? [])
          .filter((extra) => extra.vector.length === space.dim && allowedExtra(extra.documentId))
          .map((extra) => ({
            score: cosineSimilarity(query, extra.vector),
            payload: extra,
          }));
        if (!includeDisk || (!existsSync(dbFile()) && !writer)) {
          return extras
            .sort((left, right) => right.score - left.score)
            .slice(0, limit)
            .map((hit, index) => ({
              documentId: hit.payload.documentId,
              revision: hit.payload.revision,
              blockId: hit.payload.blockId,
              parentUnitId: hit.payload.parentUnitId,
              parentName: hit.payload.parentName,
              parentKind: hit.payload.parentKind,
              startLine: hit.payload.startLine,
              endLine: hit.payload.endLine,
              contentHash: hit.payload.contentHash,
              fallback: hit.payload.fallback,
              body: hit.payload.body,
              similarity: hit.score,
              rank: index + 1,
              scope: options.scope,
              spaceId,
              generation,
            }));
        }
        const db = writer ?? openDb(dbFile(), space.dim, writer ? "readWrite" : "readOnly");
        try {
          let hits: Array<{ score: number; payload: BlockPayload | SemanticOverlayBlock }>;
          const scoped = restricted || mask.size > 0;
          if (scoped) {
            const scopedIds = [...documentBlockIds(db).entries()]
              .filter(([documentId]) => allowedDisk(documentId))
              .flatMap(([, ids]) => ids);
            if (scopedIds.length === 0) {
              hits = [];
            } else {
              try {
                // `searchGraphFirst` computes exact Top-K within the supplied
                // anchors. Passing every scoped block ID avoids global
                // oversampling and preserves the correct result when global top-K
                // is filled by out-of-scope documents.
                hits = db.searchGraphFirst(query, scopedIds, limit, scopedIds.length).map((hit) => ({
                  score: hit.score,
                  payload: hit.payload as BlockPayload,
                }));
              } catch {
                // Keep the same scoped anchors if the native exact query is
                // unavailable at runtime; this fallback does not widen scope.
                hits = [];
                for (const id of scopedIds) {
                  const node = db.get(id);
                  if (!node) continue;
                  const payload = node.payload as BlockPayload;
                  if (payload.type !== "block" || !allowedDisk(payload.documentId)) continue;
                  hits.push({ score: cosineSimilarity(query, node.vector), payload });
                }
                hits.sort((left, right) => right.score - left.score);
              }
            }
          } else {
            try {
              hits = db.searchExact(query, Math.max(limit * 4, limit)).map((hit) => ({
                score: hit.score,
                payload: hit.payload as BlockPayload,
              }));
            } catch {
              hits = [];
              for (const id of db.indexedLookup({ type: "block" }, maximumLookupResults(db))) {
                const node = db.get(id);
                if (!node) continue;
                const payload = node.payload as BlockPayload;
                if (payload.type !== "block") continue;
                hits.push({ score: cosineSimilarity(query, node.vector), payload });
              }
              hits.sort((left, right) => right.score - left.score);
            }
          }
          const ranked = [...hits, ...extras]
            .filter((hit) => {
              if ("type" in hit.payload) {
                return hit.payload.type === "block" && allowedDisk(hit.payload.documentId);
              }
              return allowedExtra(hit.payload.documentId);
            })
            .sort((left, right) => right.score - left.score)
            .slice(0, limit);
          return ranked.map((hit, index) => ({
            documentId: hit.payload.documentId,
            revision: hit.payload.revision,
            blockId: hit.payload.blockId,
            parentUnitId: hit.payload.parentUnitId,
            parentName: hit.payload.parentName,
            parentKind: hit.payload.parentKind,
            startLine: hit.payload.startLine,
            endLine: hit.payload.endLine,
            contentHash: hit.payload.contentHash,
            fallback: hit.payload.fallback,
            body: typeof hit.payload.body === "string" ? hit.payload.body : "",
            similarity: hit.score,
            rank: index + 1,
            scope: options.scope,
            spaceId,
            generation,
          }));
        } finally {
          if (db !== writer) db.close();
        }
      });
    },
    async close(): Promise<void> {
      if (disposed) return;
      if (closeTask) return closeTask;
      closeTask = writeTail.then(() => {
        persistence.close();
        writer = null;
        disposed = true;
      }).catch((error: unknown) => {
        closeTask = null; // A failed close keeps its handle available for retry.
        throw error;
      });
      return closeTask;
    },
  };
}

export type SemanticGenerationStore = ReturnType<typeof createSemanticGenerationStore>;

export const spaceIdentityOf = (space: VectorSpaceIdentity): string => spaceIdOf(space);
