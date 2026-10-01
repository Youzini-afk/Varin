import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessActorContext, HarnessServiceMap } from "@varin/protocol";
import { createDocumentAuthority } from "../../documents/authority.js";
import { openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/file-store.test-helper.js";
import { createDocumentPathOverlayService, createDocumentReadSourceService, createSearchContentService } from "../harness-services.js";
import { createHarnessPathAuthority } from "../path-authority.js";
import { createHarnessRouter } from "../router.js";
import { createHarnessSearchService } from "../search-service.js";
import { createExploreFileReader } from "../explore-file-reader.js";
import { createExploreDeps, createExploreQueryStartService } from "../explore-query-services.js";
import { createExploreQueryStore } from "../explore-query-store.js";
import type { HarnessServiceContext } from "../router.js";
import { ThreadExecutionViewRegistry } from "./execution-view.js";
import { createWorkingBranchLookups } from "./working-branch-lookups.js";
import type { WorkingBranchQuerySnapshot } from "./working-branch-lookups.js";
import { WorkingStateStore } from "./working-state-store.js";
import { asTestWorkingStateRootAccess, type TestWorkspaceWorkingStateAccess } from "./working-state-root-adapter.test-helper.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "varin-working-branch-view-"));
  const workspace = path.join(root, "workspace");
  const recoveryRoot = path.join(root, "recovery");
  const worktree = path.join(root, "worktree");
  await fs.mkdir(workspace);
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(worktree);
  await fs.writeFile(path.join(workspace, "kept.txt"), "fixed kept\n");
  await fs.writeFile(path.join(workspace, "draft.ts"), "disk draft\n");
  await fs.writeFile(path.join(workspace, "src", "nested.ts"), "nested baseline\n");
  const documents = createDocumentAuthority({
    hostId: "test-host",
    dataDir: path.join(root, "data"),
    isAllowedRoot: async () => true,
    isTrusted: async () => true,
  });
  const { workspaceId } = await documents.resolveWorkspace({ path: workspace });
  const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
  if (!database) throw new Error("catalog missing");
  const context = {
    database,
    fileStore: createRecoveryFileStore(),
    identity: { authorityId: "test-host", canonicalRoot: workspace, filesystemProfile: "test", workspaceId },
    resourceOperationGate: {
      run: async <Result>(_resources: readonly unknown[], operation: () => Promise<Result>) => operation(),
    },
    root: recoveryRoot,
  };
  const store = await WorkingStateStore.open(context);
  const legacyWorkingStates: TestWorkspaceWorkingStateAccess = {
    withStore: async (_workspaceId, _purpose, operation) => operation(store, context),
  };
  const workingStates = asTestWorkingStateRootAccess(legacyWorkingStates);
  const views = new ThreadExecutionViewRegistry();
  const lookups = createWorkingBranchLookups({ views, workingStates });
  const actor: HarnessActorContext = {
    authorityInstanceId: "test-host",
    sessionId: "child-session",
    workerId: "worker",
    workerGeneration: 1,
    workspaceId,
    grantedCapabilities: ["read.document", "read.search"],
    runId: "run-1",
  };
  const scopedActor: HarnessActorContext = { ...actor, sessionId: "scoped-session", workspaceScope: [path.join(workspace, "src")] };
  const paths = createHarnessPathAuthority({ authorityId: "test-host", documents });
  const base = await store.captureDirectory(workspace);
  const draftBytes = Buffer.from("fixed draft body\n");
  const draftObject = await store.putObject(draftBytes);
  await store.createBranch(workspaceId, "thread-child", {
    ...base,
    "draft.ts": { kind: "regular-file", objectHash: draftObject.hash, byteLength: draftObject.byteLength },
  }, "base", ["draft.ts"]);
  views.bind({
    sessionId: actor.sessionId,
    workspaceId,
    threadId: "child",
    runId: "run-1",
    branchId: "thread-child",
    revision: 0,
    writeRevision: 0,
    mode: "virtual",
    draftBasePaths: ["draft.ts"],
  });
  views.bind({
    sessionId: scopedActor.sessionId,
    workspaceId,
    threadId: "child",
    runId: "run-1",
    branchId: "thread-child",
    revision: 0,
    writeRevision: 0,
    mode: "virtual",
    draftBasePaths: ["draft.ts"],
  });

  let response: unknown;
  const router = createHarnessRouter({
    resolveActor: async (identity) => identity.sessionId === scopedActor.sessionId ? scopedActor : actor,
    authorizeWorkspacePath: (current, input, options) => paths.resolve(current, input, options),
    respond: async (_sessionId, _requestId, result) => { response = result; },
  });
  router.register("document.readSource", createDocumentReadSourceService({
    documentReadSource: async (sessionId, _context, resourceId, targetWorkspaceId) => {
      const result = await lookups.readSource(sessionId, resourceId, targetWorkspaceId);
      return result ?? documents.readAgentInputSnapshot(sessionId, { source: "disk" }, resourceId, targetWorkspaceId);
    },
    readAuthorizedDiskFile: (ctx, authorized) => paths.readAuthorizedFile(ctx.actor, authorized, ctx.signal),
  }));
  router.register("document.pathOverlay", createDocumentPathOverlayService({
    documentPathOverlay: async (sessionId, _context, resourceId, targetWorkspaceId) => {
      const result = await lookups.pathOverlay(sessionId, resourceId, targetWorkspaceId);
      return result ?? documents.overlayAgentInputSnapshot(sessionId, { source: "disk" }, resourceId, targetWorkspaceId);
    },
  }));
  const search = createHarnessSearchService({
    search: async () => {
      throw new Error("parent disk search must not run for a bound branch");
    },
    resolveWorkspaceRoot: async () => workspace,
    pinWorkingBranchQuery: (sessionId, options) => lookups.pinQuery(sessionId, options),
    readFile: createExploreFileReader(documents, paths, (sessionId, resourceId, workspaceId) => lookups.exploreFile(sessionId, resourceId, workspaceId)),
  });
  router.register("search.content", createSearchContentService(search));

  disposes.push(async () => {
    router.dispose();
    database.close();
    await documents.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const request = async <M extends "document.readSource" | "document.pathOverlay" | "search.content">(
    method: M,
    params: HarnessServiceMap[M]["params"],
    currentActor: HarnessActorContext = actor,
  ) => {
    await router.processEvent({
      kind: "host",
      actor: currentActor,
      envelope: {
        kind: "event",
        event: "harness.request",
        data: { requestId: crypto.randomUUID(), method, params },
      },
    });
    return response as
      | { ok: true; result: HarnessServiceMap[M]["result"] }
      | { ok: false; error: { code: string; message: string } };
  };

  return { actor, lookups, request, scopedActor, store, views, workspace, worktree, workspaceId };
}

describe("WorkingState Host branch view production chain", () => {
  it('pages a pinned branch source and preserves its provenance after parent disk drift', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, 'kept.txt'), 'parent changed\n');
    const result = await f.lookups.readSource(f.actor.sessionId, 'kept.txt', f.workspaceId,
      { page: { offset: 1, limit: 1, maxBytes: 50 * 1024 } });
    expect(result).toMatchObject({ status: 'working-branch', provenance: { branchId: 'thread-child', origin: 'base', revision: 0 },
      page: { kind: 'text', text: 'fixed kept' } });
  });

  it("uses the authorized external root's disk view for read and listing", async () => {
    const f = await fixture();
    const external = path.join(path.dirname(f.workspace), "external-view");
    await fs.mkdir(external);
    await fs.writeFile(path.join(external, "kept.txt"), "external body\n");
    const read = await f.request("document.readSource", { path: path.join(external, "kept.txt") });
    expect(read).toEqual({ ok: true, result: { source: "disk", base64: Buffer.from("external body\n").toString("base64") } });
    expect(await f.request("document.pathOverlay", { path: external })).toEqual({ ok: true, result: { status: "disk" } });
  });

  it("keeps child read/grep/find/ls on the fixed base after parent and worktree drift", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.workspace, "kept.txt"), "parent live kept\n");
    await fs.writeFile(path.join(f.worktree, "kept.txt"), "worktree live kept\n");
    await fs.writeFile(path.join(f.workspace, "draft.ts"), "parent live draft\n");

    const read = await f.request("document.readSource", { path: "kept.txt" });
    expect(read).toMatchObject({ ok: true, result: { source: "working-branch" } });
    if (!read.ok || read.result.source !== "working-branch" || !read.result.base64) {
      throw new Error("expected working-branch bytes");
    }
    expect(Buffer.from(read.result.base64, "base64").toString("utf8")).toBe("fixed kept\n");
    expect(read.result.provenance).toEqual({ branchId: "thread-child", revision: 0, origin: "base" });

    const draft = await f.request("document.readSource", { path: "draft.ts" });
    expect(draft).toMatchObject({ ok: true, result: { source: "working-branch", provenance: { origin: "draft-base" } } });
    if (!draft.ok || draft.result.source !== "working-branch" || !draft.result.base64) {
      throw new Error("expected draft-base bytes");
    }
    expect(Buffer.from(draft.result.base64, "base64").toString("utf8")).toBe("fixed draft body\n");

    const overlay = await f.request("document.pathOverlay", { path: ".", pattern: "*" });
    expect(overlay).toMatchObject({ ok: true, result: { status: "ready", authority: "working-branch" } });
    if (!overlay.ok || overlay.result.status !== "ready") throw new Error("expected exclusive overlay");
    expect(overlay.result.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(["kept.txt", "draft.ts", "src", "src/nested.ts"]));

    const grep = await f.request("search.content", { pattern: "fixed kept" });
    expect(grep).toMatchObject({ ok: true, result: { status: "ready", totalHits: 1 } });
    if (!grep.ok || grep.result.status !== "ready") throw new Error("expected branch grep hits");
    expect(grep.result.files[0]?.path).toBe("kept.txt");

    const liveGrep = await f.request("search.content", { pattern: "parent live" });
    expect(liveGrep).toMatchObject({ ok: true, result: { status: "empty" } });
  });

  it("re-reads the live view after the store lease so body and provenance share one revision", async () => {
    const f = await fixture();
    let releaseShared: (() => void) | undefined;
    const sharedGate = new Promise<void>((resolve) => { releaseShared = resolve; });
    let sharedWaiting: () => void = () => undefined;
    const sharedWaitingP = new Promise<void>((resolve) => { sharedWaiting = resolve; });
    const delayed = asTestWorkingStateRootAccess({
      withStore: async (_workspaceId, _purpose, operation, mode) => {
        if (mode === "shared") {
          sharedWaiting();
          await sharedGate;
        }
        return operation(f.store, {
          database: { close() { /* test fixture */ } } as never,
          fileStore: { captureState: async () => ({ state: { kind: "missing" as const } }) } as never,
          identity: { authorityId: "test-host", canonicalRoot: f.workspace, filesystemProfile: "test", workspaceId: f.workspaceId },
          resourceOperationGate: { run: async (_resources, op) => op() },
          root: f.workspace,
        });
      },
    });
    const lookups = createWorkingBranchLookups({ views: f.views, workingStates: delayed });
    const reading = lookups.readSource(f.actor.sessionId, "kept.txt", f.workspaceId);
    await sharedWaitingP;
    const next = await f.store.putObject(Buffer.from("lease-visible body\n"));
    await f.store.commitVirtualWrite("thread-child", 0, "kept.txt", {
      kind: "regular-file",
      objectHash: next.hash,
      byteLength: next.byteLength,
    });
    f.views.bind({ ...f.views.get(f.actor.sessionId)!, writeRevision: 1 });
    releaseShared?.();
    const result = await reading;
    expect(result).toMatchObject({
      status: "working-branch",
      provenance: { revision: 1, origin: "delta" },
    });
    if (!result || result.status !== "working-branch" || !result.base64) throw new Error("expected working-branch bytes");
    expect(Buffer.from(result.base64, "base64").toString("utf8")).toBe("lease-visible body\n");
    expect(result.revision).toContain("@1:");
  });

  it("pins explore lexical and original-text reads to the start-time snapshot", async () => {
    const f = await fixture();
    const lookups = createWorkingBranchLookups({ views: f.views, workingStates: asTestWorkingStateRootAccess({
      withStore: async (_workspaceId, _purpose, operation) => operation(f.store, {
        database: { close() { /* test fixture */ } } as never,
        fileStore: { captureState: async () => ({ state: { kind: "missing" as const } }) } as never,
        identity: { authorityId: "test-host", canonicalRoot: f.workspace, filesystemProfile: "test", workspaceId: f.workspaceId },
        resourceOperationGate: { run: async (_resources, op) => op() },
        root: f.workspace,
      }),
    }) });
    const written = await f.store.putObject(Buffer.from("export const needle = \"pinned-pineapple\";\n"));
    await f.store.commitVirtualWrite("thread-child", 0, "kept.txt", {
      kind: "regular-file",
      objectHash: written.hash,
      byteLength: written.byteLength,
    });
    f.views.bind({ ...f.views.get(f.actor.sessionId)!, writeRevision: 1 });
    const queryStore = createExploreQueryStore();
    const pin = { snapshot: null as WorkingBranchQuerySnapshot | null };
    const searchService = createHarnessSearchService({
      search: async () => {
        throw new Error("parent disk search must not run for a pinned branch query");
      },
      resolveWorkspaceRoot: async () => f.workspace,
      pinWorkingBranchQuery: async () => {
        throw new Error("a second working-branch pin must not be acquired after explore.query.start");
      },
    });
    let semanticDocs: Array<{ path: string; content: string; revision: string }> | undefined;
    const host = {
      exploreQueryStore: queryStore,
      searchService,
      pinWorkingBranchQuery: async (sessionId: string) => {
        pin.snapshot = await lookups.pinQuery(sessionId);
        return pin.snapshot;
      },
      readExploreFile: async () => {
        throw new Error("live explore reader must not run after a working-branch pin");
      },
      semanticRecall: async (
        _workspaceId: string,
        _question: string,
        _limit: number,
        options?: { threadQuery?: WorkingBranchQuerySnapshot },
      ) => {
        semanticDocs = [];
        for (const file of await options?.threadQuery?.listFiles() ?? []) {
          const document = await options!.threadQuery!.readFile(file.path);
          if (document.status === "ready") semanticDocs.push({ path: file.path, content: document.content, revision: document.revision });
        }
        return [];
      },
    };
    const ctx: HarnessServiceContext = {
      actor: f.actor,
      authorizedPaths: [],
      sessionId: f.actor.sessionId,
      workspaceId: f.workspaceId,
      inputContext: { source: "disk" },
      signal: new AbortController().signal,
    };
    await createExploreQueryStartService(host as never).handle({ question: "pinned-pineapple" }, ctx);
    expect(pin.snapshot?.writeRevision).toBe(1);
    const later = await f.store.putObject(Buffer.from("export const needle = \"later-drift\";\n"));
    await f.store.commitVirtualWrite("thread-child", 1, "kept.txt", {
      kind: "regular-file",
      objectHash: later.hash,
      byteLength: later.byteLength,
    });
    f.views.bind({ ...f.views.get(f.actor.sessionId)!, writeRevision: 2 });
    const deps = createExploreDeps(host as never, ctx, { source: "disk" }, ctx.signal, undefined, pin.snapshot);
    const search = await deps.rgSearch("pinned-pineapple", { fixedStrings: false });
    const hits = Array.isArray(search) ? search : search.hits;
    expect(hits.some((hit) => hit.text.includes("pinned-pineapple"))).toBe(true);
    expect(hits.some((hit) => hit.text.includes("later-drift"))).toBe(false);
    const original = await deps.readFile("kept.txt");
    expect(original).toMatchObject({
      status: "ready",
      content: "export const needle = \"pinned-pineapple\";\n",
      revision: "working-branch:thread-child@1:base",
    });
    await deps.semantic?.search("pinned-pineapple");
    expect(semanticDocs?.some((file) => file.content.includes("pinned-pineapple"))).toBe(true);
    expect(semanticDocs?.some((file) => file.content.includes("later-drift"))).toBe(false);
    queryStore.dispose();
  });

  it("rejects a path outside the child scope before reading the branch", async () => {
    const f = await fixture();
    const refused = await f.request("document.readSource", { path: "kept.txt" }, f.scopedActor);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("expected scope refusal");
    expect(refused.error.code).toBe("forbidden");
    expect(JSON.stringify(refused)).not.toContain("fixed kept");
  });

  it("pins only authorized query roots without cloning the full branch and honors cancellation", async () => {
    const f = await fixture();
    const fullClone = vi.spyOn(f.store, "effectiveState");
    const controller = new AbortController();
    const scoped = await f.lookups.pinQuery(f.actor.sessionId, {
      roots: ["src"],
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
    });
    expect((await scoped?.listFiles())?.map((file) => file.path)).toEqual(["src/nested.ts"]);
    expect(scoped).not.toHaveProperty("states");
    expect(scoped).not.toHaveProperty("files");
    expect(fullClone).not.toHaveBeenCalled();
    controller.abort();
    await expect(f.lookups.pinQuery(f.actor.sessionId, {
      roots: [""],
      signal: controller.signal,
      deadlineAt: Date.now() + 10_000,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
