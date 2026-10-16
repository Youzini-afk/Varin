import { describe, expect, it } from "vitest";
import { remapAsarUnpackedPath, resolveStructureRuntimeFile } from "./runtime-path.js";

describe("remapAsarUnpackedPath", () => {
  it("rewrites app.asar to app.asar.unpacked when that path exists", () => {
    const logical = "C:\\Varin\\resources\\app.asar\\server\\lib\\structure\\runtime\\web-tree-sitter.wasm";
    const unpacked = "C:\\Varin\\resources\\app.asar.unpacked\\server\\lib\\structure\\runtime\\web-tree-sitter.wasm";
    expect(remapAsarUnpackedPath(logical, (candidate) => candidate === unpacked)).toBe(unpacked);
  });

  it("keeps the logical path when the unpacked file is absent", () => {
    const logical = "/opt/Varin/resources/app.asar/server/lib/structure/runtime/web-tree-sitter.wasm";
    expect(remapAsarUnpackedPath(logical, () => false)).toBe(logical);
  });
});

describe("resolveStructureRuntimeFile", () => {
  it("keeps a bundled file even when an installed twin exists", () => {
    const installed = "/data/structure-grammars/sha256/deadbeef.wasm";
    const resolved = resolveStructureRuntimeFile(
      "tree-sitter-typescript.wasm",
      import.meta.url,
      (candidate) => candidate.replace(/\\/g, "/").endsWith("tree-sitter-typescript.wasm") || candidate === installed,
      () => installed,
    );
    expect(resolved.replace(/\\/g, "/")).toContain("runtime/tree-sitter-typescript.wasm");
    expect(resolved).not.toBe(installed);
  });

  it("falls through to the download directory only when the bundled file is absent", () => {
    const installed = "/data/structure-grammars/sha256/abcdef.wasm";
    const resolved = resolveStructureRuntimeFile(
      "tree-sitter-python.wasm",
      import.meta.url,
      (candidate) => candidate === installed,
      (fileName) => fileName === "tree-sitter-python.wasm" ? installed : null,
    );
    expect(resolved).toBe(installed);
  });
});
