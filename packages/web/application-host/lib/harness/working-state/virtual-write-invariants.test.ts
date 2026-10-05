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
import { IntegrationCoordinator } from "./integration-coordinator.js";
import { pinSemanticQueryView } from "../../knowledge/semantic/query-view.js";
import { listBranchTextFiles, readBranchFile } from "./branch-view.js";
import { ThreadExecutionViewRegistry } from "./execution-view.js";
import { createWorkingBranchLookups } from "./working-branch-lookups.js";
import { createWorkingBranchWriteServices } from "./working-branch-writes.js";
import { acquireVirtualWriteTicket, VirtualWriteGate } from "./virtual-write-gate.js";
import { WorkingStateStore } from "./working-state-store.js";
import { asTestWorkingStateRootAccess, asTestWorkingStateRootStore, type TestWorkspaceWorkingStateAccess } from "./working-state-root-adapter.test-helper.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });

async function fixture(options?: { attachGit?: () => Promise<void> }) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "varin-virtual-write-invariants-"));
  const workspace = path.join(root, "workspace");
  const recoveryRoot = path.join(root, "recovery");
  const scratch = path.join(root, "scratch");
  await fs.mkdir(workspace);
  await fs.mkdir(scratch);
  await fs.writeFile(path.join(workspace, "kept.txt"), "fixed kept\n");
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
  const rootStore = asTestWorkingStateRootStore(store, context);
  const legacyWorkingStates: TestWorkspaceWorkingStateAccess = {
    withStore: async (_workspaceId, _purpose, operation) => operation(store, context),
  };
  const workingStates = asTestWorkingStateRootAccess(legacyWorkingStates);
  const views = new ThreadExecutionViewRegistry();
  const writeGate = new VirtualWriteGate();
  const lookups = createWorkingBranchLookups({ views, workingStates });
  const writes = createWorkingBranchWriteServices({ views, workingStates, writeGate });
  const base = await store.captureDirectory(workspace);
  await store.createBranch(workspaceId, "thread-parent", base, "base");
  const actor: HarnessActorContext = {
    authorityInstanceId: "test-host",
    sessionId: "session-parent",
    workerId: "worker",
    workerGeneration: 1,
    workspaceId,
    grantedCapabilities: ["read.document", "write.document"],
    runId: "run-parent",
  };
  views.bind({
    sessionId: actor.sessionId,
    workspaceId,
    threadId: "parent",
    runId: "run-parent",
    branchId: "thread-parent",
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
      create: async () => ({ sessionId: "unused", cwd: scratch } as never),
      open: async (input) => ({ sessionId: input.sessionId, cwd: input.cwd } as never),
      prompt: async () => undefined,
      send: async () => undefined,
      abort: async () => undefined,
      close: async () => undefined,
      snapshot: async (sessionId) => ({ sessionId, cwd: scratch } as never),
      summary: async (sessionId) => ({ id: sessionId, sessionFile: sessionId, cwd: scratch } as never),
      stats: async () => ({ tokens: 0 } as never),
      entries: async (sessionId) => ({ sessionId, scope: "branch", leafId: null, entries: [] }),
    } as ThreadSessionAdapter,
    worktrees: {
      assertOwnership: async () => undefined,
      prepare: async () => ({ cwd: scratch, worktree: { path: scratch, base: "base", viewMode: "virtual" } }),
      snapshot: async (worktree) => worktree,
      inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
      attachIsolatedGitContext: async () => {
        if (options?.attachGit) await options.attachGit();
        return { kind: "none" as const };
      },
    },
  });
  const paths = createHarnessPathAuthority({ authorityId: "test-host", documents });
  let response: unknown;
  const router = createHarnessRouter({
    resolveActor: async () => actor,
    authorizeWorkspacePath: (current, input, resolveOptions) => paths.resolve(current, input, resolveOptions),
    respond: async (_sessionId, _requestId, result) => { response = result; },
  });
  router.register("document.readSource", createDocumentReadSourceService({
    documentReadSource: async (sessionId, _context, resourceId, targetWorkspaceId) => {
      const result = await lookups.readSource(sessionId, resourceId, targetWorkspaceId);
      if (!result) throw new Error("working-branch read source is unbound");
      return result;
    },
  }));
  router.register("document.branchWrite", createDocumentBranchWriteService({
    documentBranchWrite: (sessionId, changes, expectedRevision) => writes.branchWrite(sessionId, changes, expectedRevision),
  }));
  router.register("workingBranch.ensureMaterialized", createWorkingBranchEnsureMaterializedService({
    workingBranchEnsureMaterialized: (sessionId, signal) => runtime.materializeExecutionView(sessionId, signal),
  }));
  const coordinator = new IntegrationCoordinator({
    workingStates,
    holdParentVirtualWrite: async (sessionId, signal) => {
      const ticket = await acquireVirtualWriteTicket(
        writeGate,
        sessionId,
        () => views.get(sessionId)?.mode === "virtual",
        signal,
      );
      return ticket === "disk"
        ? { status: "disk" }
        : { status: "virtual", release: () => ticket.finish() };
    },
    resolveParentSessionId: (workspaceId, branchId) => views.findByBranch(workspaceId, branchId)?.sessionId,
    commitParentVirtualWrites: async (input) => {
      const result = await input.store.commitVirtualWrites(input.branchId, input.expectedWriteRevision, input.files);
      const sessionId = input.sessionId ?? views.findByBranch(input.workspaceId, input.branchId)?.sessionId;
      if (result.status === "committed" && sessionId) {
        const live = views.get(sessionId);
        if (live?.mode === "virtual") views.bind({ ...live, writeRevision: result.writeRevision });
      }
      return result;
    },
  });

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
  ) => {
    await router.processEvent({
      kind: "host",
      actor,
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

  const bindThread = async () => {
    const thread = await registry.createThread({
      scopeId: workspaceId,
      parent: { kind: "session", id: "root" },
      brief: "virtual writes",
      preset: "worker",
      kind: "implementation",
      createdBy: "agent",
      concurrency: 1,
      autoRun: true,
      worktree: "isolated",
      model: { providerId: "test", modelId: "test" },
      tools: ["read", "write", "bash"],
      permissions: {},
    });
    const worktree = { path: scratch, base: "base", viewMode: "virtual" as const, materialized: false, preparationStage: "ready" as const };
    await registry.setWorktree(workspaceId, thread.id, worktree);
    await registry.setWorkingState(workspaceId, thread.id, { branchId: "thread-parent", worktree });
    const run = await registry.startRun(workspaceId, thread.id);
    await registry.markRunRunning(workspaceId, thread.id, run.id, actor.sessionId);
    views.bind({
      sessionId: actor.sessionId,
      workspaceId,
      threadId: thread.id,
      runId: run.id,
      branchId: "thread-parent",
      revision: 0,
      writeRevision: views.get(actor.sessionId)?.writeRevision ?? 0,
      mode: "virtual",
      draftBasePaths: [],
    });
    return thread;
  };

  return {
    actor,
    coordinator,
    lookups,
    request,
    registry,
    root,
    runtime,
    scratch,
    store,
    rootStore,
    views,
    workspace,
    workspaceId,
    bindThread,
    writes,
  };
}

describe("virtual write production invariants", () => {
  it("rejects symlink edit/delete, cycles, illegal UTF-8, and file-ancestor children without writing a delta", async () => {
    const f = await fixture();
    const target = await f.store.putObject(Buffer.from("target\n"));
    await f.store.commitVirtualWrite("thread-parent", 0, "link.txt", {
      kind: "symlink",
      symlinkTarget: "link.txt",
    });
    await f.store.commitVirtualWrite("thread-parent", 1, "binary.dat", {
      kind: "regular-file",
      objectHash: (await f.store.putObject(Buffer.from([0xff, 0xfe, 0xfd]))).hash,
      byteLength: 3,
    });
    await f.store.commitVirtualWrite("thread-parent", 2, "kept.txt", {
      kind: "regular-file",
      objectHash: target.hash,
      byteLength: target.byteLength,
    });
    f.views.bind({ ...f.views.get("session-parent")!, writeRevision: 3 });

    const editLink = await f.request("document.branchWrite", {
      path: "link.txt",
      action: "edit",
      edits: [{ oldText: "x", newText: "y" }],
    });
    const deleteLink = await f.request("document.branchWrite", {
      path: "link.txt",
      action: "delete",
    });
    const illegal = await f.request("document.branchWrite", {
      path: "binary.dat",
      action: "edit",
      edits: [{ oldText: "x", newText: "y" }],
    });
    const nested = await f.request("document.branchWrite", {
      path: "kept.txt/child.ts",
      action: "write",
      content: "nope\n",
    });
    expect(editLink).toMatchObject({ ok: true, result: { status: "rejected" } });
    expect(deleteLink).toMatchObject({ ok: true, result: { status: "rejected" } });
    expect(illegal).toMatchObject({ ok: true, result: { status: "rejected" } });
    expect(nested).toMatchObject({ ok: true, result: { status: "rejected" } });
    expect(f.store.getBranch("thread-parent")?.writeRevision).toBe(3);
    expect(f.store.effectiveState("thread-parent")?.["link.txt"]).toMatchObject({ kind: "symlink" });
    expect(f.store.effectiveState("thread-parent")?.["kept.txt/child.ts"]).toBeUndefined();
    await expect(readBranchFile(f.rootStore, "thread-parent", "link.txt")).resolves.toMatchObject({
      unavailable: expect.stringMatching(/cycle/),
    });
  });

  it("labels reads with the live writeRevision, not a published headRevision", async () => {
    const f = await fixture();
    expect(await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "virtual body\n",
    })).toMatchObject({ ok: true, result: { status: "committed", revision: 1 } });
    expect(f.store.getBranch("thread-parent")?.headRevision).toBe(0);
    const readBack = await f.request("document.readSource", { path: "kept.txt" });
    expect(readBack).toMatchObject({
      ok: true,
      result: {
        source: "working-branch",
        revision: "working-branch:thread-parent@1:delta",
        provenance: { revision: 1, origin: "delta" },
      },
    });
    const files = await listBranchTextFiles(f.rootStore, "thread-parent", [""]);
    expect(files.find((file) => file.path === "kept.txt")?.revision).toBe("working-branch:thread-parent@1:delta");
  });

  it("pins virtual explore/semantic documents to the branch view and excludes later parent disk drift", async () => {
    const f = await fixture();
    expect(await f.request("document.branchWrite", {
      path: "only-on-branch.ts",
      action: "write",
      content: "export const secret = \"branch-only pineapple\";\n",
    })).toMatchObject({ ok: true, result: { status: "committed", revision: 1 } });
    await fs.writeFile(path.join(f.workspace, "kept.txt"), "parent drifted after dispatch\n");
    const files = await listBranchTextFiles(f.rootStore, "thread-parent", [""]);
    const pinned = await pinSemanticQueryView({
      inputContext: { source: "disk" },
      threadDocuments: files.map((file) => ({
        path: file.path,
        content: file.text,
        revision: file.revision,
      })),
    });
    expect(pinned.view).toBe("working-state");
    expect(pinned.overlays.some((overlay) => overlay.content?.includes("branch-only pineapple"))).toBe(true);
    expect(pinned.overlays.some((overlay) => overlay.content?.includes("parent drifted"))).toBe(false);
    const explore = await f.lookups.exploreFile("session-parent", "only-on-branch.ts", f.workspaceId);
    expect(explore).toMatchObject({
      status: "ready",
      source: "working-branch",
      revision: "working-branch:thread-parent@1:delta",
    });
  });

  it("keeps a concurrent write on the branch when forced materialization fails", async () => {
    const f = await fixture({
      attachGit: async () => {
        throw new Error("forced materialization failure");
      },
    });
    expect(await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "before switch\n",
    })).toMatchObject({ ok: true, result: { status: "committed", revision: 1 } });
    await f.bindThread();
    f.views.bind({ ...f.views.get("session-parent")!, writeRevision: 1, mode: "virtual" });
    const switching = f.runtime.materializeExecutionView("session-parent");
    const concurrent = f.request("document.branchWrite", {
      path: "after-fail.ts",
      action: "write",
      content: "still on branch\n",
    });
    await expect(switching).resolves.toMatchObject({ status: "failed" });
    expect(await concurrent).toMatchObject({ ok: true, result: { status: "committed" } });
    expect(f.views.get("session-parent")?.mode).toBe("virtual");
    expect(await fs.readFile(path.join(f.workspace, "kept.txt"), "utf8")).toBe("fixed kept\n");
    await expect(fs.readFile(path.join(f.scratch, "after-fail.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const readBack = await f.request("document.readSource", { path: "after-fail.ts" });
    if (!readBack.ok || readBack.result.source !== "working-branch" || !readBack.result.base64) {
      throw new Error("expected the concurrent write to remain on the branch");
    }
    expect(Buffer.from(readBack.result.base64, "base64").toString("utf8")).toBe("still on branch\n");
  });

  it("does not finish a directory switch after the caller aborts", async () => {
    const f = await fixture();
    expect(await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "virtual\n",
    })).toMatchObject({ ok: true, result: { status: "committed", revision: 1 } });
    const thread = await f.bindThread();
    f.views.bind({ ...f.views.get("session-parent")!, writeRevision: 1, mode: "virtual" });
    const controller = new AbortController();
    controller.abort();
    await expect(f.runtime.materializeExecutionView("session-parent", controller.signal)).resolves.toMatchObject({
      status: "failed",
    });
    expect(f.views.get("session-parent")?.mode).toBe("virtual");
    const latest = await f.registry.getThreadById(f.workspaceId, thread.id);
    expect(latest?.worktree?.viewMode).toBe("virtual");
    expect(latest?.worktree?.materializationSwitch).toBeUndefined();
    expect(await fs.readdir(f.scratch)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/materializing|virtual-backup/),
    ]));
    const names = await fs.readdir(path.dirname(f.scratch));
    expect(names.some((name) => name.includes("materializing") || name.includes("virtual-backup"))).toBe(false);
  });

  it("recovers a promoted crash to one materialized tree and a live-backed-up abort to virtual", async () => {
    const f = await fixture();
    expect(await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "frozen\n",
    })).toMatchObject({ ok: true, result: { status: "committed", revision: 1 } });
    const thread = await f.bindThread();
    const backup = `${f.scratch}.virtual-backup-crash`;
    const staging = `${f.scratch}.materializing-crash`;
    await fs.rename(f.scratch, backup);
    await fs.mkdir(f.scratch);
    await fs.writeFile(path.join(f.scratch, "kept.txt"), "frozen\n");
    await f.registry.setWorktree(f.workspaceId, thread.id, {
      path: f.scratch,
      base: "base",
      viewMode: "virtual",
      materialized: false,
      preparationStage: "ready",
      materializationSwitch: {
        revision: 0,
        writeRevision: 1,
        root: "sha256-promoted-root",
        stagingPath: staging,
        backupPath: backup,
        stage: "staging-promoted",
      },
    });
    f.views.bind({ ...f.views.get("session-parent")!, writeRevision: 1, mode: "virtual" });
    await expect(f.runtime.materializeExecutionView("session-parent")).resolves.toMatchObject({
      status: "materialized",
      path: f.scratch,
    });
    expect(f.views.get("session-parent")?.mode).toBe("materialized");
    expect(await fs.readFile(path.join(f.scratch, "kept.txt"), "utf8")).toBe("frozen\n");
    await expect(fs.stat(backup)).rejects.toMatchObject({ code: "ENOENT" });

    const aborted = await fixture();
    await aborted.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "still virtual\n",
    });
    const abortedThread = await aborted.bindThread();
    const abortedBackup = `${aborted.scratch}.virtual-backup-abort`;
    const abortedStaging = `${aborted.scratch}.materializing-abort`;
    await fs.writeFile(path.join(aborted.scratch, "virtual-marker.txt"), "scratch authority\n");
    await fs.mkdir(abortedStaging);
    await fs.writeFile(path.join(abortedStaging, "next.txt"), "should not win\n");
    await fs.rename(aborted.scratch, abortedBackup);
    await aborted.registry.setWorktree(aborted.workspaceId, abortedThread.id, {
      path: aborted.scratch,
      base: "base",
      viewMode: "virtual",
      materialized: false,
      preparationStage: "ready",
      materializationSwitch: {
        revision: 0,
        writeRevision: 1,
        root: "sha256-aborted-root",
        stagingPath: abortedStaging,
        backupPath: abortedBackup,
        stage: "live-backed-up",
      },
    });
    aborted.views.bind({ ...aborted.views.get("session-parent")!, writeRevision: 1, mode: "virtual" });
    const controller = new AbortController();
    controller.abort();
    await expect(aborted.runtime.materializeExecutionView("session-parent", controller.signal)).resolves.toMatchObject({
      status: "failed",
    });
    expect(aborted.views.get("session-parent")?.mode).toBe("virtual");
    expect(await fs.readFile(path.join(aborted.scratch, "virtual-marker.txt"), "utf8")).toBe("scratch authority\n");
    await expect(fs.stat(path.join(aborted.scratch, "next.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(abortedStaging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies a grandchild merge, a later parent write, and materialize onto the same tree", async () => {
    const f = await fixture();
    await f.store.createBranch(f.workspaceId, "thread-child", f.store.effectiveState("thread-parent")!, "thread-parent@0");
    const childFile = await f.store.putObject(Buffer.from("from grandchild\n"));
    await f.store.commitVirtualWrites("thread-child", 0, {
      "child.txt": { kind: "regular-file", objectHash: childFile.hash, byteLength: childFile.byteLength },
    });
    const published = await f.store.publishHeadResult("thread-child");
    await f.coordinator.mergeResult({
      workspaceId: f.workspaceId,
      threadId: "child",
      branchId: "thread-child",
      resultRevision: published.resultRevision,
      parentAuthority: { kind: "branch", branchId: "thread-parent", sessionId: "session-parent" },
    });
    expect(f.views.get("session-parent")?.writeRevision).toBeGreaterThan(0);
    expect(await f.request("document.branchWrite", {
      path: "parent-later.ts",
      action: "write",
      content: "from parent after merge\n",
    })).toMatchObject({ ok: true, result: { status: "committed" } });
    await f.bindThread();
    await expect(f.request("workingBranch.ensureMaterialized", {})).resolves.toMatchObject({
      ok: true,
      result: { status: "materialized", path: f.scratch },
    });
    expect(await fs.readFile(path.join(f.scratch, "child.txt"), "utf8")).toBe("from grandchild\n");
    expect(await fs.readFile(path.join(f.scratch, "parent-later.ts"), "utf8")).toBe("from parent after merge\n");
    expect(await fs.readFile(path.join(f.workspace, "kept.txt"), "utf8")).toBe("fixed kept\n");
    await expect(fs.stat(path.join(f.workspace, "child.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
