import pathModule from "node:path";
import { insideDirectory, indexPathAllowed, resolveScopedIndexRoots, resolveIndexScanRoots, type IndexScope } from "./index-scope.js";
import type { DocumentMutationObservation } from "../documents/authority.js";
import type { DocumentAuthority } from "../documents/authority.js";
import type { FileSearchItems } from "../fs/types.js";
import type { createLanguageSupervisor } from "../lsp/supervisor.js";
import { AGENT_LANGUAGE_VIEW } from "../lsp/supervisor.js";
import { createLanguageViewBinder } from "../lsp/language-view.js";
import { languageIdForPath } from "../harness/language-id.js";
import { classifyLiteralCall } from "../structure/connections.js";
import { CATALOG_SCAN_LANGUAGES } from "../structure/languages.js";
import type { StructureSource, StructureSymbol } from "../structure/types.js";
import { CATALOG_EXTRACTOR_VERSION, createSymbolCollector, type CollectedSymbols, type SymbolCollector } from "./symbols.js";
import type {
  KnowledgeStore,
  SymbolGraphLinkInput,
  SymbolGraphRange,
  SymbolGraphSymbolInput,
} from "./store.js";

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>,
  "syncDocument" | "documentSymbols">;

export { CATALOG_SCAN_LANGUAGES };
/**
 * Distinct paths handed to the collector at once. The collector serializes per
 * path and runs different paths concurrently, so this is also the store's write
 * burst size — the measurement script imports it rather than restating it, so
 * the recorded numbers describe the shape the product runs (D-140).
 */
export const CATALOG_SCAN_BATCH = 8;

export interface SymbolGraphRuntimeOptions {
  getStore(workspaceId: string): Promise<KnowledgeStore | null>;
  documents: Pick<DocumentAuthority, "read" | "readAgentInputSnapshot"> & {
    inspectWorkspace?: DocumentAuthority["inspectWorkspace"];
  };
  supervisor: LanguageSupervisor;
  structureSource?: StructureSource;
  searchFilesystemFiles?: (
    rootPath: string,
    options: { query: string; respectGitignore?: boolean; includeRevisions?: boolean; signal?: AbortSignal },
  ) => Promise<FileSearchItems>;
  isIndexablePath?: (workspaceId: string, path: string, signal: AbortSignal) => Promise<boolean>;
  getIndexScope?: () => IndexScope;
  onError?: (error: unknown) => void;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const symbolRange = (value: unknown): SymbolGraphRange | null => {
  const symbol = recordOf(value);
  const range = recordOf(symbol.selectionRange ?? symbol.range);
  const start = recordOf(range.start);
  const end = recordOf(range.end);
  return [start.line, start.character, end.line, end.character].every((part) => Number.isSafeInteger(part) && Number(part) >= 0)
    ? {
        startLine: Number(start.line),
        startCharacter: Number(start.character),
        endLine: Number(end.line),
        endCharacter: Number(end.character),
      }
    : null;
};

const flattenSymbols = (value: unknown): SymbolGraphSymbolInput[] => {
  if (!Array.isArray(value)) return [];
  const result: SymbolGraphSymbolInput[] = [];
  const visit = (raw: unknown): void => {
    const symbol = recordOf(raw);
    const range = symbolRange(symbol);
    if (typeof symbol.name === "string" && symbol.name.trim() && range) {
      result.push({
        name: symbol.name,
        kind: typeof symbol.kind === "number" || typeof symbol.kind === "string" ? String(symbol.kind) : "unknown",
        range,
      });
    }
    if (Array.isArray(symbol.children)) for (const child of symbol.children) visit(child);
  };
  for (const symbol of value) visit(symbol);
  return result;
};

/**
 * Structure outlines carry inclusive 1-based line spans with no columns, while
 * the graph stores a 0-based character range. Ending at column 0 of the last
 * line would exclude that line and make a single-line symbol zero-width, so the
 * end column comes from the real line length (D-110).
 */
const flattenOutlineSymbols = (
  symbols: readonly StructureSymbol[],
  lineLengths: readonly number[],
): SymbolGraphSymbolInput[] => {
  const result: SymbolGraphSymbolInput[] = [];
  const visit = (symbol: StructureSymbol): void => {
    if (symbol.name.trim()) {
      const startLine = Math.max(0, symbol.range.startLine - 1);
      const endLine = Math.max(startLine, symbol.range.endLine - 1);
      result.push({
        name: symbol.name,
        kind: symbol.kind,
        range: {
          startLine,
          startCharacter: 0,
          endLine,
          endCharacter: lineLengths[endLine] ?? 0,
        },
      });
    }
    for (const child of symbol.children ?? []) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return result;
};

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, 0);
});

export function createSymbolGraphRuntime(options: SymbolGraphRuntimeOptions) {
  const collectors = new Map<string, Promise<SymbolCollector | null>>();
  const pending = new Set<Promise<void>>();
  const relationRefreshes = new Map<string, { version: number }>();
  const binder = createLanguageViewBinder({ documents: options.documents, supervisor: options.supervisor });
  const catalogControllers = new Map<string, AbortController>();
  interface CatalogScanState {
    running: Promise<void> | null;
  }
  const catalogScans = new Map<string, CatalogScanState>();
  const manualWorkspaces = new Set<string>();
  let disposed = false;

  /**
   * The graph holds committed facts, so collection binds the Host language view
   * to the file's disk text and never reads an editor buffer. The range set is
   * returned with that revision, or null so the last known graph survives
   * (D-087).
   */
  const loadSymbolsFromLsp = async (
    workspaceId: string,
    path: string,
    languageId: string,
    signal?: AbortSignal,
  ): Promise<CollectedSymbols | null> => {
    if (signal?.aborted) return null;
    const bound = await binder.bind({ workspaceId, resourceId: path, languageId, text: "disk" });
    if (bound.status !== "bound") return null;
    if (signal?.aborted) return null;
    const response = await options.supervisor.documentSymbols({
      view: AGENT_LANGUAGE_VIEW,
      resource: { workspaceId, resourceId: path },
      languageId,
      expectedRevision: bound.revision,
    });
    if (signal?.aborted) return null;
    const result = recordOf(response);
    if (result.status !== "ready") return null;
    return { symbols: flattenSymbols(result.value), documentRevision: bound.revision };
  };

  const loadGraphFacts = async (
    workspaceId: string,
    path: string,
    languageId: string,
    signal?: AbortSignal,
  ): Promise<CollectedSymbols | null> => {
    const scope = options.getIndexScope?.();
    if (scope) {
      signal = AbortSignal.any([scope.signal, ...(signal ? [signal] : [])]);
      const root = (await options.documents.inspectWorkspace!(workspaceId)).root;
      const roots = await resolveScopedIndexRoots(root, scope, manualWorkspaces.has(workspaceId));
      if (signal.aborted || !indexPathAllowed(scope, pathModule.resolve(root, path), manualWorkspaces.has(workspaceId)) || !roots.some((directory) => insideDirectory(directory, pathModule.resolve(root, path)))) return null;
    }
    if (!options.structureSource) return loadSymbolsFromLsp(workspaceId, path, languageId, signal);
    let analysis;
    let lineLengths: number[];
    if (options.structureSource.analyzeFile && options.documents.inspectWorkspace) {
      let root: string;
      try { root = (await options.documents.inspectWorkspace(workspaceId)).root; }
      catch { return null; }
      analysis = await options.structureSource.analyzeFile({
        workspaceId,
        root,
        path,
        languageId,
        lane: "background",
        lines: [],
        ...(signal ? { signal } : {}),
      });
      lineLengths = analysis.lineLengths ?? [];
    } else {
      let snapshot: Awaited<ReturnType<DocumentAuthority["read"]>>;
      try { snapshot = await options.documents.read({ workspaceId, resourceId: path }); }
      catch { return null; }
      if (snapshot.status !== "ready") return null;
      if (signal?.aborted) return null;
      const request = {
        path,
        languageId,
        text: snapshot.content,
        revision: snapshot.revision,
        workspaceId,
        lane: "background" as const,
        ...(signal ? { signal } : {}),
      };
      analysis = options.structureSource.analyze
        ? await options.structureSource.analyze({ ...request, lines: [] })
        : undefined;
      if (!analysis) {
        const [outline, imports, literalCalls] = await Promise.all([
          options.structureSource.outline(request),
          options.structureSource.imports(request),
          options.structureSource.literalCalls(request),
        ]);
        analysis = { outline, imports, literalCalls, classify: { status: "unsupported", provider: null, revision: snapshot.revision, hits: [] } };
      }
      lineLengths = snapshot.content.split("\n").map((line) => line.replace(/\r$/u, "").length);
    }
    const { outline, imports: importsResult, literalCalls: callsResult } = analysis;
    if (signal?.aborted) return null;
    if (outline.status === "cancelled" || importsResult.status === "cancelled" || callsResult.status === "cancelled") {
      return null;
    }
    /**
     * The outline decides whether this generation may be written at all: an
     * empty symbol set is only authoritative when a provider actually answered.
     * A blocked link query never suppresses a working outline — a wasm failure
     * must degrade to defines-only, not freeze the file forever (D-111).
     */
    if (outline.status !== "ready" && outline.status !== "empty") {
      if (outline.status === "unsupported") return loadSymbolsFromLsp(workspaceId, path, languageId, signal);
      return null;
    }
    const answered = (status: string): boolean => status === "ready" || status === "empty" || status === "unsupported";
    const linksIncomplete = !answered(importsResult.status) || !answered(callsResult.status);
    const links: SymbolGraphLinkInput[] = [];
    const associationCandidates: SymbolGraphLinkInput[] = [];
    if (importsResult.status === "ready") {
      for (const item of importsResult.imports) {
        if (item.source.trim() && Number.isSafeInteger(item.line) && item.line >= 1) {
          links.push({ kind: "import", value: item.source, line: item.line });
        }
      }
    }
    if (callsResult.status === "ready") {
      const usable = callsResult.calls.filter((call) => (
        call.literal.trim().length > 0
        && classifyLiteralCall(call) !== null
        && Number.isSafeInteger(call.line)
        && call.line >= 1
      ));
      const candidates = usable.filter((call) => classifyLiteralCall(call) === "associates");
      /**
       * plan 3.11 marks a *same-name* string as an association candidate, so a
       * literal only qualifies once it is a confirmed connection value
       * somewhere. Without this gate every `it("…")` and `join("…")` becomes a
       * graph node (D-109).
       */
      // A file that both registers and mentions the same literal is the
      // clearest same-name case, and the store has not seen this generation
      // yet, so the gate consults this batch as well as the graph (D-109).
      const localConnections = new Set(usable
        .filter((call) => classifyLiteralCall(call) === "connects")
        .map((call) => call.literal));
      const unresolved = [...new Set(candidates
        .map((call) => call.literal)
        .filter((literal) => !localConnections.has(literal)))];
      const store = unresolved.length > 0 ? await options.getStore(workspaceId) : null;
      const knownLiterals = store ? await store.connectionLiterals(unresolved) : new Set<string>();
      for (const call of usable) {
        const classified = classifyLiteralCall(call)!;
        if (classified === "associates") {
          associationCandidates.push({ kind: classified, value: call.literal, line: call.line, callee: call.name });
          if (!localConnections.has(call.literal) && !knownLiterals.has(call.literal)) continue;
        }
        links.push({ kind: classified, value: call.literal, line: call.line, callee: call.name });
      }
    }
    return {
      symbols: flattenOutlineSymbols(outline.symbols, lineLengths),
      links,
      ...(associationCandidates.length > 0 ? { associationCandidates } : {}),
      ...(linksIncomplete ? { linksIncomplete: true } : {}),
      documentRevision: outline.revision,
    };
  };

  const collectorFor = (workspaceId: string): Promise<SymbolCollector | null> => {
    const existing = collectors.get(workspaceId);
    if (existing) return existing;
    const loading = options.getStore(workspaceId).then((store) => store ? createSymbolCollector({
      store,
      getLanguage: languageIdForPath,
      getDocumentSymbols: (path, language, signal) => loadGraphFacts(workspaceId, path, language, signal),
      ...(options.onError ? { onError: options.onError } : {}),
    }) : null);
    collectors.set(workspaceId, loading);
    void loading.catch(() => {
      if (collectors.get(workspaceId) === loading) collectors.delete(workspaceId);
    });
    void loading.then((collector) => {
      if (!collector && collectors.get(workspaceId) === loading) collectors.delete(workspaceId);
    }, () => undefined);
    return loading;
  };

  const track = (task: Promise<void>): void => {
    pending.add(task);
    void task.catch((error) => {
      try { options.onError?.(error); } catch { /* diagnostics cannot break observation */ }
    }).finally(() => pending.delete(task));
  };

  const observeDocumentMutation = (event: DocumentMutationObservation): void => {
    if (disposed) return;
    const scope = options.getIndexScope?.();
    track((async () => {
      if (scope) {
        const root = (await options.documents.inspectWorkspace!(event.workspaceId)).root;
        const roots = await resolveScopedIndexRoots(root, scope);
        if (scope.signal.aborted || !indexPathAllowed(scope, pathModule.resolve(root, event.resourceId)) || !roots.some((directory) => insideDirectory(directory, pathModule.resolve(root, event.resourceId)))) return;
      }
      const collector = await collectorFor(event.workspaceId);
      if (!collector) return;
      const eligible = event.kind === "deleted" || !options.isIndexablePath
        || await options.isIndexablePath(event.workspaceId, event.resourceId, scope?.signal ?? new AbortController().signal);
      if (disposed || scope?.signal.aborted) return;
      collector.observe({ path: event.resourceId, kind: eligible ? event.kind : "deleted", ...(scope ? { signal: scope.signal } : {}) });
      const existing = relationRefreshes.get(event.workspaceId);
      if (existing) { existing.version++; return; }
      const refresh = { version: 0 };
      relationRefreshes.set(event.workspaceId, refresh);
      try {
        while (!disposed) {
          await collector.drain();
          const version = refresh.version;
          const store = await options.getStore(event.workspaceId);
          if (store) await store.resolveAssociationCandidates();
          if (version === refresh.version) break;
        }
      } finally { relationRefreshes.delete(event.workspaceId); }
    })());
  };

  const scanWorkspace = (workspaceId: string, optionsForScan?: { signal?: AbortSignal; manual?: boolean }): Promise<void> => {
    if (disposed || !options.searchFilesystemFiles || !options.documents.inspectWorkspace) return Promise.resolve();
    if (optionsForScan?.signal?.aborted) return Promise.resolve();
    const state = catalogScans.get(workspaceId) ?? {
      running: null,
    };
    catalogScans.set(workspaceId, state);
    if (state.running) {
      if (optionsForScan?.manual && !manualWorkspaces.has(workspaceId)) catalogControllers.get(workspaceId)?.abort();
      if (!catalogControllers.get(workspaceId)?.signal.aborted) return state.running;
      return state.running.then(() => scanWorkspace(workspaceId, optionsForScan));
    }

    const controller = new AbortController();
    if (optionsForScan?.manual) manualWorkspaces.add(workspaceId);
    catalogControllers.set(workspaceId, controller);
    const scope = options.getIndexScope?.();
    const signal = AbortSignal.any([controller.signal,
      ...(optionsForScan?.signal ? [optionsForScan.signal] : []), ...(scope ? [scope.signal] : [])]);
    const task = Promise.resolve().then(async () => {
      try {
        if (signal.aborted) return;
        let root: string;
        try {
          root = (await options.documents.inspectWorkspace!(workspaceId)).root;
        } catch {
          return;
        }
        const roots = await (scope ? resolveScopedIndexRoots(root, scope, optionsForScan?.manual) : resolveIndexScanRoots(root, undefined));
        if (roots.length === 0 || signal.aborted) return;
        const inventories = await Promise.all(roots.map((directory) => options.searchFilesystemFiles!(directory, {
          query: "", respectGitignore: true, includeRevisions: true, signal,
        })));
        const files = inventories.flatMap((inventory, index) => {
          const prefix = pathModule.relative(root, roots[index]!).split(pathModule.sep).join('/');
          return inventory.map((file) => ({ ...file, relativePath: prefix ? `${prefix}/${file.relativePath}` : file.relativePath }));
        });
        if (signal.aborted) return;
        const store = await options.getStore(workspaceId);
        const collector = await collectorFor(workspaceId);
        if (!store || !collector) return;
        const catalogFiles = files.filter((file) => (!scope || indexPathAllowed(scope, pathModule.resolve(root, file.relativePath), optionsForScan?.manual))
          && CATALOG_SCAN_LANGUAGES.has(languageIdForPath(file.relativePath) ?? ""));
        const inventoryPaths = new Set(catalogFiles.map((file) => file.relativePath));
        for (let offset = 0; offset < catalogFiles.length; offset += CATALOG_SCAN_BATCH) {
          if (disposed || signal.aborted) return;
          const batch = catalogFiles.slice(offset, offset + CATALOG_SCAN_BATCH);
          for (const file of batch) {
            if (disposed || signal.aborted) return;
            const existing = await store.getFileRelations(file.relativePath);
            // Current only if both the source and the extractor that read it are
            // unchanged; rows from an older extractor are recomputed (D-143).
            if (file.revision
              && existing?.documentRevision === file.revision
              && existing.extractor === CATALOG_EXTRACTOR_VERSION) continue;
            collector.observe({ path: file.relativePath, kind: "modified", signal });
          }
          await collector.drain();
          await yieldToEventLoop();
        }
        if (disposed || signal.aborted) return;
        if (inventories.every((inventory) => inventory.enumerationStatus === "complete")) {
          // A complete inventory is the only authority allowed to remove a
          // path that disappeared from the current file set. Re-read a stale
          // path immediately before deletion so a concurrent recreation is
          // handed back to the collector instead of being removed from the
          // graph. The store-side revision/generation guard closes the normal
          // collector-vs-reconcile race in the write queue.
          const existingPaths = (await store.catalogStats()).paths;
          for (const stalePath of existingPaths) {
            if (inventoryPaths.has(stalePath)) continue;
            if (disposed || signal.aborted) return;
            const existing = await store.getFileRelations(stalePath);
            if (!existing) continue;
            if (!optionsForScan?.manual && scope && !indexPathAllowed(scope, pathModule.resolve(root, stalePath))
              && indexPathAllowed(scope, pathModule.resolve(root, stalePath), true)) continue;
            const selected = (!scope || indexPathAllowed(scope, pathModule.resolve(root, stalePath), optionsForScan?.manual)) && roots.some((directory) => insideDirectory(directory, pathModule.resolve(root, stalePath)));
            if (!selected) {
              await store.removeFileSymbols(stalePath, { expectedDocumentRevision: existing.documentRevision,
                expectedGeneration: existing.generation, signal });
              continue;
            }
            if (options.isIndexablePath) {
              let present: boolean;
              try { present = await options.isIndexablePath(workspaceId, stalePath, signal); }
              catch { continue; }
              if (signal.aborted || disposed) return;
              if (present) {
                collector.observe({ path: stalePath, kind: "modified", signal });
                continue;
              }
            } else {
              // Explicit unit-test seam. Production uses native membership
              // above and never reads file bodies to reconcile the catalog.
              let confirmation: Awaited<ReturnType<DocumentAuthority["read"]>>;
              try { confirmation = await options.documents.read({ workspaceId, resourceId: stalePath }); }
              catch { continue; }
              if (confirmation.status === "ready") {
                collector.observe({ path: stalePath, kind: "modified", signal });
                continue;
              }
              if (confirmation.status !== "missing") continue;
            }
            if (signal.aborted || disposed) return;
            await store.removeFileSymbols(stalePath, {
              expectedDocumentRevision: existing.documentRevision,
              expectedGeneration: existing.generation,
              signal,
            });
          }
          await collector.drain();
        }
        if (disposed || signal.aborted) return;
        // Gated calls were already extracted and persisted as compact metadata
        // on the current file row by replaceFileSymbols. Resolving them only
        // updates matching relation rows, so no source read or symbol
        // republish is needed here (D-109).
        await store.resolveAssociationCandidates();
      } catch (error) {
        if (signal.aborted || disposed) return;
        try { options.onError?.(error); } catch { /* catalog failures stay observational */ }
        if (optionsForScan?.manual) throw error;
      } finally {
        if (catalogControllers.get(workspaceId) === controller) {
          catalogControllers.delete(workspaceId);
          manualWorkspaces.delete(workspaceId);
        }
        if (state.running === task) state.running = null;
      }
    });
    state.running = task;
    return task;
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
    const loaded = await Promise.allSettled(collectors.values());
    await Promise.allSettled(loaded.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value.drain()] : []));
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    for (const controller of catalogControllers.values()) controller.abort();
    catalogControllers.clear();
    await drain();
    await Promise.allSettled([...catalogScans.values()]
      .flatMap((state) => state.running ? [state.running] : []));
    const loaded = await Promise.allSettled(collectors.values());
    await Promise.allSettled(loaded.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value.dispose()] : []));
    collectors.clear();
    catalogScans.clear();
  };

  return { observeDocumentMutation, scanWorkspace, drain, dispose,
    purgeDirectory: async (workspaceId: string, directory: string, resourceRoot?: string, preserveDirectories: readonly string[] = []) => {
      catalogControllers.get(workspaceId)?.abort();
      await catalogScans.get(workspaceId)?.running;
      const collector = await collectors.get(workspaceId);
      await collector?.dispose();
      collectors.delete(workspaceId);
      const store = await options.getStore(workspaceId);
      if (!store) return;
      const root = resourceRoot ?? (await options.documents.inspectWorkspace!(workspaceId)).root;
      let removed = false;
      for (const resourceId of (await store.catalogStats()).paths) {
        if (!insideDirectory(directory, pathModule.resolve(root, resourceId))) continue;
        if (preserveDirectories.some((retained) => insideDirectory(retained, pathModule.resolve(root, resourceId)))) continue;
        await store.removeFileSymbols(resourceId);
        removed = true;
      }
      if (removed) await store.compact();
    },
    refreshIndexScope: () => {
      for (const controller of catalogControllers.values()) controller.abort();
      for (const workspaceId of catalogScans.keys()) track(scanWorkspace(workspaceId));
    },
  };
}

export type SymbolGraphRuntime = ReturnType<typeof createSymbolGraphRuntime>;
