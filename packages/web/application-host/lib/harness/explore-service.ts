import pathModule from "node:path";
import type {
  ExploreFileRelation,
  ExploreRelationStatus,
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
  type ExploreSemanticHit,
  type ExploreSemanticSearch,
} from "./explore.js";
import {
  pathInRoots,
  type ExploreGraphDefinition,
  type ExploreGraphLink,
  type ExploreGraphRecall,
  type ExploreGraphRelationSite,
} from "./explore-graph.js";
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
  const logicalPath = (authorized: HarnessServiceContext["authorizedPaths"][number]): string => (
    authorized.workspaceId !== ctx.actor.workspaceId
      ? (authorized.resolvedPath ?? authorized.resourceId) || "."
      : authorized.resourceId || "."
  );
  const explicitPaths = ctx.authorizedPaths
    .slice(0, explicitPathCount)
    .map(logicalPath);
  const authorizedAnchorPaths = ctx.authorizedPaths.slice(explicitPathCount);
  let anchorIndex = 0;
  const anchors = params.anchors?.map((anchor) => {
    if (!looksLikePathObject(anchor.trim())) return anchor;
    const authorized = authorizedAnchorPaths[anchorIndex++];
    if (!authorized) throw new HarnessServiceError("forbidden", "A search path anchor was not authorized.");
    return logicalPath(authorized);
  });

  const defaultPaths = explicitPathCount > 0
    ? explicitPaths.filter((_path, index) => ctx.authorizedPaths[index]?.workspaceId === ctx.actor.workspaceId)
    : [sessionDefaultRoot(ctx.actor)].filter((root): root is string => root !== undefined);
  const localAnchorPaths = (explicitPathCount > 0 ? [] : authorizedAnchorPaths)
    .filter((authorized) => authorized.workspaceId === ctx.actor.workspaceId)
    .map(logicalPath);
  const externalRoots = (explicitPathCount > 0 ? ctx.authorizedPaths.slice(0, explicitPathCount) : ctx.authorizedPaths)
    .filter((authorized) => authorized.workspaceId !== ctx.actor.workspaceId)
    .map(logicalPath);
  const localRequested = [...defaultPaths, ...localAnchorPaths];
  const localScope = intersectRetrievalScope(localRequested.length > 0 ? localRequested : undefined, ctx.actor.workspaceScope);
  if (localScope.empty && externalRoots.length === 0) {
    throw new HarnessServiceError("forbidden", "Explore scope does not overlap the actor's authorized workspace scope.");
  }
  const roots = [...(localScope.roots ?? []), ...externalRoots];
  return {
    ...(anchors !== undefined ? { anchors } : {}),
    ...(roots.length > 0 ? { paths: [...new Set(roots)] } : localScope.roots !== undefined ? { paths: localScope.roots } : {}),
  };
}

export interface ExploreResourceUnit {
  workspaceId: string;
  root: string;
  external: boolean;
  resourcePrefix: string;
  logicalPrefix: string;
  authorized?: { workspaceId: string; resourceId: string };
}

const normalizedPath = (value: string): string => value.replaceAll("\\", "/").replace(/\/+$/u, "") || ".";
const pathWithin = (value: string, root: string): boolean => {
  const candidate = normalizedPath(value);
  const prefix = normalizedPath(root);
  const left = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const right = process.platform === "win32" ? prefix.toLowerCase() : prefix;
  return right === "." || left === right || left.startsWith(`${right}/`);
};

/**
 * Bind each router-authorized path to its actual resource root. Local workspace
 * scope remains relative to the actor; external roots keep absolute logical
 * paths so same-named files in different roots cannot collapse together.
 */
export async function resolveExploreResourceUnits(
  searchService: Pick<HarnessServiceHost["searchService"], "resolveWorkspaceRoot" | "resolveScopeRoot">,
  ctx: Pick<HarnessServiceContext, "actor" | "workspaceId" | "authorizedPaths">,
  params: ExploreParams,
  paths: readonly string[] | undefined,
): Promise<ExploreResourceUnit[]> {
  const units: ExploreResourceUnit[] = [];
  const explicitPaths = (params.paths?.length ?? 0) > 0;
  const add = async (input: {
    workspaceId: string;
    resourcePrefix: string;
    logicalPrefix?: string;
    authorized?: { workspaceId: string; resourceId: string };
    root?: string;
  }): Promise<void> => {
    let root = input.root;
    if (!root && typeof searchService.resolveWorkspaceRoot === "function") {
      root = await searchService.resolveWorkspaceRoot(input.workspaceId).catch(() => null) ?? undefined;
    }
    // Lightweight harness fixtures may omit root resolution. Keep local-only
    // unit tests usable; external roots still require the real authority map.
    if (!root && input.workspaceId === ctx.actor.workspaceId) {
      root = ctx.actor.authorityRoot ?? ctx.actor.cwd ?? ".";
    }
    if (!root) return;
    const external = input.workspaceId !== ctx.actor.workspaceId;
    const resourcePrefix = normalizedPath(input.resourcePrefix);
    const logicalPrefix = input.logicalPrefix ?? (external
      ? pathModule.resolve(root, resourcePrefix === "." ? "" : resourcePrefix)
      : resourcePrefix);
    const candidates = paths?.length ? paths : [logicalPrefix || "."];
    const scopes = new Set<string>();
    for (const candidate of candidates) {
      let resourcePath: string;
      if (pathModule.isAbsolute(candidate)) {
        if (!external) continue;
        const relative = pathModule.relative(root, candidate).replaceAll("\\", "/");
        if (pathModule.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) continue;
        resourcePath = relative || ".";
      } else {
        if (external) continue;
        resourcePath = normalizedPath(candidate);
      }
      if (pathWithin(resourcePath, resourcePrefix)) scopes.add(resourcePath);
      else if (pathWithin(resourcePrefix, resourcePath)) scopes.add(resourcePrefix);
    }
    for (const resourcePath of scopes) {
      const logicalPath = external
        ? pathModule.resolve(root, resourcePath === "." ? "" : resourcePath)
        : resourcePath;
      units.push({
        workspaceId: input.workspaceId,
        root,
        external,
        resourcePrefix: resourcePath,
        logicalPrefix: logicalPath,
        ...(input.authorized ? { authorized: input.authorized } : {}),
      });
    }
  };

  for (const authorized of ctx.authorizedPaths) {
    await add({
      workspaceId: authorized.workspaceId,
      resourcePrefix: authorized.resourceId || ".",
      ...(authorized.resolvedPath ? { logicalPrefix: authorized.resolvedPath } : {}),
      authorized: { workspaceId: authorized.workspaceId, resourceId: authorized.resourceId },
    });
  }

  if (!explicitPaths && ctx.actor.workspaceId) {
    const defaultRoot = sessionDefaultRoot(ctx.actor) ?? ".";
    const allowed = intersectRetrievalScope([defaultRoot], ctx.actor.workspaceScope);
    for (const root of allowed.roots ?? [defaultRoot]) {
      await add({ workspaceId: ctx.actor.workspaceId, resourcePrefix: root || "." });
    }
  } else if (!explicitPaths && !ctx.actor.workspaceId && (ctx.actor.cwd || ctx.actor.authorityRoot) && searchService.resolveScopeRoot) {
    const scope = await searchService.resolveScopeRoot((ctx.actor.cwd || ctx.actor.authorityRoot)!).catch(() => null);
    if (scope) await add({ workspaceId: scope.workspaceId, resourcePrefix: ".", logicalPrefix: scope.root, root: scope.root });
  }

  const seen = new Set<string>();
  return units.filter((unit) => {
    const key = `${unit.workspaceId}\0${unit.resourcePrefix}\0${unit.logicalPrefix}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function exploreResourceAtPath(
  value: string,
  units: readonly ExploreResourceUnit[],
): { unit: ExploreResourceUnit; resourceId: string } | null {
  const absolute = pathModule.isAbsolute(value);
  const matches = units.flatMap((unit) => {
    if (absolute !== unit.external) return [];
    let resourceId: string;
    if (absolute) {
      const relative = pathModule.relative(unit.root, value).replaceAll("\\", "/");
      if (pathModule.isAbsolute(relative) || relative === ".." || relative.startsWith("../")) return [];
      resourceId = relative || ".";
    } else {
      resourceId = normalizedPath(value);
    }
    if (!pathWithin(resourceId, unit.resourcePrefix)) return [];
    return [{ unit, resourceId }];
  });
  matches.sort((left, right) => right.unit.resourcePrefix.length - left.unit.resourcePrefix.length);
  const match = matches[0];
  return match ?? null;
}

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
      const readFile = host.readExploreFile;
      if (!readFile) throw new HarnessServiceError("unavailable", "Workspace document reading is unavailable.");
      ctx.signal.throwIfAborted();
      const inputContext = ctx.inputContext ?? { source: "disk" as const };
      const resolvedRequest = resolveExploreScopeAndAnchors(params, ctx);
      const effectiveParams: ExploreParams = { ...params, ...resolvedRequest };
      const resourceUnits = await resolveExploreResourceUnits(host.searchService, ctx, params, effectiveParams.paths);
      if (resourceUnits.length === 0) throw new HarnessServiceError("unavailable", "No usable resource root was available for this query.");
      const graphSources = await loadExploreGraphRecall(host, ctx, resourceUnits);
      const graph = graphSources.graph ?? (host.graphRecall ? unavailableExploreGraphRecall() : undefined);
      let searchPartial = false;
      let searchUnavailable = false;
      const result = await explore(effectiveParams, {
        rgSearch: async (pattern, options) => {
          const queryPaths = options.paths?.length ? [...new Set(options.paths)] : resourceUnits.map((unit) => unit.logicalPrefix);
          const targets = new Map<string, { unit: ExploreResourceUnit; resourceId: string }>();
          for (const queryPath of queryPaths) {
            for (const unit of resourceUnits) {
              const scopePath = unit.logicalPrefix;
              const selectedPath = pathWithin(queryPath, scopePath) ? queryPath : pathWithin(scopePath, queryPath) ? scopePath : null;
              if (!selectedPath) continue;
              const target = exploreResourceAtPath(selectedPath, [unit]);
              if (!target) continue;
              targets.set(`${target.unit.workspaceId}\0${target.resourceId}`, target);
            }
          }
          const batches = await Promise.all([...targets.values()].map(async ({ unit, resourceId }) => {
            ctx.signal.throwIfAborted();
            const search = await host.searchService.search({
              pattern,
              fixedStrings: options.fixedStrings,
              path: resourceId,
            }, {
              workspaceId: ctx.workspaceId,
              actor: ctx.actor,
              ...(unit.authorized ? { authorizedPaths: [{ workspaceId: unit.workspaceId, resourceId }] } : {}),
              inputContext,
              candidateBudget: options.candidateBudget ?? DEFAULT_CANDIDATE_BUDGET,
              hitsPerFile: options.hitsPerFile ?? DEFAULT_HITS_PER_FILE,
              ...(ctx.actor.workspaceScope !== undefined ? { workspaceScope: ctx.actor.workspaceScope } : {}),
              signal: ctx.signal,
            });
            ctx.signal.throwIfAborted();
            if (search.status === "unavailable") {
              searchPartial = true;
              searchUnavailable = true;
              return { hits: [], partial: true, filesDropped: 0, fileCoverage: "unknown" as const };
            }
            const callPartial = search.partial || (search.filesDropped ?? 0) > 0;
            return {
              hits: search.files.flatMap((file) => file.hits.map((hit) => ({ path: file.path, line: hit.line, text: hit.text, ...(hit.revision ? { revision: hit.revision } : {}) }))),
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
        readFile: (file) => {
          const target = exploreResourceAtPath(file, resourceUnits);
          if (!target) throw new Error("Explore file is outside the resolved resource scope.");
          return readFile(ctx.actor, pathModule.resolve(target.unit.root, target.resourceId), ctx.signal, inputContext);
        },
        ...(host.structureSource ? {
          structure: {
            outline: (request) => {
              const target = exploreResourceAtPath(request.path, resourceUnits);
              if (!target) throw new Error("Structure path is outside the resolved resource scope.");
              return host.structureSource!.outline({ ...request, path: target.resourceId, workspaceId: target.unit.workspaceId, sessionId: ctx.sessionId, inputContext });
            },
            classifyHits: (request) => {
              const target = exploreResourceAtPath(request.path, resourceUnits);
              if (!target) throw new Error("Structure path is outside the resolved resource scope.");
              return host.structureSource!.classifyHits({ ...request, path: target.resourceId, workspaceId: target.unit.workspaceId, sessionId: ctx.sessionId, inputContext });
            },
            literalCalls: (request: Parameters<typeof host.structureSource.literalCalls>[0]) => {
              const target = exploreResourceAtPath(request.path, resourceUnits);
              if (!target) throw new Error("Structure path is outside the resolved resource scope.");
              return host.structureSource!.literalCalls({ ...request, path: target.resourceId, workspaceId: target.unit.workspaceId, sessionId: ctx.sessionId, inputContext });
            },
          },
        } : {}),
        ...(graph ? { graph } : {}),
        ...(host.semanticRecall ? {
          semantic: {
            search: (question: string, limit?: number, signal?: AbortSignal) => semanticSearchAcrossRoots(
              host.semanticRecall!, resourceUnits, question, limit ?? DEFAULT_SEMANTIC_RECALL, {
                signal: signal ?? ctx.signal, sessionId: ctx.sessionId, inputContext,
              },
            ),
          },
        } : {}),
      }, ctx.signal);
      if (graphSources.missing > 0) {
        if (result.details.graph) result.details.graph.partial = true;
        result.partial = true;
      }
      if (result.snippets.length === 0 && (result.issues.length > 0 || searchUnavailable)) {
        const dirtySourceIssues = inputContext.source === "surface" && inputContext.snapshot.status === "unavailable"
          ? [...new Set(resourceUnits.flatMap((unit) => inputContext.roots
            .filter((root) => root.workspaceId === unit.workspaceId)
            .flatMap((root) => root.dirtyPaths
              .filter((resourceId) => pathWithin(resourceId, unit.resourcePrefix))
              .map((resourceId) => `${unit.external ? pathModule.resolve(unit.root, resourceId) : resourceId} (unavailable)`))))]
          : [];
        const details = result.issues.length > 0
          ? result.issues.map((issue) => `${issue.path} (${issue.status})`).join(", ")
          : dirtySourceIssues.length > 0 ? dirtySourceIssues.join(", ") : "the requested source was unavailable";
        throw new HarnessServiceError("unavailable", `No current excerpts could be read: ${details}. Search again.`);
      }
      const incomplete = searchPartial || result.searched.incomplete;
      const relations = await loadSnippetRelationsAcrossRoots(host, resourceUnits, result.snippets, ctx.signal);
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
        ...(result.details.semantic ? { semantic: result.details.semantic } : {}),
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

function mapExploreGraphRecall(
  source: ExploreGraphRecall,
  unit: ExploreResourceUnit,
  roots?: readonly string[],
): ExploreGraphRecall {
  const toLogical = (value: string): string => unit.external ? pathModule.resolve(unit.root, value) : value;
  const inScope = (value: string): boolean => pathInRoots(value, roots);
  const mapSite = (site: ExploreGraphRelationSite): ExploreGraphRelationSite => {
    const { targetPath, ...rest } = site;
    return { ...rest, path: toLogical(site.path), ...(targetPath !== undefined && inScope(targetPath) ? { targetPath: toLogical(targetPath) } : {}) };
  };
  return {
    catalogStats: async () => {
      const stats = await source.catalogStats();
      const paths = (stats.paths ?? []).filter(inScope).map(toLogical);
      return { ...stats, paths };
    },
    searchDefinitions: async (query, k) => (await source.searchDefinitions(query, k))
      .filter((item) => inScope(item.path))
      .map((item): ExploreGraphDefinition => ({ ...item, path: toLogical(item.path) })),
    findLinks: async (value) => (await source.findLinks(value))
      .filter((item) => inScope(item.path))
      .map((item): ExploreGraphLink => ({ ...item, path: toLogical(item.path) })),
    fileRelations: async (resourceId) => {
      const result = await source.fileRelations(resourceId);
      if (!result) return null;
      return {
        ...result,
        ...(result.references ? { references: result.references.filter((site) => inScope(site.path)).map(mapSite) } : {}),
        ...(result.calls ? { calls: result.calls.filter((site) => inScope(site.path)).map(mapSite) } : {}),
      };
    },
    findImporters: async (resourceId) => ({
      resolved: (await source.findImporters(resourceId)).resolved
        .filter((item) => inScope(item.path))
        .map((item) => ({ ...item, path: toLogical(item.path) })),
    }),
    ...(source.findReferences ? { findReferences: async (name) => (await source.findReferences!(name))
      .filter((site) => inScope(site.path)).map(mapSite) } : {}),
    ...(source.findCallers ? { findCallers: async (name) => (await source.findCallers!(name))
      .filter((site) => inScope(site.path)).map(mapSite) } : {}),
    ...(source.findCalls ? { findCalls: async (caller) => (await source.findCalls!(caller))
      .filter((site) => inScope(site.path)).map(mapSite) } : {}),
  };
}

function mergeExploreGraphRecalls(sources: readonly ExploreGraphRecall[]): ExploreGraphRecall | undefined {
  if (sources.length === 0) return undefined;
  const merge = async <T>(read: (source: ExploreGraphRecall) => Promise<T[]>, key: (item: T) => string): Promise<T[]> => {
    const groups = await Promise.all(sources.map(read));
    return [...new Map(groups.flat().map((item) => [key(item), item])).values()];
  };
  return {
    catalogStats: async () => {
      const groups = await Promise.all(sources.map((source) => source.catalogStats()));
      const fileCounts = groups.map((stats) => stats.fileCount);
      return {
        symbolCount: groups.reduce((sum, stats) => sum + stats.symbolCount, 0),
        ...(fileCounts.every((count): count is number => count !== undefined)
          ? { fileCount: fileCounts.reduce((sum, count) => sum + count, 0) }
          : {}),
        paths: [...new Set(groups.flatMap((stats) => stats.paths ?? []))],
      };
    },
    searchDefinitions: async (query, k) => (await merge((source) => source.searchDefinitions(query, k), (item) => `${item.path}\0${item.name}\0${item.kind}`))
      .toSorted((left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name)).slice(0, k),
    findLinks: async (value) => merge((source) => source.findLinks(value), (item) => `${item.path}\0${item.kind}\0${item.value}\0${item.callee ?? ""}`),
    fileRelations: async (value) => {
      for (const source of sources) {
        const relations = await source.fileRelations(value);
        if (relations) return relations;
      }
      return null;
    },
    findImporters: async (value) => ({
      resolved: await merge(async (source) => (await source.findImporters(value)).resolved,
        (item) => `${item.path}\0${item.specifier}`),
    }),
    findReferences: async (name) => merge(async (source) => source.findReferences ? source.findReferences(name) : [],
      (item) => `${item.path}\0${item.line}\0${item.targetName ?? item.caller ?? ""}`),
    findCallers: async (name) => merge(async (source) => source.findCallers ? source.findCallers(name) : [],
      (item) => `${item.path}\0${item.line}\0${item.callee ?? ""}`),
    findCalls: async (caller) => merge(async (source) => source.findCalls ? source.findCalls(caller) : [],
      (item) => `${item.path}\0${item.line}\0${item.callee ?? ""}`),
  };
}

export async function loadExploreGraphRecall(
  host: Pick<HarnessServiceHost, "graphRecall">,
  ctx: Pick<HarnessServiceContext, "sessionId">,
  units: readonly ExploreResourceUnit[],
): Promise<{ graph?: ExploreGraphRecall; missing: number }> {
  if (!host.graphRecall) return { missing: 0 };
  const roots = [...new Set(units.map((unit) => unit.workspaceId))];
  const sources: Array<{ workspaceId: string; recall: ExploreGraphRecall; unit: ExploreResourceUnit }> = [];
  let missing = 0;
  for (const workspaceId of roots) {
    const recalled = await host.graphRecall(ctx.sessionId, workspaceId).catch(() => null);
    if (!recalled || recalled.workspaceId !== workspaceId || !recalled.directFactsCompatible) {
      missing += 1;
      continue;
    }
    const rootUnits = units.filter((unit) => unit.workspaceId === workspaceId);
    const prefixes = rootUnits.map((unit) => unit.resourcePrefix === "." ? "" : unit.resourcePrefix);
    const scope = prefixes.includes("") ? undefined : prefixes;
    sources.push({
      workspaceId,
      unit: rootUnits[0]!,
      recall: mapExploreGraphRecall(bindExploreGraphRecall(recalled.store, scope), rootUnits[0]!, scope),
    });
  }
  const merged = mergeExploreGraphRecalls(sources.map((entry) => entry.recall));
  if (!merged) return { missing };
  const graph: ExploreGraphRecall = {
    ...merged,
    fileRelations: async (logicalPath) => {
      const target = exploreResourceAtPath(logicalPath, units);
      const source = target && sources.find((entry) => entry.workspaceId === target.unit.workspaceId);
      return source ? source.recall.fileRelations(target.resourceId) : null;
    },
    findImporters: async (logicalPath) => {
      const target = exploreResourceAtPath(logicalPath, units);
      const source = target && sources.find((entry) => entry.workspaceId === target.unit.workspaceId);
      return source ? source.recall.findImporters(target.resourceId) : { resolved: [] };
    },
  };
  return { graph, missing };
}

function unavailableExploreGraphRecall(): ExploreGraphRecall {
  const unavailable = async (): Promise<never> => {
    throw Object.assign(new Error("The symbol graph is not open for one or more selected resource roots."), { code: "unavailable" });
  };
  return {
    catalogStats: unavailable,
    searchDefinitions: unavailable,
    findLinks: unavailable,
    fileRelations: unavailable,
    findImporters: unavailable,
    findReferences: unavailable,
    findCallers: unavailable,
    findCalls: unavailable,
  };
}

export async function semanticSearchAcrossRoots(
  recall: NonNullable<HarnessServiceHost["semanticRecall"]>,
  units: readonly ExploreResourceUnit[],
  question: string,
  limit: number,
  options: Parameters<NonNullable<HarnessServiceHost["semanticRecall"]>>[3],
): Promise<ExploreSemanticSearch> {
  const grouped = new Map<string, ExploreResourceUnit[]>();
  for (const unit of units) {
    const rootUnits = grouped.get(unit.workspaceId) ?? [];
    rootUnits.push(unit);
    grouped.set(unit.workspaceId, rootUnits);
  }
  const results = await Promise.all([...grouped.entries()].map(async ([workspaceId, rootUnits]) => {
    const roots = [...new Set(rootUnits.map((unit) => unit.resourcePrefix).filter((root) => root !== "."))];
    const { threadQuery, ...sharedOptions } = options ?? {};
    const rootThreadQuery = threadQuery && "workspaceId" in threadQuery && threadQuery.workspaceId === workspaceId
      ? { threadQuery }
      : {};
    let result: Awaited<ReturnType<NonNullable<HarnessServiceHost["semanticRecall"]>>>;
    try {
      result = await recall(workspaceId, question, limit, { ...sharedOptions, ...rootThreadQuery, ...(roots.length > 0 ? { roots } : {}) });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      result = { status: "failed", coverage: "partial", lifecycle: "idle", hits: [], gaps: [] };
    }
    const representative = rootUnits[0]!;
    const inScope = (resourceId: string) => rootUnits.some((unit) => pathWithin(resourceId, unit.resourcePrefix));
    const logical = (resourceId: string) => representative.external
      ? pathModule.resolve(representative.root, resourceId)
      : resourceId;
    return {
      workspaceId,
      result,
      hits: result.hits.filter((hit) => inScope(hit.documentId)).map((hit): ExploreSemanticHit => ({
        ...hit,
        documentId: logical(hit.documentId),
      })),
      gaps: (result.gaps ?? []).map((gap) => ({ ...gap, path: logical(gap.path) })),
      root: representative,
    };
  }));
  const valid = results.map(({ result }) => result);
  const hitsWithSource = results.flatMap((entry) => entry.hits.map((hit) => ({ hit, workspaceId: entry.workspaceId, root: entry.root })));
  const seen = new Set<string>();
  const hits = hitsWithSource
    .sort((left, right) => left.hit.rank - right.hit.rank || left.workspaceId.localeCompare(right.workspaceId) || left.hit.documentId.localeCompare(right.hit.documentId))
    .filter(({ hit, root }) => {
      const absolute = pathModule.resolve(root.root, hit.documentId);
      const key = `${absolute}\0${hit.blockId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ hit }, index) => ({ ...hit, rank: index + 1 }));
  const statusNames = valid.map((result) => result.status);
  const failures = statusNames.filter((status) => status === "failed" || status === "stale").length;
  const unavailable = statusNames.filter((status) => status === "unavailable").length;
  const incomplete = statusNames.filter((status) => status === "incomplete").length;
  const allUnavailable = valid.length > 0 && unavailable === valid.length;
  const allFailed = valid.length > 0 && failures === valid.length;
  const status: ExploreSemanticSearch["status"] = allUnavailable
    ? "unavailable"
    : allFailed
      ? "failed"
      : failures > 0 || unavailable > 0 || incomplete > 0 || valid.some((result) => result.coverage === "partial")
        ? "incomplete"
        : hits.length > 0 ? "ready" : "empty";
  const coverage: ExploreSemanticSearch["coverage"] = valid.length > 0 && valid.every((result) => result.coverage === "complete")
    ? "complete"
    : valid.some((result) => result.coverage === "partial") ? "partial" : "empty";
  const lifecycleRank = { idle: 0, ready: 1, building: 2, rebuilding: 3 } as const;
  const lifecycle = valid.reduce<ExploreSemanticSearch["lifecycle"]>((current, result) => (
    lifecycleRank[result.lifecycle] > lifecycleRank[current] ? result.lifecycle : current
  ), "idle");
  const notes = [...new Set(valid.map((result) => result.note).filter((note): note is string => Boolean(note)))];
  const first = valid.length === 1 ? valid[0] : undefined;
  return {
    status,
    coverage,
    lifecycle,
    hits,
    ...(first?.generation ? { generation: first.generation } : {}),
    ...(first?.spaceId ? { spaceId: first.spaceId } : {}),
    ...(first?.scope ? { scope: first.scope } : {}),
    ...(results.flatMap((entry) => entry.gaps).length > 0 ? { gaps: results.flatMap((entry) => entry.gaps) } : {}),
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

export async function loadSnippetRelationsAcrossRoots(
  host: Partial<Pick<HarnessServiceHost, "fileRelations">>,
  units: readonly ExploreResourceUnit[],
  snippets: ReadonlyArray<{ path: string; revision: string }>,
  signal: AbortSignal,
): Promise<{ status: ExploreRelationStatus; files: ExploreFileRelation[] } | undefined> {
  if (!host.fileRelations || snippets.length === 0) return undefined;
  const distinctSnippets = [...new Map(snippets.map((snippet) => [snippet.path, snippet])).values()];
  const files: ExploreFileRelation[] = [];
  let asked = 0;
  let answered = 0;
  for (const snippet of distinctSnippets) {
    signal.throwIfAborted();
    const target = exploreResourceAtPath(snippet.path, units);
    asked += 1;
    if (!target) continue;
    let relation: Awaited<ReturnType<NonNullable<HarnessServiceHost["fileRelations"]>>>;
    try {
      relation = await host.fileRelations(target.unit.workspaceId, target.resourceId);
    } catch {
      continue;
    }
    answered += 1;
    if (!relation) continue;
    if (relation.imports.length === 0 && relation.connections.length === 0 && relation.associations.length === 0
      && (relation.references?.length ?? 0) === 0 && (relation.calls?.length ?? 0) === 0) continue;
    const mapTarget = (resourceId: string): string => target.unit.external ? pathModule.resolve(target.unit.root, resourceId) : resourceId;
    const mapTargetPath = <T extends { targetPath?: string }>(item: T): T => {
      const { targetPath, ...rest } = item;
      return { ...rest, ...(targetPath ? { targetPath: mapTarget(targetPath) } : {}) } as T;
    };
    files.push({
      ...relation,
      path: snippet.path,
      stale: relation.documentRevision !== snippet.revision,
      ...(relation.references ? { references: relation.references.map(mapTargetPath) } : {}),
      ...(relation.calls ? { calls: relation.calls.map(mapTargetPath) } : {}),
    });
  }
  const status: ExploreRelationStatus = answered === asked ? "ready" : answered === 0 ? "unavailable" : "partial";
  if (files.length === 0 && status === "ready") return undefined;
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { status, files };
}
