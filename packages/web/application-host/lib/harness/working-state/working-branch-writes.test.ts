import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessActorContext, HarnessServiceMap } from "@varin/protocol";
import { createDocumentAuthority } from "../../documents/authority.js";
import { openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/file-store.test-helper.js";
import {
  createDocumentBranchWriteService,
  createDocumentReadSourceService,
  createWorkingBranchEnsureMaterializedService,
} from "../harness-services.js";
import { createHarnessPathAuthority } from "../path-authority.js";
import { createHarnessRouter } from "../router.js";
import { createThreadRegistry } from "../thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "../thread-runtime.js";
import { ThreadExecutionViewRegistry } from "./execution-view.js";
import { createWorkingBranchLookups } from "./working-branch-lookups.js";
import { createWorkingBranchWriteServices } from "./working-branch-writes.js";
import { VirtualWriteGate } from "./virtual-write-gate.js";
import { WorkingStateStore } from "./working-state-store.js";
import { asTestWorkingStateRootAccess, type TestWorkspaceWorkingStateAccess } from "./working-state-root-adapter.test-helper.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "varin-working-branch-write-"));
  const workspace = path.join(root, "workspace");
  const recoveryRoot = path.join(root, "recovery");
  const scratchA = path.join(root, "scratch-a");
  const scratchB = path.join(root, "scratch-b");
  await fs.mkdir(workspace);
  await fs.mkdir(scratchA);
  await fs.mkdir(scratchB);
  await fs.writeFile(path.join(workspace, "kept.txt"), "fixed kept\n");
  await fs.writeFile(path.join(workspace, "sibling.txt"), "shared base\n");
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
  const writeGate = new VirtualWriteGate();
  const lookups = createWorkingBranchLookups({ views, workingStates });
  const writes = createWorkingBranchWriteServices({ views, workingStates, writeGate });
  const base = await store.captureDirectory(workspace);
  await store.createBranch(workspaceId, "thread-a", base, "base");
  await store.createBranch(workspaceId, "thread-b", base, "base");
  const actorA: HarnessActorContext = {
    authorityInstanceId: "test-host",
    sessionId: "session-a",
    workerId: "worker",
    workerGeneration: 1,
    workspaceId,
    grantedCapabilities: ["read.document", "write.document"],
    runId: "run-a",
  };
  const actorB: HarnessActorContext = { ...actorA, sessionId: "session-b", runId: "run-b" };
  const scopedActor: HarnessActorContext = {
    ...actorA,
    sessionId: "session-scoped",
    workspaceScope: [path.join(workspace, "src")],
  };
  views.bind({
    sessionId: actorA.sessionId,
    workspaceId,
    threadId: "a",
    runId: "run-a",
    branchId: "thread-a",
    revision: 0,
    writeRevision: 0,
    mode: "virtual",
    draftBasePaths: [],
  });
  views.bind({
    sessionId: actorB.sessionId,
    workspaceId,
    threadId: "b",
    runId: "run-b",
    branchId: "thread-b",
    revision: 0,
    writeRevision: 0,
    mode: "virtual",
    draftBasePaths: [],
  });
  views.bind({
    sessionId: scopedActor.sessionId,
    workspaceId,
    threadId: "a",
    runId: "run-a",
    branchId: "thread-a",
    revision: 0,
    writeRevision: 0,
    mode: "virtual",
    draftBasePaths: [],
  });
  const registry = createThreadRegistry({ dataDir: path.join(root, "threads"), hostId: "test-host" });
  const runtime = createThreadRuntime({
    registry,
    workingStates,
    executionViews: views,
    virtualWriteGate: writeGate,
    resolveWorkspaceRoot: async () => workspace,
    resolveRuntimeWorkspaceId: async () => workspaceId,
    sessions: {
      create: async () => ({ sessionId: "unused", cwd: scratchA } as never),
      open: async (input) => ({ sessionId: input.sessionId, cwd: input.cwd } as never),
      prompt: async () => undefined,
      send: async () => undefined,
      abort: async () => undefined,
      close: async () => undefined,
      snapshot: async (sessionId) => ({ sessionId, cwd: scratchA } as never),
      summary: async (sessionId) => ({ id: sessionId, sessionFile: sessionId, cwd: scratchA } as never),
      stats: async () => ({ tokens: 0 } as never),
      entries: async (sessionId) => ({ sessionId, scope: "branch", leafId: null, entries: [] }),
    } as ThreadSessionAdapter,
    worktrees: {
      assertOwnership: async () => undefined,
      prepare: async () => ({ cwd: scratchA, worktree: { path: scratchA, base: "base", viewMode: "virtual" } }),
      snapshot: async (worktree) => worktree,
      inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
    },
  });
  const paths = createHarnessPathAuthority({ authorityId: "test-host", documents });
  let response: unknown;
  const router = createHarnessRouter({
    resolveActor: async (identity) => (
      identity.sessionId === actorB.sessionId
        ? actorB
        : identity.sessionId === scopedActor.sessionId
          ? scopedActor
          : actorA
    ),
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
  router.register("document.branchWrite", createDocumentBranchWriteService({
    documentBranchWrite: (sessionId, changes, expectedRevision) => writes.branchWrite(sessionId, changes, expectedRevision),
  }));
  router.register("workingBranch.ensureMaterialized", createWorkingBranchEnsureMaterializedService({
    workingBranchEnsureMaterialized: (sessionId) => runtime.materializeExecutionView(sessionId),
  }));

  disposes.push(async () => {
    router.dispose();
    await runtime.dispose();
    await registry.dispose();
    database.close();
    await documents.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const request = async <M extends "document.readSource" | "document.branchWrite" | "workingBranch.ensureMaterialized">(
    method: M,
    params: HarnessServiceMap[M]["params"],
    currentActor: HarnessActorContext = actorA,
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

  return {
    actorA,
    actorB,
    request,
    scopedActor,
    store,
    views,
    workspace,
    scratchA,
    workspaceId,
    registry,
    runtime,
    writeGate,
    writes,
  };
}

describe("WorkingState Host virtual write production chain", () => {
  it("does not confuse an external same-name file with the isolated branch file", async () => {
    const f = await fixture();
    const external = path.join(path.dirname(f.workspace), "external");
    await fs.mkdir(external);
    const externalFile = path.join(external, "kept.txt");
    await fs.writeFile(externalFile, "external kept\n");

    const read = await f.request("document.readSource", { path: externalFile });
    expect(read).toEqual({ ok: true, result: { source: "disk", base64: Buffer.from("external kept\n").toString("base64") } });

    const write = await f.request("document.branchWrite", {
      path: externalFile,
      action: "write",
      content: "wrong target\n",
    });
    expect(write).toMatchObject({ ok: true, result: { status: "rejected" } });
    expect(await fs.readFile(externalFile, "utf8")).toBe("external kept\n");
    expect(await fs.readFile(path.join(f.workspace, "kept.txt"), "utf8")).toBe("fixed kept\n");
    const branch = await f.writes.branchWrite("session-a", [{ workspaceId: f.workspaceId, resourceId: "kept.txt", action: "edit", edits: [{ oldText: "fixed kept", newText: "branch kept" }] }]);
    expect(branch.status).toBe("committed");
  });

  it("commits child writes without touching the parent disk and keeps sibling branches isolated", async () => {
    const f = await fixture();
    const wrote = await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "child a\n",
    });
    expect(wrote).toMatchObject({
      ok: true,
      result: { status: "committed", revision: 1, provenance: { branchId: "thread-a", origin: "delta" } },
    });
    expect(await fs.readFile(path.join(f.workspace, "kept.txt"), "utf8")).toBe("fixed kept\n");
    expect(await fs.readdir(f.scratchA)).toEqual([]);

    const readBack = await f.request("document.readSource", { path: "kept.txt" });
    expect(readBack).toMatchObject({
      ok: true,
      result: { source: "working-branch", provenance: { origin: "delta", revision: 1 } },
    });
    if (!readBack.ok || readBack.result.source !== "working-branch" || !readBack.result.base64) {
      throw new Error("expected working-branch bytes");
    }
    expect(Buffer.from(readBack.result.base64, "base64").toString("utf8")).toBe("child a\n");

    const sibling = await f.request("document.readSource", { path: "kept.txt" }, f.actorB);
    expect(sibling).toMatchObject({
      ok: true,
      result: { source: "working-branch", provenance: { origin: "base" } },
    });
    if (!sibling.ok || sibling.result.source !== "working-branch" || !sibling.result.base64) {
      throw new Error("expected sibling baseline bytes");
    }
    expect(Buffer.from(sibling.result.base64, "base64").toString("utf8")).toBe("fixed kept\n");

    const added = await f.request("document.branchWrite", {
      path: "src/new.ts",
      action: "write",
      content: "added\n",
    }, f.actorB);
    expect(added).toMatchObject({ ok: true, result: { status: "committed", revision: 1 } });
    const listed = await f.request("document.readSource", { path: "src/new.ts" });
    expect(listed).toMatchObject({ ok: true, result: { source: "working-branch", missing: true } });
  });

  it("rejects a stale writeRevision instead of dropping the newer update", async () => {
    const f = await fixture();
    expect(await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "first\n",
    })).toMatchObject({ ok: true, result: { status: "committed", revision: 1 } });
    const conflict = await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "stale\n",
      expectedRevision: 0,
    });
    expect(conflict).toMatchObject({
      ok: true,
      result: { status: "conflict", revision: 1 },
    });
    const readBack = await f.request("document.readSource", { path: "kept.txt" });
    if (!readBack.ok || readBack.result.source !== "working-branch" || !readBack.result.base64) {
      throw new Error("expected surviving first write");
    }
    expect(Buffer.from(readBack.result.base64, "base64").toString("utf8")).toBe("first\n");
  });

  it("refuses text writes over directories and scope-escaped paths", async () => {
    const f = await fixture();
    await f.store.commitVirtualWrite("thread-a", 0, "dir", { kind: "directory" });
    f.views.bind({ ...f.views.get("session-a")!, writeRevision: 1 });
    const directory = await f.request("document.branchWrite", {
      path: "dir",
      action: "write",
      content: "nope\n",
    });
    expect(directory).toMatchObject({
      ok: true,
      result: { status: "rejected" },
    });
    const escaped = await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "nope\n",
    }, f.scopedActor);
    expect(escaped).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("materializes the frozen branch for shell and publishes both virtual and directory phases", async () => {
    const f = await fixture();
    expect(await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "virtual then shell\n",
    })).toMatchObject({ ok: true, result: { status: "committed", revision: 1 } });
    const thread = await f.registry.createThread({
      scopeId: f.workspaceId,
      parent: { kind: "session", id: "parent-1" },
      brief: "materialize",
      preset: "hard-implement",
      kind: "implementation",
      createdBy: "agent",
      concurrency: 1,
      autoRun: true,
      worktree: "isolated",
      model: { providerId: "test", modelId: "test" },
      tools: ["read", "write", "bash"],
      permissions: {},
    });
    await f.registry.setWorktree(f.workspaceId, thread.id, {
      path: f.scratchA,
      base: "base",
      viewMode: "virtual",
      materialized: false,
      preparationStage: "ready",
    });
    await f.registry.setWorkingState(f.workspaceId, thread.id, { branchId: "thread-a", worktree: {
      path: f.scratchA,
      base: "base",
      viewMode: "virtual",
      materialized: false,
      preparationStage: "ready",
    } });
    const run = await f.registry.startRun(f.workspaceId, thread.id);
    await f.registry.markRunRunning(f.workspaceId, thread.id, run.id, "session-a");
    f.views.bind({
      sessionId: "session-a",
      workspaceId: f.workspaceId,
      threadId: thread.id,
      runId: run.id,
      branchId: "thread-a",
      revision: 0,
      writeRevision: 1,
      mode: "virtual",
      draftBasePaths: [],
    });

    const switched = await f.request("workingBranch.ensureMaterialized", {});
    expect(switched).toMatchObject({ ok: true, result: { status: "materialized", path: f.scratchA } });
    expect(f.views.get("session-a")?.mode).toBe("materialized");
    expect(await fs.readFile(path.join(f.scratchA, "kept.txt"), "utf8")).toBe("virtual then shell\n");
    expect(await fs.readFile(path.join(f.workspace, "kept.txt"), "utf8")).toBe("fixed kept\n");

    await fs.writeFile(path.join(f.scratchA, "kept.txt"), "virtual then shell then disk\n");
    await fs.writeFile(path.join(f.scratchA, "from-shell.txt"), "shell added\n");
    const published = await f.store.publishDirectoryResult("thread-a", f.scratchA);
    expect(published.changedPaths).toEqual(["from-shell.txt", "kept.txt"]);
    expect(await f.store.getObject(published.pathStates["kept.txt"]!.kind === "regular-file"
      ? published.pathStates["kept.txt"]!.objectHash
      : "")).toEqual(Buffer.from("virtual then shell then disk\n"));
  });

  it("waits for the real switch or cancel signal instead of failing after two attempts", async () => {
    const f = await fixture();
    const controller = new AbortController();
    await f.writeGate.beginSwitch("session-a");
    const write = f.writes.branchWrite("session-a", [{
      workspaceId: f.workspaceId,
      resourceId: "kept.txt",
      action: "write",
      content: "after switch\n",
    }], undefined, controller.signal);
    controller.abort();
    await expect(write).rejects.toMatchObject({ name: "AbortError" });
    f.writeGate.endSwitch("session-a");
    expect(await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "after switch\n",
    })).toMatchObject({ ok: true, result: { status: "committed" } });
  });
});
