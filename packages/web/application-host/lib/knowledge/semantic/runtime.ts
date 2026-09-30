/**
 * Background semantic index. Bound by the Host to a workspace scope, not to a
 * chat session. Incremental updates follow Documents revisions (D-107 / D-140).
 */

import type { DocumentAuthority, DocumentMutationObservation } from "../../documents/authority.js";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { FileSearchEnumerationStatus, FileSearchItem } from "../../fs/types.js";
import { languageIdForPath } from "../../harness/language-id.js";
import { TREE_SITTER_LANGUAGE_SPECS } from "../../structure/languages.js";
import type { StructureSource, StructureUnitsResult } from "../../structure/types.js";
import { pathInRoots } from "../../workspace/path-scope.js";
import { CATALOG_SCAN_BATCH } from "../symbol-runtime.js";
import { packStructuralUnits } from "./chunker.js";
import type { SemanticEmbedder } from "./embedder.js";
import { createEmbedScheduler, type EmbedScheduler } from "./embed-scheduler.js";
import { workspaceScope, spaceIdOf, semanticSpaceDir, type SemanticScopeKey } from "./identity.js";
import {
  createSemanticGenerationStore,
  readSemanticCheckpoint,
  type SemanticDocumentPublication,
  type SemanticGenerationStore,
  type SemanticHit,
  type SemanticOverlayBlock,
} from "./store.js";
import { createVectorCache, type SemanticVectorCache } from "./vector-cache.js";
import { isAbortError, waitWithSignal } from "./cancellation.js";

export const SEMANTIC_SCAN_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(TREE_SITTER_LANGUAGE_SPECS));

const insideDirectory = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Resolve user-selected folders into non-overlapping scan roots inside one resource root. */
export async function resolveSemanticScanRoots(root: string, selected: readonly string[] | null | undefined): Promise<string[]> {
  if (selected === null || selected === undefined) return [root];
  const canonicalDirectories = await Promise.all(selected.map(async (directory) => {
    // Documents stores a real path, while a saved selection may use another
    // spelling of the same directory (including Windows 8.3 path aliases).
    try { return await realpath(directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return directory;
    }
  }));
  const candidates = canonicalDirectories.flatMap((directory) => {
    if (insideDirectory(directory, root)) return [root];
    return insideDirectory(root, directory) ? [directory] : [];
  }).sort((left, right) => left.length - right.length);
  return candidates.filter((directory, index) => !candidates.slice(0, index).some((earlier) => insideDirectory(earlier, directory)));
}

export type SemanticQueryStatus = "not-requested" | "ready" | "empty" | "unavailable" | "failed" | "stale" | "incomplete";

export type SemanticIndexStatus = {
  status: SemanticQueryStatus;
  coverage: "empty" | "partial" | "complete";
  lifecycle: "idle" | "building" | "rebuilding" | "ready";
  generation: string | null;
  spaceId: string | null;
  scope: SemanticScopeKey;
};

export type SemanticScanBatchProgress = {
  processedFiles: number;
  totalFiles: number;
  publishedDocuments: number;
};

export type SemanticScanProgress = SemanticScanBatchProgress & {
  phase: "enumerating" | "processing" | "ready" | "failed" | "cancelled";
  startedAt: number;
  updatedAt: number;
  error?: string;
};

export type SemanticScanOptions = {
  signal?: AbortSignal;
  onBatchComplete?: (progress: SemanticScanBatchProgress) => void;
  /** Watch continuity was lost: metadata is not enough to retain old content. */
  forceContentVerification?: boolean;
};

export type SemanticQueryOverlay = {
  path: string;
  content: string | null;
  revision: string;
  origin: "surface-draft" | "thread";
  gap?: "draft-vector-pending" | "draft-unavailable" | "thread-vector-pending";
};

type SemanticScanFile = FileSearchItem & { metadata?: { byteLength: string; modifiedTimeNs: string } };
type SemanticScanFiles = SemanticScanFile[] & { enumerationStatus?: FileSearchEnumerationStatus };

export type SemanticSearchRequest = {
  threadQuery?: import("../../harness/working-state/working-branch-query.js").WorkingBranchQuerySnapshot;
  signal?: AbortSignal;
  roots?: readonly string[];
  overlays?: readonly SemanticQueryOverlay[];
  view?: "disk" | "working-state";
  waitForFirstPublish?: boolean;
};

export type SemanticSearchResult = {
  status: SemanticIndexStatus;
  hits: SemanticHit[];
  gaps: Array<{ path: string; reason: "draft-vector-pending" | "draft-unavailable" | "thread-vector-pending" | "index-read-failed" | "content-changed" | "index-watch-unavailable" }>;
};

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, 0);
});

export interface SemanticIndexRuntimeOptions {
  dataDir: string;
  hostId: string;
  documents: Pick<DocumentAuthority, "inspectWorkspace" | "read">;
  structureSource: StructureSource;
  searchFilesystemFiles?: (
    rootPath: string,
    options: { query: string; respectGitignore?: boolean; includeRevisions?: boolean; signal?: AbortSignal },
  ) => Promise<SemanticScanFiles>;
  isIndexablePath?: (workspaceId: string, path: string, signal: AbortSignal) => Promise<boolean>;
  embedder: SemanticEmbedder;
  getEmbedder?: () => SemanticEmbedder;
  onError?: (error: unknown) => void;
  vectorCache?: SemanticVectorCache;
  scheduler?: EmbedScheduler;
  indexDirectories?: readonly string[] | null;
}

export function createSemanticIndexRuntime(options: SemanticIndexRuntimeOptions) {
  const stores = new Map<string, SemanticGenerationStore>();
  const pending = new Set<Promise<void>>();
  const scanControllers = new Map<string, AbortController>();
  const scanProgress = new Map<string, SemanticScanProgress>();
  const inFlightScans = new Map<string, Promise<void>>();
  const verifyingScanKeys = new Set<string>();
  const activeScanGates = new Map<string, { promise: Promise<void>; resolve: () => void; resolved: boolean }>();
  const unverifiedPaths = new Map<string, Set<string>>();
  // Metadata only gates repeat reads within this Host lifetime. It is a hint,
  // never a content revision; skipped paths remain visible as coverage gaps.
  const verifiedScanMetadata = new Map<string, Map<string, string>>();
  const metadataUnverifiedPaths = new Map<string, Set<string>>();
  const mutationPending = new Map<string, Set<string>>();
  const indexReadFailures = new Map<string, Set<string>>();
  const scanFailures = new Set<string>();
  const deferredDimensionScans = new WeakMap<SemanticEmbedder, Set<string>>();
  const documentTokens = new Map<string, number>();
  let revisionClock = 0;
  const queryCache = options.vectorCache ?? createVectorCache();
  const scheduler = options.scheduler ?? createEmbedScheduler();
  const embedderBootstraps = new WeakMap<SemanticEmbedder, Promise<void>>();
  const lifecycleController = new AbortController();
  let disposed = false;

  const embedderOf = (): SemanticEmbedder => options.getEmbedder?.() ?? options.embedder;

  const ensureEmbedderSpace = async (
    embedder: SemanticEmbedder,
    signal: AbortSignal | undefined,
    bootstrapText: string,
    bootstrapPurpose: "document" | "query" = "document",
  ): Promise<SemanticEmbedder> => {
    if (embedder.status !== "ready" || embedder.space.dim > 0) return embedder;
    let bootstrap = embedderBootstraps.get(embedder);
    if (!bootstrap) {
      bootstrap = (async () => {
        await embedder.prepare();
        const vectors = await scheduler.enqueue("foreground", async () => (
          embedder.embed([bootstrapText], { purpose: bootstrapPurpose, ...(signal ? { signal } : {}) })
        ));
        const vector = vectors[0];
        if (vector && embedder.space.dim > 0) {
          queryCache.set({ spaceId: spaceIdOf(embedder.space), purpose: bootstrapPurpose, embedText: bootstrapText }, vector);
        }
      })();
      embedderBootstraps.set(embedder, bootstrap);
      void bootstrap.catch(() => {
        if (embedderBootstraps.get(embedder) === bootstrap) embedderBootstraps.delete(embedder);
      });
    }
    await waitWithSignal(bootstrap, signal);
    return embedder;
  };

  const scopeKey = (scope: SemanticScopeKey, spaceId?: string): string => (
    `${scope.scopeKind}\0${scope.scopeId}\0${spaceId ?? spaceIdOf(embedderOf().space)}`
  );
  const scopeIdentity = (scope: SemanticScopeKey): string => `${scope.scopeKind}\0${scope.scopeId}`;
  const forgetScanMetadata = (scope: SemanticScopeKey, documentId: string): void => {
    const prefix = `${scopeIdentity(scope)}\0`;
    for (const [key, metadata] of verifiedScanMetadata) if (key.startsWith(prefix)) metadata.delete(documentId);
    for (const [key, paths] of metadataUnverifiedPaths) if (key.startsWith(prefix)) paths.delete(documentId);
  };
  const metadataIdentity = (metadata: SemanticScanFile["metadata"]): string | undefined => (
    metadata ? JSON.stringify([metadata.byteLength, metadata.modifiedTimeNs]) : undefined
  );

  const createScanGate = () => {
    let resolve = (): void => undefined;
    const created = {
      resolved: false,
      resolve: (): void => undefined,
      promise: new Promise<void>((done) => {
        resolve = () => {
          created.resolved = true;
          done();
        };
      }),
    };
    created.resolve = resolve;
    return created;
  };

  const storeFor = (scope: SemanticScopeKey, embedder: SemanticEmbedder = embedderOf()): SemanticGenerationStore => {
    if (embedder.space.dim <= 0) {
      throw new Error("Semantic store requires a known vector dimension.");
    }
    const key = scopeKey(scope, spaceIdOf(embedder.space));
    const existing = stores.get(key);
    if (existing) return existing;
    const created = createSemanticGenerationStore({
      dataDir: options.dataDir,
      hostId: options.hostId,
      scope,
      embedder,
      vectorCache: queryCache,
      scheduler,
    });
    stores.set(key, created);
    return created;
  };

  const track = (task: Promise<void>): void => {
    pending.add(task);
    void task.catch((error) => {
      if (isAbortError(error) || lifecycleController.signal.aborted) return;
      try { options.onError?.(error); } catch { /* diagnostics cannot break observation */ }
    }).finally(() => pending.delete(task));
  };

  const nextToken = (scope: SemanticScopeKey, documentId: string): number => {
    const key = `${scopeKey(scope, "token")}\0${documentId}`;
    const next = ++revisionClock;
    documentTokens.set(key, next);
    return next;
  };

  const scanTokenFor = (scope: SemanticScopeKey, documentId: string, token: number): number => {
    const key = `${scopeKey(scope, "token")}\0${documentId}`;
    if ((documentTokens.get(key) ?? 0) <= token) documentTokens.set(key, token);
    return token;
  };

  const isCurrentToken = (scope: SemanticScopeKey, documentId: string, token: number): boolean => {
    const key = `${scopeKey(scope, "token")}\0${documentId}`;
    return documentTokens.get(key) === token;
  };

  const packUnits = (documentId: string, units: StructureUnitsResult, embedder: SemanticEmbedder) => ({
    chunks: packStructuralUnits({
      documentId,
      units: units.units,
      maxTokens: embedder.space.maxTokens,
      countTokens: (value) => embedder.countTokens(value),
    }),
    sourceRecipeId: units.recipeId ?? "native-structure-v1",
  });

  const chunksFor = async (documentId: string, text: string, revision: string, embedder: SemanticEmbedder,
    signal: AbortSignal | undefined, lane: "foreground" | "background", workspaceId?: string) => {
    if (!options.structureSource.units) throw new Error("Native structural unit service is unavailable");
    const units = await options.structureSource.units({path:documentId,text,revision,languageId:languageIdForPath(documentId),lane,
      ...(workspaceId ? {workspaceId} : {}), ...(signal ? {signal} : {})});
    signal?.throwIfAborted();
    if (units.status !== "ready" && units.status !== "empty") throw new Error(units.message ?? "Native structural units did not complete");
    if (units.revision !== revision) throw new Error("Native structural units changed their input revision");
    return packUnits(documentId, units, embedder);
  };

  const diskChunksFor = async (
    workspaceId: string,
    root: string,
    documentId: string,
    embedder: SemanticEmbedder,
    signal?: AbortSignal,
  ) => {
    if (!options.structureSource.unitsFile) throw new Error("Native disk structural unit service is unavailable");
    const units = await options.structureSource.unitsFile({
      workspaceId,
      root,
      path: documentId,
      languageId: languageIdForPath(documentId),
      lane: "background",
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    if (units.status !== "ready" && units.status !== "empty") {
      throw new Error(units.message ?? "Native disk structural units did not complete");
    }
    if (!units.revision) throw new Error("Native disk structural units returned no source revision");
    return { revision: units.revision, ...packUnits(documentId, units, embedder) };
  };

  const prepareDocument = async (
    scope: SemanticScopeKey,
    store: SemanticGenerationStore,
    root: string,
    documentId: string,
    token: number,
    embedder: SemanticEmbedder = embedderOf(),
    signal?: AbortSignal,
    expectedRevision?: string,
  ): Promise<SemanticDocumentPublication | { kind: "unchanged-current" } | { kind: "superseded" } | { kind: "read-failed" }> => {
    if (scope.scopeKind !== "workspace") return { kind: "read-failed" };
    signal?.throwIfAborted();
    if (!isCurrentToken(scope, documentId, token)) return { kind: "superseded" };
    const published = await store.publishedRevision(documentId);
    if (expectedRevision && published?.revision === expectedRevision && published.recipeId === store.recipeId) {
      return { kind: "unchanged-current" };
    }
    let prepared;
    try { prepared = await diskChunksFor(scope.scopeId, root, documentId, embedder, signal); }
    catch { signal?.throwIfAborted(); return {kind:"read-failed"}; }
    if (!isCurrentToken(scope, documentId, token)) return {kind:"superseded"};
    if (expectedRevision && prepared.revision !== expectedRevision) return { kind: "superseded" };
    if (published?.revision === prepared.revision && published.recipeId === store.recipeId) {
      return { kind: "unchanged-current" };
    }
    return { documentId, revision: prepared.revision, chunks: prepared.chunks, publishToken: token };
  };

  const indexDocument = async (scope: SemanticScopeKey, documentId: string, kind: "modified" | "deleted"): Promise<void> => {
    const signal = lifecycleController.signal;
    signal.throwIfAborted();
    const token = nextToken(scope, documentId);
    const embedder = embedderOf();
    const root = kind === "deleted" ? undefined : (await options.documents.inspectWorkspace(scope.scopeId)).root;
    const included = root !== undefined && (await resolveSemanticScanRoots(root, options.indexDirectories))
      .some((directory) => insideDirectory(directory, path.resolve(root, documentId)));
    const excluded = kind !== "deleted" && (!included || Boolean(options.isIndexablePath
      && !await options.isIndexablePath(scope.scopeId, documentId, signal)));
    if (!isCurrentToken(scope, documentId, token)) return;
    if (kind === "deleted" || excluded) {
      const prefix = `${scope.scopeKind}\0${scope.scopeId}\0`;
      await Promise.all([...stores].filter(([key]) => key.startsWith(prefix)).map(([, store]) => store.removeDocument(documentId, token)));
      if (!isCurrentToken(scope, documentId, token)) return;
      for (const [key, failures] of indexReadFailures) if (key.startsWith(prefix)) failures.delete(documentId);
      for (const [key, paths] of unverifiedPaths) if (key.startsWith(prefix)) paths.delete(documentId);
      mutationPending.get(scopeIdentity(scope))?.delete(documentId);
      return;
    }
    if (embedder.status === "ready" && embedder.space.dim <= 0) {
      await embedder.prepare();
      const first = (await diskChunksFor(scope.scopeId, root!, documentId, embedder, signal)).chunks[0];
      if (!first) return;
      await ensureEmbedderSpace(embedder, signal, first.embedText);
    }
    if (disposed || embedder.status !== "ready") return;
    const store = storeFor(scope, embedder);
    await embedder.prepare();
    const publication = await prepareDocument(scope, store, root!, documentId, token, embedder, signal);
    const resolvedKey = scopeKey(scope, spaceIdOf(embedder.space));
    if (!("kind" in publication) && isCurrentToken(scope, documentId, token)) {
      await store.publishDocument(publication, signal);
      if (!isCurrentToken(scope, documentId, token)) return;
      mutationPending.get(scopeIdentity(scope))?.delete(documentId);
      indexReadFailures.get(resolvedKey)?.delete(documentId);
      unverifiedPaths.get(resolvedKey)?.delete(documentId);
    } else if ("kind" in publication && publication.kind === "unchanged-current" && isCurrentToken(scope, documentId, token)) {
      mutationPending.get(scopeIdentity(scope))?.delete(documentId);
      indexReadFailures.get(resolvedKey)?.delete(documentId);
      unverifiedPaths.get(resolvedKey)?.delete(documentId);
    } else if ("kind" in publication && publication.kind === "read-failed" && isCurrentToken(scope, documentId, token)) {
      const failures = indexReadFailures.get(resolvedKey) ?? new Set<string>();
      failures.add(documentId);
      indexReadFailures.set(resolvedKey, failures);
    }
  };

  const observeDocumentMutation = (event: Omit<DocumentMutationObservation, 'owner'> & Partial<Pick<DocumentMutationObservation, 'owner'>>): void => {
    if (disposed) return;
    const languageId = languageIdForPath(event.resourceId);
    if (!languageId || !SEMANTIC_SCAN_LANGUAGES.has(languageId)) return;
    const pendingForScope = mutationPending.get(scopeIdentity(workspaceScope(event.workspaceId))) ?? new Set<string>();
    forgetScanMetadata(workspaceScope(event.workspaceId), event.resourceId);
    pendingForScope.add(event.resourceId);
    mutationPending.set(scopeIdentity(workspaceScope(event.workspaceId)), pendingForScope);
    track(indexDocument(workspaceScope(event.workspaceId), event.resourceId, event.kind === "deleted" ? "deleted" : "modified"));
  };

  const scanScope = async (scope: SemanticScopeKey, optionsForScan?: SemanticScanOptions): Promise<void> => {
    const initialEmbedder = embedderOf();
    if (disposed || !options.searchFilesystemFiles || initialEmbedder.status !== "ready") return;
    if (scope.scopeKind !== "workspace") return;
    const key = scopeKey(scope, spaceIdOf(initialEmbedder.space));
    const existing = inFlightScans.get(key);
    if (existing) {
      if (optionsForScan?.forceContentVerification && !verifyingScanKeys.has(key)) {
        scanControllers.get(key)?.abort();
      } else if (!scanControllers.get(key)?.signal.aborted) return existing;
      await existing;
      return scanScope(scope, optionsForScan);
    }
    const scopeScanKey = `${scope.scopeKind}\0${scope.scopeId}`;
    const startedAt = Date.now();
    const updateProgress = (patch: Partial<SemanticScanProgress>): void => {
      scanProgress.set(scopeScanKey, {
        phase: "enumerating", processedFiles: 0, totalFiles: 0, publishedDocuments: 0,
        startedAt, ...scanProgress.get(scopeScanKey), ...patch, updatedAt: Date.now(),
      });
    };
    scanProgress.delete(scopeScanKey);
    updateProgress({ phase: "enumerating", processedFiles: 0, totalFiles: 0, publishedDocuments: 0, startedAt });
    scanFailures.add(scopeScanKey);
    for (const [activeKey, activeController] of scanControllers) {
      if (activeKey.startsWith(`${scopeScanKey}\0`)) activeController.abort();
    }
    const controller = new AbortController();
    scanControllers.set(key, controller);
    const signal = optionsForScan?.signal
      ? AbortSignal.any([controller.signal, optionsForScan.signal, lifecycleController.signal])
      : AbortSignal.any([controller.signal, lifecycleController.signal]);
    const gate = createScanGate();
    activeScanGates.set(scopeScanKey, gate);
    let resolvedKey = key;
    const runHolder: { promise?: Promise<void> } = {};
    const run = (async () => {
      let store: SemanticGenerationStore | undefined;
      let scanComplete = true;
      try {
        const root = (await options.documents.inspectWorkspace(scope.scopeId)).root;
        const scanToken = ++revisionClock;
        const selectedRoots = await resolveSemanticScanRoots(root, options.indexDirectories);
        const inventories = await Promise.all(selectedRoots.map((directory) => options.searchFilesystemFiles!(directory, {
          query: "", respectGitignore: true, signal,
        })));
        const byPath = new Map<string, SemanticScanFile>();
        for (const [index, inventory] of inventories.entries()) {
          const prefix = path.relative(root, selectedRoots[index]!).split(path.sep).join("/");
          for (const file of inventory) {
            const relativePath = prefix ? `${prefix}/${file.relativePath}` : file.relativePath;
            byPath.set(relativePath, { ...file, relativePath });
          }
        }
        const files = [...byPath.values()] as SemanticScanFiles;
        if (inventories.some((inventory) => inventory.enumerationStatus === "failed")) files.enumerationStatus = "failed";
        else if (inventories.some((inventory) => inventory.enumerationStatus !== undefined && inventory.enumerationStatus !== "complete")) {
          files.enumerationStatus = "incomplete";
        }
        signal.throwIfAborted();
        const catalog = (files as SemanticScanFiles).filter((file) => SEMANTIC_SCAN_LANGUAGES.has(languageIdForPath(file.relativePath) ?? ""));
        updateProgress({ totalFiles: catalog.length });
        if (catalog.length === 0 && initialEmbedder.space.dim <= 0) {
          // There is no document body with which to resolve an automatic remote
          // dimension. Remember the successful empty catalog. The first real
          // query can resolve the dimension and then reconcile any persisted
          // generation before it is searched.
          const deferred = deferredDimensionScans.get(initialEmbedder) ?? new Set<string>();
          deferred.add(scopeScanKey);
          deferredDimensionScans.set(initialEmbedder, deferred);
          scanFailures.delete(scopeScanKey);
          updateProgress({ phase: "ready" });
          return;
        }
        // The model dimension can be resolved with a path probe. Resolving it
        // must not force a body read for a file that metadata may later skip.
        const bootstrapText = catalog[0]?.relativePath ?? ".";
        const embedder = await ensureEmbedderSpace(initialEmbedder, signal, bootstrapText);
        signal.throwIfAborted();
        resolvedKey = scopeKey(scope, spaceIdOf(embedder.space));
        if (resolvedKey !== key) {
          inFlightScans.set(resolvedKey, runHolder.promise!);
          scanControllers.set(resolvedKey, controller);
          if (optionsForScan?.forceContentVerification) verifyingScanKeys.add(resolvedKey);
        }
        store = storeFor(scope, embedder);
        store.markBuilding(store.lifecycle === "ready" ? "rebuilding" : "building");
        const publishedBefore = await store.listDocumentIds();
        const publishedIds = new Set(publishedBefore);
        const catalogIds = new Set(catalog.map((file) => file.relativePath));
        const enumerationComplete = files.enumerationStatus === undefined || files.enumerationStatus === "complete";
        if (!enumerationComplete) scanComplete = false;
        const removed = enumerationComplete ? publishedBefore.filter((documentId) => !catalogIds.has(documentId)) : [];
        const removalTokens = new Map(removed.map((documentId) => [documentId, scanTokenFor(scope, documentId, scanToken)]));
        const unverified = new Set([...publishedBefore, ...catalog.map((file) => file.relativePath)].filter((documentId) => (
          (documentTokens.get(`${scopeKey(scope, "token")}\0${documentId}`) ?? 0) <= scanToken
        )));
        unverifiedPaths.set(resolvedKey, unverified);
        const priorMetadata = verifiedScanMetadata.get(resolvedKey) ?? new Map<string, string>();
        const nextMetadata = new Map(priorMetadata);
        const previouslyMetadataUnverified = metadataUnverifiedPaths.get(resolvedKey) ?? new Set<string>();
        const metadataUnverified = enumerationComplete ? new Set<string>() : new Set(previouslyMetadataUnverified);
        const readFailures = indexReadFailures.get(resolvedKey) ?? new Set<string>();
        indexReadFailures.set(resolvedKey, readFailures);
        if (enumerationComplete) {
          for (const failedPath of readFailures) if (!catalogIds.has(failedPath)) readFailures.delete(failedPath);
        }
        const toProcess: SemanticScanFile[] = [];
        for (const file of catalog) {
          const path = file.relativePath;
          scanTokenFor(scope, path, scanToken);
          const identity = metadataIdentity(file.metadata);
          const pendingMutation = mutationPending.get(scopeIdentity(scope))?.has(path) ?? false;
          const canSkip = identity !== undefined
            && optionsForScan?.forceContentVerification !== true
            && priorMetadata.get(path) === identity
            && publishedIds.has(path)
            && !readFailures.has(path)
            && !pendingMutation
            && isCurrentToken(scope, path, scanToken);
          if (canSkip) {
            // Keep the prior index available so its candidate revision can be
            // checked against Documents. The scan still cannot claim complete
            // recall because metadata equality does not prove equal contents.
            metadataUnverified.add(path);
            unverified.delete(path);
          } else {
            toProcess.push(file);
            metadataUnverified.delete(path);
            nextMetadata.delete(path);
          }
        }
        scanFailures.delete(scopeScanKey);
        await embedder.prepare();
        const scanStore = store;
        let completedFiles = catalog.length - toProcess.length;
        updateProgress({ phase: "processing", processedFiles: completedFiles, publishedDocuments: scanStore.checkpoint()?.publishedDocuments ?? 0 });
        let nextOffset = 0;
        let workerFailure: unknown;
        let failed = false;
        const processBatches = async (): Promise<void> => {
          while (nextOffset < toProcess.length && !failed) {
            const offset = nextOffset;
            nextOffset += CATALOG_SCAN_BATCH;
            signal.throwIfAborted();
            const batch = toProcess.slice(offset, offset + CATALOG_SCAN_BATCH);
            const prepared = await Promise.all(batch.map((file) => (
              prepareDocument(
                scope,
                scanStore,
                root,
                file.relativePath,
                scanTokenFor(scope, file.relativePath, scanToken),
                embedder,
                signal,
                file.revision,
              )
            )));
            signal.throwIfAborted();
            const accepted = prepared.filter((publication): publication is SemanticDocumentPublication => !("kind" in publication));
            if (accepted.length > 0) await scanStore.publishDocuments(accepted, signal);
            for (const [index, publication] of prepared.entries()) {
              const path = batch[index]!.relativePath;
              if (!isCurrentToken(scope, path, scanToken)) continue;
              if ("kind" in publication && publication.kind === "read-failed") {
                scanComplete = false;
                readFailures.add(path);
                metadataUnverified.delete(path);
                nextMetadata.delete(path);
              } else if (!("kind" in publication) || publication.kind === "unchanged-current") {
                unverified.delete(path);
                readFailures.delete(path);
                mutationPending.get(scopeIdentity(scope))?.delete(path);
                metadataUnverified.delete(path);
                const identity = metadataIdentity(batch[index]!.metadata);
                if (identity) nextMetadata.set(path, identity);
                else nextMetadata.delete(path);
              }
            }
            if (prepared.some((publication) => !("kind" in publication) || publication.kind === "unchanged-current")) gate.resolve();
            completedFiles += batch.length;
            const progress = {
              processedFiles: completedFiles, totalFiles: catalog.length,
              publishedDocuments: scanStore.checkpoint()?.publishedDocuments ?? 0,
            };
            updateProgress(progress);
            try { optionsForScan?.onBatchComplete?.(progress); } catch { /* observers do not own indexing */ }
            await yieldToEventLoop();
          }
        };
        const workers = Array.from({ length: Math.min(
          options.scheduler?.maxConcurrent ?? 1,
          Math.max(1, Math.ceil(toProcess.length / CATALOG_SCAN_BATCH)),
        ) }, () => processBatches().catch((error: unknown) => {
          if (!failed) {
            failed = true;
            workerFailure = error;
            controller.abort();
          }
        }));
        await Promise.all(workers);
        if (failed) throw workerFailure;
        signal.throwIfAborted();
        for (const path of [...metadataUnverified]) {
          if (!isCurrentToken(scope, path, scanToken)) {
            metadataUnverified.delete(path);
            nextMetadata.delete(path);
          }
        }
        const currentRemovals = removed.filter((documentId) => isCurrentToken(scope, documentId, removalTokens.get(documentId)!));
        await Promise.all(currentRemovals.map((documentId) => store!.removeDocument(documentId, removalTokens.get(documentId)!)));
        for (const documentId of currentRemovals) {
          unverified.delete(documentId);
          nextMetadata.delete(documentId);
          metadataUnverified.delete(documentId);
        }
        if (enumerationComplete) {
          for (const documentId of nextMetadata.keys()) if (!catalogIds.has(documentId)) nextMetadata.delete(documentId);
        }
        verifiedScanMetadata.set(resolvedKey, nextMetadata);
        if (metadataUnverified.size > 0) metadataUnverifiedPaths.set(resolvedKey, metadataUnverified);
        else metadataUnverifiedPaths.delete(resolvedKey);
        store.markReady(scanComplete && unverified.size === 0 && metadataUnverified.size === 0);
        updateProgress({ phase: "ready", processedFiles: catalog.length, publishedDocuments: store.checkpoint()?.publishedDocuments ?? 0 });
        deferredDimensionScans.get(embedder)?.delete(scopeScanKey);
      } catch (error) {
        updateProgress(signal.aborted && isAbortError(error)
          ? { phase: "cancelled" }
          : { phase: "failed", error: error instanceof Error ? error.message : String(error) });
        if (!disposed && !isAbortError(error)) {
          store?.markReady(false);
          try { options.onError?.(error); } catch { /* observational */ }
        }
      } finally {
        gate.resolve();
        if (activeScanGates.get(scopeScanKey) === gate) activeScanGates.delete(scopeScanKey);
        if (scanControllers.get(key) === controller) scanControllers.delete(key);
        if (scanControllers.get(resolvedKey) === controller) scanControllers.delete(resolvedKey);
        if (inFlightScans.get(key) === runHolder.promise) inFlightScans.delete(key);
        if (inFlightScans.get(resolvedKey) === runHolder.promise) inFlightScans.delete(resolvedKey);
        verifyingScanKeys.delete(key);
        verifyingScanKeys.delete(resolvedKey);
      }
    })();
    runHolder.promise = run;
    inFlightScans.set(key, run);
    if (optionsForScan?.forceContentVerification) verifyingScanKeys.add(key);
    return run;
  };

  const statusForEmbedder = (
    scope: SemanticScopeKey,
    embedder: SemanticEmbedder,
  ): SemanticIndexStatus => {
    if (embedder.status !== "ready") {
      return {
        status: "unavailable",
        coverage: "empty",
        lifecycle: "idle",
        generation: null,
        spaceId: null,
        scope,
      };
    }
    if (embedder.space.dim <= 0) {
      return {
        status: "empty",
        coverage: "empty",
        lifecycle: "idle",
        generation: null,
        spaceId: spaceIdOf(embedder.space),
        scope,
      };
    }
    const store = stores.get(scopeKey(scope, spaceIdOf(embedder.space)));
    const checkpoint = store?.checkpoint() ?? readSemanticCheckpoint(semanticSpaceDir(
      options.dataDir, options.hostId, scope, spaceIdOf(embedder.space),
    ));
    const coverage = checkpoint?.coverage ?? store?.coverage ?? "empty";
    return {
      status: coverage === "empty" ? "empty" : "ready",
      coverage,
      lifecycle: store?.lifecycle ?? checkpoint?.lifecycle ?? "idle",
      generation: store?.generation ?? checkpoint?.generation ?? null,
      spaceId: store?.spaceId ?? checkpoint?.spaceId ?? spaceIdOf(embedder.space),
      scope,
    };
  };

  const statusFor = (scope: SemanticScopeKey): SemanticIndexStatus => (
    statusForEmbedder(scope, embedderOf())
  );

  const overlayChunks = async (
    path: string,
    revision: string,
    origin: SemanticQueryOverlay["origin"],
    chunks: ReturnType<typeof packStructuralUnits>,
    signal: AbortSignal | undefined,
    embedder: SemanticEmbedder,
  ): Promise<{ extras: SemanticOverlayBlock[]; gaps: SemanticSearchResult["gaps"] }> => {
    const vectors: number[][] = [];
    const missing: Array<{ chunk: typeof chunks[number]; index: number }> = [];
    for (const [index, chunk] of chunks.entries()) {
      const cached = queryCache.get({ spaceId: spaceIdOf(embedder.space), purpose: "document", embedText: chunk.embedText });
      if (cached) vectors[index] = cached;
      else missing.push({ chunk, index });
    }
    if (missing.length > 0) {
      signal?.throwIfAborted();
      const owners = missing.map((item) => ({
        text: item.chunk.embedText,
        claim: queryCache.claim({ spaceId: spaceIdOf(embedder.space), purpose: "document", embedText: item.chunk.embedText }),
      })).filter((item) => item.claim.owner);
      if (owners.length > 0) {
        // Captured fixed text becomes workspace-owned background vector work.
        // Returning/finishing a query does not cancel a claimed embedding.
        const backgroundSignal = lifecycleController.signal;
        const work = scheduler.enqueue("background", async () => {
          try {
            backgroundSignal.throwIfAborted();
            await embedder.prepare();
            backgroundSignal.throwIfAborted();
            const fresh = await embedder.embed(owners.map((item) => item.text), { purpose: "document", signal: backgroundSignal });
            backgroundSignal.throwIfAborted();
            if (fresh.length !== owners.length || fresh.some((vector) => vector.length !== embedder.space.dim)) {
              throw new Error("Fixed-view embedding returned an incomplete batch");
            }
            for (const [offset, item] of owners.entries()) {
              const vector = fresh[offset]!;
              queryCache.set({ spaceId: spaceIdOf(embedder.space), purpose: "document", embedText: item.text }, vector);
              item.claim.resolve(vector);
            }
          } catch (error) {
            for (const item of owners) item.claim.reject(error);
            throw error;
          }
        });
        track(waitWithSignal(work, backgroundSignal));
      }
      return { extras: [], gaps: [{ path, reason: origin === "thread" ? "thread-vector-pending" : "draft-vector-pending" }] };
    }
    if (vectors.some((vector) => !vector)) {
      return { extras: [], gaps: [{ path, reason: origin === "thread" ? "thread-vector-pending" : "draft-vector-pending" }] };
    }
    return {
      extras: chunks.map((chunk, index) => ({
        documentId: path,
        revision,
        blockId: chunk.blockId,
        parentUnitId: chunk.parentUnitId,
        parentName: chunk.parentName,
        parentKind: chunk.parentKind,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        contentHash: chunk.contentHash,
        fallback: chunk.fallback,
        body: chunk.body,
        vector: vectors[index]!,
      })),
      gaps: [],
    };
  };

  const overlayBlocks = async (
    overlays: readonly SemanticQueryOverlay[],
    signal?: AbortSignal,
    embedder: SemanticEmbedder = embedderOf(),
  ): Promise<{ extras: SemanticOverlayBlock[]; gaps: SemanticSearchResult["gaps"] }> => {
    const extras: SemanticOverlayBlock[] = [];
    const gaps: SemanticSearchResult["gaps"] = [];
    for (const overlay of overlays) {
      if (overlay.content === null) {
        if (overlay.gap) gaps.push({ path: overlay.path, reason: overlay.gap });
        continue;
      }
      const {chunks} = await chunksFor(overlay.path,overlay.content,overlay.revision,embedder,signal,"foreground");
      const material = await overlayChunks(overlay.path, overlay.revision, overlay.origin, chunks, signal, embedder);
      extras.push(...material.extras);gaps.push(...material.gaps);
    }
    return { extras, gaps };
  };

  const search = async (
    scope: SemanticScopeKey,
    question: string,
    limit: number,
    searchOptions?: SemanticSearchRequest,
  ): Promise<SemanticSearchResult> => {
    const signal = searchOptions?.signal
      ? AbortSignal.any([searchOptions.signal, lifecycleController.signal])
      : lifecycleController.signal;
    signal?.throwIfAborted();
    const embedder = embedderOf();
    let status = statusForEmbedder(scope, embedder);
    if (status.status === "unavailable") return { status, hits: [], gaps: [] };
    const scopeId = scopeIdentity(scope);
    try {
      await ensureEmbedderSpace(embedder, signal, question, "query");
      if (deferredDimensionScans.get(embedder)?.has(scopeId)) {
        if (embedder !== embedderOf()) return { status: { ...status, status: "stale" }, hits: [], gaps: [] };
        await scanScope(scope, { signal });
      }
      status = statusForEmbedder(scope, embedder);
      const key = scopeKey(scope, spaceIdOf(embedder.space));
      const activeScan = activeScanGates.get(scopeId);
      if (searchOptions?.waitForFirstPublish !== false && activeScan && !activeScan.resolved) {
        await waitWithSignal(activeScan.promise, signal);
      }
      if (scanFailures.has(scopeId)) {
        return { status: { ...status, status: "stale" }, hits: [], gaps: [] };
      }
      signal?.throwIfAborted();
      await waitWithSignal(embedder.prepare(), signal);
      signal?.throwIfAborted();
      const spaceId = spaceIdOf(embedder.space);
      let queryVector = queryCache.get({ spaceId, purpose: "query", embedText: question });
      if (!queryVector) {
        const [vector] = await waitWithSignal(scheduler.enqueue("foreground", async () => (
          embedder.embed([question], { purpose: "query", ...(signal ? { signal } : {}) })
        )), signal);
        signal?.throwIfAborted();
        if (vector) {
          queryVector = vector;
          queryCache.set({ spaceId, purpose: "query", embedText: question }, vector);
        }
      }
      const overlays = (searchOptions?.overlays ?? []).filter((overlay) => pathInRoots(overlay.path, searchOptions?.roots));
      const overlay = overlays.length > 0
        ? await overlayBlocks(overlays, signal, embedder)
        : { extras: [] as SemanticOverlayBlock[], gaps: [] as SemanticSearchResult["gaps"] };
      if (searchOptions?.threadQuery) {
        if (!options.structureSource.unitsFixed) throw new Error("Native fixed-view structural units are unavailable");
        const files = await searchOptions.threadQuery.listFiles(signal);
        for (const file of files) {
          signal.throwIfAborted();
          if (!pathInRoots(file.path, searchOptions.roots)) continue;
          const languageId = languageIdForPath(file.path);
          if (!languageId || !SEMANTIC_SCAN_LANGUAGES.has(languageId)) continue;
          const units = await options.structureSource.unitsFixed({
            workspaceId: scope.scopeId,
            path: file.path,
            languageId,
            compute: searchOptions.threadQuery.compute,
            lane: "foreground",
            signal,
          });
          if (units.status !== "ready" && units.status !== "empty") {
            throw new Error(units.message ?? "Native fixed-view structural units did not complete");
          }
          if (units.revision !== file.revision) throw new Error("Fixed-view semantic source revision changed inside one pin");
          const chunks = packUnits(file.path, units, embedder).chunks;
          const material = await overlayChunks(file.path, units.revision, "thread", chunks, signal, embedder);
          overlay.extras.push(...material.extras);overlay.gaps.push(...material.gaps);
        }
      }
      const diskIndexEnabled = searchOptions?.view !== "working-state" && !searchOptions?.threadQuery;
      const indexGaps: SemanticSearchResult["gaps"] = [...(indexReadFailures.get(key) ?? [])]
        .filter((path) => pathInRoots(path, searchOptions?.roots))
        .map((path) => ({ path, reason: "index-read-failed" as const }));
      // One scope-level gap represents the inventory's coverage uncertainty.
      // Expanding every unchanged file into a query result would make a large
      // workspace's response scale with its file count even for a one-hit query.
      const hasMetadataGap = diskIndexEnabled && [...(metadataUnverifiedPaths.get(key) ?? [])]
        .some((path) => pathInRoots(path, searchOptions?.roots));
      if (hasMetadataGap) indexGaps.push({ path: ".", reason: "index-watch-unavailable" });
      const store = storeFor(scope, embedder);
      const maskPaths = [
        ...overlays.map((overlay) => overlay.path),
        ...(unverifiedPaths.get(key) ?? []),
        ...(mutationPending.get(scopeId) ?? []),
      ];
      const indexedHits = queryVector
        ? await waitWithSignal(store.search(queryVector, limit, {
          maskPaths,
          extras: overlay.extras,
          disk: searchOptions?.view !== "working-state",
          ...(searchOptions?.roots === undefined ? {} : { roots: searchOptions.roots }),
        }), signal)
        : [];
      signal?.throwIfAborted();
      // A watcher can be delayed, overflow, or miss an event. Before exposing a
      // disk-index hit, compare its indexed document revision with Documents.
      // Fixed execution views and explicit overlays carry their own source
      // revision and must not be compared with live disk.
      const hits: SemanticHit[] = [];
      const gaps: SemanticSearchResult["gaps"] = [...overlay.gaps, ...indexGaps];
      const verified = new Map<string, { revision?: string; status?: string }>();
      const overlayByPath = new Map(overlays.map((item) => [item.path, item]));
      for (const hit of indexedHits) {
        signal?.throwIfAborted();
        if (searchOptions?.view === "working-state" || searchOptions?.threadQuery) {
          hits.push(hit);
          continue;
        }
        const pinnedOverlay = overlayByPath.get(hit.documentId);
        if (pinnedOverlay) {
          if (pinnedOverlay.content !== null && pinnedOverlay.revision === hit.revision) hits.push(hit);
          else if (!gaps.some((gap) => gap.path === hit.documentId && gap.reason === "content-changed")) {
            gaps.push({ path: hit.documentId, reason: "content-changed" });
          }
          continue;
        }
        let current = verified.get(hit.documentId);
        if (!current) {
          try {
            const snapshot = await options.documents.read({ workspaceId: scope.scopeId, resourceId: hit.documentId });
            current = { status: snapshot.status, ...(snapshot.status === "ready" ? { revision: snapshot.revision } : {}) };
          } catch {
            current = { status: "failed" };
          }
          verified.set(hit.documentId, current);
        }
        if (current.status === "ready" && current.revision === hit.revision) {
          hits.push(hit);
          continue;
        }
        const reason = current.status === "failed" ? "index-read-failed" : "content-changed";
        if (!gaps.some((gap) => gap.path === hit.documentId && gap.reason === reason)) gaps.push({ path: hit.documentId, reason });
        observeDocumentMutation({
          workspaceId: scope.scopeId,
          resourceId: hit.documentId,
          kind: current.status === "missing" ? "deleted" : "modified",
        });
      }
      const incomplete = store.coverage === "partial"
        || gaps.length > 0
        || store.lifecycle === "building"
        || store.lifecycle === "rebuilding"
        || (unverifiedPaths.get(key)?.size ?? 0) > 0
        || (diskIndexEnabled && [...(metadataUnverifiedPaths.get(key) ?? [])].some((path) => pathInRoots(path, searchOptions?.roots)))
        || (mutationPending.get(scopeId)?.size ?? 0) > 0;
      return {
        status: {
          ...status,
          status: incomplete ? "incomplete" : hits.length === 0 ? "empty" : "ready",
          coverage: store.coverage,
          lifecycle: store.lifecycle,
          generation: store.generation,
          spaceId: store.spaceId,
        },
        hits,
        gaps,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      try { options.onError?.(error); } catch { /* query failure is a status */ }
      return { status: { ...status, status: "failed" }, hits: [], gaps: [] };
    }
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0 || inFlightScans.size > 0) {
      await Promise.allSettled([...pending, ...inFlightScans.values()]);
    }
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    lifecycleController.abort();
    for (const controller of scanControllers.values()) controller.abort();
    scanControllers.clear();
    await drain();
    await Promise.allSettled([...stores.values()].map((store) => store.close()));
    stores.clear();
    verifiedScanMetadata.clear();
    metadataUnverifiedPaths.clear();
  };

  return {
    cancelScans: (): void => {
      for (const controller of scanControllers.values()) controller.abort();
    },
    observeDocumentMutation,
    scanScope,
    scanWorkspace: (workspaceId: string, scanOptions?: SemanticScanOptions) => (
      scanScope(workspaceScope(workspaceId), scanOptions)
    ),
    statusFor,
    scanProgress: (scope: SemanticScopeKey): SemanticScanProgress | null => (
      scanProgress.get(`${scope.scopeKind}\0${scope.scopeId}`) ?? null
    ),
    search,
    drain,
    dispose,
    scheduler,
  };
}

export type SemanticIndexRuntime = ReturnType<typeof createSemanticIndexRuntime>;
