import { describe, expect, it } from "vitest";
import { explore } from "./explore.js";
import type { ExploreFileSnapshot } from "./file-snapshot.js";
import { createStructureSource } from "../structure/source.js";
import { createTreeSitterStructureProvider } from "../structure/native-provider.test-helper.js";
import type { StructureProvider } from "../structure/types.js";

const ready = (content: string, revision = "rev-1"): ExploreFileSnapshot => ({ status: "ready", content, revision, source: "disk" });

// Real parser consumers use a generous budget so loaded runners do not change the behavior under test.
const parsingProvider = () => createTreeSitterStructureProvider({ parseBudgetMs: 30_000 });

describe("explore structure slices", () => {

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

describe("explore ranking and verification", () => {

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
});

describe("explore query-internal distinctiveness", () => {

  it("retains generated windows independently of the model preview limit", async () => {
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
    expect(windows.every((window) => window.packed)).toBe(true);
    expect(result.snippets.length).toBeGreaterThan(1);
    expect(windows.every((window) => typeof window.why === "string")).toBe(true);
    expect(windows.some((window) => window.hits.some((hit) => hit.includes("extra")))).toBe(true);
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

describe("explore local evidence and packing", () => {
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
    expect(result.snippets.slice(0, 2).every((snippet) => snippet.path === "src/provider.ts")).toBe(true);
    expect(result.snippets.some((snippet) => snippet.path === "src/weak.ts")).toBe(true);
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
    expect(result.snippets.slice(0, 2).every((snippet) => snippet.path === "src/languages.ts")).toBe(true);
    expect(result.snippets.some((snippet) => snippet.path === "src/other.ts")).toBe(true);
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
});
