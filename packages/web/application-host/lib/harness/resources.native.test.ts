import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it as vitestIt } from "vitest";
import { createKernelClient, type KernelClient } from "../kernel/kernel-client.js";
import { createResourceService, type LocalMachineProbe } from "./resources.js";
import type { GpuProbeResult } from "./gpu-resources.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH
  ?? path.join(repositoryRoot, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;
const available = await fs.stat(kernelPath).then(() => true).catch(() => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === "1") {
  throw new Error("Resource acceptance requires the release kernel");
}
const it = vitestIt.skipIf(!available);

const clients: KernelClient[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

const probe = (overrides: Partial<LocalMachineProbe> = {}): LocalMachineProbe => ({
  cpuCores: 1,
  memoryMb: 1_024,
  usedMemoryMb: 128,
  ...overrides,
});

async function fixture(
  machineProbe: () => LocalMachineProbe = () => probe(),
  onCapacityAvailable?: (workspaceId: string) => void | Promise<void>,
  gpuProbe?: () => Promise<GpuProbeResult>,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-resource-"));
  roots.push(root);
  const storageRoot = path.join(root, "storage");
  const client = createKernelClient({
    hostId: `resource-test-${randomUUID()}`,
    storageRoot,
    kernelPath,
    buildVersion,
    allowCargoDevRunner: false,
  });
  clients.push(client);
  await client.start();
  return {
    root,
    storageRoot,
    client,
    machineProbe,
    resources: createResourceService({
      client,
      probeLocal: machineProbe,
      ...(gpuProbe === undefined ? {} : { probeLocalGpu: gpuProbe }),
      ...(onCapacityAvailable === undefined ? {} : { onCapacityAvailable }),
    }),
  };
}

describe("resource facts on the real kernel", () => {
  it("shares one machine reservation across workspaces and projects only shared commitment facts", async () => {
    const f = await fixture();
    const [workspaceA, workspaceB] = await Promise.all([
      f.resources.admit("workspace-a", "local", { cpuCores: 1 }, "attempt-a"),
      f.resources.admit("workspace-b", "local", { cpuCores: 1 }, "attempt-b"),
    ]);
    const first = workspaceA.status === "confirmed" ? workspaceA : workspaceB;
    const blocked = workspaceA.status === "confirmed" ? workspaceB : workspaceA;
    const ownerWorkspace = workspaceA.status === "confirmed" ? "workspace-a" : "workspace-b";
    const ownerAttempt = workspaceA.status === "confirmed" ? "attempt-a" : "attempt-b";
    const otherWorkspace = ownerWorkspace === "workspace-a" ? "workspace-b" : "workspace-a";
    assert.equal(first.status, "confirmed");
    assert.ok(first.commitmentId);
    assert.equal(first.remaining?.cpuCores, 0);

    assert.equal(blocked.status, "insufficient");
    assert.match(blocked.reason ?? "", /insufficient cpuCores/);

    const otherView = await f.resources.getMachine(otherWorkspace, "local");
    assert.ok(otherView);
    assert.equal(otherView.commitments.length, 1);
    assert.equal(otherView.commitments[0]?.attemptId, undefined);
    assert.equal(otherView.commitments[0]?.resources.cpuCores, 1);

    await f.resources.release(otherWorkspace, first.commitmentId, "unauthorized");
    const stillReserved = await f.resources.getMachine(ownerWorkspace, "local");
    assert.equal(stillReserved?.commitments.length, 1);

    const retry = await f.resources.admit(ownerWorkspace, "local", { cpuCores: 1 }, ownerAttempt);
    assert.deepEqual(retry, first);
  });

  it("makes release idempotent and keeps the durable reservation after service reconstruction", async () => {
    const capacityEvents: string[] = [];
    const f = await fixture(() => probe(), (workspaceId) => { capacityEvents.push(workspaceId); });
    const first = await f.resources.admit("workspace-a", "local", { cpuCores: 1 }, "attempt-a");
    assert.equal(first.status, "confirmed");
    if (!first.commitmentId) throw new Error("expected a commitment");

    const rebuilt = createResourceService({ client: f.client, probeLocal: f.machineProbe });
    const blocked = await rebuilt.admit("workspace-b", "local", { cpuCores: 1 }, "attempt-b");
    assert.equal(blocked.status, "insufficient");
    const same = await rebuilt.admit("workspace-a", "local", { cpuCores: 1 }, "attempt-a");
    assert.equal(same.commitmentId, first.commitmentId);
    await f.resources.getMachine("workspace-b", "local");

    await f.resources.release("workspace-a", first.commitmentId, "done");
    await f.resources.release("workspace-a", first.commitmentId, "retry release");
    assert.deepEqual(new Set(capacityEvents), new Set(["workspace-a", "workspace-b"]));
    const availableAgain = await rebuilt.admit("workspace-b", "local", { cpuCores: 1 }, "attempt-b");
    assert.equal(availableAgain.status, "confirmed");
  });

  it("does not invent GPU memory or CPU usage when probes lack those facts", async () => {
    const f = await fixture(() => probe());
    await f.resources.registerMachine("workspace-a", {
      machineId: "gpu-1",
      kind: "cluster",
      state: "available",
      connection: { status: "connected" },
      capacity: { gpus: [{ index: 0 }] },
    });
    await assert.rejects(
      () => f.resources.registerMachine("workspace-b", { machineId: "gpu-1", kind: "ssh" }),
      /different machine/,
    );
    const resourceGrant = await f.client.issueGrant({
      grantId: `resource-sample-test:${randomUUID()}`,
      owningWorkspace: "__varin_host_resources__",
      executionWorkspace: "__varin_host_resources__",
      capabilities: ["storage.read", "storage.write", "storage.maintenance"],
      pathScopes: [""],
    });
    await f.client.scoped(resourceGrant).putRecord({
      operationId: `resource-sample:${randomUUID()}`,
      recordId: "resource.sample:gpu-1",
      workspaceId: "__varin_host_resources__",
      recordType: "resource.sample",
      state: "observed",
      payloadJson: JSON.stringify({
        machineId: "gpu-1",
        observedAt: 10,
        source: "nvidia-smi",
        usage: { gpus: [{ index: 0, utilizationPercent: 42, usedMemoryMb: 256 }] },
      }),
      ownerIds: [],
      references: [],
    });
    const gpu = await f.resources.getMachine("workspace-b", "gpu-1");
    assert.ok(gpu);
    assert.deepEqual(gpu.capacity?.gpus, [{ index: 0 }]);
    assert.deepEqual(gpu.usage?.gpus, [{ index: 0, utilizationPercent: 42, usedMemoryMb: 256 }]);
    const denied = await f.resources.admit("workspace-b", "gpu-1", { gpuMemoryMb: 1 }, "attempt-gpu");
    assert.equal(denied.status, "insufficient");
    assert.match(denied.reason ?? "", /no gpuMemoryMb capacity/);

    await f.resources.listMachines("workspace-b");
    const local = await f.resources.getMachine("workspace-b", "local");
    assert.ok(local?.usage);
    assert.equal(local.usage.cpuPercent, undefined);
  });

  it("rejects invalid resource requests and treats an empty request as no reservation", async () => {
    const f = await fixture();
    await assert.rejects(
      () => f.resources.admit("workspace-a", "local", { cpuCores: Number.NaN }, "attempt-nan"),
      /must be finite/,
    );
    await assert.rejects(
      () => f.resources.admit("workspace-a", "local", { cpuCores: -1 }, "attempt-negative"),
      /cannot be negative/,
    );
    const empty = await f.resources.admit("workspace-a", "local", {}, "attempt-empty");
    assert.deepEqual(empty, { status: "confirmed" });
    const machine = await f.resources.getMachine("workspace-a", "local");
    assert.equal(machine?.commitments.length, 0);
  });

  it("allocates distinct real GPU UUIDs across concurrent workspaces", async () => {
    const f = await fixture(
      () => probe(),
      undefined,
      async () => ({ status: "available", devices: [
        { index: 0, uuid: "GPU-test-a", name: "Test A", memoryMb: 8_192, usedMemoryMb: 100, utilizationPercent: 2 },
        { index: 1, uuid: "GPU-test-b", name: "Test B", memoryMb: 8_192, usedMemoryMb: 200, utilizationPercent: 3 },
      ] }),
    );
    const first = await f.resources.admit("workspace-a", "local", { gpuCount: 1 }, "attempt-a");
    const second = await f.resources.admit("workspace-b", "local", { gpuCount: 1 }, "attempt-b");
    assert.equal(first.status, "confirmed");
    assert.equal(second.status, "confirmed");
    assert.equal(first.gpuAllocation?.devices[0]?.uuid, "GPU-test-a");
    assert.equal(second.gpuAllocation?.devices[0]?.uuid, "GPU-test-b");
    assert.equal(first.gpuAllocation?.environment.value, "GPU-test-a");
    assert.equal(second.gpuAllocation?.environment.value, "GPU-test-b");
    const sharedView = await f.resources.getMachine("workspace-c", "local");
    assert.equal(sharedView?.commitments.find((entry) => entry.resources.gpuCount === 1)?.gpuAllocation?.devices[0]?.uuid, "GPU-test-a");
    if (second.status !== "confirmed" || !second.commitmentId) throw new Error("expected second commitment");
    const rebuilt = createResourceService({
      client: f.client,
      probeLocal: f.machineProbe,
      probeLocalGpu: async () => ({ status: "available", devices: [
        { index: 0, uuid: "GPU-test-a", name: "Test A", memoryMb: 8_192 },
        { index: 1, uuid: "GPU-test-b", name: "Test B", memoryMb: 8_192 },
      ] }),
    });
    assert.equal((await rebuilt.getCommitmentAllocation("workspace-b", second.commitmentId))?.environment.value, "GPU-test-b");
    const blocked = await f.resources.admit("workspace-c", "local", { gpuCount: 1 }, "attempt-c");
    assert.equal(blocked.status, "insufficient");
    if (first.status !== "confirmed" || !first.commitmentId) throw new Error("expected first commitment");
    await f.resources.release("workspace-a", first.commitmentId, "done");
    const afterRelease = await f.resources.admit("workspace-c", "local", { gpuCount: 1 }, "attempt-c");
    assert.equal(afterRelease.status, "confirmed");
    assert.equal(afterRelease.gpuAllocation?.devices[0]?.uuid, "GPU-test-a");
  });
});
