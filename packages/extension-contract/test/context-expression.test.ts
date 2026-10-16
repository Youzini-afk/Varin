import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseVarinContextExpression,
  evaluateVarinContextExpression,
  collectVarinContextExpressionKeys,
  VarinContextExpressionError,
  parseVarinExtensionManifest,
  VarinExtensionContractError,
} from "../src/index.js";

const ctx = (entries: Record<string, string | number | boolean>) => new Map(Object.entries(entries));

test("parsed expressions drive visibility and subscribe only to their referenced keys", () => {
  const expression = parseVarinContextExpression({
    op: "all",
    expressions: [
      { op: "defined", key: "editorIsOpen" },
      { op: "not", expression: { op: "equals", key: "editorIsDirty", value: true } },
      { op: "any", expressions: [
        { op: "equals", key: "language", value: "markdown" },
        { op: "equals", key: "editorIsOpen", value: 1 },
      ] },
    ],
  });
  for (const [values, visible] of [
    [{ editorIsOpen: false, language: "markdown" }, true], // defined means present, not truthy
    [{ language: "markdown" }, false],
    [{ editorIsOpen: true, editorIsDirty: true, language: "markdown" }, false],
    [{ editorIsOpen: 1, language: "typescript" }, true],
    [{ editorIsOpen: "1", language: "typescript" }, false], // equality does not coerce
    [{ editorIsOpen: true, language: "typescript" }, false],
  ] as const) {
    assert.equal(evaluateVarinContextExpression(expression, ctx(values)), visible, JSON.stringify(values));
  }
  assert.deepEqual(collectVarinContextExpressionKeys(expression).sort(), ["editorIsDirty", "editorIsOpen", "language"]);
  for (const [op, expected] of [["all", true], ["any", false]] as const) {
    const empty = parseVarinContextExpression({ op, expressions: [] });
    assert.equal(evaluateVarinContextExpression(empty, ctx({})), expected);
    assert.deepEqual(collectVarinContextExpressionKeys(empty), []);
  }
});

test("malformed expressions fail before visibility evaluation", () => {
  for (const expression of [
    "string", { op: "invalid" }, { op: "defined" },
    { op: "equals", key: "a", value: NaN }, { op: "equals", key: "a", value: Infinity },
    { op: "defined", key: "a", extra: true },
    { op: "equals", key: "a", value: 1, extra: true },
    { op: "not", expression: { op: "defined", key: "a" }, extra: true },
    { op: "all", expressions: [], extra: true },
    { op: "any", expressions: [{ op: "equals", key: "a", value: {} }] },
  ]) {
    assert.throws(() => parseVarinContextExpression(expression), VarinContextExpressionError);
  }
});

test("parseVarinExtensionManifest accepts structured when on view", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { varin: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.view",
      kind: "view",
      contractVersion: 1,
      data: {},
      supports: ["web"],
      when: { op: "defined", key: "editorIsOpen" },
    }],
  };
  const parsed = parseVarinExtensionManifest(manifest);
  assert.deepEqual(parsed.contributions![0]!.when, { op: "defined", key: "editorIsOpen" });
});

test("parseVarinExtensionManifest rejects when on shell", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { varin: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.shell",
      kind: "shell",
      contractVersion: 1,
      data: {
        contract: "varin-workbench-shell/v1",
        seams: { web: { replacementTargets: [], slots: [] } },
      },
      supports: ["web"],
      replacement: { target: "workbench.shell" },
      when: { op: "defined", key: "editorIsOpen" },
    }],
  };
  assert.throws(
    () => parseVarinExtensionManifest(manifest),
    (error: unknown) => {
      if (!(error instanceof VarinExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("when is not allowed for shell or transition-scene"));
    },
  );
});

test("parseVarinExtensionManifest rejects when on transition-scene", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { varin: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.transition",
      kind: "transition-scene",
      contractVersion: 1,
      data: {
        contract: "varin-transition-scene/v1",
        scenes: ["workbench-profile"],
        durations: {
          "workbench-profile": {
            covering: { quick: 100, reduced: 200, standard: 300 },
            revealing: { quick: 100, reduced: 200, standard: 300 },
          },
        },
      },
      supports: ["web"],
      replacement: { target: "workbench.transition" },
      when: { op: "defined", key: "editorIsOpen" },
    }],
  };
  assert.throws(
    () => parseVarinExtensionManifest(manifest),
    (error: unknown) => {
      if (!(error instanceof VarinExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("when is not allowed for shell or transition-scene"));
    },
  );
});

test("parseVarinExtensionManifest rejects invalid when expression", () => {
  const manifest = {
    schemaVersion: 1,
    id: "dev.example.when",
    version: "1.0.0",
    engines: { varin: ">=0.2.0" },
    contributions: [{
      id: "dev.example.when.view",
      kind: "view",
      contractVersion: 1,
      data: {},
      supports: ["web"],
      when: { op: "invalid" },
    }],
  };
  assert.throws(
    () => parseVarinExtensionManifest(manifest),
    (error: unknown) => {
      if (!(error instanceof VarinExtensionContractError)) return false;
      return error.issues.some((issue) => issue.includes("op must be defined"));
    },
  );
});
