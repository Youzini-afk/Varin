import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { VarinExtensionInstallationRecord } from "@varin/extension-contract";
import {
  VARIN_BUILTIN_EXTENSION_DEFINITIONS,
  VARIN_BUILTIN_EXTENSION_PREFIX,
} from "@varin/extension-builtins";
import {
  ApplicationExtensionCatalog,
  ExtensionCatalogRevisionConflictError,
  ExtensionCatalogStorageError,
} from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "varin-extension-host-"));
  temporaryDirectories.push(directory);
  return directory;
}

function installation(id = "dev.example.extension"): VarinExtensionInstallationRecord {
  const now = "2026-08-14T00:00:00.000Z";
  return {
    manifest: {
      schemaVersion: 1,
      id,
      version: "1.0.0",
      engines: { varin: ">=0.1.0" },
      entrypoints: { surfaces: [{ id: "main", mode: "managed", file: "dist/main.mjs", supports: ["web"] }] },
    },
    source: { kind: "npm", specifier: `npm:${id}`, display: `npm:${id}` },
    resolvedVersion: "1.0.0",
    selectedVersion: "1.0.0",
    desired: { enabled: true, revision: 1, updatedAt: now },
    capabilityGrants: [],
    installedAt: now,
    updatedAt: now,
  };
}

test.after(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("distinguishes a missing catalog from a persisted empty catalog", async () => {
  const dataDir = await temporaryDirectory();
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const missing = await catalog.snapshot();
  assert.equal(missing.storageState, "missing");
  assert.equal(missing.authoritative, true);
  assert.deepEqual(missing.extensions, []);

  const persisted = await catalog.upsert(installation(), 0);
  const empty = await catalog.remove("dev.example.extension", persisted.revision);
  assert.equal(empty.storageState, "ready");
  assert.equal(empty.authoritative, true);
  assert.deepEqual(empty.extensions, []);

  await writeFile(catalog.store.catalogPath, JSON.stringify({
    schemaVersion: 1,
    revision: 0,
    updatedAt: "2026-08-14T00:00:00.000Z",
    extensions: {},
  }), "utf8");
  const freshHostView = new ApplicationExtensionCatalog({ dataDir });
  const persistedRevisionZero = await freshHostView.setAllEnabled(false, 0);
  assert.equal(persistedRevisionZero.storageState, "ready");
});

test("preserves the last valid catalog when the file becomes malformed or disappears", async () => {
  const catalog = new ApplicationExtensionCatalog({ dataDir: await temporaryDirectory() });
  const installed = await catalog.upsert(installation(), 0);
  assert.equal(installed.extensions.length, 1);

  await writeFile(catalog.store.catalogPath, "{ malformed", "utf8");
  const malformed = await catalog.snapshot();
  assert.equal(malformed.storageState, "stale");
  assert.equal(malformed.authoritative, false);
  assert.equal(malformed.extensions.length, 1);

  await unlink(catalog.store.catalogPath);
  const disappeared = await catalog.snapshot();
  assert.equal(disappeared.storageState, "stale");
  assert.equal(disappeared.extensions.length, 1);
});

test("reports initial malformed storage as failure rather than an empty catalog", async () => {
  const directory = await temporaryDirectory();
  const catalog = new ApplicationExtensionCatalog({ dataDir: directory });
  await catalog.store.getHostIdentity();
  await writeFile(catalog.store.catalogPath, "[]", "utf8");
  await assert.rejects(() => catalog.snapshot(), ExtensionCatalogStorageError);
});

test("serializes mutations and rejects a stale expected revision", async () => {
  const catalog = new ApplicationExtensionCatalog({ dataDir: await temporaryDirectory() });
  const installed = await catalog.upsert(installation(), 0);
  const enabled = installed.extensions[0]?.desired.enabled;
  assert.equal(enabled, true);

  const first = await catalog.setEnabled("dev.example.extension", false, installed.revision);
  await assert.rejects(
    () => catalog.setEnabled("dev.example.extension", true, installed.revision),
    ExtensionCatalogRevisionConflictError,
  );
  const stored = JSON.parse(await readFile(catalog.store.catalogPath, "utf8")) as { revision: number };
  assert.equal(stored.revision, first.revision);
  assert.equal((await catalog.snapshot()).extensions[0]?.desired.enabled, false);
});

test("external extensions cannot be enabled until every selected capability has a decision", async () => {
  const catalog = new ApplicationExtensionCatalog({ dataDir: await temporaryDirectory() });
  const record = installation("dev.example.review");
  record.manifest.capabilities = { host: ["workspace.files"], surface: ["desktop.clipboard"] };
  record.desired.enabled = false;
  const installed = await catalog.upsert(record, 0);
  await assert.rejects(
    () => catalog.setEnabled("dev.example.review", true, installed.revision),
    /capabilities require review/,
  );
  const partial = await catalog.reviewCapabilities({
    decisions: [{ capability: "workspace.files", granted: false, realm: "host" }],
    expectedRevision: installed.revision,
    extensionId: "dev.example.review",
  });
  await assert.rejects(
    () => catalog.setEnabled("dev.example.review", true, partial.revision),
    /capabilities require review/,
  );
  const reviewed = await catalog.reviewCapabilities({
    decisions: [{ capability: "desktop.clipboard", granted: true, realm: "surface" }],
    expectedRevision: partial.revision,
    extensionId: "dev.example.review",
  });
  const enabled = await catalog.setEnabled("dev.example.review", true, reviewed.revision);
  assert.equal(enabled.extensions[0]?.desired.enabled, true);
});

test("reconciles Varin-owned built-ins while preserving their desired state", async () => {
  const catalog = new ApplicationExtensionCatalog({ dataDir: await temporaryDirectory() });
  const seeded = await catalog.reconcileBuiltins(
    VARIN_BUILTIN_EXTENSION_DEFINITIONS,
    VARIN_BUILTIN_EXTENSION_PREFIX,
  );
  assert.equal(seeded.extensions.length, VARIN_BUILTIN_EXTENSION_DEFINITIONS.length);
  assert.ok(seeded.extensions.every((entry) => entry.source.kind === "builtin"));

  const extensionId = VARIN_BUILTIN_EXTENSION_DEFINITIONS[0]?.manifest.id;
  assert.ok(extensionId);
  const disabled = await catalog.setEnabled(extensionId, false, seeded.revision);
  const reconciled = await catalog.reconcileBuiltins(
    VARIN_BUILTIN_EXTENSION_DEFINITIONS,
    VARIN_BUILTIN_EXTENSION_PREFIX,
  );
  assert.equal(reconciled.revision, disabled.revision);
  assert.equal(reconciled.extensions.find((entry) => entry.manifest.id === extensionId)?.desired.enabled, false);

  const updatedDefinitions = VARIN_BUILTIN_EXTENSION_DEFINITIONS.map((definition) => definition.manifest.id === extensionId
    ? { ...definition, manifest: { ...definition.manifest, version: "9.9.9" } } : definition);
  const updated = await catalog.reconcileBuiltins(updatedDefinitions, VARIN_BUILTIN_EXTENSION_PREFIX);
  const updatedEntry = updated.extensions.find((entry) => entry.manifest.id === extensionId)!;
  assert.equal(updatedEntry.selectedVersion, "9.9.9");
  assert.deepEqual(updatedEntry.manifest, updatedDefinitions[0]!.manifest);
  assert.equal(updatedEntry.desired.enabled, false);
  assert.equal(updatedEntry.desired.revision, disabled.extensions.find((entry) => entry.manifest.id === extensionId)!.desired.revision);
  const stable = await catalog.reconcileBuiltins(updatedDefinitions, VARIN_BUILTIN_EXTENSION_PREFIX);
  assert.equal(stable.revision, updated.revision);

  const trimmed = await catalog.reconcileBuiltins(
    VARIN_BUILTIN_EXTENSION_DEFINITIONS.slice(1),
    VARIN_BUILTIN_EXTENSION_PREFIX,
  );
  assert.equal(trimmed.extensions.some((entry) => entry.manifest.id === extensionId), false);
});

for (const kind of ["builtin", "external"] as const) test(`built-in reconciliation rejects an invalid ${kind} record without repairing storage`, async () => {
  const dataDir = await temporaryDirectory();
  const catalog = new ApplicationExtensionCatalog({ dataDir });
  const seeded = await catalog.reconcileBuiltins(VARIN_BUILTIN_EXTENSION_DEFINITIONS, VARIN_BUILTIN_EXTENSION_PREFIX);
  await catalog.upsert(installation(), seeded.revision);
  const valid = await catalog.snapshot();
  const stored = JSON.parse(await readFile(catalog.store.catalogPath, "utf8")) as {
    extensions: Record<string, Record<string, unknown>>;
  };
  const id = kind === "builtin" ? VARIN_BUILTIN_EXTENSION_DEFINITIONS[0]!.manifest.id : "dev.example.extension";
  stored.extensions[id]!.candidate = {};
  const invalidCatalog = `${JSON.stringify(stored, null, 2)}\n`;
  await writeFile(catalog.store.catalogPath, invalidCatalog, "utf8");

  for (const reader of [catalog, new ApplicationExtensionCatalog({ dataDir })]) {
    await assert.rejects(
      () => reader.reconcileBuiltins(VARIN_BUILTIN_EXTENSION_DEFINITIONS, VARIN_BUILTIN_EXTENSION_PREFIX),
      (error: unknown) => error instanceof ExtensionCatalogStorageError && error.code === "catalog_invalid",
    );
    if (reader === catalog) {
      const state = await reader.snapshot();
      assert.equal(state.authoritative, false);
      assert.equal(state.storageState, "stale");
      assert.deepEqual(state.extensions, valid.extensions, "retain the last valid non-authoritative view");
    } else {
      await assert.rejects(() => reader.snapshot(), (error: unknown) =>
        error instanceof ExtensionCatalogStorageError && error.code === "catalog_invalid");
    }
    assert.equal(await readFile(catalog.store.catalogPath, "utf8"), invalidCatalog);
  }
});

test("candidate capability deltas require explicit decisions and carry unchanged decisions forward", async () => {
  const catalog = new ApplicationExtensionCatalog({ dataDir: await temporaryDirectory() });
  const installed = await catalog.upsert(installation(), 0);
  const candidateManifest = {
    ...installation().manifest,
    capabilities: { host: ["workspace.files"] },
    version: "2.0.0",
  };
  const staged = await catalog.stageCandidate({
    integrity: `sha256-${"1".repeat(64)}`,
    manifest: candidateManifest,
    preparedAt: "2026-08-14T00:01:00.000Z",
    resolvedPath: "C:/extensions/dev.example.extension/2.0.0",
    resolvedVersion: "2.0.0",
    source: { kind: "npm", specifier: "npm:dev.example.extension", display: "npm:dev.example.extension" },
  }, installed.revision);
  assert.deepEqual(staged.extensions[0]?.candidate?.capabilityDelta.added, [{ capability: "workspace.files", realm: "host" }]);
  assert.equal(staged.extensions[0]?.candidate?.capabilitiesReviewed, false);
  await assert.rejects(
    () => catalog.selectCandidate("dev.example.extension", `sha256-${"1".repeat(64)}`, staged.revision),
    /require review/,
  );

  const reviewed = await catalog.reviewCandidateCapabilities({
    candidateIntegrity: `sha256-${"1".repeat(64)}`,
    decisions: [{ capability: "workspace.files", granted: false, realm: "host" }],
    expectedRevision: staged.revision,
    extensionId: "dev.example.extension",
  });
  assert.equal(reviewed.extensions[0]?.candidate?.capabilitiesReviewed, true);
  await assert.rejects(
    () => catalog.selectCandidate("dev.example.extension", `sha256-${"1".repeat(64)}`, reviewed.revision),
    /application was not requested/,
  );
  const requested = await catalog.requestCandidateApplication(
    "dev.example.extension",
    `sha256-${"1".repeat(64)}`,
    reviewed.revision,
  );
  const selected = await catalog.selectCandidate("dev.example.extension", `sha256-${"1".repeat(64)}`, requested.revision);
  assert.deepEqual(selected.extensions[0]?.capabilityGrants.map(({ capability, granted, manifestVersion, realm }) => ({ capability, granted, manifestVersion, realm })), [{
    capability: "workspace.files",
    granted: false,
    manifestVersion: "2.0.0",
    realm: "host",
  }]);

  const unchanged = await catalog.stageCandidate({
    integrity: `sha256-${"2".repeat(64)}`,
    manifest: { ...candidateManifest, version: "3.0.0" },
    preparedAt: "2026-08-14T00:02:00.000Z",
    resolvedPath: "C:/extensions/dev.example.extension/3.0.0",
    resolvedVersion: "3.0.0",
    source: { kind: "npm", specifier: "npm:dev.example.extension", display: "npm:dev.example.extension" },
  }, selected.revision);
  assert.equal(unchanged.extensions[0]?.candidate?.capabilitiesReviewed, true);
  assert.equal(unchanged.extensions[0]?.candidate?.applyRequested, false);
  assert.equal(unchanged.extensions[0]?.candidate?.capabilityGrants[0]?.manifestVersion, "3.0.0");
});
