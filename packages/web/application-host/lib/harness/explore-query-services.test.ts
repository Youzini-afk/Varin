import { isAbsolute, relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentInputContext, HarnessActorContext } from "@varin/protocol";
import {
  createExploreQueryCancelService,
  createExploreQueryFinishService,
  createExploreQueryStartService,
  createExploreQueryViewsService as collectService,
  packExploreSearchResult,
} from "./explore-query-services.js";
import { createExploreQueryStore } from "./explore-query-store.js";
import { createOutputStore } from "./output-store.js";
import type { ExploreResult } from "./explore.js";
import { createExploreSearchService, resolveExploreScopeAndAnchors, resolveExploreResourceUnits } from "./explore-service.js";
import type { HarnessServiceContext } from "./router.js";
import type { HarnessServiceHost } from "./service-host.js";

const actor: HarnessActorContext = {
  authorityInstanceId: "test-host",
  sessionId: "test-session",
  workerId: "worker",
  workerGeneration: 1,
  workspaceId: "workspace-1",
  grantedCapabilities: ["read.search"],
};

const surface: AgentInputContext = {
  source: "surface",
  roots: [{ workspaceId: "workspace-1", dirtyPaths: ["a.ts"] }],
  snapshot: { status: "ready", ref: "surface" },
};

function context(inputContext: AgentInputContext, signal = new AbortController().signal): HarnessServiceContext {
  return {
    actor,
    authorizedPaths: [],
    sessionId: actor.sessionId,
    workspaceId: actor.workspaceId,
    inputContext,
    signal,
  };
}

function createExploreQueryViewsService(host: Pick<HarnessServiceHost, "exploreQueryStore">) {
  const service = collectService(host);
  return { handle: async (params: Parameters<typeof service.handle>[0], ctx: HarnessServiceContext) => {
    const run = host.exploreQueryStore.get(ctx.sessionId, params.queryId)?.run;
    if (run) await run.waitForViews();
    return service.handle(params, ctx);
  } };
}

describe("explore query services", () => {
  it('returns delivery metadata for the exact visible byte pack while retaining all prepared source in output storage', async () => {
    const { explore } = await import('./explore.js');
    const paths = Array.from({ length: 8 }, (_, index) => `long-source-${index}.ts`);
    const body = `needle ${'x'.repeat(7800)}`;
    const result = await explore({ question: 'needle', limit: 8 }, {
      rgSearch: async () => paths.map(path => ({ path, line: 1, text: body })),
      readFile: async () => ({ status: 'ready', content: body, revision: 'rev', source: 'disk' }),
    });
    const outputStore = createOutputStore();
    const delivered = await packExploreSearchResult({ outputStore }, context({ source: 'disk' }), result);
    const headers = delivered.text.split('\n').filter(line => line.startsWith('--- '));
    expect(headers).toHaveLength(delivered.snippets.length);
    expect(delivered.snippets.length).toBeLessThan(result.snippets.length);
    for (const snippet of delivered.snippets) expect(delivered.text).toContain(snippet.text);
    expect(Buffer.byteLength(delivered.text)).toBeLessThanOrEqual(delivered.details.byteBudget);
    expect(delivered.partial).toBe(true);
    const full = outputStore.read(actor.sessionId, delivered.handle, 0, 100_000);
    expect(full.status).toBe('ready');
    if (full.status !== 'ready') throw new Error('expected full prepared output');
    for (const snippet of result.snippets) expect(full.slice.text).toContain(`--- ${snippet.path}:${snippet.startLine}-${snippet.endLine}`);
    outputStore.dispose();
  });

  it("does not expand explicit directories when a path anchor points elsewhere", async () => {
    const ctx = {
      ...context({ source: "disk" }),
      authorizedPaths: [
        { authorityId: "test-host", workspaceId: actor.workspaceId!, canonicalResourceId: "/workspace/src", resourceId: "src", inputPath: "src" },
        { authorityId: "test-host", workspaceId: actor.workspaceId!, canonicalResourceId: "/workspace/other/ref.ts", resourceId: "other/ref.ts", inputPath: "other/ref.ts" },
      ],
    };
    const params = { question: "needle", paths: ["src"], anchors: ["other/ref.ts"] };
    const scoped = resolveExploreScopeAndAnchors(params, ctx);
    expect(scoped.paths).toEqual(["src"]);
    const units = await resolveExploreResourceUnits({ resolveWorkspaceRoot: async () => "/workspace", resolveScopeRoot: undefined }, ctx, params, scoped.paths);
    expect(units.map((unit) => unit.resourcePrefix)).toEqual(["src"]);
  });

  it("uses the session cwd as the default for a session without a project binding", async () => {
    const cwd = resolve("workspace/project");
    const resolveScopeRoot = vi.fn(async () => ({ workspaceId: "directory-root", root: cwd }));
    const ctx = {
      ...context({ source: "disk" }),
      workspaceId: null,
      actor: { ...actor, workspaceId: null, cwd, authorityRoot: resolve("workspace") },
    };
    const units = await resolveExploreResourceUnits({ resolveScopeRoot, resolveWorkspaceRoot: async () => cwd }, ctx, { question: "needle" }, undefined);
    expect(resolveScopeRoot).toHaveBeenCalledWith(cwd);
    expect(units.map((unit) => unit.root)).toEqual([cwd]);
  });

  it("returns completed excerpts after the deadline without starting another model stage", async () => {
    const store = createExploreQueryStore();
    const outputStore = createOutputStore();
    const rerankExploreViews = vi.fn();
    const host = {
      exploreQueryStore: store, outputStore, rerankExploreViews,
      searchService: { search: async () => ({ status: "ready", files: [{ path: "a.ts", hits: [{ line: 1, text: "needle" }] }], partial: false }) },
      readExploreFile: async () => ({ status: "ready" as const, content: "needle", revision: "r1", source: "disk" as const }),
    } as unknown as HarnessServiceHost;
    try {
      const ctx = context({ source: "disk" });
      const started = await createExploreQueryStartService(host).handle({ question: "needle", budgetMs: 300_000 }, ctx);
      expect(started.deadlineAt - Date.now()).toBeGreaterThan(290_000);
      await createExploreQueryViewsService(host).handle({ queryId: started.queryId }, ctx);
      const stored = store.get(actor.sessionId, started.queryId)!;
      stored.deadlineAt = Date.now() - 1;
      stored.cancelController.abort();
      const result = await createExploreQueryFinishService(host).handle({ queryId: started.queryId }, ctx);
      expect(result.snippets[0]?.text).toContain("needle");
      expect(result.text).toContain("Search scope:");
      expect(rerankExploreViews).not.toHaveBeenCalled();
    } finally { store.dispose(); outputStore.dispose(); }
  });

  it("uses configured rerank in a projectless session without assigning it a project", async () => {
    const store = createExploreQueryStore();
    const outputStore = createOutputStore();
    const cwd = resolve("workspace/projectless");
    const ctx = { ...context({ source: "disk" }), workspaceId: null,
      actor: { ...actor, workspaceId: null, cwd, authorityRoot: cwd } };
    const harnessSettings = vi.fn(async () => ({
      global: { harness: { codeRetrieval: { decision: "rerank" },
        rerank: { protocol: "http-rerank", providerId: "remote", modelId: "ranking" } } },
      globalRevision: "1", project: {}, projectRevision: "1", projectTrusted: false,
    }));
    const rerankExploreViews = vi.fn(async (input: { documents: Array<{ id: string }> }) => ({
      batchId: "rank", providerId: "remote", modelId: "ranking",
      scores: input.documents.map((document, index) => ({ id: document.id, index, score: 1 })),
    }));
    const host = { exploreQueryStore: store, outputStore, harnessSettings, rerankExploreViews,
      searchService: {
        resolveScopeRoot: async () => ({ workspaceId: "resource-root", root: cwd }),
        resolveWorkspaceRoot: async () => cwd,
        search: async () => ({ status: "ready", partial: false,
          files: [{ path: resolve(cwd, "a.ts"), hits: [{ line: 1, text: "needle" }] }] }),
      },
      readExploreFile: async () => ({ status: "ready", content: "needle", revision: "r1", source: "disk" }),
    } as unknown as HarnessServiceHost;
    try {
      const started = await createExploreQueryStartService(host).handle({ question: "needle" }, ctx);
      expect(started.decisionMode).toBe("rerank");
      await createExploreQueryViewsService(host).handle({ queryId: started.queryId }, ctx);
      const result = await createExploreQueryFinishService(host).handle({ queryId: started.queryId,
        model: { plan: "disabled", select: "disabled", followup: "disabled" } }, ctx);
      expect(result.details.model?.rerank).toBe("used");
      expect(harnessSettings).toHaveBeenCalledWith("session:test-session");
      expect(rerankExploreViews).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "session:test-session" }));
      expect(store.get(actor.sessionId, started.queryId)?.workspaceId).toBeNull();
    } finally { store.dispose(); outputStore.dispose(); }
  });

  it("keeps the direct explore.search contract full while query.finish uses summaries", async () => {
    const outputStore = createOutputStore();
    const paths = Array.from({ length: 9 }, (_, index) => `candidate-${index}.ts`);
    const host = {
      outputStore,
      searchService: {
        search: async () => ({
          status: "ready",
          files: paths.map((path) => ({ path, hits: [{ line: 1, text: "needle" }] })),
          partial: false,
        }),
      },
      readExploreFile: async (_actor: HarnessActorContext, _path: string) => ({
        status: "ready" as const,
        content: "needle",
        revision: "rev-1",
        source: "disk" as const,
      }),
    } as unknown as Pick<
      HarnessServiceHost,
      "outputStore" | "searchService" | "readExploreFile" | "agentInputDraftPaths" | "structureSource" | "fileRelations" | "graphRecall" | "semanticRecall"
    >;
    try {
      const result = await createExploreSearchService(host).handle({ question: "needle", limit: 1 }, context({ source: "disk" }));
      expect(result.notRequested.count).toBe(0);
      expect(result.notRequested.paths.length).toBe(result.notRequested.count);
      expect(result.omitted.length).toBeGreaterThan(0);
      expect(result.details.provenance.some((entry) => entry.status === "not-requested")).toBe(false);
    } finally {
      outputStore.dispose();
    }
  });

  it("keeps full omitted, unread, and provenance details in the session output handle", async () => {
    const outputStore = createOutputStore();
    const result: ExploreResult = {
      snippets: [{
        path: "read.ts",
        startLine: 1,
        endLine: 1,
        text: "needle",
        why: "matched needle",
        revision: "rev-1",
        source: "disk",
      }],
      issues: [],
      notRequested: { count: 1, paths: ["unread-secret.ts"] },
      omitted: [{ path: "omitted-secret.ts", startLine: 3, endLine: 4, reason: "not selected" }],
      partial: true,
      searchIncomplete: false,
      searched: { patterns: 1, files: 2, ms: 1, incomplete: false },
      details: {
        provenance: [
          { path: "read.ts", revision: "rev-1", source: "disk", status: "ready", matchedGroups: ["question:needle"] },
          { path: "unread-secret.ts", revision: "", source: null, status: "not-requested", matchedGroups: [] },
        ],
        anchors: { supplied: [], used: [], truncated: 0 },
        byteBudget: 24 * 1024,
      },
    };
    try {
      const packed = await packExploreSearchResult(
        { outputStore },
        context({ source: "disk" }),
        result,
      );
      expect(packed.notRequestedCount).toBe(1);
      expect(packed.omittedCount).toBe(1);
      expect(packed.partial).toBe(true);
      expect(packed.details.provenance.statusCounts).toEqual({ ready: 1, "not-requested": 1 });
      expect(JSON.stringify(packed)).not.toMatch(/unread-secret|omitted-secret/);
      expect(packed.text).toContain("listed in output store");
      expect(packed.text).toContain(`get_output("${packed.handle}")`);

      const full = outputStore.read(actor.sessionId, packed.handle, 0, 100_000);
      expect(full.status).toBe("ready");
      if (full.status !== "ready") throw new Error("expected full explore output");
      expect(full.slice.text).toContain("unread-secret.ts");
      expect(full.slice.text).toContain("omitted-secret.ts");
      expect(full.slice.text).toContain('"path":"read.ts","revision":"rev-1","source":"disk","status":"ready","matchedGroups":["question:needle"]');
      expect(full.slice.text).toContain('"path":"unread-secret.ts","revision":"","source":null,"status":"not-requested","matchedGroups":[]');
      expect(full.slice.text).toContain('"status":"not-requested"');
    } finally {
      outputStore.dispose();
    }
  });

  it("pins explicit paths to Router-authorized workspace resource IDs", async () => {
    const store = createExploreQueryStore();
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async () => ({ status: "ready", files: [], partial: false }),
      },
      readExploreFile: async () => ({ status: "ready" as const, content: "", revision: "rev-1", source: "disk" as const }),
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const ctx: HarnessServiceContext = {
      ...context({ source: "disk" }),
      authorizedPaths: [{
        authorityId: "test-host",
        workspaceId: "workspace-1",
        canonicalResourceId: "C:/workspace/src",
        inputPath: "C:/workspace/src",
        resourceId: "src",
      }],
    };
    const started = await createExploreQueryStartService(host).handle({
      question: "needle",
      paths: ["C:/workspace/src"],
    }, ctx);
    expect(store.get(actor.sessionId, started.queryId)?.paths).toEqual(["src"]);
    store.dispose();
  });

  it("runs a progressive query across two authorized resource roots with same-named files", async () => {
    const store = createExploreQueryStore();
    const rootA = resolve("external-query-a");
    const rootB = resolve("external-query-b");
    const pathA = resolve(rootA, "src");
    const pathB = resolve(rootB, "src");
    const searched: string[] = [];
    const readPaths: string[] = [];
    const host = {
      exploreQueryStore: store,
      searchService: {
        resolveWorkspaceRoot: async (workspaceId: string) => ({ A: rootA, B: rootB })[workspaceId as "A" | "B"] ?? null,
        search: vi.fn(async (_request: unknown, options: { authorizedPaths?: Array<{ workspaceId: string }> }) => {
          const workspaceId = options.authorizedPaths?.[0]?.workspaceId;
          if (!workspaceId) throw new Error("Search lost the authorized resource root");
          searched.push(workspaceId);
          const root = workspaceId === "A" ? rootA : rootB;
          return {
            status: "ready",
            files: [{ path: resolve(root, "src", "same.ts"), hits: [{ line: 1, text: "needle", revision: `${workspaceId}-r1`, before: [], after: [] }] }],
            partial: false,
          };
        }),
      },
      readExploreFile: async (_actor: HarnessActorContext, path: string) => {
        readPaths.push(path);
        return { status: "ready" as const, content: "needle", revision: "read-r1", source: "disk" as const };
      },
    } as unknown as Pick<HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore">;
    const ctx: HarnessServiceContext = {
      ...context({ source: "disk" }),
      authorizedPaths: [
        { authorityId: "test-host", workspaceId: "A", canonicalResourceId: pathA, resolvedPath: pathA, inputPath: pathA, resourceId: "src" },
        { authorityId: "test-host", workspaceId: "B", canonicalResourceId: pathB, resolvedPath: pathB, inputPath: pathB, resourceId: "src" },
      ],
    };
    try {
      const started = await createExploreQueryStartService(host).handle({ question: "needle", paths: [pathA, pathB] }, ctx);
      await createExploreQueryViewsService(host).handle({ queryId: started.queryId }, ctx);
      expect(searched).toContain("A");
      expect(searched).toContain("B");
      expect(readPaths).toContain(resolve(rootA, "src", "same.ts"));
      expect(readPaths).toContain(resolve(rootB, "src", "same.ts"));
    } finally {
      store.dispose();
    }
  });

  it("normalizes path anchors from Router authorization without changing symbol anchors", async () => {
    const store = createExploreQueryStore();
    const host = {
      exploreQueryStore: store,
      searchService: { search: async () => ({ status: "ready", files: [], partial: false }) },
      readExploreFile: async () => ({ status: "ready" as const, content: "", revision: "rev-1", source: "disk" as const }),
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const ctx: HarnessServiceContext = {
      ...context({ source: "disk" }),
      actor: { ...actor, cwd: "/workspace/project-a", authorityRoot: "/workspace" },
      authorizedPaths: [{
        authorityId: "test-host",
        workspaceId: "workspace-1",
        canonicalResourceId: "C:/workspace/project-c/src/target.ts",
        inputPath: "C:/workspace/project-c/src/target.ts",
        resourceId: "project-c/src/target.ts",
      }],
    };
    const started = await createExploreQueryStartService(host).handle({
      question: "where is Target.method",
      anchors: ["C:/workspace/project-c/src/target.ts", "Target.method"],
    }, ctx);
    const stored = store.get(actor.sessionId, started.queryId)!;
    expect(stored.paths).toEqual(["project-a", "project-c/src/target.ts"]);
    expect(stored.run.parsed.usedAnchors).toEqual(["project-c/src/target.ts", "Target.method"]);
    store.dispose();
  });

  it("fails closed before graph recall when the default scope misses the child workspace scope", async () => {
    const store = createExploreQueryStore();
    let graphReads = 0;
    const host = {
      exploreQueryStore: store,
      searchService: { search: async () => ({ status: "ready", files: [], partial: false }) },
      readExploreFile: async () => ({ status: "ready" as const, content: "", revision: "rev-1", source: "disk" as const }),
      graphRecall: async () => {
        graphReads += 1;
        return null;
      },
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const ctx: HarnessServiceContext = {
      ...context({ source: "disk" }),
      actor: { ...actor, cwd: "/workspace/parent/project", authorityRoot: "/workspace", workspaceScope: ["child/project"] },
    };
    await expect(createExploreQueryStartService(host).handle({ question: "NeedleSymbol" }, ctx))
      .rejects.toMatchObject({ harnessCode: "forbidden" });
    expect(graphReads).toBe(0);
    store.dispose();
  });

  it("keeps the start input source when a later stage RPC sends a different window", async () => {
    const seen: AgentInputContext[] = [];
    const store = createExploreQueryStore();
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async (_request: unknown, options: { inputContext?: AgentInputContext }) => {
          if (options.inputContext) seen.push(options.inputContext);
          return {
            status: "ready",
            files: [{ path: "a.ts", hits: [{ line: 1, text: "needle", before: [], after: [] }] }],
            partial: false,
          };
        },
      },
      readExploreFile: async (
        _actor: HarnessActorContext,
        _path: string,
        _signal: AbortSignal,
        inputContext: AgentInputContext,
      ) => {
        seen.push(inputContext);
        return { status: "ready" as const, content: "needle", revision: "rev-1", source: inputContext.source };
      },
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, context(surface));
    expect(started.inputSource).toBe("surface");
    await createExploreQueryViewsService(host).handle(
      { queryId: started.queryId },
      context({ source: "disk" }),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.source === "surface")).toBe(true);
    store.dispose();
  });

  it("rejects a later actor with a new generation and drops queries on session cleanup", async () => {
    const store = createExploreQueryStore();
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async () => ({
          status: "ready",
          files: [{ path: "a.ts", hits: [{ line: 1, text: "needle", before: [], after: [] }] }],
          partial: false,
        }),
      },
      readExploreFile: async () => ({ status: "ready" as const, content: "needle", revision: "rev-1", source: "disk" as const }),
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, context({ source: "disk" }));
    const nextActor = { ...actor, workerGeneration: 2 };
    await expect(createExploreQueryViewsService(host).handle(
      { queryId: started.queryId },
      { ...context({ source: "disk" }), actor: nextActor },
    )).rejects.toMatchObject({ harnessCode: "forbidden" });
    expect(store.get(actor.sessionId, started.queryId)).toBeDefined();
    store.dropSession(actor.sessionId);
    expect(store.get(actor.sessionId, started.queryId)).toBeUndefined();
    store.dispose();
  });

  it("aborts Host search when the bound actor cancels the query", async () => {
    const store = createExploreQueryStore();
    let sawAbort = false;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async (_request: unknown, options: { signal?: AbortSignal }) => {
          resolveEntered();
          await new Promise<void>((_resolve, reject) => {
            const fail = (): void => {
              sawAbort = true;
              reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
            };
            if (options.signal?.aborted) fail();
            else options.signal?.addEventListener("abort", fail, { once: true });
          });
          return { status: "ready", files: [], partial: false };
        },
      },
      readExploreFile: async () => ({ status: "ready" as const, content: "needle", revision: "rev-1", source: "disk" as const }),
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, context({ source: "disk" }));
    await entered;
    const cancelled = await createExploreQueryCancelService(host).handle(
      { queryId: started.queryId },
      context({ source: "disk" }),
    );
    expect(cancelled.cancelled).toBe(true);
    await Promise.resolve();
    expect(sawAbort).toBe(true);
    store.dispose();
  });

  it("releases a started query when its response is not delivered", async () => {
    const store = createExploreQueryStore();
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async () => ({ status: "ready", files: [], partial: false }),
      },
      readExploreFile: async () => ({ status: "ready" as const, content: "needle", revision: "rev-1", source: "disk" as const }),
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    let abortDelivery!: () => void;
    const ctx: HarnessServiceContext = {
      ...context({ source: "disk" }),
      deferResponseDelivery: (_commit, abort) => { abortDelivery = abort; },
    };
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, ctx);
    expect(store.get(actor.sessionId, started.queryId)).toBeDefined();
    abortDelivery();
    expect(store.get(actor.sessionId, started.queryId)).toBeUndefined();
    store.dispose();
  });

  it("uses the actor scope for graph, semantic, vocabulary, and follow-up paths", async () => {
    const store = createExploreQueryStore();
    const workspaceRoot = resolve("explore-scoped-workspace");
    const scopedActor: HarnessActorContext = {
      ...actor,
      authorityRoot: workspaceRoot,
      cwd: workspaceRoot,
      workspaceScope: ["packages/allowed"],
    };
    const readPaths: string[] = [];
    const graphRoots: string[][] = [];
    const semanticRoots: string[][] = [];
    const graph = {
      catalogStats: async () => ({
        symbolCount: 2,
        fileCount: 2,
        paths: ["packages/allowed/src/index.ts", "packages/secret/src/index.ts"],
      }),
      searchSymbols: async (_query: string, _limit: number, roots?: readonly string[]) => {
        graphRoots.push([...(roots ?? [])]);
        return [
          { name: "NeedleSymbol", path: "packages/allowed/src/index.ts", kind: "function", match: "exact", score: 1 },
          { name: "NeedleSymbol", path: "packages/secret/src/index.ts", kind: "function", match: "exact", score: 1 },
        ];
      },
      findLinks: async () => [],
      getFileRelations: async () => null,
      findImporters: async () => ({ resolved: [], unresolved: [] }),
    };
    const semanticHit = (documentId: string, blockId: string) => ({
      documentId,
      blockId,
      parentUnitId: blockId,
      parentName: "NeedleSymbol",
      parentKind: "function",
      startLine: 1,
      endLine: 1,
      contentHash: blockId,
      body: "export function NeedleSymbol() {}",
      similarity: 0.9,
      rank: 1,
    });
    const host = {
      exploreQueryStore: store,
      searchService: {
        search: async () => ({ status: "ready", files: [], partial: false }),
      },
      readExploreFile: async (_actor: HarnessActorContext, path: string) => {
        readPaths.push(path);
        return { status: "ready" as const, content: "export function NeedleSymbol() {}", revision: "rev-1", source: "disk" as const };
      },
      graphRecall: async (_sessionId: string, workspaceId: string) => ({ workspaceId, store: graph, directFactsCompatible: true }),
      semanticRecall: async (
        _workspaceId: string,
        _question: string,
        _limit: number,
        options?: { signal?: AbortSignal; roots?: readonly string[] },
      ) => {
        semanticRoots.push([...(options?.roots ?? [])]);
        return {
          status: "ready" as const,
          coverage: "complete" as const,
          lifecycle: "ready" as const,
          hits: [
            semanticHit("packages/allowed/src/index.ts", "allowed"),
            semanticHit("packages/secret/src/index.ts", "secret"),
          ],
        };
      },
    } as unknown as Pick<
      HarnessServiceHost,
      "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths" | "exploreQueryStore"
    >;
    const scopedContext: HarnessServiceContext = {
      ...context({ source: "disk" }),
      actor: scopedActor,
      workspaceScope: ["packages/allowed"],
    };
    const started = await createExploreQueryStartService(host).handle({ question: "NeedleSymbol" }, scopedContext);
    expect(store.get(actor.sessionId, started.queryId)?.paths).toEqual(["packages/allowed"]);
    expect(started.vocab.catalog).toBeUndefined();
    expect(started.vocab.packages).toEqual(["packages/allowed"]);
    expect(started.vocab.entries).toEqual(["packages/allowed/src/index.ts"]);
    const views = await createExploreQueryViewsService(host).handle({ queryId: started.queryId }, scopedContext);
    const result = store.get(actor.sessionId, started.queryId)!.run.finish();
    expect(readPaths.every(isAbsolute)).toBe(true);
    expect(readPaths.map((path) => relative(workspaceRoot, path).replaceAll("\\", "/")))
      .toContain("packages/allowed/src/index.ts");
    expect(readPaths.every((path) => relative(workspaceRoot, path).replaceAll("\\", "/").startsWith("packages/allowed/"))).toBe(true);
    expect(graphRoots).toEqual([["packages/allowed"]]);
    expect(semanticRoots).toEqual([["packages/allowed"]]);
    expect(JSON.stringify({ started, views, result })).not.toContain("packages/secret");
    store.dispose();
  });

  it("calls the reranker only when model select did not already judge the views", async () => {
    const store = createExploreQueryStore();
    let reserveMs = 0;
    const start = store.start;
    store.start = (request) => { reserveMs = request.reserveForJudgeMs ?? 0; return start(request); };
    const outputStore = createOutputStore();
    const rerankCalls: string[] = [];
    const host = {
      exploreQueryStore: store,
      outputStore,
      searchService: {
        search: async () => ({
          status: "ready",
          files: [{ path: "a.ts", hits: [{ line: 1, text: "needle", before: [], after: [] }] }],
          partial: false,
        }),
      },
      readExploreFile: async () => ({ status: "ready" as const, content: "needle\n", revision: "rev-1", source: "disk" as const }),
      harnessSettings: async () => ({
        global: {
          harness: { rerank: { protocol: "http-rerank", providerId: "rerank-provider", modelId: "rerank-1" } },
        },
        globalRevision: "1",
        project: {},
        projectRevision: "1",
        projectTrusted: true,
      }),
      rerankExploreViews: async (input: { query: string; documents: Array<{ id: string }> }) => {
        rerankCalls.push(input.query);
        return {
          batchId: "rerank-1",
          providerId: "rerank-provider",
          modelId: "rerank-1",
          scores: input.documents.map((document, index) => ({ id: document.id, index, score: 1 - index })),
        };
      },
    } as unknown as Pick<
      HarnessServiceHost,
      "exploreQueryStore" | "outputStore" | "fileRelations" | "rerankExploreViews" | "harnessSettings" | "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths"
    >;
    const finish = createExploreQueryFinishService(host);
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, context({ source: "disk" }));
    expect(reserveMs).toBeGreaterThan(0);
    await createExploreQueryViewsService(host).handle({ queryId: started.queryId }, context({ source: "disk" }));
    const selected = await finish.handle({
      queryId: started.queryId,
      model: { plan: "used", select: "used", followup: "skipped" },
    }, context({ source: "disk" }));
    expect(rerankCalls).toEqual([]);
    expect(selected.details.model?.rerank).toBe("skipped");

    const ranking = await createExploreQueryStartService(host).handle({ question: "needle again" }, context({ source: "disk" }));
    await createExploreQueryViewsService(host).handle({ queryId: ranking.queryId }, context({ source: "disk" }));
    const finishRequest = {
      queryId: ranking.queryId,
      model: { plan: "unconfigured", select: "unconfigured", followup: "unconfigured" } as const,
    };
    const [ranked, concurrent] = await Promise.all([
      finish.handle(finishRequest, context({ source: "disk" })),
      finish.handle(finishRequest, context({ source: "disk" })),
    ]);
    expect(concurrent.text).toBe(ranked.text);
    expect(rerankCalls).toEqual(["needle again"]);
    expect(ranked.details.model?.rerank).toBe("used");
    expect(ranked.details.rerank?.status).toBe("used");
    const repeated = await finish.handle({
      queryId: ranking.queryId,
      model: { plan: "unconfigured", select: "unconfigured", followup: "unconfigured" },
    }, context({ source: "disk" }));
    expect(rerankCalls).toEqual(["needle again"]);
    expect(repeated.text).toBe(ranked.text);

    host.harnessSettings = () => ({
      global: { harness: {
        codeRetrieval: { decision: "llm" },
        rerank: { protocol: "http-rerank", providerId: "rerank-provider", modelId: "rerank-1" },
      } },
      globalRevision: "2", project: {}, projectRevision: "1", projectTrusted: true,
    }) as never;
    const llmOnly = await createExploreQueryStartService(host).handle({ question: "llm only" }, context({ source: "disk" }));
    expect(llmOnly.decisionMode).toBe("llm");
    await createExploreQueryViewsService(host).handle({ queryId: llmOnly.queryId }, context({ source: "disk" }));
    const llmFallback = await finish.handle({ queryId: llmOnly.queryId,
      model: { plan: "unconfigured", select: "unconfigured", followup: "unconfigured" } }, context({ source: "disk" }));
    expect(llmFallback.details.model?.rerank).toBe("disabled");
    expect(rerankCalls).toEqual(["needle again"]);

    host.harnessSettings = () => ({
      global: { harness: {
        codeRetrieval: { decision: "rerank" },
        rerank: { protocol: "http-rerank", providerId: "rerank-provider", modelId: "rerank-1" },
      } },
      globalRevision: "3", project: {}, projectRevision: "1", projectTrusted: true,
    }) as never;
    const rerankOnly = await createExploreQueryStartService(host).handle({ question: "rerank only" }, context({ source: "disk" }));
    expect(rerankOnly.decisionMode).toBe("rerank");
    await createExploreQueryViewsService(host).handle({ queryId: rerankOnly.queryId }, context({ source: "disk" }));
    const explicitlyRanked = await finish.handle({ queryId: rerankOnly.queryId,
      model: { plan: "used", select: "used", followup: "skipped" } }, context({ source: "disk" }));
    expect(explicitlyRanked.details.model?.rerank).toBe("used");
    expect(rerankCalls).toEqual(["needle again", "rerank only"]);

    host.harnessSettings = () => ({
      global: { harness: { rerank: { protocol: "http-rerank", providerId: "missing-model" } } },
      globalRevision: "4", project: {}, projectRevision: "1", projectTrusted: true,
    }) as never;
    const malformed = await createExploreQueryStartService(host).handle({ question: "still readable" }, context({ source: "disk" }));
    await createExploreQueryViewsService(host).handle({ queryId: malformed.queryId }, context({ source: "disk" }));
    const fallback = await finish.handle({
      queryId: malformed.queryId,
      model: { plan: "unconfigured", select: "unconfigured", followup: "unconfigured" },
    }, context({ source: "disk" }));
    expect(fallback.text).toContain("needle");
    expect(fallback.details.model?.rerank).toBe("failed");
    expect(fallback.details.rerank?.status).toBe("failed");
    expect(rerankCalls).toEqual(["needle again", "rerank only"]);
    store.dispose();
  });

  it("runs the fast-decision loop inside the query and reports its provenance instead of reranking", async () => {
    const store = createExploreQueryStore();
    const outputStore = createOutputStore();
    const batches: Array<{ goal: string; questions: string[] }> = [];
    const rerankCalls: string[] = [];
    const host = {
      exploreQueryStore: store,
      outputStore,
      searchService: {
        search: async () => ({
          status: "ready",
          files: [{ path: "a.ts", hits: [{ line: 1, text: "needle", before: [], after: [] }] }],
          partial: false,
        }),
      },
      readExploreFile: async () => ({ status: "ready" as const, content: "needle\n", revision: "rev-1", source: "disk" as const }),
      harnessSettings: async () => ({
        global: {
          harness: { rerank: { protocol: "http-rerank", providerId: "rerank-provider", modelId: "rerank-1" } },
        },
        globalRevision: "1",
        project: {},
        projectRevision: "1",
        projectTrusted: true,
      }),
      rerankExploreViews: async () => {
        rerankCalls.push("called");
        return { batchId: "r1", providerId: "rerank-provider", modelId: "rerank-1", scores: [] };
      },
      fastDecisionStatus: async () => ({
        status: "ready" as const,
        binding: {
          protocol: "pi-classifier" as const,
          providerId: "jev",
          modelId: "jev-1.13",
          configurationId: "cfg-1",
        },
      }),
      fastDecision: async (input: { goal: string; questions: Array<{ id: string }> }) => {
        batches.push({ goal: input.goal, questions: input.questions.map((question) => question.id) });
        return {
          batchId: "fd-1",
          providerId: "jev",
          modelId: "jev-1.13",
          answers: input.questions
            .filter((question) => question.id.startsWith("m:"))
            .map((question) => ({ id: question.id, kind: "judge" as const, value: 0.9 })),
          missing: [],
          usage: { inputTokens: 5 },
        };
      },
    } as unknown as Pick<
      HarnessServiceHost,
      "exploreQueryStore" | "outputStore" | "harnessSettings" | "rerankExploreViews" | "fastDecision" | "fastDecisionStatus" | "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths"
    >;
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, context({ source: "disk" }));
    expect(started.fastDecision?.status).toBe("ready");
    await createExploreQueryViewsService(host).handle({ queryId: started.queryId }, context({ source: "disk" }));
    const finished = await createExploreQueryFinishService(host).handle({
      queryId: started.queryId,
      model: { plan: "unconfigured", select: "unconfigured", followup: "unconfigured" },
    }, context({ source: "disk" }));
    // The loop judged the real material and the same judgment is not
    // re-run through the reranker.
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0]?.goal).toBe("needle");
    expect(batches.some(batch => batch.questions.some(id => id.startsWith("m:")))).toBe(true);
    expect(finished.details.fastDecision?.status).toBe("used");
    expect(finished.details.model?.fastDecision).toBe("used");
    expect(finished.details.model?.rerank).toBe("skipped");
    expect(rerankCalls).toEqual([]);
    store.dispose();
  });

  it("keeps algorithmic retrieval honest when fast decision is unavailable", async () => {
    const store = createExploreQueryStore();
    const outputStore = createOutputStore();
    const decisionCalls: string[] = [];
    const host = {
      exploreQueryStore: store,
      outputStore,
      searchService: {
        search: async () => ({
          status: "ready",
          files: [{ path: "a.ts", hits: [{ line: 1, text: "needle", before: [], after: [] }] }],
          partial: false,
        }),
      },
      readExploreFile: async () => ({ status: "ready" as const, content: "needle\n", revision: "rev-1", source: "disk" as const }),
      fastDecisionStatus: async () => ({ status: "unconfigured" as const }),
      fastDecision: async () => {
        decisionCalls.push("called");
        throw new Error("must not be called");
      },
    } as unknown as Pick<
      HarnessServiceHost,
      "exploreQueryStore" | "outputStore" | "fastDecision" | "fastDecisionStatus" | "searchService" | "readExploreFile" | "structureSource" | "graphRecall" | "semanticRecall" | "agentInputDraftPaths"
    >;
    const started = await createExploreQueryStartService(host).handle({ question: "needle" }, context({ source: "disk" }));
    expect(started.fastDecision?.status).toBe("unconfigured");
    await createExploreQueryViewsService(host).handle({ queryId: started.queryId }, context({ source: "disk" }));
    const finished = await createExploreQueryFinishService(host).handle({
      queryId: started.queryId,
      model: { plan: "unconfigured", select: "unconfigured", followup: "unconfigured" },
    }, context({ source: "disk" }));
    expect(decisionCalls).toEqual([]);
    expect(finished.details.fastDecision).toBeUndefined();
    expect(finished.text).toContain("needle");
    store.dispose();
  });
});
