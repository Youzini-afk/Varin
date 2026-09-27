import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkingStateRootContext, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./working-state/types.js";
import { createSourceViewStore, SOURCE_VIEW_STORAGE_SCOPE } from "./source-view-store.js";
import { createKernelClient } from "../kernel/kernel-client.js";
import { createKernelWorkspaceWorkingStateAccess, KernelStorageAdapter } from "../kernel/storage-adapter.js";

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
  return { views: createSourceViewStore(workingStates), reopen: () => createSourceViewStore(workingStates), scopes };
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
    }, "target");
    expect(captured).not.toBeNull();
    expect(await views.read(captured!.viewId, "external", "draft.txt", "stable-file-identity"))
      .toMatchObject({ status: "ready", content: "fixed unsaved text" });
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
