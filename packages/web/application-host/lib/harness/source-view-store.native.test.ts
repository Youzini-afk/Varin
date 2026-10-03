import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createSourceViewStore, SOURCE_VIEW_STORAGE_SCOPE } from "./source-view-store.js";
import { createSourceViewRuntime } from "./source-view-runtime.js";
import { createKernelClient } from "../kernel/kernel-client.js";
import { createKernelWorkspaceWorkingStateAccess, KernelStorageAdapter } from "../kernel/storage-adapter.js";
import { attachLiveSurfaceCompleter, createDocumentAuthorityHarness, hashSurfaceText, type LiveSurfaceBuffer } from "../documents/contract-fixtures.js";
import type { DirtyBufferPublication } from "../documents/authority.js";
import { createInMemoryRecoveryDurablePort } from "../recovery/recovery-durable-port.test-helper.js";
import { createRecoveryFileStore } from "../recovery/file-store.test-helper.js";

const openStore = () => {
  const objects = new Map<string, Buffer>();
  const records = new Map<string, { recordId: string; recordType: string; state: string; payloadJson: string; references: Array<{ slot: string; objectHash: string }> }>();
  const scopes: string[] = [];
  const store = {
    async putObject(bytes: Buffer) {
      const hash = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
      objects.set(hash, Buffer.from(bytes));
      return { hash, byteLength: bytes.byteLength };
    },
    async getObject(hash: string) { return objects.get(hash) ?? null; },
  };
  const context = {
    records: {
      async get(id: string) { return records.get(id) ?? null; },
      async list(input: { recordType?: string }) { return [...records.values()].filter((record) => !input.recordType || record.recordType === input.recordType); },
      async put(input: { recordId: string; recordType: string; state: string; payloadJson: string; references: Array<{ slot: string; objectHash: string }> }) {
        records.set(input.recordId, input);
        return input;
      },
      async release(_operationId: string, id: string) { records.delete(id); return { released: true }; },
    },
  };
  const workingStates: WorkspaceWorkingStateRootAccess = {
    withBranchStore: async (scope, _purpose, operation) => {
      scopes.push(scope);
      return operation(store as unknown as WorkingStateRootStore, context as unknown as WorkingStateRootContext);
    },
  };
  return { views: createSourceViewStore(workingStates), reopen: () => createSourceViewStore(workingStates), scopes, records };
};

describe("fixed source views", () => {
  it("retains an external draft across a Host restart and binds reads to physical identity", async () => {
    const opened = openStore();
    const captured = await opened.views.capture({
      status: "ready",
      resources: [{
        resource: { workspaceId: "B", resourceId: "draft.ts" },
        aliases: [{ workspaceId: "B", resourceId: "draft.ts" }],
        coordinationId: "physical-1",
        content: "unsaved B",
        revision: "draft-rev-1",
        baseRevision: null,
        encoding: "utf-8",
        bom: false,
        localEditRevision: 1,
      }],
      supersededResources: [],
    }, "A");
    expect(captured).not.toBeNull();
    const viewId = captured!.viewId;
    const reopened = opened.reopen();
    expect(await reopened.contextFor(viewId)).toEqual(captured!.context);
    expect(await reopened.read(viewId, "B", "draft.ts", "physical-1")).toMatchObject({
      status: "ready", content: "unsaved B", revision: "draft-rev-1",
    });
    expect(await reopened.read(viewId, "B", "draft.ts", "different-physical-file")).toMatchObject({ status: "unavailable" });
    expect(await reopened.read(viewId, "B", "other.ts", null)).toEqual({ status: "disk" });
    expect(opened.scopes.every((scope) => scope === SOURCE_VIEW_STORAGE_SCOPE)).toBe(true);
    await reopened.reconcile(new Set([viewId]));
    expect(await opened.views.contextFor(viewId)).not.toBeNull();
    await reopened.release(viewId);
    expect(await opened.views.contextFor(viewId)).toBeNull();
  });

  it("releases only orphan views after a restart", async () => {
    const opened = openStore();
    const cloned = { status: "ready" as const, resources: [{
      resource: { workspaceId: "B", resourceId: "draft.ts" }, coordinationId: "file-1", content: "draft",
      revision: "r1", baseRevision: null, encoding: "utf-8", bom: false, localEditRevision: 1,
    }], supersededResources: [] };
    const kept = await opened.views.capture(cloned, "A");
    const orphan = await opened.views.capture(cloned, "A");
    await opened.reopen().reconcile(new Set([kept!.viewId]));
    expect(await opened.views.contextFor(kept!.viewId)).not.toBeNull();
    expect(await opened.views.contextFor(orphan!.viewId)).toBeNull();
  });

  it("keeps older ownerless source views readable without granting editor writes", async () => {
    const opened = openStore();
    const captured = await opened.views.capture({
      status: "ready", resources: [{
        resource: { workspaceId: "B", resourceId: "draft.ts" }, coordinationId: "file-1",
        content: "old draft", revision: "r1", baseRevision: null, encoding: "utf-8", bom: false,
        localEditRevision: 1,
      }], supersededResources: [],
    }, "A");
    const record = opened.records.get(`agent.source-view:${captured!.viewId}`)!;
    const oldPayload = JSON.parse(record.payloadJson) as Record<string, unknown>;
    delete oldPayload.owners;
    record.payloadJson = JSON.stringify(oldPayload);
    expect(await opened.reopen().read(captured!.viewId, "B", "draft.ts", "file-1"))
      .toMatchObject({ status: "ready", content: "old draft" });
    await expect(opened.reopen().prepareMutation(captured!.viewId, "child", "B", [{
      resourceId: "draft.ts", action: "write", content: "new draft",
    }])).rejects.toThrow("no captured owner");
  });

  it("clears a prepare left before Documents recorded an operation only after reopening", async () => {
    const opened = openStore();
    const captured = await opened.views.capture({
      status: "ready", resources: [{
        resource: { workspaceId: "B", resourceId: "draft.ts" }, coordinationId: "file-1",
        content: "before", revision: "r1", baseRevision: null, encoding: "utf-8", bom: false,
        localEditRevision: 1,
      }], supersededResources: [],
    }, "A", [], [{ workspaceId: "B", ownerId: "editor-B", generation: 1 }]);
    const viewId = captured!.viewId;
    const prepared = await opened.views.prepareMutation(viewId, "child", "B", [{
      resourceId: "draft.ts", action: "write", content: "after",
    }]);
    expect(prepared).not.toBeNull();
    const live: DirtyBufferPublication[] = [{ workspaceId: "B", ownerId: "editor-B", generation: 1,
      updatedAt: new Date().toISOString(), resources: [{
      resource: { workspaceId: "B", resourceId: "draft.ts" }, baseRevision: null, localEditRevision: 1,
      bufferHash: `sha256-${createHash("sha256").update("before").digest("hex")}`,
    }] }];
    expect(await opened.views.clearUnstartedMutation(viewId, prepared!.fixedView.operationId, live)).toBe(false);
    expect(await opened.views.read(viewId, "B", "draft.ts", "file-1")).toMatchObject({ status: "unavailable" });
    const restarted = opened.reopen();
    expect(await restarted.clearUnstartedMutation(viewId, prepared!.fixedView.operationId, [{
      ...live[0]!, resources: [{ ...live[0]!.resources[0]!, localEditRevision: 2 }],
    }])).toBe(false);
    expect(await restarted.clearUnstartedMutation(viewId, prepared!.fixedView.operationId, live)).toBe(true);
    expect(await restarted.read(viewId, "B", "draft.ts", "file-1"))
      .toMatchObject({ status: "ready", content: "before" });
  });

  it("maps cross-root aliases of the target branch instead of returning stale captured bytes", async () => {
    const opened = openStore();
    const captured = await opened.views.capture({
      status: "ready",
      resources: [{
        resource: { workspaceId: "A", resourceId: "project/draft.ts" },
        aliases: [{ workspaceId: "A", resourceId: "project/draft.ts" }],
        coordinationId: "same-physical-file",
        content: "old draft",
        revision: "draft-rev-1",
        baseRevision: null,
        encoding: "utf-8",
        bom: false,
        localEditRevision: 1,
      }, {
        resource: { workspaceId: "B", resourceId: "draft.ts" },
        aliases: [{ workspaceId: "B", resourceId: "draft.ts" }],
        coordinationId: "same-physical-file",
        content: "old draft",
        revision: "draft-rev-1",
        baseRevision: null,
        encoding: "utf-8",
        bom: false,
        localEditRevision: 1,
      }],
      supersededResources: [],
    }, "A");
    expect(captured?.context).toMatchObject({ roots: [{ workspaceId: "B", dirtyPaths: ["draft.ts"] }] });
    expect(await opened.views.targetAlias(captured!.viewId, "B", "draft.ts", "same-physical-file"))
      .toEqual({ workspaceId: "A", resourceId: "project/draft.ts" });
    expect(await opened.views.overlay(captured!.viewId, "B", "", async () => ({ status: "missing" })))
      .toEqual({ status: "ready", entries: [], removedPaths: ["draft.ts"] });
    await expect(opened.views.targetAlias(captured!.viewId, "B", "draft.ts", "replacement"))
      .rejects.toThrow("identity changed");
  });
});

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repositoryRoot, "kernel", "target", "release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const hasKernel = await fs.stat(kernelPath).then(() => true).catch(() => false);
if (!hasKernel && process.env.VARIN_REQUIRE_RELEASE_KERNEL === '1') {
  throw new Error('Source-view acceptance requires the selected release kernel');
}

it.skipIf(!hasKernel)("round-trips a source view through the native kernel record store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-source-view-"));
  const storageRoot = path.join(root, "storage");
  const sourceRoot = path.join(root, "source-views");
  await fs.mkdir(sourceRoot);
  const version = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;
  const client = createKernelClient({ hostId: "source-view-test", storageRoot, buildVersion: version, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({
    client, hostId: "source-view-test", storageRoot,
    resolveWorkspaceRoot: async (workspaceId) => {
      expect(workspaceId).toBe(SOURCE_VIEW_STORAGE_SCOPE);
      return sourceRoot;
    },
  });
  try {
    await client.start();
    const views = createSourceViewStore(createKernelWorkspaceWorkingStateAccess(adapter));
    const captured = await views.capture({
      status: "ready",
      resources: [{
        resource: { workspaceId: "external", resourceId: "draft.txt" },
        coordinationId: "stable-file-identity",
        content: "fixed unsaved text",
        revision: "draft:3",
        baseRevision: null,
        encoding: "utf-8",
        bom: false,
        localEditRevision: 3,
      }],
      supersededResources: [],
    }, "target", [], [{ workspaceId: "external", ownerId: "editor-owner", generation: 2 }]);
    expect(captured).not.toBeNull();
    expect(await views.read(captured!.viewId, "external", "draft.txt", "stable-file-identity"))
      .toMatchObject({ status: "ready", content: "fixed unsaved text" });
    const prepared = await views.prepareMutation(captured!.viewId, "child", "external", [{ resourceId: "draft.txt", action: "write", content: "child update" }]);
    expect(prepared?.fixedView.owner("external")).toEqual({ workspaceId: "external", ownerId: "editor-owner", generation: 2 });
    expect(prepared?.fixedView.inspect("draft.txt", "external")).toMatchObject({ status: "ready", content: "fixed unsaved text" });
    expect(await views.read(captured!.viewId, "external", "draft.txt", "stable-file-identity"))
      .toMatchObject({ status: "unavailable" });
    await views.finishMutation(captured!.viewId, prepared!.fixedView.operationId, {
      status: "applied", results: [{ path: "draft.txt", target: "surface", status: "applied", revision: "surface-draft:source-view:test:4" }],
    });
    expect(await views.read(captured!.viewId, "external", "draft.txt", "stable-file-identity"))
      .toMatchObject({ status: "ready", content: "child update" });
    const orphan = await views.capture({
      status: "ready", resources: [{
        resource: { workspaceId: "external", resourceId: "orphan.txt" },
        coordinationId: "orphan-file", content: "orphan", revision: "draft:1", baseRevision: null,
        encoding: "utf-8", bom: false, localEditRevision: 1,
      }], supersededResources: [],
    }, "target");
    await views.reconcile(new Set([captured!.viewId]));
    expect(await views.contextFor(orphan!.viewId)).toBeNull();
    expect(await views.contextFor(captured!.viewId)).not.toBeNull();
    await views.release(captured!.viewId);
    expect(await views.contextFor(captured!.viewId)).toBeNull();
  } finally {
    await adapter.dispose();
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!hasKernel)("applies a child edit to B's live editor, advances the fixed view, and conflicts on a later user edit", async () => {
  const harness = await createDocumentAuthorityHarness();
  const kernelRoot = await fs.mkdtemp(path.join(os.tmpdir(), "varin-external-editor-view-"));
  const storageRoot = path.join(kernelRoot, "storage");
  const sourceRoot = path.join(kernelRoot, "source-views");
  await fs.mkdir(sourceRoot);
  const version = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;
  const client = createKernelClient({ hostId: "external-editor-test", storageRoot, buildVersion: version, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: "external-editor-test", storageRoot,
    resolveWorkspaceRoot: async () => sourceRoot });
  const live = new Map<string, LiveSurfaceBuffer>();
  const surface = attachLiveSurfaceCompleter(harness.authority, {
    generation: 1, live, ownerId: "editor-B", workspaceId: harness.identity.workspaceId,
  });
  try {
    await client.start();
    const views = createSourceViewStore(createKernelWorkspaceWorkingStateAccess(adapter));
    const durableRecoveryStore = createInMemoryRecoveryDurablePort();
    const inspected = await harness.authority.inspectWorkspace(harness.identity.workspaceId);
    harness.authority.bindDurableMutationStorage(async (_workspaceId, operation) => operation({
      durableRecoveryStore,
      fileStore: createRecoveryFileStore(),
      identity: { authorityId: harness.authority.hostId, canonicalRoot: inspected.root, filesystemProfile: "test", workspaceId: harness.identity.workspaceId },
      resourceOperationGate: { run: (_resources, callback) => callback() },
      root: path.join(harness.dataDir, "external-editor-recovery"),
    }));
    await fs.writeFile(path.join(harness.workspaceRoot, "draft.ts"), "disk A\n");
    const disk = await harness.authority.read(harness.resource("draft.ts"));
    if (disk.status !== "ready") throw new Error("Expected the B disk fixture");
    const binding = {
      baseRevision: disk.revision, localEditRevision: 2, documentInstanceId: "B-document-instance",
      bufferHash: hashSurfaceText("draft B\n"), encoding: "utf-8" as const, bom: false,
      lineEnding: "lf" as const, resource: harness.resource("draft.ts"),
    };
    live.set("draft.ts", { ...binding, content: "draft B\n" });
    await harness.authority.publishDirtyBuffers({ generation: 1, ownerId: "editor-B", resources: [binding], workspaceId: harness.identity.workspaceId });
    const parentContext = await harness.authority.captureAgentInputSnapshot({
      generation: 1, ownerId: "editor-B", sessionId: "parent-session", resources: [{ ...binding, content: "draft B\n" }],
    });
    const cloned = harness.authority.cloneAgentInputSnapshot("parent-session", parentContext);
    if (cloned.status !== "ready") throw new Error("Expected captured editor input");
    const fixed = await views.capture(cloned, "child-target-root", [], [{ workspaceId: harness.identity.workspaceId, ownerId: "editor-B", generation: 1 }]);
    if (!fixed) throw new Error("Expected external fixed source view");
    type RuntimeOptions = Parameters<typeof createSourceViewRuntime>[0];
    const runtime = createSourceViewRuntime({
      documents: harness.authority,
      registry: {
        getSessionBinding: async () => ({ owningScopeId: "child-target-root", threadId: "child" }),
        getThreadById: async () => ({ id: "child", manifest: { sourceViewId: fixed.viewId } }),
      } as unknown as RuntimeOptions["registry"],
      views: { get: () => undefined } as unknown as RuntimeOptions["views"],
      branchLookups: { readSource: async () => null, pathOverlay: async () => null } as unknown as RuntimeOptions["branchLookups"],
      branchWrites: { branchWrite: async () => ({ status: "disk" }) },
      worktrees: { assertOwnership: async () => undefined },
      sourceViews: views,
    });
    expect(await runtime.branchWrite("child-session", [{ workspaceId: harness.identity.workspaceId,
      resourceId: "draft.ts", action: "edit", edits: [{ oldText: "draft B", newText: "child C" }] }]))
      .toEqual({ status: "disk" });
    const change = { resourceId: "draft.ts", action: "edit" as const, edits: [{ oldText: "draft B", newText: "child C" }] };
    const first = await runtime.surfaceWrite("child-session", harness.identity.workspaceId, fixed.context, [change]);
    expect(first).toMatchObject({ status: "applied", results: [{ target: "surface", status: "applied" }] });
    const physical = cloned.resources[0]?.coordinationId ?? null;
    expect(await views.read(fixed.viewId, harness.identity.workspaceId, "draft.ts", physical))
      .toMatchObject({ status: "ready", content: "child C\n" });
    expect(live.get("draft.ts")?.content).toBe("child C\n");
    expect(await fs.readFile(path.join(harness.workspaceRoot, "draft.ts"), "utf8")).toBe("disk A\n");

    // Simulate a Host loss after Documents persisted the successful editor
    // operation but before it advanced the child's private source view.
    const recoveredChange = { resourceId: "draft.ts", action: "edit" as const,
      edits: [{ oldText: "child C", newText: "resumed R" }] };
    const pending = await views.prepareMutation(fixed.viewId, "child-session", harness.identity.workspaceId, [recoveredChange]);
    if (!pending) throw new Error("Expected durable pending source mutation");
    const durableResult = await harness.authority.applyAgentSurfaceWrite(
      "child-session", harness.identity.workspaceId, fixed.context, [recoveredChange], undefined, pending.fixedView,
    );
    expect(durableResult).toMatchObject({ status: "applied" });
    expect(await views.read(fixed.viewId, harness.identity.workspaceId, "draft.ts", physical))
      .toMatchObject({ status: "unavailable" });
    expect(await runtime.readSource("child-session", fixed.context, "draft.ts", harness.identity.workspaceId))
      .toMatchObject({ status: "ready", content: "resumed R\n" });
    expect(live.get("draft.ts")?.content).toBe("resumed R\n");
    expect(await fs.readFile(path.join(harness.workspaceRoot, "draft.ts"), "utf8")).toBe("disk A\n");

    live.set("draft.ts", { ...binding, content: "user D\n", localEditRevision: 9, bufferHash: hashSurfaceText("user D\n") });
    await harness.authority.publishDirtyBuffers({ generation: 1, ownerId: "editor-B", workspaceId: harness.identity.workspaceId,
      resources: [{ ...binding, localEditRevision: 9, bufferHash: hashSurfaceText("user D\n") }] });
    const secondChange = { resourceId: "draft.ts", action: "edit" as const, edits: [{ oldText: "resumed R", newText: "child E" }] };
    const conflict = await runtime.surfaceWrite("child-session", harness.identity.workspaceId, fixed.context, [secondChange]);
    expect(conflict).toMatchObject({ status: "conflict" });
    expect(live.get("draft.ts")?.content).toBe("user D\n");
    expect(await views.read(fixed.viewId, harness.identity.workspaceId, "draft.ts", physical))
      .toMatchObject({ status: "ready", content: "resumed R\n" });
  } finally {
    surface.close();
    await adapter.dispose();
    await client.close();
    await harness.cleanup();
    await fs.rm(kernelRoot, { recursive: true, force: true });
  }
});
