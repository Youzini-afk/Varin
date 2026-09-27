/**
 * related — file-level topology plus language-service-resolved relations.
 *
 * Answers what a path (or symbol name) defines, imports, is imported by, which
 * connection literals it sits on — and, when a language server is wired, the
 * resolved reference sites and call edges around the anchor (D-240). Resolved
 * relations are persisted on the symbol graph around real queries; explore
 * consumes the same stored edges.
 *
 * Design: design/harness-retrieval.md §6.2
 * Plan: plan/agent-harness-plan.md §3.12
 */

import type {
  HarnessFileRoleDecision,
  RelatedCallEdge,
  RelatedQueryResult,
  RelatedQueryStatus,
  RelatedReferenceSite,
  RelatedRelationStatus,
} from "@varin/protocol";
import { resolveImportSpecifier } from "../knowledge/import-resolve.js";
import type { RelationCollectOutcome } from "../knowledge/relations.js";
import type { KnowledgeStore, SymbolGraphRelationRecord } from "../knowledge/store.js";
import { classifyFileRoleDecision } from "./file-role.js";
import { pathInRoots } from "./explore-graph.js";
import { looksLikePathObject } from "./explore-query.js";

export interface RelatedQueryInput {
  anchor: string;
}

/**
 * Bounded live resolution for the anchor (D-240). One collect call per
 * definition — references + call hierarchy — never a repository sweep.
 */
export interface RelatedRelationCollector {
  collect(
    workspaceId: string,
    anchor: { path: string; line: number; character?: number },
    options?: { roots?: readonly string[]; signal?: AbortSignal },
  ): Promise<RelationCollectOutcome>;
}

export interface RelatedQueryDeps {
  workspaceId?: string;
  collector?: RelatedRelationCollector | null;
  /**
   * Actor's effective workspace scope (authorized roots). Applied to
   * definition candidates, collector input, LSP returned locations,
   * targetPath, persisted graph rows, and the final body — out-of-scope
   * content is neither returned nor written (D-240 rework).
   */
  roots?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Visible caps so a hub file or a common name cannot hand the generic 32 KiB
 * tool-result truncation the decision of which section disappears. `details`
 * still carries every item; only the text is capped, and it says how many it
 * left out (D-139).
 */
export const RELATED_SECTION_LIMIT = 40;
export const RELATED_FOCUS_LIMIT = 8;
/**
 * Defined symbols per path anchor that get a caller lookup — bounded so a
 * symbol-dense file cannot fan out unbounded index reads per query.
 */
export const RELATED_CALLER_SYMBOL_LIMIT = 8;

function capped<T>(items: readonly T[], limit: number): { shown: readonly T[]; omitted: number } {
  return items.length <= limit
    ? { shown: items, omitted: 0 }
    : { shown: items.slice(0, limit), omitted: items.length - limit };
}

const looksLikePath = looksLikePathObject;

const compareText = (left: string, right: string): number => left.localeCompare(right);

const relationStatus = (rowCount: number, outcomes: readonly string[]): RelatedRelationStatus => {
  const failed = outcomes.some((outcome) => outcome === "failed" || outcome === "stale" || outcome === "unavailable");
  // incoming/outgoing 任一方向 failed/stale/unavailable 时，另一方向有一条结果
  // 不能把整组标成 ready (D-240 rework)。
  if (rowCount > 0) return failed ? "partial" : "ready";
  if (outcomes.length === 0) return "unavailable";
  if (outcomes.every((outcome) => outcome === "unsupported")) return "unsupported";
  const worked = outcomes.some((outcome) => outcome === "ready" || outcome === "empty");
  if (worked && failed) return "partial";
  if (worked) return "empty";
  if (failed) return "failed";
  return "empty";
};

const referenceItem = (record: SymbolGraphRelationRecord, roots?: readonly string[]): RelatedReferenceSite => ({
  path: record.path,
  line: record.line,
  ...(record.character !== undefined ? { character: record.character } : {}),
  ...(record.caller !== undefined ? { caller: record.caller } : {}),
  ...(record.targetPath !== undefined && pathInRoots(record.targetPath, roots) ? { targetPath: record.targetPath } : {}),
  ...(record.targetName !== undefined ? { targetName: record.targetName } : {}),
  pinned: record.pinned,
  ...(record.staleTarget ? { staleTarget: true } : {}),
  resolvedBy: record.resolvedBy,
});

const callEdge = (record: SymbolGraphRelationRecord, roots?: readonly string[]): RelatedCallEdge => ({
  path: record.path,
  line: record.line,
  ...(record.character !== undefined ? { character: record.character } : {}),
  ...(record.caller !== undefined ? { caller: record.caller } : {}),
  callee: record.targetName ?? record.value,
  ...(record.targetPath !== undefined && pathInRoots(record.targetPath, roots) ? { targetPath: record.targetPath } : {}),
  ...(record.targetName !== undefined ? { targetName: record.targetName } : {}),
  pinned: record.pinned,
  ...(record.staleTarget ? { staleTarget: true } : {}),
  resolvedBy: record.resolvedBy,
});

export async function executeRelated(
  input: RelatedQueryInput,
  store: KnowledgeStore,
  deps: RelatedQueryDeps = {},
): Promise<RelatedQueryResult> {
  const anchor = input.anchor.trim();
  const empty = (status: RelatedQueryStatus, kind: "path" | "name", message: string): RelatedQueryResult => ({
    text: message,
    status,
    anchor: { kind, value: anchor },
    roles: [],
    definitions: [],
    imports: { items: [], unresolved: [], incomplete: false },
    importers: { items: [], incomplete: false },
    connections: { items: [], incomplete: false },
    references: { status: "unavailable", items: [], incomplete: false },
    calls: { status: "unavailable", callers: [], callees: [], incomplete: false },
  });
  if (!anchor) {
    return empty("failed", "name", "related failed: provide a path or symbol name.");
  }

  const stats = await store.catalogStats();
  if (stats.symbolCount === 0 && stats.fileCount === 0) {
    return empty(
      "empty",
      looksLikePath(anchor) ? "path" : "name",
      "related empty: the symbol catalog has no files. Catalog languages are TypeScript and JavaScript (including JSX); other languages are not missing, they are not collected.",
    );
  }

  const known = new Set(stats.paths);
  const roots = deps.roots;
  const kind = looksLikePath(anchor) ? "path" : "name";
  let focusPaths: string[] = [];
  let anchorSymbols: Array<{ path: string; name: string; kind: string; range: { startLine: number; startCharacter: number } }> = [];
  if (kind === "path") {
    const normalized = anchor.replace(/\\/g, "/");
    if (!known.has(normalized)) {
      return empty("empty", "path", `related empty: the catalog has not collected ${normalized}.`);
    }
    if (!pathInRoots(normalized, roots)) {
      return empty("empty", "path", `related empty: ${normalized} is outside the authorized workspace scope.`);
    }
    focusPaths = [normalized];
  } else {
    const exact = (await store.searchSymbols(anchor, 32, roots)).filter((entry) => entry.match === "exact");
    anchorSymbols = exact.map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind, range: entry.range }));
    focusPaths = [...new Set(exact.map((entry) => entry.path))];
    if (focusPaths.length === 0) {
      const links = (await store.findLinks(anchor)).filter((entry) => pathInRoots(entry.path, roots));
      focusPaths = [...new Set(links.map((entry) => entry.path))];
    }
  }
  if (focusPaths.length === 0) {
    return empty(
      "empty",
      kind,
      `related empty: nothing in the catalog matched ${anchor}.`,
    );
  }

  const definitions: RelatedQueryResult["definitions"] = [];
  const importItems: RelatedQueryResult["imports"]["items"] = [];
  const unresolved: RelatedQueryResult["imports"]["unresolved"] = [];
  const importerItems: RelatedQueryResult["importers"]["items"] = [];
  const connectionItems: RelatedQueryResult["connections"]["items"] = [];
  let importsIncomplete = false;
  let importersIncomplete = false;
  let connectionsIncomplete = false;

  const focus = capped(focusPaths.toSorted(compareText), RELATED_FOCUS_LIMIT);

  // Bounded live resolution for a name anchor (D-240): one references +
  // call-hierarchy pass per exact definition, capped by the focus limit. The
  // collector persists what it resolved, so the stored reads below already
  // include the fresh rows — nothing is merged twice.
  const referenceOutcomes: string[] = [];
  const callOutcomes: string[] = [];
  if (kind === "name" && deps.collector && deps.workspaceId) {
    const anchors = capped(anchorSymbols.toSorted((left, right) => compareText(left.path, right.path) || left.name.localeCompare(right.name)), RELATED_FOCUS_LIMIT);
    for (const symbol of anchors.shown) {
      try {
        const outcome = await deps.collector.collect(deps.workspaceId, {
          path: symbol.path,
          line: symbol.range.startLine + 1,
          character: symbol.range.startCharacter + 1,
        }, { ...(deps.signal ? { signal: deps.signal } : {}), ...(roots ? { roots } : {}) });
        referenceOutcomes.push(outcome.references.status);
        callOutcomes.push(outcome.calls.status);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        referenceOutcomes.push("failed");
        callOutcomes.push("failed");
      }
    }
  }

  for (const path of focus.shown) {
    for (const symbol of await store.getDefinedSymbols(path)) {
      definitions.push({ name: symbol.name, kind: symbol.kind, path: symbol.path });
    }
    const relations = await store.getFileRelations(path);
    if (!relations) continue;
    if (relations.linksIncomplete) {
      importsIncomplete = true;
      importersIncomplete = true;
      connectionsIncomplete = true;
    }
    for (const item of relations.imports) {
      const resolved = resolveImportSpecifier(path, item.specifier, known);
      if (resolved.status === "resolved") {
        importItems.push({ specifier: item.specifier, path, resolvedPath: resolved.resolvedPath });
      } else {
        unresolved.push({ specifier: item.specifier, path, reason: resolved.status });
      }
    }
    const importers = await store.findImporters(path);
    importerItems.push(...importers.resolved.filter((item) => pathInRoots(item.path, roots)));
    for (const connection of relations.connections) {
      const ends = (await store.findLinks(connection.literal)).filter((end) => pathInRoots(end.path, roots));
      connectionItems.push({
        literal: connection.literal,
        callee: connection.callee,
        path,
        otherEnds: ends
          .filter((end) => end.path !== path)
          .map((end) => ({
            path: end.path,
            kind: end.kind,
            ...(end.callee ? { callee: end.callee } : {}),
          })),
      });
    }
  }

  // Resolved-relation sections (D-240). Name anchor: every stored site whose
  // resolved name matches the anchor. Path anchor: the file's own reference and
  // call sites, plus call sites whose resolved target lives in this file.
  // All reads apply the actor's effective workspace scope so out-of-scope
  // content is neither returned nor written (D-240 rework).
  const referenceItems: RelatedReferenceSite[] = [];
  const callerEdges: RelatedCallEdge[] = [];
  const calleeEdges: RelatedCallEdge[] = [];
  let relationsIncomplete = focus.omitted > 0;
  if (kind === "name") {
    for (const record of await store.findReferences(anchor, roots)) {
      if (pathInRoots(record.path, roots)) referenceItems.push(referenceItem(record, roots));
    }
    for (const record of await store.findCallers(anchor, roots)) {
      if (pathInRoots(record.path, roots)) callerEdges.push(callEdge(record, roots));
    }
    for (const record of await store.findCalls(anchor, roots)) {
      if (pathInRoots(record.path, roots)) calleeEdges.push(callEdge(record, roots));
    }
  } else {
    const path = focusPaths[0]!;
    const relations = await store.getFileRelations(path);
    if (relations) {
      for (const record of relations.references) {
        if (pathInRoots(record.path, roots)) referenceItems.push(referenceItem(record, roots));
      }
      for (const record of relations.calls) {
        if (pathInRoots(record.path, roots)) calleeEdges.push(callEdge(record, roots));
      }
    }
    const definedSymbols = capped(definitions.filter((item) => item.path === path), RELATED_CALLER_SYMBOL_LIMIT);
    if (definitions.filter((item) => item.path === path).length > definedSymbols.shown.length) relationsIncomplete = true;
    for (const symbol of definedSymbols.shown) {
      for (const record of await store.findCallers(symbol.name, roots)) {
        if (record.targetPath === path && pathInRoots(record.path, roots)) callerEdges.push(callEdge(record, roots));
      }
    }
  }
  const referenceItemsDeduped = [...new Map(referenceItems.map((item) => [`${item.path}:${item.line}:${item.character ?? 0}:${item.targetName ?? item.caller ?? ""}`, item])).values()];
  const callerEdgesDeduped = [...new Map(callerEdges.map((item) => [`${item.path}:${item.line}:${item.callee}`, item])).values()];
  const calleeEdgesDeduped = [...new Map(calleeEdges.map((item) => [`${item.path}:${item.line}:${item.callee}:${item.caller ?? ""}`, item])).values()];

  const result: RelatedQueryResult = {
    text: "",
    status: "ready",
    anchor: { kind, value: anchor },
    roles: [],
    definitions: definitions.toSorted((left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name)),
    imports: {
      items: importItems.toSorted((left, right) => left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier)),
      unresolved: unresolved.toSorted((left, right) => left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier)),
      incomplete: importsIncomplete,
    },
    importers: {
      items: importerItems.toSorted((left, right) => left.path.localeCompare(right.path) || left.specifier.localeCompare(right.specifier)),
      incomplete: importersIncomplete,
    },
    connections: {
      items: connectionItems.toSorted((left, right) => left.path.localeCompare(right.path) || left.literal.localeCompare(right.literal)),
      incomplete: connectionsIncomplete,
    },
    references: {
      status: relationStatus(referenceItemsDeduped.length, referenceOutcomes),
      items: referenceItemsDeduped.toSorted((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
      incomplete: relationsIncomplete,
    },
    calls: {
      status: relationStatus(callerEdgesDeduped.length + calleeEdgesDeduped.length, callOutcomes),
      callers: callerEdgesDeduped.toSorted((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
      callees: calleeEdgesDeduped.toSorted((left, right) => left.path.localeCompare(right.path) || left.line - right.line),
      incomplete: relationsIncomplete,
    },
  };
  result.roles = rolesForRelated(result);
  result.text = formatRelatedText(result, focus.omitted);
  return result;
}

function rolesForRelated(result: RelatedQueryResult): HarnessFileRoleDecision[] {
  const paths = new Set<string>();
  if (result.anchor.kind === "path" && result.anchor.value) paths.add(result.anchor.value.replace(/\\/g, "/"));
  for (const item of result.definitions) paths.add(item.path);
  for (const item of result.imports.items) {
    paths.add(item.path);
    if (item.resolvedPath) paths.add(item.resolvedPath);
  }
  for (const item of result.imports.unresolved) paths.add(item.path);
  for (const item of result.importers.items) paths.add(item.path);
  for (const item of result.connections.items) {
    paths.add(item.path);
    for (const end of item.otherEnds) paths.add(end.path);
  }
  return [...paths].toSorted(compareText).map((path) => {
    const decision = classifyFileRoleDecision(path);
    return { path, role: decision.role, ground: decision.ground };
  });
}

function formatRelatedText(result: RelatedQueryResult, focusOmitted: number): string {
  const lines: string[] = [
    `related ${result.anchor.value} (${result.anchor.kind}) · ${result.status}`,
    "File-level import topology, connection endpoints, and language-server-resolved reference/call edges from the symbol graph. Sites marked [unpinned] came from the server's own read of another file — re-read them before acting.",
  ];
  if (focusOmitted > 0) {
    lines.push(`Anchor matched ${focusOmitted} more file(s) than were walked; the first ${RELATED_FOCUS_LIMIT} in path order are below. Narrow the anchor to a path for the rest.`);
  }
  if (result.roles.length > 0) {
    lines.push("Roles (query-time, not stored on the graph):");
    const shown = capped(result.roles, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) lines.push(`- ${item.path} ${item.role} · ${item.ground}`);
    if (shown.omitted > 0) lines.push(`- … ${shown.omitted} more (full list in details)`);
  }
  const note = (omitted: number): void => {
    if (omitted > 0) lines.push(`- … ${omitted} more (full list in details)`);
  };
  if (result.definitions.length === 0) lines.push("Defines: none");
  else {
    lines.push("Defines:");
    const shown = capped(result.definitions, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) lines.push(`- ${item.path} ${item.name} (${item.kind})`);
    note(shown.omitted);
  }
  if (result.imports.items.length === 0 && result.imports.unresolved.length === 0) {
    lines.push(result.imports.incomplete ? "Imports: incomplete (edge extraction was blocked for this revision)" : "Imports: none");
  } else {
    lines.push("Imports:");
    const shown = capped(result.imports.items, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) {
      lines.push(`- ${item.path} ${item.specifier} → ${item.resolvedPath ?? "resolved"}`);
    }
    note(shown.omitted);
    const unresolved = capped(result.imports.unresolved, RELATED_SECTION_LIMIT);
    for (const item of unresolved.shown) {
      lines.push(`- ${item.path} ${item.specifier} [unresolved: ${item.reason}]`);
    }
    note(unresolved.omitted);
    if (result.imports.incomplete) lines.push("- import edges are incomplete for this revision");
  }
  if (result.importers.items.length === 0) {
    lines.push(result.importers.incomplete ? "Imported by: incomplete" : "Imported by: none");
  } else {
    lines.push("Imported by:");
    const shown = capped(result.importers.items, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) lines.push(`- ${item.path} via ${item.specifier}`);
    note(shown.omitted);
    if (result.importers.incomplete) lines.push("- reverse imports may be incomplete");
  }
  if (result.connections.items.length === 0) {
    lines.push(result.connections.incomplete ? "Connections: incomplete" : "Connections: none");
  } else {
    lines.push("Connections:");
    const shown = capped(result.connections.items, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) {
      const ends = capped(item.otherEnds, RELATED_SECTION_LIMIT);
      const rendered = ends.shown.map((end) => `${end.path}${end.callee ? ` ${end.callee}` : ""}`).join(", ");
      const text = item.otherEnds.length === 0
        ? "no other end in the catalog"
        : ends.omitted > 0 ? `${rendered}, … ${ends.omitted} more` : rendered;
      lines.push(`- ${item.path} ${item.callee}("${item.literal}") — ${text}`);
    }
    note(shown.omitted);
    if (result.connections.incomplete) lines.push("- connection edges are incomplete for this revision");
  }
  const pinMark = (item: { pinned: boolean; staleTarget?: boolean }): string => (
    `${item.pinned ? "" : " [unpinned]"}${item.staleTarget ? " [stale-target]" : ""}`
  );
  if (result.references.items.length === 0) {
    lines.push(
      result.references.status === "unsupported"
        ? "References: unsupported (the language provider does not answer references/call-hierarchy for this file type)"
        : result.references.status === "unavailable"
          ? "References: unavailable (no language service or collector is wired — lsp.references resolves a position on demand)"
          : result.references.status === "failed"
            ? "References: failed (the language service could not resolve this anchor)"
            : result.references.status === "partial"
              ? "References: partial (some definitions could not be resolved)"
              : "References: none resolved yet — lsp.references at a position resolves them on demand",
    );
  } else {
    lines.push(`References (resolved, ${result.references.status}):`);
    const shown = capped(result.references.items, RELATED_SECTION_LIMIT);
    for (const item of shown.shown) {
      const target = item.targetPath ? ` → ${item.targetPath}${item.targetName ? ` ${item.targetName}` : ""}` : "";
      lines.push(`- ${item.path}:${item.line} references ${item.targetName ?? item.caller ?? result.anchor.value}${item.caller ? ` — in ${item.caller}` : ""}${target}${pinMark(item)}`);
    }
    note(shown.omitted);
    if (result.references.incomplete) lines.push("- the resolved reference set may be incomplete for this anchor");
  }
  if (result.calls.callers.length === 0 && result.calls.callees.length === 0) {
    lines.push(
      result.calls.status === "unsupported"
        ? "Calls: unsupported (the language provider does not answer call-hierarchy for this file type)"
        : result.calls.status === "unavailable"
          ? "Calls: unavailable (no language service or collector is wired)"
          : result.calls.status === "failed"
            ? "Calls: failed (the language service could not resolve this anchor)"
            : result.calls.status === "partial"
              ? "Calls: partial (some definitions could not be resolved)"
              : "Calls: none resolved yet",
    );
  } else {
    if (result.calls.callers.length > 0) {
      lines.push(`Callers of ${result.anchor.value} (resolved, ${result.calls.status}):`);
      const shown = capped(result.calls.callers, RELATED_SECTION_LIMIT);
      for (const item of shown.shown) {
        lines.push(`- ${item.caller ?? "?"} — ${item.path}:${item.line} calls ${item.callee}${pinMark(item)}`);
      }
      note(shown.omitted);
    }
    if (result.calls.callees.length > 0) {
      lines.push(`Calls made by ${result.anchor.value} (resolved, ${result.calls.status}):`);
      const shown = capped(result.calls.callees, RELATED_SECTION_LIMIT);
      for (const item of shown.shown) {
        lines.push(`- ${item.path}:${item.line} calls ${item.callee}${item.targetPath ? ` (→ ${item.targetPath})` : ""}${pinMark(item)}`);
      }
      note(shown.omitted);
    }
    if (result.calls.incomplete) lines.push("- the resolved call set may be incomplete for this anchor");
  }
  return lines.join("\n");
}
