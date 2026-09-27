import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHarnessSearchService, type HarnessSearchDeps } from "./search-service.js";
import type { WorkspaceContentSearchOptions, WorkspaceContentSearchResult, WorkspaceSearchHit } from "../search/content.js";
import type { AgentInputContext, HarnessActorContext } from "@varin/protocol";
import type { WorkingBranchQuerySnapshot } from "./working-state/working-branch-query.js";

function makeHit(
  path: string,
  line: number,
  preview: string,
  extra: Pick<WorkspaceSearchHit, "before" | "after" | "revision"> = {},
): WorkspaceSearchHit {
  return { resource: { resourceId: path, workspaceId: "ws-1" }, line, column: 1, preview, ...extra };
}

const nativeLikeSearch = (diskHits: WorkspaceSearchHit[] = []) => vi.fn(async (
  request: Parameters<HarnessSearchDeps["search"]>[0],
  options: WorkspaceContentSearchOptions,
): Promise<WorkspaceContentSearchResult> => {
  const excluded = new Set(request.excludeResourceIds ?? []);
  const overlays = options.overlays ?? [];
  const overlayPaths = new Set(overlays.map((overlay) => overlay.path));
  const hits = diskHits.filter((hit) => !excluded.has(hit.resource.resourceId) && !overlayPaths.has(hit.resource.resourceId));
  const flags = request.ignoreCase ? "i" : "";
  let matcher: RegExp;
  try {
    matcher = request.fixedStrings
      ? new RegExp(String(request.query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags)
      : new RegExp(String(request.query), flags);
  } catch {
    return { status: "failure", generation: options.generation, message: "invalid regex" };
  }
  const normalized = (value: string) => value.replace(/\\/g, "/");
  const glob = request.glob ?? [];
  const positives = glob.filter((item) => !item.startsWith("!"));
  const negatives = glob.filter((item) => item.startsWith("!")).map((item) => item.slice(1));
  const globMatch = (pattern: string, resourceId: string) => {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "__DOUBLE_STAR__")
      .replace(/\*/g, "[^/]*")
      .replace(/__DOUBLE_STAR__/g, ".*");
    return new RegExp(`^${escaped}$`, process.platform === "win32" ? "i" : "").test(resourceId);
  };
  const allowedByGlob = (resourceId: string) => (
    (positives.length === 0 || positives.some((pattern) => globMatch(pattern, resourceId)))
    && !negatives.some((pattern) => globMatch(pattern, resourceId))
  );
  for (const overlay of overlays) {
    if (overlay.missing || !overlay.text || !allowedByGlob(normalized(overlay.path))) continue;
    const lines = overlay.text.split(/\r\n|\n|\r/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      matcher.lastIndex = 0;
      const match = matcher.exec(line);
      if (!match) continue;
      const before = Math.max(0, request.before ?? 0);
      const after = Math.max(0, request.after ?? 0);
      hits.push({
        resource: { workspaceId: request.workspaceId, resourceId: overlay.path },
        line: index + 1,
        column: (match.index ?? 0) + 1,
        preview: line,
        revision: overlay.revision,
        before: lines.slice(Math.max(0, index - before), index),
        after: lines.slice(index + 1, index + 1 + after),
      });
    }
  }
  const limited = request.maxResults === undefined ? hits : hits.slice(0, request.maxResults);
  return limited.length
    ? { status: "ready", generation: options.generation, hits: limited, ...(limited.length < hits.length ? { incomplete: true as const } : {}) }
    : { status: "empty", generation: options.generation };
});

const actor: HarnessActorContext = {
  authorityInstanceId: "authority-1",
  sessionId: "session-1",
  workerId: "worker-1",
  workerGeneration: 1,
  workspaceId: "ws-1",
  grantedCapabilities: ["read.search"],
};

const surface = (dirtyPaths: string[], ref = "snapshot-1"): AgentInputContext => ({
  source: "surface",
  roots: [{ workspaceId: "ws-1", dirtyPaths }],
  snapshot: { status: "ready", ref },
});

const searchContext = (inputContext: AgentInputContext, workspaceScope?: readonly string[]) => ({
  actor,
  inputContext,
  ...(workspaceScope ? { workspaceScope } : {}),
  workspaceId: "ws-1",
  signal: new AbortController().signal,
});

describe("harness search service", () => {
  it("returns empty when search finds nothing", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "empty", generation: 1 }));
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "nonexistent" },
      { workspaceId: "ws-1", signal: new AbortController().signal },
    );
    expect(result.status).toBe("empty");
    expect(result.files).toEqual([]);
  });

  it("does not turn an empty surface pattern into a match-all regex", async () => {
    const search = vi.fn();
    const readFile = vi.fn();
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "   " }, searchContext(surface(["draft.ts"])));

    expect(result.status).toBe("empty");
    expect(search).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("does not project a foreign-root draft onto an actor root with the same path", async () => {
    const search = nativeLikeSearch([makeHit("outside.ts", 1, "secret disk content", { revision: "disk:1" })]);
    const readFile = vi.fn(async () => ({ status: "ready" as const, content: "secret disk content", revision: "disk:1", source: "disk" as const }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });
    const inputContext: AgentInputContext = {
      source: "surface",
      roots: [{ workspaceId: "other-workspace", dirtyPaths: ["outside.ts"] }],
      snapshot: { status: "ready", ref: "other" },
    };

    const result = await service.search({ pattern: "secret", path: "." }, searchContext(inputContext));

    expect(result.status).toBe("ready");
    expect(result.files[0]?.hits[0]).toMatchObject({ text: "secret disk content", revision: "disk:1" });
    expect((search.mock.calls[0]?.[1].overlays ?? [])).toEqual([]);
  });

  it("returns unavailable when search fails", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "failure", generation: 1, message: "rg not found" }));
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "test" },
      { workspaceId: "ws-1", signal: new AbortController().signal },
    );
    expect(result.status).toBe("unavailable");
  });

  it("groups hits by file and sorts by line number", async () => {
    const hits: WorkspaceSearchHit[] = [
      makeHit("src/b.ts", 30, "line 30"),
      makeHit("src/a.ts", 10, "line 10"),
      makeHit("src/a.ts", 5, "line 5"),
      makeHit("src/b.ts", 15, "line 15"),
    ];
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "ready", generation: 1, hits }));
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "line" },
      { workspaceId: "ws-1", signal: new AbortController().signal },
    );
    expect(result.status).toBe("ready");
    expect(result.totalHits).toBe(4);
    expect(result.totalFiles).toBe(2);
    // Check that hits within each file are sorted by line number
    for (const file of result.files) {
      for (let i = 1; i < file.hits.length; i++) {
        expect(file.hits[i]!.line).toBeGreaterThan(file.hits[i - 1]!.line);
      }
    }
  });

  it("applies limit and sets partial flag", async () => {
    const hits: WorkspaceSearchHit[] = [];
    for (let i = 0; i < 150; i++) {
      hits.push(makeHit(`file${i}.ts`, 1, `hit ${i}`));
    }
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "ready", generation: 1, hits }));
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "hit", limit: 10 },
      { workspaceId: "ws-1", signal: new AbortController().signal },
    );
    expect(result.status).toBe("ready");
    expect(result.partial).toBe(true);
    expect(result.totalHits).toBe(150);
    // Limited files
    const totalHitsInFiles = result.files.reduce((sum, f) => sum + f.hits.length, 0);
    expect(totalHitsInFiles).toBeLessThanOrEqual(10);
  });

  it("returns unavailable when workspaceId is null", async () => {
    const search = vi.fn();
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "test" },
      { workspaceId: null, signal: new AbortController().signal },
    );
    expect(result.status).toBe("unavailable");
    expect(search).not.toHaveBeenCalled();
  });

  it("sorts files deterministically (same input → same order)", async () => {
    const hits: WorkspaceSearchHit[] = [
      makeHit("src/z.ts", 1, "z"),
      makeHit("src/a.ts", 1, "a"),
      makeHit("src/m.ts", 1, "m"),
    ];
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "ready", generation: 1, hits }));
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result1 = await service.search({ pattern: "test" }, { workspaceId: "ws-1", signal: new AbortController().signal });
    const result2 = await service.search({ pattern: "test" }, { workspaceId: "ws-1", signal: new AbortController().signal });
    expect(result1.files.map((f) => f.path)).toEqual(result2.files.map((f) => f.path));
  });

  it("replaces dirty disk hits with the fixed editor snapshot and keeps draft-only hits", async () => {
    const search = nativeLikeSearch([makeHit("draft.ts", 1, "old disk value")]);
    const readFile = vi.fn(async (_actor, filePath: string) => {
      if (path.basename(filePath) !== "draft.ts") throw new Error(`unexpected read ${filePath}`);
      return { status: "ready" as const, content: "new draft value\r\nsecond\rthird", revision: "surface-draft:1", source: "surface-draft" as const };
    });
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "draft", limit: 10 }, searchContext(surface(["draft.ts"])));

    expect(result.status).toBe("ready");
    expect(result.totalHits).toBe(1);
    expect(result.files.flatMap((file) => file.hits.map((hit) => [file.path, hit.line, hit.text]))).toEqual([
      ["draft.ts", 1, "new draft value"],
    ]);
    expect(readFile).toHaveBeenCalledWith(actor, path.resolve("/workspace", "draft.ts"), expect.any(AbortSignal), surface(["draft.ts"]));
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "draft" }), expect.anything());
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({
      maxResults: 30,
    });
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).not.toHaveProperty("excludeResourceIds");
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>, WorkspaceContentSearchOptions]>)[0]?.[1].overlays)
      .toEqual([expect.objectContaining({ path: "draft.ts", revision: "surface-draft:1", text: expect.stringContaining("new draft value") })]);
  });

  it("searches a written path on disk again instead of hiding it behind the older draft", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("draft.ts", 3, "value the agent just wrote", { revision: "disk:2" })],
    }));
    const readFile = vi.fn(async () => ({ status: "ready" as const, content: "value the agent just wrote", revision: "disk:2", source: "disk" as const }));
    // The turn's fixed source no longer owns draft.ts: it was written since the
    // capture, so disk holds the newer text (D-088).
    const draftPaths = vi.fn(() => [] as readonly string[]);
    const service = createHarnessSearchService({
      search,
      readFile,
      draftPaths,
      resolveWorkspaceRoot: async () => "/workspace",
    });

    const result = await service.search({ pattern: "value" }, searchContext(surface(["draft.ts"])));

    expect(result).toMatchObject({ status: "ready", totalHits: 1 });
    expect(result.files[0]?.hits[0]?.text).toBe("value the agent just wrote");
    expect(result.files[0]?.hits[0]?.revision).toBe("disk:2");
    expect(readFile).toHaveBeenCalledOnce();
    expect(draftPaths).toHaveBeenCalledWith(actor.sessionId, surface(["draft.ts"]), "ws-1");
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0].excludeResourceIds).toBeUndefined();
  });

  it("matches draft lines with regex semantics and reports CRLF, LF, and CR line numbers", async () => {
    const search = nativeLikeSearch();
    const readFile = vi.fn(async () => ({
      status: "ready" as const,
      content: "one\r\ntwo-2\nthree-3\rfour-4",
      revision: "surface-draft:1",
      source: "surface-draft" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "(two|four)-\\d" }, searchContext(surface(["draft.ts"])));

    expect(result).toMatchObject({ status: "ready", totalHits: 2, totalFiles: 1, partial: false });
    expect(result.files[0]?.hits).toEqual([
      { line: 2, text: "two-2", before: [], after: [], revision: "surface-draft:1" },
      { line: 4, text: "four-4", before: [], after: [], revision: "surface-draft:1" },
    ]);
  });

  it("uses literal and case-insensitive draft matching when requested", async () => {
    const search = nativeLikeSearch();
    const readFile = vi.fn(async () => ({
      status: "ready" as const,
      content: "value [A-Z]\nVALUE a-z",
      revision: "surface-draft:1",
      source: "surface-draft" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search(
      { pattern: "value [A-Z]", fixedStrings: true, ignoreCase: true },
      searchContext(surface(["draft.ts"])),
    );

    expect(result).toMatchObject({ status: "ready", totalHits: 1 });
    expect(result.files[0]?.hits[0]?.text).toBe("value [A-Z]");
  });

  it("does not leak a dirty path when its fixed snapshot is unavailable", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("draft.ts", 1, "private disk value")],
    }));
    const readFile = vi.fn(async () => ({ status: "unavailable" as const, message: "snapshot expired" }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "private" }, searchContext(surface(["draft.ts"])));

    expect(result).toMatchObject({ status: "unavailable", totalHits: 0, totalFiles: 0 });
    expect(search).not.toHaveBeenCalled();
  });

  it("reads and excludes only dirty paths inside both the actor scope and requested path", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [
        makeHit("packages/app/src/inside.ts", 1, "disk inside", { revision: "surface-draft:1" }),
        makeHit("packages/app/test/outside-request.ts", 1, "disk outside request"),
        makeHit("packages/other/src/outside-scope.ts", 1, "disk outside scope"),
      ],
    }));
    const readFile = vi.fn(async (_actor, filePath: string) => ({
      status: "ready" as const,
      content: path.basename(filePath) === "inside.ts" ? "draft inside" : "wrong dirty path",
      revision: "surface-draft:1",
      source: "surface-draft" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });
    const context = searchContext(
      surface([
        "packages/app/src/inside.ts",
        "packages/app/test/outside-request.ts",
        "packages/other/src/outside-scope.ts",
      ]),
      ["packages/app"],
    );

    const result = await service.search({ pattern: "inside", path: "packages/app/src" }, context);

    expect(result).toMatchObject({ status: "ready", totalHits: 1, totalFiles: 1 });
    expect(result.files[0]?.path).toBe("packages/app/src/inside.ts");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith(actor, path.resolve("/workspace", "packages/app/src/inside.ts"), expect.any(AbortSignal), context.inputContext);
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({ paths: ["packages/app/src"] });
  });

  it("applies include and exclude globs to both disk and draft hits", async () => {
    const search = nativeLikeSearch([
      makeHit("src/a.ts", 1, "match"),
      makeHit("src/a.test.ts", 1, "test match"),
      makeHit("src/a.js", 1, "js match"),
    ]);
    const readFile = vi.fn(async (_actor, filePath: string) => ({
      status: "ready" as const,
      content: path.basename(filePath) === "a.ts" ? "match" : "test match",
      revision: "surface-draft:1",
      source: "surface-draft" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({
      pattern: "match",
      glob: ["!**/*.test.ts", "**/*.ts"],
    }, searchContext(surface(["src/a.ts", "src/a.test.ts"])));

    expect(result).toMatchObject({ status: "ready", totalHits: 1, totalFiles: 1 });
    expect(result.files[0]?.path).toBe("src/a.ts");
    expect(readFile).toHaveBeenCalledTimes(1);
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({
      glob: ["**/*.ts", "!**/*.test.ts"],
    });
  });

  it("returns real neighboring lines for content context in disk and draft files", async () => {
    const search = nativeLikeSearch([
      makeHit("disk.ts", 2, "disk match", { before: ["disk before"], after: ["disk after"], revision: "disk:1" }),
    ]);
    const readFile = vi.fn(async (_actor, filePath: string) => ({
      status: "ready" as const,
      content: path.basename(filePath) === "draft.ts" ? "draft before\ndraft match\ndraft after" : "disk before\ndisk match\ndisk after",
      revision: path.basename(filePath) === "draft.ts" ? "surface-draft:1" : "disk:1",
      source: path.basename(filePath) === "draft.ts" ? "surface-draft" as const : "disk" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "match", context: 1 }, searchContext(surface(["draft.ts"])));

    expect(result).toMatchObject({ status: "ready", totalHits: 2, totalFiles: 2 });
    const hitsByPath = new Map(result.files.map((file) => [file.path, file.hits[0]]));
    expect(hitsByPath.get("draft.ts")).toMatchObject({ before: ["draft before"], after: ["draft after"] });
    expect(hitsByPath.get("disk.ts")).toMatchObject({ before: ["disk before"], after: ["disk after"] });
  });

  it("computes context independently for multiple hits in one disk file", async () => {
    const search = nativeLikeSearch([
      makeHit("disk.ts", 2, "first match", { before: ["before first"], after: ["after first"], revision: "disk:1" }),
      makeHit("disk.ts", 5, "second match", { before: ["before second"], after: ["after second"], revision: "disk:1" }),
    ]);
    const readFile = vi.fn(async () => ({
      status: "ready" as const,
      content: "before first\nfirst match\nafter first\nbefore second\nsecond match\nafter second",
      revision: "disk:1",
      source: "disk" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "match", context: 1 }, {
      actor,
      workspaceId: "ws-1",
      signal: new AbortController().signal,
    });

    expect(result.files[0]?.hits).toEqual([
      { line: 2, text: "first match", before: ["before first"], after: ["after first"], revision: "disk:1" },
      { line: 5, text: "second match", before: ["before second"], after: ["after second"], revision: "disk:1" },
    ]);
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("drops a native hit when its source revision changed before current content was read", async () => {
    const search = nativeLikeSearch([
      makeHit("disk.ts", 2, "matched old revision", { before: ["old before"], after: ["old after"], revision: "disk:1" }),
    ]);
    const readFile = vi.fn(async () => ({
      status: "ready" as const,
      content: "new before\nchanged after search\nnew after",
      revision: "disk:2",
      source: "disk" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "matched", context: 1 }, {
      actor,
      workspaceId: "ws-1",
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ status: "empty", totalHits: 0, partial: true });
    expect(result.files).toEqual([]);
    expect(readFile).toHaveBeenCalledWith(actor, path.resolve("/workspace", "disk.ts"), expect.any(AbortSignal), { source: "disk" });
  });

  it("merges all disk and draft hits before sorting and applying the limit", async () => {
    const search = nativeLikeSearch([makeHit("z-disk.ts", 1, "match", { revision: "disk:1" })]);
    const readFile = vi.fn(async (_actor, filePath: string) => ({
      status: "ready" as const,
      content: "match",
      revision: path.basename(filePath) === "a-draft.ts" ? "surface-draft:1" : "disk:1",
      source: path.basename(filePath) === "a-draft.ts" ? "surface-draft" as const : "disk" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "match", path: ".", limit: 1 }, searchContext(surface(["a-draft.ts"])));

    expect(result).toMatchObject({ status: "ready", totalHits: 2, totalFiles: 2, partial: true });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("a-draft.ts");
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({
      maxResults: 3,
    });
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>, WorkspaceContentSearchOptions]>)[0]?.[1].overlays)
      .toEqual([expect.objectContaining({ path: "a-draft.ts" })]);
  });

  it("keeps the disk over-fetch bounded while excluding dirty hits before the cap", async () => {
    const search = nativeLikeSearch([
      ...Array.from({ length: 12 }, (_, index) => makeHit("dirty.ts", index + 1, "old disk match", { revision: "disk:1" })),
      ...Array.from({ length: 6 }, (_, index) => makeHit(`disk-${index}.ts`, 1, "disk match", { revision: "disk:1" })),
    ]);
    const readFile = vi.fn(async (_actor, filePath: string) => ({
      status: "ready" as const,
      content: "draft match",
      revision: path.basename(filePath) === "dirty.ts" ? "surface-draft:1" : "disk:1",
      source: path.basename(filePath) === "dirty.ts" ? "surface-draft" as const : "disk" as const,
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "match", limit: 2 }, searchContext(surface(["dirty.ts"])));

    expect(result.status).toBe("ready");
    expect(result.files.flatMap((file) => file.hits).every((hit) => hit.text !== "old disk match")).toBe(true);
    expect(result.totalHits).toBe(6);
    expect(result.partial).toBe(true);
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]).toMatchObject({
      maxResults: 6,
    });
  });

  it("preserves disk search behavior when no surface context is supplied", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({
      status: "ready",
      generation: 1,
      hits: [makeHit("disk.ts", 1, "disk match")],
    }));
    const readFile = vi.fn();
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });

    const result = await service.search({ pattern: "match", limit: 2 }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("ready");
    expect(result.files[0]?.path).toBe("disk.ts");
    expect(readFile).not.toHaveBeenCalled();
    expect(search).toHaveBeenCalledWith({ query: "match", workspaceId: "ws-1", maxResults: 6, before: 0, after: 0 }, expect.anything());
  });

  it("propagates abort while reading a surface snapshot", async () => {
    const parent = new AbortController();
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "empty", generation: 1 }));
    const readFile = vi.fn((_actor, _path, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const service = createHarnessSearchService({ search, readFile, resolveWorkspaceRoot: async () => "/workspace" });
    const pending = service.search({ pattern: "match" }, {
      ...searchContext(surface(["draft.ts"])),
      signal: parent.signal,
    });
    parent.abort();

    await expect(pending).resolves.toMatchObject({ status: "empty", partial: true });
    expect(search).not.toHaveBeenCalled();
  });

  it("returns only hits inside both the child scope and requested path", async () => {
    const hits = [
      makeHit("packages/web/src/a.ts", 1, "allowed"),
      makeHit("packages/web/test/a.test.ts", 1, "outside request"),
      makeHit("packages/ui/src/a.ts", 1, "outside child scope"),
      makeHit("packages/web/../ui/src/traversal.ts", 1, "scope-looking traversal"),
    ];
    let searchPaths: string[] | undefined;
    const service = createHarnessSearchService({
      search: async (request) => {
        searchPaths = request.paths;
        return { status: "ready", generation: 1, hits };
      },
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "a", path: "packages/web/src" },
      {
        workspaceId: "ws-1",
        workspaceScope: ["packages/web"],
        signal: new AbortController().signal,
      },
    );
    expect(result.status).toBe("ready");
    expect(result.files.map((file) => file.path)).toEqual(["packages/web/src/a.ts"]);
    expect(searchPaths).toEqual(["packages/web/src"]);
  });

  it("explore candidate mode keeps every matching file by breadth-first budget, including the last path", async () => {
    const files = Array.from({ length: 30 }, (_, index) => `dir${String(index).padStart(2, "0")}/file.ts`);
    const hits: WorkspaceSearchHit[] = files.flatMap((path) => (
      Array.from({ length: 12 }, (_, index) => makeHit(path, index + 1, `token ${index}`))
    ));
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "ready", generation: 1, hits }));
    const service = createHarnessSearchService({ search, resolveWorkspaceRoot: async () => "/workspace" });

    const exploreMode = await service.search({ pattern: "token" }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
      candidateBudget: 200,
      hitsPerFile: 12,
    });
    expect(exploreMode.status).toBe("ready");
    expect(exploreMode.files).toHaveLength(30);
    expect(exploreMode.files.reduce((sum, file) => sum + file.hits.length, 0)).toBeLessThanOrEqual(200);
    expect(exploreMode.files.at(-1)?.path).toBe("dir29/file.ts");
    expect(exploreMode.filesDropped).toBe(0);
    expect(exploreMode.partial).toBe(true);
    expect(exploreMode.fileCoverage).toBe("complete");

    const grepMode = await service.search({ pattern: "token" }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
    });
    expect(grepMode.files).toHaveLength(9);
    expect(grepMode.files[0]?.path).toBe("dir00/file.ts");
    expect(grepMode.files.at(-1)?.path).toBe("dir08/file.ts");
    expect(grepMode.files.at(-1)?.hits).toHaveLength(4);
    expect(grepMode.files.flatMap((file) => file.hits)).toHaveLength(100);
    expect(grepMode.partial).toBe(true);
    expect(grepMode.filesDropped).toBeUndefined();
    expect(grepMode.files.map((file) => file.path)).not.toContain("dir29/file.ts");
  });

  it("explore candidate mode reports filesDropped when matching files exceed the budget", async () => {
    const files = Array.from({ length: 5 }, (_, index) => `z${index}.ts`);
    const hits = files.map((path) => makeHit(path, 1, "token"));
    const service = createHarnessSearchService({
      search: async () => ({ status: "ready", generation: 1, hits }),
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search({ pattern: "token" }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
      candidateBudget: 3,
      hitsPerFile: 12,
    });
    expect(result.files.map((file) => file.path)).toEqual(["z0.ts", "z1.ts", "z2.ts"]);
    expect(result.files.every((file) => file.hits.length === 1)).toBe(true);
    expect(result.filesDropped).toBe(2);
    expect(result.partial).toBe(true);
    expect(result.fileCoverage).toBe("lower-bound");
    expect(result.totalFiles).toBe(5);
  });

  it("explore candidate mode keeps a second file after a flood of hits and does not use grep fileScore order", async () => {
    const hits: WorkspaceSearchHit[] = [
      ...Array.from({ length: 50 }, (_, index) => makeHit("flood.ts", index + 1, `token ${index}`)),
      makeHit("key.ts", 1, "uniqueAnchor"),
    ];
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "ready", generation: 1, hits }));
    const service = createHarnessSearchService({ search, resolveWorkspaceRoot: async () => "/workspace" });

    const exploreMode = await service.search({ pattern: "token" }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
      candidateBudget: 80,
      hitsPerFile: 12,
    });
    expect(exploreMode.status).toBe("ready");
    expect(exploreMode.files.map((file) => file.path).sort()).toEqual(["flood.ts", "key.ts"]);
    expect(exploreMode.files.find((file) => file.path === "flood.ts")?.hits).toHaveLength(12);
    expect(exploreMode.partial).toBe(true);

    const grepMode = await service.search({ pattern: "token", limit: 1 }, {
      workspaceId: "ws-1",
      signal: new AbortController().signal,
    });
    expect(grepMode.files).toHaveLength(1);
    expect(grepMode.files[0]?.path).toBe("flood.ts");
    expect((search.mock.calls as unknown as Array<[Record<string, unknown>]>)[1]?.[0]).toMatchObject({ maxResults: 3 });
  });

  it("returns empty without launching search when the requested path and child scope are disjoint", async () => {
    let called = false;
    const service = createHarnessSearchService({
      search: async () => {
        called = true;
        return { status: "empty", generation: 1 };
      },
      resolveWorkspaceRoot: async () => "/workspace",
    });
    const result = await service.search(
      { pattern: "a", path: "packages/ui" },
      {
        workspaceId: "ws-1",
        workspaceScope: ["packages/web"],
        signal: new AbortController().signal,
      },
    );
    expect(result.status).toBe("empty");
    expect(called).toBe(false);
  });

  it("searches a bound working-branch query without calling the disk backend", async () => {
    const search = vi.fn(async (): Promise<WorkspaceContentSearchResult> => {
      throw new Error("disk search must not run");
    });
    const documents = [
      { path: "kept.txt", text: "fixed kept\nparent must not match" },
      { path: "src/nested.ts", text: "nested baseline\n" },
    ];
    const pinned: WorkingBranchQuerySnapshot = {
      sessionId: "session-1",
      workspaceId: "ws-1",
      branchId: "branch-1",
      writeRevision: 2,
      revision: 1,
      root: "root-1",
      pinId: "pin-1",
      async search(request) {
        const query = request.query ?? "";
        const hits = documents.flatMap((document) => document.text.includes(query)
          ? [makeHit(document.path, 1, document.text.split("\n").find((line) => line.includes(query)) ?? query)]
          : []);
        return hits.length ? { status: "ready", generation: 1, hits } : { status: "empty", generation: 1 };
      },
      async compute() {
        throw new Error("raw fixed-view compute is not used by this search test");
      },
      async listFiles() {
        return documents.map((document) => ({ path: document.path, revision: "root-1" }));
      },
      async readFile(resourceId) {
        const document = documents.find((item) => item.path === resourceId);
        return document
          ? { status: "ready", content: document.text, revision: "root-1", source: "working-branch" }
          : { status: "unavailable", message: "missing" };
      },
      release: vi.fn(async () => undefined),
    };
    const service = createHarnessSearchService({
      search,
      resolveWorkspaceRoot: async () => "/workspace",
      pinWorkingBranchQuery: async () => pinned,
    });
    const hit = await service.search({ pattern: "fixed kept" }, searchContext({ source: "disk" }));
    expect(hit).toMatchObject({ status: "ready", totalHits: 1, files: [{ path: "kept.txt" }] });
    const missed = await service.search({ pattern: "parent live" }, searchContext({ source: "disk" }));
    expect(missed.status).toBe("empty");
    expect(search).not.toHaveBeenCalled();
    expect(pinned.release).toHaveBeenCalledTimes(2);
  });

  describe("RR4 retrieval scope and honest coverage", () => {
    /** Records the requested scope and filters hits by path prefix. */
    const scopedSearch = (hits: WorkspaceSearchHit[], seen: string[][]) => vi.fn(async (
      request: Parameters<HarnessSearchDeps["search"]>[0],
      options: WorkspaceContentSearchOptions,
    ): Promise<WorkspaceContentSearchResult> => {
      const paths = request.paths ?? [];
      seen.push([...paths]);
      const within = (file: string, prefix: string) => !prefix || file === prefix || file.startsWith(`${prefix}/`);
      const scoped = paths.length === 0 ? hits : hits.filter((hit) => paths.some((prefix) => within(hit.resource.resourceId, prefix)));
      return scoped.length
        ? { status: "ready", generation: options.generation, hits: scoped, scannedFiles: 7 }
        : { status: "empty", generation: options.generation, scannedFiles: 7 };
    });
    const rr4Actor = (extra: Partial<HarnessActorContext> = {}): HarnessActorContext => ({ ...actor, ...extra });
    const rr4Ctx = (extra: Partial<HarnessActorContext> = {}, authorizedPaths?: ReadonlyArray<{ workspaceId: string; resourceId: string }>) => ({
      actor: rr4Actor(extra),
      workspaceId: "ws-1",
      signal: new AbortController().signal,
      ...(authorizedPaths ? { authorizedPaths } : {}),
    });

    it("defaults to the session cwd when no explicit path is given", async () => {
      const seen: string[][] = [];
      const service = createHarnessSearchService({
        search: scopedSearch([makeHit("app/hit.ts", 1, "x"), makeHit("other/hit.ts", 1, "x")], seen),
        resolveWorkspaceRoot: async () => "/workspace",
      });
      const result = await service.search({ pattern: "x" }, rr4Ctx({ cwd: "/workspace/app" }));
      expect(result.status).toBe("ready");
      expect(seen).toEqual([["app"]]);
      expect(result.files.map((file) => file.path)).toEqual(["app/hit.ts"]);
    });

    it("uses authorized resource ids for explicit multi-path queries", async () => {
      const seen: string[][] = [];
      const service = createHarnessSearchService({
        search: scopedSearch([makeHit("a/x.ts", 1, "x"), makeHit("b/x.ts", 1, "x"), makeHit("c/x.ts", 1, "x")], seen),
        resolveWorkspaceRoot: async () => "/workspace",
      });
      const result = await service.search(
        { pattern: "x", paths: ["../a", "b"] },
        rr4Ctx({ cwd: "/workspace/root/pkg" }, [{ workspaceId: "ws-1", resourceId: "a" }, { workspaceId: "ws-1", resourceId: "b" }]),
      );
      expect(result.status).toBe("ready");
      expect(seen).toEqual([["a", "b"]]);
      expect(result.files.map((file) => file.path).sort()).toEqual(["a/x.ts", "b/x.ts"]);
    });

    it("intersects the effective scope with a restricted workspaceScope", async () => {
      const seen: string[][] = [];
      const service = createHarnessSearchService({
        search: scopedSearch([makeHit("allowed/x.ts", 1, "x"), makeHit("secret/x.ts", 1, "x")], seen),
        resolveWorkspaceRoot: async () => "/workspace",
      });
      const result = await service.search(
        { pattern: "x" },
        {
          ...rr4Ctx({ cwd: "/workspace" }),
          workspaceScope: ["allowed"],
        },
      );
      expect(result.status).toBe("ready");
      expect(seen).toEqual([["allowed"]]);
      expect(result.files.map((file) => file.path)).toEqual(["allowed/x.ts"]);
    });

    it("reports the backend's real scanned count and omits it when unknown", async () => {
      const seen: string[][] = [];
      const service = createHarnessSearchService({
        search: scopedSearch([], seen),
        resolveWorkspaceRoot: async () => "/workspace",
      });
      const known = await service.search({ pattern: "x" }, rr4Ctx());
      expect(known.status).toBe("empty");
      expect(known.searchedFiles).toBe(7);

      const unknown = createHarnessSearchService({
        search: vi.fn(async (): Promise<WorkspaceContentSearchResult> => ({ status: "empty", generation: 1 })),
        resolveWorkspaceRoot: async () => "/workspace",
      });
      const missing = await unknown.search({ pattern: "x" }, rr4Ctx());
      expect(missing.status).toBe("empty");
      expect(missing.searchedFiles).toBeUndefined();
    });
  });

  describe("HR2 multi-resource scope", () => {
    const multiSearch = (
      hitsByRoot: Record<string, WorkspaceSearchHit[]>,
      calls: string[] = [],
    ) => vi.fn(async (
      request: Parameters<HarnessSearchDeps["search"]>[0],
      options: WorkspaceContentSearchOptions,
    ): Promise<WorkspaceContentSearchResult> => {
      calls.push(request.workspaceId);
      const hits = hitsByRoot[request.workspaceId] ?? [];
      const paths = request.paths ?? [""];
      const scoped = hits.filter((hit) => paths.some((prefix) => (
        !prefix || hit.resource.resourceId === prefix || hit.resource.resourceId.startsWith(`${prefix}/`)
      )));
      return scoped.length
        ? { status: "ready", generation: options.generation, hits: scoped, scannedFiles: 3 }
        : { status: "empty", generation: options.generation, scannedFiles: 3 };
    });
    const multiRoots: Record<string, string> = { "dir-a": "/ext/a", "dir-b": "/ext/b", "file-x": "/ext/a/f.ts" };
    const hr2Ctx = (
      authorizedPaths: ReadonlyArray<{ workspaceId: string; resourceId: string }>,
    ) => ({
      actor,
      workspaceId: "ws-1",
      signal: new AbortController().signal,
      authorizedPaths,
    });
    const service = (search: HarnessSearchDeps["search"], extra: Partial<HarnessSearchDeps> = {}) =>
      createHarnessSearchService({
        search,
        resolveWorkspaceRoot: async (workspaceId) => multiRoots[workspaceId] ?? (workspaceId === "ws-1" ? "/workspace" : null),
        ...extra,
      });

    it("merges hits from unrelated directory roots with reopenable absolute paths", async () => {
      const calls: string[] = [];
      const result = await service(multiSearch({
        "dir-a": [makeHit("src/one.ts", 2, "match a")],
        "dir-b": [makeHit("two.ts", 4, "match b")],
      }, calls)).search(
        { pattern: "match" },
        hr2Ctx([{ workspaceId: "dir-a", resourceId: "src" }, { workspaceId: "dir-b", resourceId: "" }]),
      );
      expect(result.status).toBe("ready");
      expect(new Set(calls)).toEqual(new Set(["dir-a", "dir-b"]));
      expect(result.files.map((file) => file.path).sort()).toEqual([
        path.join("/ext/a", "src/one.ts"),
        path.join("/ext/b", "two.ts"),
      ]);
      expect(result.totalHits).toBe(2);
      expect(result.searchedFiles).toBe(6);
      expect(result.partial).toBe(false);
    });

    it("combines a file root and a directory root and dedupes overlapping hits", async () => {
      const overlapping = { resource: { resourceId: "", workspaceId: "file-x" }, line: 1, column: 1, preview: "dup" } as WorkspaceSearchHit;
      const result = await service(multiSearch({
        "dir-a": [makeHit("f.ts", 1, "dup"), makeHit("g.ts", 5, "only-dir")],
        "file-x": [overlapping],
      })).search(
        { pattern: "dup|only-dir" },
        hr2Ctx([{ workspaceId: "dir-a", resourceId: "" }, { workspaceId: "file-x", resourceId: "" }]),
      );
      expect(result.status).toBe("ready");
      const paths = result.files.map((file) => file.path).sort();
      expect(paths).toEqual([path.join("/ext/a", "f.ts"), path.join("/ext/a", "g.ts")]);
      expect(result.totalHits).toBe(2);
    });

    it("marks the result partial when one requested root cannot be resolved", async () => {
      const result = await service(multiSearch({
        "dir-a": [makeHit("one.ts", 1, "a")],
      })).search(
        { pattern: "a" },
        hr2Ctx([{ workspaceId: "dir-a", resourceId: "" }, { workspaceId: "gone", resourceId: "" }]),
      );
      expect(result.status).toBe("ready");
      expect(result.partial).toBe(true);
      expect(result.files.map((file) => file.path)).toEqual([path.join("/ext/a", "one.ts")]);
    });

    it("reports unavailable when every requested root fails", async () => {
      const result = await service(multiSearch({})).search(
        { pattern: "a" },
        hr2Ctx([{ workspaceId: "gone-1", resourceId: "" }, { workspaceId: "gone-2", resourceId: "" }]),
      );
      expect(result.status).toBe("unavailable");
    });

    it("searches the session authority root when no workspace is bound", async () => {
      const calls: string[] = [];
      const resolveScopeRoot = vi.fn(async (canonicalPath: string) =>
        canonicalPath === "/launch" ? { workspaceId: "dir-a", root: "/ext/a" } : null);
      const result = await service(multiSearch({ "dir-a": [makeHit("cold/note.md", 3, "hit")] }, calls), { resolveScopeRoot }).search(
        { pattern: "hit" },
        {
          actor: { ...actor, workspaceId: null, authorityRoot: "/launch" },
          workspaceId: null,
          signal: new AbortController().signal,
        },
      );
      expect(resolveScopeRoot).toHaveBeenCalledWith("/launch");
      expect(calls).toEqual(["dir-a"]);
      expect(result.status).toBe("ready");
      expect(result.files.map((file) => file.path)).toEqual([path.join("/ext/a", "cold/note.md")]);
    });

    it("stays unavailable for an unbound session without a resolvable authority root", async () => {
      const result = await service(multiSearch({}), { resolveScopeRoot: async () => null }).search(
        { pattern: "hit" },
        {
          actor: { ...actor, workspaceId: null, authorityRoot: "/untrusted" },
          workspaceId: null,
          signal: new AbortController().signal,
        },
      );
      expect(result.status).toBe("unavailable");
    });
  });
});
