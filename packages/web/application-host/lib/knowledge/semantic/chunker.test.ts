import { describe, expect, it } from "vitest";
import type { StructureUnit } from "../../structure/types.js";
import { packStructuralUnits } from "./chunker.js";
import { LOCAL_MINILM_MAX_TOKENS } from "./identity.js";

const wordCount = (text: string): number => Math.max(1, text.split(/\s+/u).filter(Boolean).length);

const unit = (
  text: string,
  input: Partial<Omit<StructureUnit, "text" | "startLine" | "endLine">> & { startLine?: number } = {},
): StructureUnit => {
  const startLine = input.startLine ?? 1;
  const endLine = startLine + text.split("\n").length - 1;
  return {
    startLine,
    endLine,
    parentName: input.parentName ?? "",
    parentKind: input.parentKind ?? "file",
    parentSignature: input.parentSignature ?? "",
    docComments: input.docComments ?? "",
    text,
    fallback: input.fallback ?? true,
  };
};

describe("packStructuralUnits", () => {
  it("covers every line of a large structural unit and keeps each embed text at the tokenizer limit", () => {
    const bodyLines = Array.from({ length: 80 }, (_, index) => `  const marker_${index + 1} = ${index + 1};`);
    const text = [
      "export function processRequest(input: string) {",
      ...bodyLines,
      "  return input;",
      "}",
    ].join("\n");
    const maxTokens = 24;
    const chunks = packStructuralUnits({
      documentId: "mail:abc123",
      units: [unit(text, {
        parentName: "processRequest",
        parentKind: "function",
        parentSignature: "export function processRequest(input: string)",
        fallback: false,
      })],
      maxTokens,
      countTokens: wordCount,
    });
    expect(chunks.length).toBeGreaterThan(1);
    const lineCount = text.split("\n").length;
    for (let line = 1; line <= lineCount; line += 1) {
      expect(chunks.some((chunk) => chunk.startLine <= line && chunk.endLine >= line), `line ${line} uncovered`).toBe(true);
    }
    for (const chunk of chunks) {
      expect(wordCount(chunk.embedText)).toBeLessThanOrEqual(maxTokens);
      expect(chunk.documentId).toBe("mail:abc123");
      expect(chunk.blockId).toContain(encodeURIComponent("mail:abc123"));
      expect(chunk.parentName).toBe("processRequest");
    }
  });

  it("uses overlapping fallback windows for a native fallback unit", () => {
    const text = Array.from({ length: 40 }, (_, index) => `line_${index + 1} token token token token`).join("\n");
    const chunks = packStructuralUnits({
      documentId: "plain.txt",
      units: [unit(text)],
      maxTokens: 12,
      countTokens: wordCount,
    });
    expect(chunks.every((chunk) => chunk.fallback)).toBe(true);
    for (let line = 1; line <= 40; line += 1) {
      expect(chunks.some((chunk) => chunk.startLine <= line && chunk.endLine >= line)).toBe(true);
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.startLine > 1 && chunks.some((other) => (
      other !== chunk && other.endLine >= chunk.startLine && other.startLine <= chunk.startLine
    )))).toBe(true);
  });

  it("does not treat a character budget as the tokenizer window", () => {
    const text = [
      "export function keep() {",
      "  const alphabet = \"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\";",
      "  return alphabet;",
      "}",
    ].join("\n");
    const countTokens = (value: string) => value.split(/\s+/u).filter(Boolean).length;
    const chunks = packStructuralUnits({
      documentId: "keep.ts",
      units: [unit(text, { parentName: "keep", parentKind: "function", fallback: false })],
      maxTokens: LOCAL_MINILM_MAX_TOKENS,
      countTokens,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.embedText).toContain("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz");
  });

  it("continue-splits an oversize single line so the original body has no gap", () => {
    const text = "abcdefghijklmnopqrstuvwxyz".repeat(8);
    const countCharacters = (value: string): number => value.length;
    const chunks = packStructuralUnits({
      documentId: "generated.ts",
      units: [unit(text)],
      maxTokens: 32,
      countTokens: countCharacters,
    });

    expect(chunks.length).toBeGreaterThan(1);
    const reconstructed = [...chunks]
      .sort((left, right) => (left.bodyOffset ?? 0) - (right.bodyOffset ?? 0))
      .map((chunk) => chunk.body)
      .join("");
    expect(reconstructed).toBe(text);
    expect(chunks.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1)).toBe(true);
    expect(chunks.every((chunk) => countCharacters(chunk.body) <= 32)).toBe(true);
  });

  it('splits a generated long line without re-tokenizing the remaining file for every piece', () => {
    const text = 'entry '.repeat(100_000);
    let tokenizedCharacters = 0;
    const countTokens = (value: string) => {
      tokenizedCharacters += value.length;
      return value.split(/\s+/u).filter(Boolean).length;
    };
    const chunks = packStructuralUnits({ documentId: 'large-generated.txt', units: [unit(text)],
      maxTokens: 128, countTokens });
    expect(chunks.map(chunk => chunk.body).join('')).toBe(text);
    // Bounded prefix probes plus decoration checks are linear in source size;
    // repeated full-suffix scans in the old splitter exceed this by orders.
    expect(tokenizedCharacters).toBeLessThan(text.length * 25);
    expect(chunks.every(chunk => wordCount(chunk.embedText) <= 128)).toBe(true);
  });

  it("finds a large overlapping line window without probing each rejected size", () => {
    const lineCount = 8_192;
    const text = Array.from({ length: lineCount }, () => "token").join("\n");
    let tokenProbes = 0;
    const countLines = (value: string): number => {
      tokenProbes += 1;
      if (value.length === 0) return 0;
      let count = 1;
      for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) === 10) count += 1;
      }
      return count;
    };
    const chunks = packStructuralUnits({
      documentId: "many-lines.ts",
      units: [unit(text)],
      maxTokens: 4_096,
      countTokens: countLines,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]?.startLine).toBe(1);
    expect(chunks.at(-1)?.endLine).toBe(lineCount);
    expect(chunks.every((chunk) => countLines(chunk.embedText) <= 4_096)).toBe(true);
    expect(chunks[0]!.endLine).toBeGreaterThan(chunks[1]!.startLine);
    expect(tokenProbes).toBeLessThan(60);
  });
});
