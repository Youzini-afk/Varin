/** Event-driven file/symbol graph projection owned by the Application Host. */

import type {
  KnowledgeStore,
  SymbolGraphLinkInput,
  SymbolGraphSymbolInput,
  FileIndexSourceMetadata,
} from "./store.js";

/**
 * Identity of everything that turns a file into graph rows: the tree-sitter
 * queries in `structure/queries.ts`, `classifyLiteralCall` in
 * `structure/connections.ts`, and the outline flatten in `symbol-runtime.ts`.
 * Bump it whenever any of those changes what it emits. A file whose disk
 * revision is unchanged but whose stored extractor is older is re-collected by
 * the next catalog scan, so a fixed query actually reaches the graph instead
 * of waiting for every affected file to be edited (D-143).
 *
 * History: 1 = D-105/D-106 first link extraction; 2 = literal-call query pins
 * the string to the first argument and matches awaited generic calls; 3 =
 * preserve gated association candidates as compact file metadata so the gate
 * can be resolved without re-reading the source.
 */
export const CATALOG_EXTRACTOR_VERSION = 3;

export interface CollectedSymbols {
  symbols: SymbolGraphSymbolInput[];
  links?: SymbolGraphLinkInput[];
  /** Association call facts retained compactly for connect-gate re-evaluation. */
  associationCandidates?: SymbolGraphLinkInput[];
  /** Link extraction was blocked, so `links` is a floor rather than the set. */
  linksIncomplete?: boolean;
  /** Disk revision the ranges were computed from. */
  documentRevision: string;
  sourceMetadata?: FileIndexSourceMetadata;
  /** Native content verification retained the already published generation. */
  unchanged?: boolean;
}

export interface SymbolCollectorDeps {
  store: Pick<KnowledgeStore, "touchFile" | "replaceFileSymbols" | "removeFileSymbols" | "recordFileSourceMetadata">;
  getDocumentSymbols(path: string, language: string, signal?: AbortSignal): Promise<CollectedSymbols | null>;
  getLanguage(path: string): string | null;
  onError?: (error: unknown) => void;
}

export interface SymbolDocumentChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  signal?: AbortSignal;
}

/**
 * Replaces one file graph at a time. A null LSP result means unavailable and
 * preserves the last known symbols while refreshing the file fact; an empty
 * array is an authoritative successful result and removes stale symbols. Ranges
 * are always stored with the disk revision they were computed from (D-087).
 */
export function createSymbolCollector(deps: SymbolCollectorDeps) {
  const changes = new Map<string, { change: SymbolDocumentChange; version: number; controller: AbortController | null }>();
  const pending = new Set<Promise<void>>();
  let disposed = false;

  const run = async (change: SymbolDocumentChange): Promise<void> => {
    change.signal?.throwIfAborted();
    if (change.kind === "deleted") {
      await deps.store.removeFileSymbols(change.path, change.signal ? { signal: change.signal } : undefined);
      return;
    }
    const language = deps.getLanguage(change.path) ?? "unknown";
    if (language === "unknown") {
      await deps.store.touchFile(change.path, language);
      return;
    }
    const collected = await deps.getDocumentSymbols(change.path, language, change.signal);
    if (change.signal?.aborted) return;
    if (collected?.unchanged) {
      if (collected.sourceMetadata) await deps.store.recordFileSourceMetadata(change.path,
        collected.documentRevision, CATALOG_EXTRACTOR_VERSION, collected.sourceMetadata);
      return;
    }
    if (collected === null) await deps.store.touchFile(change.path, language);
    else await deps.store.replaceFileSymbols(
      change.path,
      language,
      collected.symbols,
      collected.documentRevision,
      collected.links,
      {
        ...(collected.linksIncomplete ? { linksIncomplete: true } : {}),
        ...(collected.associationCandidates ? { associationCandidates: collected.associationCandidates } : {}),
        extractor: CATALOG_EXTRACTOR_VERSION,
        ...(collected.sourceMetadata ? { sourceMetadata: collected.sourceMetadata } : {}),
      },
    );
  };

  const observe = (change: SymbolDocumentChange): void => {
    if (disposed) return;
    const existing = changes.get(change.path);
    if (existing) {
      existing.change = change;
      existing.version++;
      existing.controller?.abort();
      return;
    }
    const work = { change, version: 0, controller: null as AbortController | null };
    changes.set(change.path, work);
    const settled = Promise.resolve().then(async () => {
      while (!disposed) {
        const version = work.version;
        work.controller = new AbortController();
        const signal = AbortSignal.any([work.controller.signal, ...(work.change.signal ? [work.change.signal] : [])]);
        try { await run({ ...work.change, signal }); }
        catch (error) {
          if (!signal.aborted) {
            try { deps.onError?.(error); } catch { /* observational */ }
          }
        }
        if (version === work.version) break;
      }
      changes.delete(change.path);
    }).finally(() => {
      pending.delete(settled);
    });
    pending.add(settled);
  };

  const drain = async (): Promise<void> => {
    while (pending.size > 0) await Promise.allSettled([...pending]);
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    for (const work of changes.values()) work.controller?.abort();
    await drain();
    changes.clear();
  };

  return { observe, drain, dispose };
}

export type SymbolCollector = ReturnType<typeof createSymbolCollector>;
