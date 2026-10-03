import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createKernelClient } from "./kernel-client.js";
import { KERNEL_REQUEST_WINDOW } from "./protocol.generated.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? path.join(repository, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const buildVersion = (JSON.parse(await fs.readFile(path.join(repository, "package.json"), "utf8")) as { version: string }).version;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  await fs.access(kernelPath); // Release acceptance must never silently skip.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-r6-transport-"));
  let child!: ChildProcessWithoutNullStreams;
  const outstanding = new Set<string>();
  const requests: Array<{ kind: string; id: string; method?: string }> = [];
  let maximum = 0;
  let responseBuffer = Buffer.alloc(0);
  const options = { hostId: "r6-transport", storageRoot: root, kernelPath, buildVersion, allowCargoDevRunner: false };
  const host = createKernelClient({ ...options, spawnProcess: ((command, args, input) => {
    child = spawn(command, args ?? [], input ?? {}) as ChildProcessWithoutNullStreams;
    const originalWrite = child.stdin.write;
    child.stdin.write = ((...values: unknown[]) => {
      const bytes = values[0];
      if (Buffer.isBuffer(bytes) && bytes.length >= 4 && bytes.readUInt32BE(0) === bytes.length - 4) {
        const envelope = JSON.parse(bytes.subarray(4).toString("utf8")) as { kind: string; id: string; method?: string };
        requests.push({ kind: envelope.kind, id: envelope.id, ...(envelope.method ? { method: envelope.method } : {}) });
        if (envelope.kind === "request") outstanding.add(envelope.id);
        maximum = Math.max(maximum, outstanding.size);
      }
      return Reflect.apply(originalWrite, child.stdin, values);
    }) as typeof child.stdin.write;
    child.stdout.on("data", (bytes: Buffer) => {
      responseBuffer = Buffer.concat([responseBuffer, bytes]);
      while (responseBuffer.length >= 4 && responseBuffer.length >= 4 + responseBuffer.readUInt32BE(0)) {
        const end = 4 + responseBuffer.readUInt32BE(0);
        const response = JSON.parse(responseBuffer.subarray(4, end).toString("utf8")) as { id: string };
        outstanding.delete(response.id);
        responseBuffer = responseBuffer.subarray(end);
      }
    });
    return child;
  }) as typeof spawn });
  cleanups.push(async () => { await host.close(); await fs.rm(root, { recursive: true, force: true }); });
  await host.start();
  const grant = await host.issueGrant({ grantId: "actor", owningWorkspace: "ws", executionWorkspace: "ws", capabilities: ["storage.read", "storage.write", "storage.gc"], pathScopes: [""] });
  const actor = host.scoped(grant);
  return { host, actor, child, root, options, requests, outstanding, maximum: () => maximum };
}

it("R0/R6 saturation retains a bounded native window through parallel uploads, cancellation and reuse", async () => {
  const f = await fixture();
  const bodies = Array.from({ length: 24 }, (_, index) => Buffer.alloc(160_000 + index, index));
  const uploaded = await Promise.all(bodies.map((body, index) => f.actor.putBlob(body, `parallel-${index}`)));
  expect(f.maximum()).toBe(KERNEL_REQUEST_WINDOW);
  expect(f.requests.some(request => request.kind === "data")).toBe(false);
  expect(f.requests.filter(request => request.method === "storage.putBlob.chunk").length).toBeGreaterThan(bodies.length);
  for (let index = 0; index < uploaded.length; index++) {
    const object = uploaded[index]!;
    const parts: Buffer[] = [];
    for (let offset = 0; offset < object.byteLength; offset += 65536) {
      const read = await f.actor.getBlob(object.hash, { ownerId: object.ownerId }, { offset, length: 65536 });
      parts.push(Buffer.from(read.bytesBase64, "base64"));
    }
    expect(Buffer.concat(parts)).toEqual(bodies[index]);
  }
  const controller = new AbortController();
  const object = uploaded[0]!;
  const long = f.actor.createBranch({ operationId: "cancel-large", branchId: "cancel-large", workspaceId: "ws", draftBasePaths: [], captureScopes: [],
    entries: Array.from({ length: 20_000 }, (_, index) => ({ path: `wide/${index}.txt`, state: { kind: "regular-file" as const, objectHash: object.hash, byteLength: object.byteLength, mode: 0o644 } })),
  }, controller.signal);
  const rejected = expect(long).rejects.toThrow(/cancelled/i);
  await expect.poll(() => f.requests.some(request => request.method === "branch.create.append")).toBe(true);
  const controls = Array.from({ length: 80 }, () => f.actor.health());
  controller.abort();
  await rejected;
  await Promise.all(controls);
  expect(f.requests.some(request => request.kind === "cancel")).toBe(true);
  expect(f.maximum()).toBe(KERNEL_REQUEST_WINDOW);
  expect(f.outstanding.size).toBe(0);
  await expect(f.actor.readBranch({ branchId: "cancel-large" })).rejects.toThrow(/branch not found/i);
  expect((await f.actor.health()).integrity).toBe("ok");
}, 30_000);

it("R0/R6 truncated input drains the old epoch, rejects pending work and permits a clean restart", async () => {
  const f = await fixture();
  await f.actor.createBranch({ operationId: "base", branchId: "base", workspaceId: "ws", draftBasePaths: [], captureScopes: [], entries: [] });
  const before = await f.actor.readBranch({ branchId: "base", includeEntries: false });
  // A partial control frame cannot bypass orderly Storage/reader/process drain.
  const exited = once(f.child, "exit");
  f.child.stdin.end(Buffer.from([0, 0, 0, 100, 123]));
  await exited;
  await f.host.close();
  const restarted = createKernelClient(f.options);
  try {
    await restarted.start();
    const actor = restarted.scoped(await restarted.issueGrant({ grantId: "after-disconnect", owningWorkspace: "ws", executionWorkspace: "ws", pathScopes: [""], capabilities: ["storage.read", "storage.write"] }));
    assert.equal((await actor.readBranch({ branchId: "base", includeEntries: false })).root, before.root);
    assert.equal((await actor.health()).integrity, "ok");
  } finally { await restarted.close(); }
}, 30_000);
