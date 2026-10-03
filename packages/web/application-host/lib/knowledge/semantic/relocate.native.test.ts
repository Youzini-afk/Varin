import { describe, expect, it } from "vitest";
import { createStructureSource } from "../../structure/source.js";
import { createTreeSitterStructureProvider } from "../../structure/native-provider.test-helper.js";
import { contentHashOf } from "./identity.js";
import { relocateSemanticFocus } from "./relocate.js";

const parsingSource = () => createStructureSource([
  createTreeSitterStructureProvider({ parseBudgetMs: 30_000 }),
]);

const original = [
  "export function keepLease(handle: string) {",
  "  const token = handle.trim();",
  "  return token.length;",
  "}",
].join("\n");

describe("relocateSemanticFocus", () => {
  it("uses the recorded range when the block hash still matches", async () => {
    const source = parsingSource();
    const outline = await source.outline({ path: "keep.ts", languageId: "typescript", text: original, revision: "r1" });
    const lines = original.split("\n");
    const body = lines.slice(0, 4).join("\n");
    const result = relocateSemanticFocus({
      lines,
      languageId: "typescript",
      recorded: {
        startLine: 1,
        endLine: 4,
        contentHash: contentHashOf(body),
        parentName: "keepLease",
        parentKind: "function",
        body,
      },
      symbols: outline.symbols,
    });
    expect(result).toMatchObject({ startLine: 1, endLine: 4, mode: "hash" });
  });

  it("relocates by parent identity and block text after earlier lines shift", async () => {
    const shifted = ["// banner", original].join("\n");
    const source = parsingSource();
    const outline = await source.outline({ path: "keep.ts", languageId: "typescript", text: shifted, revision: "r2" });
    const oldBody = original;
    const result = relocateSemanticFocus({
      lines: shifted.split("\n"),
      languageId: "typescript",
      recorded: {
        startLine: 1,
        endLine: 4,
        contentHash: contentHashOf(oldBody),
        parentName: "keepLease",
        parentKind: "function",
        body: oldBody,
      },
      symbols: outline.symbols,
    });
    expect(result.mode).toBe("relocated");
    expect(result.startLine).toBe(2);
    expect(result.endLine).toBe(5);
  });

  it("re-slices the current unit instead of keeping a stale range after a material edit", async () => {
    const changed = [
      "export function keepLease(handle: string) {",
      "  if (!handle) return 0;",
      "  const rewritten = handle.toUpperCase();",
      "  return rewritten.length * 2;",
      "}",
    ].join("\n");
    const source = parsingSource();
    const outline = await source.outline({ path: "keep.ts", languageId: "typescript", text: changed, revision: "r3" });
    const result = relocateSemanticFocus({
      lines: changed.split("\n"),
      languageId: "typescript",
      recorded: {
        startLine: 1,
        endLine: 4,
        contentHash: contentHashOf(original),
        parentName: "keepLease",
        parentKind: "function",
        body: original,
      },
      symbols: outline.symbols,
    });
    expect(result.mode).toBe("rechunk");
    expect(result).not.toEqual({ startLine: 1, endLine: 4, mode: "hash" });
    expect(result.startLine).toBe(1);
    expect(result.endLine).toBe(5);
  });
});
