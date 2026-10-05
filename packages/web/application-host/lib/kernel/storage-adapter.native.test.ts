import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { ThreadExecutionViewRegistry } from "../harness/working-state/execution-view.js";
import { createWorkingBranchLookups } from "../harness/working-state/working-branch-lookups.js";
import { createWorkingBranchWriteServices } from "../harness/working-state/working-branch-writes.js";
import { VirtualWriteGate } from "../harness/working-state/virtual-write-gate.js";
import { IntegrationCoordinator } from "../harness/working-state/integration-coordinator.js";
import { selectCodeChanges } from "../harness/working-state/code-submission.js";
import { createWorkspaceRecoveryEngine, type CreateWorkspaceRecoveryEngineOptions } from "../recovery/journal-engine.js";
import { createKernelClient } from "./kernel-client.js";
import { createKernelWorkspaceWorkingStateAccess, KernelStorageAdapter, KernelWorkingStateRootStore } from "./storage-adapter.js";
import { KernelRecoveryContentStore, KernelRecoveryStore, createKernelRecoveryDirectFacade } from "./kernel-recovery-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repositoryRoot, "kernel", "target", "release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const hasReleaseKernel = await fs.stat(kernelPath).then(() => true).catch(() => false);
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;

it.skipIf(!hasReleaseKernel)("equivalent actor fields share one native grant regardless of construction order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-grant-identity-"));
  const client = createKernelClient({ hostId: "grant-identity", storageRoot: path.join(root, "storage"),
    buildVersion, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: "grant-identity", storageRoot: path.join(root, "storage"),
    resolveWorkspaceRoot: async () => root });
  try {
    await client.start();
    const first = await adapter.context("workspace", "recovery-maintenance", {
      owningWorkspace: "workspace", executionWorkspace: "workspace", pathScopes: [""], capabilities: ["recovery.maintenance"],
    });
    const second = await adapter.context("workspace", "recovery-maintenance", {
      capabilities: ["recovery.maintenance"], pathScopes: [""], executionWorkspace: "workspace", owningWorkspace: "workspace",
    });
    const bytes = Buffer.from("same-authority-bytes");
    const owned = await first.client.putBlob(bytes, "grant-order-input");
    try {
      const read = await second.client.getBlob(owned.hash, { ownerId: owned.ownerId });
      assert.deepEqual(Buffer.from(read.bytesBase64, "base64"), bytes);
    } finally { await first.client.releaseBlob(owned.ownerId); }
  } finally { await adapter.dispose(); await client.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it.skipIf(!hasReleaseKernel)("release kernel owns working-state roots, pinned reads, scoped lists, virtual writes, and base reverts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-working-state-"));
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "mode.txt"), "base body\n");
  await fs.writeFile(path.join(workspace, "src", "nested.ts"), "nested base\n");
  const workspaceId = "workspace-working-state";
  const branchId = "branch-working-state";
  const sessionId = "session-working-state";
  const client = createKernelClient({
    hostId: "working-state-test-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  const resolvedActorHints: Array<{ sessionId?: string; threadId?: string; runId?: string }> = [];
  const adapter = new KernelStorageAdapter({
    client,
    hostId: "working-state-test-host",
    storageRoot,
    resolveWorkspaceRoot: async () => workspace,
    resolveActor: async (_workspace, _purpose, hint) => {
      resolvedActorHints.push({
        ...(hint?.sessionId ? { sessionId: hint.sessionId } : {}),
        ...(hint?.threadId ? { threadId: hint.threadId } : {}),
        ...(hint?.runId ? { runId: hint.runId } : {}),
      });
      if (hint?.capabilities?.includes("storage.maintenance")) return hint;
      assert.equal(hint?.sessionId, sessionId);
      assert.equal(hint?.threadId, "working-state");
      assert.equal(hint?.runId, "run-working-state");
      return {
        ...hint,
        authorityInstanceId: "working-state-authority",
        workerId: "working-state-worker",
        workerGeneration: 4,
        owningWorkspace: workspaceId,
        executionWorkspace: workspaceId,
        pathScopes: [""],
      };
    },
  });
  adapter.bindFileStore(new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache")));
  try {
    await client.start();
    const access = createKernelWorkspaceWorkingStateAccess(adapter);
    await access.withBranchStore(workspaceId, "test-duplicate-owner-release", async (store) => {
      const provenance = { baseRevision: null, encoding: "utf-8", bom: false, localEditRevision: 1, revision: "draft-1" };
      const draft = await store.createDraftBaseline(workspaceId, [
        { path: "same-a.txt", content: "same draft body\n", provenance },
        { path: "same-b.txt", content: "same draft body\n", provenance },
      ]);
      await store.deleteDraftBaseline(draft.id);
      const first = await store.putObject(Buffer.from("same branch body\n"));
      const second = await store.putObject(Buffer.from("same branch body\n"));
      assert.equal(first.hash, second.hash);
      const state = { kind: "regular-file" as const, objectHash: first.hash, byteLength: first.byteLength };
      await store.createBranch(workspaceId, "duplicate-content-branch", { "a.txt": state, "b.txt": state }, "duplicate-base");
      await store.deleteBranch("duplicate-content-branch");
    });
    const ownerAudit = await adapter.context(workspaceId, "test-duplicate-owner-audit", {
      owningWorkspace: workspaceId, executionWorkspace: workspaceId, pathScopes: [""], capabilities: ["storage.maintenance"],
    });
    assert.equal((await ownerAudit.client.health()).temporaryObjectOwners, 0);
    let baseMode: number | undefined;
    await access.withBranchStore(workspaceId, "test-create", async (store) => {
      const base = await store.captureDirectory(workspace);
      baseMode = base["mode.txt"]?.kind === "regular-file" ? base["mode.txt"].mode : undefined;
      await store.createBranch(workspaceId, branchId, base, "disk-base", ["draft-only.ts"], ["src"]);
    });
    await access.withBranchStore(workspaceId, "test-validate-branch-metadata", async (store) => {
      const base = await store.captureDirectory(workspace);
      const existing = await store.createBranch(workspaceId, branchId, base, "disk-base", ["draft-only.ts"], ["src"]);
      assert.equal(existing.baseRef, "disk-base");
      assert.deepEqual(existing.draftBasePaths, ["draft-only.ts"]);
      assert.deepEqual(existing.captureScopes, ["src"]);
      await assert.rejects(
        store.createBranch(workspaceId, branchId, base, "other-base", ["draft-only.ts"], ["src"]),
        /different parameters|creation identity/i,
      );
    });

    const views = new ThreadExecutionViewRegistry();
    views.bind({
      sessionId,
      workspaceId,
      threadId: "working-state",
      runId: "run-working-state",
      branchId,
      revision: 0,
      writeRevision: 0,
      mode: "virtual",
      draftBasePaths: [],
    });
    const lookups = createWorkingBranchLookups({ views, workingStates: access });
    const writes = createWorkingBranchWriteServices({ views, workingStates: access, writeGate: new VirtualWriteGate() });

    await fs.writeFile(path.join(workspace, "mode.txt"), "parent drift\n");
    const fixed = await lookups.readSource(sessionId, "mode.txt", workspaceId);
    assert.equal(fixed?.status, "working-branch");
    assert.equal(fixed && fixed.status === "working-branch" && fixed.base64
      ? Buffer.from(fixed.base64, "base64").toString("utf8")
      : null, "base body\n");

    const rewritten = await writes.branchWrite(sessionId, [{ workspaceId, resourceId: "mode.txt", action: "write", content: "pinned body\n" }]);
    assert.equal(rewritten.status, "committed");
    const nested = await writes.branchWrite(sessionId, [{ workspaceId, resourceId: "new/deep/file.ts", action: "write", content: "new branch file\n" }]);
    assert.equal(nested.status, "committed");
    const stale = await writes.branchWrite(sessionId, [{ workspaceId, resourceId: "stale.ts", action: "write", content: "stale\n" }], 0);
    assert.equal(stale.status, "conflict");
    const blocked = await writes.branchWrite(sessionId, [{ workspaceId, resourceId: "mode.txt/child.ts", action: "write", content: "blocked\n" }]);
    assert.equal(blocked.status, "rejected");

    await access.withBranchStore(workspaceId, "test-invariants", async (store) => {
      const mode = await store.readPath(branchId, "mode.txt");
      assert.equal(mode?.state.kind, "regular-file");
      if (mode?.state.kind === "regular-file") assert.equal(mode.state.mode, baseMode);
      assert.equal((await store.readPath(branchId, "new"))?.state.kind, "directory");
    }, "shared");

    const pinnedRoot = await access.withBranchStore(workspaceId, "test-pin-root", (store) => store.getBranchRoot(branchId), "shared");
    assert.ok(pinnedRoot);
    const controller = new AbortController();
    const pinned = await lookups.pinQuery(sessionId, { roots: [""], signal: controller.signal, deadlineAt: Date.now() + 10_000 });
    assert.ok(pinned);
    assert.equal(pinned.root, pinnedRoot.root);
    assert.equal(pinned.writeRevision, 2);
    assert.equal((await pinned.readFile("mode.txt")).status, "ready");
    assert.equal((await pinned.readFile("mode.txt") as { status: "ready"; content: string }).content, "pinned body\n");
    const scoped = await lookups.pinQuery(sessionId, { roots: ["src"], deadlineAt: Date.now() + 10_000 });
    assert.deepEqual((await scoped?.listFiles())?.map((file) => file.path), ["src/nested.ts"]);
    await scoped?.release();

    const later = await writes.branchWrite(sessionId, [{ workspaceId, resourceId: "mode.txt", action: "write", content: "later body\n" }]);
    assert.equal(later.status, "committed");
    await access.withBranchStore(workspaceId, "test-slice-content-source", async (store) => {
      const slice = await store.readStateSlice(branchId, ["mode.txt"]);
      const state = slice?.["mode.txt"];
      assert.equal(state?.kind, "regular-file");
      if (state?.kind === "regular-file") {
        assert.equal((await store.getObject(state.objectHash))?.toString("utf8"), "later body\n");
      }
      const provenancePin = await store.pinBranch(branchId);
      try {
        await assert.rejects(
          store.readPath("another-branch", "mode.txt", { pin: provenancePin }),
          /does not belong/i,
        );
      } finally {
        await provenancePin.release();
      }
    }, "shared");
    const pinnedRead = await pinned.readFile("mode.txt");
    assert.equal(pinnedRead.status, "ready");
    if (pinnedRead.status === "ready") assert.equal(pinnedRead.content, "pinned body\n");
    controller.abort();
    await pinned.release();
    const verification = await adapter.context(workspaceId, "test-pin-release", {
      owningWorkspace: workspaceId,
      executionWorkspace: workspaceId,
      sessionId,
      threadId: "working-state",
      runId: "run-working-state",
      pathScopes: [""],
    });
    await assert.rejects(verification.client.readPin({ pinId: pinned.pinId }), /pin not found/i);
    await assert.rejects(
      verification.resourceOperationGate.run([], async () => "unexpected"),
      /operation gate is not bound/i,
    );

    const published = await access.withBranchStore(workspaceId, "test-publish", (store) => store.publishHeadResult(branchId));
    assert.equal(published.root?.startsWith("sha256-"), true);

    await fs.writeFile(path.join(workspace, "mode.txt"), "base body\n");
    const reverted = await access.withBranchStore(workspaceId, "test-revert", (store) => store.publishDirectoryResult(branchId, workspace));
    assert.deepEqual(reverted.changedPaths, []);
    await access.withBranchStore(workspaceId, "test-reverted-root", async (store) => {
      const branch = await store.getBranchRoot(branchId);
      assert.ok(branch);
      const currentTree = await store.listPaths(branchId, [""]);
      const baseTree = await store.listPaths(branchId, [""], { revision: 0 });
      assert.deepEqual(currentTree?.entries.map(({ path, state }) => ({ path, state })), baseTree?.entries.map(({ path, state }) => ({ path, state })));
      assert.equal(branch.root, branch.baseRoot);
      assert.equal(reverted.root, branch.root);
      assert.equal((await store.readPath(branchId, "mode.txt"))?.origin, "base");
      assert.equal((await store.readPath(branchId, "new/deep/file.ts"))?.state.kind, "missing");
    }, "shared");
    assert.ok(resolvedActorHints.some((hint) => hint.sessionId === sessionId && hint.threadId === "working-state" && hint.runId === "run-working-state"));
  } finally {
    await adapter.dispose().catch(() => undefined);
    await client.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(!hasReleaseKernel)("composes the kernel branch authority with the durable integration journal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-integration-"));
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  const dataDir = path.join(root, "data");
  const workspaceId = "kernel-integration-workspace";
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "base.txt"), "base\n");
  const documents: CreateWorkspaceRecoveryEngineOptions["documents"] = {
    inspectWorkspace: async () => ({ root: workspace, workspaceId }),
    listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId }],
    beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
    inspectDirtyBuffers: async () => [],
    runResourceOperation: async (_workspace, _resources, operation) => operation(),
  };
  const client = createKernelClient({
    hostId: "kernel-integration-test-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  const adapter = new KernelStorageAdapter({
    client,
    hostId: "kernel-integration-test-host",
    storageRoot,
    resolveWorkspaceRoot: async () => workspace,
  });
  const content = new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache"));
  adapter.bindFileStore(content);
  const kernelRecoveryStore = new KernelRecoveryStore(adapter, content);
  const baseEngine = createWorkspaceRecoveryEngine({
    authorityId: "kernel-integration-test",
    dataDir,
    documents,
    durableRecoveryStore: kernelRecoveryStore,
    fileStore: content,
    sessionNavigation: {
      prepare: async () => ({ expectedLeafId: null, targetLeafId: null }),
      prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
      commit: async () => ({}),
      commitLeaf: async () => ({}),
    },
  });
  const engine = createKernelRecoveryDirectFacade(baseEngine, kernelRecoveryStore);
  try {
    await client.start();
    const access = createKernelWorkspaceWorkingStateAccess(adapter, engine, kernelRecoveryStore);
    const result = await access.withBranchStore(workspaceId, "integration-setup", async (store) => {
      const base = await store.captureDirectory(workspace);
      await store.createBranch(workspaceId, "parent-branch", base, "base");
      await store.createBranch(workspaceId, "child-branch", base, "parent-branch@0");
      const object = await store.putObject(Buffer.from("child\n"));
      const written = await store.commitVirtualWrites("child-branch", 0, {
        "child.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength },
      });
      assert.equal(written.status, "committed");
      return store.publishHeadResult("child-branch");
    });
    const merged = await new IntegrationCoordinator({ workingStates: access }).mergeResult({
      workspaceId,
      threadId: "child-thread",
      branchId: "child-branch",
      resultRevision: result.resultRevision,
      parentAuthority: { kind: "branch", branchId: "parent-branch" },
    });
    assert.equal(merged.status, "applied");
    await access.withBranchStore(workspaceId, "integration-assert", async (store) => {
      const durable = await kernelRecoveryStore.getOperation(workspaceId, merged.operationId);
      assert.equal(durable?.state, "complete");
      const entry = await store.readPath("parent-branch", "child.txt");
      assert.equal(entry?.state.kind, "regular-file");
      if (entry?.state.kind === "regular-file") assert.equal((await store.readContent(entry))?.toString("utf8"), "child\n");
    }, "shared");
  } finally {
    await adapter.dispose().catch(() => undefined);
    await client.close().catch(() => undefined);
    await engine.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!hasReleaseKernel)("uses Rust operation phases for dirty surface integration and undo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-surface-integration-"));
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  const dataDir = path.join(root, "data");
  const workspaceId = "kernel-surface-workspace";
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "a.txt"), "base\n");
  const documents: CreateWorkspaceRecoveryEngineOptions["documents"] = {
    inspectWorkspace: async () => ({ root: workspace, workspaceId }),
    listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId }],
    beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
    inspectDirtyBuffers: async () => [],
    runResourceOperation: async (_workspace, _resources, operation) => operation(),
  };
  const client = createKernelClient({ hostId: "kernel-surface-host", storageRoot, buildVersion, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: "kernel-surface-host", storageRoot, resolveWorkspaceRoot: async () => workspace });
  const content = new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache"));
  adapter.bindFileStore(content);
  const kernelRecoveryStore = new KernelRecoveryStore(adapter, content);
  const baseEngine = createWorkspaceRecoveryEngine({
    authorityId: "kernel-surface-test",
    dataDir,
    documents,
    durableRecoveryStore: kernelRecoveryStore,
    fileStore: content,
    sessionNavigation: { prepare: async () => ({ expectedLeafId: null, targetLeafId: null }), prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }), commit: async () => ({}), commitLeaf: async () => ({}) },
  });
  const engine = createKernelRecoveryDirectFacade(baseEngine, kernelRecoveryStore);
  const surfaceHash = (value: string) => `sha256-${createHash("sha256").update(value, "utf8").digest("hex")}`;
  try {
    await client.start();
    const access = createKernelWorkspaceWorkingStateAccess(adapter, engine, kernelRecoveryStore);
    const result = await access.withBranchStore(workspaceId, "surface-setup", async (store) => {
      const base = await store.captureDirectory(workspace);
      await store.createBranch(workspaceId, "surface-parent", base, "base");
      await store.createBranch(workspaceId, "surface-child", base, "surface-parent@0");
      const object = await store.putObject(Buffer.from("child\n"));
      const baseMode = base["a.txt"]?.kind === "regular-file" ? base["a.txt"].mode : undefined;
      await store.commitVirtualWrites("surface-child", 0, { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(baseMode === undefined ? {} : { mode: baseMode }) } });
      return store.publishHeadResult("surface-child");
    });
    const baseHash = surfaceHash("base\n");
    const childHash = surfaceHash("child\n");
    const requestSurfaceOperation = async (request: { action: string; targets: Array<{ resource: { resourceId: string }; documentInstanceId: string; beforeLocalEditRevision?: number; localEditRevision?: number; beforeHash?: string; bufferHash?: string; afterLocalEditRevision?: number; afterHash?: string }> }) => {
      return request.targets.map((target) => {
        const revision = target.beforeLocalEditRevision ?? target.localEditRevision ?? 1;
        const hash = target.beforeHash ?? target.bufferHash ?? baseHash;
        if (request.action === "capture") return { resource: target.resource, status: "captured" as const, content: "base\n", documentInstanceId: target.documentInstanceId, beforeLocalEditRevision: revision, beforeHash: hash };
        if (request.action === "undo") return { resource: target.resource, status: "undone" as const, documentInstanceId: target.documentInstanceId, afterLocalEditRevision: revision, afterHash: baseHash };
        return { resource: target.resource, status: "applied" as const, documentInstanceId: target.documentInstanceId, beforeLocalEditRevision: revision, beforeHash: hash, afterLocalEditRevision: revision + 1, afterHash: childHash };
      });
    };
    const publication = { ownerId: "surface-owner", generation: 1, registrationId: "surface-registration", resources: [{ baseRevision: null, localEditRevision: 1, resource: { resourceId: "a.txt" }, documentInstanceId: "surface-document", bufferHash: baseHash, encoding: "utf-8", bom: false, lineEnding: "lf" as const }] };
    const coordinator = new IntegrationCoordinator({ workingStates: access, inspectDirtyBuffers: async () => [publication], requestSurfaceOperation: requestSurfaceOperation as never });
    const merged = await coordinator.mergeResult({ workspaceId, threadId: "surface-thread", branchId: "surface-child", resultRevision: result.resultRevision, sourceOwner: { ownerId: "surface-owner", generation: 1 } });
    assert.equal(merged.status, "applied");
    const operation = await kernelRecoveryStore.getOperation(workspaceId, merged.operationId);
    assert.equal(operation?.state, "complete");
    const undone = await coordinator.undoIntegration({ workspaceId, threadId: "surface-thread", operationId: merged.operationId, sourceOwner: { ownerId: "surface-owner", generation: 1 } });
    assert.equal(undone.status, "compensated");
    const afterUndo = await kernelRecoveryStore.getOperation(workspaceId, merged.operationId);
    assert.equal(afterUndo?.state, "undone");
  } finally {
    await adapter.dispose().catch(() => undefined);
    await client.close().catch(() => undefined);
    await engine.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!hasReleaseKernel)("publishes a pinned virtual root without mixing a concurrent write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-publish-race-"));
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  const workspaceId = "kernel-publish-race-workspace";
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "a.txt"), "base\n");
  const client = createKernelClient({ hostId: "kernel-publish-race-host", storageRoot, buildVersion, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: "kernel-publish-race-host", storageRoot, resolveWorkspaceRoot: async () => workspace });
  adapter.bindFileStore(new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache")));
  try {
    await client.start();
    const access = createKernelWorkspaceWorkingStateAccess(adapter);
    await access.withBranchStore(workspaceId, "publish-race-setup", async (store) => {
      const base = await store.captureDirectory(workspace);
      await store.createBranch(workspaceId, "publish-race", base, "base");
      const object = await store.putObject(Buffer.from("one\n"));
      const baseMode = base["a.txt"]?.kind === "regular-file" ? base["a.txt"].mode : undefined;
      const committed = await store.commitVirtualWrites("publish-race", 0, { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(baseMode === undefined ? {} : { mode: baseMode }) } });
      assert.equal(committed.status, "committed");
    });
    const context = await adapter.context(workspaceId, "publish-race-context");
    const store = new KernelWorkingStateRootStore(context);
    const writer = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const object = await store.putObject(Buffer.from("two\n"));
      const result = await store.commitVirtualWrites("publish-race", 1, { "a.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength } });
      return result;
    })();
    const published = await store.publishHeadResult("publish-race").catch((error: unknown) => error);
    const write = await writer;
    assert.equal(write.status, "committed");
    if (published instanceof Error) {
      assert.match(published.message, /changed|conflict|publishing/i);
      return;
    }
    const result = published as { root: string; changedPaths: string[]; pathStates: Record<string, { kind: string; objectHash?: string }> };
    assert.equal(result.changedPaths.includes("a.txt"), true);
    const state = result.pathStates["a.txt"];
    assert.equal(state?.kind, "regular-file");
    const body = state?.objectHash ? await store.getObject(state.objectHash) : null;
    assert.ok(body);
    assert.equal(body?.toString("utf8"), "one\n");
    const current = await store.getBranchRoot("publish-race");
    assert.ok(current);
    assert.notEqual(current?.root, result.root);
  } finally {
    await adapter.dispose().catch(() => undefined);
    await client.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!hasReleaseKernel)("reconciles a branch CAS after the terminal response is lost and the Host restarts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-branch-reconcile-"));
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  const dataDir = path.join(root, "data");
  const workspaceId = "session:kernel-branch-reconcile-task";
  const documentWorkspaceId = "kernel-branch-reconcile-workspace";
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "base.txt"), "base\n");
  await fs.writeFile(path.join(workspace, "src", "api.ts"), "first=old\nkeep1\nkeep2\nlast=old\n");
  const documents: CreateWorkspaceRecoveryEngineOptions["documents"] = {
    inspectWorkspace: async id => { assert.equal(id, documentWorkspaceId); return { root: workspace, workspaceId: documentWorkspaceId }; },
    listWorkspaceRegistrations: async () => [{ canonicalPath: workspace, workspaceId }],
    beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
    inspectDirtyBuffers: async () => [],
    runResourceOperation: async (_workspace, _resources, operation) => operation(),
  };
  const client = createKernelClient({ hostId: "kernel-branch-reconcile-host", storageRoot, buildVersion, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: "kernel-branch-reconcile-host", storageRoot, resolveWorkspaceRoot: async () => workspace });
  const content = new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache"));
  adapter.bindFileStore(content);
  const kernelRecoveryStore = new KernelRecoveryStore(adapter, content);
  const baseEngine = createWorkspaceRecoveryEngine({
    authorityId: "kernel-branch-reconcile-test",
    dataDir,
    documents,
    durableRecoveryStore: kernelRecoveryStore,
    fileStore: content,
    sessionNavigation: { prepare: async () => ({ expectedLeafId: null, targetLeafId: null }), prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }), commit: async () => ({}), commitLeaf: async () => ({}) },
  });
  const engine = createKernelRecoveryDirectFacade(baseEngine, kernelRecoveryStore);
  try {
    await client.start();
    const access = createKernelWorkspaceWorkingStateAccess(adapter, engine, kernelRecoveryStore, async () => documentWorkspaceId);
    const result = await access.withBranchStore(workspaceId, "branch-reconcile-setup", async (store) => {
      const base = await store.captureDirectory(workspace);
      await store.createBranch(workspaceId, "reconcile-parent", base, "base");
      await store.createBranch(workspaceId, "reconcile-child", base, "reconcile-parent@0");
      const object = await store.putObject(Buffer.from("child\n"));
      await store.commitVirtualWrites("reconcile-child", 0, { "child.txt": { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength } });
      const body = await store.putObject(Buffer.from("first=new\nkeep1\nkeep2\nlast=new\n"));
      const mode = base["src/api.ts"]?.kind === "regular-file" ? base["src/api.ts"].mode : undefined;
      const selected = await selectCodeChanges(store, [{ path: "src/api.ts", edits: [{ before: "first=old\n", after: "first=new\n" }] }], base, { "src/api.ts": { kind: "regular-file", objectHash: body.hash, byteLength: body.byteLength, ...(mode === undefined ? {} : { mode }) } });
      assert.equal((await store.commitVirtualWrites("reconcile-child", 1, selected)).status, "committed");
      return store.publishHeadResult("reconcile-child");
    });
    const coordinator = new IntegrationCoordinator({ workingStates: access, resolveDocumentWorkspaceId: async () => documentWorkspaceId });
    const originalComplete = kernelRecoveryStore.completeOperation.bind(kernelRecoveryStore);
    let lost = true;
    kernelRecoveryStore.completeOperation = async (input) => {
      if (lost && input.state === "complete") {
        lost = false;
        throw new Error("simulated lost terminal response");
      }
      return originalComplete(input);
    };
    await assert.rejects(
      coordinator.mergeResult({ workspaceId, operationId: "selected-native-once", threadId: "reconcile-thread", branchId: "reconcile-child", resultRevision: result.resultRevision, parentAuthority: { kind: "branch", branchId: "reconcile-parent" } }),
      /lost terminal response/i,
    );
    const pending = (await kernelRecoveryStore.listOperations(workspaceId, "integration")).find((entry) => String(entry.state) === "applying");
    assert.ok(pending);
    kernelRecoveryStore.completeOperation = originalComplete;
    const restartedCoordinator = new IntegrationCoordinator({ workingStates: access, resolveDocumentWorkspaceId: async () => documentWorkspaceId });
    await restartedCoordinator.mergeResult({ workspaceId, operationId: "selected-native-once", threadId: "reconcile-thread", branchId: "reconcile-child", resultRevision: result.resultRevision, parentAuthority: { kind: "branch", branchId: "reconcile-parent" } });
    const reconciled = await kernelRecoveryStore.getOperation(workspaceId, String(pending?.operationId));
    assert.equal(reconciled?.state, "complete");
    await access.withBranchStore(workspaceId, "recipient-edit-after-receipt", async store => {
      const entry = await store.readPath("reconcile-parent", "src/api.ts");
      assert.ok(entry);
      assert.equal((await store.readContent(entry))?.toString(), "first=new\nkeep1\nkeep2\nlast=old\n");
      const body = await store.putObject(Buffer.from("recipient edit\n"));
      const parent = await store.getBranchRoot("reconcile-parent");
      assert.equal((await store.commitVirtualWrites("reconcile-parent", parent!.writeRevision, { "child.txt": { kind: "regular-file", objectHash: body.hash, byteLength: body.byteLength } })).status, "committed");
    });
    assert.equal((await restartedCoordinator.mergeResult({ workspaceId, operationId: "selected-native-once", threadId: "reconcile-thread", branchId: "reconcile-child", resultRevision: result.resultRevision, parentAuthority: { kind: "branch", branchId: "reconcile-parent" } })).status, "applied");
    await access.withBranchStore(workspaceId, "unchanged-recipient-after-retry", async store => {
      const entry = await store.readPath("reconcile-parent", "child.txt");
      assert.ok(entry); assert.equal((await store.readContent(entry))?.toString(), "recipient edit\n");
    });
  } finally {
    await adapter.dispose().catch(() => undefined);
    await client.close().catch(() => undefined);
    await engine.dispose().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
