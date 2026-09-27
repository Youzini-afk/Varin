import pathModule from "node:path";
import type {
  AgentInputContext,
  ExploreFileRelation,
  ExploreRelationStatus,
  HarnessActorContext,
  HarnessServiceMap,
} from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import {
  DEFAULT_BYTE_BUDGET,
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_HITS_PER_FILE,
  DEFAULT_SEMANTIC_RECALL,
  explore,
  formatExploreOutput,
  type ExploreIssue,
} from "./explore.js";
import { pathInRoots, type ExploreGraphRecall } from "./explore-graph.js";
import { looksLikePathObject } from "./explore-query.js";

type ExploreParams = HarnessServiceMap["explore.search"]["params"];

/** Workspace-scope intersection shared by explore and related retrieval. */
/**
 * HR4: the session's cwd is the default retrieval anchor, expressed relative
 * to its authority root (`.` for the root itself). Returns `undefined` when
 * the cwd lies outside the authority root so callers widen to the admitted
 * scope rather than silently dropping the default.
 */
export const sessionDefaultRoot = (actor: { cwd?: string | null; authorityRoot?: string | null }): string | undefined => {
  if (!actor.cwd || !actor.authorityRoot) return undefined;
  const rel = pathModule.relative(actor.authorityRoot, actor.cwd).replaceAll("\\", "/");
  if (rel === "" || rel === ".") return ".";
  if (rel === ".." || rel.startsWith("../")) return undefined;
  return rel;
};

export function intersectRetrievalScope(
  requested: readonly string[] | undefined,
  workspaceScope: readonly string[] | undefined,
): { roots?: string[]; empty: boolean } {
  const normalize = (value: string): string => {
    const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/u, "");
    return normalized === "." ? "" : normalized;
  };
  const allowedRoots = workspaceScope === undefined ? [""] : workspaceScope.map(normalize);
  const requestedRoots = requested === undefined ? [""] : requested.map(normalize);
  const rootsByKey = new Map<string, string>();
  const add = (value: string): void => {
    const key = process.platform === "win32" ? value.toLowerCase() : value;
    rootsByKey.set(key, value);
  };
  for (const requestedRoot of requestedRoots) {
    for (const allowedRoot of allowedRoots) {
      if (pathInRoots(requestedRoot, [allowedRoot])) add(requestedRoot);
      else if (pathInRoots(allowedRoot, [requestedRoot])) add(allowedRoot);
    }
  }
  const roots = [...rootsByKey.values()];
  if (roots.length === 0) return { roots: [], empty: true };
  // Preserve the unrestricted representation expected by graph/vector callers;
  // an empty list means "all workspace" in those APIs.
  if (roots.includes("")) return { empty: false };
  return { roots, empty: false };
}

/**
 * Resolve the fixed query roots and replace path-shaped anchors with the
 * workspace-relative resource IDs returned by Router authorization. Path
 * anchors add their requested location to the candidate roots while staying
 * hints; symbol anchors retain their original value and lookup behavior.
 */
export function resolveExploreScopeAndAnchors(
  params: ExploreParams,
  ctx: Pick<HarnessServiceContext, "actor" | "authorizedPaths">,
): Pick<ExploreParams, "paths" | "anchors"> {
  const explicitPathCount = params.paths?.length ?? 0;
  const pathAnchorCount = (params.anchors ?? []).filter((anchor) => looksLikePathObject(anchor.trim())).length;
  const expectedAuthorizedCount = explicitPathCount + pathAnchorCount;
  if (ctx.authorizedPaths.length !== expectedAuthorizedCount) {
    throw new HarnessServiceError("forbidden", "Search paths and path anchors were not authorized.");
  }
  // HR2: authorized entries carry the resource root they resolved against.
  // Explore's structure/symbol graph is bound to the actor workspace's language
  // service — a foreign root's resourceId must never be re-read as a
  // workspace-relative path. Cross-directory content search goes through
  // `search.content`, which handles multi-root scopes directly.
  if (ctx.authorizedPaths.some((authorized) => authorized.workspaceId !== ctx.actor.workspaceId)) {
    throw new HarnessServiceError(
      "unavailable",
      "Explore structure and relationships are bound to the actor workspace. Use content search for external resources.",
    );
  }

  const explicitPaths = ctx.authorizedPaths
    .slice(0, explicitPathCount)
    .map(({ resourceId }) => resourceId || ".");
  const authorizedAnchorPaths = ctx.authorizedPaths.slice(explicitPathCount);
  let anchorIndex = 0;
  const anchors = params.anchors?.map((anchor) => {
    if (!looksLikePathObject(anchor.trim())) return anchor;
    const authorized = authorizedAnchorPaths[anchorIndex++];
    if (!authorized) throw new HarnessServiceError("forbidden", "A search path anchor was not authorized.");
    return authorized.resourceId || ".";
  });

  const defaultPaths = explicitPathCount > 0
    ? explicitPaths
    : [sessionDefaultRoot(ctx.actor)].filter((root): root is string => root !== undefined);
  const requestedRoots = [
    ...(defaultPaths ?? []),
    ...authorizedAnchorPaths.map(({ resourceId }) => resourceId || "."),
  ];
  const scope = intersectRetrievalScope(requestedRoots.length > 0 ? requestedRoots : undefined, ctx.actor.workspaceScope);
  if (scope.empty) {
    throw new HarnessServiceError("forbidden", "Explore scope does not overlap the actor's authorized workspace scope.");
  }
  return {
    ...(anchors !== undefined ? { anchors } : {}),
    ...(scope.roots !== undefined ? { paths: scope.roots } : {}),
  };
}

const ownedDirtyPathsFor = (
  inputContext: AgentInputContext,
  actor: HarnessActorContext,
  params: ExploreParams,
  authorizedPaths: ReadonlyArray<{ resourceId: string }>,
  draftPaths?: (sessionId: string, context: AgentInputContext) => readonly string[],
): string[] => {
  if (inputContext.source !== "surface") return [];
  const owned = draftPaths ? draftPaths(actor.sessionId, inputContext) : inputContext.dirtyPaths;
  return owned.filter((dirtyPath) => (
    params.paths === undefined
    || authorizedPaths.some((authorized) => pathInRoots(dirtyPath, [authorized.resourceId]))
  ));
};

/**
 * Graph relations decorate a result that already succeeded, so a broken or
 * unopened knowledge store degrades the annotation and never fails the search
 * (plan 0.4). A revision that differs from the excerpt is reported as `stale`
 * rather than printed as current (agent-harness 7.2, D-112).
 */
export async function loadSnippetRelations(
  host: Pick<HarnessServiceHost, "fileRelations">,
  workspaceId: string,
  snippets: ReadonlyArray<{ path: string; revision: string }>,
  signal: AbortSignal,
): Promise<{ status: ExploreRelationStatus; files: ExploreFileRelation[] } | undefined> {
  if (!host.fileRelations || snippets.length === 0) return undefined;
  const excerptRevisions = new Map<string, string>();
  for (const snippet of snippets) {
    if (!excerptRevisions.has(snippet.path)) excerptRevisions.set(snippet.path, snippet.revision);
  }
  const files: ExploreFileRelation[] = [];
  let asked = 0;
  let answered = 0;
  for (const [path, excerptRevision] of excerptRevisions) {
    signal.throwIfAborted();
    asked += 1;
    let relation: Awaited<ReturnType<NonNullable<HarnessServiceHost["fileRelations"]>>>;
    try {
      relation = await host.fileRelations(workspaceId, path);
    } catch {
      continue;
    }
    answered += 1;
    if (!relation) continue;
    if (
      relation.imports.length === 0
      && relation.connections.length === 0
      && relation.associations.length === 0
      && (relation.references?.length ?? 0) === 0
      && (relation.calls?.length ?? 0) === 0
    ) continue;
    files.push({ ...relation, stale: relation.documentRevision !== excerptRevision });
  }
  const status: ExploreRelationStatus = answered === asked ? "ready" : answered === 0 ? "unavailable" : "partial";
  if (files.length === 0 && status === "ready") return undefined;
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { status, files };
}

export function createExploreSearchService(
  host: Pick<HarnessServiceHost, "searchService" | "outputStore" | "readExploreFile" | "agentInputDraftPaths" | "structureSource" | "fileRelations" | "graphRecall" | "semanticRecall">,
  /**
   * Window traces are an observation meter, not a product field: one entry per
   * generated window with its hit text, measured at 482 windows / 185 KB for a
   * content-word question, against a 24 KiB visible budget. Off unless a meter
   * asks for them (D-157).
   */
  options?: { traceWindows?: boolean },
): HarnessService<"explore.search"> {
  return {
    handle: async (params, ctx) => {
      if (typeof params.question !== "string" || !params.question.trim()) {
        throw new HarnessServiceError("invalid-params", "Provide a non-empty search question.");
      }
      if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || params.limit < 1)) {
        throw new HarnessServiceError("invalid-params", "The excerpt limit must be a positive integer.");
      }
      if (params.paths !== undefined && (!Array.isArray(params.paths) || params.paths.some((path) => typeof path !== "string" || !path.trim()))) {
        throw new HarnessServiceError("invalid-params", "Search paths must be non-empty strings.");
      }
      if (params.anchors !== undefined && (!Array.isArray(params.anchors) || params.anchors.some((anchor) => typeof anchor !== "string"))) {
        throw new HarnessServiceError("invalid-params", "Anchors must be an array of strings.");
      }
      const workspaceId = ctx.actor.workspaceId;
      const readFile = host.readExploreFile;
      if (!workspaceId || !readFile) throw new HarnessServiceError("unavailable", "Workspace document reading is unavailable.");
      ctx.signal.throwIfAborted();
      const inputContext = ctx.inputContext ?? { source: "disk" as const };
      const resolvedRequest = resolveExploreScopeAndAnchors(params, ctx);
      const effectiveParams: ExploreParams = { ...params, ...resolvedRequest };
      const graph = host.graphRecall
        ? await host.graphRecall(ctx.sessionId, workspaceId).catch(() => null)
        : null;
      let searchPartial = false;
      const result = await explore(effectiveParams, {
        rgSearch: async (pattern, options) => {
          const roots: Array<string | undefined> = options.paths?.length ? [...new Set(options.paths)] : [undefined];
          const batches = await Promise.all(roots.map(async (path) => {
            ctx.signal.throwIfAborted();
            const search = await host.searchService.search({
              pattern,
              fixedStrings: options.fixedStrings,
              ...(path !== undefined ? { path } : {}),
            }, {
              workspaceId,
              actor: ctx.actor,
              inputContext,
              candidateBudget: options.candidateBudget ?? DEFAULT_CANDIDATE_BUDGET,
              hitsPerFile: options.hitsPerFile ?? DEFAULT_HITS_PER_FILE,
              ...(ctx.actor.workspaceScope !== undefined ? { workspaceScope: ctx.actor.workspaceScope } : {}),
              signal: ctx.signal,
            });
            ctx.signal.throwIfAborted();
            if (search.status === "unavailable") {
                  const dirtyIssues = await collectDirtySourceIssues(effectiveParams, ctx, inputContext, host, readFile);
              if (dirtyIssues.length > 0) {
                throw new HarnessServiceError(
                  "unavailable",
                  `No current excerpts could be read: ${dirtyIssues.map((issue) => `${issue.path} (${issue.status})`).join(", ")}. Search again.`,
                );
              }
              throw new HarnessServiceError("unavailable", "Search service is unavailable. Retry or inspect workspace availability.");
            }
            const callPartial = search.partial || (search.filesDropped ?? 0) > 0;
            return {
              hits: search.files.flatMap((file) => file.hits.map((hit) => ({ path: file.path, line: hit.line, text: hit.text }))),
              partial: callPartial,
              filesDropped: search.filesDropped ?? 0,
              fileCoverage: search.fileCoverage
                ?? ((search.filesDropped ?? 0) > 0 ? "lower-bound" as const : callPartial ? "unknown" as const : "complete" as const),
            };
          }));
          const callPartial = batches.some((batch) => batch.partial);
          // Search roots may overlap (`src` and `src/lib`), so summing would double-count files.
          const callFilesDropped = batches.reduce((most, batch) => Math.max(most, batch.filesDropped), 0);
          const callCoverage = batches.some((batch) => batch.fileCoverage === "lower-bound")
            ? "lower-bound" as const
            : batches.some((batch) => batch.fileCoverage === "unknown")
              ? "unknown" as const
              : "complete" as const;
          searchPartial ||= callPartial;
          return {
            hits: batches.flatMap((batch) => batch.hits),
            partial: callPartial,
            filesDropped: callFilesDropped,
            fileCoverage: callCoverage,
          };
        },
        readFile: (path) => readFile(ctx.actor, path, ctx.signal, inputContext),
        ...(host.structureSource ? {
          structure: {
            outline: (request) => host.structureSource!.outline({
              ...request,
              workspaceId,
              sessionId: ctx.sessionId,
              inputContext,
            }),
            classifyHits: (request) => host.structureSource!.classifyHits({
              ...request,
              workspaceId,
              sessionId: ctx.sessionId,
              inputContext,
            }),
            literalCalls: (request) => host.structureSource!.literalCalls({
              ...request,
              workspaceId,
              sessionId: ctx.sessionId,
              inputContext,
            }),
          },
        } : {}),
        ...(graph ? { graph: bindExploreGraphRecall(graph.store, effectiveParams.paths) } : {}),
        ...(host.semanticRecall ? {
          semantic: {
            search: (question: string, limit?: number, signal?: AbortSignal) => (
              host.semanticRecall!(workspaceId, question, limit ?? DEFAULT_SEMANTIC_RECALL, {
                signal: signal ?? ctx.signal,
                sessionId: ctx.sessionId,
                inputContext,
                ...(effectiveParams.paths ? { roots: effectiveParams.paths } : {}),
              })
            ),
          },
        } : {}),
      }, ctx.signal);
      if (result.snippets.length === 0 && result.issues.length > 0) {
        throw new HarnessServiceError("unavailable", `No current excerpts could be read: ${result.issues.map((issue) => `${issue.path} (${issue.status})`).join(", ")}. Search again.`);
      }
      const incomplete = searchPartial || result.searched.incomplete;
      const relations = await loadSnippetRelations(host, workspaceId, result.snippets, ctx.signal);
      const formatted = {
        snippets: result.snippets,
        issues: result.issues,
        notRequested: result.notRequested,
        omitted: result.omitted,
        partial: searchPartial || result.partial,
        searchIncomplete: searchPartial || result.searchIncomplete,
        searched: {
          patterns: result.searched.patterns,
          files: result.searched.files,
          ms: result.searched.ms,
          incomplete,
          ...(result.searched.filesDropped !== undefined ? { filesDropped: result.searched.filesDropped } : {}),
        },
        ...(relations ? { relations } : {}),
        ...(result.details.graph ? { graph: result.details.graph } : {}),
        ...(result.details.skippedQueries ? { skippedQueries: result.details.skippedQueries } : {}),
        ...(result.details.sources ? { sources: result.details.sources } : {}),
      };
      const preview = formatExploreOutput(formatted, { byteBudget: DEFAULT_BYTE_BUDGET });
      const stored = host.outputStore.store(ctx.sessionId, preview.storedBody, "explore");
      const packed = formatExploreOutput(formatted, { byteBudget: DEFAULT_BYTE_BUDGET, handle: stored.ref.handle });
      return {
        text: packed.visibleText,
        snippets: result.snippets,
        issues: result.issues,
        notRequested: result.notRequested,
        omitted: packed.omitted,
        partial: searchPartial || result.partial,
        searched: formatted.searched,
        handle: stored.ref.handle,
        details: {
          provenance: result.details.provenance,
          anchors: result.details.anchors,
          byteBudget: DEFAULT_BYTE_BUDGET,
          ...(result.details.structure ? { structure: result.details.structure } : {}),
          ...(relations ? { relations } : {}),
          ...(result.details.graph ? { graph: result.details.graph } : {}),
          ...(result.details.query ? { query: result.details.query } : {}),
          ...(result.details.skippedQueries ? { skippedQueries: result.details.skippedQueries } : {}),
          ...(result.details.distinctiveness ? { distinctiveness: result.details.distinctiveness } : {}),
          ...(options?.traceWindows && result.details.windows ? { windows: result.details.windows } : {}),
          ...(result.details.semantic ? { semantic: result.details.semantic } : {}),
          ...(result.details.sources ? { sources: result.details.sources } : {}),
        },
      };
    },
  };
}

function bindExploreGraphRecall(
  store: import("../knowledge/store.js").KnowledgeStore,
  roots?: readonly string[],
): ExploreGraphRecall {
  const toSite = (record: import("../knowledge/store.js").SymbolGraphRelationRecord) => ({
    path: record.path,
    line: record.line,
    ...(record.caller !== undefined ? { caller: record.caller } : {}),
    ...(record.targetPath !== undefined && pathInRoots(record.targetPath, roots) ? { targetPath: record.targetPath } : {}),
    ...(record.targetName !== undefined ? { targetName: record.targetName } : {}),
    pinned: record.pinned,
    ...(record.staleTarget ? { staleTarget: true } : {}),
    resolvedBy: record.resolvedBy,
  });
  return {
    catalogStats: async () => store.catalogStats(),
    searchDefinitions: (query, k) => store.searchSymbols(query, k, roots),
    findLinks: (value) => store.findLinks(value),
    fileRelations: async (path) => {
      const relations = await store.getFileRelations(path);
      if (!relations) return null;
      return {
        connections: relations.connections.map(({ callee, literal }) => ({ callee, literal })),
        linksIncomplete: relations.linksIncomplete,
        references: relations.references.map((record) => ({
          path: record.path,
          line: record.line,
          ...(record.caller !== undefined ? { caller: record.caller } : {}),
          ...(record.targetPath !== undefined && pathInRoots(record.targetPath, roots) ? { targetPath: record.targetPath } : {}),
          ...(record.targetName !== undefined ? { targetName: record.targetName } : {}),
          pinned: record.pinned,
          ...(record.staleTarget ? { staleTarget: true } : {}),
          resolvedBy: record.resolvedBy,
        })),
        calls: relations.calls.map((record) => ({
          path: record.path,
          line: record.line,
          ...(record.caller !== undefined ? { caller: record.caller } : {}),
          callee: record.targetName ?? record.value,
          ...(record.targetPath !== undefined && pathInRoots(record.targetPath, roots) ? { targetPath: record.targetPath } : {}),
          ...(record.targetName !== undefined ? { targetName: record.targetName } : {}),
          pinned: record.pinned,
          ...(record.staleTarget ? { staleTarget: true } : {}),
          resolvedBy: record.resolvedBy,
        })),
      };
    },
    findImporters: (path) => store.findImporters(path),
    findReferences: async (name) => (await store.findReferences(name, roots)).map(toSite),
    findCallers: async (name) => (await store.findCallers(name, roots)).map(toSite),
    findCalls: async (caller) => (await store.findCalls(caller, roots)).map(toSite),
  };
}

async function collectDirtySourceIssues(
  params: ExploreParams,
  ctx: { actor: HarnessActorContext; sessionId: string; signal: AbortSignal; authorizedPaths: ReadonlyArray<{ resourceId: string }> },
  inputContext: AgentInputContext,
  host: Pick<HarnessServiceHost, "agentInputDraftPaths">,
  readFile: NonNullable<HarnessServiceHost["readExploreFile"]>,
): Promise<ExploreIssue[]> {
  const dirtyPaths = ownedDirtyPathsFor(inputContext, ctx.actor, params, ctx.authorizedPaths, host.agentInputDraftPaths);
  const issues: ExploreIssue[] = [];
  for (const path of dirtyPaths) {
    ctx.signal.throwIfAborted();
    const snapshot = await readFile(ctx.actor, path, ctx.signal, inputContext);
    if (snapshot.status !== "ready" && snapshot.status !== "forbidden") {
      issues.push({ path, status: snapshot.status, message: snapshot.message });
    }
  }
  return issues;
}
