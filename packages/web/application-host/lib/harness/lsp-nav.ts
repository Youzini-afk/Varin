import type { JsonValue, LspNavigationResult } from "@varin/protocol";
import type { DocumentAuthority } from "../documents/authority.js";
import type { createLanguageSupervisor } from "../lsp/supervisor.js";
import { createLanguageViewBinder, type LanguageTextSource, type BoundLanguageDocument, type ResolveLanguageTarget } from "../lsp/language-view.js";
import type { HarnessDocumentReadSource } from "./service-host.js";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import { languageIdForPath } from "./language-id.js";
import { identifierAt } from "../knowledge/relations.js";
import { pathInRoots } from "./explore-graph.js";

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>,
  "syncDocument" | "workspaceSymbols" | "definition" | "references" | "hover">;

interface LspNavigationDeps {
  documents: Pick<DocumentAuthority, "readSnapshot" | "readAgentInputSnapshot">;
  supervisor: LanguageSupervisor;
  readSource?: HarnessDocumentReadSource;
  resolveTarget?: ResolveLanguageTarget;
  /**
   * Persist already-obtained resolution results into the workspace knowledge
   * graph (D-240). Called only for disk-bound documents — a surface-draft
   * result never becomes a committed fact.
   */
  recordRelations?: (input: {
    workspaceId: string;
    sessionId: string;
    anchor: { path: string; line: number; character?: number };
    anchorRevision: string;
    name: string;
    resolvedBy: "lsp.references" | "lsp.definition";
    sites: Array<{ path: string; line: number; character?: number }>;
    target?: { path: string; line: number; character?: number; name?: string };
  }) => Promise<unknown>;
}

interface PreparedDocument {
  view: BoundLanguageDocument['view'];
  generation: number;
  viewRevision: number;
  documentVersion: number;
  languageId: string;
  resource: { workspaceId: string; resourceId: string };
  revision: string;
  languageRevision: string;
  source: LanguageTextSource;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const unavailable = (message: string): LspNavigationResult => message.includes("file resource is busy under lease")
  ? { status: "busy", text: "LSP busy: the file is in use. Retry this request." }
  : { status: "unavailable", text: message };
const empty = (message: string): LspNavigationResult => ({ status: "empty", text: message });

const startOf = (value: unknown): { line: number; character: number } | null => {
  const record = recordOf(value);
  const range = recordOf(record.targetSelectionRange ?? record.targetRange ?? record.range);
  const start = recordOf(range.start);
  return typeof start.line === "number" && typeof start.character === "number"
    ? { line: start.line + 1, character: start.character + 1 }
    : null;
};

const resourcePath = (value: unknown): string | null => {
  const resource = recordOf(recordOf(value).resource);
  return typeof resource.resourceId === "string" ? resource.resourceId : null;
};

/**
 * Varin synchronizes the queried document, so its positions are bound to a
 * named revision. Positions in other files come from the language server's own
 * read of those files and LSP does not report the version it used, so they are
 * reported as unpinned rather than claimed against a revision (D-087).
 */
const UNPINNED_NOTE = "[unpinned] positions came from the language server's own file read, not a bound revision; re-read those files before acting.";

interface AnnotatedLines {
  lines: string[];
  unpinnedPaths: string[];
}

const annotate = (
  entries: Array<{ path: string; text: string }>,
  prepared: PreparedDocument,
): AnnotatedLines => {
  const unpinned = new Set<string>();
  const lines = entries.map((entry) => {
    if (entry.path === prepared.resource.resourceId) return entry.text;
    unpinned.add(entry.path);
    return `${entry.text} [unpinned]`;
  });
  return { lines, unpinnedPaths: [...unpinned].sort() };
};

const symbolEntries = (value: unknown, inheritedPath: string): Array<{ path: string; text: string }> => {
  if (!Array.isArray(value)) return [];
  const entries: Array<{ path: string; text: string }> = [];
  const visit = (raw: unknown, fallbackPath: string): void => {
    const symbol = recordOf(raw);
    if (typeof symbol.name !== "string") return;
    const path = resourcePath(symbol) ?? fallbackPath;
    const start = startOf(symbol);
    entries.push({
      path,
      text: `${path}${start ? `:${start.line}:${start.character}` : ""} — ${symbol.name}${typeof symbol.kind === "number" ? ` (kind ${symbol.kind})` : ""}`,
    });
    if (Array.isArray(symbol.children)) for (const child of symbol.children) visit(child, path);
  };
  for (const symbol of value) visit(symbol, inheritedPath);
  return entries;
};

const locationEntries = (value: unknown): Array<{ path: string; text: string }> => (
  Array.isArray(value) ? value.flatMap((entry) => {
    const path = resourcePath(entry);
    const start = startOf(entry);
    return path && start ? [{ path, text: `${path}:${start.line}:${start.character}` }] : [];
  }) : []
);

const scopedLocations = (value: unknown, roots: readonly string[] | undefined): unknown[] => (
  Array.isArray(value) ? value.filter((entry) => {
    const path = resourcePath(entry);
    return path !== null && pathInRoots(path, roots);
  }) : []
);

const scopedSymbols = (value: unknown, roots: readonly string[] | undefined): unknown[] => {
  if (!Array.isArray(value)) return [];
  const visit = (entry: unknown, inheritedPath?: string): unknown[] => {
    const symbol = recordOf(entry);
    const path = resourcePath(symbol) ?? inheritedPath;
    const children = Array.isArray(symbol.children)
      ? symbol.children.flatMap((child) => visit(child, path))
      : [];
    if (!path || !pathInRoots(path, roots)) return children;
    return [{ ...symbol, children }];
  };
  return value.flatMap((entry) => visit(entry));
};

const hoverText = (value: unknown): string => {
  const contents = recordOf(value).contents;
  if (!Array.isArray(contents)) return "";
  return contents.flatMap((entry) => {
    const text = recordOf(entry).value;
    return typeof text === "string" && text.trim() ? [text.trim()] : [];
  }).join("\n\n");
};

const boundTo = (prepared: PreparedDocument): string => (
  `${prepared.resource.resourceId} @ ${prepared.revision} (${prepared.source})`
);

const ready = (
  prepared: PreparedDocument,
  text: string,
  value: unknown,
  unpinnedPaths: string[] = [],
): LspNavigationResult => ({
  status: "ready",
  text: unpinnedPaths.length > 0 ? `${text}\n${UNPINNED_NOTE}` : text,
  revision: prepared.revision,
  source: prepared.source,
  ...(unpinnedPaths.length > 0 ? { unpinnedPaths } : {}),
  ...(value === undefined ? {} : { value: value as JsonValue }),
});

export function createLspNavigationServices(deps: LspNavigationDeps): {
  symbols: HarnessService<"lsp.symbols">;
  definition: HarnessService<"lsp.definition">;
  references: HarnessService<"lsp.references">;
  hover: HarnessService<"lsp.hover">;
} {
  const binder = createLanguageViewBinder(deps);

  const prepareDocument = async (
    path: string,
    ctx: HarnessServiceContext,
  ): Promise<PreparedDocument | LspNavigationResult> => {
    const authorized = ctx.authorizedPaths.find((entry) => entry.inputPath === path);
    const workspaceId = authorized?.workspaceId ?? ctx.workspaceId;
    if (!workspaceId) return unavailable("LSP unavailable: document path was not authorized");
    const resourceId = authorized?.resourceId ?? path;
    const languageId = languageIdForPath(resourceId);
    if (!languageId) return unavailable(`LSP unavailable: unsupported file type for ${path}`);
    // Navigation follows the same fixed source as read/grep for this turn, so a
    // reported position refers to text the agent can actually obtain.
    const bound = await binder.bind({
      workspaceId,
      resourceId,
      languageId,
      text: "input-context",
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.inputContext ? { inputContext: ctx.inputContext } : {}),
      signal: ctx.signal,
      ...(ctx.reportPhase ? { reportPhase: ctx.reportPhase } : {}),
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('file resource is busy under lease')) return { status: 'unavailable' as const, message };
      throw error;
    });
    if (bound.status !== "bound") return unavailable(`LSP unavailable: ${bound.message}`);
    const { status: _status, ...document } = bound;
    return { ...document, languageId };
  };

  /**
   * Binds the document, asks the language server, and re-binds once when the
   * view moved to another revision between the two steps. A second stale answer
   * is reported instead of looping.
   */
  const query = async (
    path: string,
    ctx: HarnessServiceContext,
    run: (prepared: PreparedDocument) => Promise<unknown>,
  ): Promise<{ prepared: PreparedDocument; value: unknown } | LspNavigationResult> => {
    let lastStatus = "unavailable";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prepared = await prepareDocument(path, ctx);
      if ("status" in prepared) return prepared;
      ctx.signal.throwIfAborted();
      ctx.reportPhase?.('lsp:request');
      const result = recordOf(await run(prepared));
      if (result.status === "ready") return { prepared, value: result.value };
      lastStatus = typeof result.status === "string" ? result.status : "unavailable";
      if (lastStatus === "stale") continue;
      if (result.reason === "unsupported") {
        const provider = typeof result.providerId === "string" ? `, provider: ${result.providerId}` : "";
        return unavailable(`LSP unavailable: ${String(result.message)} (language: ${prepared.languageId}${provider}, file: ${path}). Select a representative file for the language you intend to query.`);
      }
      return unavailable(`LSP unavailable: ${String(result.message ?? `language service ${lastStatus}`)}`);
    }
    return unavailable(`LSP unavailable: ${path} changed while the language view was answering`);
  };

  const requestFor = (prepared: PreparedDocument) => ({
    view: prepared.view,
    resource: prepared.resource,
    languageId: prepared.languageId,
    expectedRevision: prepared.languageRevision,
    generation: prepared.generation,
    documentVersion: prepared.documentVersion,
    expectedViewRevision: prepared.viewRevision,
  });

  /**
   * Write-behind for the knowledge graph (D-240): a resolution the agent
   * already asked for becomes a committed fact only when the queried document
   * was bound to disk — a draft-bound answer is real but not graph evidence.
   * Persistence failure never fails the navigation result.
   */
  const persistResolved = (
    prepared: PreparedDocument,
    ctx: HarnessServiceContext,
    params: { path: string; line: number; character?: number },
    resolvedBy: "lsp.references" | "lsp.definition",
    value: unknown,
  ): void => {
    if (!deps.recordRelations || prepared.source !== "disk") return;
    const workspaceId = prepared.resource.workspaceId;
    const anchorPath = prepared.resource.resourceId;
    void (async () => {
      const snapshot = await deps.documents.readSnapshot({ workspaceId, resourceId: anchorPath }, { signal: ctx.signal });
      if (snapshot.status !== "ready" || snapshot.revision !== prepared.revision) return;
      const name = identifierAt(snapshot.content, params.line, params.character ?? 1)?.name;
      if (!name) return;
      const locations = (Array.isArray(value) ? value : []).flatMap((entry) => {
        const path = resourcePath(entry);
        const start = startOf(entry);
        return path && start ? [{ path, line: start.line, character: start.character }] : [];
      });
      if (resolvedBy === "lsp.references") {
      await deps.recordRelations!({
          workspaceId,
          sessionId: ctx.sessionId,
          anchor: { path: anchorPath, line: params.line, ...(params.character !== undefined ? { character: params.character } : {}) },
          anchorRevision: prepared.revision,
          name,
          resolvedBy,
          sites: locations,
        });
        return;
      }
      const target = locations[0];
      await deps.recordRelations!({
        workspaceId,
        sessionId: ctx.sessionId,
        anchor: { path: anchorPath, line: params.line, ...(params.character !== undefined ? { character: params.character } : {}) },
        anchorRevision: prepared.revision,
        name,
        resolvedBy,
        sites: [{ path: anchorPath, line: params.line, ...(params.character !== undefined ? { character: params.character } : {}) }],
        ...(target ? { target: { path: target.path, line: target.line, character: target.character, name } } : {}),
      });
    })().catch(() => {
      // Persistence is observational; a failed write-behind never fails the
      // navigation result the agent is waiting on.
    });
  };

  return {
    symbols: {
      handle: async (params, ctx) => {
        const outcome = await query(params.path, ctx, (prepared) => deps.supervisor.workspaceSymbols({
          ...requestFor(prepared),
          query: params.query,
        }, { signal: ctx.signal }));
        if ("status" in outcome) return outcome;
        const scoped = scopedSymbols(outcome.value, ctx.actor.workspaceScope);
        const { lines, unpinnedPaths } = annotate(symbolEntries(scoped, params.path), outcome.prepared);
        if (lines.length === 0) return empty("No symbols found");
        return ready(
          outcome.prepared,
          `${lines.length} symbols · queried ${boundTo(outcome.prepared)}\n${lines.join("\n")}`,
          scoped,
          unpinnedPaths,
        );
      },
    },
    definition: {
      handle: async (params, ctx) => {
        const outcome = await query(params.path, ctx, (prepared) => deps.supervisor.definition({
          ...requestFor(prepared),
          position: { line: params.line - 1, character: (params.character ?? 1) - 1 },
        }, { signal: ctx.signal }));
        if ("status" in outcome) return outcome;
        const scoped = scopedLocations(outcome.value, ctx.actor.workspaceScope);
        persistResolved(outcome.prepared, ctx, params, "lsp.definition", scoped);
        const { lines, unpinnedPaths } = annotate(locationEntries(scoped), outcome.prepared);
        if (lines.length === 0) return empty("No definition found");
        return ready(
          outcome.prepared,
          `queried ${boundTo(outcome.prepared)}\n${lines.join("\n")}`,
          scoped,
          unpinnedPaths,
        );
      },
    },
    references: {
      handle: async (params, ctx) => {
        const outcome = await query(params.path, ctx, (prepared) => deps.supervisor.references({
          ...requestFor(prepared),
          position: { line: params.line - 1, character: (params.character ?? 1) - 1 },
        }, { signal: ctx.signal }));
        if ("status" in outcome) return outcome;
        const scoped = scopedLocations(outcome.value, ctx.actor.workspaceScope);
        persistResolved(outcome.prepared, ctx, params, "lsp.references", scoped);
        const { lines, unpinnedPaths } = annotate(locationEntries(scoped), outcome.prepared);
        if (lines.length === 0) return empty("No references found");
        return ready(
          outcome.prepared,
          `${lines.length} references · queried ${boundTo(outcome.prepared)}\n${lines.join("\n")}`,
          scoped,
          unpinnedPaths,
        );
      },
    },
    hover: {
      handle: async (params, ctx) => {
        const outcome = await query(params.path, ctx, (prepared) => deps.supervisor.hover({
          ...requestFor(prepared),
          position: { line: params.line - 1, character: (params.character ?? 1) - 1 },
        }, { signal: ctx.signal }));
        if ("status" in outcome) return outcome;
        const text = hoverText(outcome.value);
        if (!text) return empty("No hover information");
        return ready(outcome.prepared, `${boundTo(outcome.prepared)}\n${text}`, outcome.value);
      },
    },
  };
}
