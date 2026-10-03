import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  checkVarinContributionCompatibility,
  isVarinContributionCompatible,
  parseVarinExtensionManifest,
  VarinExtensionContractError,
} from "../src/index.js";

const manifest = (): {
  schemaVersion: number;
  id: string;
  version: string;
  engines: { varin: string };
  contributions: Array<Record<string, unknown>>;
} => ({
  schemaVersion: 1,
  id: "dev.example.compat",
  version: "1.0.0",
  engines: { varin: ">=0.2.0" },
  contributions: [
    {
      id: "dev.example.compat.view",
      kind: "view",
      contractVersion: 1,
      data: {},
      supports: ["web"],
    },
  ],
});

test("checkVarinContributionCompatibility returns supported for v1", () => {
  const result = checkVarinContributionCompatibility("view", 1);
  assert.equal(result.status, "supported");
  assert.equal(result.kind, "view");
  assert.equal(result.contractVersion, 1);
});

test("checkVarinContributionCompatibility returns unsupported for higher version", () => {
  const result = checkVarinContributionCompatibility("view", 2);
  assert.equal(result.status, "unsupported-contract-version");
  assert.equal(result.kind, "view");
  assert.equal(result.contractVersion, 2);
  assert.deepEqual(result.supportedVersions, [1]);
});

test("isVarinContributionCompatible predicate", () => {
  assert.equal(isVarinContributionCompatible("shell", 1), true);
  assert.equal(isVarinContributionCompatible("shell", 99), false);
  assert.equal(isVarinContributionCompatible("editor", 1), true);
  assert.equal(isVarinContributionCompatible("editor", 2), false);
});

test("parseVarinExtensionManifest accepts contractVersion 1", () => {
  const parsed = parseVarinExtensionManifest(manifest());
  assert.equal(parsed.contributions![0]!.contractVersion, 1);
});

test("parseVarinExtensionManifest parses higher contractVersion without throwing", () => {
  const m = manifest();
  (m.contributions![0] as { contractVersion: number }).contractVersion = 99;
  // Should not throw �?the manifest is structurally valid, just incompatible
  const parsed = parseVarinExtensionManifest(m);
  assert.equal(parsed.contributions![0]!.contractVersion, 99);
});

test("parseVarinExtensionManifest skips kind-specific data validation for unsupported version", () => {
  // An editor with contractVersion 2 and missing languageIds/filenames
  // should NOT trigger the "must declare languageIds or filenames" issue
  // because the data is not validated for unsupported versions.
  const m = manifest();
  m.contributions![0] = {
    id: "dev.example.compat.editor",
    kind: "editor",
    contractVersion: 2,
    data: {},
    supports: ["web"],
  };
  const parsed = parseVarinExtensionManifest(m);
  assert.equal(parsed.contributions![0]!.contractVersion, 2);
});

test("parseVarinExtensionManifest still validates kind-specific data for v1 editor", () => {
  const m = manifest();
  m.contributions![0] = {
    id: "dev.example.compat.editor",
    kind: "editor",
    contractVersion: 1,
    data: {},
    supports: ["web"],
  };
  assert.throws(
    () => parseVarinExtensionManifest(m),
    (error: unknown) => {
      if (!(error instanceof VarinExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("must declare languageIds or filenames"));
    },
  );
});

test("parseVarinExtensionManifest validates shell data only for compatible version", () => {
  // shell with contractVersion 2 and invalid data should not throw shell data errors
  const m = manifest();
  m.contributions![0] = {
    id: "dev.example.compat.shell",
    kind: "shell",
    contractVersion: 2,
    data: { contract: "wrong", seams: {} },
    supports: ["web"],
    replacement: { target: "workbench.shell" },
  };
  const parsed = parseVarinExtensionManifest(m);
  assert.equal(parsed.contributions![0]!.contractVersion, 2);
});

test("same extension can have both compatible and incompatible contributions", () => {
  const m = manifest();
  m.contributions = [
    {
      id: "dev.example.compat.view1",
      kind: "view",
      contractVersion: 1,
      data: {},
      supports: ["web"],
    },
    {
      id: "dev.example.compat.view2",
      kind: "view",
      contractVersion: 99,
      data: {},
      supports: ["web"],
    },
  ];
  const parsed = parseVarinExtensionManifest(m);
  assert.equal(parsed.contributions?.length, 2);
  assert.equal(parsed.contributions![0]!.contractVersion, 1);
  assert.equal(parsed.contributions![1]!.contractVersion, 99);
});
