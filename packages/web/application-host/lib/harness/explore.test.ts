import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BYTE_BUDGET,
  DEFAULT_CANDIDATE_BUDGET,
  DEFAULT_HITS_PER_FILE,
  buildRgPatterns,
  buildTermGroups,
  explore,
  extractIdentifiers,
  extractQuotedLiterals,
  formatExploreOutput,
  maxMaterializeReads,
  type ExploreDeps,
} from "./explore.js";
import type { ExploreFileSnapshot } from "./explore-file-reader.js";
import { createStructureSource } from "../structure/source.js";
import { createTreeSitterStructureProvider } from "../structure/native-provider.test-helper.js";
import type { StructureOutlineResult, StructureProvider, StructureSource } from "../structure/types.js";

const ready = (content: string, revision = "rev-1"): ExploreFileSnapshot => ({ status: "ready", content, revision, source: "disk" });

/**
 * Slice assertions need a real parse, and the production budget is a wall
 * clock that a loaded runner can exhaust. Pin a budget so these tests do not
 * depend on machine load (D-102).
 */
const parsingProvider = () => createTreeSitterStructureProvider({ parseBudgetMs: 30_000 });

describe("explore query terms", () => {
  it("preserves Unicode, combining marks, single-character and dollar identifiers", () => {
    const terms = extractIdentifiers("where is x $value 计算值 e\u0301 myFunction snake_case");
    expect(terms).toEqual(expect.arrayContaining(["x", "$value", "计算值", "e\u0301", "myFunction", "Function", "snake_case", "snake", "case"]));
    expect(terms).not.toContain("where");
  });

  it("adds useful words for an unspaced Chinese question instead of searching only the full sentence", () => {
    const terms = extractIdentifiers("这个配置在哪里解析");
    expect(terms).toEqual(expect.arrayContaining(["配置", "解析"]));
    expect(terms).not.toContain("这个");
    expect(terms).not.toContain("哪里");
  });

  it("extracts quoted literals without treating regex characters as syntax", () => {
    expect(extractQuotedLiterals('find "a.*b" and ‘中文错误’')).toEqual(["a.*b", "中文错误"]);
    expect(buildRgPatterns(["x", "a.*b"], ["a.*b"])).toEqual([
      { pattern: "a.*b", fixedStrings: true },
      { pattern: "x", fixedStrings: true },
    ]);
  });

  it("does not impose the old twelve-pattern cutoff", () => {
    const ids = Array.from({ length: 21 }, (_, index) => "symbol" + index);
    expect(buildRgPatterns(ids, []).map((entry) => entry.pattern)).toEqual(ids);
  });

  it("keeps blank anchors in supplied and omits them from used", () => {
    const { suppliedAnchors, usedAnchors, groups } = buildTermGroups("needle", ["foo", "", "  "]);
    expect(suppliedAnchors).toEqual(["foo", "", "  "]);
    expect(usedAnchors).toEqual(["foo"]);
    expect(groups.filter((group) => group.kind === "anchor").map((group) => group.distinctive)).toEqual(["foo"]);
  });

  it("groups an identifier with its splits instead of treating each variant as its own concept", () => {
    const { groups } = buildTermGroups("where is createMemoryAgentExtension");
    const identifier = groups.find((group) => group.distinctive === "createMemoryAgentExtension");
    expect(identifier?.kind).toBe("identifier");
    expect(identifier?.variants).toEqual(expect.arrayContaining(["createMemoryAgentExtension", "Agent", "Extension"]));
    expect(groups.filter((group) => group.kind === "identifier")).toHaveLength(1);
  });
});

describe("explore versioned excerpts", () => {
  it("reads one real snapshot per file and deduplicates repeated hits", async () => {
    const content = Array.from({ length: 10 }, (_, index) => index === 6 ? "needle" : "line " + (index + 1)).join("\r\n");
    const readFile = vi.fn(async () => ready(content));
    const result = await explore({ question: "needle needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 7, text: "needle" }, { path: "a.ts", line: 7, text: "needle" }],
      readFile,
    });
    expect(readFile).toHaveBeenCalledOnce();
    expect(result.snippets).toEqual([{
      path: "a.ts", startLine: 4, endLine: 10,
      text: "line 4\nline 5\nline 6\nneedle\nline 8\nline 9\nline 10",
      revision: "rev-1", source: "disk", why: "matched needle",
    }]);
    expect(result.partial).toBe(false);
    expect(result.issues).toEqual([]);
    expect(result.notRequested).toEqual({ count: 0, paths: [] });
  });

  it("never fabricates a range when the document is missing", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "gone.ts", line: 10, text: "needle" }],
      readFile: async () => ({ status: "unavailable", message: "Document is missing." }),
    });
    expect(result.snippets).toEqual([]);
    expect(result.issues).toEqual([{ path: "gone.ts", status: "unavailable", message: "Document is missing." }]);
    expect(result.partial).toBe(true);
    expect(result.details.provenance[0]?.status).toBe("unavailable");
  });

  it("drops hits whose lines changed between search and read", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => ready("different current text", "rev-2"),
    });
    expect(result.snippets).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({ path: "a.ts", status: "stale" })]);
  });

  it("keeps readable evidence when another document fails", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [
        { path: "a.ts", line: 1, text: "needle" },
        { path: "b.ts", line: 1, text: "needle" },
      ],
      readFile: async (path) => path === "a.ts" ? ready("needle\nbody") : { status: "failed", message: "Read failed." },
    });
    expect(result.snippets.map((snippet) => snippet.path)).toEqual(["a.ts"]);
    expect(result.snippets[0]?.endLine).toBe(2);
    expect(result.issues[0]?.path).toBe("b.ts");
    expect(result.partial).toBe(true);
  });

  it("counts distinct query evidence and returns stable ranking", async () => {
    const result = await explore({ question: "needle target" }, {
      rgSearch: async (pattern) => pattern === "needle"
        ? [{ path: "a.ts", line: 1, text: "needle" }, { path: "b.ts", line: 1, text: "needle target" }]
        : [{ path: "b.ts", line: 1, text: "needle target" }],
      readFile: async (path) => ready(path === "a.ts" ? "needle" : "needle target"),
    });
    expect(result.snippets.map((snippet) => snippet.path)).toEqual(["b.ts", "a.ts"]);
    expect(result.snippets[0]?.why).toMatch(/2 term groups/);
    expect(result.searched.files).toBe(2);
  });

  it("honors the requested excerpt count and marks omitted results", async () => {
    const result = await explore({ question: "needle", limit: 1 }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }, { path: "b.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
    });
    expect(result.snippets).toHaveLength(1);
    expect(result.partial).toBe(true);
  });

  it("does not run search after cancellation", async () => {
    const deps: ExploreDeps = { rgSearch: vi.fn(async () => []), readFile: vi.fn(async () => ready("")) };
    await expect(explore({ question: "needle" }, deps, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
    expect(deps.rgSearch).not.toHaveBeenCalled();
    expect(deps.readFile).not.toHaveBeenCalled();
  });

  it("propagates cancellation during reading instead of making a source failure", async () => {
    const controller = new AbortController();
    await expect(explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => { controller.abort(); return ready("needle"); },
    }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not forward the output limit as the candidate search budget", async () => {
    const rgSearch = vi.fn<ExploreDeps["rgSearch"]>(async () => [{ path: "a.ts", line: 1, text: "needle" }]);
    await explore({ question: "needle", limit: 1 }, { rgSearch, readFile: async () => ready("needle") });
    expect(rgSearch).toHaveBeenCalledWith("needle", expect.objectContaining({
      fixedStrings: true,
      candidateBudget: DEFAULT_CANDIDATE_BUDGET,
      hitsPerFile: DEFAULT_HITS_PER_FILE,
    }));
    expect(rgSearch.mock.calls[0]?.[1]).not.toHaveProperty("limit");
  });
});

describe("explore D-090 candidate ranking and materialization", () => {
  it("T1: limit 1 still keeps an anchor hit from a second file in the candidate pool and output", async () => {
    const genericHits = Array.from({ length: 50 }, (_, index) => ({ path: "flood.ts", line: index + 1, text: `token ${index}` }));
    const result = await explore({ question: "token", limit: 1, anchors: ["uniqueAnchor"] }, {
      rgSearch: async (pattern) => pattern === "uniqueAnchor"
        ? [{ path: "key.ts", line: 1, text: "uniqueAnchor" }]
        : genericHits,
      readFile: async (path) => ready(path === "key.ts" ? "uniqueAnchor" : Array.from({ length: 50 }, (_, index) => `token ${index}`).join("\n")),
    });
    expect(result.searched.files).toBe(2);
    expect(result.snippets.some((snippet) => snippet.path === "key.ts")).toBe(true);
    expect(result.snippets).toHaveLength(1);
  });

  it("T3: a full identifier outranks files that only repeat its split words", async () => {
    const result = await explore({ question: "createMemoryAgentExtension" }, {
      rgSearch: async (pattern) => {
        if (pattern === "createMemoryAgentExtension") return [{ path: "src/factory.ts", line: 1, text: "export function createMemoryAgentExtension() {}" }];
        if (pattern === "Agent" || pattern === "Extension") {
          return Array.from({ length: 8 }, (_, index) => ({ path: "src/generic.ts", line: index + 1, text: `Agent Extension ${index}` }));
        }
        return [];
      },
      readFile: async (path) => ready(
        path === "src/factory.ts"
          ? "export function createMemoryAgentExtension() {}"
          : Array.from({ length: 8 }, (_, index) => `Agent Extension ${index}`).join("\n"),
      ),
    });
    expect(result.snippets[0]?.path).toBe("src/factory.ts");
    expect(result.snippets.map((snippet) => snippet.path)).toContain("src/generic.ts");
  });

  it("T4: a hitting anchor ranks first; a miss does not exclude question hits; metacharacters stay literal", async () => {
    const rgSearch = vi.fn(async (pattern: string) => {
      if (pattern === "createMemoryAgentExtension") return [{ path: "src/factory.ts", line: 1, text: "export function createMemoryAgentExtension() {}" }];
      if (pattern === "a.*b") return [{ path: "src/literal.ts", line: 1, text: "const re = \"a.*b\";" }];
      if (pattern === "missingAnchor") return [];
      return [];
    });
    const result = await explore({
      question: "createMemoryAgentExtension",
      anchors: ["a.*b", "missingAnchor"],
    }, {
      rgSearch,
      readFile: async (path) => ready(
        path === "src/literal.ts" ? "const re = \"a.*b\";" : "export function createMemoryAgentExtension() {}",
      ),
    });
    expect(rgSearch).toHaveBeenCalledWith("a.*b", expect.objectContaining({ fixedStrings: true }));
    expect(result.snippets[0]?.path).toBe("src/literal.ts");
    expect(result.snippets.map((snippet) => snippet.path)).toContain("src/factory.ts");
    expect(result.details.anchors.used).toEqual(["a.*b", "missingAnchor"]);
  });

  it("T5: a test file with an exact anchor is not ranked below a generic source file", async () => {
    const result = await explore({ question: "token", anchors: ["exactAnchor"] }, {
      rgSearch: async (pattern) => pattern === "exactAnchor"
        ? [{ path: "src/feature.test.ts", line: 1, text: "exactAnchor" }]
        : [{ path: "src/feature.ts", line: 1, text: "token" }],
      readFile: async (path) => ready(path.endsWith(".test.ts") ? "exactAnchor" : "token"),
    });
    expect(result.snippets[0]?.path).toBe("src/feature.test.ts");
  });

  it("T6: reads on demand, bounds readFile, and reports unread files as not-requested", async () => {
    const files = Array.from({ length: 10 }, (_, index) => `f${index}.ts`);
    const readFile = vi.fn(async (path: string) => ready(`needle in ${path}`));
    const result = await explore({ question: "needle", limit: 2 }, {
      rgSearch: async () => files.map((path) => ({ path, line: 1, text: `needle in ${path}` })),
      readFile,
    });
    const bound = maxMaterializeReads(10, 2);
    expect(bound).toBe(5);
    expect(readFile.mock.calls.length).toBeLessThanOrEqual(bound);
    expect(readFile.mock.calls.length).toBeGreaterThan(0);
    expect(result.snippets).toHaveLength(2);
    expect(result.notRequested.count).toBeGreaterThan(0);
    expect(result.notRequested.paths.length).toBe(result.notRequested.count);
    expect(result.details.provenance.filter((entry) => entry.status === "empty")).toEqual([]);
    expect(result.details.provenance.filter((entry) => entry.status === "not-requested").map((entry) => entry.path))
      .toEqual(result.notRequested.paths);
  });

  it("T7: a second file with a key hit appears even when the first file has many windows", async () => {
    const firstHits = [1, 8, 15, 22, 29].map((line) => ({ path: "first.ts", line, text: `token ${line}` }));
    const result = await explore({ question: "token", anchors: ["keyHit"], limit: 2 }, {
      rgSearch: async (pattern) => pattern === "keyHit"
        ? [{ path: "second.ts", line: 1, text: "keyHit" }]
        : firstHits,
      readFile: async (path) => ready(
        path === "second.ts"
          ? "keyHit"
          : Array.from({ length: 32 }, (_, index) => firstHits.some((hit) => hit.line === index + 1) ? `token ${index + 1}` : `pad ${index + 1}`).join("\n"),
      ),
    });
    expect(result.snippets.map((snippet) => snippet.path).sort()).toEqual(["first.ts", "second.ts"]);
  });

  it("T8: packs to a byte budget, lists omitted supports, and keeps provenance in details", async () => {
    const long = "x".repeat(200);
    const files = Array.from({ length: 8 }, (_, index) => `f${index}.ts`);
    const result = await explore({ question: "needle", limit: 3 }, {
      rgSearch: async () => files.map((path) => ({ path, line: 1, text: `needle in ${path}` })),
      readFile: async (path) => ready(`needle in ${path}\n${long}`),
    });
    const packed = formatExploreOutput(result, { byteBudget: 280 });
    expect(Buffer.byteLength(packed.visibleText, "utf8")).toBeLessThanOrEqual(280);
    expect(packed.omitted.length).toBeGreaterThan(0);
    expect(packed.omitted.some((item) => item.reason === "over byte budget")).toBe(true);
    expect(packed.storedBody).toMatch(/Unread candidates \(not-requested/);
    expect(packed.showHandle).toBe(true);
    expect(result.details.provenance.length).toBe(8);
    expect(result.details.provenance.some((entry) => entry.status === "not-requested")).toBe(true);
    expect(result.details.byteBudget).toBe(DEFAULT_BYTE_BUDGET);
    expect(result.snippets[0]?.revision).toBe("rev-1");
    const withHandle = formatExploreOutput(result, { byteBudget: 280, handle: "out_test" });
    expect(withHandle.showHandle).toBe(true);
    expect(withHandle.visibleText).toContain("get_output(\"out_test\")");
    expect(Buffer.byteLength(withHandle.visibleText, "utf8")).toBeLessThanOrEqual(280);
  });

  it("ranks a single anchor file ahead of files that only match three split-word groups", async () => {
    const splitFiles = Array.from({ length: 10 }, (_, index) => `split${index}.ts`);
    const readFile = vi.fn(async (path: string) => ready(path === "anchor.ts" ? "uniqueAnchor" : "Alpha Beta Gamma"));
    const result = await explore({ question: "Alpha Beta Gamma", anchors: ["uniqueAnchor"], limit: 2 }, {
      rgSearch: async (pattern) => {
        if (pattern === "uniqueAnchor") return [{ path: "anchor.ts", line: 1, text: "uniqueAnchor" }];
        if (pattern === "Alpha" || pattern === "Beta" || pattern === "Gamma") {
          return splitFiles.map((path) => ({ path, line: 1, text: "Alpha Beta Gamma" }));
        }
        return [];
      },
      readFile,
    });
    expect(result.snippets.some((snippet) => snippet.path === "anchor.ts")).toBe(true);
    expect(result.notRequested.paths).not.toContain("anchor.ts");
    expect(readFile.mock.calls.some((call) => call[0] === "anchor.ts")).toBe(true);
  });

  it("reports filesDropped separately from a hit-budget partial", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => ({
        hits: [{ path: "kept.ts", line: 1, text: "needle" }],
        partial: true,
        filesDropped: 13,
      }),
      readFile: async () => ready("needle"),
    });
    expect(result.searched.incomplete).toBe(true);
    expect(result.searched.filesDropped).toBe(13);
    const packed = formatExploreOutput(result);
    expect(packed.visibleText).toMatch(/at least 13 matching file\(s\) were not brought into the candidate pool/);
    expect(packed.visibleText).not.toMatch(/candidate working budget reached/);
  });

  it("reports filesDropped as a floor instead of summing overlapping query terms", async () => {
    const dropsByPattern = new Map<string, number>();
    const result = await explore({ question: "Alpha Beta", anchors: ["myAnchor"] }, {
      rgSearch: async (pattern) => {
        const filesDropped = pattern === "myAnchor" ? 40 : 12;
        dropsByPattern.set(pattern, filesDropped);
        return { hits: [{ path: "kept.ts", line: 1, text: "myAnchor Alpha Beta" }], filesDropped };
      },
      readFile: async () => ready("myAnchor Alpha Beta"),
    });
    const summed = [...dropsByPattern.values()].reduce((sum, count) => sum + count, 0);
    expect(dropsByPattern.size).toBeGreaterThan(1);
    expect(result.searched.filesDropped).toBe(40);
    expect(result.searched.filesDropped).toBeLessThan(summed);
    expect(result.searched.incomplete).toBe(true);
  });

  it("formats confirmed connections separately from association candidates and counts them against the byte budget", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "router.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
    });
    const withoutGraph = formatExploreOutput(result);
    const withGraph = formatExploreOutput({
      ...result,
      relations: {
        status: "ready",
        files: [{
          path: "router.ts",
          documentRevision: result.snippets[0]!.revision,
          stale: false,
          incomplete: false,
          imports: [{ specifier: "./protocol", line: 1 }],
          connections: [{ callee: "register", literal: "explore.search", line: 4 }],
          associations: [{ callee: "log", literal: "explore.search", line: 5 }],
        }],
      },
    });
    expect(withoutGraph.visibleText).not.toContain("Relations");
    expect(withGraph.visibleText).toContain("router.ts imports ./protocol (L1)");
    expect(withGraph.visibleText).toContain("router.ts connects register(\"explore.search\") (L4)");
    expect(withGraph.visibleText).toContain("router.ts associates log(\"explore.search\") (L5) [candidate]");
    expect(withGraph.storedBody).toContain("same-string candidates");
    const tight = formatExploreOutput({
      ...result,
      relations: {
        status: "ready",
        files: [{
          path: "router.ts",
          documentRevision: result.snippets[0]!.revision,
          stale: false,
          incomplete: false,
          imports: [{ specifier: "./protocol", line: 1 }],
          connections: [],
          associations: [],
        }],
      },
    }, { byteBudget: Buffer.byteLength(withoutGraph.visibleText, "utf8") });
    expect(tight.visibleText).not.toContain("imports ./protocol");
    expect(Buffer.byteLength(tight.visibleText, "utf8")).toBeLessThanOrEqual(Buffer.byteLength(withoutGraph.visibleText, "utf8"));
  });

  it("drops relation line numbers when the graph revision is not the excerpt revision", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "router.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
    });
    const formatted = formatExploreOutput({
      ...result,
      relations: {
        status: "ready",
        files: [{
          path: "router.ts",
          documentRevision: "disk-older",
          stale: true,
          incomplete: false,
          imports: [],
          connections: [{ callee: "register", literal: "gone.handler", line: 3 }],
          associations: [],
        }],
      },
    });
    expect(formatted.visibleText).toContain("stale @disk-older");
    expect(formatted.visibleText).toContain("connects register(\"gone.handler\")");
    expect(formatted.visibleText).not.toContain("(L3)");
  });

  it("reports a graph that could not answer, and keeps issues ahead of relations in the budget", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [
        { path: "router.ts", line: 1, text: "needle" },
        { path: "broken.ts", line: 1, text: "needle" },
      ],
      readFile: async (path) => (path === "broken.ts"
        ? { status: "failed", message: "disk read failed" }
        : ready("needle")),
    });
    const unavailable = formatExploreOutput({ ...result, relations: { status: "unavailable", files: [] } });
    expect(unavailable.visibleText).toContain("Relations unavailable");

    const issueLine = result.issues[0]!;
    const manyEdges = Array.from({ length: 40 }, (_, index) => ({
      callee: "register", literal: `handler-${index}`, line: index + 1,
    }));
    const crowded = formatExploreOutput({
      ...result,
      relations: {
        status: "ready",
        files: [{
          path: "router.ts",
          documentRevision: result.snippets[0]!.revision,
          stale: false,
          incomplete: false,
          imports: [],
          connections: manyEdges,
          associations: [],
        }],
      },
    });
    expect(crowded.visibleText).toContain(issueLine.path);
    expect(crowded.visibleText).toContain("more edge(s) omitted");
    expect(crowded.visibleText.split("\n").filter((line) => line.includes("connects register")).length).toBe(12);
  });
});

const structureSource = (outline: StructureOutlineResult): Pick<StructureSource, "outline" | "classifyHits"> => ({
  outline: async (request) => ({ ...outline, revision: outline.status === "stale" ? outline.revision : request.revision }),
  classifyHits: async (request) => ({ status: "unsupported", provider: outline.provider, revision: request.revision, hits: [] }),
});

describe("explore structure slices", () => {
  it("uses a small function in full when the outline is ready", async () => {
    const content = "export function needle() {\n  return 1;\n}\n";
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "small.ts", line: 1, text: "export function needle() {" }],
      readFile: async () => ready(content),
      structure: structureSource({
        status: "ready",
        provider: "lsp",
        revision: "rev-1",
        symbols: [{
          name: "needle",
          kind: "function",
          range: { startLine: 1, endLine: 3 },
          signature: { startLine: 1, endLine: 1 },
        }],
      }),
    });
    expect(result.snippets[0]).toMatchObject({
      path: "small.ts",
      startLine: 1,
      endLine: 3,
      text: "export function needle() {\n  return 1;\n}",
      unit: { name: "needle", kind: "function", startLine: 1, endLine: 3 },
      structure: { provider: "lsp", status: "ready" },
    });
    expect(result.details.structure?.files).toEqual([{ path: "small.ts", provider: "lsp", status: "ready" }]);
  });

  it("keeps signature, hit block, omission markers, and a full-unit read entry for a large function", async () => {
    const body = Array.from({ length: 48 }, (_, index) => index === 23 ? "  const needle = 1;" : `  const pad${index} = ${index};`);
    const content = ["export function largeTarget() {", ...body, "}"].join("\n");
    const hitLine = 25;
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "large.ts", line: hitLine, text: "  const needle = 1;" }],
      readFile: async () => ready(content),
      structure: structureSource({
        status: "ready",
        provider: "lsp",
        revision: "rev-1",
        symbols: [{
          name: "largeTarget",
          kind: "function",
          range: { startLine: 1, endLine: 50 },
          signature: { startLine: 1, endLine: 1 },
        }],
      }),
    });
    const snippet = result.snippets[0];
    expect(snippet?.structure).toEqual({ provider: "lsp", status: "ready" });
    expect(snippet?.unit).toMatchObject({ name: "largeTarget", kind: "function", startLine: 1, endLine: 50 });
    expect(snippet?.unit?.omitted?.length).toBeGreaterThan(0);
    expect(snippet?.text.startsWith("export function largeTarget() {")).toBe(true);
    expect(snippet?.text).toContain("const needle = 1;");
    expect(snippet?.text).toContain("read large.ts:1-50");
    expect(snippet?.text).toMatch(/… omitted large\.ts:\d+-\d+/);
    expect(snippet?.endLine).toBeLessThan(50);
    const packed = formatExploreOutput(result);
    expect(packed.visibleText).toMatch(/unit largeTarget \(function\) large\.ts:1-50/);
    expect(packed.visibleText).toMatch(/structure lsp\/ready/);
  });

  it("falls back to a ±3 window and reports the source status when structure is unavailable", async () => {
    const content = Array.from({ length: 10 }, (_, index) => index === 6 ? "needle" : `line ${index + 1}`).join("\n");
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 7, text: "needle" }],
      readFile: async () => ready(content),
      structure: structureSource({
        status: "unavailable",
        provider: "lsp",
        revision: "rev-1",
        symbols: [],
        message: "Language server is not ready for document symbols.",
      }),
    });
    expect(result.snippets[0]).toMatchObject({
      path: "a.ts",
      startLine: 4,
      endLine: 10,
      text: "line 4\nline 5\nline 6\nneedle\nline 8\nline 9\nline 10",
      structure: { provider: "lsp", status: "unavailable" },
    });
    expect(result.snippets[0]?.unit).toBeUndefined();
    expect(result.details.structure?.files[0]?.status).toBe("unavailable");
  });

  it("does not slice with a stale outline", async () => {
    const content = Array.from({ length: 10 }, (_, index) => index === 6 ? "needle" : `line ${index + 1}`).join("\n");
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 7, text: "needle" }],
      readFile: async () => ready(content, "rev-new"),
      structure: {
        outline: async () => ({
          status: "stale",
          provider: "lsp",
          revision: "rev-old",
          symbols: [{
            name: "oldNeedle",
            kind: "function",
            range: { startLine: 1, endLine: 10 },
            signature: { startLine: 1, endLine: 1 },
          }],
        }),
        classifyHits: async () => ({ status: "unsupported", provider: "lsp", revision: "rev-old", hits: [] }),
      },
    });
    expect(result.snippets[0]).toMatchObject({
      startLine: 4,
      endLine: 10,
      structure: { provider: "lsp", status: "stale" },
    });
    expect(result.snippets[0]?.unit).toBeUndefined();
    expect(result.snippets[0]?.text).toContain("needle");
    expect(result.snippets[0]?.text).not.toContain("omitted");
    expect(result.details.structure?.files[0]).toEqual({ path: "a.ts", provider: "lsp", status: "stale" });
  });

  it("ranks a declaration-name hit ahead of the same token in a comment", async () => {
    const result = await explore({ question: "needle", limit: 2 }, {
      rgSearch: async () => [
        { path: "name.ts", line: 1, text: "export function needle() {" },
        { path: "comment.ts", line: 1, text: "// needle" },
      ],
      readFile: async (path) => ready(path === "name.ts" ? "export function needle() {\n  return 1;\n}" : "// needle\nexport function other() {\n  return 2;\n}"),
      structure: {
        outline: async (request) => ({
          status: "ready",
          provider: "tree-sitter",
          revision: request.revision,
          symbols: request.path === "name.ts"
            ? [{ name: "needle", kind: "function", range: { startLine: 1, endLine: 3 }, signature: { startLine: 1, endLine: 1 } }]
            : [{ name: "other", kind: "function", range: { startLine: 2, endLine: 4 }, signature: { startLine: 2, endLine: 2 } }],
        }),
        classifyHits: async (request) => ({
          status: "ready",
          provider: "tree-sitter",
          revision: request.revision,
          hits: request.lines.map((line) => ({
            line,
            class: request.path === "name.ts" ? "name" as const : "comment" as const,
          })),
        }),
      },
    });
    expect(result.snippets.map((snippet) => snippet.path)).toEqual(["name.ts", "comment.ts"]);
  });

  it("does not classify unread candidates", async () => {
    const classified: string[] = [];
    const hits = Array.from({ length: 8 }, (_, index) => ({
      path: `file-${index}.ts`,
      line: 1,
      text: "export function needle() {",
    }));
    const result = await explore({ question: "needle", limit: 1 }, {
      rgSearch: async () => hits,
      readFile: async () => ready("export function needle() {\n  return 1;\n}"),
      structure: {
        outline: async (request) => ({
          status: "ready",
          provider: "tree-sitter",
          revision: request.revision,
          symbols: [{ name: "needle", kind: "function", range: { startLine: 1, endLine: 3 }, signature: { startLine: 1, endLine: 1 } }],
        }),
        classifyHits: async (request) => {
          classified.push(request.path);
          return { status: "ready", provider: "tree-sitter", revision: request.revision, hits: request.lines.map((line) => ({ line, class: "name" as const })) };
        },
      },
    });
    expect(classified.length).toBeGreaterThan(0);
    expect(classified).not.toContain("file-7.ts");
    expect(result.notRequested.paths).toContain("file-7.ts");
  });

  it("keeps anchor-first complementary packing when structure slices are present", async () => {
    const result = await explore({ question: "token", anchors: ["keyHit"], limit: 2 }, {
      rgSearch: async (pattern) => pattern === "keyHit"
        ? [{ path: "second.ts", line: 1, text: "keyHit" }]
        : [1, 8, 15, 22, 29].map((line) => ({ path: "first.ts", line, text: `token ${line}` })),
      readFile: async (path) => ready(
        path === "second.ts"
          ? "keyHit"
          : Array.from({ length: 32 }, (_, index) => [1, 8, 15, 22, 29].includes(index + 1) ? `token ${index + 1}` : `pad ${index + 1}`).join("\n"),
      ),
      structure: structureSource({
        status: "unavailable",
        provider: "lsp",
        revision: "rev-1",
        symbols: [],
      }),
    });
    expect(result.snippets.map((snippet) => snippet.path).sort()).toEqual(["first.ts", "second.ts"]);
    expect(result.snippets[0]?.path).toBe("second.ts");
  });

  it("keeps a value-binding hit inside its enclosing function, not a one-line unit", async () => {
    const body = Array.from({ length: 47 }, (_, index) => {
      if (index === 44) return "  const needle = 1;";
      if (index === 45) return "  handle(needle);";
      return `  const pad${index} = ${index};`;
    });
    const content = ["export function big() {", ...body, "}"].join("\n");
    const lines = content.split("\n");
    const constLine = lines.findIndex((line) => line.includes("const needle")) + 1;
    const callLine = lines.findIndex((line) => line.includes("handle(needle)")) + 1;
    const structure = createStructureSource([parsingProvider()]);
    const run = (line: number, text: string) => explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "big.ts", line, text }],
      readFile: async () => ready(content),
      structure,
    });

    const onConst = await run(constLine, "  const needle = 1;");
    expect(onConst.snippets[0]?.unit).toMatchObject({ name: "big", kind: "function", startLine: 1, endLine: lines.length });
    expect(onConst.snippets[0]?.text.startsWith("export function big() {")).toBe(true);
    expect(onConst.snippets[0]?.text).toContain("const needle = 1;");
    expect(onConst.snippets[0]?.text).toMatch(/read big\.ts:1-\d+/);
    expect(onConst.snippets[0]?.text.split("\n").length).toBeGreaterThan(3);

    const onCall = await run(callLine, "  handle(needle);");
    expect(onCall.snippets[0]?.unit).toMatchObject({ name: "big", kind: "function" });
    expect(onCall.snippets[0]?.text.startsWith("export function big() {")).toBe(true);
    expect(onCall.snippets[0]?.text).toContain("handle(needle);");

    const without = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "big.ts", line: constLine, text: "  const needle = 1;" }],
      readFile: async () => ready(content),
    });
    expect(without.snippets[0]?.unit).toBeUndefined();
    expect(without.snippets[0]?.startLine).toBe(constLine - 3);
    expect(without.snippets[0]?.endLine).toBe(constLine + 3);
    expect(onConst.snippets[0]!.text.length).toBeGreaterThan(without.snippets[0]!.text.length);
  });

  it("keeps a definition binding as its own explore unit", async () => {
    const content = [
      "export function wrap() {",
      "  const foo = () => {",
      "    return needle;",
      "  };",
      "  return foo;",
      "}",
    ].join("\n");
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "bind.ts", line: 3, text: "    return needle;" }],
      readFile: async () => ready(content),
      structure: createStructureSource([parsingProvider()]),
    });
    expect(result.snippets[0]?.unit).toMatchObject({ name: "foo", kind: "function", startLine: 2, endLine: 4 });
    expect(result.snippets[0]?.text).toContain("const foo = () => {");
    expect(result.snippets[0]?.text).toContain("return needle;");
  });

  it("slices from tree-sitter when the language-server provider is cold", async () => {
    const unavailableLsp: StructureProvider = {
      id: "lsp",
      capabilities: () => ({ outline: true, classifyHits: false, literalCalls: false, imports: false }),
      outline: async (request) => ({
        status: "unavailable",
        provider: "lsp",
        revision: request.revision,
        symbols: [],
        message: "Language server is still starting.",
      }),
      classifyHits: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, hits: [] }),
      literalCalls: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, calls: [] }),
      imports: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, imports: [] }),
    };
    const content = [
      "export function decoy() {",
      "  return 0;",
      "}",
      "export function needle() {",
      "  return 1;",
      "}",
    ].join("\n");
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "cold.ts", line: 4, text: "export function needle() {" }],
      readFile: async () => ready(content),
      structure: createStructureSource([parsingProvider(), unavailableLsp]),
    });
    expect(result.snippets[0]).toMatchObject({
      path: "cold.ts",
      startLine: 4,
      endLine: 6,
      text: "export function needle() {\n  return 1;\n}",
      unit: { name: "needle", kind: "function", startLine: 4, endLine: 6 },
      structure: { provider: "tree-sitter", status: "ready" },
    });
    expect(result.details.structure?.files).toEqual([{ path: "cold.ts", provider: "tree-sitter", status: "ready" }]);
  });

  it("falls back when tree-sitter wasm is missing and does not fail the tool", async () => {
    const missing = createTreeSitterStructureProvider({
      runtimeFromUrl: pathToFileURL(join(mkdtempSync(join(tmpdir(), "varin-missing-structure-")), "index.js")).href,
    });
    const content = Array.from({ length: 10 }, (_, index) => index === 6 ? "needle" : `line ${index + 1}`).join("\n");
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 7, text: "needle" }],
      readFile: async () => ready(content),
      structure: createStructureSource([missing]),
    });
    expect(result.snippets[0]).toMatchObject({
      startLine: 4,
      endLine: 10,
      structure: { provider: "tree-sitter", status: "unavailable" },
    });
    expect(result.snippets[0]?.unit).toBeUndefined();
  });

  it("slices a JavaScript hit to its function and a JSX hit to its component", async () => {
    const js = [
      "function decoy() { return 0; }",
      "function boot() {",
      "  router.register(\"explore.search\");",
      "  return 1;",
      "}",
    ].join("\n");
    const jsx = [
      "export function decoy() { return null; }",
      "export function Badge() {",
      "  return <span>needle</span>;",
      "}",
    ].join("\n");
    const structure = createStructureSource([parsingProvider()]);
    const jsResult = await explore({ question: "explore.search" }, {
      rgSearch: async () => [{ path: "boot.js", line: 3, text: "  router.register(\"explore.search\");" }],
      readFile: async () => ready(js),
      structure,
    });
    expect(jsResult.snippets[0]).toMatchObject({
      path: "boot.js",
      unit: { name: "boot", kind: "function" },
      structure: { provider: "tree-sitter", status: "ready" },
    });
    expect(jsResult.snippets[0]?.text).toContain("router.register");
    const jsxResult = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "Badge.jsx", line: 3, text: "  return <span>needle</span>;" }],
      readFile: async () => ready(jsx),
      structure,
    });
    expect(jsxResult.snippets[0]).toMatchObject({
      path: "Badge.jsx",
      unit: { name: "Badge", kind: "function" },
    });
  });

  it("slices a large JSON hit to the enclosing object instead of a ±3 window", async () => {
    const lines = [
      "{",
      ...Array.from({ length: 40 }, (_, index) => `  "pad${index}": ${index},`),
      "  \"config\": {",
      "    \"enabled\": true,",
      "    \"needle\": \"hit\"",
      "  }",
      "}",
    ];
    const content = lines.join("\n");
    const hitLine = lines.findIndex((line) => line.includes("needle")) + 1;
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "big.json", line: hitLine, text: "    \"needle\": \"hit\"" }],
      readFile: async () => ready(content),
      structure: createStructureSource([parsingProvider()]),
    });
    expect(result.snippets[0]?.unit).toMatchObject({ name: "config" });
    expect(result.snippets[0]?.text).toContain("\"needle\": \"hit\"");
    expect(result.snippets[0]?.text).not.toContain("\"pad0\"");
    expect((result.snippets[0]?.endLine ?? 0) - (result.snippets[0]?.startLine ?? 0)).toBeLessThan(8);
  });
});

describe("explore graph path recall", () => {
  const files = new Map<string, string>([
    ["aaa.ts", "export function uniqueDefName() { return 1; }\n"],
    ["def.ts", "export function uniqueDefName() { return 2; }\n"],
    ["request.ts", "export function uniqueWireHandler() { return request(\"unique.wire.literal\"); }\n"],
    ["register.ts", "router.register(\"unique.wire.literal\");\n"],
    ["core.ts", "export function uniqueCoreName() { return 1; }\n"],
    ["app.ts", "import { uniqueCoreName } from \"./core.js\";\nexport const boot = uniqueCoreName;\n"],
    ["caller.ts", "export const driver = () => uniqueTarget();\n"],
    ["missing.ts", "export function other() { return 1; }\n"],
  ]);

  const readNamed = async (path: string): Promise<ExploreFileSnapshot> => {
    const content = files.get(path);
    return content ? ready(content) : { status: "unavailable", message: "missing" };
  };

  it("prefers a catalog definition over a same-term mention when ranking", async () => {
    const result = await explore({ question: "uniqueDefName", limit: 1 }, {
      rgSearch: async () => [
        { path: "aaa.ts", line: 1, text: "export function uniqueDefName() { return 1; }" },
        { path: "def.ts", line: 1, text: "export function uniqueDefName() { return 2; }" },
      ],
      readFile: readNamed,
      graph: {
        catalogStats: async () => ({ symbolCount: 2 }),
        searchDefinitions: async (query) => query === "uniqueDefName"
          ? [{ name: "uniqueDefName", path: "def.ts", kind: "function", match: "exact" as const }]
          : [],
        findLinks: async () => [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets[0]?.path).toBe("def.ts");
    expect(result.snippets[0]?.why).toContain("definition of uniqueDefName (function)");
    expect(result.details.graph).toMatchObject({ status: "ready", definitions: 1 });
  });

  it("brings in the other end of a connection that rg never candidate-selected", async () => {
    const result = await explore({ question: "uniqueWireHandler" }, {
      rgSearch: async () => [
        { path: "request.ts", line: 1, text: "export function uniqueWireHandler() { return request(\"unique.wire.literal\"); }" },
      ],
      readFile: readNamed,
      graph: {
        catalogStats: async () => ({ symbolCount: 2 }),
        searchDefinitions: async () => [],
        findLinks: async (value) => value === "unique.wire.literal"
          ? [
            { path: "request.ts", kind: "connects", value, callee: "request" },
            { path: "register.ts", kind: "connects", value, callee: "register" },
          ]
          : [],
        fileRelations: async (path) => path === "request.ts"
          ? { connections: [{ callee: "request", literal: "unique.wire.literal" }], linksIncomplete: false }
          : null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets.map((snippet) => snippet.path)).toEqual(expect.arrayContaining(["request.ts", "register.ts"]));
    const other = result.snippets.find((snippet) => snippet.path === "register.ts");
    expect(other?.why).toContain("other end of connection \"unique.wire.literal\"");
    expect(other?.why).not.toMatch(/matched uniqueWireHandler/);
    expect(result.details.graph?.status).toBe("ready");
    expect(result.details.graph?.connections).toBeGreaterThanOrEqual(1);
  });

  it("brings in a resolved call site the graph remembers, even with no rg hit on the name", async () => {
    const result = await explore({ question: "uniqueTarget" }, {
      rgSearch: async () => [
        { path: "missing.ts", line: 1, text: "export function other() { return 1; }" },
      ],
      readFile: readNamed,
      graph: {
        catalogStats: async () => ({ symbolCount: 3 }),
        searchDefinitions: async () => [],
        findLinks: async () => [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
        findCallers: async (name) => name === "uniqueTarget"
          ? [{
            path: "caller.ts",
            line: 1,
            caller: "driver",
            targetPath: "def.ts",
            targetName: "uniqueTarget",
            pinned: true,
            resolvedBy: "lsp.callHierarchy.incoming",
          }]
          : [],
        findReferences: async () => [],
      },
    });
    const caller = result.snippets.find((snippet) => snippet.path === "caller.ts");
    expect(caller).toBeTruthy();
    expect(caller?.why).toContain("calls uniqueTarget");
    expect(result.details.graph?.status).toBe("ready");
    expect(result.details.graph?.relations).toBe(1);
  });

  it("adds a reverse-import candidate and does not pretend it was an rg hit", async () => {
    const result = await explore({ question: "uniqueCoreName" }, {
      rgSearch: async () => [
        { path: "core.ts", line: 1, text: "export function uniqueCoreName() { return 1; }" },
      ],
      readFile: readNamed,
      graph: {
        catalogStats: async () => ({ symbolCount: 1 }),
        searchDefinitions: async () => [],
        findLinks: async () => [],
        fileRelations: async () => null,
        findImporters: async (path) => path === "core.ts"
          ? { resolved: [{ path: "app.ts", specifier: "./core.js" }] }
          : { resolved: [] },
      },
    });
    const importer = result.snippets.find((snippet) => snippet.path === "app.ts");
    expect(importer?.why).toContain("imports core.ts");
    expect(importer?.text).toContain("./core.js");
  });

  it("omits a graph path when the current text no longer contains the symbol name", async () => {
    const result = await explore({ question: "ghostName" }, {
      rgSearch: async () => [],
      readFile: readNamed,
      graph: {
        catalogStats: async () => ({ symbolCount: 1 }),
        searchDefinitions: async () => [
          { name: "ghostName", path: "missing.ts", kind: "function", match: "exact" as const },
        ],
        findLinks: async () => [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets).toEqual([]);
    expect(result.details.provenance.find((entry) => entry.path === "missing.ts")?.status).toBe("empty");
  });

  it("reports unavailable instead of failed when the graph store is not open", async () => {
    const result = await explore({ question: "uniqueDefName" }, {
      rgSearch: async () => [
        { path: "aaa.ts", line: 1, text: "export function uniqueDefName() { return 1; }" },
      ],
      readFile: readNamed,
      graph: {
        catalogStats: async () => {
          throw Object.assign(new Error("knowledge store is not open"), { code: "unavailable" });
        },
        searchDefinitions: async () => [],
        findLinks: async () => [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets[0]?.path).toBe("aaa.ts");
    expect(result.details.graph?.status).toBe("unavailable");
  });

  it("keeps rg excerpts when the graph store is unusable", async () => {
    const result = await explore({ question: "uniqueDefName" }, {
      rgSearch: async () => [
        { path: "aaa.ts", line: 1, text: "export function uniqueDefName() { return 1; }" },
      ],
      readFile: readNamed,
      graph: {
        catalogStats: async () => {
          throw new Error("knowledge store is corrupt");
        },
        searchDefinitions: async () => [],
        findLinks: async () => [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets[0]?.path).toBe("aaa.ts");
    expect(result.details.graph?.status).toBe("failed");
  });

  it("reports an empty catalog instead of ready when no symbols were collected", async () => {
    const result = await explore({ question: "uniqueDefName" }, {
      rgSearch: async () => [
        { path: "aaa.ts", line: 1, text: "export function uniqueDefName() { return 1; }" },
      ],
      readFile: readNamed,
      graph: {
        catalogStats: async () => ({ symbolCount: 0 }),
        searchDefinitions: async () => {
          throw new Error("should not search an empty catalog");
        },
        findLinks: async () => [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.details.graph?.status).toBe("empty");
    expect(result.snippets[0]?.path).toBe("aaa.ts");
  });

  it("takes filesDropped as a floor across rg and graph instead of summing", async () => {
    const result = await explore({ question: "uniqueDefName" }, {
      rgSearch: async () => ({
        hits: [{ path: "aaa.ts", line: 1, text: "export function uniqueDefName() { return 1; }" }],
        filesDropped: 12,
      }),
      readFile: readNamed,
      graph: {
        catalogStats: async () => ({ symbolCount: 40 }),
        searchDefinitions: async () => Array.from({ length: 50 }, (_, index) => ({
          name: "uniqueDefName",
          path: `extra-${index}.ts`,
          kind: "function",
          match: "exact" as const,
        })),
        findLinks: async () => [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.searched.filesDropped).toBeGreaterThanOrEqual(12);
    expect(result.details.graph?.filesDropped).toBeGreaterThan(0);
    expect(result.searched.filesDropped).toBe(Math.max(12, result.details.graph?.filesDropped ?? 0));
  });
});

describe("explore 3.13 ranking and verification", () => {
  it("does not let path-alphabetical rg hits beat a later source file that has the register call", async () => {
    const result = await explore({ question: "where is explore.search registered" }, {
      rgSearch: async (pattern) => {
        if (pattern !== "explore.search") return [];
        return [
          { path: "bun.lock", line: 1, text: "explore.search" },
          { path: "docs/design/agent-harness.md", line: 1, text: "explore.search is registered on the host" },
          { path: "packages/web/application-host/lib/harness/harness-services.ts", line: 1, text: "register(\"explore.search\", createExploreSearchService)" },
        ];
      },
      readFile: async (path) => {
        if (path.endsWith("harness-services.ts")) return ready("register(\"explore.search\", createExploreSearchService)");
        if (path === "bun.lock") return ready("explore.search");
        return ready("explore.search is registered on the host");
      },
    });
    expect(result.snippets[0]?.path).toContain("harness-services.ts");
    expect(result.snippets[0]?.text).toContain("register(\"explore.search\"");
    expect(result.details.query).toMatchObject({ objects: ["explore.search"], relation: "register", domain: "implementation" });
  });

  it("still reads a graph-selected source file that rg already had in the pool", async () => {
    const readFile = vi.fn(async (path: string) => (
      path === "zzz-source.ts"
        ? ready("router.register(\"explore.search\", handler);")
        : ready("mention explore.search in prose")
    ));
    const result = await explore({ question: "where is explore.search registered" }, {
      rgSearch: async () => [
        { path: "aaa-docs.md", line: 1, text: "mention explore.search in prose" },
        { path: "zzz-source.ts", line: 1, text: "router.register(\"explore.search\", handler);" },
      ],
      readFile,
      graph: {
        catalogStats: async () => ({ symbolCount: 4 }),
        searchDefinitions: async () => [],
        findLinks: async (value) => value === "explore.search"
          ? [{ path: "zzz-source.ts", kind: "connects", value, callee: "register" }]
          : [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(readFile.mock.calls.some((call) => call[0] === "zzz-source.ts")).toBe(true);
    expect(result.snippets.some((snippet) => snippet.path === "zzz-source.ts")).toBe(true);
    expect(result.notRequested.paths).not.toContain("zzz-source.ts");
  });

  it("relocates a stale graph hint in current text and drops it when the object is gone", async () => {
    const result = await explore({ question: "explore.search" }, {
      rgSearch: async () => [],
      readFile: async () => ready("export function other() { return 1; }\n"),
      graph: {
        catalogStats: async () => ({ symbolCount: 1 }),
        searchDefinitions: async () => [],
        findLinks: async () => [{ path: "moved.ts", kind: "connects", value: "explore.search", callee: "register" }],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets).toEqual([]);
    expect(result.details.provenance.find((entry) => entry.path === "moved.ts")?.status).toBe("empty");
  });

  it("keeps rg excerpts when the graph is unavailable", async () => {
    const result = await explore({ question: "where is explore.search registered" }, {
      rgSearch: async () => [{ path: "src/router.ts", line: 1, text: "register(\"explore.search\")" }],
      readFile: async () => ready("register(\"explore.search\")"),
      graph: {
        catalogStats: async () => {
          throw Object.assign(new Error("knowledge store is not open"), { code: "unavailable" });
        },
        searchDefinitions: async () => [],
        findLinks: async () => [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets[0]?.path).toBe("src/router.ts");
    expect(result.details.graph?.status).toBe("unavailable");
  });

  it("prefers the production register over a same-name test fixture when the question asks for the host entry", async () => {
    const result = await explore({ question: "where is explore.search registered on the host router" }, {
      rgSearch: async () => [
        { path: "src/harness-services.ts", line: 1, text: "register(\"explore.search\", service)" },
        { path: "test/session-e2e.test.ts", line: 1, text: "register(\"explore.search\", fake)" },
      ],
      readFile: async (path) => ready(path.includes("test") ? "register(\"explore.search\", fake)" : "register(\"explore.search\", service)"),
      graph: {
        catalogStats: async () => ({ symbolCount: 2 }),
        searchDefinitions: async () => [],
        findLinks: async () => [
          { path: "src/harness-services.ts", kind: "connects", value: "explore.search", callee: "register" },
          { path: "test/session-e2e.test.ts", kind: "connects", value: "explore.search", callee: "register" },
        ],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets[0]?.path).toBe("src/harness-services.ts");
  });

  it("returns the current text when structure cannot verify a register relation", async () => {
    const result = await explore({ question: "where is explore.search registered" }, {
      rgSearch: async () => [{ path: "src/router.ts", line: 1, text: "register(\"explore.search\")" }],
      readFile: async () => ready("register(\"explore.search\")"),
      structure: {
        outline: async (request) => ({ status: "unsupported", provider: "tree-sitter", revision: request.revision, symbols: [] }),
        classifyHits: async (request) => ({ status: "unsupported", provider: "tree-sitter", revision: request.revision, hits: [] }),
        literalCalls: async (request) => ({ status: "unsupported", provider: "tree-sitter", revision: request.revision, calls: [] }),
      },
      graph: {
        catalogStats: async () => ({ symbolCount: 1 }),
        searchDefinitions: async () => [],
        findLinks: async () => [{ path: "src/router.ts", kind: "connects", value: "explore.search", callee: "register" }],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets[0]?.text).toContain("register(\"explore.search\")");
    expect(result.snippets[0]?.why).not.toMatch(/verified register\(/);
    expect(result.snippets[0]?.why).toMatch(/graph pointed here|other end of connection/);
  });

  it("binds a definition clue to the window that contains it, not every window in the file", async () => {
    const content = [
      "export function createExploreFixture() { return explore; }",
      "export function other() { return explore; }",
      "export function third() { return explore; }",
    ].join("\n");
    const result = await explore({ question: "createExploreFixture", limit: 3 }, {
      rgSearch: async (pattern) => {
        if (pattern === "createExploreFixture") return [{ path: "session-e2e.test.ts", line: 1, text: "export function createExploreFixture() { return explore; }" }];
        if (pattern === "explore") {
          return [
            { path: "session-e2e.test.ts", line: 1, text: "export function createExploreFixture() { return explore; }" },
            { path: "session-e2e.test.ts", line: 2, text: "export function other() { return explore; }" },
            { path: "session-e2e.test.ts", line: 3, text: "export function third() { return explore; }" },
          ];
        }
        return [];
      },
      readFile: async () => ready(content),
      graph: {
        catalogStats: async () => ({ symbolCount: 1 }),
        searchDefinitions: async (query) => query === "createExploreFixture"
          ? [{ name: "createExploreFixture", path: "session-e2e.test.ts", kind: "function", match: "exact" as const }]
          : [],
        findLinks: async () => [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    const defined = result.snippets.filter((snippet) => snippet.why.includes("definition of createExploreFixture"));
    expect(defined.length).toBe(1);
    expect(defined[0]?.text).toContain("createExploreFixture");
  });

  it("packs the production registration ahead of a test fixture that registers the same value", async () => {
    // Both bodies carry register("explore.search"), so relation evidence is
    // comparable and only the file role separates them. D-148 asks for the
    // production entry when the question is about the host implementation.
    const production = [
      "export function registerHarnessServices(router: Router) {",
      "  register(\"explore.search\", createExploreSearchService);",
      "  return router;",
      "}",
    ].join("\n");
    const fixture = [
      "export function fixture() {",
      "  const host = createServiceHost();",
      "  const router = createRouter();",
      "  register(\"explore.search\", createExploreSearchService);",
      "  return { host, router, registered: true };",
      "}",
    ].join("\n");
    const result = await explore({ question: "where is the explore.search service registered on the host router", limit: 3 }, {
      rgSearch: async (pattern) => {
        const hits = [];
        if (pattern === "explore.search") {
          hits.push({ path: "src/harness-services.ts", line: 2, text: "  register(\"explore.search\", createExploreSearchService);" });
          hits.push({ path: "src/explore-service.test.ts", line: 4, text: "  register(\"explore.search\", createExploreSearchService);" });
        }
        if (pattern === "host" || pattern === "router" || pattern === "registered") {
          hits.push({ path: "src/explore-service.test.ts", line: 2, text: "  const host = createServiceHost();" });
        }
        return hits;
      },
      readFile: async (path) => ready(path === "src/harness-services.ts" ? production : fixture),
      structure: createStructureSource([parsingProvider()]),
    });
    const paths = result.snippets.map((snippet) => snippet.path);
    expect(paths).toContain("src/harness-services.ts");
    expect(paths.indexOf("src/harness-services.ts")).toBeLessThan(paths.indexOf("src/explore-service.test.ts"));
  });

  it("rebuilds windows of an already-read file when the content-word pass adds hits", async () => {
    // The object pass reads the file for `tree-sitter` and slices the mention;
    // `parse`/`budget` arrive in the later pass, when the file is already read.
    const content = [
      "function ensureRuntime() {",
      "  const runtime = \"tree-sitter\";",
      "  return runtime.length > 0;",
      "}",
      ...Array.from({ length: 40 }, (_, index) => `const pad${index} = ${index};`),
      "function parseDocument(elapsed: number, parseBudget: number) {",
      "  if (elapsed > parseBudget) {",
      "    throw new Error(\"parse budget exceeded\");",
      "  }",
      "  return true;",
      "}",
    ].join("\n");
    const lines = content.split("\n");
    const lineOf = (needle: string) => lines.findIndex((line) => line.includes(needle)) + 1;
    const reads: string[] = [];
    const run = (question: string) => explore({ question, limit: 4 }, {
      rgSearch: async (pattern) => {
        if (pattern === "tree-sitter") return [{ path: "provider.ts", line: lineOf("\"tree-sitter\""), text: lines[lineOf("\"tree-sitter\"") - 1]! }];
        if (pattern === "parse" || pattern === "budget") {
          return [
            { path: "provider.ts", line: lineOf("elapsed > parseBudget"), text: lines[lineOf("elapsed > parseBudget") - 1]! },
            { path: "provider.ts", line: lineOf("parse budget exceeded"), text: lines[lineOf("parse budget exceeded") - 1]! },
          ];
        }
        return [];
      },
      readFile: async (path) => {
        reads.push(path);
        return ready(content);
      },
      structure: createStructureSource([parsingProvider()]),
    });

    const withObject = await run("how is the parse budget for tree-sitter enforced");
    expect(reads).toEqual(["provider.ts"]);
    expect(withObject.snippets.some((snippet) => snippet.text.includes("elapsed > parseBudget"))).toBe(true);

    const withoutObject = await run("how is the parse budget enforced");
    expect(withoutObject.snippets.some((snippet) => snippet.text.includes("elapsed > parseBudget"))).toBe(true);
  });

  it("does not let an off-topic wire end from a registration table outrank the question's own object", async () => {
    // A container slice of a registration table holds every literal it
    // registers, so the window filter alone does not keep the other services
    // out. Use the real parser so the window is the whole function (D-151).
    const registrar = [
      "export function registerHarnessServices() {",
      ...Array.from({ length: 10 }, (_, index) => `  register("other.service.${index}", noop);`),
      "  register(\"explore.search\", createExploreSearchService);",
      "}",
    ].join("\n");
    const usage = [
      "export function describeWiring() {",
      "  return \"explore.search is answered by the application host\";",
      "}",
    ].join("\n");
    const registrarHit = registrar.split("\n").findIndex((line) => line.includes("explore.search")) + 1;
    const result = await explore({ question: "where is explore.search registered", limit: 2 }, {
      rgSearch: async (pattern) => pattern === "explore.search"
        ? [
          { path: "src/harness-services.ts", line: registrarHit, text: "  register(\"explore.search\", createExploreSearchService);" },
          { path: "src/describe-wiring.ts", line: 2, text: "  return \"explore.search is answered by the application host\";" },
        ]
        : [],
      readFile: async (path) => {
        if (path === "src/harness-services.ts") return ready(registrar);
        if (path === "src/describe-wiring.ts") return ready(usage);
        return ready("register(\"other.service.0\", noop);");
      },
      structure: createStructureSource([parsingProvider()]),
      graph: {
        catalogStats: async () => ({ symbolCount: 3 }),
        searchDefinitions: async () => [],
        findLinks: async (value) => {
          if (value === "explore.search") return [{ path: "src/harness-services.ts", kind: "connects", value, callee: "register" }];
          if (value.startsWith("other.service")) {
            return [{ path: "src/bash-tool.ts", kind: "connects", value, callee: "register" }];
          }
          return [];
        },
        fileRelations: async (path) => path === "src/harness-services.ts"
          ? {
            connections: [
              ...Array.from({ length: 10 }, (_, index) => ({ callee: "register", literal: `other.service.${index}` })),
              { callee: "register", literal: "explore.search" },
            ],
            linksIncomplete: false,
          }
          : null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    const paths = result.snippets.map((snippet) => snippet.path);
    expect(paths).toContain("src/harness-services.ts");
    expect(paths).toContain("src/describe-wiring.ts");
    expect(paths).not.toContain("src/bash-tool.ts");
  });

  it("records skipped content-word queries as direct-verified, not as unread budget", async () => {
    const rgSearch = vi.fn(async (pattern: string) => {
      if (pattern === "explore.search") {
        return [{ path: "src/router.ts", line: 1, text: "register(\"explore.search\", handler)" }];
      }
      return [{ path: "docs/guide.md", line: 1, text: "service host router" }];
    });
    const result = await explore({ question: "where is the explore.search service registered on the host router" }, {
      rgSearch,
      readFile: async () => ready("register(\"explore.search\", handler)"),
      structure: {
        outline: async (request) => ({ status: "ready", provider: "tree-sitter", revision: request.revision, symbols: [] }),
        classifyHits: async (request) => ({ status: "ready", provider: "tree-sitter", revision: request.revision, hits: [] }),
        literalCalls: async (request) => ({
          status: "ready",
          provider: "tree-sitter",
          revision: request.revision,
          calls: [{ name: "register", literal: "explore.search", line: 1 }],
        }),
      },
      graph: {
        catalogStats: async () => ({ symbolCount: 1 }),
        searchDefinitions: async () => [],
        findLinks: async () => [{ path: "src/router.ts", kind: "connects", value: "explore.search", callee: "register" }],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(rgSearch.mock.calls.map((call) => call[0])).toEqual(["explore.search"]);
    expect(result.details.skippedQueries).toEqual({
      reason: "direct-verified",
      patterns: expect.arrayContaining(["service", "host", "router"]),
    });
    expect(result.snippets[0]?.why).toContain("verified register(\"explore.search\")");
  });
});

describe("explore query-internal distinctiveness", () => {
  it("does not treat a truncated pattern as an exact document frequency", async () => {
    const result = await explore({ question: "rareword commonword" }, {
      rgSearch: async (pattern) => {
        if (pattern === "rareword") {
          return {
            hits: [
              { path: "src/rare.ts", line: 1, text: "rareword here" },
              { path: "src/also.ts", line: 1, text: "rareword also" },
            ],
            filesDropped: 0,
            fileCoverage: "complete",
          };
        }
        return {
          hits: Array.from({ length: 3 }, (_, index) => ({
            path: `src/common-${index}.ts`,
            line: 1,
            text: "commonword",
          })),
          filesDropped: 40,
          fileCoverage: "lower-bound",
        };
      },
      readFile: async (path) => ready(path.includes("rare") || path.includes("also") ? "rareword here" : "commonword"),
    });
    const terms = result.details.distinctiveness?.terms ?? [];
    const rare = terms.find((term) => term.term === "rareword");
    const common = terms.find((term) => term.term === "commonword");
    expect(result.details.distinctiveness?.scope).toBe("query-pool");
    expect(result.details.distinctiveness?.poolFiles).toBeGreaterThanOrEqual(5);
    expect(rare?.coverage).toBe("complete");
    expect(rare?.uniqueFiles).toBe(2);
    expect(common?.coverage).toBe("lower-bound");
    expect(common?.uniqueFiles).toBe(3);
    expect(common?.weight).toBe(1);
    expect(rare?.weight).toBeGreaterThan(common!.weight);
  });

  it("keeps unique-file coverage complete when only per-file hits were capped", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => ({
        hits: [
          { path: "a.ts", line: 1, text: "needle" },
          { path: "b.ts", line: 1, text: "needle" },
        ],
        partial: true,
        filesDropped: 0,
        fileCoverage: "complete",
      }),
      readFile: async () => ready("needle"),
    });
    const needle = result.details.distinctiveness?.terms.find((term) => term.term === "needle");
    expect(needle?.coverage).toBe("complete");
    expect(needle?.uniqueFiles).toBe(2);
    // Pool is two files and both match, so complete coverage still has no
    // rarity bonus. The assertion is the state, not a fake IDF.
    expect(needle?.weight).toBe(1);
  });

  it("lists generated windows so a packed-out match is distinguishable from a missing window", async () => {
    const content = [
      "function decoy() { return needle; }",
      ...Array.from({ length: 20 }, (_, index) => `const pad${index} = ${index};`),
      "function target() { return needle + extra; }",
    ].join("\n");
    const lines = content.split("\n");
    const result = await explore({ question: "needle extra", limit: 1 }, {
      rgSearch: async (pattern) => {
        if (pattern === "needle") {
          return [
            { path: "src/a.ts", line: 1, text: lines[0]! },
            { path: "src/a.ts", line: 22, text: lines[21]! },
          ];
        }
        if (pattern === "extra") return [{ path: "src/a.ts", line: 22, text: lines[21]! }];
        return [];
      },
      readFile: async () => ready(content),
      structure: createStructureSource([parsingProvider()]),
    });
    const windows = result.details.windows ?? [];
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.some((window) => window.packed)).toBe(true);
    expect(windows.some((window) => !window.packed)).toBe(true);
    expect(windows.every((window) => typeof window.why === "string")).toBe(true);
    expect(windows.some((window) => window.hits.some((hit) => hit.includes("extra")))).toBe(true);
  });

  it("lets two rare complete content words outrank a file that only stacks generic terms", async () => {
    const genericFiles = Array.from({ length: 20 }, (_, index) => `src/flood-${index}.ts`);
    const result = await explore({ question: "alphaword betaword gammaword deltaword epsilonword zetaword", limit: 2 }, {
      rgSearch: async (pattern) => {
        if (pattern === "alphaword" || pattern === "betaword") {
          return {
            hits: [{ path: "src/rare.ts", line: 1, text: "alphaword betaword" }],
            filesDropped: 0,
            fileCoverage: "complete",
          };
        }
        return {
          hits: [
            { path: "src/generic.ts", line: 1, text: "gammaword deltaword epsilonword zetaword" },
            ...genericFiles.map((path) => ({ path, line: 1, text: pattern })),
          ],
          filesDropped: 0,
          fileCoverage: "complete",
        };
      },
      readFile: async (path) => ready(
        path === "src/rare.ts" ? "alphaword betaword" : "gammaword deltaword epsilonword zetaword",
      ),
    });
    expect(result.details.distinctiveness?.terms.find((term) => term.term === "alphaword")?.coverage).toBe("complete");
    expect(result.details.distinctiveness?.terms.find((term) => term.term === "gammaword")?.uniqueFiles).toBeGreaterThan(10);
    expect(result.snippets[0]?.path).toBe("src/rare.ts");
    expect(result.snippets.map((snippet) => snippet.path)).toContain("src/rare.ts");
  });

  it("does not let roleFit wall a weak source file ahead of a stronger manifest", async () => {
    const genericFiles = Array.from({ length: 18 }, (_, index) => `src/flood-${index}.ts`);
    const result = await explore({ question: "how does alphaword betaword gammaword deltaword epsilonword zetaword", limit: 1 }, {
      rgSearch: async (pattern) => {
        if (pattern === "alphaword" || pattern === "betaword") {
          return {
            hits: [{ path: "config/manifest.json", line: 1, text: "alphaword betaword" }],
            filesDropped: 0,
            fileCoverage: "complete",
          };
        }
        return {
          hits: [
            { path: "src/weak.ts", line: 1, text: "gammaword deltaword epsilonword zetaword" },
            ...genericFiles.map((path) => ({ path, line: 1, text: pattern })),
          ],
          filesDropped: 0,
          fileCoverage: "complete",
        };
      },
      readFile: async (path) => ready(
        path.endsWith(".json") ? "alphaword betaword" : "gammaword deltaword epsilonword zetaword",
      ),
    });
    expect(result.snippets[0]?.path).toBe("config/manifest.json");
  });

  it("does not treat a full excerpt pack as a reason to skip another high-weight file", async () => {
    const paths = ["src/aaa.ts", "src/bbb.ts", "src/ccc.ts", "src/zzz.ts"];
    const block = (name: string) => Array.from(
      { length: 25 },
      (_, index) => `function ${name}${index}() { return "alphaword betaword"; }`,
    ).join("\n");
    const reads: string[] = [];
    await explore({ question: "alphaword betaword", limit: 2 }, {
      rgSearch: async () => ({
        hits: paths.map((path) => ({
          path,
          line: 1,
          text: `function ${path.slice(4, 7)}0() { return "alphaword betaword"; }`,
        })),
        filesDropped: 0,
        fileCoverage: "complete",
      }),
      readFile: async (path) => {
        reads.push(path);
        return ready(block(path.slice(4, 7)));
      },
      structure: createStructureSource([parsingProvider()]),
    });
    expect(reads).toEqual(expect.arrayContaining(paths));
    expect(reads).toContain("src/zzz.ts");
  });
});

describe("explore local evidence and pack (3.14 checkpoint 3)", () => {
  it("does not give a content-word-only window full-object grade", async () => {
    const content = [
      "function checkBudget(budget: number) {",
      "  return budget > 0;",
      "}",
    ].join("\n");
    const result = await explore({ question: "how is the budget enforced", limit: 1 }, {
      rgSearch: async (pattern) => pattern === "budget"
        ? [{ path: "src/budget.ts", line: 2, text: "  return budget > 0;" }]
        : [],
      readFile: async () => ready(content),
      structure: createStructureSource([parsingProvider()]),
    });
    const window = result.details.windows?.find((item) => item.path === "src/budget.ts");
    expect(window).toBeDefined();
    expect(window?.assessment).toBe("name-only");
    expect(window?.arrivals.some((arrival) => arrival.kind === "lexical")).toBe(true);
    expect(window?.purpose === "primary" || window?.purpose === "support" || window?.purpose === "candidate").toBe(true);
  });

  it("packs two complementary blocks from one file ahead of a weak second file", async () => {
    const target = [
      "function ensureRuntime() {",
      "  return \"tree-sitter\";",
      "}",
      ...Array.from({ length: 40 }, (_, index) => `const pad${index} = ${index};`),
      "function parseDocument(elapsed: number, parseBudget: number) {",
      "  if (elapsed > parseBudget) {",
      "    throw new Error(\"alphaword betaword\");",
      "  }",
      "  return true;",
      "}",
    ].join("\n");
    const lines = target.split("\n");
    const lineOf = (needle: string) => lines.findIndex((line) => line.includes(needle)) + 1;
    const genericFiles = Array.from({ length: 3 }, (_, index) => `src/flood-${index}.ts`);
    const result = await explore({
      question: "how is the alphaword betaword gammaword for tree-sitter enforced",
      limit: 2,
    }, {
      rgSearch: async (pattern) => {
        if (pattern === "tree-sitter") {
          return {
            hits: [{ path: "src/provider.ts", line: lineOf("\"tree-sitter\""), text: lines[lineOf("\"tree-sitter\"") - 1]! }],
            filesDropped: 0,
            fileCoverage: "complete",
          };
        }
        if (pattern === "alphaword" || pattern === "betaword") {
          return {
            hits: [{ path: "src/provider.ts", line: lineOf("alphaword betaword"), text: lines[lineOf("alphaword betaword") - 1]! }],
            filesDropped: 0,
            fileCoverage: "complete",
          };
        }
        if (pattern === "gammaword") {
          return {
            hits: [
              { path: "src/weak.ts", line: 1, text: "function mention() { return \"gammaword\"; }" },
              ...genericFiles.map((path) => ({ path, line: 1, text: "gammaword" })),
            ],
            filesDropped: 0,
            fileCoverage: "complete",
          };
        }
        return { hits: [], filesDropped: 0, fileCoverage: "complete" };
      },
      readFile: async (path) => ready(
        path === "src/provider.ts" ? target : "function mention() { return \"gammaword\"; }",
      ),
      structure: createStructureSource([parsingProvider()]),
    });
    expect(result.notRequested.paths).not.toContain("src/weak.ts");
    expect(result.snippets.some((snippet) => snippet.text.includes("elapsed > parseBudget"))).toBe(true);
    expect(result.snippets.some((snippet) => snippet.text.includes("tree-sitter"))).toBe(true);
    expect(result.snippets.every((snippet) => snippet.path !== "src/weak.ts")).toBe(true);
  });

  it("packs a same-file implementation function ahead of another file that only repeats covered terms", async () => {
    const languages = [
      "export const TREE_SITTER_LANGUAGE_SPECS = {",
      "  typescript: { grammarFile: \"tree-sitter-typescript.wasm\", outline: true },",
      "};",
      ...Array.from({ length: 40 }, (_, index) => `export const pad${index} = ${index};`),
      "export function capabilitiesFromSpec(spec?: { grammarFile: string }) {",
      "  return { outline: Boolean(spec) };",
      "}",
    ].join("\n");
    const other = [
      "export const OTHER_SPECS = {",
      "  rust: { grammarFile: \"tree-sitter-rust.wasm\" },",
      "};",
    ].join("\n");
    const langLines = languages.split("\n");
    const otherLines = other.split("\n");
    const lineOf = (source: string[], needle: string) => source.findIndex((line) => line.includes(needle)) + 1;
    const result = await explore({
      question: "where do we decide a tree-sitter grammar can produce an outline",
      limit: 2,
    }, {
      rgSearch: async (pattern) => {
        const hits: Array<{ path: string; line: number; text: string }> = [];
        const push = (path: string, source: string[], needle: string): void => {
          const line = lineOf(source, needle);
          if (line > 0) hits.push({ path, line, text: source[line - 1]! });
        };
        if (pattern === "tree-sitter") {
          push("src/languages.ts", langLines, "tree-sitter-typescript");
          push("src/other.ts", otherLines, "tree-sitter-rust");
        }
        if (pattern === "grammar") {
          push("src/languages.ts", langLines, "grammarFile: \"tree-sitter-typescript");
          push("src/other.ts", otherLines, "grammarFile: \"tree-sitter-rust");
        }
        if (pattern === "outline") {
          push("src/languages.ts", langLines, "outline: true");
          push("src/languages.ts", langLines, "outline: Boolean");
        }
        return { hits, filesDropped: 0, fileCoverage: "complete" };
      },
      readFile: async (path) => ready(path === "src/languages.ts" ? languages : other),
      structure: createStructureSource([parsingProvider()]),
    });
    expect(result.snippets.some((snippet) => snippet.text.includes("capabilitiesFromSpec"))).toBe(true);
    expect(result.snippets.every((snippet) => snippet.path !== "src/other.ts")).toBe(true);
  });

  it("rescans a snapshot so a dropped content-word hit still becomes a window", async () => {
    const content = [
      "function ensureRuntime() {",
      "  return \"tree-sitter\";",
      "}",
      ...Array.from({ length: 40 }, (_, index) => `const pad${index} = ${index};`),
      "function parseDocument(elapsed: number, parseBudget: number) {",
      "  if (elapsed > parseBudget) {",
      "    throw new Error(\"alphaword\");",
      "  }",
      "  return true;",
      "}",
    ].join("\n");
    const lines = content.split("\n");
    const lineOf = (needle: string) => lines.findIndex((line) => line.includes(needle)) + 1;
    const result = await explore({ question: "how is the alphaword for tree-sitter enforced", limit: 4 }, {
      rgSearch: async (pattern) => {
        if (pattern === "tree-sitter") {
          return [{ path: "src/provider.ts", line: lineOf("\"tree-sitter\""), text: lines[lineOf("\"tree-sitter\"") - 1]! }];
        }
        return [];
      },
      readFile: async () => ready(content),
      structure: createStructureSource([parsingProvider()]),
    });
    expect(result.details.windows?.some((window) => window.hits.some((hit) => hit.includes("alphaword")))).toBe(true);
    expect(result.snippets.some((snippet) => snippet.text.includes("alphaword"))).toBe(true);
  });

  it("does not fill leftover excerpt slots with off-topic wire ends after a locating hit", async () => {
    const registrar = [
      "export function registerHarnessServices() {",
      ...Array.from({ length: 10 }, (_, index) => `  register("other.service.${index}", noop);`),
      "  register(\"explore.search\", createExploreSearchService);",
      "}",
    ].join("\n");
    const registrarHit = registrar.split("\n").findIndex((line) => line.includes("explore.search")) + 1;
    const result = await explore({ question: "where is explore.search registered", limit: 6 }, {
      rgSearch: async (pattern) => pattern === "explore.search"
        ? [{ path: "src/harness-services.ts", line: registrarHit, text: "  register(\"explore.search\", createExploreSearchService);" }]
        : [],
      readFile: async (path) => {
        if (path === "src/harness-services.ts") return ready(registrar);
        return ready(`register("${path}", noop);`);
      },
      structure: createStructureSource([parsingProvider()]),
      graph: {
        catalogStats: async () => ({ symbolCount: 3 }),
        searchDefinitions: async () => [],
        findLinks: async (value) => {
          if (value === "explore.search") return [{ path: "src/harness-services.ts", kind: "connects", value, callee: "register" }];
          if (value.startsWith("other.service")) {
            return [{ path: `src/${value}.ts`, kind: "connects", value, callee: "register" }];
          }
          return [];
        },
        fileRelations: async (path) => path === "src/harness-services.ts"
          ? {
            connections: [
              ...Array.from({ length: 10 }, (_, index) => ({ callee: "register", literal: `other.service.${index}` })),
              { callee: "register", literal: "explore.search" },
            ],
            linksIncomplete: false,
          }
          : null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets.some((snippet) => snippet.text.includes("register(\"explore.search\""))).toBe(true);
    expect(result.snippets.some((snippet) => snippet.path.includes("other.service"))).toBe(false);
    expect(result.details.provenance.some((entry) => entry.path.includes("other.service"))).toBe(false);
  });

  it("does not give same-container connection clues direct-clue or extra-read treatment", async () => {
    const ranking = [
      "export function ranking() {",
      "  return materialize();",
      "}",
      "function materialize() {",
      "  return { kind: \"ranking-plan\", note: \"candidates\" };",
      "}",
    ].join("\n");
    const registry = [
      "export function bootTable() {",
      "  // candidates table used at startup",
      ...Array.from({ length: 16 }, (_, index) => `  register("wire.alpha.${index}", noop);`),
      "}",
    ].join("\n");
    const bodies = new Map<string, string>([
      ["src/ranking.ts", ranking],
      ["src/registry.ts", registry],
    ]);
    const readPaths: string[] = [];
    const result = await explore({ question: "how does ranking materialize candidates", limit: 6 }, {
      rgSearch: async (pattern) => {
        const hits: Array<{ path: string; line: number; text: string }> = [];
        for (const [path, content] of bodies) {
          for (const [index, text] of content.split("\n").entries()) {
            if (text.includes(pattern)) hits.push({ path, line: index + 1, text });
          }
        }
        return hits;
      },
      readFile: async (path) => {
        readPaths.push(path);
        return ready(bodies.get(path) ?? `register("${path}", impl);`);
      },
      structure: createStructureSource([parsingProvider()]),
      graph: {
        catalogStats: async () => ({ symbolCount: 20 }),
        searchDefinitions: async () => [],
        findLinks: async (value) => {
          if (!value.startsWith("wire.alpha.")) return [];
          return [
            { path: "src/registry.ts", kind: "connects", value, callee: "register" },
            { path: `src/${value}.ts`, kind: "connects", value, callee: "register" },
          ];
        },
        fileRelations: async (path) => path === "src/registry.ts"
          ? {
            connections: Array.from({ length: 16 }, (_, index) => ({
              callee: "register",
              literal: `wire.alpha.${index}`,
            })),
            linksIncomplete: false,
          }
          : null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets.some((snippet) => snippet.path === "src/ranking.ts")).toBe(true);
    expect(readPaths.some((path) => path.includes("wire.alpha"))).toBe(false);
    expect(result.snippets.some((snippet) => snippet.path.includes("wire.alpha"))).toBe(false);
    expect(result.details.provenance.some((entry) => entry.path.includes("wire.alpha") && entry.status === "ready")).toBe(false);
  });

  it("still extra-reads a connection literal that sits on a relevant statement", async () => {
    const ranking = [
      "export function ranking() {",
      "  return materialize(\"rank.pipeline.core\");",
      "}",
    ].join("\n");
    const pipeline = "export function rankPipelineCore() { return materialize(\"rank.pipeline.core\"); }\n";
    const result = await explore({ question: "how does ranking materialize candidates", limit: 6 }, {
      rgSearch: async (pattern) => {
        const hits: Array<{ path: string; line: number; text: string }> = [];
        for (const [index, text] of ranking.split("\n").entries()) {
          if (text.includes(pattern)) hits.push({ path: "src/ranking.ts", line: index + 1, text });
        }
        return hits;
      },
      readFile: async (path) => ready(path === "src/pipeline-core.ts" ? pipeline : ranking),
      structure: createStructureSource([parsingProvider()]),
      graph: {
        catalogStats: async () => ({ symbolCount: 2 }),
        searchDefinitions: async () => [],
        findLinks: async (value) => value === "rank.pipeline.core"
          ? [
            { path: "src/ranking.ts", kind: "connects", value, callee: "materialize" },
            { path: "src/pipeline-core.ts", kind: "connects", value, callee: "register" },
          ]
          : [],
        fileRelations: async (path) => path === "src/ranking.ts"
          ? { connections: [{ callee: "materialize", literal: "rank.pipeline.core" }], linksIncomplete: false }
          : null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.snippets.some((snippet) => snippet.path === "src/pipeline-core.ts")).toBe(true);
    expect(result.snippets.find((snippet) => snippet.path === "src/pipeline-core.ts")?.why).toContain("other end of connection \"rank.pipeline.core\"");
  });

  it("does not treat register and request of different connection values as both ends", async () => {
    const request = "export function ask() { return request(\"explore.search\"); }\n";
    const decoy = [
      "export function boot() {",
      "  // explore.search mentioned so rg selects this file",
      "  register(\"other.wire\", noop);",
      "}",
    ].join("\n");
    const result = await explore({ question: "how is explore.search wired on the host" }, {
      rgSearch: async (pattern) => {
        if (pattern === "explore.search") {
          return [
            { path: "src/request.ts", line: 1, text: "export function ask() { return request(\"explore.search\"); }" },
            { path: "src/decoy.ts", line: 2, text: "  // explore.search mentioned so rg selects this file" },
          ];
        }
        return [];
      },
      readFile: async (path) => ready(path === "src/decoy.ts" ? decoy : request),
      structure: createStructureSource([parsingProvider()]),
      graph: {
        catalogStats: async () => ({ symbolCount: 2 }),
        searchDefinitions: async () => [],
        findLinks: async (value) => value === "explore.search"
          ? [{ path: "src/request.ts", kind: "connects", value, callee: "request" }]
          : [],
        fileRelations: async () => null,
        findImporters: async () => ({ resolved: [] }),
      },
    });
    expect(result.details.skippedQueries).toBeUndefined();
  });
});

describe("explore main-evidence partition", () => {
  it("keeps both verified ends of one connection ahead of support windows", async () => {
    // Bare `explore.search`: relation is unknown, so relationRoleRank is 0 and
    // nothing but the partition protects verified evidence. Both ends must be
    // packed before the filler that merely mentions the value.
    // The register end is a large registration table, so its body cost is high
    // and it adds no new term groups once the request end is picked. That is
    // the real shape: without the partition it sinks below the small fillers.
    const registrar = [
      "export function registerHarnessServices() {",
      ...Array.from({ length: 60 }, (_, index) => `  register("other.service.${index}", noop);`),
      "  register(\"explore.search\", createExploreSearchService);",
      "}",
    ].join("\n");
    const registrarHitLine = registrar.split("\n").findIndex((line) => line.includes("explore.search")) + 1;
    const requester = [
      "export function createExploreTool() {",
      "  return request(\"explore.search\", params);",
      "}",
    ].join("\n");
    // Fillers win on lexical coverage: they carry every content word. Only the
    // partition can keep the two verified ends ahead of them.
    const filler = (index: number) => [
      `export function mention${index}() {`,
      "  const host = router.service(\"explore.search\");",
      "  return { host, router, service: \"explore.search\" };",
      "}",
    ].join("\n");
    const fillerPaths = Array.from({ length: 12 }, (_, index) => `src/mention-${index}.ts`);
    const result = await explore({ question: "explore.search host router service", limit: 4 }, {
      rgSearch: async (pattern) => {
        const hits: Array<{ path: string; line: number; text: string }> = [];
        if (pattern === "explore.search") {
          hits.push({ path: "src/harness-services.ts", line: registrarHitLine, text: "  register(\"explore.search\", createExploreSearchService);" });
          hits.push({ path: "src/explore-tool.ts", line: 2, text: "  return request(\"explore.search\", params);" });
        }
        if (pattern === "explore.search" || pattern === "host" || pattern === "router" || pattern === "service") {
          hits.push(...fillerPaths.map((path) => ({ path, line: 2, text: "  const host = router.service(\"explore.search\");" })));
        }
        return hits;
      },
      readFile: async (path) => {
        if (path === "src/harness-services.ts") return ready(registrar);
        if (path === "src/explore-tool.ts") return ready(requester);
        const index = fillerPaths.indexOf(path);
        return ready(filler(index >= 0 ? index : 0));
      },
      structure: createStructureSource([parsingProvider()]),
    });
    const paths = result.snippets.map((snippet) => snippet.path);
    const registerAt = paths.indexOf("src/harness-services.ts");
    const requestAt = paths.indexOf("src/explore-tool.ts");
    expect(registerAt).toBeGreaterThanOrEqual(0);
    expect(requestAt).toBeGreaterThanOrEqual(0);
    expect(Math.max(registerAt, requestAt)).toBeLessThan(2);
  });
});

describe("explore semantic recall", () => {
  const reclaim = [
    "export function reclaimLease(handle: string) {",
    "  parkedHandles.delete(handle);",
    "  return handle;",
    "}",
  ].join("\n");

  const semanticHit = {
    documentId: "src/reclaim.ts",
    blockId: "src%2Freclaim.ts#1-4",
    parentUnitId: "src%2Freclaim.ts#reclaimLease#function",
    parentName: "reclaimLease",
    parentKind: "function",
    startLine: 1,
    endLine: 4,
    contentHash: "unused",
    body: reclaim,
    similarity: 0.81,
    rank: 1,
  };

  it("puts a lexical-gap semantic hit in the visible body as primary", async () => {
    const result = await explore({ question: "how does the runtime discard idle tokens" }, {
      rgSearch: async () => [],
      readFile: async (path) => ready(path === "src/reclaim.ts" ? reclaim : ""),
      structure: createStructureSource([parsingProvider()]),
      semantic: {
        search: async () => ({
          status: "ready",
          coverage: "complete",
          lifecycle: "ready",
          generation: "g1",
          spaceId: "space",
          scope: { scopeKind: "workspace", scopeId: "ws" },
          hits: [semanticHit],
        }),
      },
    });
    expect(result.snippets.some((snippet) => snippet.text.includes("reclaimLease"))).toBe(true);
    expect(formatExploreOutput({
      ...result,
      ...(result.details.graph ? { graph: result.details.graph } : {}),
    }).visibleText).toContain("reclaimLease");
    const window = result.details.windows?.find((item) => item.path === "src/reclaim.ts");
    expect(window?.arrivals.some((item) => item.kind === "semantic")).toBe(true);
    expect(window?.arrivals.some((item) => item.kind === "lexical")).toBe(false);
    expect(window?.purpose).toBe("primary");
    expect(result.details.semantic?.status).toBe("ready");
    expect(result.details.semantic?.primary).toBeGreaterThanOrEqual(1);
  });

  it("relocates a shifted block instead of keeping the stale recorded range", async () => {
    const decoy = [
      "export function decoyBanner() {",
      ...Array.from({ length: 18 }, (_, index) => `  const filler${index} = ${index};`),
      "}",
    ].join("\n");
    const shifted = `${decoy}\n${reclaim}`;
    const result = await explore({ question: "how does the runtime discard idle tokens" }, {
      rgSearch: async () => [],
      readFile: async () => ready(shifted),
      structure: createStructureSource([parsingProvider()]),
      semantic: {
        search: async () => ({
          status: "ready",
          coverage: "complete",
          lifecycle: "ready",
          hits: [{ ...semanticHit, startLine: 1, endLine: 4, contentHash: "stale-hash" }],
        }),
      },
    });
    const packed = result.snippets.find((snippet) => snippet.path === "src/reclaim.ts");
    expect(packed?.text).toContain("reclaimLease");
    expect(packed?.text).not.toContain("decoyBanner");
    expect(packed?.startLine).toBeGreaterThan(4);
  });

  it("re-slices a rewritten unit instead of keeping the stale recorded range", async () => {
    const rewritten = [
      "export function reclaimLease(handle: string) {",
      ...Array.from({ length: 30 }, (_, index) => `  const step${index} = handle;`),
      "  return yieldOrphanedLease(handle);",
      "}",
    ].join("\n");
    const result = await explore({ question: "how does the runtime discard idle tokens" }, {
      rgSearch: async () => [],
      readFile: async () => ready(rewritten),
      structure: createStructureSource([parsingProvider()]),
      semantic: {
        search: async () => ({
          status: "ready",
          coverage: "complete",
          lifecycle: "ready",
          hits: [{ ...semanticHit, startLine: 1, endLine: 4, contentHash: "stale-hash", body: reclaim }],
        }),
      },
    });
    expect(result.snippets.some((snippet) => snippet.text.includes("yieldOrphanedLease"))).toBe(true);
  });

  it("returns published semantic hits while coverage is still partial", async () => {
    const result = await explore({ question: "how does the runtime discard idle tokens" }, {
      rgSearch: async () => [],
      readFile: async () => ready(reclaim),
      structure: createStructureSource([parsingProvider()]),
      semantic: {
        search: async () => ({
          status: "ready",
          coverage: "partial",
          lifecycle: "building",
          hits: [semanticHit],
        }),
      },
    });
    expect(result.details.semantic?.coverage).toBe("partial");
    expect(result.details.semantic?.index.lifecycle).toBe("building");
    expect(result.snippets.some((snippet) => snippet.text.includes("reclaimLease"))).toBe(true);
  });

  it("merges lexical and semantic arrivals on the same function instead of copying the unit", async () => {
    const result = await explore({ question: "reclaimLease" }, {
      rgSearch: async (pattern) => pattern === "reclaimLease"
        ? [{ path: "src/reclaim.ts", line: 1, text: "export function reclaimLease(handle: string) {" }]
        : [],
      readFile: async () => ready(reclaim),
      structure: createStructureSource([parsingProvider()]),
      semantic: {
        search: async () => ({
          status: "ready",
          coverage: "complete",
          lifecycle: "ready",
          hits: [semanticHit],
        }),
      },
    });
    const units = result.details.windows?.filter((item) => item.path === "src/reclaim.ts" && item.packed) ?? [];
    expect(units).toHaveLength(1);
    expect(units[0]?.arrivals.map((item) => item.kind).sort()).toEqual(["lexical", "semantic"]);
  });

  it("schedules a semantic-only file and does not give ten blocks ten votes", async () => {
    const reads: string[] = [];
    const noisyHits = Array.from({ length: 10 }, (_, index) => ({
      ...semanticHit,
      documentId: "src/noisy.ts",
      blockId: `noisy#${index}`,
      rank: 2 + index,
      body: "export function noisy() { return 1; }",
    }));
    await explore({ question: "how does the runtime discard idle tokens" }, {
      rgSearch: async () => [],
      readFile: async (path) => {
        reads.push(path);
        return ready(path === "src/reclaim.ts" ? reclaim : "export function noisy() { return 1; }");
      },
      structure: createStructureSource([parsingProvider()]),
      semantic: {
        search: async () => ({
          status: "ready",
          coverage: "complete",
          lifecycle: "ready",
          hits: [...noisyHits, semanticHit],
        }),
      },
    });
    expect(reads[0]).toBe("src/reclaim.ts");
  });

  it("keeps lexical plus graph results when the semantic source is unavailable", async () => {
    const result = await explore({ question: "needle" }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
      semantic: {
        search: async () => ({
          status: "unavailable",
          coverage: "empty",
          lifecycle: "idle",
          hits: [],
        }),
      },
    });
    expect(result.snippets[0]?.text).toContain("needle");
    expect(result.details.semantic?.status).toBe("unavailable");
    expect(result.details.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "semantic", status: "unavailable" }),
    ]));
  });
});
