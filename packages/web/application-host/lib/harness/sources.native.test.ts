import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createKernelClient } from "../kernel/kernel-client.js";
import { createSourceService } from "./sources.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH
  ?? path.join(repositoryRoot, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;
const available = await fs.stat(kernelPath).then(() => true).catch(() => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === "1") throw new Error("Research source test requires the release kernel");

it.skipIf(!available)("retains source content after its original branch is released and keeps other research roots out", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-source-"));
  const client = createKernelClient({ hostId: "source-test", storageRoot: root, kernelPath, buildVersion, allowCargoDevRunner: false });
  try {
    await client.start();
    const grant = await client.issueGrant({ grantId: "source-fixture", owningWorkspace: "ws", executionWorkspace: "ws", pathScopes: [""], capabilities: ["storage.read", "storage.write", "storage.maintenance", "storage.admin"] });
    const scoped = client.scoped(grant);
    const bytes = Buffer.from("the retained dataset");
    const blob = await scoped.putBlob(bytes, "source-dataset");
    await scoped.createBranch({ operationId: "source-branch", branchId: "input", workspaceId: "ws", entries: [
      { path: "dataset.txt", state: { kind: "regular-file", objectHash: blob.hash, byteLength: bytes.length, mode: 0o644 }, ownerId: blob.ownerId },
    ], draftBasePaths: [], captureScopes: [] });
    const sources = createSourceService({ client });
    const source = await sources.register("ws", { kind: "dataset", objectHash: blob.hash }, { sessionId: "session-a", threadId: "thread-a" });
    await scoped.deleteBranch({ operationId: "delete-source-branch", branchId: "input" });
    await scoped.gc("source-gc");
    const body = await scoped.getBlob(blob.hash, { recordId: `research.source:${source.sourceId}`, slot: "content" });
    expect(Buffer.from(body.bytesBase64, "base64")).toEqual(bytes);
    const other = { workspaceId: "ws", executionWorkspaceId: "ws", sessionId: "session-b", rootSessionId: "session-b", allowedThreadIds: ["thread-b"] };
    expect((await sources.list("ws", {}, other)).sources).toEqual([]);
    await expect(sources.get("ws", source.sourceId, other)).rejects.toThrow(/outside/);
    await expect(sources.register("ws", { kind: "dataset", path: "src/../private.txt" }, {})).rejects.toThrow(/relative/);
    const dotted = await sources.register("ws", { kind: "dataset", path: "src/foo..bar" }, { workspaceScope: ["src"] });
    expect(dotted.path).toBe("src/foo..bar");
  } finally {
    await client.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});
