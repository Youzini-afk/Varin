import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createKernelClient } from "../kernel/kernel-client.js";
import { KernelStorageAdapter, createKernelWorkspaceWorkingStateAccess } from "../kernel/storage-adapter.js";
import { createMaterialCollections } from "./material-collections.js";
import { createWebMaterialStore } from "./web-materials.js";
import type { HarnessServiceContext } from "./router.js";

it("persists web material, collection membership and related-thread access through the kernel", async () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-web-materials-"));
  const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, "package.json"), "utf8")) as { version: string }).version;
  const kernelPath = process.env.VARIN_TEST_KERNEL_PATH
    ?? path.join(repository, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
  const client = createKernelClient({ hostId: "materials", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: "materials", storageRoot: root, resolveWorkspaceRoot: async () => root });
  const access = createKernelWorkspaceWorkingStateAccess(adapter);
  const materials = createWebMaterialStore(access);
  const collections = createMaterialCollections(access, {
    materials,
    resolveThreadId: async (sessionId) => sessionId,
    threadsRelated: async (from, to) => from === "parent" && to === "child",
  });
  const authority = (sessionId: string) => ({ owningWorkspaceId: "workspace", sessionId, threadId: sessionId });
  const context = (sessionId: string): HarnessServiceContext => ({
    actor: { authorityInstanceId: "materials", workerId: "worker", workerGeneration: 1, sessionId, workspaceId: "workspace", grantedCapabilities: ["read.web"] },
    authorizedPaths: [], sessionId, workspaceId: "workspace", signal: new AbortController().signal,
  });
  try {
    await client.start();
    const source = Buffer.from("%PDF-fixed-source");
    const ref = await materials.put("workspace", {
      sourceUrl: "https://example.com/paper.pdf", finalUrl: "https://example.com/paper.pdf",
      contentType: "application/pdf", representation: "pdf-text", document: { kind: "pdf", parser: "native" },
    }, Buffer.from("A durable finding."), authority("parent"), {
      source: { bytes: source, contentType: "application/pdf" },
    });
    expect((await materials.read("workspace", ref.snapshotId, authority("parent"), { includeSource: true }))?.source?.bytes).toEqual(source);
    expect(await materials.read("workspace", ref.snapshotId, authority("child"))).toBeNull();
    const created = await collections.handle({ action: "create", name: "Evidence" }, context("parent"));
    expect(created.status).toBe("ok");
    const collectionId = created.collection!.collectionId;
    expect((await collections.handle({ action: "add", collectionId, member: { kind: "snapshot", snapshotId: ref.snapshotId } }, context("parent"))).status).toBe("ok");
    expect((await collections.handle({ action: "share", collectionId, targetThreadId: "child" }, context("parent"))).status).toBe("ok");
    expect((await materials.read("workspace", ref.snapshotId, authority("child")))?.body.toString()).toBe("A durable finding.");
    expect(await materials.read("workspace", ref.snapshotId, authority("unrelated"))).toBeNull();

    // Restart the native storage owner, then reread through fresh Host facades.
    await adapter.dispose();
    await client.close();
    const reopenedClient = createKernelClient({ hostId: "materials", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
    const reopenedAdapter = new KernelStorageAdapter({ client: reopenedClient, hostId: "materials", storageRoot: root, resolveWorkspaceRoot: async () => root });
    try {
      await reopenedClient.start();
      const reopened = createWebMaterialStore(createKernelWorkspaceWorkingStateAccess(reopenedAdapter));
      const found = await reopened.read("workspace", ref.snapshotId, authority("child"), { includeSource: true });
      expect(found?.body.toString()).toBe("A durable finding.");
      expect(found?.source?.bytes).toEqual(source);
    } finally { await reopenedAdapter.dispose(); await reopenedClient.close(); }
  } finally {
    await adapter.dispose();
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
