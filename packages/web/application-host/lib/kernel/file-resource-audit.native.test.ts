import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, it as vitestIt } from "vitest";
import { createDocumentAuthorityHarness } from "../documents/contract-fixtures.js";
import { KernelRecoveryContentStore, KernelRecoveryStore } from "./kernel-recovery-store.js";
import { createDocumentAuthority } from "../documents/authority.js";
import { assertManagedWorktreeOwnership } from "../harness/worktree-ownership.js";
import { createManagedRootAdmission } from "./managed-root-admission.js";
import { KernelFileResourceBackend } from "./file-resource-backend.js";
import { createKernelClient, type KernelClient } from "./kernel-client.js";
import { createKernelWorkspaceWorkingStateAccess, KernelStorageAdapter } from "./storage-adapter.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repositoryRoot, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;
const hasReleaseKernel = await fs.stat(kernelPath).then(() => true).catch(() => false);
if (process.env.VARIN_REQUIRE_RELEASE_KERNEL === "1" && !hasReleaseKernel) {
  throw new Error("Kernel authority acceptance requires a built release kernel");
}
const it = vitestIt.skipIf(!hasReleaseKernel);
const clients: KernelClient[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(env: Record<string, string> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-authority-audit-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const storageRoot = path.join(root, "storage");
  await fs.mkdir(path.join(workspace, "nested"), { recursive: true });
  const host = createKernelClient({ hostId: "audit", storageRoot, kernelPath, buildVersion, allowCargoDevRunner: false, env });
  clients.push(host);
  await host.start();
  const scoped = async (id: string, workspaceId = "ws", scopes = [""]) => host.scoped(await host.issueGrant({
    grantId: id, owningWorkspace: workspaceId, executionWorkspace: workspaceId,
    pathScopes: scopes, capabilities: ["storage.read", "storage.write", "storage.gc"],
  }));
  const client = await scoped("actor");
  const registered = await client.fileRootRegister({ workspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: workspace });
  const rootId = String(registered.rootId);
  return { root, workspace, storageRoot, host, client, scoped, rootId, address: { workspaceId: "ws", rootId } };
}

it("audit: overlapping physical directories share one lease boundary across root registrations", async () => {
  const f = await fixture();
  const other = await f.scoped("other", "other-ws");
  const nested = await other.fileRootRegister({ workspaceId: "other-ws", executionWorkspaceId: "other-ws", canonicalRoot: path.join(f.workspace, "nested") });
  await f.client.fileLeaseAcquire({ ...f.address, leaseId: "parent-lease", resources: [{ path: "nested", scope: "subtree" }] });
  const attempted = await other.fileLeaseAcquire({ workspaceId: "other-ws", rootId: String(nested.rootId), leaseId: "child-lease", resources: [{ path: "data.txt", scope: "exact" }] });
  assert.equal(attempted.status, "busy");
});

it("audit: a descendant subtree lease cannot authorize an ancestor removal", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.workspace, "nested", "child"));
  await fs.writeFile(path.join(f.workspace, "nested", "keep.txt"), "keep");
  await f.client.fileLeaseAcquire({ ...f.address, leaseId: "narrow", resources: [{ path: "nested/child", scope: "subtree" }] });
  await assert.rejects(f.client.fileRemove({ ...f.address, operationId: "bad-remove", path: "nested", recursive: true, force: true, leaseId: "narrow" }), /lease|scope/i);
  assert.equal(await fs.readFile(path.join(f.workspace, "nested", "keep.txt"), "utf8"), "keep");
});

it("audit: an exact lease cannot authorize recursive removal of the same directory", async () => {
  const f = await fixture();
  await f.client.fileLeaseAcquire({ ...f.address, leaseId: "exact", resources: [{ path: "nested", scope: "exact" }] });
  await assert.rejects(f.client.fileRemove({ ...f.address, operationId: "bad-recursive", path: "nested", recursive: true, force: true, leaseId: "exact" }), /lease|scope/i);
});

it("audit: a lease id cannot silently accept a different resource set", async () => {
  const f = await fixture();
  await f.client.fileLeaseAcquire({ ...f.address, leaseId: "same-id", resources: [{ path: "a", scope: "exact" }] });
  await assert.rejects(f.client.fileLeaseAcquire({ ...f.address, leaseId: "same-id", resources: [{ path: "b", scope: "subtree" }] }), /reuse|different|resource/i);
});

it("audit: in-root directory aliases cannot evade a writer lease", async () => {
  const f = await fixture();
  await fs.symlink(path.join(f.workspace, "nested"), path.join(f.workspace, "alias"), process.platform === "win32" ? "junction" : "dir");
  await f.client.fileLeaseAcquire({ ...f.address, leaseId: "real-path", resources: [{ path: "nested/data.txt", scope: "exact" }] });
  const attempted = await f.client.fileLeaseAcquire({ ...f.address, leaseId: "alias-path", resources: [{ path: "alias/data.txt", scope: "exact" }] });
  assert.equal(attempted.status, "busy");
});

it("audit: replacing an admitted root with a link does not authorize outside capture", async () => {
  const f = await fixture();
  const outside = path.join(f.root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.txt"), "outside");
  await fs.rename(f.workspace, `${f.workspace}-original`);
  await fs.symlink(outside, f.workspace, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.client.fileCapture({ ...f.address, operationId: "root-swapped", path: "private.txt", store: false }), /root|escape|identity/i);
});

it("audit: a fresh rename cannot report success for a missing source and unrelated target", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.workspace, "target.txt"), "unrelated");
  await assert.rejects(f.client.fileRename({ ...f.address, operationId: "fresh-rename", fromPath: "missing.txt", toPath: "target.txt" }), /source|missing/i);
  assert.equal(await fs.readFile(path.join(f.workspace, "target.txt"), "utf8"), "unrelated");
});

it("audit: retrying a remove after terminal loss never deletes newly created user content", async () => {
  const f = await fixture({ VARIN_KERNEL_FAIL_OPERATION_FINISH: "1" });
  const target = path.join(f.workspace, "note.txt");
  await fs.writeFile(target, "original");
  const request = { ...f.address, operationId: "remove-lost-terminal", path: "note.txt", recursive: false, force: true };
  await assert.rejects(f.client.fileRemove(request), /finish failure/i);
  await fs.writeFile(target, "new user edit");
  await f.client.fileRemove(request).catch(() => undefined);
  assert.equal(await fs.readFile(target, "utf8"), "new user edit");
});

it("audit: file apply cannot consume another grant's temporary object owner", async () => {
  const f = await fixture();
  const other = await f.scoped("other");
  const blob = await other.putBlob(Buffer.from("other grant body"), "other-blob");
  await assert.rejects(f.client.fileApply({ ...f.address, operationId: "foreign-object", path: "stolen.txt", ownerId: blob.ownerId, targetJson: JSON.stringify({ kind: "regular-file", objectHash: blob.hash, byteLength: blob.byteLength }) }), /owner|grant|authoriz/i);
});

async function restart(f: Awaited<ReturnType<typeof fixture>>) {
  await f.host.close();
  const host = createKernelClient({ hostId: "audit", storageRoot: f.storageRoot, kernelPath, buildVersion, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  return host.scoped(await host.issueGrant({ grantId: "restarted-actor", owningWorkspace: "ws", executionWorkspace: "ws", pathScopes: [""], capabilities: ["storage.read", "storage.write", "storage.gc"] }));
}

it("audit: GC cannot delete a blob reintroduced after physical cleanup failed", async () => {
  const f = await fixture({ VARIN_KERNEL_FAIL_GC_DELETE: "1" });
  const first = await f.client.putBlob(Buffer.from("revived body"), "gc-first");
  await f.client.releaseBlob(first.ownerId);
  const released = await f.client.gc("gc-queued");
  assert.ok((released.cleanupFailures as unknown[]).length > 0);
  const second = await f.client.putBlob(Buffer.from("revived body"), "gc-revived");
  await f.client.createBranch({ operationId: "gc-retain", workspaceId: "ws", branchId: "revived", draftBasePaths: [], captureScopes: [], entries: [{ path: "note.txt", state: { kind: "regular-file", objectHash: second.hash, byteLength: second.byteLength, mode: 0o644 }, ownerId: second.ownerId }] });
  const resumed = await restart(f);
  await resumed.getBlob(second.hash, { branchId: "revived", path: "note.txt" });
});

it("audit: GC and operation.release preserve unfinished filesystem reconciliation records", async () => {
  const f = await fixture({ VARIN_KERNEL_FAIL_OPERATION_FINISH: "1" });
  await assert.rejects(f.client.fileMkdir({ ...f.address, operationId: "pending-mkdir", path: "created", recursive: true }), /finish failure/);
  const resumed = await restart(f);
  const release = await resumed.releaseOperation("pending-mkdir");
  assert.equal(release.released, false, "an unfinished operation is not releasable");
  await resumed.gc("gc-with-pending");
  assert.equal((await resumed.getOperation("pending-mkdir"))?.state, "started");
  await resumed.fileRootRegister({ workspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: f.workspace });
  assert.equal((await resumed.getOperation("pending-mkdir"))?.state, "committed");
});

it("audit: unresolved directory rename is visible and remains explicitly needs-attention", async () => {
  const f = await fixture({ VARIN_KERNEL_FAIL_OPERATION_FINISH: "1" });
  await fs.mkdir(path.join(f.workspace, "tree", "nested"), { recursive: true });
  await fs.writeFile(path.join(f.workspace, "tree", "nested", "value.txt"), "preserve");
  await assert.rejects(f.client.fileRename({
    ...f.address, operationId: "pending-directory-rename", fromPath: "tree", toPath: "moved-tree", targetMustBeMissing: true,
  }), /finish failure/i);
  await f.host.close();
  const host = createKernelClient({ hostId: "audit", storageRoot: f.storageRoot, kernelPath, buildVersion, allowCargoDevRunner: false });
  clients.push(host);
  await host.start();
  const adapter = new KernelStorageAdapter({ client: host, hostId: "audit", storageRoot: f.storageRoot, resolveWorkspaceRoot: async () => f.workspace });
  try {
    const context = await adapter.fileAuthorityContext({
      owningWorkspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: f.workspace, capabilities: ["storage.maintenance"],
    });
    assert.equal(context.pendingFileOperations.length, 1);
    assert.deepEqual(context.pendingFileOperations[0], {
      operationId: "pending-directory-rename", kind: "file.rename", rootId: context.rootId,
      paths: ["tree", "moved-tree"], disposition: "needs-attention",
      reason: "directory-rename-cannot-be-proven-from-directory-metadata",
      createdAt: context.pendingFileOperations[0]!.createdAt, updatedAt: context.pendingFileOperations[0]!.updatedAt,
    });
    const reconciled = await context.reconcilePendingFileOperation("pending-directory-rename");
    assert.equal(reconciled.status, "pending");
    assert.equal((reconciled.operation as Record<string, unknown>).reason, "directory-rename-cannot-be-proven-from-directory-metadata");
    assert.equal(await fs.readFile(path.join(f.workspace, "moved-tree", "nested", "value.txt"), "utf8"), "preserve");
    await assert.rejects(fs.stat(path.join(f.workspace, "tree")), { code: "ENOENT" });
  } finally {
    await adapter.dispose();
  }
});

it("audit: execution-only Host maintenance hints do not require a fake session actor", async () => {
  const f = await fixture();
  const adapter = new KernelStorageAdapter({ client: f.host, hostId: "audit", storageRoot: f.storageRoot, resolveWorkspaceRoot: async () => f.workspace,
    resolveActor: async (_workspace, _purpose, hint) => {
      if (!hint?.capabilities?.includes("storage.maintenance")) throw new Error("exact session actor required");
      return hint;
    },
  });
  const access = createKernelWorkspaceWorkingStateAccess(adapter);
  await access.withBranchStore("ws", "thread-baseline-capture", async (store) => {
    await store.createBranch("ws", "baseline", {}, "zero-commit");
  }, "exclusive", { executionWorkspace: "ws" });
  await adapter.dispose();
});

async function branch(f: Awaited<ReturnType<typeof fixture>>) {
  const blob = await f.client.putBlob(Buffer.from("immutable body"), "source-object");
  return f.client.createBranch({ operationId: "source-branch", workspaceId: "ws", branchId: "source", draftBasePaths: [], captureScopes: [], entries: [
    { path: "note.txt", state: { kind: "regular-file", objectHash: blob.hash, byteLength: blob.byteLength, mode: 0o644 }, ownerId: blob.ownerId },
  ] });
}

it("audit: unknown materialization target is preserved on both initial call and retry", async () => {
  const f = await fixture();
  const source = await branch(f);
  const live = path.join(f.workspace, "nested", "user.txt");
  await fs.writeFile(live, "user content");
  const request = { ...f.address, operationId: "occupied-materialize", path: "nested", sourceRoot: String(source.root) };
  assert.equal((await f.client.fileMaterialize(request)).status, "conflict");
  assert.equal((await f.client.fileMaterialize(request)).status, "conflict");
  assert.equal(await fs.readFile(live, "utf8"), "user content");
});

it("audit: a restricted path grant cannot materialize the entire workspace root", async () => {
  const f = await fixture();
  const source = await branch(f);
  const restricted = await f.scoped("restricted", "ws", ["nested"]);
  await assert.rejects(restricted.fileMaterialize({ ...f.address, operationId: "restricted-materialize", path: "nested", sourceRoot: String(source.root) }), /grant|scope/i);
  assert.deepEqual(await fs.readdir(path.join(f.workspace, "nested")), []);
});

it("audit: scan continuation rejects changed inventories instead of silently shifting offsets", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.workspace, "a"), "a");
  await fs.writeFile(path.join(f.workspace, "b"), "b");
  const first = await f.client.fileScan({ ...f.address, path: "", pageSize: 1 });
  const continuation = { ...f.address, path: "", pageSize: 1, cursor: Number(first.nextCursor), expectedFingerprint: String(first.fingerprint) };
  const stable = await f.client.fileScan(continuation);
  assert.equal(stable.fingerprint, first.fingerprint);
  await fs.writeFile(path.join(f.workspace, "0-new"), "new");
  await assert.rejects(f.client.fileScan(continuation), /inventory|fingerprint/i);
});

it("audit: nested Host gates must prove their resource coverage in the kernel", async () => {
  const f = await fixture();
  const adapter = new KernelStorageAdapter({ client: f.host, hostId: "audit", storageRoot: f.storageRoot, resolveWorkspaceRoot: async () => f.workspace });
  const backend = new KernelFileResourceBackend(adapter);
  const identity = { authorityId: "audit", canonicalRoot: f.workspace, filesystemProfile: "test", workspaceId: "ws" };
  let invoked = false;
  await backend.gateFor(identity).run([{ resourceId: "nested", scope: "subtree" }], async () => {
    await backend.gateFor(identity).run([{ resourceId: "nested/a", scope: "exact" }], async () => undefined);
    await assert.rejects(backend.gateFor(identity).run([{ resourceId: "unrelated", scope: "exact" }], async () => { invoked = true; }), /lease|scope/i);
  });
  assert.equal(invoked, false);
  await adapter.dispose();
});

it("audit: a readonly target can be durably installed without reopening it writable", async () => {
  const f = await fixture();
  const blob = await f.client.putBlob(Buffer.from("readonly"), "readonly-object");
  const result = await f.client.fileApply({ ...f.address, operationId: "readonly-apply", path: "readonly.txt", ownerId: blob.ownerId, expectedJson: JSON.stringify({ kind: "missing" }), targetJson: JSON.stringify({ kind: "regular-file", objectHash: blob.hash, byteLength: blob.byteLength, mode: 0o444 }) });
  try {
    assert.equal(result.status, "applied");
    assert.equal(await fs.readFile(path.join(f.workspace, "readonly.txt"), "utf8"), "readonly");
  } finally { await fs.chmod(path.join(f.workspace, "readonly.txt"), 0o666); }
});

it("audit: an in-root alias cannot expand a restricted actor's canonical scope", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.workspace, "nested", "secret.txt"), "secret");
  await fs.symlink(path.join(f.workspace, "nested"), path.join(f.workspace, "allowed"), process.platform === "win32" ? "junction" : "dir");
  const actor = await f.scoped("narrow-scope", "ws", ["allowed"]);
  await assert.rejects(actor.fileCapture({ ...f.address, operationId: "alias-scope", path: "allowed/secret.txt", store: false }), /scope/i);
});

it("audit: real Documents execution identity stays separate from managed-root materialization admission", async () => {
  const f = await fixture();
  const managedRoot = path.join(f.root, "managed");
  const live = path.join(managedRoot, "thread-one");
  await fs.mkdir(live, { recursive: true });
  await fs.writeFile(path.join(f.workspace, "note.txt"), "baseline body");
  const documents = createDocumentAuthority({ hostId: "audit", dataDir: path.join(f.root, "documents"), isAllowedRoot: async () => true, isTrusted: async () => true });
  const owning = (await documents.resolveWorkspace({ path: f.workspace })).workspaceId;
  const execution = (await documents.resolveWorkspace({ path: live })).workspaceId;
  assert.notEqual(owning, execution);
  const adapter = new KernelStorageAdapter({ client: f.host, hostId: "audit", storageRoot: f.storageRoot,
    resolveWorkspaceRoot: async (workspaceId) => (await documents.inspectWorkspace(workspaceId)).root,
    resolveActor: async (_workspaceId, _purpose, hint) => {
      assert.ok(hint, "Host lifecycle must provide an explicit identity");
      assert.ok(hint.capabilities?.includes("storage.maintenance"));
      return hint;
    },
  });
  adapter.bindFileRootResolver(async (directory) => {
    const { workspaceId } = await documents.resolveWorkspace({ path: directory });
    return { workspaceId, canonicalRoot: (await documents.inspectWorkspace(workspaceId)).root };
  });
  const admission = createManagedRootAdmission({
    listWorktrees: async (workspaceId) => workspaceId === owning ? [{ path: live, managedRoot, base: "zero-commit", materialized: false }] : [],
    assertOwnership: (worktree, operation, paths) => assertManagedWorktreeOwnership(worktree, operation, paths, {
      authorizeManagedRoot: async (candidate) => candidate === managedRoot,
    }),
  });
  adapter.bindManagedRootResolver(admission.materialization);
  const access = createKernelWorkspaceWorkingStateAccess(adapter);
  try {
    await assert.rejects(admission.materialization(path.join(managedRoot, "unrecorded"), owning), /ownership/i);
    await assert.rejects(admission.materialization(live, "another-owning-workspace"), /ownership/i);
    await access.withBranchStore(owning, "thread-baseline-capture", async (store) => {
      const states = await store.captureDirectory(f.workspace);
      await store.createBranch(owning, "recorded-thread", states, "zero-commit");
      const pin = await store.pinBranch("recorded-thread");
      try { await store.materializePinManaged!(pin, live, "recorded-materialize"); }
      finally { await pin.release(); }
    }, "exclusive", { executionWorkspace: owning });
    assert.equal(await fs.readFile(path.join(live, "note.txt"), "utf8"), "baseline body");
    await fs.writeFile(path.join(live, "note.txt"), "shell result");
    const result = await access.withBranchStore(owning, "thread-result-publish", (store) => store.publishDirectoryResult("recorded-thread", live), "exclusive", { executionWorkspace: execution });
    assert.ok(result.changedPaths.includes("note.txt"));
    assert.equal(await access.withBranchStore(owning, "thread-result-reclaim-check", (store) => store.directoryMatchesResult("recorded-thread", result.resultRevision, live), "shared", { executionWorkspace: execution }), true);
    await fs.rm(live, { recursive: true });
    await access.withBranchStore(owning, "thread-recorded-materialize", (store) => store.materializeResult("recorded-thread", result.resultRevision, live));
    assert.equal(await fs.readFile(path.join(live, "note.txt"), "utf8"), "shell result");
  } finally {
    await adapter.dispose();
    await documents.dispose();
  }
}, 30_000);

it("audit: RecoveryFileStore applyState does not turn a conditional conflict into success", async () => {
  const f = await fixture();
  const adapter = new KernelStorageAdapter({ client: f.host, hostId: "audit", storageRoot: f.storageRoot, resolveWorkspaceRoot: async () => f.workspace });
  const backend = new KernelFileResourceBackend(adapter);
  const identity = { authorityId: "audit", canonicalRoot: f.workspace, filesystemProfile: "test", workspaceId: "ws" };
  await fs.writeFile(path.join(f.workspace, "note.txt"), "before");
  await backend.gateFor(identity).run([{ resourceId: "note.txt", scope: "exact" }], async () => {
    await backend.captureState(identity, f.storageRoot, "note.txt", { store: false });
    await fs.writeFile(path.join(f.workspace, "note.txt"), "user changed");
    await assert.rejects(backend.applyState(identity, f.storageRoot, "note.txt", { kind: "missing" }), /conflict/i);
  });
  assert.equal(await fs.readFile(path.join(f.workspace, "note.txt"), "utf8"), "user changed");
  await adapter.dispose();
});

it("audit: epoch-local query pins expire on restart while explicit revision pins survive", async () => {
  const f = await fixture();
  const source = await branch(f);
  await f.client.pinBranch({ operationId: "ephemeral-pin", branchId: "source", expectedWriteRevision: Number(source.writeRevision), expectedRoot: String(source.root), pinId: "query-pin" });
  await f.client.deleteBranch({ operationId: "drop-ephemeral-branch", branchId: "source" });
  const durableBlob = await f.client.putBlob(Buffer.from("durable pin bytes"), "durable-pin-object");
  await f.client.createBranch({ operationId: "durable-branch", workspaceId: "ws", branchId: "durable", draftBasePaths: [], captureScopes: [], entries: [
    { path: "note.txt", state: { kind: "regular-file", objectHash: durableBlob.hash, byteLength: durableBlob.byteLength, mode: 0o644 }, ownerId: durableBlob.ownerId },
  ] });
  await f.client.pinBranch({ operationId: "durable-pin", branchId: "durable", revision: 0, pinId: "retained-pin" });
  await f.client.deleteBranch({ operationId: "drop-durable-branch", branchId: "durable" });
  const resumed = await restart(f);
  const gc = await resumed.gc("after-query-owner-exit");
  assert.equal(gc.releasedBlobs, 1, "only the abandoned query object should be collected");
  await resumed.getBlob(durableBlob.hash, { pinId: "retained-pin", path: "note.txt" });
});

it("audit: a pending materialization retains its source root across branch deletion, GC and restart", async () => {
  const f = await fixture({ VARIN_KERNEL_FAIL_MATERIALIZE_AFTER_BACKUP: "1" });
  const source = await branch(f);
  await assert.rejects(f.client.fileMaterialize({ ...f.address, operationId: "pending-materialize", path: "nested", sourceRoot: String(source.root) }), /after backup/i);
  await f.client.deleteBranch({ operationId: "drop-materialize-branch", branchId: "source" });
  await f.client.gc("gc-before-materialize-recovery");
  const resumed = await restart(f);
  await resumed.gc("gc-after-materialize-restart");
  const root = await resumed.fileRootRegister({ workspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: f.workspace });
  assert.equal(root.reconciledOperations, 1);
  assert.equal(await fs.readFile(path.join(f.workspace, "nested", "note.txt"), "utf8"), "immutable body");
});

it("audit: real Documents write, stale save, move and delete use the kernel Recovery gate", async () => {
  const f = await fixture();
  const h = await createDocumentAuthorityHarness({ hostId: "audit" });
  const adapter = new KernelStorageAdapter({ client: f.host, hostId: "audit", storageRoot: f.storageRoot,
    resolveWorkspaceRoot: async (workspaceId) => (await h.authority.inspectWorkspace(workspaceId)).root,
  });
  const backend = new KernelFileResourceBackend(adapter, { authorityPurpose: "recovery-maintenance", authorityCapabilities: ["recovery.maintenance"],
    resolveExecutionRoot: async (directory) => {
      const { workspaceId } = await h.authority.resolveWorkspace({ path: directory });
      return { workspaceId, canonicalRoot: (await h.authority.inspectWorkspace(workspaceId)).root };
    },
  });
  const content = new KernelRecoveryContentStore(adapter, backend);
  adapter.bindFileStore(content);
  const recovery = new KernelRecoveryStore(adapter, content);
  h.authority.bindDurableMutationStorage(async (workspaceId, operation) => operation(await recovery.workspaceStorageContext(workspaceId)));
  try {
    const written = await h.authority.write({ resource: h.resource("saved.txt"), token: h.token(), content: "saved", encoding: "utf-8", bom: false, expectedRevision: null, operationId: "editor-save" });
    assert.equal(written.status, "written");
    if (written.status !== "written") throw new Error("expected a real disk write");
    const stale = await h.authority.write({ resource: h.resource("saved.txt"), token: h.token(), content: "stale", encoding: "utf-8", bom: false, expectedRevision: null });
    assert.equal(stale.status, "conflict");
    const moved = await h.authority.move({ from: h.resource("saved.txt"), to: h.resource("nested/moved.txt"), token: h.token(), expectedRevision: written.revision, operationId: "editor-move" });
    assert.equal(moved.status, "moved");
    if (moved.status !== "moved") throw new Error("expected a real disk rename");
    assert.equal(await fs.readFile(path.join(h.workspaceRoot, "nested/moved.txt"), "utf8"), "saved");
    const removed = await h.authority.delete({ resource: h.resource("nested/moved.txt"), token: h.token(), expectedRevision: moved.revision, operationId: "editor-delete" });
    assert.equal(removed.status, "deleted");
    await assert.rejects(fs.stat(path.join(h.workspaceRoot, "nested/moved.txt")), { code: "ENOENT" });
    let invoked = false;
    await h.authority.runResourceOperation(h.identity.workspaceId, [{ resourceId: "nested", scope: "exact" }], async () => {
      await assert.rejects(h.authority.runResourceOperation(h.identity.workspaceId, [{ resourceId: "nested", scope: "subtree" }], async () => { invoked = true; }), /scope|lease/i);
    });
    assert.equal(invoked, false, "Documents must not shortcut kernel coverage validation");
  } finally { await adapter.dispose(); await h.cleanup(); }
}, 30_000);

it("audit: materialization installs children before readonly directory modes", async () => {
  const f = await fixture();
  const blob = await f.client.putBlob(Buffer.from("readonly child"), "readonly-tree-object");
  const source = await f.client.createBranch({ operationId: "readonly-tree", workspaceId: "ws", branchId: "readonly-tree", draftBasePaths: [], captureScopes: [], entries: [
    { path: "locked", state: { kind: "directory", mode: 0o555 } },
    { path: "locked/note.txt", state: { kind: "regular-file", objectHash: blob.hash, byteLength: blob.byteLength, mode: 0o444 }, ownerId: blob.ownerId },
  ] });
  const directory = path.join(f.workspace, "nested", "locked");
  const note = path.join(directory, "note.txt");
  try {
    const result = await f.client.fileMaterialize({ ...f.address, operationId: "readonly-tree-materialize", path: "nested", sourceRoot: String(source.root) });
    assert.equal(result.status, "materialized");
    assert.equal(await fs.readFile(note, "utf8"), "readonly child");
    assert.equal((await fs.stat(note)).mode & 0o200, 0);
  } finally {
    await fs.chmod(directory, 0o777).catch(() => undefined);
    await fs.chmod(note, 0o666).catch(() => undefined);
  }
});

it("audit: ambiguous interrupted directory rename remains pending instead of claiming recovery", async () => {
  const f = await fixture({ VARIN_KERNEL_FAIL_OPERATION_FINISH: "1" });
  await fs.writeFile(path.join(f.workspace, "nested", "note.txt"), "original tree");
  await assert.rejects(f.client.fileRename({ ...f.address, operationId: "directory-rename", fromPath: "nested", toPath: "moved" }), /finish failure/i);
  await fs.writeFile(path.join(f.workspace, "moved", "note.txt"), "later user edit");
  const resumed = await restart(f);
  const registration = await resumed.fileRootRegister({ workspaceId: "ws", executionWorkspaceId: "ws", canonicalRoot: f.workspace });
  assert.equal(registration.pendingOperations, 1);
  assert.equal((await resumed.getOperation("directory-rename"))?.state, "started");
  assert.equal(await fs.readFile(path.join(f.workspace, "moved", "note.txt"), "utf8"), "later user edit");
});
