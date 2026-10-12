import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import type {
  VarinApplicationSurface,
  VarinExtensionActualState,
  VarinExtensionAssetPayload,
  VarinExtensionCatalogEntry,
  VarinExtensionCatalogSnapshot,
  VarinExtensionManagedEntrypointPayload,
  VarinExtensionManifest,
  VarinExtensionHostStateSnapshot,
  VarinExtensionStaticContribution,
} from "@varin/extension-contract";
import { SurfaceCapabilityRegistry, SurfaceExtensionRuntime } from "@varin/extension-surface";
import {
  browserIsolatedSurfaceRealmFactory,
  evaluateManagedSurfaceModule,
  SurfaceExtensionLoader,
  type ManagedStyleHost,
  type IsolatedSurfaceRealmFactory,
} from "../src/index.js";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const hostId = "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a";
const realmId = "window-test";

const integrityFor = (value: string): string => `sha256-${createHash("sha256").update(value).digest("hex")}`;

const asset = (value: string, artifactIntegrity: string, path: string, contentType = "text/javascript; charset=utf-8"): VarinExtensionAssetPayload => ({
  artifactIntegrity,
  bytesBase64: Buffer.from(value).toString("base64"),
  contentType,
  integrity: integrityFor(value),
  path,
});

const manifest = (version: string): VarinExtensionManifest => ({
  schemaVersion: 1,
  id: "dev.example.managed",
  version,
  engines: { varin: "*" },
  entrypoints: {
    surfaces: [{ id: "main", file: "surface.js", mode: "managed", supports: ["web"] }],
  },
});

const catalogEntry = (version: string, artifactIntegrity: string): VarinExtensionCatalogEntry => ({
  actual: [],
  capabilityGrants: [],
  desired: { enabled: true, revision: 1, updatedAt: "2026-08-14T00:00:00.000Z" },
  installedAt: "2026-08-14T00:00:00.000Z",
  integrity: artifactIntegrity,
  manifest: manifest(version),
  resolvedVersion: version,
  selectedVersion: version,
  source: { display: "Test", kind: "local" },
  updatedAt: "2026-08-14T00:00:00.000Z",
});

const snapshot = (
  revision: number,
  entry: VarinExtensionCatalogEntry,
  applicationHostId = hostId,
): VarinExtensionCatalogSnapshot => ({
  authoritative: true,
  diagnostics: [],
  extensions: [entry],
  hostId: applicationHostId,
  loadedAt: "2026-08-14T00:00:00.000Z",
  revision,
  schemaVersion: 1,
  storageState: "ready",
});

const hostState = (
  catalog: VarinExtensionCatalogSnapshot,
  revision = catalog.revision,
  providers: VarinExtensionHostStateSnapshot['services']['providers'] = [],
  selections: Record<string, string> = {},
): VarinExtensionHostStateSnapshot => ({
  catalog,
  revision,
  routing: {
    authoritative: true,
    diagnostics: [],
    document: { revision: 0, rules: [], schemaVersion: 1, updatedAt: '1970-01-01T00:00:00.000Z' },
    hostId: catalog.hostId,
    storageState: 'missing',
  },
  services: { hostId: catalog.hostId, providers, revision, selections },
  workbench: {
    authoritative: true,
    diagnostics: [],
    document: {
      activeProfileId: 'default', layouts: [], profileSelections: { users: {} },
      profiles: [{ id: 'default', label: 'Default' }], revision: 0, schemaVersion: 1,
      updatedAt: '1970-01-01T00:00:00.000Z',
    },
    hostId: catalog.hostId,
    storageState: 'missing',
  },
});

for (const surface of ["web", "desktop", "mobile"] as const satisfies readonly VarinApplicationSurface[]) {
  test(`pure declarative ${surface} lifecycle registers without module bytes and withdraws on disable`, async () => {
    const artifactIntegrity = integrityFor(`declarative-${surface}`);
    const declarativeManifest: VarinExtensionManifest = {
      schemaVersion: 1,
      id: "dev.example.declarative",
      version: "1.0.0",
      engines: { varin: "*" },
      entrypoints: {
        surfaces: [
          { id: "declarative", mode: "declarative", supports: [surface] },
          { id: "empty", mode: "declarative", supports: [surface] },
        ],
      },
      contributions: [
        {
          contractVersion: 1,
          data: { label: `Manifest ${surface}` },
          id: "dev.example.declarative.manifest-page",
          kind: "page",
          supports: [surface],
        },
        {
          contractVersion: 1,
          data: { label: `Entrypoint ${surface}` },
          entrypoint: "declarative",
          id: "dev.example.declarative.entrypoint-status",
          kind: "status-item",
          supports: [surface],
        },
      ],
    };
    let current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: declarativeManifest });
    let assetReads = 0;
    let entrypointReads = 0;
    let evaluations = 0;
    const reported: VarinExtensionActualState[] = [];
    const runtime = new SurfaceExtensionRuntime({ surface });
    const loader = new SurfaceExtensionLoader({
      evaluateModule: () => {
        evaluations += 1;
        throw new Error("declarative Surface must not evaluate a module");
      },
      host: {
        activateExtension: async () => undefined,
        catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
        discardPreparedCandidate: async () => undefined,
        hostState: async () => hostState(current),
        invokeService: async () => { throw new Error("unexpected service invocation"); },
        prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
        requestCandidateApplication: async () => current,
        readAsset: async () => {
          assetReads += 1;
          throw new Error("declarative Surface must not read an asset");
        },
        readManagedEntrypoint: async () => {
          entrypointReads += 1;
          throw new Error("declarative Surface must not read module bytes");
        },
        reportActualState: async (_extensionId, state) => { reported.push(state); },
        selectCandidate: async () => current,
        waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
      },
      realmId,
      surface,
      surfaceRuntime: runtime,
    });

    await loader.reconcile();
    const visible = runtime.getSnapshot().visibleContributions;
    assert.deepEqual(visible.map((item) => item.descriptor.id), [
      "dev.example.declarative.entrypoint-status",
      "dev.example.declarative.manifest-page",
    ]);
    const manifestImplementation = visible.find((item) => item.descriptor.id.endsWith("manifest-page"))?.implementation as {
      descriptor: VarinExtensionStaticContribution;
      kind: string;
    };
    assert.equal(manifestImplementation.kind, "declarative");
    assert.deepEqual(manifestImplementation.descriptor.data, { label: `Manifest ${surface}` });
    assert.deepEqual(runtime.getSnapshot().actual.map((state) => state.entrypointId), [
      "dev.example.declarative.manifest",
    ]);
    assert.equal(runtime.getSnapshot().actual.every((state) => state.status === "active"), true);
    assert.equal(assetReads, 0);
    assert.equal(entrypointReads, 0);
    assert.equal(evaluations, 0);

    current = snapshot(2, {
      ...current.extensions[0] as VarinExtensionCatalogEntry,
      desired: { enabled: false, revision: 2, updatedAt: "2026-08-14T00:01:00.000Z" },
    });
    await loader.reconcile();
    assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
    assert.equal(loader.getSnapshot().active.length, 0);
    assert.equal(reported.some((state) => state.entrypointId === "dev.example.declarative.manifest" && state.status === "active"), true);
    assert.equal(reported.some((state) => state.entrypointId === "dev.example.declarative.manifest" && state.status === "inactive"), true);
    assert.equal(assetReads, 0);
    assert.equal(entrypointReads, 0);
    assert.equal(evaluations, 0);
  });
}

test("manifest and managed contributions publish as one Surface generation", async () => {
  const artifactIntegrity = integrityFor("mixed-artifact");
  const mixedManifest: VarinExtensionManifest = {
    ...manifest("1.0.0"),
    contributions: [{
      contractVersion: 1,
      data: { source: "manifest" },
      entrypoint: "main",
      id: "dev.example.managed.manifest-page",
      kind: "page",
      supports: ["web"],
    }],
  };
  const current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: mixedManifest });
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const observed: string[][] = [];
  runtime.subscribe(() => observed.push(runtime.getSnapshot().visibleContributions.map((item) => item.descriptor.id).sort()));
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => ({
      default: {
        activate: (context) => context.contribute({
          contractVersion: 1,
          data: { source: "module" },
          id: "dev.example.managed.module-page",
          kind: "page",
          supports: ["web"],
        }, { kind: "managed-test" }),
      },
    }),
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset("mixed", request.integrity, "runtime/surface/main/module.cjs"),
        styles: [],
      }),
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.descriptor.id), [
    "dev.example.managed.manifest-page",
    "dev.example.managed.module-page",
  ]);
  assert.equal(observed.some((ids) => ids.length === 1), false);
  const owners = runtime.getSnapshot().visibleContributions.map((item) => item.owner);
  assert.equal(owners[0]?.entrypointId, "main");
  assert.equal(owners[0]?.generation, owners[1]?.generation);
});

test("eager entrypoint with only incompatible contributions does not execute its module", async () => {
  const artifactIntegrity = integrityFor("incompatible-only");
  const incompatibleManifest: VarinExtensionManifest = {
    schemaVersion: 1,
    id: "dev.example.incompatible-only",
    version: "1.0.0",
    engines: { varin: "*" },
    entrypoints: {
      surfaces: [{ id: "main", file: "surface.js", mode: "managed", supports: ["web"] }],
    },
    contributions: [
      // Both contributions target the eager "main" entrypoint but use contractVersion 99
      { contractVersion: 99, data: {}, entrypoint: "main", id: "dev.example.incompatible-only.page", kind: "page", supports: ["web"] },
      { contractVersion: 99, data: {}, entrypoint: "main", id: "dev.example.incompatible-only.command", kind: "command", supports: ["web"] },
    ],
  };
  const current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: incompatibleManifest });
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  let evaluations = 0;
  let entrypointReads = 0;
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => {
      evaluations += 1;
      throw new Error("incompatible-only entrypoint must not evaluate a module");
    },
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async () => {
        entrypointReads += 1;
        throw new Error("incompatible-only entrypoint must not read module bytes");
      },
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });
  await loader.reconcile();
  // No visible contributions — both were incompatible
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  // No active entrypoints — the eager plan was skipped
  assert.equal(loader.getSnapshot().active.length, 0);
  // Module was never evaluated or read
  assert.equal(evaluations, 0);
  assert.equal(entrypointReads, 0);
  assert.deepEqual(
    loader.getSnapshot().diagnostics.map((item) => ({ code: item.code, entrypointId: item.entrypointId })),
    [
      { code: "unsupported-contract-version", entrypointId: "main" },
      { code: "unsupported-contract-version", entrypointId: "main" },
    ],
  );
  assert.match(loader.getSnapshot().diagnostics[0]?.message ?? "", /page contract version 99/);
});

test("lazy Surface entrypoints index declarative contributions and activate once per real event", async () => {
  const artifactIntegrity = integrityFor("lazy-events");
  const lazyManifest: VarinExtensionManifest = {
    schemaVersion: 1,
    id: "dev.example.lazy",
    version: "1.0.0",
    engines: { varin: "*" },
    entrypoints: {
      surfaces: [
        { activation: ["command"], file: "command.js", id: "command", mode: "managed", supports: ["web"] },
        { activation: ["contribution-visible"], file: "visible.js", id: "visible", mode: "managed", supports: ["web"] },
        { activation: ["workspace-match"], file: "workspace.js", id: "workspace", mode: "managed", supports: ["web"] },
        { activation: ["service-request"], file: "service.js", id: "service", mode: "managed", supports: ["web"] },
      ],
    },
    contributions: [
      { contractVersion: 1, data: {}, entrypoint: "command", id: "dev.example.lazy.command", kind: "command", supports: ["web"] },
      { contractVersion: 1, data: {}, entrypoint: "command", id: "dev.example.lazy.command-fallback", kind: "status-item", supports: ["web"] },
      { contractVersion: 1, data: {}, entrypoint: "visible", id: "dev.example.lazy.visible", kind: "page", supports: ["web"] },
      { contractVersion: 1, data: {}, entrypoint: "workspace", id: "dev.example.lazy.workspace", kind: "panel", supports: ["web"] },
    ],
  };
  let current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: lazyManifest });
  const reads = new Map<string, number>();
  const executions = new Map<string, number>();
  let hostActivations = 0;
  const reported: VarinExtensionActualState[] = [];
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: (source) => ({
      default: {
        activate: (context) => {
          executions.set(source, (executions.get(source) ?? 0) + 1);
          if (source !== "service") {
            context.contribute({
              contractVersion: 1,
              data: {},
              id: `dev.example.lazy.${source}`,
              kind: source === "command" ? "command" : source === "visible" ? "page" : "panel",
              supports: ["web"],
            }, { dynamic: source });
          }
        },
      },
    }),
    host: {
      activateExtension: async () => { hostActivations += 1; },
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => {
        reads.set(request.entrypointId, (reads.get(request.entrypointId) ?? 0) + 1);
        return {
          artifactIntegrity: request.integrity,
          entrypointId: request.entrypointId,
          module: asset(request.entrypointId, request.integrity, `runtime/surface/${request.entrypointId}/module.cjs`),
          styles: [],
        };
      },
      reportActualState: async (_extensionId, state) => { reported.push(state); },
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.deepEqual(runtime.getSnapshot().visibleContributions.map((item) => item.descriptor.id), [
    "dev.example.lazy.command",
    "dev.example.lazy.command-fallback",
    "dev.example.lazy.visible",
    "dev.example.lazy.workspace",
  ]);
  assert.equal(runtime.getSnapshot().visibleContributions.every((item) => (
    (item.implementation as { kind?: string }).kind === "declarative"
  )), true);
  assert.equal(reads.size, 0);
  assert.equal(executions.size, 0);
  assert.equal(hostActivations, 0);
  assert.equal(loader.getSnapshot().active.length, 0);
  assert.equal(reported.filter((state) => ["command", "visible", "workspace", "service"].includes(state.entrypointId))
    .every((state) => state.status === "inactive"), true);

  await loader.triggerActivation("command", { contributionId: "dev.example.lazy.command", extensionId: "dev.example.lazy" });
  await loader.triggerActivation("command", { contributionId: "dev.example.lazy.command", extensionId: "dev.example.lazy" });
  assert.equal(reads.get("command"), 1);
  assert.equal(executions.get("command"), 1);
  assert.deepEqual(runtime.getSnapshot().visibleContributions.find((item) => item.descriptor.id === "dev.example.lazy.command")?.implementation, { dynamic: "command" });
  assert.equal((runtime.getSnapshot().visibleContributions.find((item) => item.descriptor.id === "dev.example.lazy.command-fallback")?.implementation as { kind?: string }).kind, "declarative");

  await loader.triggerActivation("contribution-visible", { contributionId: "dev.example.lazy.visible" });
  await loader.triggerActivation("workspace-match", { entrypointId: "workspace", extensionId: "dev.example.lazy" });
  await loader.triggerActivation("service-request", { entrypointId: "service", extensionId: "dev.example.lazy" });
  await loader.triggerActivation("service-request", { entrypointId: "service", extensionId: "dev.example.lazy" });
  assert.deepEqual(Object.fromEntries(reads), { command: 1, service: 1, visible: 1, workspace: 1 });
  assert.deepEqual(Object.fromEntries(executions), { command: 1, service: 1, visible: 1, workspace: 1 });
  assert.equal(hostActivations, 4);

  current = snapshot(2, {
    ...current.extensions[0] as VarinExtensionCatalogEntry,
    desired: { enabled: false, revision: 2, updatedAt: "2026-08-14T00:01:00.000Z" },
  });
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  current = snapshot(3, {
    ...current.extensions[0] as VarinExtensionCatalogEntry,
    desired: { enabled: true, revision: 3, updatedAt: "2026-08-14T00:02:00.000Z" },
  });
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 4);
  assert.deepEqual(Object.fromEntries(reads), { command: 1, service: 1, visible: 1, workspace: 1 });
  assert.equal(hostActivations, 4);
  assert.equal(runtime.getSnapshot().actual.find((state) => state.entrypointId === "command")?.status, "inactive");

  await loader.triggerActivation("command", { contributionId: "dev.example.lazy.command" });
  assert.equal(reads.get("command"), 2);
  assert.equal(executions.get("command"), 2);
});

test("declarative owner is replaced across an application-host switch", async () => {
  const artifactIntegrity = integrityFor("host-switch-declarative");
  const secondHostId = "55b455dc-555c-4d67-b82d-d2f94aa4a729";
  const declarativeManifest: VarinExtensionManifest = {
    schemaVersion: 1,
    id: "dev.example.switchable",
    version: "1.0.0",
    engines: { varin: "*" },
    contributions: [{
      contractVersion: 1,
      data: { source: "manifest" },
      id: "dev.example.switchable.page",
      kind: "page",
      supports: ["web"],
    }],
  };
  const entry = { ...catalogEntry("1.0.0", artifactIntegrity), manifest: declarativeManifest };
  let current = snapshot(1, entry);
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => { throw new Error("unexpected module evaluation"); },
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async () => { throw new Error("unexpected entrypoint read"); },
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  const firstOwner = runtime.getSnapshot().visibleContributions[0]?.owner;
  assert.equal(firstOwner?.hostId, hostId);
  current = snapshot(2, entry, secondHostId);
  await loader.reconcile();
  const switched = runtime.getSnapshot().visibleContributions;
  assert.equal(switched.length, 1);
  assert.equal(switched[0]?.owner.hostId, secondHostId);
  assert.ok((switched[0]?.owner.generation ?? 0) > (firstOwner?.generation ?? 0));
  assert.equal(runtime.getSnapshot().actual.find((state) => state.entrypointId === "dev.example.switchable.manifest")?.hostId, secondHostId);
});

test("declarative contributions do not register on an incompatible Surface", async () => {
  const artifactIntegrity = integrityFor("desktop-only-declarative");
  const desktopManifest: VarinExtensionManifest = {
    schemaVersion: 1,
    id: "dev.example.desktop-only",
    version: "1.0.0",
    engines: { varin: "*" },
    entrypoints: { surfaces: [{ id: "desktop", mode: "declarative", supports: ["desktop"] }] },
    contributions: [{
      contractVersion: 1,
      data: {},
      entrypoint: "desktop",
      id: "dev.example.desktop-only.page",
      kind: "page",
      supports: ["desktop"],
    }],
  };
  const current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: desktopManifest });
  let hostActivations = 0;
  let entrypointReads = 0;
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => { throw new Error("unexpected module evaluation"); },
    host: {
      activateExtension: async () => { hostActivations += 1; },
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async () => { entrypointReads += 1; throw new Error("unexpected entrypoint read"); },
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  assert.equal(runtime.getSnapshot().actual.length, 0);
  assert.equal(loader.getSnapshot().active.length, 0);
  assert.equal(hostActivations, 0);
  assert.equal(entrypointReads, 0);
});

test("declarative contributions honor capability availability and required Host services", async () => {
  const artifactIntegrity = integrityFor("declarative-requirements");
  const capabilityId = "dev.example.surface-data";
  const serviceId = "dev.example.declarative-service";
  const requiredManifest: VarinExtensionManifest = {
    schemaVersion: 1,
    id: "dev.example.requirements",
    version: "1.0.0",
    engines: { varin: "*" },
    capabilities: { surface: [capabilityId] },
    requires: { services: [{ id: serviceId, version: 1 }] },
    contributions: [{
      contractVersion: 1,
      data: { source: "manifest" },
      id: "dev.example.requirements.page",
      kind: "page",
      requiresCapabilities: [capabilityId],
      supports: ["web"],
    }],
  };
  const selectedEntry: VarinExtensionCatalogEntry = {
    ...catalogEntry("1.0.0", artifactIntegrity),
    capabilityGrants: [{
      capability: capabilityId,
      granted: true,
      manifestVersion: "1.0.0",
      realm: "surface",
      updatedAt: "2026-08-14T00:00:00.000Z",
    }],
    manifest: requiredManifest,
  };
  const current = snapshot(1, selectedEntry);
  let stateRevision = 1;
  let providers: VarinExtensionHostStateSnapshot["services"]["providers"] = [];
  const capabilities = new SurfaceCapabilityRegistry();
  const unregisterCapability = capabilities.register({
    exposure: "remote-safe",
    id: capabilityId,
    supports: ["web"],
  }, async () => null);
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    capabilities,
    evaluateModule: () => { throw new Error("unexpected module evaluation"); },
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current, stateRevision, providers),
      invokeService: async () => null,
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async () => { throw new Error("unexpected entrypoint read"); },
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  assert.equal(runtime.getSnapshot().actual[0]?.status, "failed");

  providers = [{
    descriptor: { id: serviceId, version: 1 },
    entrypointId: "host",
    extensionId: "dev.example.provider",
    extensionVersion: "1.0.0",
    generation: 1,
    providerId: `dev.example.provider:host:1:${serviceId}@1`,
    providerKey: `dev.example.provider:host:${serviceId}@1`,
    status: "active",
  }];
  stateRevision += 1;
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 1);

  unregisterCapability();
  stateRevision += 1;
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  assert.equal(loader.getSnapshot().diagnostics.some((item) => item.code === "required_surface_capability_withdrawn"), true);
});

const serviceManifest = (binding: "single" | "selected" | "all"): VarinExtensionManifest => ({
  schemaVersion: 1,
  id: `dev.example.binding-${binding}`,
  version: "1.0.0",
  engines: { varin: "*" },
  requires: { services: [{ id: "dev.example.matrix-service", version: 1, binding }] },
  entrypoints: {
    surfaces: [{ id: "main", file: "surface.js", mode: "managed", supports: ["web"] }],
  },
  contributions: [{
    contractVersion: 1,
    data: {},
    entrypoint: "main",
    id: `dev.example.binding-${binding}.page`,
    kind: "page",
    supports: ["web"],
  }],
});

const matrixProvider = (providerId: string): VarinExtensionHostStateSnapshot["services"]["providers"][number] => ({
  descriptor: { id: "dev.example.matrix-service", version: 1 },
  entrypointId: "host",
  extensionId: `dev.example.provider-${providerId}`,
  extensionVersion: "1.0.0",
  generation: 1,
  providerId: `dev.example.provider-${providerId}:host:1:dev.example.matrix-service@1`,
  providerKey: `dev.example.provider-${providerId}:host:dev.example.matrix-service@1`,
  status: "active",
});

test("service binding matrix: single requires exactly one provider", async () => {
  const artifactIntegrity = integrityFor("binding-single");
  const entry: VarinExtensionCatalogEntry = { ...catalogEntry("1.0.0", artifactIntegrity), manifest: serviceManifest("single") };
  const current = snapshot(1, entry);
  let stateRevision = 1;
  let providers: VarinExtensionHostStateSnapshot["services"]["providers"] = [];
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => ({ default: { activate: (ctx: { contribute: (d: VarinExtensionStaticContribution, impl: unknown) => void }) => ctx.contribute({
      contractVersion: 1, data: {}, entrypoint: "main", id: "dev.example.binding-single.page", kind: "page", supports: ["web"],
    }, {}) } }),
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current, stateRevision, providers),
      invokeService: async () => null,
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({ artifactIntegrity: request.integrity, entrypointId: request.entrypointId, module: asset("main", request.integrity, "runtime/surface/main/module.cjs"), styles: [] }),
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  // Zero providers — single binding should NOT activate
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);

  // One provider — single binding should activate
  providers = [matrixProvider("a")];
  stateRevision += 1;
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 1);

  // Two providers — single binding should withdraw (count !== 1)
  providers = [matrixProvider("a"), matrixProvider("b")];
  stateRevision += 1;
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
});

test("service binding matrix: selected requires and resolves the explicit provider", async () => {
  const artifactIntegrity = integrityFor("binding-selected");
  const entry: VarinExtensionCatalogEntry = { ...catalogEntry("1.0.0", artifactIntegrity), manifest: serviceManifest("selected") };
  const current = snapshot(1, entry);
  let stateRevision = 1;
  let providers: VarinExtensionHostStateSnapshot["services"]["providers"] = [];
  let selections: Record<string, string> = {};
  const resolvedProviders: string[] = [];
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => ({ default: { activate: async (ctx: {
      contribute: (d: VarinExtensionStaticContribution, impl: unknown) => void;
      useService<T>(id: string, version: number): T | undefined;
    }) => {
      const service = ctx.useService<{ provider(): Promise<string> }>("dev.example.matrix-service", 1);
      assert.ok(service);
      resolvedProviders.push(await service.provider());
      ctx.contribute({
        contractVersion: 1, data: {}, entrypoint: "main", id: "dev.example.binding-selected.page", kind: "page", supports: ["web"],
      }, {});
    } } }),
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current, stateRevision, providers, selections),
      invokeService: async (request) => request.providerId ?? "missing",
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({ artifactIntegrity: request.integrity, entrypointId: request.entrypointId, module: asset("main", request.integrity, "runtime/surface/main/module.cjs"), styles: [] }),
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  // Zero providers — selected should NOT activate
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);

  // One provider without a selection remains unsatisfied.
  providers = [matrixProvider("a")];
  stateRevision += 1;
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);

  // An explicit provider selection activates and resolves that exact provider.
  selections = { "dev.example.matrix-service@1": matrixProvider("a").providerId };
  stateRevision += 1;
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 1);
  assert.deepEqual(resolvedProviders, [matrixProvider("a").providerId]);

  // Changing the explicit selection rebinds to the chosen provider.
  providers = [matrixProvider("a"), matrixProvider("b")];
  selections = { "dev.example.matrix-service@1": matrixProvider("b").providerId };
  stateRevision += 1;
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 1);
  assert.deepEqual(resolvedProviders, [matrixProvider("a").providerId, matrixProvider("b").providerId]);

  // A stale selection withdraws the dependent instead of binding an arbitrary provider.
  selections = { "dev.example.matrix-service@1": "dev.example.provider-missing:host:1:dev.example.matrix-service@1" };
  stateRevision += 1;
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
});

test("service binding matrix: all activates with at least one provider", async () => {
  const artifactIntegrity = integrityFor("binding-all");
  const entry: VarinExtensionCatalogEntry = { ...catalogEntry("1.0.0", artifactIntegrity), manifest: serviceManifest("all") };
  const current = snapshot(1, entry);
  let stateRevision = 1;
  let providers: VarinExtensionHostStateSnapshot["services"]["providers"] = [];
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => ({ default: { activate: (ctx: { contribute: (d: VarinExtensionStaticContribution, impl: unknown) => void }) => ctx.contribute({
      contractVersion: 1, data: {}, entrypoint: "main", id: "dev.example.binding-all.page", kind: "page", supports: ["web"],
    }, {}) } }),
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current, stateRevision, providers),
      invokeService: async () => null,
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({ artifactIntegrity: request.integrity, entrypointId: request.entrypointId, module: asset("main", request.integrity, "runtime/surface/main/module.cjs"), styles: [] }),
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  // Zero providers — all should NOT activate
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);

  // One provider — all should activate
  providers = [matrixProvider("a")];
  stateRevision += 1;
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 1);

  // Two providers — all should still activate
  providers = [matrixProvider("a"), matrixProvider("b")];
  stateRevision += 1;
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 1);
});

test("evaluates a self-contained CommonJS managed module without a module URL", async () => {
  const loaded = await evaluateManagedSurfaceModule(
    "module.exports={default:{activate(){return 'active'}}};",
    { entrypointId: "main", extensionId: "dev.example.managed", integrity: integrityFor("module") },
  );
  assert.equal(typeof (loaded.default as { activate?: unknown })?.activate, "function");
});

test("managed candidate activation, rollback, style ownership, and disable are refresh-free", async () => {
  const v1Integrity = integrityFor("artifact-v1");
  const failedIntegrity = integrityFor("artifact-failed");
  const v3Integrity = integrityFor("artifact-v3");
  const manifestWithStatic = (version: string, release: string): VarinExtensionManifest => ({
    ...manifest(version),
    contributions: [{
      contractVersion: 1,
      data: { release },
      id: "dev.example.managed.static-page",
      kind: "page",
      supports: ["web"],
    }],
  });
  let current = snapshot(1, {
    ...catalogEntry("1.0.0", v1Integrity),
    manifest: manifestWithStatic("1.0.0", "v1"),
  });
  const code = new Map([[v1Integrity, "v1"], [failedIntegrity, "fail"], [v3Integrity, "v3"]]);
  const reported: VarinExtensionActualState[] = [];
  let selections = 0;
  let committedStyles = 0;
  const styleHost: ManagedStyleHost = {
    stage: () => {
      let committed = false;
      return {
        commit: () => {
          if (!committed) committedStyles += 1;
          committed = true;
        },
        dispose: () => {
          if (committed) committedStyles -= 1;
          committed = false;
        },
      };
    },
  };
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: (source) => ({
      default: {
        activate: (context) => {
          if (source === "fail") throw new Error("candidate module failed");
          context.contribute({
            contractVersion: 1,
            data: {},
            id: "dev.example.managed.page",
            kind: "page",
            supports: ["web"],
          }, { version: source });
        },
      },
    }),
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async (request) => {
        const entry = current.extensions[0] as VarinExtensionCatalogEntry;
        assert.equal(entry.candidate?.integrity, request.candidateIntegrity);
        const candidate = entry.candidate;
        assert.ok(candidate);
        current = snapshot(current.revision + 1, {
          ...entry,
          candidate: { ...candidate, applyRequested: true },
        });
        return current;
      },
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request): Promise<VarinExtensionManagedEntrypointPayload> => {
        const source = code.get(request.integrity);
        if (!source) throw new Error("unknown artifact");
        return {
          artifactIntegrity: request.integrity,
          entrypointId: request.entrypointId,
          module: asset(source, request.integrity, "runtime/surface/main/module.cjs"),
          styles: [asset(".managed {}", request.integrity, "runtime/surface/main/module.css", "text/css; charset=utf-8")],
        };
      },
      reportActualState: async (_extensionId, state) => { reported.push(state); },
      selectCandidate: async (request) => {
        selections += 1;
        const entry = current.extensions[0] as VarinExtensionCatalogEntry;
        assert.equal(entry.candidate?.integrity, request.candidateIntegrity);
        const candidate = entry.candidate;
        if (!candidate) throw new Error("candidate disappeared");
        const { candidate: _candidate, ...selectedEntry } = entry;
        void _candidate;
        current = snapshot(current.revision + 1, {
          ...selectedEntry,
          integrity: candidate.integrity,
          manifest: candidate.manifest,
          resolvedVersion: candidate.resolvedVersion,
          selectedVersion: candidate.resolvedVersion,
          source: candidate.source,
        });
        return current;
      },
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    styleHost,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  const dynamicContribution = () => runtime.getSnapshot().visibleContributions
    .find((item) => item.descriptor.id === "dev.example.managed.page");
  const staticContribution = () => runtime.getSnapshot().visibleContributions
    .find((item) => item.descriptor.id === "dev.example.managed.static-page");
  assert.equal((dynamicContribution()?.implementation as { version: string }).version, "v1");
  assert.deepEqual((staticContribution()?.implementation as { descriptor: VarinExtensionStaticContribution }).descriptor.data, { release: "v1" });
  const selectedStaticGeneration = staticContribution()?.owner.generation;
  assert.equal(committedStyles, 1);

  current = snapshot(2, {
    ...current.extensions[0] as VarinExtensionCatalogEntry,
    candidate: {
      applyRequested: false,
      capabilitiesReviewed: true,
      capabilityDelta: { added: [], removed: [] },
      capabilityGrants: [],
      integrity: failedIntegrity,
      manifest: manifestWithStatic("2.0.0", "failed"),
      preparedAt: "2026-08-14T00:01:00.000Z",
      resolvedVersion: "2.0.0",
      source: { display: "Test", kind: "local" },
    },
  });
  await loader.reconcile();
  assert.equal((dynamicContribution()?.implementation as { version: string }).version, "v1");
  assert.deepEqual((staticContribution()?.implementation as { descriptor: VarinExtensionStaticContribution }).descriptor.data, { release: "v1" });
  assert.equal(selections, 0);
  assert.equal(committedStyles, 1);
  await assert.rejects(
    () => loader.applyCandidate("dev.example.managed", failedIntegrity, current.revision),
    /candidate module failed/,
  );
  assert.equal((dynamicContribution()?.implementation as { version: string }).version, "v1");
  assert.deepEqual((staticContribution()?.implementation as { descriptor: VarinExtensionStaticContribution }).descriptor.data, { release: "v1" });
  assert.equal(staticContribution()?.owner.generation, selectedStaticGeneration);
  assert.equal(current.extensions[0]?.selectedVersion, "1.0.0");
  assert.equal(selections, 0);
  assert.equal(committedStyles, 1);

  current = snapshot(3, {
    ...current.extensions[0] as VarinExtensionCatalogEntry,
    candidate: {
      applyRequested: false,
      capabilitiesReviewed: true,
      capabilityDelta: { added: [], removed: [] },
      capabilityGrants: [],
      integrity: v3Integrity,
      manifest: manifest("3.0.0"),
      preparedAt: "2026-08-14T00:02:00.000Z",
      resolvedVersion: "3.0.0",
      source: { display: "Test", kind: "local" },
    },
  });
  await loader.reconcile();
  assert.equal((dynamicContribution()?.implementation as { version: string }).version, "v1");
  assert.equal(selections, 0);
  await loader.applyCandidate("dev.example.managed", v3Integrity, current.revision);
  assert.equal((dynamicContribution()?.implementation as { version: string }).version, "v3");
  assert.equal(staticContribution(), undefined);
  assert.equal(selections, 1);
  assert.equal(committedStyles, 1);

  current = snapshot(current.revision + 1, {
    ...current.extensions[0] as VarinExtensionCatalogEntry,
    desired: { enabled: false, revision: 2, updatedAt: "2026-08-14T00:03:00.000Z" },
  });
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
  assert.equal(committedStyles, 0);
  assert.equal(reported.some((state) => state.status === "active"), true);
  assert.equal(reported.some((state) => state.status === "inactive"), true);
});

test("lazy candidates stay unread until triggered and a triggered candidate failure preserves the old generation", async () => {
  const v1Integrity = integrityFor("lazy-candidate-v1");
  const v2Integrity = integrityFor("lazy-candidate-v2");
  const failedIntegrity = integrityFor("lazy-candidate-failed");
  const lazyCandidateManifest = (version: string, release: string): VarinExtensionManifest => ({
    schemaVersion: 1,
    id: "dev.example.lazy-candidate",
    version,
    engines: { varin: "*" },
    entrypoints: {
      surfaces: [{ activation: ["command"], file: "surface.js", id: "main", mode: "managed", supports: ["web"] }],
    },
    contributions: [{
      contractVersion: 1,
      data: { release },
      entrypoint: "main",
      id: "dev.example.lazy-candidate.command",
      kind: "command",
      supports: ["web"],
    }],
  });
  let current = snapshot(1, {
    ...catalogEntry("1.0.0", v1Integrity),
    manifest: lazyCandidateManifest("1.0.0", "v1"),
  });
  const reads: string[] = [];
  const evaluations: string[] = [];
  let hostActivations = 0;
  let selections = 0;
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: (source) => {
      evaluations.push(source);
      if (source === "failed") throw new Error("lazy candidate failed");
      return {
        default: {
          activate: (context) => context.contribute({
            contractVersion: 1,
            data: { release: source },
            id: "dev.example.lazy-candidate.command",
            kind: "command",
            supports: ["web"],
          }, { release: source }),
        },
      };
    },
    host: {
      activateExtension: async () => { hostActivations += 1; },
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async (request) => {
        const entry = current.extensions[0] as VarinExtensionCatalogEntry;
        assert.equal(entry.candidate?.integrity, request.candidateIntegrity);
        current = snapshot(current.revision + 1, {
          ...entry,
          candidate: { ...entry.candidate as NonNullable<VarinExtensionCatalogEntry["candidate"]>, applyRequested: true },
        });
        return current;
      },
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => {
        reads.push(request.integrity);
        const source = request.integrity === v2Integrity ? "v2" : request.integrity === failedIntegrity ? "failed" : "v1";
        return {
          artifactIntegrity: request.integrity,
          entrypointId: request.entrypointId,
          module: asset(source, request.integrity, "runtime/surface/main/module.cjs"),
          styles: [],
        };
      },
      reportActualState: async () => undefined,
      selectCandidate: async (request) => {
        selections += 1;
        const entry = current.extensions[0] as VarinExtensionCatalogEntry;
        const candidate = entry.candidate;
        if (!candidate || candidate.integrity !== request.candidateIntegrity) throw new Error("candidate disappeared");
        const { candidate: _candidate, ...selectedEntry } = entry;
        void _candidate;
        current = snapshot(current.revision + 1, {
          ...selectedEntry,
          integrity: candidate.integrity,
          manifest: candidate.manifest,
          resolvedVersion: candidate.resolvedVersion,
          selectedVersion: candidate.resolvedVersion,
          source: candidate.source,
        });
        return current;
      },
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  const implementation = () => runtime.getSnapshot().visibleContributions.find((item) => (
    item.descriptor.id === "dev.example.lazy-candidate.command"
  ))?.implementation;
  await loader.reconcile();
  assert.equal((implementation() as { kind?: string }).kind, "declarative");
  assert.deepEqual(reads, []);
  assert.deepEqual(evaluations, []);
  assert.equal(hostActivations, 0);

  current = snapshot(2, {
    ...current.extensions[0] as VarinExtensionCatalogEntry,
    candidate: {
      applyRequested: false,
      capabilitiesReviewed: true,
      capabilityDelta: { added: [], removed: [] },
      capabilityGrants: [],
      integrity: v2Integrity,
      manifest: lazyCandidateManifest("2.0.0", "v2"),
      preparedAt: "2026-08-14T00:01:00.000Z",
      resolvedVersion: "2.0.0",
      source: { display: "Test", kind: "local" },
    },
  });
  await loader.applyCandidate("dev.example.lazy-candidate", v2Integrity, current.revision);
  assert.deepEqual(reads, []);
  assert.deepEqual(evaluations, []);
  assert.equal(current.extensions[0]?.selectedVersion, "2.0.0");
  assert.deepEqual((implementation() as { descriptor: VarinExtensionStaticContribution }).descriptor.data, { release: "v2" });

  await loader.triggerActivation("command", { contributionId: "dev.example.lazy-candidate.command" });
  assert.deepEqual(reads, [v2Integrity]);
  assert.deepEqual(evaluations, ["v2"]);
  assert.deepEqual(implementation(), { release: "v2" });
  assert.equal(hostActivations, 1);

  current = snapshot(current.revision + 1, {
    ...current.extensions[0] as VarinExtensionCatalogEntry,
    candidate: {
      applyRequested: false,
      capabilitiesReviewed: true,
      capabilityDelta: { added: [], removed: [] },
      capabilityGrants: [],
      integrity: failedIntegrity,
      manifest: lazyCandidateManifest("3.0.0", "failed"),
      preparedAt: "2026-08-14T00:02:00.000Z",
      resolvedVersion: "3.0.0",
      source: { display: "Test", kind: "local" },
    },
  });
  await assert.rejects(
    () => loader.applyCandidate("dev.example.lazy-candidate", failedIntegrity, current.revision),
    /lazy candidate failed/,
  );
  assert.deepEqual(implementation(), { release: "v2" });
  assert.equal(current.extensions[0]?.selectedVersion, "2.0.0");
  assert.deepEqual(reads, [v2Integrity, failedIntegrity]);
  assert.deepEqual(evaluations, ["v2", "failed"]);
  assert.equal(selections, 1);
});

test("candidate code does not execute before added capabilities are reviewed", async () => {
  const selectedIntegrity = integrityFor("review-selected");
  const candidateIntegrity = integrityFor("review-candidate");
  const candidateManifest: VarinExtensionManifest = {
    ...manifest("2.0.0"),
    capabilities: { surface: ["desktop.files"] },
  };
  const entry: VarinExtensionCatalogEntry = {
    ...catalogEntry("1.0.0", selectedIntegrity),
    candidate: {
      applyRequested: false,
      capabilitiesReviewed: false,
      capabilityDelta: { added: [{ capability: "desktop.files", realm: "surface" }], removed: [] },
      capabilityGrants: [],
      integrity: candidateIntegrity,
      manifest: candidateManifest,
      preparedAt: "2026-08-14T00:01:00.000Z",
      resolvedVersion: "2.0.0",
      source: { display: "Test", kind: "local" },
    },
  };
  const current = snapshot(2, entry);
  const evaluated: string[] = [];
  let prepared = 0;
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: (source) => {
      evaluated.push(source);
      return { default: { activate: () => undefined } };
    },
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => { prepared += 1; return { extensionId, integrity, providers: [] }; },
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset(request.integrity === selectedIntegrity ? "selected" : "candidate", request.integrity, "runtime/surface/main/module.cjs"),
        styles: [],
      }),
      reportActualState: async () => undefined,
      selectCandidate: async () => { throw new Error("candidate must not be selected"); },
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.deepEqual(evaluated, ["selected"]);
  assert.equal(prepared, 0);
});

test("withdrawn Host services tear down dependent Surface owners", async () => {
  const artifactIntegrity = integrityFor("service-artifact");
  const serviceManifest: VarinExtensionManifest = {
    ...manifest("1.0.0"),
    requires: { services: [{ id: "dev.example.host-service", version: 1 }] },
  };
  let current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: serviceManifest });
  let stateRevision = 1;
  let providers = [{
    descriptor: { id: "dev.example.host-service", version: 1 },
    entrypointId: "host",
    extensionId: "dev.example.provider",
    extensionVersion: "1.0.0",
    generation: 1,
    providerId: "dev.example.provider:host:1:dev.example.host-service@1",
    providerKey: "dev.example.provider:host:dev.example.host-service@1",
    status: "active" as const,
  }];
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => ({
      default: {
        activate: async (context) => {
          const service = context.useService<{ read(): Promise<string> }>("dev.example.host-service", 1);
          context.contribute({
            contractVersion: 1,
            data: {},
            id: "dev.example.managed.service-page",
            kind: "page",
            supports: ["web"],
          }, { value: await service?.read() });
        },
      },
    }),
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current, stateRevision, providers),
      invokeService: async () => "host-value",
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset("service", request.integrity, "runtime/surface/main/module.cjs"),
        styles: [],
      }),
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });
  await loader.reconcile();
  assert.deepEqual(runtime.getSnapshot().visibleContributions[0]?.implementation, { value: "host-value" });
  providers = [];
  stateRevision += 1;
  current = { ...current, revision: current.revision + 1 };
  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
});

test("isolated Surface realms contribute transactionally and are physically disposed on disable", async () => {
  const artifactIntegrity = integrityFor("isolated-artifact");
  const isolatedManifest: VarinExtensionManifest = {
    ...manifest("1.0.0"),
    entrypoints: {
      surfaces: [{ id: "main", file: "surface.js", isolation: "iframe", mode: "isolated", supports: ["web"] }],
    },
  };
  let current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: isolatedManifest });
  let disposed = false;
  let receivedStyles: readonly string[] = [];
  const isolatedRealmFactory: IsolatedSurfaceRealmFactory = {
    create: (_source, styles, identity) => ({
      activate: async (context) => {
        context.contribute({
          contractVersion: 1,
          data: {},
          id: "dev.example.managed.isolated-page",
          kind: "page",
          supports: ["web"],
        }, { kind: "isolated-iframe", mount: () => () => undefined, postMessage: () => undefined, realmId: identity.realmId, viewId: "main" });
      },
      get disposed() { return disposed; },
      dispose: () => { disposed = true; },
    }),
  };
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset("isolated", request.integrity, "runtime/surface/main/module.js"),
        styles: [asset(".isolated {}", request.integrity, "runtime/surface/main/module.css", "text/css; charset=utf-8")],
      }),
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    isolatedRealmFactory: {
      create: (source, styles, identity) => {
        receivedStyles = styles;
        return isolatedRealmFactory.create(source, styles, identity);
      },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 1);
  assert.deepEqual(receivedStyles, [".isolated {}"]);
  current = snapshot(2, {
    ...current.extensions[0] as VarinExtensionCatalogEntry,
    desired: { enabled: false, revision: 2, updatedAt: "2026-08-14T00:05:00.000Z" },
  });
  await loader.reconcile();
  assert.equal(disposed, true);
  assert.equal(runtime.getSnapshot().visibleContributions.length, 0);
});

test("isolated Workers are background-only and reject visual contributions without exposing mount", async () => {
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let terminated = false;
  class TestWorker {
    addEventListener(): void {}
    postMessage(message: { nonce: string; version: number }, transfer: Transferable[]): void {
      const port = transfer[0] as MessagePort;
      port.postMessage({ type: "hello", nonce: message.nonce, version: message.version });
      port.postMessage({
        type: "contribute",
        descriptor: {
          contractVersion: 1,
          data: {},
          id: "dev.example.worker.page",
          kind: "page",
          supports: ["web"],
        },
        viewId: "main",
      });
      port.postMessage({ type: "ready", version: message.version });
    }
    terminate(): void { terminated = true; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });
  try {
    const realm = browserIsolatedSurfaceRealmFactory.create("", [], {
      entrypointId: "worker",
      extensionId: "dev.example.worker",
      integrity: integrityFor("worker"),
      kind: "worker",
      realmId: "worker-test",
    });
    let contributions = 0;
    await assert.rejects(() => realm.activate({
      callCapability: async () => null,
      callService: async () => null,
      contribute: () => { contributions += 1; },
      deleteContext: () => false,
      grantedCapabilities: [],
      hasService: () => false,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      setContext: () => false,
    }), /background-only/);
    assert.equal(contributions, 0);
    assert.equal(realm.disposed, true);
    assert.equal(terminated, true);
  } finally {
    if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
    else delete (globalThis as { Worker?: unknown }).Worker;
  }
});

test("isolated realm requests bridge owner-scoped context writes", async () => {
  const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  class TestWorker {
    addEventListener(): void {}
    postMessage(message: { nonce: string; version: number }, transfer: Transferable[]): void {
      const port = transfer[0] as MessagePort;
      port.onmessage = (event: MessageEvent<{ id?: string; success?: boolean; type?: string }>) => {
        if (event.data.type !== "response" || event.data.success !== true) return;
        if (event.data.id === "set") {
          port.postMessage({ id: "delete", method: "context.delete", params: { key: "ready" }, type: "request" });
        } else if (event.data.id === "delete") {
          port.postMessage({ type: "ready", version: message.version });
        }
      };
      port.start();
      port.postMessage({ type: "hello", nonce: message.nonce, version: message.version });
      port.postMessage({
        id: "set",
        method: "context.set",
        params: { key: "ready", value: true },
        type: "request",
      });
    }
    terminate(): void {}
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: TestWorker });
  try {
    const realm = browserIsolatedSurfaceRealmFactory.create("", [], {
      entrypointId: "worker",
      extensionId: "dev.example.worker-context",
      integrity: integrityFor("worker-context"),
      kind: "worker",
      realmId: "worker-context-test",
    });
    const values = new Map<string, string | number | boolean>();
    await realm.activate({
      callCapability: async () => null,
      callService: async () => null,
      contribute: () => undefined,
      deleteContext: (key) => values.delete(key),
      grantedCapabilities: [],
      hasService: () => false,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      setContext: (key, value) => {
        values.set(key, value);
        return true;
      },
    });
    assert.equal(values.has("ready"), false);
    realm.dispose();
  } finally {
    if (workerDescriptor) Object.defineProperty(globalThis, "Worker", workerDescriptor);
    else delete (globalThis as { Worker?: unknown }).Worker;
  }
});

test("Surface-local external service factories bind consumer owners and preserve the old generation on failed update", async () => {
  const v1Integrity = integrityFor("local-service-v1");
  const failedIntegrity = integrityFor("local-service-failed");
  const serviceManifest = (version: string): VarinExtensionManifest => ({
    ...manifest(version),
    requires: { services: [{ id: "varin.editor.monaco", optional: true, version: 1 }] },
  });
  let current = snapshot(1, {
    ...catalogEntry("1.0.0", v1Integrity),
    manifest: serviceManifest("1.0.0"),
  });
  const created: Array<{ generation: number; version: string }> = [];
  const disposed: Array<{ generation: number; version: string }> = [];
  let selections = 0;
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: (source) => ({
      default: {
        activate: (context) => {
          assert.ok(context.useService("varin.editor.monaco", 1));
          if (source === "failed") throw new Error("local-service candidate failed");
          context.contribute({
            contractVersion: 1,
            data: { languageIds: ["markdown"] },
            id: "dev.example.managed.local-service-editor",
            kind: "editor",
            supports: ["web"],
          }, { version: source });
        },
      },
    }),
    externalServiceFactories: [{
      create: (owner) => {
        const identity = { generation: owner.generation, version: owner.extensionVersion };
        created.push(identity);
        return {
          descriptor: { id: "varin.editor.monaco", version: 1 },
          dispose: () => { disposed.push(identity); },
          implementation: { getActiveView: () => ({ reason: "provider-inactive", status: "absent" }) },
          providerId: "varin.builtin.text",
        };
      },
      descriptor: { id: "varin.editor.monaco", version: 1 },
      providerId: "varin.builtin.text",
    }],
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("UI-local service must not use Host RPC"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async (request) => {
        const entry = current.extensions[0] as VarinExtensionCatalogEntry;
        current = snapshot(current.revision + 1, {
          ...entry,
          candidate: {
            ...entry.candidate as NonNullable<VarinExtensionCatalogEntry["candidate"]>,
            applyRequested: true,
          },
        });
        assert.equal(request.candidateIntegrity, failedIntegrity);
        return current;
      },
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset(request.integrity === failedIntegrity ? "failed" : "v1", request.integrity, "runtime/surface/main/module.cjs"),
        styles: [],
      }),
      reportActualState: async () => undefined,
      selectCandidate: async () => { selections += 1; return current; },
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.deepEqual(runtime.getSnapshot().visibleContributions[0]?.implementation, { version: "v1" });
  const selectedOwner = runtime.getSnapshot().visibleContributions[0]?.owner;
  current = snapshot(2, {
    ...current.extensions[0] as VarinExtensionCatalogEntry,
    candidate: {
      applyRequested: false,
      capabilitiesReviewed: true,
      capabilityDelta: { added: [], removed: [] },
      capabilityGrants: [],
      integrity: failedIntegrity,
      manifest: serviceManifest("2.0.0"),
      preparedAt: "2026-08-26T00:00:00.000Z",
      resolvedVersion: "2.0.0",
      source: { display: "Test", kind: "local" },
    },
  });
  await assert.rejects(
    () => loader.applyCandidate("dev.example.managed", failedIntegrity, current.revision),
    /local-service candidate failed/,
  );
  assert.equal(runtime.getSnapshot().visibleContributions[0]?.owner.generation, selectedOwner?.generation);
  assert.deepEqual(runtime.getSnapshot().visibleContributions[0]?.implementation, { version: "v1" });
  assert.equal(selections, 0);
  assert.deepEqual(created.map((item) => item.version), ["1.0.0", "2.0.0"]);
  assert.deepEqual(disposed.map((item) => item.version), ["2.0.0"]);

  current = snapshot(current.revision + 1, {
    ...current.extensions[0] as VarinExtensionCatalogEntry,
    desired: { enabled: false, revision: 2, updatedAt: "2026-08-26T00:01:00.000Z" },
  });
  await loader.reconcile();
  assert.deepEqual(disposed.map((item) => item.version), ["2.0.0", "1.0.0"]);
});

test("isolated realms call the serializable Surface-local editor service subset", async () => {
  const artifactIntegrity = integrityFor("isolated-local-service");
  const isolatedManifest: VarinExtensionManifest = {
    ...manifest("1.0.0"),
    entrypoints: {
      surfaces: [{ id: "main", file: "surface.js", isolation: "iframe", mode: "isolated", supports: ["web"] }],
    },
    requires: { services: [{ id: "varin.editor.monaco", optional: true, version: 1 }] },
  };
  const current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: isolatedManifest });
  let response: unknown;
  let available = false;
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    externalServiceFactories: [{
      create: (owner) => ({
        descriptor: { id: "varin.editor.monaco", version: 1 },
        implementation: {
          getActiveView: () => ({
            status: "ready",
            view: {
              documentVersion: 4,
              focused: true,
              generation: owner.generation,
              kind: "text",
              languageId: "typescript",
              providerId: "varin.builtin.text",
              resource: { resourceId: "src/main.ts", workspaceId: "workspace" },
              selection: null,
              viewId: "view-1",
            },
          }),
        },
        providerId: "varin.builtin.text",
      }),
      descriptor: { id: "varin.editor.monaco", version: 1 },
      providerId: "varin.builtin.text",
    }],
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("UI-local service must not use Host RPC"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset("isolated", request.integrity, "runtime/surface/main/module.js"),
        styles: [],
      }),
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    isolatedRealmFactory: {
      create: (_source, _styles, identity) => ({
        activate: async (context) => {
          available = context.hasService("varin.editor.monaco", 1);
          response = await context.callService("varin.editor.monaco", 1, undefined, "getActiveView", []);
          context.contribute({
            contractVersion: 1,
            data: {},
            id: "dev.example.managed.isolated-service-page",
            kind: "page",
            supports: ["web"],
          }, { kind: "isolated-iframe", mount: () => () => undefined, postMessage: () => undefined, realmId: identity.realmId, viewId: "main" });
        },
        disposed: false,
        dispose: () => undefined,
      }),
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  assert.equal(available, true);
  assert.equal((response as { status?: string }).status, "ready");
  assert.equal((response as { view?: { resource?: { resourceId?: string } } }).view?.resource?.resourceId, "src/main.ts");
});

test("trusted-native Surface activation failure requires a Surface reload and is not retried", async () => {
  const artifactIntegrity = integrityFor("native-artifact");
  const nativeManifest: VarinExtensionManifest = {
    ...manifest("1.0.0"),
    entrypoints: {
      surfaces: [{ id: "main", file: "surface.cjs", mode: "native", supports: ["web"] }],
    },
  };
  const current = snapshot(1, { ...catalogEntry("1.0.0", artifactIntegrity), manifest: nativeManifest });
  const reported: VarinExtensionActualState[] = [];
  let evaluations = 0;
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => {
      evaluations += 1;
      throw new Error("native top-level failure");
    },
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => hostState(current),
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async (request) => ({
        artifactIntegrity: request.integrity,
        entrypointId: request.entrypointId,
        module: asset("native", request.integrity, "runtime/surface/main/module.cjs"),
        styles: [],
      }),
      reportActualState: async (_extensionId, state) => { reported.push(state); },
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("unexpected host-state wait"); },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
  });

  await loader.reconcile();
  await loader.reconcile();
  assert.equal(evaluations, 1);
  assert.equal(runtime.getSnapshot().actual[0]?.status, "restart-required");
  assert.equal(reported.some((state) => state.status === "restart-required"), true);
});

test("Host-state watch reconnects from an authoritative snapshot after a transient transport failure", async () => {
  const artifactIntegrity = integrityFor("watch-recovery");
  const declarativeManifest: VarinExtensionManifest = {
    schemaVersion: 1,
    id: "dev.example.watch-recovery",
    version: "1.0.0",
    engines: { varin: "*" },
    entrypoints: { surfaces: [{ id: "main", mode: "declarative", supports: ["web"] }] },
    contributions: [{
      contractVersion: 1,
      data: {},
      entrypoint: "main",
      id: "dev.example.watch-recovery.page",
      kind: "page",
      supports: ["web"],
    }],
  };
  const enabledEntry: VarinExtensionCatalogEntry = {
    ...catalogEntry("1.0.0", artifactIntegrity),
    manifest: declarativeManifest,
  };
  let current = snapshot(1, enabledEntry);
  let hostStateReads = 0;
  let waits = 0;
  let interrupt!: () => void;
  const interruption = new Promise<void>((resolve) => { interrupt = resolve; });
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const withdrawn = new Promise<void>((resolve) => {
    const unsubscribe = runtime.subscribe(() => {
      if (runtime.getSnapshot().visibleContributions.length === 0) {
        unsubscribe();
        resolve();
      }
    });
  });
  const loader = new SurfaceExtensionLoader({
    evaluateModule: () => { throw new Error("declarative Surface must not evaluate a module"); },
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      discardPreparedCandidate: async () => undefined,
      hostState: async () => {
        hostStateReads += 1;
        return hostState(current, hostStateReads);
      },
      invokeService: async () => { throw new Error("unexpected service invocation"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("unexpected asset read"); },
      readManagedEntrypoint: async () => { throw new Error("unexpected entrypoint read"); },
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async (_request, signal) => {
        waits += 1;
        if (waits === 1) {
          await interruption;
          current = snapshot(2, {
            ...enabledEntry,
            desired: { enabled: false, revision: 2, updatedAt: "2026-08-14T00:05:00.000Z" },
          });
          throw new Error("relay disconnected");
        }
        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve(hostState(current, hostStateReads)), { once: true });
        });
      },
    },
    realmId,
    surface: "web",
    surfaceRuntime: runtime,
    watchRetry: async () => undefined,
  });

  await loader.start();
  assert.equal(runtime.getSnapshot().visibleContributions.length, 1);
  interrupt();
  // Initial activating state also has no visible contribution; observe the actual disabled owner.
  while (!runtime.getSnapshot().actual.some((state) => state.status === "inactive")) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await withdrawn;
  assert.equal(hostStateReads >= 2, true);
  assert.equal(waits >= 1, true);
  assert.equal(loader.getSnapshot().diagnostics.some((item) => item.code === "host_state_watch_interrupted"), true);
  await loader.stop();
});

test("a pending module does not block another catalog owner's activation or disable", { timeout: 2_000 }, async () => {
  const integrity = integrityFor("parallel-loader");
  const slow = catalogEntry("1.0.0", integrity);
  const fast: VarinExtensionCatalogEntry = { ...catalogEntry("1.0.0", integrity), manifest: {
    schemaVersion: 1, id: "dev.example.fast", version: "1.0.0", engines: { varin: "*" },
    contributions: [{ id: "dev.example.fast.page", kind: "page", contractVersion: 1, supports: ["web"], data: {} }],
  } };
  let current = snapshot(1, slow);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const preparing = new Promise<void>((resolve) => { entered = resolve; });
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const when = (predicate: () => boolean) => new Promise<void>((resolve) => {
    const unsubscribe = runtime.subscribe(() => { if (predicate()) { unsubscribe(); resolve(); } });
    if (predicate()) { unsubscribe(); resolve(); }
  });
  const loader = new SurfaceExtensionLoader({
    surface: "web", surfaceRuntime: runtime,
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      hostState: async () => hostState(current),
      discardPreparedCandidate: async () => undefined,
      invokeService: async () => { throw new Error("No services"); },
      prepareCandidate: async (extensionId, integrity) => ({ extensionId, integrity, providers: [] }),
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("No assets"); },
      readManagedEntrypoint: async (request) => {
        entered(); await gate;
        return { artifactIntegrity: integrity, entrypointId: request.entrypointId,
          module: asset("module.exports={activate(){}}", integrity, "runtime/surface/main/module.cjs"), styles: [] };
      },
      reportActualState: async () => undefined,
      selectCandidate: async () => current,
      waitForHostState: async () => { throw new Error("Explicit catalog transitions"); },
    },
  });
  const initial = loader.reconcile(); await preparing;
  current = { ...current, revision: 2, extensions: [slow, fast] };
  const activation = loader.reconcile();
  await when(() => runtime.getSnapshot().visibleContributions.some((item) => item.owner.extensionId === fast.manifest.id));
  current = { ...current, revision: 3, extensions: [slow, { ...fast, desired: { ...fast.desired, enabled: false, revision: 2 } }] };
  const disable = loader.reconcile();
  await when(() => runtime.getSnapshot().actual.some((item) => item.extensionId === fast.manifest.id && item.status === "inactive"));
  release(); await Promise.all([initial, activation, disable]);
  await loader.stop();
});

test("the exact candidate promoted by the Host during prepare is consumed without selecting it again", async () => {
  const oldIntegrity = integrityFor("old-artifact");
  const nextIntegrity = integrityFor("promoted-artifact");
  let current = snapshot(1, catalogEntry("1.0.0", oldIntegrity));
  let selects = 0;
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const loader = new SurfaceExtensionLoader({
    surface: "web", surfaceRuntime: runtime,
    host: {
      activateExtension: async () => undefined,
      catalog: async () => ({ supported: true, status: "ready", snapshot: current }),
      hostState: async () => hostState(current),
      discardPreparedCandidate: async () => undefined,
      invokeService: async () => { throw new Error("No services"); },
      prepareCandidate: async (extensionId, integrity) => {
        const candidate = current.extensions[0]!.candidate!;
        current = snapshot(current.revision + 1, { ...catalogEntry(candidate.resolvedVersion, candidate.integrity), manifest: candidate.manifest });
        return { extensionId, integrity, providers: [] };
      },
      requestCandidateApplication: async () => current,
      readAsset: async () => { throw new Error("No assets"); },
      readManagedEntrypoint: async (request) => {
        expectSelectedSlot(request.slot, request.integrity);
        return { artifactIntegrity: request.integrity, entrypointId: request.entrypointId,
          module: asset(`module.exports={activate(context){context.contribute({id:'dev.example.managed.page',kind:'page',contractVersion:1,supports:['web'],data:{}},{version:${JSON.stringify(request.integrity)}})}}`, request.integrity, "runtime/surface/main/module.cjs"), styles: [] };
      },
      reportActualState: async () => undefined,
      selectCandidate: async () => { selects += 1; return current; },
      waitForHostState: async () => { throw new Error("Explicit catalog transitions"); },
    },
  });
  function expectSelectedSlot(slot: string, integrity: string) {
    assert.equal(slot, "selected");
    assert.equal(current.extensions[0]?.integrity, integrity);
  }
  await loader.reconcile();
  current = snapshot(2, { ...current.extensions[0]!, candidate: {
    applyRequested: false, capabilitiesReviewed: true, capabilityDelta: { added: [], removed: [] }, capabilityGrants: [],
    integrity: nextIntegrity, manifest: manifest("2.0.0"), preparedAt: new Date().toISOString(), resolvedVersion: "2.0.0",
    source: { kind: "local", display: "Promoted candidate" },
  } });
  const committed = await loader.applyCandidate("dev.example.managed", nextIntegrity, current.revision);
  assert.equal(committed.extensions[0]?.integrity, nextIntegrity);
  assert.equal(selects, 0);
  assert.equal((runtime.getSnapshot().visibleContributions[0]?.implementation as { version: string }).version, nextIntegrity);
  await loader.stop();
});
