import assert from "node:assert/strict";
import test from "node:test";
import {
  VarinExtensionContractError,
  assertVarinExtensionManifestCompatibility,
  parseVarinExtensionCatalogAvailability,
  parseVarinExtensionCatalogDocument,
  parseVarinExtensionCandidateCapabilityReviewRequest,
  parseVarinExtensionCapabilityReviewRequest,
  parseVarinExtensionAssetPayload,
  parseVarinExtensionManagedEntrypointRequest,
  parseVarinExtensionLocalSourceReloadRequest,
  parseVarinExtensionLocalSourceReloadResult,
  parseVarinExtensionManifest,
  parseVarinExtensionRemoveRequest,
  parseVarinExtensionStorageOpenRequest,
} from "../src/index.js";

const manifest = () => ({
  schemaVersion: 1,
  id: "dev.example.memory-workbench",
  version: "1.2.0",
  engines: { varin: ">=0.2.0 <0.3.0" },
  entrypoints: {
    host: { file: "dist/host.mjs", mode: "brokered" },
    surfaces: [{ id: "main", file: "dist/surface.mjs", mode: "managed", supports: ["web", "desktop"] }],
  },
  requires: { services: [{ id: "varin.sessions", version: 1 }] },
  provides: { services: [{ id: "dev.example.memory", version: 1, multiple: true }] },
  capabilities: { host: ["extension-storage"], surface: ["commands"] },
  contributions: [{
    id: "dev.example.memory-workbench.settings",
    kind: "settings-page",
    contractVersion: 1,
    entrypoint: "main",
    supports: ["web", "desktop"],
    requiresCapabilities: ["commands"],
    data: { route: "memory" },
  }],
  integrates: { piPackages: ["pi-observational-memory"] },
});

test("validates content-addressed managed entrypoint requests and asset bytes", () => {
  const integrity = `sha256-${"a".repeat(64)}`;
  assert.deepEqual(parseVarinExtensionManagedEntrypointRequest({
    entrypointId: "main",
    extensionId: "dev.example.memory-workbench",
    integrity,
    slot: "candidate",
  }), {
    entrypointId: "main",
    extensionId: "dev.example.memory-workbench",
    integrity,
    slot: "candidate",
  });
  assert.equal(parseVarinExtensionAssetPayload({
    artifactIntegrity: integrity,
    bytesBase64: "aGVsbG8=",
    contentType: "text/plain",
    integrity,
    path: "package/hello.txt",
  }).path, "package/hello.txt");
  assert.throws(() => parseVarinExtensionManagedEntrypointRequest({
    entrypointId: "main",
    extensionId: "../escape",
    integrity: "sha256-not-a-digest",
    slot: "selected",
  }), VarinExtensionContractError);
});

test("validates explicit candidate capability decisions", () => {
  const request = parseVarinExtensionCandidateCapabilityReviewRequest({
    candidateIntegrity: `sha256-${"b".repeat(64)}`,
    decisions: [{ capability: "workspace.files", granted: false, realm: "host" }],
    expectedRevision: 4,
    extensionId: "dev.example.memory-workbench",
  });
  assert.equal(request.decisions[0]?.granted, false);
  assert.throws(() => parseVarinExtensionCandidateCapabilityReviewRequest({
    ...request,
    decisions: [request.decisions[0], request.decisions[0]],
  }), VarinExtensionContractError);
});

test("validates explicit selected-version capability decisions", () => {
  const request = parseVarinExtensionCapabilityReviewRequest({
    decisions: [{ capability: "commands", granted: true, realm: "surface" }],
    expectedRevision: 2,
    extensionId: "dev.example.memory-workbench",
  });
  assert.equal(request.decisions[0]?.granted, true);
  assert.throws(() => parseVarinExtensionCapabilityReviewRequest({
    ...request,
    decisions: [request.decisions[0], request.decisions[0]],
  }), VarinExtensionContractError);
});

test("validates local source reload requests and results without a source specifier", () => {
  const request = parseVarinExtensionLocalSourceReloadRequest({
    expectedRevision: 4,
    extensionId: "dev.example.memory-workbench",
  });
  assert.deepEqual(request, { expectedRevision: 4, extensionId: "dev.example.memory-workbench" });
  assert.equal("source" in request, false);
  const snapshot = {
    schemaVersion: 1,
    hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
    revision: 4,
    loadedAt: "2026-08-14T00:00:00.000Z",
    authoritative: true,
    storageState: "ready",
    diagnostics: [],
    extensions: [],
  };
  const staged = parseVarinExtensionLocalSourceReloadResult({
    candidateIntegrity: `sha256-${"c".repeat(64)}`,
    outcome: "staged",
    snapshot,
  });
  assert.equal(staged.outcome, "staged");
  assert.throws(() => parseVarinExtensionLocalSourceReloadResult({
    outcome: "staged",
    snapshot,
  }), VarinExtensionContractError);
});

test("defaults legacy remove requests to retained data and validates explicit deletion", () => {
  assert.deepEqual(parseVarinExtensionRemoveRequest({
    expectedRevision: 3,
    extensionId: "dev.example.memory-workbench",
  }), {
    deleteData: false,
    expectedRevision: 3,
    extensionId: "dev.example.memory-workbench",
  });
  assert.equal(parseVarinExtensionRemoveRequest({
    deleteData: true,
    expectedRevision: 3,
    extensionId: "dev.example.memory-workbench",
  }).deleteData, true);
  assert.throws(() => parseVarinExtensionRemoveRequest({
    deleteData: "yes",
    expectedRevision: 3,
    extensionId: "dev.example.memory-workbench",
  }), VarinExtensionContractError);
});

test("validates public storage addresses without accepting a forged extension namespace", () => {
  assert.deepEqual(parseVarinExtensionStorageOpenRequest({
    key: "preferences",
    schemaVersion: 2,
    scope: "workspace",
  }), { key: "preferences", schemaVersion: 2, scope: "workspace" });
  assert.throws(() => parseVarinExtensionStorageOpenRequest({
    extensionId: "dev.example.someone-else",
    key: "preferences",
    scope: "workspace",
  }), (error) => error instanceof VarinExtensionContractError
    && error.issues.some((issue) => issue.includes("assigned by the Varin Host")));
});

test("normalizes a complete Varin extension manifest", () => {
  const parsed = parseVarinExtensionManifest(manifest());
  assert.equal(parsed.id, "dev.example.memory-workbench");
  assert.equal(parsed.entrypoints?.surfaces?.[0]?.mode, "managed");
  assert.equal(parsed.contributions?.[0]?.data.route, "memory");
});

test("rejects invalid Varin SemVer ranges and checks compatibility at range boundaries", () => {
  assert.throws(
    () => parseVarinExtensionManifest({ ...manifest(), engines: { varin: "definitely not semver" } }),
    (error) => error instanceof VarinExtensionContractError
      && error.issues.includes("engines.varin must be a valid SemVer range"),
  );
  const parsed = parseVarinExtensionManifest({
    ...manifest(),
    engines: { varin: ">=1.2.3 <2.0.0" },
  });
  assert.doesNotThrow(() => assertVarinExtensionManifestCompatibility(parsed, "1.2.3"));
  assert.doesNotThrow(() => assertVarinExtensionManifestCompatibility(parsed, "1.9.9"));
  assert.throws(
    () => assertVarinExtensionManifestCompatibility(parsed, "2.0.0"),
    /requires Varin >=1\.2\.3 <2\.0\.0; current version is 2\.0\.0/,
  );
});

test("rejects traversal, duplicate IDs, and unsupported surfaces together", () => {
  const candidate = manifest();
  candidate.entrypoints.surfaces = [
    { id: "main", file: "../surface.mjs", mode: "managed", supports: ["web"] },
    { id: "main", file: "dist/other.mjs", mode: "managed", supports: ["vscode"] },
  ];
  assert.throws(
    () => parseVarinExtensionManifest(candidate),
    (error) => error instanceof VarinExtensionContractError
      && error.issues.some((issue) => issue.includes("parent traversal"))
      && error.issues.some((issue) => issue.includes("duplicate entrypoint"))
      && error.issues.some((issue) => issue.includes("unsupported surface")),
  );
});

test("distinguishes a valid empty catalog from malformed persisted content", () => {
  const empty = parseVarinExtensionCatalogDocument({
    schemaVersion: 1,
    revision: 0,
    updatedAt: "2026-08-14T00:00:00.000Z",
    extensions: {},
  });
  assert.deepEqual(empty.extensions, {});
  assert.throws(
    () => parseVarinExtensionCatalogDocument({ schemaVersion: 1, revision: 0, extensions: [] }),
    VarinExtensionContractError,
  );
});

test("validates public catalog snapshots before a surface accepts them", () => {
  const ready = parseVarinExtensionCatalogAvailability({
    supported: true,
    status: "ready",
    snapshot: {
      schemaVersion: 1,
      hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
      revision: 0,
      loadedAt: "2026-08-14T00:00:00.000Z",
      authoritative: true,
      storageState: "missing",
      diagnostics: [],
      extensions: [],
    },
  });
  assert.equal(ready.supported, true);
  assert.throws(() => parseVarinExtensionCatalogAvailability({
    supported: true,
    status: "ready",
    snapshot: { schemaVersion: 1, extensions: [] },
  }), VarinExtensionContractError);
});

test("rejects unknown contribution kinds instead of coercing them", () => {
  const source = manifest();
  source.contributions = [{ ...source.contributions[0]!, kind: "unknown-kind" }];
  assert.throws(() => parseVarinExtensionManifest(source), (error: unknown) => (
    error instanceof VarinExtensionContractError
    && error.issues.some((issue) => issue.includes("kind is unsupported"))
  ));
});

test("accepts view, editor, and transition scene contribution kinds", () => {
  const source = manifest();
  source.contributions = [
    { ...source.contributions[0]!, id: "dev.example.memory-workbench.panel-view", kind: "view" },
    {
      ...source.contributions[0]!,
      id: "dev.example.memory-workbench.markdown",
      kind: "editor",
      data: Object.assign({ route: "memory" }, { languageIds: ["markdown"], priority: 40 }),
    },
    Object.assign({
      ...source.contributions[0]!,
      id: "dev.example.memory-workbench.transition",
      kind: "transition-scene",
      data: Object.assign({ route: "memory" }, {
        contract: "varin-transition-scene/v1",
        durations: {
          "workbench-profile": {
            covering: { quick: 800, reduced: 0, standard: 1_600 },
            revealing: { quick: 800, reduced: 0, standard: 1_600 },
          },
        },
        scenes: ["workbench-profile"],
      }),
    }, { replacement: { target: "workbench.transition" } }),
  ];
  const parsed = parseVarinExtensionManifest(source);
  assert.deepEqual(parsed.contributions?.map((item) => item.kind), ["view", "editor", "transition-scene"]);
});

test("rejects transition scenes without a complete timing contract", () => {
  const source = manifest();
  source.contributions = [Object.assign({
    ...source.contributions[0]!,
    id: "dev.example.memory-workbench.transition",
    kind: "transition-scene",
    data: Object.assign({ route: "memory" }, {
      contract: "varin-transition-scene/v1",
      durations: { "workbench-profile": { covering: { quick: 1 } } },
      scenes: ["workbench-profile"],
    }),
  }, { replacement: { target: "workbench.transition" } })];
  assert.throws(() => parseVarinExtensionManifest(source), (error: unknown) => (
    error instanceof VarinExtensionContractError
    && error.issues.some((issue) => issue.includes("data.durations.workbench-profile.covering.reduced"))
    && error.issues.some((issue) => issue.includes("data.durations.workbench-profile.revealing"))
  ));
});

test("requires transition scenes to use the public workbench transition target", () => {
  const source = manifest();
  source.contributions = [Object.assign({
    ...source.contributions[0]!,
    id: "dev.example.memory-workbench.transition",
    kind: "transition-scene",
    data: Object.assign({ route: "memory" }, {
      contract: "varin-transition-scene/v1",
      durations: {
        "workbench-profile": {
          covering: { quick: 1, reduced: 0, standard: 1 },
          revealing: { quick: 1, reduced: 0, standard: 1 },
        },
      },
      scenes: ["workbench-profile"],
    }),
  }, { replacement: { target: "dev.example.private-transition" } })];
  assert.throws(() => parseVarinExtensionManifest(source), (error: unknown) => (
    error instanceof VarinExtensionContractError
    && error.issues.some((issue) => issue.includes("replacement.target must be workbench.transition"))
  ));
});

test("rejects editor contributions without a resource selector", () => {
  const source = manifest();
  source.contributions = [{
    ...source.contributions[0]!,
    id: "dev.example.memory-workbench.editor",
    kind: "editor",
    data: { route: "memory" },
  }];
  assert.throws(() => parseVarinExtensionManifest(source), (error: unknown) => (
    error instanceof VarinExtensionContractError
    && error.issues.some((issue) => issue.includes("languageIds or filenames"))
  ));
});
