import { rmSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GrammarStoreUnreadableError, createGrammarStore, grammarIntegrityOf } from "./grammar-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temporaryDirectory = () => {
  const root = mkdtempSync(join(tmpdir(), "varin-grammar-test-"));
  roots.push(root);
  return root;
};

describe("createGrammarStore", () => {
  it("stores wasm by sha256 and removes unused blobs", () => {
    const dataDir = temporaryDirectory();
    const store = createGrammarStore(dataDir, () => "2026-09-07T00:00:00.000Z");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const integrity = grammarIntegrityOf(bytes);
    store.put("python", bytes, { integrity, source: "manifest", grammarFile: "tree-sitter-python.wasm" });
    expect(store.get("python")).toMatchObject({ integrity, source: "manifest" });
    expect(existsSync(store.pathForIntegrity(integrity))).toBe(true);
    expect(store.pathForGrammarFile("tree-sitter-python.wasm")).toBe(store.pathForIntegrity(integrity));
    expect(createGrammarStore(dataDir).get("python")).toMatchObject({ integrity, source: "manifest" });
    store.remove("python");
    expect(store.has("python")).toBe(false);
    expect(existsSync(store.pathForIntegrity(integrity))).toBe(false);
  });

  it("keeps the tags query with the grammar and drops it on remove", () => {
    const dataDir = temporaryDirectory();
    const store = createGrammarStore(dataDir);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const tags = new TextEncoder().encode("(function_declaration) @definition.function");
    const tagsIntegrity = grammarIntegrityOf(tags);
    store.put(
      "python",
      bytes,
      { integrity: grammarIntegrityOf(bytes), source: "manifest", grammarFile: "tree-sitter-python.wasm" },
      { bytes: tags, integrity: tagsIntegrity },
    );
    expect(store.get("python")?.tagsIntegrity).toBe(tagsIntegrity);
    expect(store.readTagsQuery("python")).toContain("@definition.function");
    store.remove("python");
    expect(store.readTagsQuery("python")).toBeNull();
  });

  it("treats an unreadable index as an error instead of an empty store", () => {
    const dataDir = temporaryDirectory();
    const store = createGrammarStore(dataDir);
    const bytes = new Uint8Array([7, 7, 7]);
    const integrity = grammarIntegrityOf(bytes);
    store.put("python", bytes, { integrity, source: "manifest", grammarFile: "tree-sitter-python.wasm" });
    writeFileSync(join(store.root, "index.json"), "{ not json", "utf8");

    expect(() => store.has("python")).toThrow(GrammarStoreUnreadableError);
    // The install must fail rather than persist an index that dropped python.
    expect(() => store.put("go", bytes, { integrity, source: "manifest", grammarFile: "tree-sitter-go.wasm" }))
      .toThrow(GrammarStoreUnreadableError);
    expect(readFileSync(join(store.root, "index.json"), "utf8")).toBe("{ not json");
  });

  it("reports a missing index as an empty store", () => {
    const dataDir = temporaryDirectory();
    const store = createGrammarStore(dataDir);
    expect(store.has("python")).toBe(false);
    expect(store.idsBySource("manifest")).toEqual([]);
  });
});
