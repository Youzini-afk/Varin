import type { DocumentAuthority } from "../documents/authority.js";
import type { createLanguageSupervisor } from "../lsp/supervisor.js";
import { AGENT_LANGUAGE_VIEW } from "../lsp/supervisor.js";
import { createLanguageViewBinder } from "../lsp/language-view.js";
import { languageIdForPath } from "../harness/language-id.js";
import { pathInRoots } from "../harness/explore-graph.js";
import type { KnowledgeStore, SymbolGraphRelationInput, SymbolGraphRelationKind } from "./store.js";

type LanguageSupervisor = Pick<ReturnType<typeof createLanguageSupervisor>,
  | "getStatus"
  | "syncDocument"
  | "references"
  | "definition"
  | "prepareCallHierarchy"
  | "callHierarchyIncoming"
  | "callHierarchyOutgoing">;

/**
 * Resolved-relation collector (D-240). Two entry points share one persistence
 * path:
 *
 * - `collect` deliberately resolves references and call-hierarchy for a queried
 *   position (related.query's bounded resolution pass).
 * - `record` persists resolution results a navigation request already obtained
 *   (lsp.references / lsp.definition), so the graph accumulates facts around
 *   real queries instead of re-resolving them.
 *
 * Rows are file→link nodes on the *site* file's current generation, so they
 * participate in the existing recollect/delete lifecycle. Only the file the
 * collector bound itself is `pinned`; other sites are the language server's own
 * reads and stay unpinned with `documentRevision: null` (D-087). Nothing here
 * binds drafts — the graph records committed text only.
 */

export interface RelationAnchor {
  /** Workspace-relative path. */
  path: string;
  /** 1-based line of the queried position. */
  line: number;
  /** 1-based column; defaults to 1. */
  character?: number;
}

export type RelationSourceStatus =
  | "ready"
  | "empty"
  | "unavailable"
  | "unsupported"
  | "failed"
  | "stale"
  | "partial";

export interface ResolvedReferenceSite {
  path: string;
  /** 1-based. */
  line: number;
  character?: number;
  /** Enclosing catalog symbol at the site, when the catalog knows one. */
  caller?: string;
}

export interface ResolvedCallSite {
  /** Call-site file. */
  path: string;
  line: number;
  character?: number;
  /** Enclosing symbol making the call. */
  caller?: string;
  /** Called symbol name. */
  callee: string;
  targetPath?: string;
  targetName?: string;
}

export interface RelationCollectOutcome {
  status: RelationSourceStatus;
  /** Identifier at the queried position, when one was resolved. */
  name?: string;
  references: { status: RelationSourceStatus; sites: ResolvedReferenceSite[] };
  calls: { status: RelationSourceStatus; callers: ResolvedCallSite[]; callees: ResolvedCallSite[] };
}

export interface RelationRecordInput {
  /** The queried position the resolution came from. */
  anchor: RelationAnchor;
  /** Bound revision of the anchor file — pins only that file's own rows. */
  anchorRevision: string;
  /** Identifier name at the anchor. */
  name: string;
  resolvedBy: "lsp.references" | "lsp.definition";
  /** Reference sites the server returned. */
  sites: Array<{ path: string; line: number; character?: number }>;
  /** Resolved definition, when the request pinned one. */
  target?: { path: string; line: number; character?: number; name?: string };
}

export interface RelationCollectorDeps {
  documents: Pick<DocumentAuthority, "read" | "readSnapshot" | "readAgentInputSnapshot">;
  supervisor: LanguageSupervisor;
  /**
   * Already-open store for the workspace, or null — same already-open rule as
   * graphRecall: collecting never opens a database on the read path (D-112).
   */
  getStore(workspaceId: string): KnowledgeStore | null;
}

const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/;

/**
 * Identifier covering the 1-based (line, character) in `text`, if the position
 * lands on an identifier character. A space or punctuation between tokens is
 * not "the word before it" — returning an adjacent keyword would misname the
 * persisted row.
 */
export const identifierAt = (text: string, line: number, character: number): { name: string; start: number; end: number } | null => {
  const lines = text.split("\n");
  const row = lines[line - 1];
  if (row === undefined) return null;
  const column = Math.max(0, character - 1);
  if (column >= row.length || !/[A-Za-z0-9_$]/.test(row[column]!)) return null;
  let start = column;
  let end = column + 1;
  while (start > 0 && /[A-Za-z0-9_$]/.test(row[start - 1]!)) start -= 1;
  while (end < row.length && /[A-Za-z0-9_$]/.test(row[end]!)) end += 1;
  const name = row.slice(start, end);
  return IDENTIFIER_RE.test(name) ? { name, start, end } : null;
};

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const sourceStatusOf = (response: { status?: unknown; reason?: unknown }): RelationSourceStatus => {
  switch (response.status) {
    case "ready": return "ready";
    case "stale": return "stale";
    case "absent": return "unavailable";
    case "failed": return response.reason === "unsupported" ? "unsupported" : "failed";
    default: return "failed";
  }
};

interface MappedRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface MappedLocation {
  resource: { workspaceId: string; resourceId: string };
  /** Present on plain Location results (references). */
  range?: MappedRange;
  /** Present on LocationLink results (definition). */
  targetRange?: MappedRange;
  targetSelectionRange?: MappedRange;
}

interface MappedCallItem {
  name: string;
  kind: unknown;
  resource: { workspaceId: string; resourceId: string };
  range: MappedRange;
  selectionRange: MappedRange;
  detail?: string;
  itemToken?: string;
}

export function createRelationCollector(deps: RelationCollectorDeps) {
  const binder = createLanguageViewBinder({ documents: deps.documents, supervisor: deps.supervisor });

  /** Enclosing catalog symbol for a site, when the catalog has an outline. */
  const callerFor = async (
    store: KnowledgeStore | null,
    path: string,
    line: number,
  ): Promise<string | undefined> => {
    if (!store) return undefined;
    try {
      const symbols = await store.getDefinedSymbols(path);
      const line0 = line - 1;
      let best: { name: string; span: number } | undefined;
      for (const symbol of symbols) {
        const range = symbol.range;
        if (line0 < range.startLine || line0 > range.endLine) continue;
        const span = range.endLine - range.startLine;
        if (!best || span < best.span) best = { name: symbol.name, span };
      }
      return best?.name;
    } catch {
      return undefined;
    }
  };

  const addRow = (
    rows: Map<string, { language: string; relations: SymbolGraphRelationInput[] }>,
    path: string,
    relation: SymbolGraphRelationInput,
  ): void => {
    const language = languageIdForPath(path) ?? "unknown";
    const entry = rows.get(path) ?? { language, relations: [] };
    entry.relations.push(relation);
    rows.set(path, entry);
  };

  return {
    /**
     * Persist already-obtained resolution results. `anchorRevision` pins rows
     * on the anchor file itself; every other site stays unpinned.
     */
    async record(workspaceId: string, input: RelationRecordInput): Promise<{ recorded: number }> {
      const store = deps.getStore(workspaceId);
      if (!store) return { recorded: 0 };
      const rows = new Map<string, { language: string; relations: SymbolGraphRelationInput[] }>();
      for (const site of input.sites) {
        const pinned = site.path === input.anchor.path;
        addRow(rows, site.path, {
          kind: "references",
          value: input.name,
          line: site.line,
          ...(site.character !== undefined ? { character: site.character } : {}),
          ...(input.target
            ? {
              targetPath: input.target.path,
              targetName: input.target.name ?? input.name,
              ...(input.target.line !== undefined ? { targetLine: input.target.line } : {}),
            }
            : {}),
          anchorPath: input.anchor.path,
          anchorLine: input.anchor.line,
          resolvedBy: input.resolvedBy,
          siteRevision: pinned ? input.anchorRevision : null,
        });
      }
      // Enrich sites with the catalog's enclosing symbol when it knows one.
      for (const [path, entry] of rows) {
        for (const relation of entry.relations) {
          if (relation.caller) continue;
          const caller = await callerFor(store, path, relation.line);
          if (caller) relation.caller = caller;
        }
      }
      await store.replaceResolvedRelationsForAnchor(
        { path: input.anchor.path, line: input.anchor.line },
        [...rows.entries()].map(([path, entry]) => ({ path, language: entry.language, relations: entry.relations })),
        ["references"],
      );
      return { recorded: rows.size };
    },

    /**
     * Resolve references and call hierarchy around a queried position and
     * persist what was actually returned. Bounded: one references pass, one
     * definition pass, and one call-hierarchy chain for this anchor only —
     * never a repository-wide sweep.
     */
    async collect(
      workspaceId: string,
      anchor: RelationAnchor,
      options: { kinds?: readonly ("references" | "calls")[]; roots?: readonly string[]; signal?: AbortSignal } = {},
    ): Promise<RelationCollectOutcome> {
      const kinds = new Set<SymbolGraphRelationKind>(options.kinds ?? ["references", "calls"]);
      const roots = options.roots;
      const empty = (status: RelationSourceStatus): RelationCollectOutcome => ({
        status,
        references: { status, sites: [] },
        calls: { status, callers: [], callees: [] },
      });
      const languageId = languageIdForPath(anchor.path);
      if (!languageId) return empty("unsupported");
      const bound = await binder.bind({
        workspaceId,
        resourceId: anchor.path,
        languageId,
        text: "disk",
      });
      if (bound.status !== "bound") return empty("unavailable");
      const snapshot = await deps.documents.read({ workspaceId, resourceId: anchor.path });
      if (snapshot.status !== "ready" || snapshot.revision !== bound.revision) return empty("stale");
      const identifier = identifierAt(snapshot.content, anchor.line, anchor.character ?? 1);
      if (!identifier) return empty("empty");
      const name = identifier.name;
      options.signal?.throwIfAborted();

      const resource = { workspaceId, resourceId: anchor.path };
      const position = { line: anchor.line - 1, character: (anchor.character ?? 1) - 1 };
      const request = {
        view: AGENT_LANGUAGE_VIEW,
        resource,
        languageId,
        expectedRevision: bound.revision,
        position,
      };

      const outcome: RelationCollectOutcome = {
        status: "ready",
        name,
        references: { status: kinds.has("references") ? "empty" : "unsupported", sites: [] },
        calls: { status: kinds.has("calls") ? "empty" : "unsupported", callers: [], callees: [] },
      };

      let target: { path: string; line: number; name: string } | undefined;
      if (kinds.has("references")) {
        const [refsRaw, defsRaw] = await Promise.all([
          deps.supervisor.references(request),
          deps.supervisor.definition(request),
        ]);
        const refs = recordOf(refsRaw);
        const defs = recordOf(defsRaw);
        outcome.references.status = refs.status === "ready" ? "empty" : sourceStatusOf(refs);
        if (defs.status === "ready") {
          const first = (defs.value as MappedLocation[] | undefined)?.[0];
          const defRange = first?.targetSelectionRange ?? first?.targetRange;
          if (first && defRange && pathInRoots(first.resource.resourceId, roots)) {
            target = { path: first.resource.resourceId, line: defRange.start.line + 1, name };
          }
        }
        if (refs.status === "ready") {
          const locations = (refs.value as MappedLocation[] | undefined) ?? [];
          outcome.references.sites = locations.flatMap((location) => {
            const range = location.range;
            if (!range) return [];
            // Out-of-scope sites are neither returned nor persisted (D-240 rework).
            if (!pathInRoots(location.resource.resourceId, roots)) return [];
            return [{
              path: location.resource.resourceId,
              line: range.start.line + 1,
              character: range.start.character + 1,
            }];
          });
          if (outcome.references.sites.length > 0) outcome.references.status = "ready";
        }
      }

      if (kinds.has("calls")) {
        const prepared = recordOf(await deps.supervisor.prepareCallHierarchy(request));
        if (prepared.status === "ready") {
          const items = (prepared.value as MappedCallItem[] | undefined) ?? [];
          const item = items[0];
          if (item?.itemToken) {
            const [incomingRaw, outgoingRaw] = await Promise.all([
              deps.supervisor.callHierarchyIncoming({ ...request, itemToken: item.itemToken }),
              deps.supervisor.callHierarchyOutgoing({ ...request, itemToken: item.itemToken }),
            ]);
            const incoming = recordOf(incomingRaw);
            const outgoing = recordOf(outgoingRaw);
            if (incoming.status === "ready") {
              const calls = (incoming.value as Array<{ from: MappedCallItem; fromRanges: MappedRange[] }> | undefined) ?? [];
              for (const call of calls) {
                // Out-of-scope callers are neither returned nor persisted (D-240 rework).
                if (!pathInRoots(call.from.resource.resourceId, roots)) continue;
                for (const range of call.fromRanges) {
                  outcome.calls.callers.push({
                    path: call.from.resource.resourceId,
                    line: range.start.line + 1,
                    character: range.start.character + 1,
                    caller: call.from.name,
                    callee: name,
                    targetPath: anchor.path,
                    targetName: name,
                  });
                }
              }
            }
            if (outgoing.status === "ready") {
              const calls = (outgoing.value as Array<{ to: MappedCallItem; fromRanges: MappedRange[] }> | undefined) ?? [];
              for (const call of calls) {
                // Out-of-scope callees are neither returned nor persisted (D-240 rework).
                if (!pathInRoots(call.to.resource.resourceId, roots)) continue;
                for (const range of call.fromRanges) {
                  outcome.calls.callees.push({
                    path: anchor.path,
                    line: range.start.line + 1,
                    character: range.start.character + 1,
                    caller: name,
                    callee: call.to.name,
                    targetPath: call.to.resource.resourceId,
                    targetName: call.to.name,
                  });
                }
              }
            }
            if (outcome.calls.callers.length + outcome.calls.callees.length > 0) {
              // incoming/outgoing 任一方向 failed/stale/unavailable 时，另一方向
              // 有一条结果不能把整组标成 ready (D-240 rework)。
              const oneDirectionFailed = incoming.status !== "ready" || outgoing.status !== "ready";
              outcome.calls.status = oneDirectionFailed ? "partial" : "ready";
            } else if (incoming.status !== "ready" || outgoing.status !== "ready") {
              outcome.calls.status = sourceStatusOf(incoming.status !== "ready" ? incoming : outgoing);
            }
          }
        } else {
          outcome.calls.status = sourceStatusOf(prepared);
        }
      }

      // Persist: references rows land on each site file; call rows on the file
      // holding the call site (caller's file for incoming, queried file for
      // outgoing).
      const store = deps.getStore(workspaceId);
      if (store) {
        const rows = new Map<string, { language: string; relations: SymbolGraphRelationInput[] }>();
        for (const site of outcome.references.sites) {
          const pinned = site.path === anchor.path;
          addRow(rows, site.path, {
            kind: "references",
            value: name,
            line: site.line,
            ...(site.character !== undefined ? { character: site.character } : {}),
            ...(target
              ? { targetPath: target.path, targetName: target.name, targetLine: target.line }
              : {}),
            anchorPath: anchor.path,
            anchorLine: anchor.line,
            resolvedBy: "lsp.references",
            siteRevision: pinned ? bound.revision : null,
          });
        }
        for (const call of outcome.calls.callers) {
          addRow(rows, call.path, {
            kind: "calls",
            value: call.callee,
            line: call.line,
            ...(call.character !== undefined ? { character: call.character } : {}),
            ...(call.caller ? { caller: call.caller } : {}),
            targetPath: anchor.path,
            targetName: name,
            anchorPath: anchor.path,
            anchorLine: anchor.line,
            resolvedBy: "lsp.callHierarchy.incoming",
            siteRevision: call.path === anchor.path ? bound.revision : null,
          });
        }
        for (const call of outcome.calls.callees) {
          addRow(rows, call.path, {
            kind: "calls",
            value: call.callee,
            line: call.line,
            ...(call.character !== undefined ? { character: call.character } : {}),
            caller: name,
            ...(call.targetPath ? { targetPath: call.targetPath, targetName: call.targetName } : {}),
            anchorPath: anchor.path,
            anchorLine: anchor.line,
            resolvedBy: "lsp.callHierarchy.outgoing",
            siteRevision: call.path === anchor.path ? bound.revision : null,
          });
        }
        for (const [path, entry] of rows) {
          for (const relation of entry.relations) {
            if (relation.caller) continue;
            const caller = await callerFor(store, path, relation.line);
            if (caller) relation.caller = caller;
          }
        }
        // Authoritative reparse (D-240 rework): one batch call per anchor that
        // removes disappeared sites. The batch identity is the anchor, not
        // individual non-empty path writes — a site that existed before but
        // vanished this resolution is cleared.
        await store.replaceResolvedRelationsForAnchor(
          { path: anchor.path, line: anchor.line },
          [...rows.entries()].map(([path, entry]) => ({ path, language: entry.language, relations: entry.relations })),
          [...kinds],
        );
      }

      const statuses = [outcome.references.status, outcome.calls.status];
      if (statuses.includes("partial")) outcome.status = "partial";
      else if (statuses.includes("ready")) outcome.status = "ready";
      else if (statuses.every((status) => status === "unsupported")) outcome.status = "unsupported";
      else if (statuses.includes("stale")) outcome.status = "stale";
      else if (statuses.every((status) => status === "empty" || status === "unsupported")) outcome.status = "empty";
      else if (statuses.includes("failed")) outcome.status = "failed";
      else outcome.status = "unavailable";
      return outcome;
    },
  };
}

export type RelationCollector = ReturnType<typeof createRelationCollector>;
