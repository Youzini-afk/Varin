import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
} from "@varin/extension-builtins";
import {
  VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
  VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
} from "@varin/extension-contract";
import { ApplicationExtensionRuntime } from "../src/application-runtime.js";
import type { HostServiceBinding } from "../src/service-registry.js";

test("the built-in recovery Host activates on service invocation and withdraws on deactivation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-builtin-recovery-"));
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
    varinVersion: "1.2.3",
  });
  const calls: Array<{ method: string; params: unknown }> = [];
  runtime.capabilities.register("workspace.recovery-primitives", async (method, params) => {
    calls.push({ method, params });
    if (method === "listStorageWorkspaces") return { status: "ready", workspaces: [] };
    return {
      capabilities: {
        bindings: true,
        checkpoints: true,
        combined: true,
        journal: true,
        redo: true,
        storageManagement: true,
      },
      identity: {
        authorityId: runtime.services.hostId,
        canonicalRoot: "/workspace",
        filesystemProfile: "local-posix",
        workspaceId: "workspace-1",
      },
      status: "ready",
      storage: {
        authorityId: runtime.services.hostId,
        byteLength: 0,
        checkpointCount: 0,
        encryption: { available: false, enabled: false },
        location: { mode: "application-data" },
        locationSource: "global",
        objectCount: 0,
        readyCheckpointCount: 0,
        registryRevision: 0,
        state: "missing",
        workspaceId: "workspace-1",
      },
    };
  });
  let consumer: HostServiceBinding | undefined;
  try {
    const started = await runtime.start();
    const entry = started.catalog.extensions.find((candidate) => (
      candidate.manifest.id === VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID
    ));
    assert.equal(entry?.desired.enabled, true);
    assert.equal(entry?.integrity, undefined);
    assert.equal(calls.length, 0);

    consumer = await runtime.prepareService({
      args: [], method: "status",
      serviceId: VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
      version: VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
    });
    const result = await runtime.invokeService({
      args: ["workspace-1"],
      method: "status",
      serviceId: VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
      version: VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
    }) as { status?: string };
    assert.equal(result.status, "ready");
    assert.deepEqual(calls, [{ method: "status", params: { workspaceId: "workspace-1" } }]);
    const inventory = await runtime.invokeService({
      args: [],
      method: "listStorageWorkspaces",
      serviceId: VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
      version: VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
    }) as { status?: string; workspaces?: unknown[] };
    assert.deepEqual(inventory, { status: "ready", workspaces: [] });
    assert.deepEqual(calls.at(-1), { method: "listStorageWorkspaces", params: {} });
    const active = await runtime.state();
    assert.equal(active.services.providers.some((provider) => (
      provider.extensionId === VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID
      && provider.descriptor.id === VARIN_WORKSPACE_RECOVERY_SERVICE_ID
    )), true);

    await runtime.setEnabled(
      VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
      false,
      active.catalog.revision,
    );
    assert.equal(runtime.services.getSnapshot().providers.some((provider) => (
      provider.extensionId === VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID
    )), false);
    await assert.rejects(
      runtime.invokeService({
        args: ["workspace-1"],
        method: "status",
        serviceId: VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
        version: VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
      }),
      /no provider is available|provider is unavailable/i,
    );
  } finally {
    consumer?.release();
    await runtime.stop().catch(() => undefined);
    await rm(dataDir, { force: true, recursive: true });
  }
});
