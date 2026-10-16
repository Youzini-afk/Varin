import { describe, expect, it } from "vitest";
import { parseGrammarPackManifest } from "./grammar-manifest.js";

const entry = (overrides: Record<string, unknown> = {}) => ({
  languageId: "python",
  packageName: "tree-sitter-python",
  version: "0.25.0",
  tarballUrl: "https://example.test/p.tgz",
  wasmPath: "package/tree-sitter-python.wasm",
  grammarFile: "tree-sitter-python.wasm",
  integrity: `sha256-${"a".repeat(64)}`,
  bytes: 10,
  abi: 15,
  licensePath: "package/LICENSE",
  ...overrides,
});

describe("parseGrammarPackManifest", () => {
  it("does not offer a pack whose ABI is outside the window the manifest declares", () => {
    const manifest = parseGrammarPackManifest({
      generatedAt: "2026-09-07",
      minCompatibleAbi: 13,
      maxCompatibleAbi: 15,
      packs: { python: entry(), go: entry({ languageId: "go", abi: 17 }) },
      skipped: {},
    });
    expect(Object.keys(manifest.packs)).toEqual(["python"]);
    expect(manifest.skipped.go).toContain("outside the manifest window");
  });

  it("drops a query it cannot verify instead of installing one on trust", () => {
    const manifest = parseGrammarPackManifest({
      generatedAt: "2026-09-07",
      minCompatibleAbi: 13,
      maxCompatibleAbi: 15,
      packs: { python: entry({ tagsPath: "package/queries/tags.scm", tagsIntegrity: "not-a-digest" }) },
      skipped: {},
    });
    expect(manifest.packs.python?.tagsPath).toBeNull();
    expect(manifest.packs.python?.tagsIntegrity).toBeNull();
  });
});
