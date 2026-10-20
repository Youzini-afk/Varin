import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CANDIDATE_BUDGET, DEFAULT_HITS_PER_FILE, buildRgPatterns, explore, extractIdentifiers, extractQuotedLiterals, type ExploreDeps } from "./explore.js";
import type { ExploreFileSnapshot } from "./file-snapshot.js";
import type { StructureOutlineResult, StructureSource } from "../structure/types.js";

const ready = (content: string, revision = "rev-1"): ExploreFileSnapshot => ({ status: "ready", content, revision, source: "disk" });

const structureSource = (outline: StructureOutlineResult): Pick<StructureSource, "outline" | "classifyHits"> => ({
  outline: async (request) => ({ ...outline, revision: outline.status === "stale" ? outline.revision : request.revision }),
  classifyHits: async (request) => ({ status: "unsupported", provider: outline.provider, revision: request.revision, hits: [] }),
});

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

  it("keeps selected source evidence beyond the requested preview count", async () => {
    const result = await explore({ question: "needle", limit: 1 }, {
      rgSearch: async () => [{ path: "a.ts", line: 1, text: "needle" }, { path: "b.ts", line: 1, text: "needle" }],
      readFile: async () => ready("needle"),
    });
    expect(result.snippets).toHaveLength(2);
    expect(result.omitted).toEqual([]);
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

describe("explore candidate ranking and materialization", () => {
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
    expect(result.snippets).toHaveLength(2);
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

  it("reads investigation candidates independently of the delivery count", async () => {
    const files = Array.from({ length: 10 }, (_, index) => `f${index}.ts`);
    const readFile = vi.fn(async (path: string) => ready(`needle in ${path}`));
    const result = await explore({ question: "needle", limit: 2 }, {
      rgSearch: async () => files.map((path) => ({ path, line: 1, text: `needle in ${path}` })),
      readFile,
    });
    expect(readFile).toHaveBeenCalledTimes(files.length);
    expect(result.snippets).toHaveLength(files.length);
    expect(result.notRequested.count).toBe(0);
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

  it("classifies actually read candidates independently of the output limit", async () => {
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
    expect(new Set(classified).size).toBe(hits.length);
    expect(result.notRequested.paths).toEqual([]);
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

describe("explore ranking and verification", () => {
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
});

describe("explore semantic recall", () => {

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
