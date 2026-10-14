import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION,
  VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID,
  VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_VERSION,
} from "@varin/extension-builtins";
import {
  VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
  VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
} from "@varin/extension-contract";
import { ApplicationExtensionRuntime } from "../src/application-runtime.js";

test("the native recovery built-in declares a replaceable Host service without package integration", () => {
  const manifest = VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION.manifest;
  assert.equal(manifest.id, "varin.builtin.recovery");
  assert.equal(manifest.version, VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_VERSION);
  assert.equal(manifest.version, "0.4.0");
  assert.equal(manifest.entrypoints?.host?.mode, "brokered");
  assert.deepEqual(manifest.entrypoints?.host?.activation, ["service-request"]);
  assert.deepEqual(manifest.capabilities?.host, ["workspace.recovery-primitives"]);
  assert.deepEqual(manifest.provides?.services, [{
    id: VARIN_WORKSPACE_RECOVERY_SERVICE_ID,
    multiple: true,
    version: VARIN_WORKSPACE_RECOVERY_SERVICE_VERSION,
  }]);
  assert.equal("integrates" in manifest, false);
});

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
  try {
    const started = await runtime.start();
    const entry = started.catalog.extensions.find((candidate) => (
      candidate.manifest.id === VARIN_BUILTIN_WORKSPACE_RECOVERY_EXTENSION_ID
    ));
    assert.equal(entry?.desired.enabled, true);
    assert.equal(entry?.integrity, undefined);
    assert.equal(calls.length, 0);

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
    await runtime.stop().catch(() => undefined);
    await rm(dataDir, { force: true, recursive: true });
  }
});
