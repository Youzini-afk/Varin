import path from "node:path";
import type {
  AgentInputContext,
  ExploreModelParticipation,
  ExploreQueryCancelParams,
  ExploreQueryFinishDetails,
  ExploreQueryFinishParams,
  ExploreQueryFinishResult,
  ExploreQueryFollowupParams,
  ExploreQueryPlanParams,
  ExploreQueryReleaseParams,
  ExploreQuerySelectParams,
  ExploreQueryStartParams,
  ExploreQueryViewsParams,
  ExploreSourceStatus,
  ExploreQueryTaskFamily,
  ExploreQueryTaskStatus,
  HarnessServiceMap,
  HarnessExploreDecisionMode,
} from "@varin/protocol";
import { resolveHarnessCodeRetrievalSettings } from "@varin/protocol";
import {
  documentsFromViews,
  exploreShouldRerank,
  rerankFailureDetails,
  rerankSettingsFromSnapshot,
  scoresFromRerankResult,
} from "./explore-rerank.js";
import {
  fastDecisionStageStatus,
  resolveExploreFastDecision,
  runExploreFastDecisionLoop,
} from "./explore-fast-decision.js";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS } from "@varin/protocol";
import type { HarnessService, HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";
import { HarnessServiceError } from "./service-error.js";
import {
  DEFAULT_BYTE_BUDGET,
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_EXPLORE_QUERY_BUDGET_MS,
  DEFAULT_HITS_PER_FILE,
  DEFAULT_JUDGE_RESERVE_MS,
  DEFAULT_SEMANTIC_RECALL,
  formatExploreOutput,
  type ExploreDeps,
  type ExploreIssue,
} from "./explore.js";
import { pathInRoots, type ExploreGraphRecall } from "./explore-graph.js";
import type { StoredExploreQuery } from "./explore-query-store.js";
import { actorFromHarness, exploreQueryActorsMatch } from "./explore-query-identity.js";
import { sessionScopeId } from "./owner-scope.js";
import {
  exploreResourceAtPath,
  loadExploreGraphRecall,
  loadSnippetRelationsAcrossRoots,
  loadSnippetRelations,
  resolveExploreResourceUnits,
  resolveExploreScopeAndAnchors,
  semanticSearchAcrossRoots,
  type ExploreResourceUnit,
} from "./explore-service.js";
import {
  exploreFileFromSnapshot,
  type WorkingBranchQuerySnapshot,
} from "./working-state/working-branch-lookups.js";

type ExploreParams = HarnessServiceMap["explore.search"]["params"];

const queryCoverage = new WeakMap<StoredExploreQuery, {
  graphMissing: boolean;
  resourceUnits: readonly ExploreResourceUnit[];
}>();

export function bindExploreGraphRecall(
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
    // Wire resolved reference/call edges into the public explore.query chain,
    // not only the low-level explore() unit tests (D-240 rework).
    findReferences: async (name) => (await store.findReferences(name, roots)).map(toSite),
    findCallers: async (name) => (await store.findCallers(name, roots)).map(toSite),
    findCalls: async (caller) => (await store.findCalls(caller, roots)).map(toSite),
  };
}

export function createExploreDeps(
  host: Pick<HarnessServiceHost, "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths">,
  ctx: HarnessServiceContext,
  inputContext: AgentInputContext,
  signal: AbortSignal = ctx.signal,
  roots?: readonly string[],
  snapshot: WorkingBranchQuerySnapshot | null = null,
  graph?: ExploreGraphRecall | null,
  resourceUnits?: readonly ExploreResourceUnit[],
): ExploreDeps {
  const readFile = host.readExploreFile;
  const workspaceId = ctx.actor.workspaceId;
  if (!readFile || (!workspaceId && !resourceUnits?.length)) {
    throw new HarnessServiceError("unavailable", "Workspace document reading is unavailable.");
  }
  const units = resourceUnits ?? [];
  const deps: ExploreDeps = {
    rgSearch: async (pattern, options) => {
      const searchRoots = options.paths?.length ? [...new Set(options.paths)] : units.map((unit) => unit.logicalPrefix);
      const targets = new Map<string, { unit: ExploreResourceUnit; resourceId: string }>();
      if (units.length > 0) {
        for (const searchRoot of searchRoots) {
          for (const unit of units) {
            const target = exploreResourceAtPath(searchRoot, [unit]);
            if (target) targets.set(`${target.unit.workspaceId}\0${target.resourceId}`, target);
          }
        }
      } else {
        for (const searchRoot of searchRoots.length > 0 ? searchRoots : [undefined]) {
          const resourceId = searchRoot;
          if (!workspaceId) continue;
          const fallback: ExploreResourceUnit = {
            workspaceId,
            root: ".",
            external: false,
            resourcePrefix: resourceId ?? ".",
            logicalPrefix: resourceId ?? ".",
          };
          targets.set(`${workspaceId}\0${resourceId ?? ""}`, { unit: fallback, resourceId: resourceId ?? "." });
        }
      }
      const batches = await Promise.all([...targets.values()].map(async ({ unit, resourceId }) => {
        signal.throwIfAborted();
        const search = await host.searchService.search({ pattern, fixedStrings: options.fixedStrings, path: resourceId }, {
          workspaceId,
          actor: ctx.actor,
          ...(unit.authorized ? { authorizedPaths: [{ workspaceId: unit.workspaceId, resourceId }] } : {}),
          inputContext,
          candidateBudget: options.candidateBudget ?? DEFAULT_CANDIDATE_BUDGET,
          hitsPerFile: options.hitsPerFile ?? DEFAULT_HITS_PER_FILE,
          ...(ctx.actor.workspaceScope !== undefined ? { workspaceScope: ctx.actor.workspaceScope } : {}),
          ...(snapshot && snapshot.workspaceId === unit.workspaceId ? { pinnedBranchQuery: snapshot } : {}),
          signal,
        });
        signal.throwIfAborted();
        if (search.status === "unavailable") {
          return { hits: [], partial: true, filesDropped: 0, fileCoverage: "unknown" as const };
        }
        const callPartial = search.partial || (search.filesDropped ?? 0) > 0;
        return {
          hits: search.files.flatMap((file) => file.hits.map((hit) => ({
            path: file.path,
            line: hit.line,
            text: hit.text,
            ...(hit.revision ? { revision: hit.revision } : {}),
          }))),
          partial: callPartial,
          filesDropped: search.filesDropped ?? 0,
          fileCoverage: search.fileCoverage
            ?? ((search.filesDropped ?? 0) > 0 ? "lower-bound" as const : callPartial ? "unknown" as const : "complete" as const),
        };
      }));
      return {
        hits: batches.flatMap((batch) => batch.hits),
        partial: batches.some((batch) => batch.partial),
        filesDropped: batches.reduce((most, batch) => Math.max(most, batch.filesDropped), 0),
        fileCoverage: batches.some((batch) => batch.fileCoverage === "lower-bound")
          ? "lower-bound" as const
          : batches.some((batch) => batch.fileCoverage === "unknown")
            ? "unknown" as const
            : "complete" as const,
      };
    },
    readFile: async (resourceId) => {
      const target = units.length > 0 ? exploreResourceAtPath(resourceId, units) : null;
      if (snapshot && (!target || target.unit.workspaceId === snapshot.workspaceId) && snapshot.workspaceId === workspaceId) {
        const snapshotPath = target?.resourceId ?? resourceId;
        return exploreFileFromSnapshot(snapshot, snapshotPath);
      }
      if (units.length > 0 && !target) throw new Error("Explore file is outside the resolved resource scope.");
      return readFile(ctx.actor, target ? path.resolve(target.unit.root, target.resourceId) : resourceId, signal, inputContext);
    },
    ...(host.structureSource ? {
      structure: {
        outline: (request) => {
          const target = units.length > 0 ? exploreResourceAtPath(request.path, units) : null;
          if (units.length > 0 && !target) throw new Error("Structure path is outside the resolved resource scope.");
          const targetWorkspaceId = target?.unit.workspaceId ?? workspaceId;
          if (!targetWorkspaceId) throw new HarnessServiceError("unavailable", "Structure workspace is unavailable.");
          return host.structureSource!.outline({ ...request, ...(target ? { path: target.resourceId } : {}), workspaceId: targetWorkspaceId, sessionId: ctx.sessionId, inputContext });
        },
        classifyHits: (request) => {
          const target = units.length > 0 ? exploreResourceAtPath(request.path, units) : null;
          if (units.length > 0 && !target) throw new Error("Structure path is outside the resolved resource scope.");
          const targetWorkspaceId = target?.unit.workspaceId ?? workspaceId;
          if (!targetWorkspaceId) throw new HarnessServiceError("unavailable", "Structure workspace is unavailable.");
          return host.structureSource!.classifyHits({ ...request, ...(target ? { path: target.resourceId } : {}), workspaceId: targetWorkspaceId, sessionId: ctx.sessionId, inputContext });
        },
        literalCalls: (request) => {
          const target = units.length > 0 ? exploreResourceAtPath(request.path, units) : null;
          if (units.length > 0 && !target) throw new Error("Structure path is outside the resolved resource scope.");
          const targetWorkspaceId = target?.unit.workspaceId ?? workspaceId;
          if (!targetWorkspaceId) throw new HarnessServiceError("unavailable", "Structure workspace is unavailable.");
          return host.structureSource!.literalCalls({ ...request, ...(target ? { path: target.resourceId } : {}), workspaceId: targetWorkspaceId, sessionId: ctx.sessionId, inputContext });
        },
      },
    } : {}),
    ...(graph ? { graph } : {}),
    ...(host.semanticRecall ? {
      semantic: {
        search: async (question: string, limit?: number, searchSignal?: AbortSignal) => {
          const active = searchSignal ?? signal;
          active.throwIfAborted();
          if (units.length > 0) {
            return semanticSearchAcrossRoots(host.semanticRecall!, units, question, limit ?? DEFAULT_SEMANTIC_RECALL, {
              signal: active,
              sessionId: ctx.sessionId,
              inputContext,
              ...(snapshot ? { threadQuery: snapshot } : {}),
            });
          }
          if (!workspaceId) return { status: "unavailable", coverage: "empty", lifecycle: "idle", hits: [], gaps: [] };
          return host.semanticRecall!(workspaceId, question, limit ?? DEFAULT_SEMANTIC_RECALL, {
            signal: active,
            sessionId: ctx.sessionId,
            inputContext,
            ...(roots ? { roots } : {}),
            ...(snapshot ? { threadQuery: snapshot } : {}),
          });
        },
      },
    } : {}),
  };
  return deps;
}

function requireQuery(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
  ctx: HarnessServiceContext,
  queryId: unknown,
  access: "mutate" | "finish" | "read" | "control",
): StoredExploreQuery {
  if (typeof queryId !== "string" || !queryId.trim()) {
    throw new HarnessServiceError("invalid-params", "Provide the explore query id.");
  }
  const stored = host.exploreQueryStore.get(ctx.sessionId, queryId);
  if (!stored) throw new HarnessServiceError("expired", "Explore query is not active in this session.");
  if (!exploreQueryActorsMatch(stored.actor, ctx.actor)) {
    throw new HarnessServiceError("forbidden", "Explore query does not belong to this actor.");
  }
  const terminal = stored.run.terminal();
  if (access === "mutate" && terminal !== "active") {
    throw new HarnessServiceError("expired", "Explore query is no longer active.");
  }
  if ((access === "finish" || access === "read") && terminal === "cancelled") {
    throw new HarnessServiceError("expired", "Explore query was cancelled.");
  }
  if (access === "mutate" || access === "read") {
    const onAbort = (): void => {
      stored.run.cancel();
    };
    if (ctx.signal.aborted) onAbort();
    else ctx.signal.addEventListener("abort", onAbort, { once: true });
  }
  return stored;
}

export async function packExploreSearchResult(
  host: Pick<HarnessServiceHost, "outputStore"> & Partial<Pick<HarnessServiceHost, "fileRelations">>,
  ctx: HarnessServiceContext,
  result: Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>,
  options?: {
    traceWindows?: boolean;
    searchPartial?: boolean;
    graphMissing?: boolean;
    resourceUnits?: readonly ExploreResourceUnit[];
  },
): Promise<ExploreQueryFinishResult> {
  const incomplete = (options?.searchPartial ?? false) || result.searched.incomplete;
  const graph = result.details.graph && options?.graphMissing
    ? { ...result.details.graph, partial: true }
    : result.details.graph;
  const resolvedDetails = graph ? { ...result.details, graph } : result.details;
  const relations = options?.resourceUnits
    ? await loadSnippetRelationsAcrossRoots(host, options.resourceUnits, result.snippets, ctx.signal)
    : ctx.workspaceId && host.fileRelations
      ? await loadSnippetRelations({ fileRelations: host.fileRelations }, ctx.workspaceId, result.snippets, ctx.signal)
      : undefined;
  const formatted = {
    snippets: result.snippets,
    issues: result.issues,
    notRequested: result.notRequested,
    omitted: result.omitted,
    partial: (options?.searchPartial ?? false) || options?.graphMissing === true || result.partial,
    searchIncomplete: (options?.searchPartial ?? false) || result.searchIncomplete,
    searched: {
      patterns: result.searched.patterns,
      files: result.searched.files,
      ms: result.searched.ms,
      incomplete,
      ...(result.searched.filesDropped !== undefined ? { filesDropped: result.searched.filesDropped } : {}),
    },
    ...(resolvedDetails.graph ? { graph: resolvedDetails.graph } : {}),
    ...(resolvedDetails.semantic ? { semantic: resolvedDetails.semantic } : {}),
    ...(resolvedDetails.skippedQueries ? { skippedQueries: resolvedDetails.skippedQueries } : {}),
    ...(resolvedDetails.model ? { model: resolvedDetails.model } : {}),
    ...(resolvedDetails.rerank ? { rerank: resolvedDetails.rerank } : {}),
    ...(resolvedDetails.fastDecision ? { fastDecision: resolvedDetails.fastDecision } : {}),
    ...(relations ? { relations } : {}),
    ...(resolvedDetails.sources ? { sources: resolvedDetails.sources } : {}),
  };
  const prefix = options?.resourceUnits?.length
    ? `Search scope: ${[...new Set(options.resourceUnits.map((unit) => path.resolve(unit.root, unit.resourcePrefix)))].join(", ")}` : '';
  const preview = formatExploreOutput(formatted, { byteBudget: DEFAULT_BYTE_BUDGET, prefix });
  const fullDetails = {
    notRequested: result.notRequested,
    omitted: result.omitted,
    previewOmitted: preview.omitted,
    details: resolvedDetails,
    ...(relations ? { relations } : {}),
  };
  const storedBody = `${preview.storedBody}\n\nExplore structured details (JSON):\n${JSON.stringify(fullDetails)}`;
  const stored = host.outputStore.store(ctx.sessionId, storedBody, "explore");
  const summaryFormatted = {
    ...formatted,
    notRequested: { count: result.notRequested.count, paths: [] },
    omitted: [],
    omittedCount: result.omitted.length,
    summaryOnly: true,
  };
  const packed = formatExploreOutput(summaryFormatted, { byteBudget: DEFAULT_BYTE_BUDGET, handle: stored.ref.handle, prefix });
  const provenanceCounts: Partial<Record<ExploreSourceStatus, number>> = {};
  for (const entry of result.details.provenance) {
    provenanceCounts[entry.status] = (provenanceCounts[entry.status] ?? 0) + 1;
  }
  const details: ExploreQueryFinishDetails = {
    provenance: { statusCounts: provenanceCounts },
    anchors: result.details.anchors,
    byteBudget: DEFAULT_BYTE_BUDGET,
    ...(result.details.structure ? { structure: summarizeStructure(result.details.structure.files) } : {}),
    ...(resolvedDetails.graph ? { graph: resolvedDetails.graph } : {}),
    ...(resolvedDetails.query ? {
      query: {
        objectCount: resolvedDetails.query.objects.length,
        relation: resolvedDetails.query.relation,
        domain: resolvedDetails.query.domain,
      },
    } : {}),
    ...(resolvedDetails.skippedQueries ? {
      skippedQueries: { reason: resolvedDetails.skippedQueries.reason, patternCount: resolvedDetails.skippedQueries.patterns.length },
    } : {}),
    ...(resolvedDetails.distinctiveness ? {
      distinctiveness: {
        scope: resolvedDetails.distinctiveness.scope,
        poolFiles: resolvedDetails.distinctiveness.poolFiles,
        termCount: resolvedDetails.distinctiveness.terms.length,
      },
    } : {}),
    ...(relations ? { relations: summarizeRelations(relations) } : {}),
    ...(resolvedDetails.semantic ? { semantic: summarizeSemantic(resolvedDetails.semantic) } : {}),
    ...(resolvedDetails.rerank ? { rerank: resolvedDetails.rerank } : {}),
    ...(resolvedDetails.fastDecision ? { fastDecision: summarizeFastDecision(resolvedDetails.fastDecision) } : {}),
    ...(resolvedDetails.model ? { model: resolvedDetails.model } : {}),
    ...(resolvedDetails.sources ? { sources: summarizeSources(resolvedDetails.sources) } : {}),
  };
  return {
    text: packed.visibleText,
    snippets: packed.snippets,
    issueCount: result.issues.length,
    notRequestedCount: result.notRequested.count,
    omittedCount: result.omitted.length + packed.omitted.length,
    partial: formatted.partial || packed.omitted.some(item => item.reason === 'over byte budget' || item.reason === 'required range exceeded output budget'),
    searched: formatted.searched,
    handle: stored.ref.handle,
    details,
  };
}

function summarizeStructure(files: NonNullable<Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>["details"]["structure"]>["files"]): NonNullable<ExploreQueryFinishDetails["structure"]> {
  const providers: NonNullable<ExploreQueryFinishDetails["structure"]>["providers"] = {};
  const statuses: NonNullable<ExploreQueryFinishDetails["structure"]>["statuses"] = {};
  for (const file of files) {
    const provider = file.provider ?? "none";
    providers[provider] = (providers[provider] ?? 0) + 1;
    statuses[file.status] = (statuses[file.status] ?? 0) + 1;
  }
  return { fileCount: files.length, providers, statuses };
}

function summarizeRelations(
  relations: NonNullable<Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>["details"]["relations"]>,
): NonNullable<ExploreQueryFinishDetails["relations"]> {
  const summary: NonNullable<ExploreQueryFinishDetails["relations"]> = {
    status: relations.status,
    fileCount: relations.files.length,
    staleFiles: relations.files.filter((file) => file.stale).length,
    incompleteFiles: relations.files.filter((file) => file.incomplete).length,
    edgeCounts: { imports: 0, connections: 0, associations: 0, references: 0, calls: 0 },
  };
  for (const file of relations.files) {
    summary.edgeCounts.imports += file.imports.length;
    summary.edgeCounts.connections += file.connections.length;
    summary.edgeCounts.associations += file.associations.length;
    summary.edgeCounts.references += file.references?.length ?? 0;
    summary.edgeCounts.calls += file.calls?.length ?? 0;
  }
  return summary;
}

function summarizeSemantic(
  semantic: NonNullable<Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>["details"]["semantic"]>,
): NonNullable<ExploreQueryFinishDetails["semantic"]> {
  return {
    status: semantic.status,
    coverage: semantic.coverage,
    ...(semantic.note ? { note: semantic.note } : {}),
    ...(semantic.generation ? { generation: semantic.generation } : {}),
    ...(semantic.spaceId ? { spaceId: semantic.spaceId } : {}),
    ...(semantic.scope ? { scope: semantic.scope } : {}),
    index: semantic.index,
    ...(semantic.blocks !== undefined ? { blocks: semantic.blocks } : {}),
    ...(semantic.units !== undefined ? { units: semantic.units } : {}),
    ...(semantic.primary !== undefined ? { primary: semantic.primary } : {}),
    ...(semantic.gaps?.length ? { gapCount: semantic.gaps.length } : {}),
  };
}

function summarizeFastDecision(
  details: NonNullable<Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>["details"]["fastDecision"]>,
): NonNullable<ExploreQueryFinishDetails["fastDecision"]> {
  return {
    status: details.status,
    ...(details.providerId ? { providerId: details.providerId } : {}),
    ...(details.modelId ? { modelId: details.modelId } : {}),
    ...(details.servedModelId ? { servedModelId: details.servedModelId } : {}),
    batches: details.batches,
    rounds: details.rounds,
    viewsJudged: details.viewsJudged,
    actionsOffered: details.actionsOffered,
    actionsExecuted: details.actionsExecuted,
    missing: details.missing,
    unevaluatedMaterials: details.unevaluatedMaterials,
    ...(details.usage ? { usage: details.usage } : {}),
    ...(details.note ? { note: details.note } : {}),
  };
}

function summarizeSources(
  sources: Awaited<ReturnType<StoredExploreQuery["run"]["finish"]>>["details"]["sources"],
): NonNullable<ExploreQueryFinishDetails["sources"]> {
  const families: Partial<Record<ExploreQueryTaskFamily, number>> = {};
  const statuses: Partial<Record<ExploreQueryTaskStatus, number>> = {};
  for (const source of sources ?? []) {
    families[source.family] = (families[source.family] ?? 0) + 1;
    statuses[source.status] = (statuses[source.status] ?? 0) + 1;
  }
  return { count: sources?.length ?? 0, families, statuses };
}

export function createExploreQueryStartService(
  host: Pick<HarnessServiceHost, "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore" | "harnessSettings" | "pinWorkingBranchQuery" | "fastDecision" | "fastDecisionStatus">,
): HarnessService<"explore.query.start"> {
  return {
    handle: async (params: ExploreQueryStartParams, ctx) => {
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
      if (params.budgetMs !== undefined && (
        !Number.isFinite(params.budgetMs)
        || params.budgetMs <= 0
        || params.budgetMs > HARNESS_MAX_REQUEST_TIMEOUT_MS
      )) {
        throw new HarnessServiceError(
          "invalid-params",
          `The explore query budget must be between 1 and ${HARNESS_MAX_REQUEST_TIMEOUT_MS}ms.`,
        );
      }
      if (params.reserveForJudge !== undefined && typeof params.reserveForJudge !== "boolean") {
        throw new HarnessServiceError("invalid-params", "reserveForJudge must be a boolean.");
      }
      ctx.signal.throwIfAborted();
      const inputContext = ctx.inputContext ?? { source: "disk" as const };
      const budgetMs = typeof params.budgetMs === "number"
        ? params.budgetMs
        : DEFAULT_EXPLORE_QUERY_BUDGET_MS;
      const deadlineAt = Date.now() + budgetMs;
      const queryController = new AbortController();
      let stored: StoredExploreQuery | undefined;
      const onStartAbort = (): void => {
        if (!queryController.signal.aborted) queryController.abort();
        stored?.run.cancel();
      };
      if (ctx.signal.aborted) onStartAbort();
      else ctx.signal.addEventListener("abort", onStartAbort, { once: true });
      try {
        const resolvedRequest = resolveExploreScopeAndAnchors(params, ctx);
        const effectivePaths = resolvedRequest.paths;
        const effectiveAnchors = resolvedRequest.anchors;
        const resourceUnits = await resolveExploreResourceUnits(host.searchService, ctx, params, effectivePaths);
        if (resourceUnits.length === 0) {
          throw new HarnessServiceError("unavailable", "No usable resource root was available for this query.");
        }
        let rerankConfigured = false;
        let fastDecision: StoredExploreQuery["fastDecision"];
        let decisionMode: HarnessExploreDecisionMode = "auto";
        // Inference bindings are global even when a session owns no project.
        // This scope does not grant access to any additional resource root.
        const inferenceScopeId = ctx.workspaceId ?? sessionScopeId(ctx.sessionId);
        const snapshotSettings = await Promise.resolve(
          host.harnessSettings?.(inferenceScopeId) ?? null,
        ).catch(() => null);
        try {
          const rawHarness = snapshotSettings?.global?.harness;
          decisionMode = resolveHarnessCodeRetrievalSettings(
            rawHarness && typeof rawHarness === "object" && !Array.isArray(rawHarness)
              ? (rawHarness as { codeRetrieval?: unknown }).codeRetrieval : undefined,
          ).decision;
        } catch {
          // An invalid external edit must not silently dispatch a paid judge.
          decisionMode = "source";
        }
        try {
          rerankConfigured = (decisionMode === "auto" || decisionMode === "rerank")
            && rerankSettingsFromSnapshot(snapshotSettings) !== undefined;
        } catch {
          rerankConfigured = false;
        }
        // Fast Decision (D-312): freeze the resolved binding — including its
        // credential-free configurationId — at query start. A settings edit
        // applies to the next query, never this one.
        if ((decisionMode === "auto" || decisionMode === "fast-decision") && host.fastDecision && host.fastDecisionStatus) {
          const status = await host.fastDecisionStatus(inferenceScopeId, "explore").catch(() => undefined);
          fastDecision = resolveExploreFastDecision(status);
        } else if (decisionMode === "auto" || decisionMode === "fast-decision") {
          fastDecision = { status: "unavailable" };
        }
        const localUnits = resourceUnits.filter((unit) => unit.workspaceId === ctx.actor.workspaceId && !unit.external);
        const pinRoots = [...new Set(localUnits.map((unit) => unit.resourcePrefix === "." ? "" : unit.resourcePrefix))];
        const [snapshot, graphSources] = await Promise.all([
          host.pinWorkingBranchQuery && localUnits.length > 0
            ? host.pinWorkingBranchQuery(ctx.sessionId, {
              roots: pinRoots,
              signal: queryController.signal,
              deadlineAt,
            })
            : Promise.resolve(null),
          loadExploreGraphRecall(host, ctx, resourceUnits),
        ]);
        stored = host.exploreQueryStore.start({
          actor: actorFromHarness(ctx.actor),
          inputContext,
          input: {
            question: params.question,
            ...(effectiveAnchors ? { anchors: effectiveAnchors } : {}),
            ...(effectivePaths ? { paths: effectivePaths } : {}),
            ...(params.limit ? { limit: params.limit } : {}),
          },
          deps: createExploreDeps(
            host,
            ctx,
            inputContext,
            queryController.signal,
            effectivePaths,
            snapshot,
            graphSources.graph,
            resourceUnits,
          ),
          deadlineAt,
          reserveForJudgeMs: ((decisionMode === "auto" || decisionMode === "llm") && params.reserveForJudge)
            || rerankConfigured || fastDecision?.status === "ready"
            ? DEFAULT_JUDGE_RESERVE_MS
            : 0,
          controller: queryController,
        });
        stored.decisionMode = decisionMode;
        queryCoverage.set(stored, { graphMissing: graphSources.missing > 0, resourceUnits });
        if (fastDecision) {
          stored.fastDecision = fastDecision;
          if (fastDecision.status === "ready" && fastDecision.binding && host.fastDecision) {
            const binding = fastDecision.binding;
            // The loop shares the query's lifetime: cancelController covers
            // cancel/release/total deadline; `abort` is the finish-time stop.
            const loopAbort = new AbortController();
            const loopSignal = AbortSignal.any([stored.cancelController.signal, loopAbort.signal]);
            let settleRequested = false;
            let settle!: () => void;
            const settlePromise = new Promise<void>((resolve) => { settle = resolve; });
            fastDecision.requestSettle = () => {
              settleRequested = true;
              settle();
            };
            fastDecision.abort = () => {
              if (!loopAbort.signal.aborted) loopAbort.abort();
            };
            fastDecision.done = runExploreFastDecisionLoop({
              run: stored.run,
              binding,
              call: (batch) => host.fastDecision!({
                workspaceId: inferenceScopeId,
                purpose: "explore",
                settings: binding,
                goal: batch.goal,
                materials: batch.materials,
                questions: batch.questions,
                signal: batch.signal,
              }),
              signal: loopSignal,
              deadlineAt: stored.deadlineAt,
              waitForLaterProgress: true,
              closing: { promise: settlePromise, requested: () => settleRequested },
            }).then((details) => {
              stored!.run.applyFastDecision(details);
              fastDecision.details = details;
            }).catch(() => undefined);
          }
        }
        await stored.run.refreshVocab();
        ctx.signal.throwIfAborted();
        ctx.deferResponseDelivery?.(
          () => undefined,
          () => { if (stored) host.exploreQueryStore.release(ctx.actor, stored.id); },
        );
        return {
          queryId: stored.id,
          question: stored.run.question,
          deadlineAt: stored.deadlineAt,
          parsed: {
            objects: stored.run.parsed.objects,
            relation: stored.run.parsed.relation,
            domain: stored.run.parsed.domain,
          },
          vocab: stored.run.vocab(),
          sources: stored.run.sourceStates(),
          inputSource: stored.inputContext.source,
          decisionMode,
          ...(fastDecision ? { fastDecision: { status: fastDecision.status } } : {}),
        };
      } catch (error) {
        if (stored) host.exploreQueryStore.release(ctx.actor, stored.id);
        else if (!queryController.signal.aborted) queryController.abort();
        throw error;
      } finally {
        ctx.signal.removeEventListener("abort", onStartAbort);
      }
    },
  };
}

export function createExploreQueryPlanService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.plan"> {
  return {
    handle: async (params: ExploreQueryPlanParams, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "mutate");
      const submitted = await stored.run.submitPlan(params.plan);
      return {
        queryId: stored.id,
        launched: submitted.launched,
        reused: submitted.reused,
        sources: stored.run.sourceStates(),
      };
    },
  };
}

export function createExploreQueryViewsService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.views"> {
  return {
    handle: async (params: ExploreQueryViewsParams, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "read");
      await stored.run.waitForViews();
      const views = stored.run.viewsForModel();
      return {
        queryId: stored.id,
        question: stored.run.question,
        ...(views.hypotheses ? { hypotheses: views.hypotheses } : {}),
        views: views.views,
        unevaluated: views.unevaluated,
        sources: stored.run.sourceStates(),
        deadlineAt: stored.deadlineAt,
      };
    },
  };
}

export function createExploreQuerySelectService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.select"> {
  return {
    handle: async (params: ExploreQuerySelectParams, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "mutate");
      const selected = stored.run.applySelection(params.groups, { merge: params.merge === true });
      return { ...selected, queryId: stored.id };
    },
  };
}

export function createExploreQueryFollowupService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.followup"> {
  return {
    handle: async (params: ExploreQueryFollowupParams, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "mutate");
      const result = await stored.run.followup(params);
      return {
        queryId: stored.id,
        launched: result.launched,
        reused: result.reused,
        newViews: result.newViews,
        ...(result.actionsExecuted.length > 0 ? { actionsExecuted: result.actionsExecuted } : {}),
        ...(result.actionsRejected.length > 0 ? { actionsRejected: result.actionsRejected } : {}),
        sources: stored.run.sourceStates(),
      };
    },
  };
}

export function createExploreQueryFinishService(
  host: Pick<HarnessServiceHost, "exploreQueryStore" | "outputStore" | "rerankExploreViews" | "harnessSettings">
    & Partial<Pick<HarnessServiceHost, "fileRelations">>,
  options?: { traceWindows?: boolean },
): HarnessService<"explore.query.finish"> {
  return {
    handle: async (params: ExploreQueryFinishParams & { model?: ExploreModelParticipation }, ctx) => {
      const stored = requireQuery(host, ctx, params.queryId, "finish");
      const model = params.model;
      const inferenceScopeId = stored.workspaceId ?? sessionScopeId(stored.sessionId);
      const coverage = queryCoverage.get(stored);
      const packOptions = {
        ...options,
        ...(coverage?.graphMissing ? { graphMissing: true } : {}),
        ...(coverage ? { resourceUnits: coverage.resourceUnits } : {}),
      };
      const packOnce = (result: ReturnType<StoredExploreQuery['run']['finish']>): Promise<ExploreQueryFinishResult> => {
        if (stored.packed) return stored.packed;
        const pending = packExploreSearchResult(host, ctx, result, packOptions);
        stored.packed = pending;
        void pending.catch(() => { if (stored.packed === pending) delete stored.packed; });
        return pending;
      };
      if (stored.run.terminal() === "finished") {
        return packOnce(stored.run.finish(model));
      }
      stored.finishing ??= (async () => {
        // Fast Decision (D-312): the progressive loop owns material relevance
        // and action choice while it is configured for this query — the same
        // judgment is not re-run through rerank or another paid model (§4.4).
        const fastDecision = stored.fastDecision;
        const fastDecisionActive = fastDecision?.status === "ready";
        if (fastDecisionActive) {
          fastDecision.requestSettle?.();
          const remaining = Math.max(0, stored.deadlineAt - Date.now());
          await Promise.race([
            fastDecision.done,
            new Promise<void>((resolve) => {
              setTimeout(resolve, Math.min(remaining, DEFAULT_JUDGE_RESERVE_MS));
            }),
          ]);
          if (fastDecision.done) {
            fastDecision.abort?.();
            await fastDecision.done;
          }
        }
        if (model && fastDecisionActive) {
          model.fastDecision = fastDecisionStageStatus(fastDecision.details);
          if (model.rerank === undefined) model.rerank = "skipped";
        } else if (model && fastDecision && fastDecision.status !== "ready") {
          model.fastDecision = fastDecision.status === "disabled"
            ? "disabled"
            : fastDecision.status === "unconfigured"
              ? "unconfigured"
              : "failed";
          if (fastDecision.status === "invalid" || fastDecision.status === "unavailable") {
            model.note = `${model.note ? `${model.note} ` : ""}Fast decision is ${fastDecision.status}; source ranking was kept.`;
          }
        }
        const shouldRerank = stored.decisionMode === "rerank"
          || (stored.decisionMode !== "llm" && stored.decisionMode !== "fast-decision"
            && stored.decisionMode !== "source" && exploreShouldRerank(model));
        if (Date.now() < stored.deadlineAt && shouldRerank && host.rerankExploreViews && !fastDecisionActive) {
          let settings: ReturnType<typeof rerankSettingsFromSnapshot>;
          let settingsInvalid = false;
          try {
            settings = rerankSettingsFromSnapshot(await host.harnessSettings?.(inferenceScopeId) ?? null);
          } catch {
            settingsInvalid = true;
            stored.run.applyRerank([], {
              status: "failed",
              note: "Rerank settings are malformed; source ranking was kept.",
            });
            if (model) model.rerank = "failed";
          }
          if (settings) {
            try {
              const views = stored.run.viewsForModel().views;
              const { documents } = documentsFromViews(
                views,
                settings.maxDocumentTokens,
                // Character count is an estimate; the remote tokenizer may differ.
                // Over-budget views keep their source rank without being sent.
                (text) => Math.max(1, text.length),
              );
              if (documents.length > 0) {
                const ranked = await host.rerankExploreViews({
                  workspaceId: inferenceScopeId,
                  query: stored.run.question,
                  documents,
                  settings,
                  signal: AbortSignal.any([ctx.signal, stored.cancelController.signal]),
                });
                const scores = scoresFromRerankResult(ranked, documents);
                if (scores.length === 0) throw new Error("Rerank returned no valid scores");
                stored.run.applyRerank(scores, {
                  status: "used",
                  providerId: settings.providerId,
                  modelId: settings.modelId,
                  batchId: ranked.batchId,
                  evaluated: scores.length,
                });
                if (model) model.rerank = "used";
              } else if (model) {
                model.rerank = "skipped";
              }
            } catch (error) {
              const cancelled = ctx.signal.aborted || (error instanceof Error && error.name === "AbortError");
              stored.run.applyRerank([], rerankFailureDetails(
                settings,
                cancelled ? "cancelled" : "failed",
                cancelled ? "Rerank was cancelled; source ranking was kept." : "Rerank failed; source ranking was kept.",
              ));
              if (model) model.rerank = cancelled ? "cancelled" : "failed";
            }
          } else if (model && !settingsInvalid) {
            model.rerank = "unconfigured";
          }
        } else if (model && model.rerank === undefined) {
          model.rerank = shouldRerank ? "unconfigured" : stored.decisionMode === "auto" ? "skipped" : "disabled";
        }
        const result = stored.run.finish(model);
        if (!stored.controller.signal.aborted) stored.controller.abort();
        if (!stored.cancelController.signal.aborted) stored.cancelController.abort();
        return result;
      })();
      const result = await stored.finishing;
      if (result.snippets.length === 0 && result.issues.length > 0) {
        throw new HarnessServiceError("unavailable", `No current excerpts could be read: ${result.issues.map((issue: ExploreIssue) => `${issue.path} (${issue.status})`).join(", ")}. Search again.`);
      }
      return packOnce(result);
    },
  };
}

export function createExploreQueryCancelService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.cancel"> {
  return {
    handle: async (params: ExploreQueryCancelParams, ctx) => ({
      cancelled: host.exploreQueryStore.cancel(ctx.actor, params.queryId),
    }),
  };
}

export function createExploreQueryReleaseService(
  host: Pick<HarnessServiceHost, "exploreQueryStore">,
): HarnessService<"explore.query.release"> {
  return {
    handle: async (params: ExploreQueryReleaseParams, ctx) => ({
      released: host.exploreQueryStore.release(ctx.actor, params.queryId),
    }),
  };
}

export function ownedDirtyPathsFor(
  inputContext: AgentInputContext,
  actor: HarnessServiceContext["actor"],
  params: ExploreParams,
  authorizedPaths: ReadonlyArray<{ workspaceId: string; resourceId: string }>,
  draftPaths?: (sessionId: string, context: AgentInputContext, workspaceId: string) => readonly string[],
): Array<{ workspaceId: string; resourceId: string }> {
  if (inputContext.source !== "surface") return [];
  return inputContext.roots.flatMap((root) => {
    const owned = draftPaths ? draftPaths(actor.sessionId, inputContext, root.workspaceId) : root.dirtyPaths;
    return owned
      .map((resourceId) => ({ workspaceId: root.workspaceId, resourceId }))
      .filter((dirty) => params.paths === undefined
        || authorizedPaths.some((authorized) => authorized.workspaceId === dirty.workspaceId
          && pathInRoots(dirty.resourceId, [authorized.resourceId])));
  });
}
