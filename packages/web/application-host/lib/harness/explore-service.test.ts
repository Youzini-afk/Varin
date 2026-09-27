import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentInputContext, HarnessActorContext, HarnessServiceMap } from "@varin/protocol";
import { createDocumentAuthority } from "../documents/authority.js";
import { createWorkspaceContentSearch } from "../search/content.js";
import { createNativeComputeTestHarness } from "../kernel/compute.test-helper.js";
import { createHarnessPathAuthority } from "./path-authority.js";
import { createExploreFileReader } from "./explore-file-reader.js";
import { createExploreSearchService } from "./explore-service.js";
import { createHarnessServiceHost } from "./service-host.js";
import type { StructureSource } from "../structure/types.js";
import { createHarnessRouter } from "./router.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });

async function fixture(
  scope?: string[],
  structureSource?: StructureSource,
  fileRelations?: NonNullable<import("./service-host.js").HarnessServiceHost["fileRelations"]>,
) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "varin-explore-service-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const documents = createDocumentAuthority({ hostId: "test-host", dataDir: path.join(root, "data"), isAllowedRoot: async () => true, isTrusted: async () => true });
  const { workspaceId } = await documents.resolveWorkspace({ path: workspace });
  const actor: HarnessActorContext = {
    authorityInstanceId: "test-host", sessionId: "test-session", workerId: "worker", workerGeneration: 1,
    workspaceId, grantedCapabilities: ["read.search"], ...(scope ? { workspaceScope: scope } : {}),
  };
  const paths = createHarnessPathAuthority({ authorityId: "test-host", documents });
  const compute = createNativeComputeTestHarness();
  const search = createWorkspaceContentSearch({ documents, pathModule: path, compute });
  const host = createHarnessServiceHost({
    search: (request, options) => search.searchContent(request, options),
    resolveWorkspaceRoot: async (workspaceId) => (await documents.inspectWorkspace(workspaceId)).root,
    discoveredShells: {},
    readExploreFile: createExploreFileReader(documents, paths),
    ...(structureSource ? { structureSource } : {}),
    ...(fileRelations ? { fileRelations } : {}),
  });
  let response: unknown;
  const router = createHarnessRouter({
    resolveActor: async () => actor,
    authorizeWorkspacePath: (current, input, options) => paths.resolve(current, input, options),
    respond: async (_sessionId, _requestId, result) => { response = result; },
  });
  router.register("explore.search", createExploreSearchService(host));
  disposes.push(async () => {
    router.dispose();
    await host.dispose();
    await compute.dispose();
    await documents.dispose();
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root, workspace, actor, host, documents, paths,
    async request(params: HarnessServiceMap["explore.search"]["params"], inputContext?: AgentInputContext) {
      await router.processEvent({
        kind: "host", actor,
        envelope: { kind: "event", event: "harness.request", data: {
          requestId: "request", method: "explore.search", params,
          ...(inputContext ? { inputContext } : {}),
        } },
      });
      return response as { ok: true; result: HarnessServiceMap["explore.search"]["result"] } | { ok: false; error: { code: string; message: string } };
    },
    async capture(resourceId: string, content: string, localEditRevision = 1, sessionId = actor.sessionId) {
      const disk = await documents.read({ workspaceId, resourceId });
      const baseRevision = disk.status === "missing" ? null : disk.revision;
      const resource = { workspaceId, resourceId };
      await documents.publishDirtyBuffers({
        generation: 1,
        ownerId: "surface",
        resources: [{ baseRevision, localEditRevision, resource }],
        workspaceId,
      });
      return documents.captureAgentInputSnapshot({
        generation: 1,
        ownerId: "surface",
        resources: [{ baseRevision, content, localEditRevision, resource }],
        sessionId,
      });
    },
  };
}

describe("explore through Host router, real ripgrep, and Documents", () => {
  it("searches an external root and binds structure requests to that resource identity", async () => {
    const outline = vi.fn(async (request: Parameters<StructureSource["outline"]>[0]) => ({
      status: "unsupported" as const,
      provider: "lsp" as const,
      revision: request.revision,
      symbols: [],
    }));
    const structureSource: StructureSource = {
      outline,
      classifyHits: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, hits: [] }),
      literalCalls: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, calls: [] }),
      imports: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, imports: [] }),
    };
    const f = await fixture(undefined, structureSource);
    const external = path.join(f.root, "external");
    const source = path.join(external, "src");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "outside.ts"), "export function outside() { return 'needle outside'; }\n", "utf8");

    const response = await f.request({ question: "needle", paths: [source] });

    expect(response.ok, JSON.stringify(response)).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.snippets.map((snippet) => snippet.path)).toEqual([await fs.realpath(path.join(source, "outside.ts"))]);
    const externalWorkspace = await f.documents.resolveWorkspace({ path: source });
    expect(outline).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: externalWorkspace.workspaceId,
      path: "outside.ts",
    }));
  });

  it("reads both requested roots, preserves literal metacharacters, and issues a scoped output ref", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.workspace, "first"));
    await fs.mkdir(path.join(f.workspace, "second"));
    await fs.writeFile(path.join(f.workspace, "first", "a.ts"), "header\na.*b\nfirst body\n", "utf8");
    await fs.writeFile(path.join(f.workspace, "second", "b.ts"), "a.*b\nsecond body\n", "utf8");
    await fs.writeFile(path.join(f.workspace, "unselected.ts"), "a.*b\n", "utf8");
    const response = await f.request({ question: '"a.*b"', paths: ["first", "second"] });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const { result } = response;
    expect(result.snippets.map((snippet) => snippet.path).sort()).toEqual(["first/a.ts", "second/b.ts"]);
    expect(result.snippets.find((snippet) => snippet.path === "first/a.ts")).toMatchObject({
      source: "disk",
      startLine: 1,
      text: "header\na.*b\nfirst body\n",
    });
    expect(result.snippets[0]?.revision).toBeTruthy();
    expect(result.handle).toMatch(/^out_/);
    expect(result.details.provenance.length).toBeGreaterThan(0);
    expect(f.host.outputStore.read(f.actor.sessionId, result.handle).status).toBe("ready");
    expect(f.host.outputStore.read("other-session", result.handle).status).not.toBe("ready");
  });

  it("enforces actor scope even without an explicit path", async () => {
    const f = await fixture(["allowed"]);
    await fs.mkdir(path.join(f.workspace, "allowed"));
    await fs.writeFile(path.join(f.workspace, "allowed", "a.ts"), "needle\n");
    await fs.writeFile(path.join(f.workspace, "outside.ts"), "needle\n");
    const response = await f.request({ question: "needle" });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.snippets.map((snippet) => snippet.path)).toEqual(["allowed/a.ts"]);
    expect(await f.request({ question: "needle", paths: ["outside.ts"] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("resolves a parent-relative path as an explicit external resource", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, "outside.ts"), "needle\n");
    const response = await f.request({ question: "needle", paths: [".", "../outside.ts"] });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.snippets.map((snippet) => snippet.path)).toContain(await fs.realpath(path.join(f.root, "outside.ts")));
  });

  it("normalizes session-cwd and absolute path anchors to authorized workspace resource IDs", async () => {
    const f = await fixture();
    const projectA = path.join(f.workspace, "project-a");
    const projectBSource = path.join(f.workspace, "project-b", "src");
    await fs.mkdir(path.join(projectA, "src"), { recursive: true });
    await fs.mkdir(projectBSource, { recursive: true });
    await fs.writeFile(path.join(projectA, "src", "target.ts"), "needle in project a\n", "utf8");
    await fs.writeFile(path.join(projectBSource, "target.ts"), "needle in project b\n", "utf8");

    f.actor.cwd = path.join(f.workspace, "project-a");
    f.actor.authorityRoot = f.workspace;
    f.actor.workspaceScope = ["project-a", "project-b"];
    const relative = await f.request({ question: "needle", anchors: ["src/target.ts"] });
    expect(relative.ok, JSON.stringify(relative)).toBe(true);
    if (!relative.ok) throw new Error(relative.error.message);
    expect(relative.result.details.anchors.used).toEqual(["project-a/src/target.ts"]);
    expect(relative.result.snippets.map((snippet) => snippet.path)).toContain("project-a/src/target.ts");

    const absolute = await f.request({
      question: "needle",
      anchors: [path.join(projectBSource, "target.ts")],
    });
    expect(absolute.ok).toBe(true);
    if (!absolute.ok) throw new Error(absolute.error.message);
    expect(absolute.result.details.anchors.used).toEqual(["project-b/src/target.ts"]);
    expect(absolute.result.snippets.map((snippet) => snippet.path)).toContain("project-b/src/target.ts");

    const symbolic = await f.request({ question: "where is Target.method", anchors: ["Target.method"] });
    expect(symbolic.ok).toBe(true);
    if (!symbolic.ok) throw new Error(symbolic.error.message);
    expect(symbolic.result.details.anchors.used).toEqual(["Target.method"]);
  });

  it("rejects path anchors outside the actor's authorized workspace scope", async () => {
    const f = await fixture(["project-a"]);
    const projectB = path.join(f.workspace, "project-b");
    await fs.mkdir(projectB);
    await fs.writeFile(path.join(projectB, "target.ts"), "needle\n", "utf8");
    const response = await f.request({ question: "needle", anchors: [path.join(projectB, "target.ts")] });
    expect(response).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("cannot read an out-of-scope derived hit", async () => {
    const f = await fixture(["allowed"]);
    await fs.mkdir(path.join(f.workspace, "allowed"));
    await fs.writeFile(path.join(f.workspace, "outside.ts"), "private text\n");
    const read = createExploreFileReader(f.documents, f.paths);
    expect(await read(f.actor, "outside.ts", new AbortController().signal)).toMatchObject({ status: "forbidden" });
  });

  it("Reports missing/binary documents without text fallback", async () => {
    const f = await fixture();
    const read = createExploreFileReader(f.documents, f.paths);
    expect(await read(f.actor, "missing.ts", new AbortController().signal)).toMatchObject({ status: "unavailable" });
    await fs.writeFile(path.join(f.workspace, "binary.bin"), Buffer.from([0, 255, 0, 1]));
    expect(await read(f.actor, "binary.bin", new AbortController().signal)).toMatchObject({ status: "unavailable" });
  });

  it("searches dirty-only text, removes stale disk matches, and reads one fixed draft revision", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "stalediskneedle\nbase\n", "utf8");
    const context = await f.capture("draft.ts", "newdraftneedle\nfirst frozen body\n", 3);

    const draft = await f.request({ question: "newdraftneedle" }, context);
    expect(draft.ok).toBe(true);
    if (!draft.ok) throw new Error(draft.error.message);
    expect(draft.result.snippets).toMatchObject([{
      path: "draft.ts",
      source: "surface-draft",
      text: "newdraftneedle\nfirst frozen body\n",
    }]);
    expect(draft.result.snippets[0]?.revision).toMatch(/^surface-draft:/);

    const deletedFromDraft = await f.request({ question: "stalediskneedle" }, context);
    expect(deletedFromDraft).toMatchObject({ ok: true, result: { snippets: [] } });

    await f.documents.publishDirtyBuffers({
      generation: 1,
      ownerId: "surface",
      resources: [{
        baseRevision: (await f.documents.read({ workspaceId: f.actor.workspaceId!, resourceId: "draft.ts" }) as { revision: string }).revision,
        localEditRevision: 4,
        resource: { workspaceId: f.actor.workspaceId!, resourceId: "draft.ts" },
      }],
      workspaceId: f.actor.workspaceId!,
    });
    const frozen = await f.request({ question: "first frozen body" }, context);
    expect(frozen).toMatchObject({ ok: true, result: { snippets: [{ source: "surface-draft" }] } });
  });

  it("blocks known dirty disk text when the surface source is unavailable", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "dirty.ts"), "mustNotLeakFromDisk\n", "utf8");
    const context: AgentInputContext = {
      source: "surface",
      roots: [{ workspaceId: f.actor.workspaceId!, dirtyPaths: ["dirty.ts"] }],
      snapshot: { status: "unavailable", reason: "surface-unavailable" },
    };
    const response = await f.request({ question: "mustNotLeakFromDisk" }, context);
    expect(response.ok).toBe(false);
    if (response.ok) throw new Error("Expected unavailable source response");
    expect(response.error).toMatchObject({ code: "unavailable" });
    expect(response.error.message).toContain("dirty.ts (unavailable)");
  });

  it("does not project a foreign surface draft onto the actor workspace", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "local.ts"), "needle from disk\n", "utf8");
    const response = await f.request({ question: "needle" }, {
      source: "surface",
      roots: [{ workspaceId: "another-workspace", dirtyPaths: ["local.ts"] }],
      snapshot: { status: "ready", ref: "foreign-surface" },
    });
    expect(response).toMatchObject({ ok: true, result: { snippets: [{ path: "local.ts", source: "disk" }] } });
  });

  it("does not read a ready snapshot owned by another session or outside actor scope", async () => {
    const scoped = await fixture(["allowed"]);
    await fs.mkdir(path.join(scoped.workspace, "allowed"));
    await fs.writeFile(path.join(scoped.workspace, "outside.ts"), "privateDiskNeedle\n", "utf8");
    const otherSession = await scoped.capture(
      "outside.ts",
      "privateDraftNeedle\n",
      1,
      "other-session",
    );
    const response = await scoped.request({ question: "privateDraftNeedle" }, otherSession);
    expect(response).toMatchObject({ ok: true, result: { snippets: [] } });
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.text).not.toContain("privateDraftNeedle");
    expect(JSON.stringify(response.result.snippets)).not.toContain("privateDraftNeedle");

    const inScopeOtherSession = await scoped.capture(
      "allowed/draft.ts",
      "otherSessionNeedle\n",
      1,
      "other-session",
    );
    const unavailable = await scoped.request({ question: "otherSessionNeedle" }, inScopeOtherSession);
    expect(unavailable).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(unavailable)).not.toContain("otherSessionNeedle");
  });

  it("T2: search-service receives actor and inputContext; explore-service has no draft matcher", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "a.ts"), "needle\n", "utf8");
    const calls: Array<{
      params: { pattern?: string; fixedStrings?: boolean; limit?: number };
      ctx: { actor?: unknown; inputContext?: unknown; candidateBudget?: number };
    }> = [];
    const original = f.host.searchService.search.bind(f.host.searchService);
    f.host.searchService.search = async (params, ctx) => {
      calls.push({ params, ctx });
      return original(params, ctx);
    };
    const context = await f.capture("a.ts", "needle\n", 1);
    const response = await f.request({ question: "needle" }, context);
    expect(response.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.ctx).toMatchObject({ actor: f.actor, inputContext: context });
      expect(call.params).toMatchObject({ fixedStrings: true, pattern: "needle" });
      expect(call.params.limit).toBeUndefined();
      expect(call.ctx.candidateBudget).toEqual(expect.any(Number));
    }
    const source = await fs.readFile(path.join(import.meta.dirname, "explore-service.ts"), "utf8");
    expect(source).not.toMatch(/dirtySnapshots/);
    expect(source).not.toMatch(/draftHits/);
  });

  it("T8: stores unread candidates in OutputStore and mentions the handle only when more remains", async () => {
    const f = await fixture();
    const pad = "x".repeat(120);
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      await fs.writeFile(path.join(f.workspace, `f${index}.ts`), `${pad}\nneedle ${index}\n${pad}\n`, "utf8");
    }));
    const response = await f.request({ question: "needle", limit: 2 });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    const stored = f.host.outputStore.read(f.actor.sessionId, response.result.handle);
    expect(stored.status).toBe("ready");
    if (stored.status !== "ready") throw new Error("expected stored explore output");
    expect(stored.slice.text).toMatch(/Unread candidates \(not-requested/);
    expect(response.result.details.provenance.some((entry) => entry.status === "not-requested")).toBe(true);
    expect(Buffer.byteLength(response.result.text, "utf8")).toBeLessThanOrEqual(response.result.details.byteBudget);
    expect(response.result.text).toMatch(/Unread candidates \(not-requested/);
    expect(response.result.text).toContain(response.result.handle);
  });

  it("filters a blank anchor instead of rejecting the call", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "a.ts"), "needle\n", "utf8");
    const response = await f.request({ question: "needle", anchors: ["foo", ""] });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.details.anchors.supplied).toEqual(["foo", ""]);
    expect(response.result.details.anchors.used).toEqual(["foo"]);
    expect(JSON.stringify(response.result)).not.toContain("searchIncomplete");
  });

  it("T8: keeps result.text within the byte budget when the handle hint is shown", async () => {
    const f = await fixture();
    const pad = "x".repeat(5000);
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      await fs.writeFile(path.join(f.workspace, `big${index}.ts`), `needle ${index}\n${pad}\n`, "utf8");
    }));
    const response = await f.request({ question: "needle", limit: 6 });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.text).toContain(`get_output("${response.result.handle}")`);
    expect(Buffer.byteLength(response.result.text, "utf8")).toBeLessThanOrEqual(response.result.details.byteBudget);
  });

  it("does not sum filesDropped across overlapping search roots", async () => {
    const f = await fixture();
    const inner = path.join(f.workspace, "sub", "inner");
    await fs.mkdir(inner, { recursive: true });
    await Promise.all(Array.from({ length: 250 }, async (_, index) => {
      await fs.writeFile(path.join(inner, `f${index}.ts`), "needle\n", "utf8");
    }));
    // Both roots match all 250 files, so each drops 50 against the 200-file candidate budget.
    // Summing would claim 100 distinct files were dropped; only 50 ever were.
    const response = await f.request({ question: "needle", paths: ["sub", "sub/inner"], limit: 2 });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.searched.filesDropped).toBe(50);
    expect(response.result.text).toMatch(/at least 50 matching file\(s\) were not brought into the candidate pool/);
  });

  it("returns a structure unit and source status on the explore.search result", async () => {
    const body = Array.from({ length: 48 }, (_, index) => index === 23 ? "  const needle = 1;" : `  const pad${index} = ${index};`);
    const structureSource: StructureSource = {
      outline: async (request) => ({
        status: "ready",
        provider: "lsp",
        revision: request.revision,
        symbols: [{
          name: "largeTarget",
          kind: "function",
          range: { startLine: 1, endLine: 50 },
          signature: { startLine: 1, endLine: 1 },
        }],
      }),
      classifyHits: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, hits: [] }),
      literalCalls: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, calls: [] }),
      imports: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, imports: [] }),
    };
    const f = await fixture(undefined, structureSource);
    await fs.writeFile(
      path.join(f.workspace, "large.ts"),
      ["export function largeTarget() {", ...body, "}"].join("\n"),
      "utf8",
    );
    const response = await f.request({ question: "needle" });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.snippets[0]).toMatchObject({
      path: "large.ts",
      structure: { provider: "lsp", status: "ready" },
      unit: { name: "largeTarget", kind: "function", startLine: 1, endLine: 50 },
    });
    expect(response.result.snippets[0]?.text).toContain("read large.ts:1-50");
    expect(response.result.details.structure?.files).toEqual([{ path: "large.ts", provider: "lsp", status: "ready" }]);
    expect(response.result.text).toMatch(/structure lsp\/ready/);
  });

  it("attaches graph relations for excerpt paths without expanding the candidate pool", async () => {
    let excerptRevision = "";
    const f = await fixture(undefined, undefined, async (_workspaceId, path) => (
      path === "router.ts"
        ? {
            path: "router.ts",
            documentRevision: excerptRevision,
            incomplete: false,
            imports: [{ specifier: "./protocol", line: 1 }],
            connections: [{ callee: "register", literal: "explore.search", line: 4 }],
            associations: [{ callee: "log", literal: "explore.search", line: 5 }],
          }
        : null
    ));
    await fs.writeFile(
      path.join(f.workspace, "router.ts"),
      "import { x } from \"./protocol\";\nexport function boot() { register(\"explore.search\"); }\n",
      "utf8",
    );
    await fs.writeFile(path.join(f.workspace, "other.ts"), "export const unused = 1;\n", "utf8");
    const disk = await f.documents.read({ workspaceId: f.actor.workspaceId!, resourceId: "router.ts" });
    if (disk.status !== "ready") throw new Error("expected disk text");
    excerptRevision = disk.revision;
    const response = await f.request({ question: "explore.search" });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.details.relations).toEqual({
      status: "ready",
      files: [{
        path: "router.ts",
        documentRevision: excerptRevision,
        stale: false,
        incomplete: false,
        imports: [{ specifier: "./protocol", line: 1 }],
        connections: [{ callee: "register", literal: "explore.search", line: 4 }],
        associations: [{ callee: "log", literal: "explore.search", line: 5 }],
      }],
    });
    expect(response.result.snippets.every((snippet) => snippet.path === "router.ts")).toBe(true);
    expect(response.result.notRequested.paths).not.toContain("other.ts");
    expect(response.result.text).toContain("router.ts connects register(\"explore.search\") (L4)");
    expect(response.result.text).toContain("[candidate]");
    expect(response.result.searched.files).toBe(1);
  });

  it("still returns excerpts when the symbol graph cannot be consulted", async () => {
    const f = await fixture(undefined, undefined, async () => {
      throw new Error("knowledge store is not open for workspace w");
    });
    await fs.writeFile(path.join(f.workspace, "router.ts"), "export function needle() { return 1; }\n", "utf8");
    const response = await f.request({ question: "needle" });
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.snippets.map((snippet) => snippet.path)).toEqual(["router.ts"]);
    expect(response.result.details.relations).toEqual({ status: "unavailable", files: [] });
    expect(response.result.text).toContain("Relations unavailable");
    expect(response.result.text).not.toContain("knowledge store is not open");
  });

  it("marks relations stale when the excerpt comes from a captured draft the graph never saw", async () => {
    const f = await fixture(undefined, undefined, async (_workspaceId, path) => ({
      path,
      documentRevision: "disk-before-the-edit",
      incomplete: false,
      imports: [],
      connections: [{ callee: "register", literal: "explore.search", line: 2 }],
      associations: [],
    }));
    await fs.writeFile(path.join(f.workspace, "router.ts"), "export function boot() {}\n", "utf8");
    const context = await f.capture("router.ts", "export function boot() { register(\"explore.search\"); }\n");
    const response = await f.request({ question: "explore.search" }, context);
    expect(response.ok).toBe(true);
    if (!response.ok) throw new Error(response.error.message);
    expect(response.result.snippets[0]?.source).toBe("surface-draft");
    expect(response.result.details.relations?.files[0]).toMatchObject({ stale: true });
    expect(response.result.text).toContain("stale @disk-before-the-edit");
    expect(response.result.text).not.toContain("(L2)");
  });
});
