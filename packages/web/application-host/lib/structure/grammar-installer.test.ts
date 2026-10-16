import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGrammarInstaller } from "./grammar-installer.js";
import { parseGrammarPackManifest } from "./grammar-manifest.js";
import { createGrammarStore, grammarIntegrityOf } from "./grammar-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const temporaryDirectory = () => {
  const root = mkdtempSync(join(tmpdir(), "varin-grammar-test-"));
  roots.push(root);
  return root;
};

const wasm = new Uint8Array([0, 1, 2, 3, 4, 5]);
const integrity = grammarIntegrityOf(wasm);
const tags = new TextEncoder().encode("(function_definition name: (identifier) @name) @definition.function\n");
const tagsIntegrity = grammarIntegrityOf(tags);

const manifest = parseGrammarPackManifest({
  generatedAt: "2026-09-07",
  minCompatibleAbi: 13,
  maxCompatibleAbi: 15,
  packs: {
    swift: {
      languageId: "swift",
      packageName: "tree-sitter-swift",
      version: "0.25.0",
      tarballUrl: "https://example.test/tree-sitter-swift.tgz",
      wasmPath: "package/tree-sitter-swift.wasm",
      grammarFile: "tree-sitter-swift.wasm",
      integrity,
      bytes: wasm.byteLength,
      abi: 15,
      licensePath: "package/LICENSE",
      tagsPath: "package/queries/tags.scm",
      tagsIntegrity,
    },
  },
  skipped: {},
});

const storeOf = () => createGrammarStore(temporaryDirectory());

const files = (entries: Record<string, Uint8Array>) => async (
  _tarball: Uint8Array,
  paths: readonly string[],
) => {
  const found = new Map<string, Uint8Array>();
  for (const path of paths) {
    const bytes = entries[path];
    if (bytes) found.set(path, bytes);
  }
  return found;
};

const published = files({
  "package/tree-sitter-swift.wasm": wasm,
  "package/queries/tags.scm": tags,
});

describe("createGrammarInstaller", () => {
  it("rejects a digest mismatch and does not keep the file", async () => {
    const store = storeOf();
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      download: async () => new Uint8Array([9, 9, 9]),
      extractFiles: files({ "package/tree-sitter-swift.wasm": new Uint8Array([9, 9, 9]) }),
      inspectAbi: async () => 15,
    });
    await expect(installer.install({ languageId: "swift" })).resolves.toMatchObject({
      status: "failed",
      reason: "integrity",
    });
    expect(store.has("swift")).toBe(false);
  });

  it("rejects a query digest mismatch, because the query is part of the anchor", async () => {
    const store = storeOf();
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      download: async () => wasm,
      extractFiles: files({
        "package/tree-sitter-swift.wasm": wasm,
        "package/queries/tags.scm": new TextEncoder().encode("(other) @definition.class"),
      }),
      inspectAbi: async () => 15,
    });
    await expect(installer.install({ languageId: "swift" })).resolves.toMatchObject({
      status: "failed",
      reason: "integrity",
    });
    expect(store.has("swift")).toBe(false);
  });

  it("stores the verified query next to the grammar", async () => {
    const store = storeOf();
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      download: async () => wasm,
      extractFiles: published,
      inspectAbi: async () => 15,
    });
    await expect(installer.install({ languageId: "swift" })).resolves.toMatchObject({
      status: "ready",
      grammarStatus: "installed",
    });
    expect(store.readTagsQuery("swift")).toContain("@definition.function");
  });

  it("cancels an in-flight download", async () => {
    const store = storeOf();
    let release: (() => void) | undefined;
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      download: async (_url, signal) => {
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        });
        return wasm;
      },
      extractFiles: published,
      inspectAbi: async () => 15,
    });
    const pending = installer.install({ languageId: "swift" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(installer.cancelInstall({ languageId: "swift" })).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(pending).resolves.toMatchObject({ status: "cancelled" });
    expect(store.has("swift")).toBe(false);
    release?.();
  });

  it("joins a download already in progress instead of cancelling the first click", async () => {
    const store = storeOf();
    let downloads = 0;
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      download: async () => {
        downloads += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return wasm;
      },
      extractFiles: published,
      inspectAbi: async () => 15,
    });
    const [first, second] = await Promise.all([
      installer.install({ languageId: "swift" }),
      installer.install({ languageId: "swift" }),
    ]);
    expect(first).toMatchObject({ status: "ready" });
    expect(second).toMatchObject({ status: "ready" });
    expect(downloads).toBe(1);
  });

  it("rejects an ABI outside the application window with its own reason", async () => {
    const store = storeOf();
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      download: async () => wasm,
      extractFiles: published,
      inspectAbi: async () => 16,
    });
    await expect(installer.install({ languageId: "swift" })).resolves.toMatchObject({
      status: "failed",
      reason: "abi",
    });
    expect(store.has("swift")).toBe(false);
  });

  it("imports a user wasm without a manifest match", async () => {
    const store = storeOf();
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      readLocal: async () => wasm,
      inspectAbi: async () => 14,
    });
    await expect(installer.importUserGrammar({ languageId: "markdown", path: "C:\\tmp\\custom.wasm" })).resolves.toMatchObject({
      status: "ready",
      grammarStatus: "user-unverified",
    });
    expect(store.get("markdown")?.source).toBe("user");
  });

  it("does not echo filesystem errors back to the caller", async () => {
    const store = storeOf();
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      readLocal: async () => {
        throw Object.assign(new Error("EACCES: permission denied, open '/etc/shadow'"), { code: "EACCES" });
      },
      inspectAbi: async () => 14,
    });
    const result = await installer.importUserGrammar({ languageId: "markdown", path: "/etc/shadow.wasm" });
    expect(result).toMatchObject({ status: "failed", reason: "failed" });
    expect(result).not.toMatchObject({ message: expect.stringContaining("EACCES") });
    expect(store.has("markdown")).toBe(false);
  });

  it("refuses a path that is not a wasm file and a file over the ceiling", async () => {
    const store = storeOf();
    const installer = createGrammarInstaller({
      store,
      manifest,
      minAbi: 13,
      maxAbi: 15,
      readLocal: async () => new Uint8Array(64),
      inspectAbi: async () => 14,
      maxUserBytes: 32,
    });
    await expect(installer.importUserGrammar({ languageId: "markdown", path: "/tmp/grammar.txt" })).resolves.toMatchObject({
      status: "failed",
      reason: "unsupported",
    });
    await expect(installer.importUserGrammar({ languageId: "markdown", path: "/tmp/grammar.wasm" })).resolves.toMatchObject({
      status: "failed",
      reason: "failed",
    });
    expect(store.has("markdown")).toBe(false);
  });
});
