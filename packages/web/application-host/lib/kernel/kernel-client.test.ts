import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createKernelClient, KernelClient } from "./kernel-client.js";
import type { KernelGrantHandle } from "./kernel-client.js";
import { KernelStorageAdapter } from "./storage-adapter.js";
import { KernelPathLockService } from "./file-resource-lock-service.js";
import { KernelRecoveryContentStore, KernelRecoveryStore, createKernelRecoveryDirectFacade } from "./kernel-recovery-store.js";
import { createWorkspaceRecoveryEngine } from "../recovery/journal-engine.js";

const extension = process.platform === "win32" ? ".exe" : "";
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.resolve(process.cwd(), "kernel", "target", "release", `varin-kernel${extension}`);
const buildVersion = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "package.json"), "utf8")).version as string;
const clients: KernelClient[] = [];
const roots: string[] = [];

const issueActor = async (client: KernelClient, grantId: string, workspaceId: string | null, pathScopes: string[] = [""], extraCapabilities: string[] = []): Promise<KernelGrantHandle> => client.issueGrant({
  grantId,
  hostGeneration: client.handshake?.hostGeneration,
  sessionId: null,
  threadId: null,
  runId: null,
  owningWorkspace: workspaceId,
  executionWorkspace: workspaceId,
  storageIdentity: client.handshake?.storageRoot,
  capabilities: ["storage.read", "storage.write", "recovery", "storage.gc", ...extraCapabilities],
  pathScopes,
});

const issueSessionActor = async (client: KernelClient, grantId: string, workspaceId: string, sessionId: string): Promise<KernelGrantHandle> => client.issueGrant({
  grantId,
  hostGeneration: client.handshake?.hostGeneration,
  sessionId,
  threadId: null,
  runId: null,
  owningWorkspace: workspaceId,
  executionWorkspace: workspaceId,
  storageIdentity: client.handshake?.storageRoot,
  capabilities: ["storage.read", "storage.write", "recovery", "storage.gc"],
  pathScopes: [""],
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

test("real Rust kernel persists roots, CAS revisions, pins, and objects", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-test-"));
  roots.push(root);
  const host = createKernelClient({
    hostId: "kernel-test-host",
    storageRoot: root,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  clients.push(host);
  const handshake = await host.start();
  const client = host.scoped(await issueActor(host, "kernel-test-actor", "workspace-test"));
  assert.equal(handshake.protocolVersion, 1);
  const first = await client.putBlob(Buffer.from("one\n"), "op-blob-one");
  const large = await client.putBlob(Buffer.alloc(200_000, 7), "op-blob-large");
  assert.equal(large.byteLength, 200_000);
  assert.equal((await client.releaseBlob(large.ownerId)).released, true);
  const created = await client.createBranch({
    operationId: "op-create",
    branchId: "branch-test",
    workspaceId: "workspace-test",
    parentRef: "workspace-head:1",
    draftBasePaths: ["src/file.txt"],
    captureScopes: ["vendor/cache"],
    entries: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash, mode: 0o644 }, ownerId: first.ownerId }],
  });
  const forked = await client.createBranch({
    operationId: "op-fork",
    branchId: "branch-fork",
    workspaceId: "workspace-test",
    draftBasePaths: [], captureScopes: [], entries: [],
    baseRef: String(created.root),
  });
  assert.equal(forked.root, created.root);
  const initial = await client.readBranch({ branchId: "branch-test", includeEntries: true });
  assert.equal(initial.entries.length, 1);
  assert.equal(initial.entries[0]?.path, "src/file.txt");
  assert.equal(initial.parentRef, "workspace-head:1");
  assert.deepEqual(initial.draftBasePaths, ["src/file.txt"]);
  assert.deepEqual(initial.captureScopes, ["vendor/cache"]);
  assert.equal(Number.isSafeInteger(initial.createdAt), true);
  assert.equal(Number.isSafeInteger(initial.updatedAt), true);
  const reopenedCreate = await client.createBranch({
    operationId: "op-create-semantic-retry",
    branchId: "branch-test",
    workspaceId: "workspace-test",
    parentRef: "workspace-head:1",
    draftBasePaths: ["src/file.txt"],
    captureScopes: ["vendor/cache"],
    entries: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash, mode: 0o644 } }],
  });
  assert.equal(reopenedCreate.created, false);
  assert.equal(reopenedCreate.root, created.root);
  const normalized = await client.readBranch({ branchId: "branch-test", paths: ["src\\file.txt"] });
  assert.equal(normalized.entries[0]?.path, "src/file.txt");
  assert.equal((await client.health({ deep: false })).integrity, "ok");
  await assert.rejects(
    client.createBranch({ operationId: "op-create", branchId: "operation-reuse", workspaceId: "workspace-test", draftBasePaths: [], captureScopes: [], entries: [] }),
    /operationId.*reused|different parameters/i,
  );
  await assert.rejects(client.createBranch({ operationId: "op-create-different", branchId: "branch-test", workspaceId: "workspace-test", draftBasePaths: [], captureScopes: [], entries: [] }), /creation parameters/i);
  assert.equal((await client.health({ deep: true })).integrity, "ok");
  await assert.rejects(
    client.createBranch({
      operationId: "op-invalid-state",
      branchId: "invalid-state",
      workspaceId: "workspace-test",
      draftBasePaths: [], captureScopes: [], entries: [{ path: "a", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash } } as never],
    }),
    /invalid path state|mode/i,
  );
  await assert.rejects(
    client.createBranch({
      operationId: "op-invalid-tree",
      branchId: "invalid-tree",
      workspaceId: "workspace-test",
      draftBasePaths: [], captureScopes: [], entries: [
        { path: "a", state: { kind: "regular-file", byteLength: first.byteLength, objectHash: first.hash, mode: 0o644 } },
        { path: "a/b", state: { kind: "directory", mode: 0o755 } },
      ],
    }),
    /non-directory|descendant/i,
  );
  const treeBlob = await client.putBlob(Buffer.from("tree\n"), "op-tree-blob");
  await client.createBranch({
    operationId: "op-tree-invariant",
    branchId: "tree-invariant",
    workspaceId: "workspace-test",
    draftBasePaths: [], captureScopes: [], entries: [
      { path: "a", state: { kind: "directory", mode: 0o755 } },
      { path: "a/b", state: { kind: "regular-file", byteLength: treeBlob.byteLength, objectHash: treeBlob.hash, mode: 0o644 }, ownerId: treeBlob.ownerId },
    ],
  });
  await client.writeBranch({
    operationId: "op-tree-replace",
    branchId: "tree-invariant",
    expectedWriteRevision: 0,
    changes: [{ path: "a", state: { kind: "regular-file", byteLength: treeBlob.byteLength, objectHash: treeBlob.hash, mode: 0o755 }, sourcePath: "a/b" }],
  });
  const replaced = await client.readBranch({ branchId: "tree-invariant", includeEntries: true });
  assert.deepEqual(replaced.entries.map((entry) => entry.path), ["a"]);
  await assert.rejects(
    client.writeBranch({
      operationId: "op-tree-invalid-descendant",
      branchId: "tree-invariant",
      expectedWriteRevision: 1,
      changes: [{ path: "a/b", state: { kind: "missing" } }],
    }),
    /non-directory|descendant/i,
  );
  await client.deleteBranch({ operationId: "op-tree-delete", branchId: "tree-invariant" });
  const second = await client.putBlob(Buffer.from("two\n"), "op-blob-two");
  const committed = await client.writeBranch({
    operationId: "op-write",
    branchId: "branch-test",
    expectedWriteRevision: 0,
    changes: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: second.byteLength, objectHash: second.hash, mode: 0o755 }, ownerId: second.ownerId }],
  });
  assert.equal(committed.status, "committed");
  await assert.rejects(
    client.writeBranch({
      operationId: "op-write",
      branchId: "branch-test",
      expectedWriteRevision: 1,
      changes: [{ path: "src/reused.txt", state: { kind: "directory" } }],
    }),
    /operationId.*reused|different parameters/i,
  );
  const conflict = await client.writeBranch({
    operationId: "op-write-stale",
    branchId: "branch-test",
    expectedWriteRevision: 0,
    changes: [{ path: "src/other.txt", state: { kind: "directory" } }],
  });
  assert.equal(conflict.status, "conflict");
  const stalePublish = await client.publishBranch({
    operationId: "op-publish-stale",
    branchId: "branch-test",
    expectedWriteRevision: 0,
    expectedRoot: String(created.root),
  });
  assert.equal(stalePublish.status, "conflict");
  const published = await client.publishBranch({ operationId: "op-publish", branchId: "branch-test", expectedWriteRevision: committed.writeRevision, expectedRoot: committed.root });
  const pin = await client.pinBranch({ operationId: "op-pin", branchId: "branch-test", revision: Number(published.revision) });
  assert.equal(pin.pinned, true);
  const operation = await client.getOperation("op-publish");
  assert.equal(operation?.state, "committed");
  const snapshot = await client.snapshot("workspace-test");
  assert.equal((snapshot.branches as unknown[]).length, 2);
  const third = await client.putBlob(Buffer.from("three\n"), "op-blob-three");
  const afterPublishWrite = await client.writeBranch({
    operationId: "op-write-after-publish",
    branchId: "branch-test",
    expectedWriteRevision: 1,
    changes: [{ path: "src/file.txt", state: { kind: "regular-file", byteLength: third.byteLength, objectHash: third.hash, mode: 0o644 }, ownerId: third.ownerId }],
  });
  assert.equal(afterPublishWrite.status, "committed");
  const fixed = await client.readBranch({ branchId: "branch-test", revision: Number(published.revision), includeEntries: true });
  const changed = await client.readBranch({ branchId: "branch-test", includeEntries: true });
  assert.equal((fixed.entries[0]?.state as { objectHash?: string }).objectHash, second.hash);
  assert.equal((changed.entries[0]?.state as { objectHash?: string }).objectHash, third.hash);
  assert.equal((changed.entries[0]?.state as { mode?: number }).mode, 0o644);
  const temporary = await client.putBlob(Buffer.from("temporary\n"), "op-blob-temporary");
  const withTemporary = await client.writeBranch({
    operationId: "op-write-temporary",
    branchId: "branch-test",
    expectedWriteRevision: 2,
    changes: [{ path: "src/temporary.txt", state: { kind: "regular-file", byteLength: temporary.byteLength, objectHash: temporary.hash, mode: 0o644 }, ownerId: temporary.ownerId }],
  });
  const currentPin = await client.pinBranch({
    operationId: "op-pin-current",
    branchId: "branch-test",
    expectedWriteRevision: withTemporary.writeRevision,
    expectedRoot: withTemporary.root,
  });
  assert.equal(currentPin.view, "current");
  assert.equal(currentPin.writeRevision, withTemporary.writeRevision);
  const reverted = await client.writeBranch({
    operationId: "op-revert-temporary",
    branchId: "branch-test",
    expectedWriteRevision: withTemporary.writeRevision,
    changes: [{ path: "src/temporary.txt", state: { kind: "missing" } }],
  });
  assert.equal(reverted.root, changed.root);
  const pinnedCurrent = await client.readPin({ pinId: String(currentPin.pinId), paths: ["src/temporary.txt"] });
  assert.equal(((pinnedCurrent.entries as Array<{ state: { objectHash?: string } }>)[0]?.state.objectHash), temporary.hash);
  await client.unpinBranch({ operationId: "op-unpin-current", branchId: "branch-test", pinId: String(currentPin.pinId) });
  const handoffOwner = host.scoped(await issueActor(host, "kernel-handoff-maintenance", "workspace-test", [""], ["storage.maintenance"]));
  const persistentCurrentPin = await handoffOwner.pinBranch({
    operationId: "op-pin-current-persistent",
    branchId: "branch-test",
    pinId: "handoff-persistent-pin",
    expectedWriteRevision: reverted.writeRevision,
    expectedRoot: reverted.root,
    persistent: true,
  });
  assert.equal(persistentCurrentPin.view, "current");
  assert.equal(persistentCurrentPin.root, reverted.root);
  assert.equal((await client.health({ deep: true })).integrity, "ok");
  const diff = await client.diffRoots({ leftRoot: String(created.root), rightRoot: changed.root });
  assert.deepEqual(diff.changed, ["src/file.txt"]);
  assert.equal((await client.health()).integrity, "ok");
  await client.close();
  const reopenedHost = createKernelClient({ hostId: "kernel-test-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(reopenedHost);
  await reopenedHost.start();
  const reopened = reopenedHost.scoped(await issueActor(reopenedHost, "kernel-test-actor", "workspace-test"));
  const maintenance = reopenedHost.scoped(await issueActor(reopenedHost, "kernel-test-maintenance", null));
  const afterRestart = await reopened.readBranch({ branchId: "branch-test", includeEntries: true });
  const fixedAfterRestart = await reopened.readBranch({ branchId: "branch-test", revision: Number(published.revision), includeEntries: true });
  assert.equal((afterRestart.entries[0]?.state as { objectHash?: string }).objectHash, third.hash);
  assert.equal((fixedAfterRestart.entries[0]?.state as { objectHash?: string }).objectHash, second.hash);
  const persistentAfterRestart = await reopened.readPin({ pinId: String(persistentCurrentPin.pinId), includeEntries: true });
  assert.equal(persistentAfterRestart.root, reverted.root);
  assert.equal(persistentAfterRestart.writeRevision, reverted.writeRevision);
  const reopenedMaintenancePinOwner = reopenedHost.scoped(await issueActor(reopenedHost, "kernel-handoff-maintenance-restart", "workspace-test", [""], ["storage.maintenance"]));
  assert.equal((await reopenedMaintenancePinOwner.unpinBranch({ operationId: "op-unpin-current-persistent", branchId: "branch-test", pinId: String(persistentCurrentPin.pinId) })).released, true);
  const deleted = await reopened.deleteBranch({ operationId: "op-delete", branchId: "branch-test" });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.retainedPins, 1);
  await reopened.deleteBranch({ operationId: "op-fork-delete", branchId: "branch-fork" });
  const retained = await reopened.readPin({ pinId: String(pin.pinId), includeEntries: true });
  assert.equal((retained.entries as unknown[]).length, 1);
  assert.equal(((await reopened.snapshot("workspace-test")).branches as unknown[]).length, 0);
  await maintenance.gc("op-gc-with-pin");
  assert.equal((await reopened.readPin({ pinId: String(pin.pinId), includeEntries: true })).entries instanceof Array, true);
  const released = await reopened.unpinBranch({ operationId: "op-unpin-after-delete", branchId: "branch-test", pinId: String(pin.pinId) });
  assert.equal(released.released, true);
  await maintenance.gc("op-gc-after-unpin");
  await assert.rejects(reopened.readPin({ pinId: String(pin.pinId) }), /pin not found/i);
});

test("operation finish failure rolls back the durable mutation and permits retry", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-operation-"));
  roots.push(root);
  const faultedHost = createKernelClient({
    hostId: "operation-fault-host",
    storageRoot: root,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
    env: { VARIN_KERNEL_FAIL_OPERATION_FINISH: "1" },
  });
  clients.push(faultedHost);
  await faultedHost.start();
  const faulted = faultedHost.scoped(await issueSessionActor(faultedHost, "operation-fault-actor", "recovery-workspace", "recovery-session"));
  await assert.rejects(faulted.putBlob(Buffer.from("retry-me"), "retry-operation"), /injected operation finish failure|storage error/i);
  await faulted.close();
  const retriedHost = createKernelClient({ hostId: "operation-fault-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(retriedHost);
  await retriedHost.start();
  const retried = retriedHost.scoped(await issueSessionActor(retriedHost, "operation-fault-actor", "recovery-workspace", "recovery-session"));
  const result = await retried.putBlob(Buffer.from("retry-me"), "retry-operation");
  assert.equal(result.byteLength, 8);
  assert.equal((await retried.getOperation("retry-operation"))?.state, "committed");
  const recovery = await retried.recoveryOperationCreate({
    operationId: "recovery-multi-stage",
    workspaceId: "recovery-workspace",
    kind: "combined",
    state: "planned",
    sessionId: "recovery-session",
    dataJson: JSON.stringify({ before: "before-state" }),
    files: [],
  });
  assert.equal(recovery.state, "planned");
  const completed = await retried.recoveryOperationComplete({
    transitionId: "recovery-multi-stage:complete",
    operationId: "recovery-multi-stage",
    workspaceId: "recovery-workspace",
    expectedRevision: 1,
    state: "complete",
    resultJson: JSON.stringify({ target: "after-state" }),
  });
  assert.equal(completed.state, "complete");
  const loadedRecovery = await retried.recoveryOperationGet({
    operationId: "recovery-multi-stage",
    workspaceId: "recovery-workspace",
  });
  assert.deepEqual(loadedRecovery?.data, { before: "before-state" });
});

test("GC distinguishes durable release from physical cleanup failure and retries after restart", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-gc-"));
  roots.push(root);
  const faultedHost = createKernelClient({
    hostId: "gc-fault-host",
    storageRoot: root,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
    env: { VARIN_KERNEL_FAIL_GC_DELETE: "1" },
  });
  clients.push(faultedHost);
  await faultedHost.start();
  const faulted = faultedHost.scoped(await issueActor(faultedHost, "gc-fault-actor", "gc-workspace"));
  const faultedMaintenance = faultedHost.scoped(await issueActor(faultedHost, "gc-fault-maintenance", null));
  const blob = await faulted.putBlob(Buffer.from("gc-body"), "gc-blob");
  await faulted.createBranch({
    operationId: "gc-create",
    branchId: "gc-branch",
    workspaceId: "gc-workspace",
    draftBasePaths: [], captureScopes: [], entries: [{ path: "file", state: { kind: "regular-file", byteLength: blob.byteLength, objectHash: blob.hash, mode: 0o644 }, ownerId: blob.ownerId }],
  });
  await faulted.deleteBranch({ operationId: "gc-delete", branchId: "gc-branch" });
  const failed = await faultedMaintenance.gc("gc-run");
  assert.equal(failed.releasedBlobs, 1);
  assert.equal(failed.deletedBlobs, 0);
  assert.equal(failed.byteLengthReclaimed, 0);
  assert.equal((failed.cleanupFailures as string[]).length, 1);
  assert.equal((await faulted.health({ deep: true })).integrity, "degraded");
  const adapter = new KernelStorageAdapter({ client: faultedHost, hostId: "gc-fault-host", storageRoot: root, resolveWorkspaceRoot: async () => root });
  const context = await adapter.context("gc-workspace", "gc");
  await assert.rejects(context.collectUnreachableObjects!(), /object cleanup failed/i);
  await adapter.dispose();
  await faulted.close();

  const recoveredHost = createKernelClient({ hostId: "gc-fault-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(recoveredHost);
  await recoveredHost.start();
  const recovered = recoveredHost.scoped(await issueActor(recoveredHost, "gc-fault-actor", "gc-workspace"));
  const health = await recovered.health({ deep: true });
  assert.equal(health.integrity, "ok");
  assert.equal(health.pendingCleanup, 0);
});

test("grant workspace/path scope and revocation are enforced by Rust", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-grant-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "grant-host", hostGeneration: "grant-generation", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const ownerGrant = await host.issueGrant({
    grantId: "workspace-a-owner",
    hostGeneration: "grant-generation",
    sessionId: null,
    threadId: null,
    runId: null,
    owningWorkspace: "workspace-a",
    executionWorkspace: "workspace-a",
    storageIdentity: host.handshake?.storageRoot,
    capabilities: ["storage.read", "storage.write"],
    pathScopes: [""],
  });
  const owner = host.scoped(ownerGrant);
  const publicBlob = await owner.putBlob(Buffer.from("PUBLIC"), "grant-public-blob");
  const privateBlob = await owner.putBlob(Buffer.from("SECRET"), "grant-private-blob");
  await owner.createBranch({
    operationId: "grant-branch-ok",
    branchId: "grant-branch",
    workspaceId: "workspace-a",
    draftBasePaths: [], captureScopes: [], entries: [
      { path: "src/public/a.txt", state: { kind: "regular-file", byteLength: publicBlob.byteLength, objectHash: publicBlob.hash, mode: 0o644 }, ownerId: publicBlob.ownerId },
      { path: "src/private/secret.txt", state: { kind: "regular-file", byteLength: privateBlob.byteLength, objectHash: privateBlob.hash, mode: 0o644 }, ownerId: privateBlob.ownerId },
    ],
  });
  const client = host.scoped(await host.issueGrant({
    grantId: "scoped-grant",
    hostGeneration: "grant-generation",
    sessionId: null,
    threadId: null,
    runId: null,
    owningWorkspace: "workspace-a",
    executionWorkspace: "workspace-a",
    storageIdentity: host.handshake?.storageRoot,
    capabilities: ["storage.read", "storage.write"],
    pathScopes: ["src/public"],
  }));
  await assert.rejects(client.createBranch({ operationId: "grant-branch-other", branchId: "grant-other", workspaceId: "workspace-b", draftBasePaths: [], captureScopes: [], entries: [] }), /workspace|grant/i);
  const scopedRead = await client.readBranch({ branchId: "grant-branch", includeEntries: true });
  assert.deepEqual(scopedRead.entries.map((entry) => entry.path), ["src/public/a.txt"]);
  const scopedRootRead = await client.readBranch({ branchId: "grant-branch", roots: ["src"], includeEntries: true });
  assert.deepEqual(scopedRootRead.entries.map((entry) => entry.path), ["src/public/a.txt"]);
  await assert.rejects(client.branchObjects({ branchId: "grant-branch" }), /storage\.maintenance|capability/i);
  const maintenance = host.scoped(await host.issueGrant({
    grantId: "grant-object-maintenance",
    hostGeneration: "grant-generation",
    sessionId: null,
    threadId: null,
    runId: null,
    owningWorkspace: "workspace-a",
    executionWorkspace: "workspace-a",
    storageIdentity: host.handshake?.storageRoot,
    capabilities: ["storage.maintenance"],
    pathScopes: [""],
  }));
  const branchObjects = await maintenance.branchObjects({ branchId: "grant-branch", pageSize: 1 });
  assert.equal((branchObjects.objects as unknown[]).length, 1);
  assert.equal(typeof branchObjects.nextCursor, "number");
  await assert.rejects(
    client.readBranch({ branchId: "grant-branch", roots: ["src/private"], includeEntries: true }),
    /scope|path root/i,
  );
  const publicSlice = await client.getBlob(publicBlob.hash, { branchId: "grant-branch", path: "src/public/a.txt" });
  assert.equal(Buffer.from(publicSlice.bytesBase64, "base64").toString("utf8"), "PUBLIC");
  await assert.rejects(
    client.getBlob(privateBlob.hash, { branchId: "grant-branch", path: "src/private/secret.txt" }),
    /scope|path|grant/i,
  );
  await assert.rejects(
    client.getBlob(privateBlob.hash, { branchId: "grant-branch", path: "src/public/a.txt" }),
    /bound|source|path/i,
  );
  await assert.rejects(
    client.writeBranch({
      operationId: "grant-copy-private-by-hash",
      branchId: "grant-branch",
      expectedWriteRevision: 0,
      changes: [{ path: "src/public/leak.txt", state: { kind: "regular-file", objectHash: privateBlob.hash, byteLength: privateBlob.byteLength, mode: 0o644 } }],
    }),
    /source path|bound|scope|grant/i,
  );
  await assert.rejects(
    client.writeBranch({
      operationId: "grant-copy-private-by-source",
      branchId: "grant-branch",
      expectedWriteRevision: 0,
      changes: [{ path: "src/public/leak.txt", sourcePath: "src/private/secret.txt", state: { kind: "regular-file", objectHash: privateBlob.hash, byteLength: privateBlob.byteLength, mode: 0o644 } }],
    }),
    /source path|scope|grant/i,
  );
  await assert.rejects(client.readBranch({ branchId: "grant-branch", paths: ["src/private/secret.txt"] }), /scope|path|grant/i);
  const ownerWrite = await owner.writeBranch({
    operationId: "grant-private-write",
    branchId: "grant-branch",
    expectedWriteRevision: 0,
    changes: [{ path: "src/private/secret.txt", state: { kind: "missing" } }],
  });
  const scopedDiff = await client.diffRoots({ leftRoot: String(scopedRead.root), rightRoot: String(ownerWrite.root) });
  assert.deepEqual(scopedDiff.changed, []);
  assert.deepEqual(scopedDiff.removed, []);
  const published = await owner.publishBranch({ operationId: "grant-publish", branchId: "grant-branch", expectedWriteRevision: ownerWrite.writeRevision, expectedRoot: ownerWrite.root });
  const pin = await owner.pinBranch({ operationId: "grant-pin", branchId: "grant-branch", revision: Number(published.revision), pinId: "grant-pin" });
  const scopedPin = await client.readPin({ pinId: String(pin.pinId), includeEntries: true });
  assert.deepEqual((scopedPin.entries as Array<{ path: string }>).map((entry) => entry.path), ["src/public/a.txt"]);
  const scopedPinRoot = await client.readPin({ pinId: String(pin.pinId), roots: ["src"], includeEntries: true });
  assert.deepEqual((scopedPinRoot.entries as Array<{ path: string }>).map((entry) => entry.path), ["src/public/a.txt"]);
  await assert.rejects(
    client.readPin({ pinId: String(pin.pinId), roots: ["src/private"], includeEntries: true }),
    /scope|path root/i,
  );
  const other = host.scoped(await issueActor(host, "workspace-b-actor", "workspace-b"));
  await assert.rejects(
    other.getBlob(publicBlob.hash, { branchId: "grant-branch", path: "src/public/a.txt" }),
    /owned|grant|workspace/i,
  );
  const liveBeforeRevoke = await client.readBranch({ branchId: "grant-branch" });
  const queryPin = await client.pinBranch({
    operationId: "grant-query-pin",
    branchId: "grant-branch",
    expectedWriteRevision: liveBeforeRevoke.writeRevision,
    expectedRoot: liveBeforeRevoke.root,
  });
  await assert.rejects(
    owner.getBlob(publicBlob.hash, { pinId: String(queryPin.pinId), path: "src/public/a.txt" }),
    /query pin|another actor/i,
  );
  await host.revokeGrant("scoped-grant");
  await assert.rejects(client.readBranch({ branchId: "grant-branch", includeEntries: true }), /revoked|grant/i);
  await assert.rejects(owner.readPin({ pinId: String(queryPin.pinId) }), /pin not found/i);
});

test("queued long branch build observes cancellation and leaves the kernel usable", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-cancel-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "cancel-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "cancel-actor", "cancel-workspace"));
  const blob = await client.putBlob(Buffer.from("cancel"), "cancel-blob");
  const entries = Array.from({ length: 8_000 }, (_, index) => ({
    path: `wide/${String(index).padStart(6, "0")}.txt`,
    state: { kind: "regular-file" as const, byteLength: blob.byteLength, objectHash: blob.hash, mode: 0o644 },
  }));
  const controller = new AbortController();
  const request = client.createBranch({ operationId: "cancel-build", branchId: "cancel-branch", workspaceId: "cancel-workspace", draftBasePaths: [], captureScopes: [], entries }, controller.signal);
  void request.catch(() => undefined);
  const pending = request.then(
    () => assert.fail("cancelled branch build unexpectedly committed"),
    (error: unknown) => assert.match(String(error), /cancelled/i),
  );
  setTimeout(() => controller.abort(), 0);
  await pending;
  assert.equal((await client.health()).integrity, "ok");
  assert.equal((await client.releaseBlob(blob.ownerId)).released, true);
});

test("grant revoke cancels queued side effects before admission", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-revoke-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "revoke-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const actor = host.scoped(await issueActor(host, "revoke-actor", "revoke-workspace"));
  const blob = await actor.putBlob(Buffer.from("revoke"), "revoke-blob");
  await actor.createBranch({ operationId: "revoke-base", branchId: "revoke-base", workspaceId: "revoke-workspace", draftBasePaths: [], captureScopes: [], entries: [] });
  const entries = Array.from({ length: 20_000 }, (_, index) => ({
    path: `wide/${String(index).padStart(6, "0")}.txt`,
    state: { kind: "regular-file" as const, byteLength: blob.byteLength, objectHash: blob.hash, mode: 0o644 },
  }));
  const long = actor.createBranch({ operationId: "revoke-long", branchId: "revoke-long", workspaceId: "revoke-workspace", draftBasePaths: [], captureScopes: [], entries });
  const queued = actor.writeBranch({ operationId: "revoke-queued", branchId: "revoke-base", expectedWriteRevision: 0, changes: [{ path: "queued.txt", state: { kind: "missing" } }] });
  const revoke = host.revokeGrant("revoke-actor");
  const [longResult, queuedResult, revokeResult] = await Promise.allSettled([long, queued, revoke]);
  assert.equal(revokeResult.status, "fulfilled");
  assert.equal(longResult.status, "rejected");
  assert.equal(queuedResult.status, "rejected");
  const verifier = host.scoped(await issueActor(host, "revoke-verifier", "revoke-workspace"));
  const base = await verifier.readBranch({ branchId: "revoke-base", includeEntries: true });
  assert.equal(base.writeRevision, 0);
  assert.deepEqual(base.entries, []);
});

test("temporary blob owners are independent and have explicit release", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-owner-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "owner-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "owner-actor", "owner-workspace"));
  const first = await client.putBlob(Buffer.from("same-content"), "owner-put-first");
  const second = await client.putBlob(Buffer.from("same-content"), "owner-put-second");
  assert.notEqual(first.ownerId, second.ownerId);
  const beforeAttach = await client.getBlob(second.hash, { ownerId: second.ownerId });
  assert.equal(Buffer.from(beforeAttach.bytesBase64, "base64").toString("utf8"), "same-content");
  await client.createBranch({
    operationId: "owner-create",
    branchId: "owner-branch",
    workspaceId: "owner-workspace",
    draftBasePaths: [], captureScopes: [], entries: [{
      path: "file.txt",
      state: { kind: "regular-file", objectHash: first.hash, byteLength: first.byteLength, mode: 0o644 },
      ownerId: first.ownerId,
    }],
  });
  assert.equal((await client.releaseBlob(first.ownerId)).released, false);
  assert.equal((await client.health()).temporaryObjectOwners, 1);
  await client.deleteBranch({ operationId: "owner-delete", branchId: "owner-branch" });
  const orphan = Buffer.from("orphan-content");
  const orphanHash = createHash("sha256").update(orphan).digest("hex");
  const orphanPath = path.join(root, "objects", orphanHash.slice(0, 2), orphanHash.slice(2));
  await fs.mkdir(path.dirname(orphanPath), { recursive: true });
  await fs.writeFile(orphanPath, orphan);
  const orphanCleanup = await client.gc("owner-gc-retained");
  assert.equal(orphanCleanup.byteLengthReclaimed, orphan.length);
  assert.equal(orphanCleanup.deletedBlobs, 1);
  await assert.rejects(fs.stat(orphanPath), { code: "ENOENT" });
  assert.deepEqual(await client.gc("owner-gc-retained"), orphanCleanup);
  assert.equal(Buffer.from((await client.getBlob(second.hash, { ownerId: second.ownerId })).bytesBase64, "base64").toString("utf8"), "same-content");
  assert.equal((await client.releaseBlob(second.ownerId)).released, true);
  assert.equal((await client.releaseOperation("owner-put-second")).released, true);
  const releasedCleanup = await client.gc("owner-gc-released");
  assert.equal(releasedCleanup.byteLengthReclaimed, Buffer.byteLength("same-content"));
  assert.equal(releasedCleanup.deletedBlobs, 1);
  await assert.rejects(client.getBlob(second.hash, { ownerId: second.ownerId }), /owner|owned|grant/i);
});

test("typed durable records own references and page fixed roots", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-records-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "record-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "record-actor", "record-workspace"));
  const body = await client.putBlob(Buffer.from("record-body"), "record-body-op");
  const record = await client.putRecord({
    operationId: "record-put-op",
    recordId: "record-1",
    workspaceId: "record-workspace",
    recordType: "retrieval.artifact",
    state: "temporary",
    payloadJson: JSON.stringify({ receipt: "record-1" }),
    ownerIds: [body.ownerId],
    references: [{ slot: "body", objectHash: body.hash }],
  });
  assert.equal(record.recordId, "record-1");
  const read = await client.getBlob(body.hash, { recordId: "record-1", slot: "body" });
  assert.equal(Buffer.from(read.bytesBase64, "base64").toString("utf8"), "record-body");
  await client.createBranch({ operationId: "record-source-branch-create", branchId: "record-source-branch", workspaceId: "record-workspace", draftBasePaths: [], captureScopes: [], entries: [] });
  await assert.rejects(
    client.writeBranch({
      operationId: "record-source-branch-write",
      branchId: "record-source-branch",
      expectedWriteRevision: 0,
      changes: [{ path: "copied.txt", state: { kind: "regular-file", objectHash: body.hash, byteLength: body.byteLength, mode: 0o644 }, sourceRecordId: "record-1", sourceSlot: "body" }],
    }),
    /storage maintenance|record-backed/i,
  );
  assert.equal((await client.listRecords({ workspaceId: "record-workspace", recordType: "retrieval.artifact", pageSize: 1 })).records.length, 1);
  await assert.rejects(
    client.putRecord({ operationId: "record-malformed-turn", recordId: "bad-turn", workspaceId: "record-workspace", recordType: "recovery.turn", state: "ready", payloadJson: JSON.stringify({}), ownerIds: [], references: [] }),
    /turn executionId|identity is incomplete/i,
  );
  await assert.rejects(
    client.putRecord({ operationId: "record-working-bypass", recordId: "working-result:bypass@1", workspaceId: "record-workspace", recordType: "working.result", state: "published", revision: 1, payloadJson: JSON.stringify({ branchId: "bypass", resultRevision: 1 }), ownerIds: [], references: [] }),
    /typed working record method/i,
  );
  const cas = await client.putRecord({ operationId: "record-cas-create", recordId: "record-cas", workspaceId: "record-workspace", recordType: "retrieval.artifact", state: "published", revision: 1, payloadJson: JSON.stringify({ artifactId: "record-cas" }), ownerIds: [], references: [] });
  assert.equal(cas.revision, 1);
  assert.equal(cas.recordRevision, 1);
  const casUpdated = await client.putRecord({ operationId: "record-cas-update", recordId: "record-cas", workspaceId: "record-workspace", recordType: "retrieval.artifact", state: "published", revision: 1, expectedRecordRevision: 1, payloadJson: JSON.stringify({ artifactId: "record-cas", changed: true }), ownerIds: [], references: [] });
  assert.equal(casUpdated.revision, 1);
  assert.equal(casUpdated.recordRevision, 2);
  await assert.rejects(
    client.putRecord({ operationId: "record-cas-blind", recordId: "record-cas", workspaceId: "record-workspace", recordType: "retrieval.artifact", state: "published", revision: 1, payloadJson: JSON.stringify({ artifactId: "record-cas", blind: true }), ownerIds: [], references: [] }),
    /expectedRecordRevision|record update/i,
  );
  await assert.rejects(
    client.putRecord({ operationId: "record-cas-stale", recordId: "record-cas", workspaceId: "record-workspace", recordType: "retrieval.artifact", state: "published", revision: 1, expectedRecordRevision: 1, payloadJson: JSON.stringify({ artifactId: "record-cas" }), ownerIds: [], references: [] }),
    /revision conflict/i,
  );
  await client.releaseRecord("record-release-op", "record-workspace", "record-1");
  await assert.rejects(client.getBlob(body.hash, { recordId: "record-1", slot: "body" }), /content|record|reference|owner/i);
});

test("typed working result boundary stores root identity with frozen state maps", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) { t.skip("release kernel has not been built in this checkout"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-working-record-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "working-record-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "working-record-actor", "working-record-workspace"));
  const created = await client.createBranch({ operationId: "working-result-branch-create", branchId: "branch-1", workspaceId: "working-record-workspace", draftBasePaths: [], captureScopes: [], entries: [] });
  const publishedBranch = await client.publishBranch({ operationId: "working-result-branch-publish", branchId: "branch-1", expectedWriteRevision: Number(created.writeRevision ?? 0), expectedRoot: String(created.root) });
  const publishedRoot = String(publishedBranch.root);
  const value = await client.workingResultPut({
    operationId: "working-result-put",
    recordId: "working-result:branch-1@1",
    workspaceId: "working-record-workspace",
    branchId: "branch-1",
    resultRevision: 1,
    root: publishedRoot,
    changedPaths: [],
    diffStats: { files: 0, insertions: 0, deletions: 0 },
    createdAt: new Date().toISOString(),
    document: { branchId: "branch-1", resultRevision: 1, root: publishedRoot, changedPaths: [], diffStats: { files: 0, insertions: 0, deletions: 0 }, createdAt: new Date().toISOString(), baseRoot: String(created.root), baseStates: {}, pathStates: {} },
    ownerIds: [],
    references: [],
  });
  assert.equal((value.record as { root: string }).root.startsWith("sha256-"), true);
  // Frozen per-path states travel with the record so a later branch baseline
  // rebase cannot rewrite an older revision's provenance (3.18D).
  assert.equal(JSON.stringify(value.record).includes("pathStates"), true);
  const verificationClient = host.scoped(await host.issueGrant({
    grantId: "working-record-verification-actor",
    hostGeneration: host.handshake?.hostGeneration,
    sessionId: "working-record-session",
    threadId: "thread-1",
    runId: null,
    owningWorkspace: "working-record-workspace",
    executionWorkspace: "working-record-workspace",
    storageIdentity: host.handshake?.storageRoot,
    capabilities: ["storage.read", "storage.write"],
    pathScopes: [""],
  }));
  await assert.rejects(
    verificationClient.workingVerificationPut({
      operationId: "working-verification-malformed",
      recordId: "working-verification:child:thread-1:1",
      workspaceId: "working-record-workspace",
      kind: "child",
      threadId: "thread-1",
      branchId: "branch-1",
      resultRevision: 1,
      root: publishedRoot,
      document: { recordedAt: Date.now(), binding: "bound", checks: [] },
      ownerIds: [],
      references: [],
    }),
    /child verification|result identity/i,
  );
  await verificationClient.workingVerificationPut({
    operationId: "working-verification-valid",
    recordId: "working-verification:child:thread-1:1",
    workspaceId: "working-record-workspace",
    kind: "child",
    threadId: "thread-1",
    branchId: "branch-1",
    resultRevision: 1,
    root: publishedRoot,
    document: { resultRevision: 1, branchId: "branch-1", resultTreeHash: publishedRoot, recordedAt: Date.now(), binding: "bound", checks: [] },
    ownerIds: [],
    references: [],
  });
  await verificationClient.workingReviewPut({
    operationId: "working-review-valid",
    recordId: "working-review:thread-1:1",
    workspaceId: "working-record-workspace",
    threadId: "thread-1",
    branchId: "branch-1",
    resultRevision: 1,
    root: publishedRoot,
    document: { resultRevision: 1, status: "completed", recordedAt: Date.now() },
    ownerIds: [],
    references: [],
  });
  const listed = await client.workingResultList({ workspaceId: "working-record-workspace", branchId: "branch-1" });
  assert.equal((listed.records as unknown[]).length, 1);
  await assert.rejects(
    client.releaseRecord("working-result-generic-release", "working-record-workspace", "working-result:branch-1@1"),
    /typed working release method/i,
  );
  await assert.rejects(
    client.workingResultRelease({ operationId: "working-result-release-head", workspaceId: "working-record-workspace", recordId: "working-result:branch-1@1" }),
    /branch head/i,
  );
  await client.publishBranch({ operationId: "working-result-branch-publish-2", branchId: "branch-1", expectedWriteRevision: Number(created.writeRevision ?? 0), expectedRoot: publishedRoot });
  const released = await client.workingResultRelease({ operationId: "working-result-release", workspaceId: "working-record-workspace", recordId: "working-result:branch-1@1" });
  assert.equal(released.released, true);
  assert.equal(await client.workingResultGet({ workspaceId: "working-record-workspace", recordId: "working-result:branch-1@1" }), null);
  assert.equal(((await verificationClient.workingVerificationList({ workspaceId: "working-record-workspace", threadId: "thread-1", kind: "child" })).records as unknown[]).length, 0);
  assert.equal(((await verificationClient.workingReviewList({ workspaceId: "working-record-workspace", threadId: "thread-1" })).records as unknown[]).length, 0);
  const gc = await client.gc("working-result-gc");
  assert.ok(Number(gc.deletedBlobs ?? 0) >= 0);
});

test("Rust rejects malformed and mismatched typed working result DTOs", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) { t.skip("release kernel has not been built in this checkout"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-working-dto-reject-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "working-dto-reject-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "working-dto-reject-actor", "working-dto-reject-workspace"));
  const common = {
    operationId: "working-dto-reject-malformed",
    recordId: "working-result:missing@1",
    workspaceId: "working-dto-reject-workspace",
    branchId: "missing",
    resultRevision: 1,
    root: "sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    changedPaths: [],
    diffStats: { files: 0, insertions: 0, deletions: 0 },
    createdAt: new Date().toISOString(),
    ownerIds: [],
    references: [],
  };
  await assert.rejects(
    client.workingResultPut({ ...common, document: { branchId: "missing", resultRevision: 1, root: common.root, changedPaths: [], diffStats: common.diffStats, createdAt: common.createdAt, pathStates: {} } as never }),
    /unknown field|malformed|missing field|revision is not published/i,
  );
  await assert.rejects(
    client.workingResultPut({ ...common, operationId: "working-dto-reject-mismatch", recordId: "working-result:missing@1", document: { branchId: "missing", resultRevision: 1, root: common.root, changedPaths: [], diffStats: common.diffStats, createdAt: common.createdAt } as never }),
    /revision is not published|branch|root/i,
  );
});

test("releasing a non-head result drops its revision while an explicit pin alone retains its objects", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) { t.skip("release kernel has not been built in this checkout"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-result-release-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "result-release-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "result-release-actor", "result-release-workspace"));
  const base = await client.putBlob(Buffer.from("base\n"), "result-release-base");
  const first = await client.putBlob(Buffer.from("first\n"), "result-release-first");
  const second = await client.putBlob(Buffer.from("second\n"), "result-release-second");
  const created = await client.createBranch({
    operationId: "result-release-create",
    branchId: "result-release-branch",
    workspaceId: "result-release-workspace",
    draftBasePaths: [],
    captureScopes: [],
    entries: [{ path: "file.txt", state: { kind: "regular-file", objectHash: base.hash, byteLength: base.byteLength, mode: 0o644 }, ownerId: base.ownerId }],
  });
  const firstWrite = await client.writeBranch({
    operationId: "result-release-write-first",
    branchId: "result-release-branch",
    expectedWriteRevision: Number(created.writeRevision),
    changes: [{ path: "file.txt", state: { kind: "regular-file", objectHash: first.hash, byteLength: first.byteLength, mode: 0o644 }, ownerId: first.ownerId }],
  });
  const firstPublished = await client.publishBranch({
    operationId: "result-release-publish-first",
    branchId: "result-release-branch",
    expectedWriteRevision: firstWrite.writeRevision,
    expectedRoot: firstWrite.root,
  });
  const firstRevision = Number(firstPublished.revision);
  await assert.rejects(client.workingResultPut({
    operationId: "result-release-record-missing-refs",
    recordId: `working-result:result-release-branch@${firstRevision}`,
    workspaceId: "result-release-workspace",
    branchId: "result-release-branch",
    resultRevision: firstRevision,
    root: String(firstPublished.root),
    changedPaths: ["file.txt"],
    diffStats: { files: 1, insertions: 0, deletions: 0 },
    createdAt: new Date().toISOString(),
    document: {
      branchId: "result-release-branch",
      resultRevision: firstRevision,
      root: String(firstPublished.root),
      changedPaths: ["file.txt"],
      diffStats: { files: 1, insertions: 0, deletions: 0 },
      createdAt: new Date().toISOString(),
      baseRoot: String(created.root),
      baseStates: { "file.txt": { kind: "regular-file", objectHash: base.hash, byteLength: base.byteLength, mode: 0o644 } },
      pathStates: { "file.txt": { kind: "regular-file", objectHash: first.hash, byteLength: first.byteLength, mode: 0o644 } },
    },
    ownerIds: [],
    references: [],
  }), /references.*published|base\/result/i);
  await client.workingResultPut({
    operationId: "result-release-record-first",
    recordId: `working-result:result-release-branch@${firstRevision}`,
    workspaceId: "result-release-workspace",
    branchId: "result-release-branch",
    resultRevision: firstRevision,
    root: String(firstPublished.root),
    changedPaths: ["file.txt"],
    diffStats: { files: 1, insertions: 0, deletions: 0 },
    createdAt: new Date().toISOString(),
    document: {
      branchId: "result-release-branch",
      resultRevision: firstRevision,
      root: String(firstPublished.root),
      changedPaths: ["file.txt"],
      diffStats: { files: 1, insertions: 0, deletions: 0 },
      createdAt: new Date().toISOString(),
      baseRoot: String(created.root),
      baseStates: { "file.txt": { kind: "regular-file", objectHash: base.hash, byteLength: base.byteLength, mode: 0o644 } },
      pathStates: { "file.txt": { kind: "regular-file", objectHash: first.hash, byteLength: first.byteLength, mode: 0o644 } },
    },
    ownerIds: [],
    references: [
      { slot: "base:file.txt", objectHash: base.hash },
      { slot: "result:file.txt", objectHash: first.hash },
    ],
  });
  const pin = await client.pinBranch({
    operationId: "result-release-pin-first",
    branchId: "result-release-branch",
    revision: firstRevision,
    pinId: "result-release-pin",
  });
  const secondWrite = await client.writeBranch({
    operationId: "result-release-write-second",
    branchId: "result-release-branch",
    expectedWriteRevision: firstWrite.writeRevision,
    changes: [{ path: "file.txt", state: { kind: "regular-file", objectHash: second.hash, byteLength: second.byteLength, mode: 0o644 }, ownerId: second.ownerId }],
  });
  await client.publishBranch({
    operationId: "result-release-publish-second",
    branchId: "result-release-branch",
    expectedWriteRevision: secondWrite.writeRevision,
    expectedRoot: secondWrite.root,
  });
  const beforeRelease = await client.health();
  assert.equal(beforeRelease.blobs, 3);
  await client.workingResultRelease({
    operationId: "result-release-record-drop",
    workspaceId: "result-release-workspace",
    recordId: `working-result:result-release-branch@${firstRevision}`,
  });
  await client.gc("result-release-gc-pinned");
  assert.equal((await client.health()).blobs, 3);
  const pinned = await client.readPin({ pinId: String(pin.pinId), paths: ["file.txt"] });
  const pinnedEntries = pinned.entries as Array<{ state?: { objectHash?: string } }>;
  assert.equal(pinnedEntries[0]?.state?.objectHash, first.hash);
  await client.unpinBranch({ operationId: "result-release-unpin", branchId: "result-release-branch", pinId: String(pin.pinId) });
  await client.gc("result-release-gc-unpinned");
  assert.equal((await client.health()).blobs, 2);
});

test("a baseline rebase keeps older result provenance and validates new results against the new base", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) { t.skip("release kernel has not been built in this checkout"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-rebase-result-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "rebase-result-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "rebase-result-actor", "rebase-result-workspace", [""], ["storage.maintenance"]));
  const parentBase = await client.putBlob(Buffer.from("parent-base\n"), "rebase-parent-base");
  const parentResult = await client.putBlob(Buffer.from("parent-result\n"), "rebase-parent-result");
  const childBase = await client.putBlob(Buffer.from("child-base\n"), "rebase-child-base");
  const childFirst = await client.putBlob(Buffer.from("child-first\n"), "rebase-child-first");
  const childSecond = await client.putBlob(Buffer.from("child-second\n"), "rebase-child-second");
  const state = (blob: { hash: string; byteLength: number }) => ({ kind: "regular-file" as const, objectHash: blob.hash, byteLength: blob.byteLength, mode: 0o644 });
  const parent = await client.createBranch({
    operationId: "rebase-parent-create",
    branchId: "rebase-parent-branch",
    workspaceId: "rebase-result-workspace",
    draftBasePaths: [],
    captureScopes: [],
    entries: [{ path: "p.txt", state: state(parentBase), ownerId: parentBase.ownerId }],
  });
  const parentWrite = await client.writeBranch({
    operationId: "rebase-parent-write",
    branchId: "rebase-parent-branch",
    expectedWriteRevision: Number(parent.writeRevision),
    changes: [{ path: "p.txt", state: state(parentResult), ownerId: parentResult.ownerId }],
  });
  await client.publishBranch({
    operationId: "rebase-parent-publish",
    branchId: "rebase-parent-branch",
    expectedWriteRevision: parentWrite.writeRevision,
    expectedRoot: parentWrite.root,
  });
  const child = await client.createBranch({
    operationId: "rebase-child-create",
    branchId: "rebase-child-branch",
    workspaceId: "rebase-result-workspace",
    draftBasePaths: [],
    captureScopes: [],
    entries: [{ path: "c.txt", state: state(childBase), ownerId: childBase.ownerId }],
  });
  const childWrite = await client.writeBranch({
    operationId: "rebase-child-write-first",
    branchId: "rebase-child-branch",
    expectedWriteRevision: Number(child.writeRevision),
    changes: [{ path: "c.txt", state: state(childFirst), ownerId: childFirst.ownerId }],
  });
  const childPublished = await client.publishBranch({
    operationId: "rebase-child-publish-first",
    branchId: "rebase-child-branch",
    expectedWriteRevision: childWrite.writeRevision,
    expectedRoot: childWrite.root,
  });
  const childRevision = Number(childPublished.revision);
  await client.workingResultPut({
    operationId: "rebase-child-record-first",
    recordId: `working-result:rebase-child-branch@${childRevision}`,
    workspaceId: "rebase-result-workspace",
    branchId: "rebase-child-branch",
    resultRevision: childRevision,
    root: String(childPublished.root),
    changedPaths: ["c.txt"],
    diffStats: { files: 1, insertions: 0, deletions: 0 },
    createdAt: new Date().toISOString(),
    document: {
      branchId: "rebase-child-branch",
      resultRevision: childRevision,
      root: String(childPublished.root),
      changedPaths: ["c.txt"],
      diffStats: { files: 1, insertions: 0, deletions: 0 },
      createdAt: new Date().toISOString(),
      baseRoot: String(child.root),
      baseStates: { "c.txt": state(childBase) },
      pathStates: { "c.txt": state(childFirst) },
    },
    ownerIds: [],
    references: [
      { slot: "base:c.txt", objectHash: childBase.hash },
      { slot: "result:c.txt", objectHash: childFirst.hash },
    ],
  });
  const staleRebase = await client.writeBranch({
    operationId: "rebase-child-write-stale",
    branchId: "rebase-child-branch",
    expectedWriteRevision: Number(child.writeRevision),
    baseRef: "rebase-parent-branch@1",
    parentRef: "rebase-parent-branch@1",
    changes: [{ path: "c.txt", state: { kind: "missing" } }],
  });
  assert.equal(staleRebase.status, "conflict");
  const rebased = await client.writeBranch({
    operationId: "rebase-child-write-rebase",
    branchId: "rebase-child-branch",
    expectedWriteRevision: childWrite.writeRevision,
    baseRef: "rebase-parent-branch@1",
    parentRef: "rebase-parent-branch@1",
    changes: [{
      path: "c.txt",
      state: state(childFirst),
      sourceRecordId: `working-result:rebase-child-branch@${childRevision}`,
      sourceSlot: "result:c.txt",
    }],
  });
  const frozen = await client.workingResultGet({ workspaceId: "rebase-result-workspace", recordId: `working-result:rebase-child-branch@${childRevision}` });
  const frozenDoc = (frozen as { record?: Record<string, unknown> } | null)?.record as { baseRoot?: string; baseStates?: Record<string, { objectHash?: string }> } | undefined;
  assert.equal(frozenDoc?.baseRoot, String(child.root));
  assert.equal(frozenDoc?.baseStates?.["c.txt"]?.objectHash, childBase.hash);
  const secondWrite = await client.writeBranch({
    operationId: "rebase-child-write-second",
    branchId: "rebase-child-branch",
    expectedWriteRevision: rebased.writeRevision,
    changes: [{ path: "c.txt", state: state(childSecond), ownerId: childSecond.ownerId }],
  });
  const secondPublished = await client.publishBranch({
    operationId: "rebase-child-publish-second",
    branchId: "rebase-child-branch",
    expectedWriteRevision: secondWrite.writeRevision,
    expectedRoot: secondWrite.root,
  });
  const secondRevision = Number(secondPublished.revision);
  const secondDocument = (baseRoot: string) => ({
    branchId: "rebase-child-branch",
    resultRevision: secondRevision,
    root: String(secondPublished.root),
    changedPaths: ["c.txt"],
    diffStats: { files: 1, insertions: 0, deletions: 0 },
    createdAt: new Date().toISOString(),
    baseRoot,
    baseStates: { "c.txt": { kind: "missing" as const } },
    pathStates: { "c.txt": state(childSecond) },
  });
  await assert.rejects(client.workingResultPut({
    operationId: "rebase-child-record-stale-base",
    recordId: `working-result:rebase-child-branch@${secondRevision}`,
    workspaceId: "rebase-result-workspace",
    branchId: "rebase-child-branch",
    resultRevision: secondRevision,
    root: String(secondPublished.root),
    changedPaths: ["c.txt"],
    diffStats: { files: 1, insertions: 0, deletions: 0 },
    createdAt: new Date().toISOString(),
    document: secondDocument(String(child.root)),
    ownerIds: [],
    references: [{ slot: "result:c.txt", objectHash: childSecond.hash }],
  }), /baseRoot.*baseline|publish-time/i);
  await client.workingResultPut({
    operationId: "rebase-child-record-second",
    recordId: `working-result:rebase-child-branch@${secondRevision}`,
    workspaceId: "rebase-result-workspace",
    branchId: "rebase-child-branch",
    resultRevision: secondRevision,
    root: String(secondPublished.root),
    changedPaths: ["c.txt"],
    diffStats: { files: 1, insertions: 0, deletions: 0 },
    createdAt: new Date().toISOString(),
    document: secondDocument(String(parentWrite.root)),
    ownerIds: [],
    references: [{ slot: "result:c.txt", objectHash: childSecond.hash }],
  });
});

test("domain record identity is workspace- and actor-scoped", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-record-scope-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "record-scope-host", hostGeneration: "record-scope-generation", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const storageIdentity = host.handshake?.storageRoot;
  const actor = async (grantId: string, workspaceId: string, sessionId: string) => host.scoped(await host.issueGrant({ grantId, hostGeneration: "record-scope-generation", authorityInstanceId: "authority", workerId: `${sessionId}-worker`, workerGeneration: 3, sessionId, threadId: `${sessionId}-thread`, runId: `${sessionId}-run`, owningWorkspace: workspaceId, executionWorkspace: workspaceId, storageIdentity, capabilities: ["storage.read", "storage.write", "recovery"], pathScopes: [""] }));
  const first = await actor("record-scope-a", "workspace-a", "session-a");
  const second = await actor("record-scope-b", "workspace-b", "session-b");
  const put = (client: ReturnType<typeof host.scoped>, operationId: string, workspaceId: string, sessionId: string) => client.putRecord({ operationId, recordId: "same-record", workspaceId, recordType: "recovery.checkpoint", state: "ready", sessionId, threadId: `${sessionId}-thread`, runId: `${sessionId}-run`, payloadJson: JSON.stringify({ id: "same-record", workspaceId, sessionId }), ownerIds: [], references: [] });
  await put(first, "scope-put-a", "workspace-a", "session-a");
  await put(second, "scope-put-b", "workspace-b", "session-b");
  assert.equal((await first.getRecord("workspace-a", "same-record"))?.workspaceId, "workspace-a");
  assert.equal((await second.getRecord("workspace-b", "same-record"))?.workspaceId, "workspace-b");
  const wrongActor = await actor("record-scope-wrong", "workspace-a", "session-other");
  await assert.rejects(wrongActor.getRecord("workspace-a", "same-record"), /actor|authorization|record/i);
  const unbound = host.scoped(await issueActor(host, "record-scope-unbound", "workspace-a"));
  await assert.rejects(
    unbound.putRecord({ operationId: "scope-put-impersonated", recordId: "impersonated", workspaceId: "workspace-a", recordType: "working.result", state: "published", sessionId: "session-a", payloadJson: JSON.stringify({}), ownerIds: [], references: [] }),
    /actor-bound|actor|authorization/i,
  );
});

test("typed recovery turn reads honor actor session identity", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-recovery-actor-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "recovery-actor-host", hostGeneration: "recovery-actor-generation", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const makeActor = async (grantId: string, sessionId: string) => host.scoped(await host.issueGrant({ grantId, hostGeneration: "recovery-actor-generation", sessionId, threadId: `${sessionId}-thread`, runId: `${sessionId}-run`, owningWorkspace: "recovery-actor-workspace", executionWorkspace: "recovery-actor-workspace", storageIdentity: host.handshake?.storageRoot, capabilities: ["storage.read", "storage.write", "recovery"], pathScopes: [""] }));
  const owner = await makeActor("recovery-owner", "session-owner");
  const other = await makeActor("recovery-other", "session-other");
  await owner.recoveryTurnStart({ operationId: "recovery-actor-turn", workspaceId: "recovery-actor-workspace", executionId: "recovery-actor-execution", sessionId: "session-owner", userEntryId: "entry-owner", workerId: "worker", runtimeGeneration: 1, activeWriterScopes: [], provenance: "caused-by" });
  await assert.rejects(other.recoveryTurnGet({ workspaceId: "recovery-actor-workspace", executionId: "recovery-actor-execution", sessionId: "session-owner" }), /actor|authorization|session/i);
  assert.equal((await owner.recoveryTurnGet({ workspaceId: "recovery-actor-workspace", executionId: "recovery-actor-execution", sessionId: "session-owner" }))?.sessionId, "session-owner");
});

test("branch creation streams a normal input larger than one control frame", { timeout: 60_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-large-branch-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "large-branch-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "large-branch-actor", "large-branch-workspace"));
  const target = "x".repeat(1_024);
  const entries = Array.from({ length: 17_000 }, (_, index) => ({
    path: `wide/${String(index).padStart(6, "0")}`,
    state: { kind: "symlink" as const, symlinkTarget: target },
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(entries), "utf8") > 16 * 1024 * 1024);
  const created = await client.createBranch({ operationId: "large-branch-create", branchId: "large-branch", workspaceId: "large-branch-workspace", draftBasePaths: [], captureScopes: [], entries });
  assert.equal(created.created, true);
  assert.equal((await client.readBranch({ branchId: "large-branch" })).writeRevision, 0);
  const added = await client.writeBranch({
    operationId: "large-branch-add",
    branchId: "large-branch",
    expectedWriteRevision: 0,
    changes: [{ path: "wide/999999", state: { kind: "directory" } }],
  });
  const diff = await client.diffRoots({ leftRoot: String(created.root), rightRoot: added.root });
  assert.deepEqual(diff.added, ["wide/999999"]);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
});

test("kernel rejects an Application Host build identity mismatch", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-build-id-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "mismatch-host", storageRoot: root, buildVersion: `${buildVersion}-other`, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await assert.rejects(host.start(), /build identity|does not match kernel/i);
});

test("a current-format catalog with missing authority tables is rejected without repair", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-schema-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "schema-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  await host.close();
  const { default: Database } = await import("better-sqlite3");
  const catalog = new Database(path.join(root, "catalog.sqlite"));
  catalog.exec("DROP TABLE object_owners");
  catalog.close();
  const broken = createKernelClient({ hostId: "schema-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(broken);
  await assert.rejects(broken.start(), /catalog table set is corrupt|schema fingerprint/i);
  const verify = new Database(path.join(root, "catalog.sqlite"), { readonly: true });
  const exists = verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'object_owners'").get();
  verify.close();
  assert.equal(exists, undefined);
});

test("the source package finds its kernel independently of process cwd", async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-cwd-root-"));
  const unrelated = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-cwd-"));
  roots.push(root, unrelated);
  const previous = process.cwd();
  process.chdir(unrelated);
  try {
    const host = createKernelClient({
      hostId: "cwd-host",
      storageRoot: root,
      buildVersion,
      allowCargoDevRunner: false,
      requireKernelManifest: false,
      cwd: unrelated,
    });
    clients.push(host);
    assert.equal((await host.start()).kernelBuildIdentity, buildVersion);
  } finally {
    process.chdir(previous);
  }
});

test("real kernel typed recovery storage persists checkpoints, operation files, and objects across restart", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-recovery-test-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "varin-recovery-workspace-"));
  roots.push(root, workspace);
  await fs.writeFile(path.join(workspace, "a.txt"), "before");
  const makeEngine = async () => {
    const client = createKernelClient({ hostId: "kernel-recovery-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
    clients.push(client);
    await client.start();
    const adapter = new KernelStorageAdapter({ hostId: "kernel-recovery-host", storageRoot: root, client, resolveWorkspaceRoot: async () => workspace });
    const content = new KernelRecoveryContentStore(adapter, path.join(root, "recovery-cache"));
    const documents = {
      inspectWorkspace: async () => ({ workspaceId: "workspace-test", root: workspace }),
      listWorkspaceRegistrations: async () => [{ workspaceId: "workspace-test", canonicalPath: workspace }],
      inspectDirtyBuffers: async () => [],
      beginDirtyStateBarrier: async () => ({ release: async () => undefined, settle: async () => undefined }),
      runResourceOperation: async (_workspaceId: string, _resources: readonly unknown[], operation: () => Promise<unknown>) => operation(),
    };
    const navigation = {
      prepare: async () => ({ expectedLeafId: null, targetLeafId: null, removedEntryIds: [] }),
      prepareLeaf: async () => ({ expectedLeafId: null, targetLeafId: null }),
      commit: async () => ({}),
      commitLeaf: async () => ({}),
    };
    const store = new KernelRecoveryStore(adapter, content);
    const engine = createWorkspaceRecoveryEngine({
      authorityId: "kernel-recovery-host",
      dataDir: path.join(root, "host-data"),
      documents: documents as never,
      durableRecoveryStore: store,
      sessionNavigation: navigation as never,
      fileStore: content,
    });
    return { adapter, client, engine: createKernelRecoveryDirectFacade(engine, store) };
  };

  const first = await makeEngine();
  await first.engine.recordTurnStart({ executionId: "execution-1", workspaceId: "workspace-test", sessionId: "session-1", userEntryId: "user-1", workerId: "worker-1", runtimeGeneration: 1, activeWriterScopes: [], provenance: "caused-by" });
  await first.engine.recordMutationBefore({ executionId: "execution-1", workspaceId: "workspace-test", path: "a.txt", toolName: "edit", mutationId: "mutation-1", toolCallId: "tool-call-1" });
  await fs.writeFile(path.join(workspace, "a.txt"), "after");
  await first.engine.recordMutationAfter({ executionId: "execution-1", workspaceId: "workspace-test", path: "a.txt", toolName: "edit", mutationId: "mutation-1", toolCallId: "tool-call-1", succeeded: true });
  await first.engine.recordTurnSettled({ executionId: "execution-1", workspaceId: "workspace-test", activeWriterScopes: [], provenance: "caused-by", observedResourceIds: ["a.txt"], observationComplete: true, mutationObserved: true, assistantEntryId: "assistant-1" });
  await first.engine.dispose();
  await first.adapter.dispose();
  await first.client.close();

  const second = await makeEngine();
  const checkpoints = await second.engine.listCheckpoints({ workspaceId: "workspace-test" });
  assert.equal(checkpoints.status, "ready");
  assert.equal(checkpoints.page.checkpoints.length, 1);
  const resolved = await second.engine.resolveEntry({ workspaceId: "workspace-test", sessionId: "session-1", entryId: "user-1" });
  assert.equal(resolved.status, "ready");
  assert.equal(resolved.binding?.checkpointId, checkpoints.page.checkpoints[0]?.id);
  await second.engine.dispose();
  await second.adapter.dispose();
  await second.client.close();
});

test("typed recovery operation publishes files atomically and rejects stale phase CAS", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-typed-recovery-"));
  roots.push(root);
  const host = createKernelClient({ hostId: "typed-recovery-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueSessionActor(host, "typed-recovery-actor", "typed-recovery-workspace", "typed-recovery-session"));
  const body = await client.putBlob(Buffer.from("typed recovery"), "typed-recovery-body");
  const created = await client.recoveryOperationCreate({
    operationId: "typed-recovery-operation",
    workspaceId: "typed-recovery-workspace",
    kind: "combined",
    state: "planned",
    sessionId: "typed-recovery-session",
    dataJson: JSON.stringify({ workspaceId: "typed-recovery-workspace", affectedPaths: ["file.txt"] }),
    files: [{
      path: "file.txt",
      expectedJson: JSON.stringify({ kind: "missing" }),
      targetJson: JSON.stringify({ kind: "regular-file", objectHash: body.hash, byteLength: body.byteLength, mode: 0o644 }),
      phase: "pending",
      references: [{ slot: "target", objectHash: body.hash, ownerId: body.ownerId }],
    }],
  });
  assert.equal(created.operationId, "typed-recovery-operation");
  const loaded = await client.recoveryOperationGet({ operationId: "typed-recovery-operation", workspaceId: "typed-recovery-workspace" });
  const loadedFiles = Array.isArray(loaded?.files) ? loaded.files as Array<Record<string, unknown>> : [];
  assert.equal(loadedFiles[0]?.phase, "pending");
  assert.equal(loadedFiles[0]?.revision, 1);
  await client.recoveryOperationFileCas({ transitionId: "typed-recovery-operation:file:apply-intent", operationId: "typed-recovery-operation", workspaceId: "typed-recovery-workspace", path: "file.txt", expectedRevision: 1, expectedPhase: "pending", phase: "apply-intent" });
  await assert.rejects(
    client.recoveryOperationFileCas({ transitionId: "typed-recovery-operation:file:stale", operationId: "typed-recovery-operation", workspaceId: "typed-recovery-workspace", path: "file.txt", expectedRevision: 1, expectedPhase: "pending", phase: "target-observed" }),
    /phase conflict|revision conflict/i,
  );
  await client.recoveryOperationComplete({ transitionId: "typed-recovery-operation:complete", operationId: "typed-recovery-operation", workspaceId: "typed-recovery-workspace", expectedRevision: 1, state: "complete" });
  assert.equal((await client.recoveryOperationRelease({ transitionId: "typed-recovery-operation:release", operationId: "typed-recovery-operation", workspaceId: "typed-recovery-workspace" })).released, true);
  assert.equal(await client.recoveryOperationGet({ operationId: "typed-recovery-operation", workspaceId: "typed-recovery-workspace" }), null);
});

test("typed recovery create fault injection rolls back operation intent and permits retry", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-recovery-fault-"));
  roots.push(root);
  const faultedHost = createKernelClient({ hostId: "typed-recovery-fault-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false, env: { VARIN_KERNEL_FAIL_RECOVERY_PHASE: "operation-before-files" } });
  clients.push(faultedHost);
  await faultedHost.start();
  const faulted = faultedHost.scoped(await issueSessionActor(faultedHost, "typed-recovery-fault-actor", "typed-recovery-fault-workspace", "typed-recovery-fault-session"));
  await assert.rejects(faulted.recoveryOperationCreate({ operationId: "typed-recovery-fault-operation", workspaceId: "typed-recovery-fault-workspace", sessionId: "typed-recovery-fault-session", kind: "combined", state: "planned", dataJson: JSON.stringify({}), files: [] }), /injected recovery failure/i);
  await faultedHost.close();
  const retryHost = createKernelClient({ hostId: "typed-recovery-fault-host", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  clients.push(retryHost);
  await retryHost.start();
  const retry = retryHost.scoped(await issueSessionActor(retryHost, "typed-recovery-fault-retry", "typed-recovery-fault-workspace", "typed-recovery-fault-session"));
  const result = await retry.recoveryOperationCreate({ operationId: "typed-recovery-fault-operation", workspaceId: "typed-recovery-fault-workspace", sessionId: "typed-recovery-fault-session", kind: "combined", state: "planned", dataJson: JSON.stringify({}), files: [] });
  assert.equal(result.operationId, "typed-recovery-fault-operation");
});

test("R2 kernel file authority gates paths and applies conditional filesystem state", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-file-authority-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-file-workspace-"));
  const alternateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-file-alternate-"));
  roots.push(storageRoot, workspace, alternateRoot);
  await fs.writeFile(path.join(workspace, "note.txt"), "before\n");

  const host = createKernelClient({
    hostId: "file-authority-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  clients.push(host);
  await host.start();
  const first = host.scoped(await issueActor(host, "file-authority-first", "file-workspace"));
  const second = host.scoped(await issueActor(host, "file-authority-second", "file-workspace"));
  const registered = await first.fileRootRegister({
    workspaceId: "file-workspace",
    executionWorkspaceId: "file-workspace",
    canonicalRoot: workspace,
  });
  assert.equal(typeof registered.rootId, "string");
  const rootId = String(registered.rootId);
  const alternateRegistration = await first.fileRootRegister({
    workspaceId: "file-workspace",
    executionWorkspaceId: "file-workspace",
    canonicalRoot: alternateRoot,
  });
  assert.notEqual(alternateRegistration.rootId, rootId, "R3 permits multiple Host-admitted roots under one workspace identity");

  const before = await first.fileCapture({
    operationId: "file-capture-before",
    workspaceId: "file-workspace",
    rootId,
    path: "note.txt",
    store: true,
  });
  const beforeState = JSON.parse(String(before.stateJson)) as Record<string, unknown>;
  assert.equal(beforeState.kind, "regular-file");
  assert.equal(typeof before.ownerId, "string");

  const lease = await first.fileLeaseAcquire({
    workspaceId: "file-workspace",
    rootId,
    leaseId: "file-lease-one",
    resources: [{ path: "note.txt", scope: "exact" }],
  });
  assert.equal(lease.status, "acquired");
  await assert.rejects(
    second.fileCapture({
      operationId: "file-capture-blocked",
      workspaceId: "file-workspace",
      rootId,
      path: "note.txt",
      store: false,
    }),
    /busy|lease/i,
  );
  assert.equal((await first.fileLeaseRelease({
    workspaceId: "file-workspace",
    rootId,
    leaseId: "file-lease-one",
  })).released, true);

  const afterObject = await first.putBlob(Buffer.from("after\n"), "file-object-after");
  const target = {
    kind: "regular-file",
    objectHash: afterObject.hash,
    byteLength: afterObject.byteLength,
    mode: beforeState.mode,
  };
  const applied = await first.fileApply({
    operationId: "file-apply-after",
    workspaceId: "file-workspace",
    rootId,
    path: "note.txt",
    expectedJson: JSON.stringify(beforeState),
    targetJson: JSON.stringify(target),
    ownerId: afterObject.ownerId,
  });
  assert.equal(applied.status, "applied");
  assert.equal(await fs.readFile(path.join(workspace, "note.txt"), "utf8"), "after\n");

  const thirdObject = await first.putBlob(Buffer.from("third\n"), "file-object-third");
  const conflict = await first.fileApply({
    operationId: "file-apply-stale",
    workspaceId: "file-workspace",
    rootId,
    path: "note.txt",
    expectedJson: JSON.stringify(beforeState),
    targetJson: JSON.stringify({
      kind: "regular-file",
      objectHash: thirdObject.hash,
      byteLength: thirdObject.byteLength,
      mode: beforeState.mode,
    }),
    ownerId: thirdObject.ownerId,
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(await fs.readFile(path.join(workspace, "note.txt"), "utf8"), "after\n");

  await assert.rejects(
    first.fileCapture({
      operationId: "file-capture-escape",
      workspaceId: "file-workspace",
      rootId,
      path: "../escape.txt",
      store: false,
    }),
    /normalized|outside|path/i,
  );
});

test("R2 file apply reconciles a committed disk side effect after kernel restart", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-file-reconcile-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-file-reconcile-workspace-"));
  roots.push(storageRoot, workspace);

  const faultedHost = createKernelClient({
    hostId: "file-reconcile-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
    env: { VARIN_KERNEL_FAIL_OPERATION_FINISH: "1" },
  });
  clients.push(faultedHost);
  await faultedHost.start();
  const faulted = faultedHost.scoped(await issueActor(faultedHost, "file-reconcile-faulted", "file-reconcile-workspace"));
  const firstRegistration = await faulted.fileRootRegister({
    workspaceId: "file-reconcile-workspace",
    executionWorkspaceId: "file-reconcile-workspace",
    canonicalRoot: workspace,
  });
  const rootId = String(firstRegistration.rootId);
  await fs.writeFile(path.join(workspace, "seed.txt"), "durable\n");
  const capturedTarget = await faulted.fileCapture({
    operationId: "file-reconcile-object",
    workspaceId: "file-reconcile-workspace",
    rootId,
    path: "seed.txt",
    store: true,
  });
  const target = JSON.parse(String(capturedTarget.stateJson)) as Record<string, unknown>;
  const targetOwnerId = String(capturedTarget.ownerId);
  await assert.rejects(
    faulted.fileApply({
      operationId: "file-reconcile-apply",
      workspaceId: "file-reconcile-workspace",
      rootId,
      path: "created.txt",
      expectedJson: JSON.stringify({ kind: "missing" }),
      targetJson: JSON.stringify(target),
      ownerId: targetOwnerId,
    }),
    /injected operation finish failure/i,
  );
  assert.equal(await fs.readFile(path.join(workspace, "created.txt"), "utf8"), "durable\n");
  await faultedHost.close();
  clients.splice(clients.indexOf(faultedHost), 1);

  const reopenedHost = createKernelClient({
    hostId: "file-reconcile-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  clients.push(reopenedHost);
  await reopenedHost.start();
  const reopened = reopenedHost.scoped(await issueActor(reopenedHost, "file-reconcile-reopened", "file-reconcile-workspace"));
  const registration = await reopened.fileRootRegister({
    workspaceId: "file-reconcile-workspace",
    executionWorkspaceId: "file-reconcile-workspace",
    canonicalRoot: workspace,
  });
  assert.equal(registration.rootId, rootId);
  assert.equal(registration.reconciledOperations, 1);
  assert.equal(registration.pendingOperations, 0);
  const retried = await reopened.fileApply({
    operationId: "file-reconcile-apply",
    workspaceId: "file-reconcile-workspace",
    rootId,
    path: "created.txt",
    expectedJson: JSON.stringify({ kind: "missing" }),
    targetJson: JSON.stringify(target),
    ownerId: targetOwnerId,
  });
  assert.equal(retried.status, "applied");
  assert.equal(retried.reconciled, true);
});

test("R2 production fs.lock delegates overlap admission to the Rust file lease authority", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-path-lock-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-path-lock-workspace-"));
  roots.push(storageRoot, workspace);
  const host = createKernelClient({
    hostId: "path-lock-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  clients.push(host);
  await host.start();
  const adapter = new KernelStorageAdapter({
    client: host,
    hostId: "path-lock-host",
    storageRoot,
    resolveWorkspaceRoot: async () => workspace,
  });
  const locks = new KernelPathLockService(adapter, {
    resolveOwningWorkspaceId: async (_sessionId, executionWorkspaceId) => executionWorkspaceId,
    resolveWorkspaceRoot: async () => workspace,
    retryDelayMs: 1,
  });
  const resource = {
    authorityId: "path-lock-host",
    workspaceId: "path-lock-workspace",
    canonicalResourceId: path.join(workspace, "file.txt"),
    resourceId: "file.txt",
  };
  const first = await locks.acquire("session-one", resource, 1_000);
  await assert.rejects(
    locks.acquire("session-two", resource, 25),
    /Lock timeout/i,
  );
  assert.equal(await locks.release("session-one", first), true);
  const second = await locks.acquire("session-two", resource, 1_000);
  assert.equal(await locks.release("session-two", second), true);
  await locks.dispose();
  await adapter.dispose();
});

test("R3 kernel scans a fixed workspace view and materializes an immutable root without Host body copies", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-r3-materialize-"));
  const source = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-r3-source-"));
  const managed = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-r3-managed-"));
  roots.push(storageRoot, source, managed);
  await fs.mkdir(path.join(source, "nested"), { recursive: true });
  await fs.mkdir(path.join(source, ".git"), { recursive: true });
  await fs.mkdir(path.join(source, ".varin"), { recursive: true });
  await fs.writeFile(path.join(source, "plain.txt"), "fixed plain\n");
  await fs.writeFile(path.join(source, "nested", "b.txt"), "fixed nested\n");
  await fs.writeFile(path.join(source, ".git", "ignored"), "git metadata\n");
  await fs.writeFile(path.join(source, ".varin", "ignored"), "varin metadata\n");

  const host = createKernelClient({
    hostId: "r3-materialize-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  clients.push(host);
  await host.start();
  const client = host.scoped(await issueActor(host, "r3-materialize-actor", "r3-materialize-workspace"));
  const sourceRegistration = await client.fileRootRegister({
    workspaceId: "r3-materialize-workspace",
    executionWorkspaceId: "r3-materialize-workspace",
    canonicalRoot: source,
  });
  const sourceRootId = String(sourceRegistration.rootId);
  const scanned: string[] = [];
  let cursor: number | undefined;
  let expectedFingerprint: string | undefined;
  do {
    const page = await client.fileScan({
      workspaceId: "r3-materialize-workspace",
      rootId: sourceRootId,
      path: "",
      pageSize: 2,
      ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.ok(Array.isArray(page.paths));
    scanned.push(...page.paths as string[]);
    assert.equal(typeof page.fingerprint, "string");
    expectedFingerprint = String(page.fingerprint);
    cursor = typeof page.nextCursor === "number" ? page.nextCursor : undefined;
  } while (cursor !== undefined);
  assert.deepEqual(scanned, ["nested", "nested/b.txt", "plain.txt"]);

  const entries: Array<{ path: string; state: Record<string, unknown>; ownerId?: string }> = [];
  for (const relative of scanned) {
    const captured = await client.fileCapture({
      operationId: `r3-capture:${relative}`,
      workspaceId: "r3-materialize-workspace",
      rootId: sourceRootId,
      path: relative,
      store: true,
    });
    entries.push({
      path: relative,
      state: JSON.parse(String(captured.stateJson)),
      ...(typeof captured.ownerId === "string" ? { ownerId: captured.ownerId } : {}),
    });
  }
  const branch = await client.createBranch({
    operationId: "r3-branch-create",
    branchId: "r3-branch",
    workspaceId: "r3-materialize-workspace",
    draftBasePaths: [],
    captureScopes: [],
    entries: entries as never,
  });
  const immutableRoot = String(branch.root);

  const managedRegistration = await client.fileRootRegister({
    workspaceId: "r3-materialize-workspace",
    executionWorkspaceId: "r3-materialize-workspace",
    canonicalRoot: managed,
  });
  const managedRootId = String(managedRegistration.rootId);
  const target = path.join(managed, "thread-one");
  await fs.mkdir(target, { recursive: true });
  const first = await client.fileMaterialize({
    operationId: "r3-materialize-first",
    workspaceId: "r3-materialize-workspace",
    rootId: managedRootId,
    path: "thread-one",
    sourceRoot: immutableRoot,
  });
  assert.equal(first.status, "materialized");
  assert.equal(await fs.readFile(path.join(target, "plain.txt"), "utf8"), "fixed plain\n");
  assert.equal(await fs.readFile(path.join(target, "nested", "b.txt"), "utf8"), "fixed nested\n");
  await assert.rejects(fs.stat(path.join(target, "old.txt")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(target, ".git")), { code: "ENOENT" });
  const cow = first.cow as { reflink?: number; copy?: number };
  assert.equal((cow.reflink ?? 0) + (cow.copy ?? 0), 2);
  if (process.platform === "win32") {
    assert.equal(cow.reflink ?? 0, 0, "Windows must not claim reflink without an implemented block-clone backend");
    assert.equal(cow.copy ?? 0, 2);
  }
  const measured = await client.fileMeasure({
    workspaceId: "r3-materialize-workspace",
    rootId: managedRootId,
    path: "thread-one",
  });
  assert.equal(measured.unknown, false);
  assert.equal(Number(measured.logicalBytes) >= Buffer.byteLength("fixed plain\n") + Buffer.byteLength("fixed nested\n"), true);
  if (process.platform === "win32") {
    assert.equal(measured.allocatedBytes, null, "Windows allocated bytes stay unknown until a verified physical-allocation backend exists");
  } else {
    assert.equal(typeof measured.allocatedBytes, "number");
  }

  await fs.writeFile(path.join(source, "plain.txt"), "live parent drift\n");
  assert.equal(await fs.readFile(path.join(target, "plain.txt"), "utf8"), "fixed plain\n");
  await client.fileRemove({
    operationId: "r3-reclaim-first",
    workspaceId: "r3-materialize-workspace",
    rootId: managedRootId,
    path: "thread-one",
    recursive: true,
    force: true,
  });
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
  const missingMeasurement = await client.fileMeasure({
    workspaceId: "r3-materialize-workspace",
    rootId: managedRootId,
    path: "thread-one",
  });
  assert.equal(missingMeasurement.unknown, true);
  assert.equal(missingMeasurement.logicalBytes, null);
  const second = await client.fileMaterialize({
    operationId: "r3-materialize-second",
    workspaceId: "r3-materialize-workspace",
    rootId: managedRootId,
    path: "thread-one",
    sourceRoot: immutableRoot,
  });
  assert.equal(second.status, "materialized");
  assert.equal(await fs.readFile(path.join(target, "plain.txt"), "utf8"), "fixed plain\n");
});

test("R3 materialization reconciles a crash after live backup before staging promotion", { timeout: 30_000 }, async (t) => {
  if (!(await fs.stat(kernelPath).then(() => true).catch(() => false))) {
    t.skip("release kernel has not been built in this checkout");
    return;
  }
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-r3-reconcile-"));
  const managed = await fs.mkdtemp(path.join(os.tmpdir(), "varin-kernel-r3-reconcile-managed-"));
  roots.push(storageRoot, managed);

  const seedHost = createKernelClient({
    hostId: "r3-reconcile-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  clients.push(seedHost);
  await seedHost.start();
  const seed = seedHost.scoped(await issueActor(seedHost, "r3-reconcile-seed", "r3-reconcile-workspace"));
  const body = await seed.putBlob(Buffer.from("new immutable body\n"), "r3-reconcile-object");
  const branch = await seed.createBranch({
    operationId: "r3-reconcile-branch",
    branchId: "r3-reconcile-branch",
    workspaceId: "r3-reconcile-workspace",
    draftBasePaths: [],
    captureScopes: [],
    entries: [{
      path: "result.txt",
      state: { kind: "regular-file", objectHash: body.hash, byteLength: body.byteLength, mode: 0o644 },
      ownerId: body.ownerId,
    }],
  });
  await seedHost.close();
  clients.splice(clients.indexOf(seedHost), 1);

  const live = path.join(managed, "thread-crash");
  await fs.mkdir(live, { recursive: true });
  const faultedHost = createKernelClient({
    hostId: "r3-reconcile-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
    env: { VARIN_KERNEL_FAIL_MATERIALIZE_AFTER_BACKUP: "1" },
  });
  clients.push(faultedHost);
  await faultedHost.start();
  const faulted = faultedHost.scoped(await issueActor(faultedHost, "r3-reconcile-faulted", "r3-reconcile-workspace"));
  const registration = await faulted.fileRootRegister({
    workspaceId: "r3-reconcile-workspace",
    executionWorkspaceId: "r3-reconcile-workspace",
    canonicalRoot: managed,
  });
  const rootId = String(registration.rootId);
  await assert.rejects(
    faulted.fileMaterialize({
      operationId: "r3-crash-materialize",
      workspaceId: "r3-reconcile-workspace",
      rootId,
      path: "thread-crash",
      sourceRoot: String(branch.root),
    }),
    /injected materialize failure after backup/i,
  );
  await assert.rejects(fs.stat(live), { code: "ENOENT" });
  assert.ok((await fs.readdir(managed)).some((name) => name.startsWith("thread-crash.varin-staging-")));
  assert.ok((await fs.readdir(managed)).some((name) => name.startsWith("thread-crash.varin-backup-")));
  await faultedHost.close();
  clients.splice(clients.indexOf(faultedHost), 1);

  const reopenedHost = createKernelClient({
    hostId: "r3-reconcile-host",
    storageRoot,
    buildVersion,
    kernelPath,
    allowCargoDevRunner: false,
  });
  clients.push(reopenedHost);
  await reopenedHost.start();
  const reopened = reopenedHost.scoped(await issueActor(reopenedHost, "r3-reconcile-reopened", "r3-reconcile-workspace"));
  const reopenedRegistration = await reopened.fileRootRegister({
    workspaceId: "r3-reconcile-workspace",
    executionWorkspaceId: "r3-reconcile-workspace",
    canonicalRoot: managed,
  });
  assert.equal(reopenedRegistration.rootId, rootId);
  assert.equal(reopenedRegistration.reconciledOperations, 1);
  assert.equal(reopenedRegistration.pendingOperations, 0);
  assert.equal(await fs.readFile(path.join(live, "result.txt"), "utf8"), "new immutable body\n");
  assert.deepEqual((await fs.readdir(managed)).filter((name) => name.includes(".varin-staging-") || name.includes(".varin-backup-")), []);
  const retried = await reopened.fileMaterialize({
    operationId: "r3-crash-materialize",
    workspaceId: "r3-reconcile-workspace",
    rootId,
    path: "thread-crash",
    sourceRoot: String(branch.root),
  });
  assert.equal(retried.status, "materialized");
  assert.equal(retried.reconciled, true);
});
