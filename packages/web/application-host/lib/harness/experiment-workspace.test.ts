import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { KernelClientError, type KernelClient, type KernelScopedClient } from "../kernel/kernel-client.js";
import { ExperimentPreparationError } from "./experiment-backend.js";
import { materializeExperimentAttempt, reconcileExperimentPreparation, type ExperimentInputSnapshot } from "./experiment-workspace.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-preparation-proof-")); roots.push(root);
  const caller = { workspaceId: "ws", executionWorkspaceId: "exec" };
  const input: ExperimentInputSnapshot = {
    schemaVersion: 1, branchId: "original-input", root: "sha256-original", sourceRoot: root,
    workspaceId: "ws", executionWorkspaceId: "exec", captureScopes: [], capturedPathCount: 0, inventoryFingerprint: "empty",
    captureSemantics: { excludedDirectories: [".git", ".varin"], gitignore: "not-applied", ignoredFilesIncluded: true },
  };
  let receipt: Record<string, unknown> | null = { state: "committed", result: { root: input.root, status: "materialized" } };
  let leaseStatus = "busy";
  let materializationError: Error = new Error("transport disconnected");
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const scoped = {
    async getOperation(operation: string) { calls.push({ operation: "get", value: operation }); return receipt; },
    async readBranch() { return { workspaceId: caller.workspaceId, root: input.root, currentRoot: input.root }; },
    async fileRootRegister() { return { rootId: "original-storage-root" }; },
    async fileLeaseAcquire(value: unknown) { calls.push({ operation: "lease", value }); return { status: leaseStatus }; },
    async fileLeaseRelease(value: unknown) { calls.push({ operation: "release", value }); return { released: true }; },
    async fileMaterialize(value: unknown) { calls.push({ operation: "materialize", value }); throw materializationError; },
  } as unknown as KernelScopedClient;
  const client = { handshake: { storageRoot: root }, start: async () => ({}), issueGrant: async () => ({}), scoped: () => scoped } as unknown as KernelClient;
  return { caller, input, client, calls, setReceipt: (value: typeof receipt) => { receipt = value; }, setLease: (value: string) => { leaseStatus = value; }, failMaterialization: (error: Error) => { materializationError = error; } };
}

describe("local preparation drain proof with explicit kernel authority fixtures", () => {
  it("requires both the original committed root and an acquired physical subtree lease", async () => {
    const f = await fixture();
    assert.equal(await reconcileExperimentPreparation(f.client, f.caller, "attempt", f.input), "unknown");
    assert.equal(f.calls.filter((call) => call.operation === "release").length, 0);
    f.setLease("acquired");
    assert.equal(await reconcileExperimentPreparation(f.client, f.caller, "attempt", f.input), "drained");
    assert.equal(f.calls.filter((call) => call.operation === "materialize").length, 0);
    const acquired = f.calls.filter((call) => call.operation === "lease").at(-1)!.value as { rootId: string; leaseId: string; resources: Array<{ path: string; scope: string }> };
    const released = f.calls.find((call) => call.operation === "release")!.value as { rootId: string; leaseId: string };
    assert.equal(released.leaseId, acquired.leaseId); assert.equal(released.rootId, acquired.rootId);
    assert.equal(acquired.resources[0]!.scope, "subtree"); assert.match(acquired.resources[0]!.path, /^managed\/experiments\//);
  });

  it("keeps missing, started, and different-root receipts unknown without probing a substitute target", async () => {
    const f = await fixture(); f.setLease("acquired");
    for (const receipt of [null, { state: "started", result: { root: f.input.root } }, { state: "committed", result: { root: "sha256-other" } }]) {
      f.setReceipt(receipt); assert.equal(await reconcileExperimentPreparation(f.client, f.caller, "attempt", f.input), "unknown");
    }
    assert.equal(f.calls.filter((call) => call.operation === "lease" || call.operation === "materialize").length, 0);
  });

  it("distinguishes a real cancellation acknowledgement from loss of the materialization connection", async () => {
    const f = await fixture();
    await assert.rejects(materializeExperimentAttempt(f.client, f.caller, "attempt", f.input), (error: unknown) => error instanceof ExperimentPreparationError && !error.drained);
    f.failMaterialization(new KernelClientError({ code: "cancelled", message: "native worker acknowledged cancellation" }));
    await assert.rejects(materializeExperimentAttempt(f.client, f.caller, "attempt", f.input), (error: unknown) => error instanceof ExperimentPreparationError && error.drained);
    assert.equal(f.calls.filter((call) => call.operation === "materialize").length, 2);
  });
});
