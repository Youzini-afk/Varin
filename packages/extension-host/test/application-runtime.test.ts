import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { parseVarinContextFragments, parseVarinExtensionServiceProvision,
  VARIN_CONTEXT_FRAGMENTS_CONTRACT, VARIN_CONTEXT_FRAGMENTS_SERVICE, type VarinExtensionStorageSnapshot } from "@varin/extension-contract";
import { ApplicationExtensionRuntime, ChildBrokeredHostTransport } from "../src/index.js";

const directories: string[] = [];
const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
};
test.after(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))); });

const extensionId = "dev.example.brokered";
const serviceId = "dev.example.memory";
const varinVersion = "1.2.3";

const writeHostExtension = async (
  directory: string,
  version: string,
  schemaVersion: number,
  migration: "ok" | "throw",
  mode: "brokered" | "native" = "brokered",
  grouped = false,
): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "varin.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: extensionId,
    version,
    engines: { varin: "*" },
    storage: { schemaVersion },
    entrypoints: { host: { activation: ["service-request"], file: "host.cjs", mode },
      ...(grouped ? { surfaces: [{ id: "panel", mode: "declarative", supports: ["web"] }] } : {}) },
    ...(grouped ? { updateReadiness: { surfaceEntrypoints: ["panel"] } } : {}),
    provides: { services: [{ id: serviceId, version: 1 }] },
  }), "utf8");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: extensionId, version }), "utf8");
  await mkdir(join(directory, "runtime"), { recursive: true });
  await writeFile(join(directory, "runtime", "tool.mjs"), "export {};\n", "utf8");
  await writeFile(join(directory, "host.cjs"), `
module.exports = {
  migrate(input) {
    ${migration === "throw" ? "throw new Error('v2 migration failed');" : `return { ...input.data, value: '${version}' };`}
  },
  activate(context) {
    context.services.provide({ id: '${serviceId}', version: 1 }, {
      read() { return context.storage.snapshot.document.data.value || '${version}'; },
      generation() { return '${version}'; },
      assetPath() { return context.assets.path('runtime/tool.mjs'); },
      async write([value]) { await context.storage.update({ value }); return value; },
      crash() { setTimeout(() => process.exit(17), 100); return 'crashing'; }
    });
  }
};
`, "utf8");
};

const writeRoutingProvider = async (directory: string, providerExtensionId: string, value: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "varin.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: providerExtensionId,
    version: "1.0.0",
    engines: { varin: "*" },
    entrypoints: { host: { activation: ["service-request"], file: "host.cjs", mode: "brokered" } },
    provides: { services: [{ id: serviceId, multiple: true, version: 1 }] },
  }), "utf8");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: providerExtensionId, version: "1.0.0" }), "utf8");
  await writeFile(join(directory, "host.cjs"), `
module.exports = {
  activate(context) {
    // Ordinary service activation identifies its implementation; multiplicity belongs to the manifest.
    context.services.provide({ id: '${serviceId}', version: 1 }, {
      read() { return '${value}'; },
      async readRouted([routing]) {
        return context.services.use('${serviceId}', 1, { routing }).call('read');
      }
    });
  }
};
`, "utf8");
};

const writeMultiStorageExtension = async (
  directory: string,
  version: string,
  schemaVersion = 1,
): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "varin.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id: extensionId,
    version,
    engines: { varin: "*" },
    storage: { schemaVersion },
    entrypoints: { host: { activation: ["service-request"], file: "host.cjs", mode: "brokered" } },
    provides: { services: [{ id: serviceId, version: 1 }] },
  }), "utf8");
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: extensionId, version }), "utf8");
  await writeFile(join(directory, "host.cjs"), `
module.exports = {
  migrate(input) { return input.data; },
  async activate(context) {
    const profile = await context.storage.open({ scope: 'profile', key: 'preferences', schemaVersion: ${schemaVersion} });
    const workspace = await context.storage.open({ scope: 'workspace', key: 'preferences', schemaVersion: ${schemaVersion} });
    await context.storage.update({ value: '${version}-application' });
    await profile.update({ value: '${version}-profile' });
    await workspace.update({ value: '${version}-workspace' });
    context.services.provide({ id: '${serviceId}', version: 1 }, {
      readAll() {
        return {
          application: context.storage.snapshot.document.data.value,
          profile: profile.snapshot.document.data.value,
          workspace: workspace.snapshot.document.data.value
        };
      },
      crash() { setTimeout(() => process.exit(17), 100); return 'crashing'; }
    });
  }
};
`, "utf8");
};

const writeSurfaceOnlyExtension = async (directory: string, id: string): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "varin.extension.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    version: "1.0.0",
    engines: { varin: "*" },
    entrypoints: { surfaces: [{ id: "main", file: "surface.cjs", mode: "managed", supports: ["web"] }] },
  }), "utf8");
  await writeFile(join(directory, "surface.cjs"), "module.exports={activate(){}};", "utf8");
};

test("brokered Host storage, migration rollback, services, and crash isolation preserve application state", { timeout: 30_000 }, async () => {
  const dataDir = await temporaryDirectory("varin-broker-runtime-");
  const v1 = await temporaryDirectory("varin-broker-v1-");
  const v2 = await temporaryDirectory("varin-broker-v2-");
  await writeHostExtension(v1, "1.0.0", 1, "ok");
  await writeHostExtension(v2, "2.0.0", 2, "throw");
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
    varinVersion,
  });
  try {
    const started = await runtime.start();
    const installed = await runtime.installOrStage({
      expectedRevision: started.catalog.revision,
      source: { display: "Broker v1", kind: "local", specifier: v1 },
    });
    assert.equal(installed.extensions[0]?.selectedVersion, "1.0.0");
    assert.equal(await runtime.invokeService({ args: [], method: "read", serviceId, version: 1 }), "1.0.0");
    const assetPath = await runtime.invokeService({ args: [], method: "assetPath", serviceId, version: 1 });
    assert.equal(typeof assetPath, "string");
    assert.match(String(assetPath).replaceAll("\\", "/"), /\/package\/runtime\/tool\.mjs$/);
    assert.equal(await runtime.invokeService({ args: ["persisted"], method: "write", serviceId, version: 1 }), "persisted");
    assert.equal(await runtime.invokeService({ args: [], method: "read", serviceId, version: 1 }), "persisted");

    const staged = await runtime.installOrStage({
      expectedRevision: installed.revision,
      source: { display: "Broker v2", kind: "local", specifier: v2 },
    });
    assert.equal(staged.extensions[0]?.selectedVersion, "1.0.0");
    assert.equal(staged.extensions[0]?.candidate?.resolvedVersion, "2.0.0");
    assert.equal(await runtime.invokeService({ args: [], method: "read", serviceId, version: 1 }), "persisted");
    const candidateIntegrity = staged.extensions[0]?.candidate?.integrity;
    assert.ok(candidateIntegrity);
    await assert.rejects(
      runtime.discardCandidate({
        candidateIntegrity,
        expectedRevision: installed.revision,
        extensionId,
      }),
      /revision/i,
    );
    assert.equal((await runtime.state()).catalog.extensions[0]?.candidate?.integrity, candidateIntegrity);
    const discarded = await runtime.discardCandidate({
      candidateIntegrity,
      expectedRevision: staged.revision,
      extensionId,
    });
    assert.equal(discarded.extensions[0]?.candidate, undefined);
    assert.equal(await runtime.invokeService({ args: [], method: "read", serviceId, version: 1 }), "persisted");

    const failed = new Promise<void>((resolveFailed) => {
      const unsubscribe = runtime.subscribe(() => {
        void runtime.state().then((state) => {
          const status = state.catalog.extensions[0]?.actual.find((actual) => actual.realmKind === "host")?.status;
          if (status === "failed") { unsubscribe(); resolveFailed(); }
        });
      });
    });
    assert.equal(await runtime.invokeService({ args: [], method: "crash", serviceId, version: 1 }), "crashing");
    await failed;
    const afterCrash = await runtime.state();
    assert.equal(afterCrash.catalog.extensions[0]?.actual.find((actual) => actual.realmKind === "host")?.status, "failed");
    assert.equal(afterCrash.services.providers.length, 0);
  } finally {
    await runtime.stop();
  }
});

test("local reload is a no-op for identical content and transactionally applies or rolls back changed Host generations", { timeout: 30_000 }, async () => {
  const dataDir = await temporaryDirectory("varin-local-reload-runtime-");
  const source = await temporaryDirectory("varin-local-reload-source-");
  await writeHostExtension(source, "1.0.0", 1, "ok");
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
    varinVersion,
  });
  try {
    const started = await runtime.start();
    const installed = await runtime.installOrStage({
      expectedRevision: started.catalog.revision,
      source: { display: "Reload fixture", kind: "local", specifier: source },
    });
    assert.equal(await runtime.invokeService({ args: [], method: "generation", serviceId, version: 1 }), "1.0.0");

    const beforeUnchanged = await runtime.state();
    const unchanged = await runtime.reloadLocalSource({
      expectedRevision: installed.revision,
      extensionId,
    });
    assert.equal(unchanged.outcome, "unchanged");
    assert.equal(unchanged.snapshot.revision, installed.revision);
    assert.equal((await runtime.state()).revision, beforeUnchanged.revision);

    await writeHostExtension(source, "2.0.0", 2, "ok");
    const changed = await runtime.reloadLocalSource({
      expectedRevision: unchanged.snapshot.revision,
      extensionId,
    });
    assert.equal(changed.outcome, "staged");
    assert.equal(changed.snapshot.extensions[0]?.selectedVersion, "1.0.0");
    assert.equal(changed.snapshot.extensions[0]?.candidate?.capabilitiesReviewed, true);
    const v2Integrity = changed.snapshot.extensions[0]?.candidate?.integrity;
    assert.ok(v2Integrity);
    const v2Requested = await runtime.requestCandidateApplication({
      candidateIntegrity: v2Integrity,
      expectedRevision: changed.snapshot.revision,
      extensionId,
    });
    await runtime.prepareCandidate(extensionId, v2Integrity);
    const v2Selected = await runtime.selectCandidate({
      candidateIntegrity: v2Integrity,
      expectedRevision: v2Requested.revision,
      extensionId,
    });
    assert.equal(v2Selected.extensions[0]?.selectedVersion, "2.0.0");
    assert.equal(await runtime.invokeService({ args: [], method: "generation", serviceId, version: 1 }), "2.0.0");

    await writeHostExtension(source, "3.0.0", 3, "throw");
    const failing = await runtime.reloadLocalSource({
      expectedRevision: v2Selected.revision,
      extensionId,
    });
    assert.equal(failing.outcome, "staged");
    const v3Integrity = failing.snapshot.extensions[0]?.candidate?.integrity;
    assert.ok(v3Integrity);
    await runtime.requestCandidateApplication({
      candidateIntegrity: v3Integrity,
      expectedRevision: failing.snapshot.revision,
      extensionId,
    });
    await assert.rejects(runtime.prepareCandidate(extensionId, v3Integrity), /v2 migration failed/);

    const afterFailure = await runtime.state();
    assert.equal(afterFailure.catalog.extensions[0]?.selectedVersion, "2.0.0");
    assert.equal(afterFailure.catalog.extensions[0]?.candidate?.integrity, v3Integrity);
    assert.equal(await runtime.invokeService({ args: [], method: "generation", serviceId, version: 1 }), "2.0.0");
  } finally {
    await runtime.stop();
  }
});

test("candidate Host generations stage every opened storage document and commit them together", { timeout: 30_000 }, async () => {
  const dataDir = await temporaryDirectory("varin-multi-storage-runtime-");
  const v1 = await temporaryDirectory("varin-multi-storage-v1-");
  const v2 = await temporaryDirectory("varin-multi-storage-v2-");
  await writeMultiStorageExtension(v1, "1.0.0");
  await writeMultiStorageExtension(v2, "2.0.0");
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
    varinVersion,
  });
  const applicationAddress = { extensionId, key: "state", scope: "application" as const };
  const profileAddress = { extensionId, key: "preferences", scope: "profile" as const };
  const workspaceAddress = { extensionId, key: "preferences", scope: "workspace" as const };
  try {
    const started = await runtime.start();
    const installed = await runtime.installOrStage({
      expectedRevision: started.catalog.revision,
      source: { display: "Storage v1", kind: "local", specifier: v1 },
    });
    assert.deepEqual(await runtime.invokeService({ args: [], method: "readAll", serviceId, version: 1 }), {
      application: "1.0.0-application",
      profile: "1.0.0-profile",
      workspace: "1.0.0-workspace",
    });
    const staged = await runtime.installOrStage({
      expectedRevision: installed.revision,
      source: { display: "Storage v2", kind: "local", specifier: v2 },
    });
    const integrity = staged.extensions[0]?.candidate?.integrity;
    assert.ok(integrity);
    const requested = await runtime.requestCandidateApplication({
      candidateIntegrity: integrity,
      expectedRevision: staged.revision,
      extensionId,
    });
    await runtime.prepareCandidate(extensionId, integrity);
    assert.deepEqual((await runtime.storage.read(applicationAddress)).document.data, { value: "1.0.0-application" });
    assert.deepEqual((await runtime.storage.read(profileAddress)).document.data, { value: "1.0.0-profile" });
    assert.deepEqual((await runtime.storage.read(workspaceAddress)).document.data, { value: "1.0.0-workspace" });

    await runtime.storage.update(workspaceAddress, 1, 1, { value: "concurrent-workspace" });
    await assert.rejects(runtime.selectCandidate({
      candidateIntegrity: integrity,
      expectedRevision: requested.revision,
      extensionId,
    }), /expected revision 1, actual revision 2/i);
    assert.equal((await runtime.state()).catalog.extensions[0]?.selectedVersion, "1.0.0");
    assert.deepEqual((await runtime.storage.read(applicationAddress)).document.data, { value: "1.0.0-application" });
    assert.deepEqual((await runtime.storage.read(profileAddress)).document.data, { value: "1.0.0-profile" });
    assert.deepEqual((await runtime.storage.read(workspaceAddress)).document.data, { value: "concurrent-workspace" });

    await runtime.discardPreparedCandidate(extensionId, integrity);
    await runtime.prepareCandidate(extensionId, integrity);
    const selected = await runtime.selectCandidate({
      candidateIntegrity: integrity,
      expectedRevision: requested.revision,
      extensionId,
    });
    assert.equal(selected.extensions[0]?.selectedVersion, "2.0.0");
    assert.deepEqual(await runtime.invokeService({ args: [], method: "readAll", serviceId, version: 1 }), {
      application: "2.0.0-application",
      profile: "2.0.0-profile",
      workspace: "2.0.0-workspace",
    });
    assert.equal((await runtime.storage.read(applicationAddress)).document.revision, 2);
    assert.equal((await runtime.storage.read(profileAddress)).document.revision, 2);
    assert.equal((await runtime.storage.read(workspaceAddress)).document.revision, 3);
  } finally {
    await runtime.stop();
  }
});

test("candidate Host storage rolls back every committed document when storage sync fails", { timeout: 30_000 }, async (t) => {
  const dataDir = await temporaryDirectory("varin-storage-sync-rollback-runtime-");
  const v1 = await temporaryDirectory("varin-storage-sync-rollback-v1-");
  const v2 = await temporaryDirectory("varin-storage-sync-rollback-v2-");
  await writeMultiStorageExtension(v1, "1.0.0", 1);
  await writeMultiStorageExtension(v2, "2.0.0", 2);
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
    varinVersion,
  });
  const addresses = [
    { extensionId, key: "state", scope: "application" as const },
    { extensionId, key: "preferences", scope: "profile" as const },
    { extensionId, key: "preferences", scope: "workspace" as const },
  ];
  try {
    const started = await runtime.start();
    const installed = await runtime.installOrStage({
      expectedRevision: started.catalog.revision,
      source: { display: "Storage rollback v1", kind: "local", specifier: v1 },
    });
    assert.deepEqual(await runtime.invokeService({ args: [], method: "readAll", serviceId, version: 1 }), {
      application: "1.0.0-application",
      profile: "1.0.0-profile",
      workspace: "1.0.0-workspace",
    });
    const staged = await runtime.installOrStage({
      expectedRevision: installed.revision,
      source: { display: "Storage rollback v2", kind: "local", specifier: v2 },
    });
    const integrity = staged.extensions[0]?.candidate?.integrity;
    assert.ok(integrity);
    const requested = await runtime.requestCandidateApplication({
      candidateIntegrity: integrity,
      expectedRevision: staged.revision,
      extensionId,
    });
    const prepared = await runtime.prepareCandidate(extensionId, integrity);
    assert.ok(prepared.providers[0]);
    const originalRequest = ChildBrokeredHostTransport.prototype.request;
    let faults = 0;
    t.mock.method(ChildBrokeredHostTransport.prototype, "request", async function (
      this: ChildBrokeredHostTransport, method: string, params?: unknown, signal?: AbortSignal,
    ) {
      if (method === "storage.sync" && faults === 0) {
        const snapshots = (params as { storages: VarinExtensionStorageSnapshot[] }).storages;
        if (snapshots.every(snapshot => snapshot.address.extensionId === extensionId && snapshot.document.schemaVersion === 2)) {
          assert.equal(snapshots.length, 3);
          assert.deepEqual(snapshots.map(snapshot => snapshot.address), addresses);
          assert.deepEqual(snapshots.map(snapshot => snapshot.document.data.value),
            ["2.0.0-application", "2.0.0-profile", "2.0.0-workspace"]);
          faults++;
          throw new Error("injected v2 storage.sync failure");
        }
      }
      return originalRequest.call(this, method, params, signal);
    });

    const beforeFailure = await runtime.state();
    const selectedProvider = beforeFailure.services.providers.find((provider) => provider.extensionId === extensionId);
    assert.ok(selectedProvider);
    await assert.rejects(runtime.selectCandidate({
      candidateIntegrity: integrity,
      expectedRevision: requested.revision,
      extensionId,
    }), /injected v2 storage\.sync failure/);
    assert.equal(faults, 1, "the fault must reach the actual candidate storage-sync boundary");

    const afterFailure = await runtime.state();
    assert.equal(afterFailure.catalog.revision, requested.revision);
    assert.equal(afterFailure.catalog.extensions[0]?.selectedVersion, "1.0.0");
    assert.equal(afterFailure.catalog.extensions[0]?.candidate?.integrity, integrity);
    assert.equal(
      afterFailure.services.providers.find((provider) => provider.extensionId === extensionId)?.generation,
      selectedProvider.generation,
    );
    for (const [index, address] of addresses.entries()) {
      const snapshot = await runtime.storage.read(address);
      assert.equal(snapshot.document.schemaVersion, 1);
      assert.deepEqual(snapshot.document.data, {
        value: `1.0.0-${["application", "profile", "workspace"][index]}`,
      });
    }

    await runtime.discardPreparedCandidate(extensionId, integrity);
    await runtime.prepareCandidate(extensionId, integrity);
    const selected = await runtime.selectCandidate({
      candidateIntegrity: integrity,
      expectedRevision: requested.revision,
      extensionId,
    });
    assert.equal(selected.extensions[0]?.selectedVersion, "2.0.0");
    for (const address of addresses) {
      const snapshot = await runtime.storage.read(address);
      assert.equal(snapshot.document.schemaVersion, 2);
    }
  } finally {
    await runtime.stop();
  }
});

test("remove retains storage by default and deletes only when explicitly requested", async () => {
  const dataDir = await temporaryDirectory("varin-remove-storage-runtime-");
  const source = await temporaryDirectory("varin-remove-storage-source-");
  const id = "dev.example.removable";
  await writeSurfaceOnlyExtension(source, id);
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
    varinVersion,
  });
  const dataAddress = { extensionId: id, key: "preferences", scope: "profile" as const };
  try {
    const started = await runtime.start();
    const installed = await runtime.installOrStage({
      expectedRevision: started.catalog.revision,
      source: { display: "Removable", kind: "local", specifier: source },
    });
    await runtime.storage.update(dataAddress, 0, 1, { retained: true });
    const disabled = await runtime.setEnabled(id, false, installed.revision);
    const retained = await runtime.removeExtension({
      deleteData: false,
      expectedRevision: disabled.revision,
      extensionId: id,
    });
    assert.equal(retained.extensions.some((entry) => entry.manifest.id === id), false);
    assert.deepEqual((await runtime.storage.read(dataAddress)).document.data, { retained: true });

    const reinstalled = await runtime.installOrStage({
      expectedRevision: retained.revision,
      source: { display: "Removable", kind: "local", specifier: source },
    });
    const disabledAgain = await runtime.setEnabled(id, false, reinstalled.revision);
    await runtime.removeExtension({
      deleteData: true,
      expectedRevision: disabledAgain.revision,
      extensionId: id,
    });
    assert.equal((await runtime.storage.read(dataAddress)).exists, false);
  } finally {
    await runtime.stop();
  }
});

test("recreating a Runtime in the same process cannot satisfy a trusted-native restart handoff", async () => {
  const dataDir = await temporaryDirectory("varin-native-runtime-");
  const v1 = await temporaryDirectory("varin-native-v1-");
  const v2 = await temporaryDirectory("varin-native-v2-");
  await writeHostExtension(v1, "1.0.0", 1, "ok", "native");
  await writeHostExtension(v2, "2.0.0", 1, "ok", "native");
  const brokerScript = fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url));
  const first = await ApplicationExtensionRuntime.create({ brokerScript, dataDir, varinVersion });
  let integrity = '';
  try {
    const started = await first.start();
    const installed = await first.installOrStage({ expectedRevision: started.catalog.revision,
      source: { display: "Native v1", kind: "local", specifier: v1 } });
    await first.activateExtension(extensionId);
    const staged = await first.installOrStage({ expectedRevision: installed.revision,
      source: { display: "Native v2", kind: "local", specifier: v2 } });
    integrity = staged.extensions[0]!.candidate!.integrity;
    const requested = await first.requestCandidateApplication({ candidateIntegrity: integrity, expectedRevision: staged.revision, extensionId });
    await assert.rejects(first.prepareCandidate(extensionId, integrity), /restart handoff/);
    assert.equal((await first.state()).catalog.extensions[0]!.selectedVersion, "1.0.0");
    await first.requestRestartHandoff({ extensionId, candidateIntegrity: integrity, expectedRevision: requested.revision, handoffId: "same-process-test" });
    assert.equal(await first.invokeService({ args: [], method: "generation", serviceId, version: 1 }), "1.0.0");
  } finally { await first.stop(); }
  const recreated = await ApplicationExtensionRuntime.create({ brokerScript, dataDir, varinVersion });
  try {
    const state = await recreated.start();
    assert.equal(state.catalog.extensions[0]!.selectedVersion, "1.0.0");
    assert.equal(state.catalog.extensions[0]!.restartHandoffs!.at(-1)!.status, "pending-restart");
    await assert.rejects(recreated.prepareCandidate(extensionId, integrity), /restart|recovery/i);
  } finally { await recreated.stop(); }
});

test("persistent routes select different real providers by session and isolate provider withdrawal", { timeout: 30_000 }, async () => {
  const dataDir = await temporaryDirectory("varin-routing-runtime-");
  const alpha = await temporaryDirectory("varin-routing-alpha-");
  const beta = await temporaryDirectory("varin-routing-beta-");
  await writeRoutingProvider(alpha, "dev.example.alpha", "alpha");
  await writeRoutingProvider(beta, "dev.example.beta", "beta");
  const runtime = await ApplicationExtensionRuntime.create({
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)),
    dataDir,
    varinVersion,
  });
  try {
    const started = await runtime.start();
    const withAlpha = await runtime.installOrStage({
      expectedRevision: started.catalog.revision,
      source: { display: "Alpha", kind: "local", specifier: alpha },
    });
    await runtime.installOrStage({
      expectedRevision: withAlpha.revision,
      source: { display: "Beta", kind: "local", specifier: beta },
    });
    await assert.rejects(
      runtime.invokeService({ args: [], method: "read", serviceId, version: 1 }),
      /explicit routing rule is required/,
    );
    assert.equal((await runtime.state()).services.providers.length, 0, "ambiguous preparation must not launch either provider");
    // Ambiguous preparation must not activate unrelated roots. Activate the fixtures
    // explicitly to obtain their stable routing keys for the scoped-selection checks.
    await Promise.all([runtime.activateExtension("dev.example.alpha"), runtime.activateExtension("dev.example.beta")]);
    const providers = (await runtime.state()).services.providers;
    const alphaProvider = providers.find((provider) => provider.extensionId === "dev.example.alpha");
    const betaProvider = providers.find((provider) => provider.extensionId === "dev.example.beta");
    assert.ok(alphaProvider);
    assert.ok(betaProvider);
    assert.equal(alphaProvider.descriptor.multiple, true);
    assert.equal(betaProvider.descriptor.multiple, true);
    const alphaRoute = await runtime.upsertServiceRoutingRule({
      expectedRevision: 0,
      rule: {
        allowFallback: false,
        providerKeys: [alphaProvider.providerKey],
        scope: { sessionId: "session-alpha" },
        serviceId,
        version: 1,
      },
    });
    await runtime.upsertServiceRoutingRule({
      expectedRevision: alphaRoute.document.revision,
      rule: {
        allowFallback: false,
        providerKeys: [betaProvider.providerKey],
        scope: { sessionId: "session-beta" },
        serviceId,
        version: 1,
      },
    });
    assert.equal(await runtime.invokeService({
      args: [], method: "read", routing: { sessionId: "session-alpha" }, serviceId, version: 1,
    }), "alpha");
    assert.equal(await runtime.invokeService({
      args: [], method: "read", routing: { sessionId: "session-beta" }, serviceId, version: 1,
    }), "beta");
    assert.equal(await runtime.invokeService({ args: [{ sessionId: "session-beta" }], method: "readRouted",
      providerId: alphaProvider.providerId, serviceId, version: 1 }), "beta",
      "An actual broker nested service call resolves the same scoped array through the registered owner");


    for (const providerKeys of [[], [alphaProvider.providerKey, betaProvider.providerKey]]) {
      await runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
        rule: { allowFallback: true, providerKeys, scope: { sessionId: "invalid-single" }, serviceId, version: 1 } });
      await assert.rejects(runtime.prepareService({ args: [], method: "read", routing: { sessionId: "invalid-single" }, serviceId, version: 1 }),
        /requires exactly one provider/);
      await assert.rejects(runtime.invokeService({ args: [{ sessionId: "invalid-single" }], method: "readRouted",
        providerId: alphaProvider.providerId, serviceId, version: 1 }), /requires exactly one provider/);
    }
    await assert.rejects(runtime.prepareServiceCollection({ args: [], method: "read", routing: { sessionId: "session-beta" }, serviceId, version: 1 }),
      /declare ordered composition/);

    await runtime.setEnabled("dev.example.alpha", false, (await runtime.state()).catalog.revision);
    await assert.rejects(
      runtime.invokeService({ args: [], method: "read", routing: { sessionId: "session-alpha" }, serviceId, version: 1 }),
      /Selected providers .* are unavailable/,
    );
    assert.equal(await runtime.invokeService({
      args: [], method: "read", routing: { sessionId: "session-beta" }, serviceId, version: 1,
    }), "beta");

    const beforeProfile = await runtime.state();
    await runtime.upsertWorkbenchProfile({
      expectedRevision: beforeProfile.workbench.document.revision,
      profile: { extensionIds: ["dev.example.beta"], id: "beta-only", label: "Beta only" },
    });
    const applied = await runtime.applyWorkbenchProfile({
      expectedCatalogRevision: (await runtime.state()).catalog.revision,
      profileId: "beta-only",
    });
    assert.equal(applied.extensions.find((entry) => entry.manifest.id === "dev.example.alpha")?.desired.enabled, false);
    assert.equal(applied.extensions.find((entry) => entry.manifest.id === "dev.example.beta")?.desired.enabled, true);

    const disabledBeta = await runtime.setEnabled(
      "dev.example.beta",
      false,
      (await runtime.state()).catalog.revision,
    );
    const removed = await runtime.removeExtension({
      deleteData: false,
      expectedRevision: disabledBeta.revision,
      extensionId: "dev.example.beta",
    });
    assert.equal(removed.extensions.some((entry) => entry.manifest.id === "dev.example.beta"), false);
  } finally {
    await runtime.stop();
  }
});

for (const mode of ["brokered", "native"] as const) {
  test(`${mode} service cancellation reaches the call context without inventing completion`, { timeout: 30_000 }, async () => {
    const dataDir = await temporaryDirectory(`varin-cancel-${mode}-`);
    const source = await temporaryDirectory(`varin-cancel-source-${mode}-`);
    await writeHostExtension(source, "1.0.0", 1, "ok", mode);
    await writeFile(join(source, "host.cjs"), `
module.exports = {
  migrate({ data }) { return data; },
  activate(context) {
    let pending = null;
    let started = false;
    let observedAbort = false;
    let callId = null;
    context.services.provide({ id: '${serviceId}', version: 1 }, {
      state() { return { started, observedAbort, callId }; },
      wait([cooperative], call) {
        started = true;
        callId = call.callId;
        return new Promise((resolve, reject) => {
          pending = resolve;
          const abort = () => {
            observedAbort = true;
            if (cooperative) { pending = null; reject(new Error('handler confirmed cancellation')); }
          };
          if (call.signal.aborted) abort();
          else call.signal.addEventListener('abort', abort, { once: true });
        });
      },
      release() { pending?.('actual completion'); pending = null; return null; }
    });
  }
};`, "utf8");
    const runtime = await ApplicationExtensionRuntime.create({
      brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)), dataDir, varinVersion,
    });
    try {
      const started = await runtime.start();
      await runtime.installOrStage({ expectedRevision: started.catalog.revision,
        source: { display: "Cancellation fixture", kind: "local", specifier: source } });
      const invoke = (method: string, args: boolean[] = [], signal?: AbortSignal) => (
        runtime.invokeService({ args, method, serviceId, version: 1 }, signal)
      );
      const readState = async () => await invoke("state") as { started: boolean; observedAbort: boolean; callId: string };
      const controller = new AbortController();
      let settled = false;
      const waiting = invoke("wait", [false], controller.signal).finally(() => { settled = true; });
      while (!(await readState()).started) await delay(5);
      controller.abort();
      while (!(await readState()).observedAbort) await delay(5);
      assert.equal(settled, false, "request remains owned while the handler still runs");
      assert.equal(typeof (await readState()).callId, "string");
      await invoke("release");
      assert.equal(await waiting, "actual completion");

      const cooperative = new AbortController();
      const cooperativelyWaiting = invoke("wait", [true], cooperative.signal);
      const rejected = assert.rejects(cooperativelyWaiting, /handler confirmed cancellation/);
      // A separate state request ensures the worker has accepted the preceding invocation.
      await invoke("state");
      cooperative.abort();
      await rejected;
      await assert.rejects(invoke("wait", [true], AbortSignal.abort(new Error("not dispatched"))), /not dispatched/);
    } finally { await runtime.stop(); }
  });
}

test("packaged and authored ContextFragments use the full SDK descriptor through real broker preparation", { timeout: 30_000 }, async () => {
  const root = await temporaryDirectory("varin-context-author-");
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, "data"), varinVersion,
    brokerScript: fileURLToPath(new URL("../broker/broker-child.mjs", import.meta.url)) });
  try {
    await runtime.start();
    const example = join(root, "project-context"); await mkdir(example);
    for (const name of ["package.json", "varin.extension.json"]) {
      await copyFile(fileURLToPath(new URL(`../../../examples/extensions/project-context/${name}`, import.meta.url)), join(example, name));
    }
    await build({ entryPoints: [fileURLToPath(new URL("../../../examples/extensions/project-context/host.ts", import.meta.url))],
      outfile: join(example, "host.cjs"), bundle: true, platform: "node", format: "cjs",
      alias: { "@varin/extension-sdk": fileURLToPath(new URL("../../extension-sdk/dist/index.js", import.meta.url)) } });
    await runtime.installOrStage({ expectedRevision: (await runtime.catalog.snapshot()).revision,
      source: { kind: "local", display: "Project context", specifier: example } });
    const providerKeys = ["varin.builtin.context-fragments", "example.project-context"].map(id => `${id}:host:varin.context.fragments@1`);
    await runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
      rule: { allowFallback: false, providerKeys, scope: { projectId: "evidence-project" }, serviceId: "varin.context.fragments", version: 1 } });
    const prepared = await runtime.prepareServiceCollection({ serviceId: "varin.context.fragments", version: 1,
      method: "describe", args: [], routing: { projectId: "evidence-project" } });
    assert.deepEqual(prepared.bindings.map(binding => binding.providerKey), providerKeys);
    const sections = [];
    for (const binding of prepared.bindings) {
      assert.deepEqual(binding.descriptor, parseVarinExtensionServiceProvision(VARIN_CONTEXT_FRAGMENTS_SERVICE));
      const pin = binding.pin();
      try {
        assert.deepEqual(await pin.invoke("inspect", []), VARIN_CONTEXT_FRAGMENTS_CONTRACT);
        sections.push(...parseVarinContextFragments(await pin.invoke("describe", [])).sections);
      } finally { pin.release(); }
    }
    assert.deepEqual(sections.map(section => section.name), ["execution-reporting", "research-evidence"]);
    assert.ok(sections.every(section => section.kind === "instruction" && section.content.length > 0));
    const described = await runtime.queryContracts({ action: "describe", kind: "service", serviceId: "varin.context.fragments", version: 1,
      extensionId: "example.project-context", member: { kind: "method", name: "describe" } });
    assert.ok(described.kind === "service" && described.action === "describe");
    assert.deepEqual(described.member?.contract, VARIN_CONTEXT_FRAGMENTS_SERVICE.contract.methods.describe);
  } finally { await runtime.stop(); }
});
