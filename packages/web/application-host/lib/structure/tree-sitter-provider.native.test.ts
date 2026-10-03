import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { languageIdForPath } from "@varin/protocol";
import { describe, expect, it } from "vitest";
import { isJsonStructureContainerKind, isStructureContainerKind } from "./kinds.js";
import {
  CATALOG_SCAN_LANGUAGES,
  capabilitiesFromSpec,
  tagsDefinitionKind,
  treeSitterLanguageSpec,
  treeSitterTagsSpec,
} from "./languages.js";
import { createTreeSitterStructureProvider } from "./native-provider.test-helper.js";
import { NO_STRUCTURE_CAPABILITIES } from "./types.js";

const request = (text: string, path = "sample.ts") => ({
  path,
  languageId: languageIdForPath(path),
  text,
  revision: "rev-1",
});

/**
 * The production budget is a wall clock, so a shared runner under load can
 * exhaust it and turn these assertions into `failed`. Tests that assert a real
 * parse pin their own budget; the ones that assert exhaustion pin `0` (D-102).
 */
const parsingProvider = () => createTreeSitterStructureProvider({ parseBudgetMs: 30_000 });

describe("tree-sitter language specs", () => {
  it("derives all four capabilities for typescript and tsx", () => {
    const expected = { outline: true, classifyHits: true, literalCalls: true, imports: true };
    expect(capabilitiesFromSpec(treeSitterLanguageSpec("typescript"))).toEqual(expected);
    expect(capabilitiesFromSpec(treeSitterLanguageSpec("typescriptreact"))).toEqual(expected);
    expect(createTreeSitterStructureProvider().capabilities("typescript")).toEqual(expected);
    expect(createTreeSitterStructureProvider().capabilities("typescriptreact")).toEqual(expected);
  });

  it("derives JS capabilities including imports and JSON without imports", () => {
    expect(capabilitiesFromSpec(treeSitterLanguageSpec("javascript"))).toEqual({
      outline: true,
      classifyHits: true,
      literalCalls: true,
      imports: true,
    });
    expect(capabilitiesFromSpec(treeSitterLanguageSpec("javascriptreact"))).toEqual({
      outline: true,
      classifyHits: true,
      literalCalls: true,
      imports: true,
    });
    expect(capabilitiesFromSpec(treeSitterLanguageSpec("json"))).toEqual({
      outline: true,
      classifyHits: true,
      literalCalls: false,
      imports: false,
    });
    expect(createTreeSitterStructureProvider().capabilities("json")).toEqual({
      outline: true,
      classifyHits: true,
      literalCalls: false,
      imports: false,
    });
    expect(capabilitiesFromSpec(undefined)).toEqual(NO_STRUCTURE_CAPABILITIES);
    expect(createTreeSitterStructureProvider().capabilities("swift")).toEqual(NO_STRUCTURE_CAPABILITIES);
    expect(createTreeSitterStructureProvider().capabilities(null)).toEqual(NO_STRUCTURE_CAPABILITIES);
  });

  it("derives outline and classifyHits from a spec, and optional queries from presence", () => {
    const outlineOnly = capabilitiesFromSpec(treeSitterTagsSpec("x.wasm", "(program) @definition.module"));
    expect(outlineOnly).toEqual({
      outline: true,
      classifyHits: true,
      literalCalls: false,
      imports: false,
    });
    expect(capabilitiesFromSpec(treeSitterTagsSpec("x.wasm", ""))).toEqual(NO_STRUCTURE_CAPABILITIES);
  });

  it("maps upstream tags captures onto slice kinds and leaves the rest as catalog names", () => {
    expect(tagsDefinitionKind("definition.function")).toBe("function");
    expect(tagsDefinitionKind("definition.trait")).toBe("interface");
    expect(tagsDefinitionKind("definition.namespace")).toBe("module");
    expect(isStructureContainerKind(tagsDefinitionKind("definition.class")!)).toBe(true);
    // A constant is a name inside a container, so it never becomes a unit.
    expect(isStructureContainerKind(tagsDefinitionKind("definition.constant")!)).toBe(false);
    expect(tagsDefinitionKind("definition.something-new")).toBe("unknown");
    expect(tagsDefinitionKind("reference.call")).toBeNull();
    expect(tagsDefinitionKind("name")).toBeNull();
  });

  /**
   * The bundled JavaScript grammar stands in for a downloaded one: what is
   * under test is the tags adapter, and this is the same capture shape every
   * upstream `queries/tags.scm` uses (D-128).
   */
  it("outlines an installed grammar through its upstream tags query", async () => {
    const provider = createTreeSitterStructureProvider({
      parseBudgetMs: 30_000,
      resolveInstalledLanguage: (languageId) => (languageId === "markdown" ? {
        grammarFile: "tree-sitter-javascript.wasm",
        tagsQuery: [
          "(function_declaration name: (identifier) @name) @definition.function",
          "(class_declaration name: (identifier) @name) @definition.class",
          "(variable_declarator name: (identifier) @name) @definition.constant",
        ].join("\n"),
      } : null),
    });
    expect(provider.capabilities("ruby")).toEqual({
      outline: true,
      classifyHits: true,
      literalCalls: false,
      imports: false,
    });
    const text = [
      "class Box {}",
      "function needle() {",
      "  const inner = 1;",
      "  return inner;",
      "}",
    ].join("\n");
    const outline = await provider.outline({ path: "sample.md", languageId: "markdown", text, revision: "rev-1" });
    expect(outline.status).toBe("ready");
    expect(outline.provider).toBe("tree-sitter");
    const needle = outline.symbols.find((symbol) => symbol.name === "needle");
    expect(needle).toMatchObject({ kind: "function", range: { startLine: 2, endLine: 5 } });
    expect(needle?.signature).toEqual({ startLine: 2, endLine: 2 });
    expect(outline.symbols.find((symbol) => symbol.name === "Box")?.kind).toBe("class");
    // Catalog name, not a slice unit.
    expect(outline.symbols.find((symbol) => symbol.name === "inner")?.kind).toBe("variable");

    const classified = await provider.classifyHits({
      path: "sample.md",
      languageId: "markdown",
      text,
      revision: "rev-1",
      lines: [2, 3],
    });
    expect(classified.status).toBe("ready");
    expect(classified.hits.find((hit) => hit.line === 2)?.class).toBe("name");
  });

  it("reports unsupported for a language with a grammar but no query", async () => {
    const provider = createTreeSitterStructureProvider({
      parseBudgetMs: 30_000,
      resolveInstalledLanguage: () => null,
    });
    expect(provider.capabilities("swift")).toEqual(NO_STRUCTURE_CAPABILITIES);
    const outline = await provider.outline({ path: "a.swift", languageId: "swift", text: "x = 1", revision: "rev-1" });
    expect(outline.status).toBe("unsupported");
    expect(outline.symbols).toEqual([]);
  });

  it("does not treat a bundled or installed empty query as usable structure", async () => {
    const provider = createTreeSitterStructureProvider({
      resolveInstalledLanguage: () => ({ grammarFile: "tree-sitter-javascript.wasm", tagsQuery: "" }),
    });
    expect(provider.capabilities("markdown")).toEqual(NO_STRUCTURE_CAPABILITIES);
    const outline = await provider.outline({ path: "a.md", languageId: "markdown", text: "# title", revision: "rev-1" });
    expect(outline.status).toBe("unavailable");
    expect(outline.message).toMatch(/query is not readable/i);
  });

  it("notifies the host when a structure request names a language", async () => {
    const seen: Array<{ languageId: string; workspaceId?: string }> = [];
    const provider = createTreeSitterStructureProvider({
      onLanguageRequest: (languageId, workspaceId) => {
        seen.push(workspaceId ? { languageId, workspaceId } : { languageId });
      },
    });
    await provider.outline({
      path: "app.py",
      languageId: "python",
      text: "print('x')",
      revision: "r1",
      workspaceId: "ws-1",
    });
    expect(seen).toEqual([{ languageId: "python", workspaceId: "ws-1" }]);
  });

  it("turns a missing import or literal-call query into unsupported, not failed", async () => {
    const provider = createTreeSitterStructureProvider({ parseBudgetMs: 30_000 });
    const python = await provider.literalCalls({
      path: "a.py",
      languageId: "python",
      text: "print('x')",
      revision: "r1",
    });
    expect(python.status).toBe("unsupported");
    expect(python.calls).toEqual([]);
  });
});

describe("createTreeSitterStructureProvider", () => {
  it("outlines TypeScript units from the vendored wasm", async () => {
    const provider = parsingProvider();
    const text = [
      "import { join } from \"node:path\";",
      "export function needle() {",
      "  return join(\"a\");",
      "}",
      "export class Box {}",
    ].join("\n");
    const outline = await provider.outline(request(text));
    expect(outline.status).toBe("ready");
    expect(outline.provider).toBe("tree-sitter");
    expect(outline.symbols.map((symbol) => symbol.name)).toEqual(expect.arrayContaining(["needle", "Box"]));
    const needle = outline.symbols.find((symbol) => symbol.name === "needle");
    expect(needle?.kind).toBe("function");
    expect(needle?.range).toEqual({ startLine: 2, endLine: 4 });
    const calls = await provider.literalCalls(request(text));
    expect(calls.status).toBe("ready");
    expect(calls.calls).toEqual(expect.arrayContaining([expect.objectContaining({ name: "join", literal: "a" })]));
    const imports = await provider.imports(request(text));
    expect(imports.status).toBe("ready");
    expect(imports.imports).toEqual(expect.arrayContaining([expect.objectContaining({ source: "node:path" })]));
  });

  /**
   * A "connection" is a call whose *first* argument is the string. The query
   * used to match a string anywhere in the arguments, and it missed awaited
   * generic calls because tree-sitter-typescript attaches `await` to the callee
   * in `await x.request<T>(…)` (D-143).
   */
  it("extracts literal calls only from a leading string argument, including awaited generics", async () => {
    const provider = parsingProvider();
    const text = [
      "router.register(handler, \"not-first\");",
      "router.register(\"actual\", \"second\");",
      "const r = await bridge.request<\"explore.search\">(\"explore.search\", { q });",
      "await request<\"wire\">(\"wire\");",
      "emit(`tpl-${a}`, payload);",
    ].join("\n");
    const calls = await provider.literalCalls(request(text));
    expect(calls.status).toBe("ready");
    expect(calls.calls.map((call) => `${call.name}:${call.literal}@${call.line}`)).toEqual([
      "register:actual@2",
      "request:explore.search@3",
      "request:wire@4",
    ]);
  });

  it("classifies declaration names differently from comments and strings", async () => {
    const provider = parsingProvider();
    const text = [
      "// needle",
      "export function needle() {",
      "  return \"needle\";",
      "}",
    ].join("\n");
    const classified = await provider.classifyHits({ ...request(text), lines: [1, 2, 3] });
    expect(classified.status).toBe("ready");
    expect(classified.hits).toEqual([
      { line: 1, class: "comment" },
      { line: 2, class: "name" },
      { line: 3, class: "string" },
    ]);
  });

  it("keeps definition bindings and skips ordinary value bindings as units", async () => {
    const provider = parsingProvider();
    const text = [
      "export function wrap() {",
      "  const foo = () => {",
      "    return 1;",
      "  };",
      "  const needle = 1;",
      "  return foo;",
      "}",
      "export const C = class {",
      "  x = 1;",
      "};",
    ].join("\n");
    const outline = await provider.outline(request(text));
    expect(outline.status).toBe("ready");
    const names = outline.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(expect.arrayContaining(["wrap", "foo", "C"]));
    expect(names).not.toContain("needle");
    expect(outline.symbols.find((symbol) => symbol.name === "foo")?.kind).toBe("function");
    expect(outline.symbols.find((symbol) => symbol.name === "C")?.kind).toBe("class");
  });

  it("outlines var, declare function, namespace, and export default class", async () => {
    const provider = parsingProvider();
    const text = [
      "var zeta = 1;",
      "declare function eta(): void;",
      "namespace Epsilon { export const z = 1 }",
      "export default class {}",
    ].join("\n");
    const outline = await provider.outline(request(text));
    expect(outline.status).toBe("ready");
    const names = outline.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(expect.arrayContaining(["eta", "Epsilon", "default"]));
    // Module-level value bindings are catalog names, not slice units (D-113).
    expect(outline.symbols.find((symbol) => symbol.name === "zeta")?.kind).toBe("variable");
    expect(outline.symbols.find((symbol) => symbol.name === "Epsilon")?.kind).toBe("module");
  });

  it("outlines module-level value bindings but not function-local ones", async () => {
    const provider = parsingProvider();
    const text = [
      "export const DEFAULT_BYTE_BUDGET = 24576;",
      "export const TABLE = { a: 1 };",
      "class Holder { field = 2; }",
      "function wrap() {",
      "  const localOnly = 3;",
      "  for (const each of []) void each;",
      "  return localOnly;",
      "}",
    ].join("\n");
    const outline = await provider.outline(request(text));
    expect(outline.status).toBe("ready");
    const names = outline.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(expect.arrayContaining(["DEFAULT_BYTE_BUDGET", "TABLE", "field", "Holder", "wrap"]));
    expect(names).not.toContain("localOnly");
    expect(names).not.toContain("each");
    expect(outline.symbols.find((symbol) => symbol.name === "DEFAULT_BYTE_BUDGET")?.kind).toBe("variable");
    // Slicing still refuses value bindings as units, so D-098 is unaffected.
    expect(isStructureContainerKind("variable")).toBe(false);
  });

  it("outlines arrows, declare class/namespace, abstract members, and object methods", async () => {
    const provider = parsingProvider();
    const text = [
      "const beta = () => { return 1; };",
      "export const gamma = () => { return 2; };",
      "export default function delta() { return 3; }",
      "declare class Alpha { bar(): void }",
      "declare namespace Omega { export const n = 1 }",
      "abstract class Box {",
      "  abstract needle(): void;",
      "  concrete() { return 1; }",
      "}",
      "const obj = {",
      "  method() { return 1; }",
      "};",
    ].join("\n");
    const outline = await provider.outline(request(text));
    expect(outline.status).toBe("ready");
    const names = outline.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(expect.arrayContaining(["beta", "gamma", "delta", "Alpha", "Omega", "Box", "concrete", "method"]));
    expect(names).not.toContain("needle");
    expect(outline.symbols.find((symbol) => symbol.name === "obj")?.kind).toBe("variable");
    expect(outline.symbols.find((symbol) => symbol.name === "beta")?.kind).toBe("function");
    expect(outline.symbols.find((symbol) => symbol.name === "Alpha")?.kind).toBe("class");
    expect(outline.symbols.find((symbol) => symbol.name === "Omega")?.kind).toBe("module");
  });

  it("reports cancelled when the signal is already aborted", async () => {
    const provider = parsingProvider();
    const signal = AbortSignal.abort();
    const result = await provider.outline({ ...request("export function needle() { return 1; }"), signal });
    expect(result.status).toBe("cancelled");
    expect(result.symbols).toEqual([]);
  });

  it("reports failed when the parse budget is exhausted", async () => {
    const provider = createTreeSitterStructureProvider({ parseBudgetMs: 0 });
    const text = Array.from({ length: 400 }, (_, index) => `export function item${index}() { return ${index}; }`).join("\n");
    const result = await provider.outline(request(text));
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/budget exhausted/i);
    expect(result.symbols).toEqual([]);
  });

  it("reports unavailable when the runtime wasm cannot be read", async () => {
    const empty = mkdtempSync(join(tmpdir(), "varin-structure-runtime-"));
    const provider = createTreeSitterStructureProvider({
      runtimeFromUrl: pathToFileURL(join(empty, "missing.js")).href,
    });
    const result = await provider.outline(request("export function needle() { return 1; }"));
    expect(result.status).toBe("unavailable");
    expect(result.message).toMatch(/not readable/i);
  });

  it("outlines JavaScript functions, require imports, and field definitions", async () => {
    const provider = parsingProvider();
    const text = [
      "const { join } = require(\"node:path\");",
      "function boot() {",
      "  router.register(\"explore.search\");",
      "  console.log(\"explore.search\");",
      "  return join(\"a\");",
      "}",
      "class Box {",
      "  ready = () => 1;",
      "}",
    ].join("\n");
    const outline = await provider.outline(request(text, "boot.js"));
    expect(outline.status).toBe("ready");
    const names = outline.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(expect.arrayContaining(["boot", "Box", "ready"]));
    expect(outline.symbols.find((symbol) => symbol.name === "ready")?.kind).toBe("function");
    const imports = await provider.imports(request(text, "boot.js"));
    expect(imports.status).toBe("ready");
    expect(imports.imports).toEqual(expect.arrayContaining([expect.objectContaining({ source: "node:path" })]));
    const calls = await provider.literalCalls(request(text, "boot.js"));
    expect(calls.status).toBe("ready");
    expect(calls.calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "register", literal: "explore.search" }),
      expect.objectContaining({ name: "log", literal: "explore.search" }),
    ]));
  });

  it("outlines a JSX component from the JavaScript grammar", async () => {
    const provider = parsingProvider();
    const text = [
      "export function Badge({ label }) {",
      "  return <span className=\"badge\">{label}</span>;",
      "}",
    ].join("\n");
    const outline = await provider.outline(request(text, "Badge.jsx"));
    expect(outline.status).toBe("ready");
    expect(outline.symbols.find((symbol) => symbol.name === "Badge")?.kind).toBe("function");
  });

  it("outlines JSON pairs and object containers, and rejects imports", async () => {
    const provider = parsingProvider();
    const text = [
      "{",
      "  \"name\": \"varin\",",
      "  \"config\": {",
      "    \"enabled\": true,",
      "    \"nested\": { \"needle\": 1 }",
      "  }",
      "}",
    ].join("\n");
    const outline = await provider.outline(request(text, "pkg.json"));
    expect(outline.status).toBe("ready");
    const names = outline.symbols.map((symbol) => symbol.name);
    expect(names).toEqual(expect.arrayContaining(["$", "name", "config", "nested"]));
    expect(names).not.toContain("enabled");
    expect(names).not.toContain("needle");
    expect(outline.symbols.find((symbol) => symbol.name === "name")?.kind).toBe("property");
    expect(outline.symbols.find((symbol) => symbol.kind === "object" && symbol.name === "config")).toBeTruthy();
    expect(isJsonStructureContainerKind("property")).toBe(true);
    expect(isStructureContainerKind("property")).toBe(false);
    expect(CATALOG_SCAN_LANGUAGES.has("json")).toBe(false);
    expect(CATALOG_SCAN_LANGUAGES.has("javascript")).toBe(true);
    const imports = await provider.imports(request(text, "pkg.json"));
    expect(imports.status).toBe("unsupported");
    const calls = await provider.literalCalls(request(text, "pkg.json"));
    expect(calls.status).toBe("unsupported");
    const classified = await provider.classifyHits({ ...request(text, "pkg.json"), lines: [2, 4] });
    expect(classified.status).toBe("ready");
    expect(classified.hits).toEqual(expect.arrayContaining([
      { line: 2, class: "name" },
    ]));
  });

  it("extracts representative symbols from every bundled common grammar", async () => {
    const provider = parsingProvider();
    const samples: Array<{ languageId: string; path: string; text: string; name: string }> = [
      { languageId: "python", path: "sample.py", text: "class Box:\n  def run(self):\n    return 1\n", name: "Box" },
      { languageId: "go", path: "sample.go", text: "package main\nfunc Run() {}\ntype Box struct {}\n", name: "Run" },
      { languageId: "rust", path: "sample.rs", text: "struct Box {}\nfn run() {}\n", name: "Box" },
      { languageId: "java", path: "Sample.java", text: "class Box { void run() {} }\n", name: "Box" },
      { languageId: "c", path: "sample.c", text: "struct Box { int x; };\nint run() { return 1; }\n", name: "run" },
      { languageId: "cpp", path: "sample.cpp", text: "class Box {};\nint run() { return 1; }\n", name: "run" },
      { languageId: "csharp", path: "Sample.cs", text: "class Box { void Run() {} }\n", name: "Box" },
      { languageId: "kotlin", path: "Sample.kt", text: "class Box { fun run() {} }\nfun top() {}\n", name: "Box" },
      { languageId: "ruby", path: "sample.rb", text: "class Box\n  def run\n  end\nend\n", name: "Box" },
      { languageId: "php", path: "sample.php", text: "<?php class Box { function run() {} }\n", name: "Box" },
      { languageId: "shellscript", path: "build.sh", text: "function build() { echo hi; }\n", name: "build" },
      { languageId: "css", path: "style.css", text: ".box { color: red; }\n", name: "box" },
      { languageId: "html", path: "index.html", text: "<div><span>Hi</span></div>\n", name: "div" },
      { languageId: "yaml", path: "config.yaml", text: "name: app\nservices:\n  web: nginx\n", name: "services" },
      { languageId: "toml", path: "Cargo.toml", text: "[package]\nname = \"app\"\n", name: "package" },
    ];
    for (const sample of samples) {
      const outline = await provider.outline({ ...sample, revision: `bundled-${sample.languageId}` });
      expect(outline.status, `${sample.languageId}: ${outline.message ?? ""}`).toBe("ready");
      expect(outline.symbols.map((symbol) => symbol.name), sample.languageId).toContain(sample.name);
    }
  });
});
