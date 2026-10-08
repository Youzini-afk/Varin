import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openWorkspaceKnowledge, type KnowledgeStore } from "../knowledge/store.js";
import { executeRelated } from "./related-tool.js";
import { createOutputStore } from "./output-store.js";
import { createRelatedQueryService } from "./related-service.js";
import type { HarnessActorContext } from "@varin/protocol";
import type { HarnessServiceContext } from "./router.js";

const TEST_DIR = join(tmpdir(), "varin-related-tool");
const range = { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5 };

let store: KnowledgeStore;

describe("related tool", () => {
  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "related-host",
      workspaceId: "ws",
      embedding: null,
    });
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("reports none versus incomplete for imports, importers, and connections", async () => {
    await store.replaceFileSymbols("lib/core.ts", "typescript", [
      { name: "core", kind: "function", range },
    ], "disk-r1");
    const none = await executeRelated({ anchor: "lib/core.ts" }, store);
    expect(none.status).toBe("ready");
    expect(none.imports.items).toEqual([]);
    expect(none.imports.unresolved).toEqual([]);
    expect(none.imports.incomplete).toBe(false);
    expect(none.text).toContain("Imports: none");
    expect(none.text).toContain("Imported by: none");
    expect(none.text).toContain("Connections: none");

    await store.replaceFileSymbols("lib/core.ts", "typescript", [
      { name: "core", kind: "function", range },
    ], "disk-r2", [
      { kind: "import", value: "@varin/protocol", line: 1 },
    ], { linksIncomplete: true });
    const incomplete = await executeRelated({ anchor: "lib/core.ts" }, store);
    expect(incomplete.imports.incomplete).toBe(true);
    expect(incomplete.imports.unresolved).toEqual([
      { specifier: "@varin/protocol", path: "lib/core.ts", reason: "non-relative" },
    ]);
    expect(incomplete.text).toContain("[unresolved: non-relative]");
    expect(incomplete.text).toContain("incomplete");
  });

  it("resolves reverse imports and connection other ends for a path", async () => {
    await store.replaceFileSymbols("lib/harness/explore.ts", "typescript", [
      { name: "explore", kind: "function", range },
    ], "disk-r1", [
      { kind: "connects", value: "explore.search", callee: "register", line: 4 },
    ]);
    await store.replaceFileSymbols("lib/harness/explore-service.ts", "typescript", [
      { name: "createExploreSearchService", kind: "function", range },
    ], "disk-r1", [
      { kind: "import", value: "./explore.js", line: 1 },
      { kind: "connects", value: "explore.search", callee: "request", line: 8 },
    ]);
    const byPath = await executeRelated({ anchor: "lib/harness/explore.ts" }, store);
    expect(byPath.definitions).toEqual([
      expect.objectContaining({ name: "explore", path: "lib/harness/explore.ts" }),
    ]);
    expect(byPath.importers.items).toEqual([
      { path: "lib/harness/explore-service.ts", specifier: "./explore.js" },
    ]);
    expect(byPath.connections.items[0]?.otherEnds).toEqual([
      expect.objectContaining({ path: "lib/harness/explore-service.ts", callee: "request" }),
    ]);
    const byName = await executeRelated({ anchor: "explore" }, store);
    expect(byName.anchor.kind).toBe("name");
    expect(byName.definitions[0]?.name).toBe("explore");
    expect(byName.text).not.toContain("rank ");
    await store.replaceFileSymbols('unrelated/other.ts', 'typescript', [], 'disk-r1', [
      { kind: 'connects', value: 'explore.search', callee: 'request', line: 1 },
    ]);
    let full = '';
    const preview = await executeRelated({ anchor: 'lib/harness/explore.ts' }, store, {
      storeOutput: text => { full = text; return 'related-full'; },
    });
    expect(preview.text).toContain('lib/harness/explore-service.ts request');
    expect(preview.text).not.toContain('unrelated/other.ts request');
    expect(preview.text.indexOf('References:')).toBeLessThan(preview.text.indexOf('Shared literals'));
    expect(full).toContain('unrelated/other.ts request');
  });

  it("keeps capped relation lists readable through a session output handle", async () => {
    const many = Array.from({ length: 120 }, (_, index) => ({
      name: `sym${index}`,
      kind: "function",
      range,
    }));
    await store.replaceFileSymbols("lib/hub.ts", "typescript", many, "disk-r1");
    for (let index = 0; index < 60; index += 1) {
      await store.replaceFileSymbols(`lib/consumer-${index}.ts`, "typescript", [
        { name: `consumer${index}`, kind: "function", range },
      ], "disk-r1", [{ kind: "import", value: "./hub.js", line: 1 }]);
    }
    const outputStore = createOutputStore();
    let handle = '';
    const result = await executeRelated({ anchor: "lib/hub.ts" }, store, {
      storeOutput: text => (handle = outputStore.store('session', text, 'related').ref.handle),
    });
    expect(result.definitions).toHaveLength(120);
    expect(result.importers.items).toHaveLength(60);
    expect(result.text).toContain("… 80 more");
    expect(result.text).toContain("… 20 more");
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThan(24 * 1024);
    expect(result.text).toContain(`get_output({handle: "${handle}"})`);
    const full = outputStore.read('session', handle, 0, 100_000);
    expect(full.status).toBe('ready');
    if (full.status === 'ready') {
      for (const symbol of many) expect(full.slice.text).toContain(`lib/hub.ts ${symbol.name} `);
      for (let index = 0; index < 60; index++) expect(full.slice.text).toContain(`lib/consumer-${index}.ts`);
    }
    outputStore.dispose();
  });

  it("walks a bounded number of paths when a name matches many files", async () => {
    for (let index = 0; index < 12; index += 1) {
      await store.replaceFileSymbols(`lib/dup-${index}.ts`, "typescript", [
        { name: "shared", kind: "function", range },
      ], "disk-r1");
    }
    const result = await executeRelated({ anchor: "shared" }, store);
    expect(result.anchor.kind).toBe("name");
    expect(result.definitions).toHaveLength(8);
    expect(result.text).toContain("4 matching files were not examined");
  });

  it("distinguishes an empty catalog from a miss", async () => {
    const empty = await executeRelated({ anchor: "explore" }, store);
    expect(empty.status).toBe("empty");
    expect(empty.text).toContain("no indexed files in this scope");
    await store.replaceFileSymbols("lib/a.ts", "typescript", [
      { name: "alpha", kind: "function", range },
    ], "disk-r1");
    const miss = await executeRelated({ anchor: "nope" }, store);
    expect(miss.status).toBe("empty");
    expect(miss.text).toContain("nothing in the catalog matched");
  });

  it("decorates walked paths with the shared query-time file role and does not persist it", async () => {
    await store.replaceFileSymbols("lib/core.ts", "typescript", [
      { name: "core", kind: "function", range },
    ], "disk-r1");
    await store.replaceFileSymbols("package.json", "json", [
      { name: "name", kind: "property", range },
    ], "disk-r1");
    const source = await executeRelated({ anchor: "lib/core.ts" }, store);
    const manifest = await executeRelated({ anchor: "package.json" }, store);
    expect(source.roles).toEqual([
      { path: "lib/core.ts", role: "source", ground: "filename-pattern" },
    ]);
    expect(manifest.roles).toEqual([
      { path: "package.json", role: "other", ground: "project-declaration" },
    ]);
    expect(source.text).not.toContain("File roles:");
    expect(manifest.text).toContain("package.json other");
    const relations = await store.getFileRelations("lib/core.ts");
    expect(JSON.stringify(relations ?? {})).not.toMatch(/filename-pattern|project-declaration|"role"/);
  });

  it("answers stored resolved references and call edges for a symbol name", async () => {
    await store.replaceFileSymbols("lib/def.ts", "typescript", [
      { name: "uniqueTarget", kind: "function", range },
    ], "disk-d1");
    await store.replaceFileSymbols("lib/caller.ts", "typescript", [
      { name: "runAll", kind: "function", range },
    ], "disk-c1");
    await store.recordResolvedRelations("lib/caller.ts", "typescript", [
      {
        kind: "references",
        value: "uniqueTarget",
        line: 3,
        character: 9,
        caller: "runAll",
        targetPath: "lib/def.ts",
        targetName: "uniqueTarget",
        resolvedBy: "lsp.references",
        siteRevision: "disk-c1",
      },
      {
        kind: "calls",
        value: "uniqueTarget",
        line: 3,
        caller: "runAll",
        targetPath: "lib/def.ts",
        targetName: "uniqueTarget",
        resolvedBy: "lsp.callHierarchy.outgoing",
        siteRevision: "disk-c1",
      },
    ]);

    const byName = await executeRelated({ anchor: "uniqueTarget" }, store);
    expect(byName.references.status).toBe("ready");
    expect(byName.references.items).toEqual([expect.objectContaining({
      path: "lib/caller.ts",
      line: 3,
      caller: "runAll",
      pinned: true,
    })]);
    expect(byName.calls.status).toBe("ready");
    expect(byName.calls.callers).toEqual([expect.objectContaining({
      path: "lib/caller.ts",
      caller: "runAll",
      callee: "uniqueTarget",
      targetPath: "lib/def.ts",
    })]);
    expect(byName.text).toContain("References (resolved");
    expect(byName.text).toContain("lib/caller.ts:3");
    expect(byName.text).toContain("Callers of uniqueTarget");

    // The file's own resolved sites are visible from the path anchor too.
    const byPath = await executeRelated({ anchor: "lib/caller.ts" }, store);
    expect(byPath.references.items.some((item) => item.targetPath === "lib/def.ts")).toBe(true);
    expect(byPath.calls.callees).toEqual([expect.objectContaining({
      callee: "uniqueTarget",
      caller: "runAll",
      targetPath: "lib/def.ts",
    })]);
    // And the target file sees who calls its symbol (filtered by targetPath).
    const defPath = await executeRelated({ anchor: "lib/def.ts" }, store);
    expect(defPath.calls.callers).toEqual([expect.objectContaining({
      path: "lib/caller.ts",
      caller: "runAll",
      callee: "uniqueTarget",
    })]);
  });

  it("reports unavailable relation sections when nothing was resolved and no collector ran", async () => {
    await store.replaceFileSymbols("lib/core.ts", "typescript", [
      { name: "core", kind: "function", range },
    ], "disk-r1");
    const result = await executeRelated({ anchor: "core" }, store);
    expect(result.references.status).toBe("unavailable");
    expect(result.calls.status).toBe("unavailable");
    expect(result.references.items).toEqual([]);
    expect(result.text).toContain("References: unavailable");
    expect(result.text).toContain("Calls: unavailable");
  });

  it("uses the session cwd, then workspaceScope, for duplicate symbol names", async () => {
    for (const project of ["project-a", "project-b", "project-c"]) {
      await store.replaceFileSymbols(`${project}/shared.ts`, "typescript", [
        { name: "shared", kind: "function", range },
      ], `revision-${project}`);
    }
    const service = createRelatedQueryService({
      graphRecall: async () => ({ workspaceId: "ws", store, directFactsCompatible: true }),
      relationCollector: null, outputStore: createOutputStore(),
    });
    const contextFor = (actorFields: Partial<HarnessActorContext> = {}, resourceIds: string[] = []): HarnessServiceContext => {
      const actor: HarnessActorContext = {
        authorityInstanceId: "host",
        sessionId: "session",
        workerId: "worker",
        workerGeneration: 1,
        workspaceId: "ws",
        grantedCapabilities: ["read.search"],
        ...actorFields,
      };
      return {
        actor,
        authorizedPaths: resourceIds.map((resourceId) => ({
          authorityId: "host",
          workspaceId: "ws",
          canonicalResourceId: resourceId,
          inputPath: resourceId,
          resourceId,
        })),
        sessionId: actor.sessionId,
        workspaceId: actor.workspaceId,
        signal: new AbortController().signal,
      };
    };

    const scoped = await service.handle({ anchor: "shared" }, contextFor({
      cwd: "/ws/project-a",
      authorityRoot: "/ws",
      workspaceScope: ["project-a", "project-b", "project-c"],
    }));
    expect(scoped.definitions.map((item) => item.path)).toEqual(["project-a/shared.ts"]);

    const operationDefault = await service.handle({ anchor: "shared" }, contextFor({
      cwd: "/ws/project-b",
      authorityRoot: "/ws",
      workspaceScope: ["project-b", "project-c"],
    }));
    expect(operationDefault.definitions.map((item) => item.path)).toEqual(["project-b/shared.ts"]);

    const workspaceDefault = await service.handle({ anchor: "shared" }, contextFor({
      workspaceScope: ["project-c"],
    }));
    expect(workspaceDefault.definitions.map((item) => item.path)).toEqual(["project-c/shared.ts"]);

    await expect(service.handle({ anchor: "shared" }, contextFor({
      cwd: "/ws/project-b",
      authorityRoot: "/ws",
      workspaceScope: ["project-c"],
    }))).rejects.toMatchObject({ harnessCode: "forbidden" });
  });

  it("uses the Router-authorized resource ID for a path anchor and keeps dotted symbols as names", async () => {
    await store.replaceFileSymbols("project-a/src/repeated.ts", "typescript", [
      { name: "repeated", kind: "function", range },
    ], "disk-r1");
    const service = createRelatedQueryService({
      graphRecall: async () => ({ workspaceId: "ws", store, directFactsCompatible: true }),
      relationCollector: null, outputStore: createOutputStore(),
    });
    const actor: HarnessActorContext = {
      authorityInstanceId: "host",
      sessionId: "session",
      workerId: "worker",
      workerGeneration: 1,
      workspaceId: "ws",
      cwd: "/ws/project-a",
      authorityRoot: "/ws",
      grantedCapabilities: ["read.search"],
    };
    const ctx: HarnessServiceContext = {
      actor,
      authorizedPaths: [{
        authorityId: "host",
        workspaceId: "ws",
        canonicalResourceId: "/workspace/project-a/src/repeated.ts",
        inputPath: "C:/workspace/project-a/src/repeated.ts",
        resourceId: "project-a/src/repeated.ts",
      }],
      sessionId: actor.sessionId,
      workspaceId: actor.workspaceId,
      signal: new AbortController().signal,
    };
    const pathResult = await service.handle({ anchor: "C:/workspace/project-a/src/repeated.ts" }, ctx);
    expect(pathResult.anchor).toEqual({ kind: "path", value: "project-a/src/repeated.ts" });
    expect(pathResult.definitions).toEqual([{ name: "repeated", kind: "function", path: "project-a/src/repeated.ts" }]);

    const dotted = await service.handle({ anchor: "explore.search" }, { ...ctx, authorizedPaths: [] });
    expect(dotted.anchor.kind).toBe("name");
  });

  it("queries an external path against that resource root graph instead of the actor graph", async () => {
    await store.replaceFileSymbols("src/external.ts", "typescript", [
      { name: "externalDefinition", kind: "function", range },
    ], "external-r1");
    const graphRecall = vi.fn(async (_sessionId: string, workspaceId: string) => ({
      workspaceId,
      store,
      directFactsCompatible: true,
    }));
    const service = createRelatedQueryService({ graphRecall, relationCollector: null, outputStore: createOutputStore() });
    const actor: HarnessActorContext = {
      authorityInstanceId: "host", sessionId: "session", workerId: "worker", workerGeneration: 1,
      workspaceId: "actor-workspace", grantedCapabilities: ["read.search"], workspaceScope: ["local"],
    };
    const result = await service.handle({ anchor: "/external/src/external.ts" }, {
      actor,
      workspaceId: actor.workspaceId,
      sessionId: actor.sessionId,
      authorizedPaths: [{
        authorityId: "host",
        workspaceId: "external-workspace",
        canonicalResourceId: "/external/src/external.ts",
        inputPath: "/external/src/external.ts",
        resolvedPath: "/external/src/external.ts",
        resourceId: "src/external.ts",
      }],
      signal: new AbortController().signal,
    });

    expect(graphRecall).toHaveBeenCalledWith("session", "external-workspace");
    expect(result.anchor.value).toBe("src/external.ts");
    expect(result.definitions).toEqual([{ name: "externalDefinition", kind: "function", path: "src/external.ts" }]);
  });

  it("collects resolved relations for a name anchor through the wired collector", async () => {
    await store.replaceFileSymbols("lib/def.ts", "typescript", [
      { name: "uniqueTarget", kind: "function", range },
    ], "disk-d1");
    const collected: Array<{ path: string; line: number; character?: number }> = [];
    const collector = {
      collect: async (_workspaceId: string, anchor: { path: string; line: number; character?: number }) => {
        collected.push(anchor);
        // The real collector persists what it resolved; the fake writes the
        // same rows so the stored-read path below observes them.
        await store.recordResolvedRelations("lib/caller.ts", "typescript", [
          {
            kind: "calls",
            value: "uniqueTarget",
            line: 9,
            caller: "driver",
            targetPath: anchor.path,
            targetName: "uniqueTarget",
            resolvedBy: "lsp.callHierarchy.incoming",
            siteRevision: "disk-x1",
          },
        ]);
        return {
          status: "ready" as const,
          name: "uniqueTarget",
          references: { status: "empty" as const, sites: [] },
          calls: {
            status: "ready" as const,
            callers: [{ path: "lib/caller.ts", line: 9, caller: "driver", callee: "uniqueTarget" }],
            callees: [],
          },
        };
      },
    };
    const result = await executeRelated(
      { anchor: "uniqueTarget" },
      store,
      { workspaceId: "ws", collector },
    );
    expect(collected).toEqual([{ path: "lib/def.ts", line: 1, character: 1 }]);
    expect(result.calls.status).toBe("ready");
    expect(result.calls.callers).toEqual([expect.objectContaining({
      path: "lib/caller.ts",
      caller: "driver",
      callee: "uniqueTarget",
      pinned: true,
    })]);
  });
});
