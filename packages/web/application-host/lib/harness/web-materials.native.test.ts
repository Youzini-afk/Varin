import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createKernelClient } from "../kernel/kernel-client.js";
import { KernelStorageAdapter } from "../kernel/storage-adapter.js";
import { createMaterialCollections } from "./material-collections.js";
import { createWebMaterialStore } from "./web-materials.js";
import { createMaterialStorageAccess, threadMaterialScope } from "../kernel/material-storage.js";
import type { MaterialCollectionContext } from "./material-collections.js";
import { createWebFetch } from "./web-fetch.js";
import { createDocumentReader } from "./document-reading.js";
import { makePdf } from "./pdf-test-fixture.js";

it("persists web material, collection membership and related-thread access through the kernel", async () => {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-web-materials-"));
  const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, "package.json"), "utf8")) as { version: string }).version;
  const kernelPath = process.env.VARIN_TEST_KERNEL_PATH
    ?? path.join(repository, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
  const client = createKernelClient({ hostId: "materials", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
  const adapter = new KernelStorageAdapter({ client, hostId: "materials", storageRoot: root, resolveWorkspaceRoot: async () => root });
  const scopeId = threadMaterialScope("parent");
  const access = createMaterialStorageAccess({ kernel: client, storage: adapter });
  const materials = createWebMaterialStore(access);
  const collections = createMaterialCollections(access, { materials });
  const authority = (threadId: string) => ({ kind: "thread" as const, owningWorkspaceId: scopeId, threadId });
  const context = (threadId: string): MaterialCollectionContext => ({
    authority: authority(threadId), signal: new AbortController().signal,
    threadsRelated: async (from, to) => from === "parent" && to === "child",
  });
  const execute = async (params: Parameters<typeof collections.execute>[0], ctx: MaterialCollectionContext) =>
    (await collections.execute(params, ctx)).result;
  try {
    await client.start();
    const chatAuthority = authority("chat");
    const chatSnapshot = await materials.put(scopeId, {
      sourceUrl: "https://example.com/guide", finalUrl: "https://example.com/guide",
      representation: "markdown",
    }, Buffer.from("Ordinary Thread material."), chatAuthority);
    expect((await materials.read(scopeId, chatSnapshot.snapshotId, chatAuthority))?.body.toString())
      .toBe("Ordinary Thread material.");
    expect(await materials.read(scopeId, chatSnapshot.snapshotId, { ...chatAuthority, threadId: "other" })).toBeNull();
    const fetcher = createWebFetch({ materials, ssrf: { check: async () => ({ blocked: false }), isSameHost: () => true } });
    vi.stubGlobal("fetch", async () => new Response(`<html><body><article><h1>Guide</h1><p>${"Durable snapshot content. ".repeat(30)}</p></article></body></html>`, {
      headers: { "content-type": "text/html" },
    }));
    const chatContext = { workspaceId: scopeId, authority: chatAuthority };
    const fetched = await fetcher.fetch({ url: "https://example.com/guide", refresh: true }, chatContext);
    if (fetched.status !== "ok" || !fetched.snapshot) throw new Error(`HTML fetch failed: ${JSON.stringify(fetched)}`);
    const reread = await fetcher.fetch({ snapshotId: fetched.snapshot.snapshotId }, chatContext);
    expect(reread.status === "ok" && reread.markdown).toBe(fetched.markdown);
    vi.unstubAllGlobals();

    const reader = createDocumentReader({ materials });
    const opened = await reader.ingest({ source: makePdf(), sourceUrl: "file:///sample.pdf" }, chatContext);
    expect(opened).toMatchObject({ status: "ok", overview: { pageCount: 1 } });
    if (opened.status !== "ok" || !opened.snapshot) throw new Error("PDF source unavailable");
    const text = await reader.read({ snapshotId: opened.snapshot.snapshotId, view: "text", find: "RIGHT" }, chatContext);
    expect(text).toMatchObject({ status: "ok", markdown: expect.stringContaining("RIGHT"), findHits: [expect.objectContaining({ page: 1 })] });
    const preview = await reader.read({ snapshotId: opened.snapshot.snapshotId, view: "page-image", page: 1 }, chatContext);
    expect(preview).toMatchObject({ status: "ok", pageImage: { mimeType: "image/png" } });
    const brokenRead = vi.spyOn(materials, "read").mockRejectedValueOnce(new Error("kernel connection failed"));
    await expect(fetcher.fetch({ snapshotId: chatSnapshot.snapshotId }, chatContext)).rejects.toThrow("kernel connection failed");
    brokenRead.mockRestore();
    const source = Buffer.from("%PDF-fixed-source");
    const ref = await materials.put(scopeId, {
      sourceUrl: "https://example.com/paper.pdf", finalUrl: "https://example.com/paper.pdf",
      contentType: "application/pdf", representation: "pdf-text", document: { kind: "pdf", parser: "native" },
    }, Buffer.from("A durable finding."), authority("parent"), {
      source: { bytes: source, contentType: "application/pdf" },
    });
    expect((await materials.read(scopeId, ref.snapshotId, authority("parent"), { includeSource: true }))?.source?.bytes).toEqual(source);
    expect(await materials.read(scopeId, ref.snapshotId, authority("child"))).toBeNull();
    const created = await execute({ action: "create", name: "Evidence" }, context("parent"));
    expect(created.status).toBe("ok");
    const collectionId = created.collection!.collectionId;
    expect((await execute({ action: "add", collectionId, member: { kind: "snapshot", snapshotId: ref.snapshotId } }, context("parent"))).status).toBe("ok");
    expect((await execute({ action: "share", collectionId, targetThreadId: "child" }, context("parent"))).status).toBe("ok");
    expect((await materials.read(scopeId, ref.snapshotId, authority("child")))?.body.toString()).toBe("A durable finding.");
    expect((await materials.read(scopeId, ref.snapshotId, {
      kind: "thread", owningWorkspaceId: scopeId, threadId: "child",
    }, { byteRange: { offset: 2, length: 7 }, expectedContentHash: ref.contentHash }))?.body.toString()).toBe("durable");
    expect(await materials.read(scopeId, ref.snapshotId, authority("unrelated"))).toBeNull();

    // Restart the native storage owner, then reread through fresh Host facades.
    await adapter.dispose();
    await client.close();
    const reopenedClient = createKernelClient({ hostId: "materials", storageRoot: root, buildVersion, kernelPath, allowCargoDevRunner: false });
    const reopenedAdapter = new KernelStorageAdapter({ client: reopenedClient, hostId: "materials", storageRoot: root, resolveWorkspaceRoot: async () => root });
    try {
      await reopenedClient.start();
      const reopened = createWebMaterialStore(createMaterialStorageAccess({ kernel: reopenedClient, storage: reopenedAdapter }));
      const found = await reopened.read(scopeId, ref.snapshotId, authority("child"), { includeSource: true });
      expect(found?.body.toString()).toBe("A durable finding.");
      expect(found?.source?.bytes).toEqual(source);
    } finally { await reopenedAdapter.dispose(); await reopenedClient.close(); }
  } finally {
    vi.unstubAllGlobals();
    await adapter.dispose();
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
