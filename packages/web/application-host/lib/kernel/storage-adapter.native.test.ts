import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { IntegrationCoordinator } from "../harness/working-state/integration-coordinator.js";
import { createWorkspaceRecoveryEngine, type CreateWorkspaceRecoveryEngineOptions } from "../recovery/journal-engine.js";
import { createKernelClient } from "./kernel-client.js";
import { createKernelWorkspaceWorkingStateAccess, KernelStorageAdapter, KernelWorkingStateRootStore } from "./storage-adapter.js";
import { KernelRecoveryContentStore, KernelRecoveryStore, createKernelRecoveryDirectFacade } from "./kernel-recovery-store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repositoryRoot, "kernel", "target", "release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const hasReleaseKernel = await fs.stat(kernelPath).then(() => true).catch(() => false);
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;

it.skipIf(!hasReleaseKernel)("forks the exact pinned namespace and applies path transactions without a physical execution copy", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-namespace-"));
  const storageRoot = path.join(root, "storage");
  const workspaceId = "namespace-workspace";
  const client = createKernelClient({ hostId: "namespace-host", storageRoot, buildVersion, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: "namespace-host", storageRoot, resolveWorkspaceRoot: async () => root });
  try {
    await client.start();
    const context = await adapter.context(workspaceId, "namespace-context");
    const store = new KernelWorkingStateRootStore(context);
    await store.createBranch(workspaceId, "parent", {}, "base");
    const pin = await store.pinBranch("parent");
    try {
      const bytes = Buffer.from("parent keeps working\n");
      const object = await context.client.putBlob(bytes, "parent-body");
      const state = { kind: "regular-file" as const, objectHash: object.hash, byteLength: object.byteLength, mode: 0o644 };
      assert.equal((await context.client.applyBranchPaths({ operationId: "parent-write", branchId: "parent",
        changes: [{ path: "src/a.txt", expectedState: { kind: "missing" }, state, ownerId: object.ownerId }] })).status, "committed");
      await store.createBranchFromPin(workspaceId, "child", pin, "parent@0");
      assert.equal((await context.client.inspectBranchPath({ branchId: "child", path: "src/a.txt" })).state.kind, "missing");

      const directory = await context.client.inspectBranchPath({ branchId: "parent", path: "src" });
      assert.equal(directory.state.kind, "directory");
      assert.ok(directory.node);
      const rename = { operationId: "move-src", branchId: "parent", sourcePath: "src", path: "renamed",
        expectedSourceNode: directory.node!, expectedTargetNode: null };
      const moved = await context.client.renameBranchPath(rename);
      assert.equal(moved.status, "committed");
      assert.deepEqual(await context.client.renameBranchPath(rename), moved);
      assert.equal((await context.client.inspectBranchPath({ branchId: "parent", path: "renamed" })).node, directory.node);
      const read = await context.client.getBlob(object.hash, { branchId: "parent", path: "renamed/a.txt" });
      assert.deepEqual(Buffer.from(read.bytesBase64, "base64"), bytes);
      assert.equal((await context.client.applyBranchPaths({ operationId: "stale-parent-write", branchId: "parent",
        changes: [{ path: "renamed/a.txt", expectedState: { kind: "missing" }, state: { kind: "missing" } }] })).status, "conflict");
      assert.equal((await fs.readdir(storageRoot)).includes("managed"), false);
      await assert.rejects(fs.stat(path.join(root, "src")), { code: "ENOENT" });
    } finally { await pin.release(); }
  } finally { await adapter.dispose(); await client.close(); await fs.rm(root, { recursive: true, force: true }); }
});

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
      const body = await store.putObject(Buffer.from("first=new\nkeep1\nkeep2\nlast=old\n"));
      const mode = base["src/api.ts"]?.kind === "regular-file" ? base["src/api.ts"].mode : undefined;
      const selected = { "src/api.ts": { kind: "regular-file" as const, objectHash: body.hash, byteLength: body.byteLength, ...(mode === undefined ? {} : { mode }) } };
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
    await restartedCoordinator.recoverIntegration({ workspaceId, operationId: "selected-native-once", threadId: "reconcile-thread", branchId: "reconcile-child", resultRevision: result.resultRevision, parentAuthority: { kind: "branch", branchId: "reconcile-parent" }, executorStopped: true });
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
