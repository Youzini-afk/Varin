import { strict as assert } from "node:assert";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv2020Ctor = Ajv2020 as any;
import semver from "semver";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseVarinExtensionManifest, VarinExtensionContractError } from "../src/index.js";
import { manifestFixtures } from "./manifest-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "schema", "varin.extension.schema.json");
const schema = JSON.parse(await readFile(schemaPath, "utf8")) as object;

// Register a real semver-range format validator instead of the always-true stub.
const validateSchema = new Ajv2020Ctor({
  allErrors: true,
  strict: false,
  formats: {
    "semver-range": (input: string) => semver.validRange(input) !== null,
  },
}).compile(schema);

const schemaValid = (manifest: unknown): boolean => Boolean(validateSchema(manifest));

const runtimeValid = (manifest: unknown): boolean => {
  try {
    parseVarinExtensionManifest(manifest);
    return true;
  } catch (error) {
    if (error instanceof VarinExtensionContractError) return false;
    throw error;
  }
};

test("schema and runtime agree on every manifest fixture", () => {
  const mismatches: string[] = [];
  for (const fixture of manifestFixtures) {
    const schemaResult = schemaValid(fixture.manifest);
    const runtimeResult = runtimeValid(fixture.manifest);
    // Check fixture expectations are met
    if (schemaResult !== fixture.schemaValid) {
      mismatches.push(
        `${fixture.label}: schema expected ${fixture.schemaValid} but got ${schemaResult}`,
      );
    }
    if (runtimeResult !== fixture.runtimeValid) {
      mismatches.push(
        `${fixture.label}: runtime expected ${fixture.runtimeValid} but got ${runtimeResult}`,
      );
    }
    // Assert schema and runtime agree, unless the fixture documents a
    // cross-field rule that only the runtime can express.
    // The only allowed divergence is schemaValid=true, runtimeValid=false
    // (schema accepts but runtime rejects a cross-field constraint).
    // schemaValid=false, runtimeValid=true is NOT acceptable — both must reject.
    if (fixture.schemaValid === false && fixture.runtimeValid === true) {
      mismatches.push(
        `${fixture.label}: schema rejects but runtime accepts — this divergence is not allowed`,
      );
    }
  }
  assert.deepEqual(mismatches, [], mismatches.join("\n"));
});

test("semver-range format uses real semver.validRange validation", () => {
  // Valid ranges
  assert.equal(schemaValid({ ...minimalManifest(), engines: { varin: ">=0.2.0" } }), true);
  assert.equal(schemaValid({ ...minimalManifest(), engines: { varin: "^1.0.0" } }), true);
  assert.equal(schemaValid({ ...minimalManifest(), engines: { varin: "*" } }), true);
  // Invalid range
  assert.equal(schemaValid({ ...minimalManifest(), engines: { varin: "not-a-range" } }), false);
});



test("editor, shell, and transition rules are scoped to their supported contract version", () => {
  const futureContributions = [
    { id: "editor", kind: "editor", data: { futureField: true } },
    {
      id: "shell",
      kind: "shell",
      data: { futureField: true },
      replacement: { target: "future.shell" },
      when: { key: "future.shell.ready", op: "defined" },
    },
    {
      id: "transition",
      kind: "transition-scene",
      data: { futureField: true },
      replacement: { target: "future.transition" },
      when: { key: "future.transition.ready", op: "defined" },
    },
  ];
  for (const contribution of futureContributions) {
    const manifest = {
      schemaVersion: 1,
      id: `dev.example.future-${contribution.id}`,
      version: "1.0.0",
      engines: { varin: ">=0.2.0" },
      contributions: [{
        ...contribution,
        id: `dev.example.future-${contribution.id}.view`,
        contractVersion: 2,
        supports: ["web"],
      }],
    };
    assert.equal(schemaValid(manifest), true, `future ${contribution.kind} should not use v1 schema rules`);
    assert.equal(runtimeValid(manifest), true, `future ${contribution.kind} should remain readable but incompatible`);
  }
});

const minimalManifest = () => ({
  schemaVersion: 1,
  id: "dev.example.minimal",
  version: "1.0.0",
  engines: { varin: ">=0.2.0" },
  contributions: [{
    id: "dev.example.minimal.view",
    kind: "view" as const,
    contractVersion: 1,
    data: {},
    supports: ["web" as const],
  }],
});
