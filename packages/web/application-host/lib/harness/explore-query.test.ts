import { describe, expect, it } from "vitest";
import {
  buildTermGroups,
  classifyFileRole,
  fileRoleFit,
  parseExploreQuery,
} from "./explore-query.js";

describe("parseExploreQuery", () => {
  it("protects a dotted technical object and treats the rest as content", () => {
    const parsed = parseExploreQuery("where is the explore.search service registered on the host router");
    expect(parsed.objects).toEqual(["explore.search"]);
    expect(parsed.relation).toBe("register");
    expect(parsed.domain).toBe("implementation");
    expect(parsed.content).toEqual(expect.arrayContaining(["service", "host", "router"]));
    expect(parsed.groups.filter((group) => group.kind === "identifier")).toEqual([]);
    expect(parsed.groups.find((group) => group.distinctive === "explore.search")?.kind).toBe("literal");
    expect(parsed.preferTests).toBe(false);
  });

  it("keeps quoted and backticked forms as the same object", () => {
    expect(parseExploreQuery("`explore.search`").objects).toEqual(["explore.search"]);
    expect(parseExploreQuery('find "explore.search"').objects).toEqual(["explore.search"]);
  });

  it("keeps camelCase as an object and does not let splits vote separately", () => {
    const parsed = parseExploreQuery("where is createMemoryAgentExtension");
    const group = parsed.groups.find((item) => item.distinctive === "createMemoryAgentExtension");
    expect(group?.kind).toBe("identifier");
    expect(group?.variants).toEqual(expect.arrayContaining(["createMemoryAgentExtension", "Agent", "Extension"]));
    expect(parsed.groups.filter((item) => item.kind === "identifier")).toHaveLength(1);
  });

  it("does not upgrade ordinary English or Chinese sentence words to identifiers", () => {
    const english = parseExploreQuery("how does explore decide which files to read after ripgrep returns hits");
    expect(english.objects).toEqual([]);
    expect(english.groups.every((group) => group.kind === "question")).toBe(true);
    const chinese = parseExploreQuery("请找一下 explore.search 的注册位置");
    expect(chinese.objects).toEqual(["explore.search"]);
    expect(chinese.relation).toBe("register");
    expect(chinese.groups.some((group) => group.kind === "identifier" && group.distinctive === "位置")).toBe(false);
    expect(chinese.content).not.toContain("请找一下");
  });

  it("treats a bare on as an object query instead of swallowing it", () => {
    const parsed = parseExploreQuery("on");
    expect(parsed.objects).toEqual(["on"]);
    expect(parsed.groups[0]?.kind).toBe("identifier");
  });

  it("treats on(...) / emitter.on as an object and leaves a sentence-level on as a stopword", () => {
    expect(parseExploreQuery("emitter.on").objects).toEqual(["emitter.on"]);
    expect(parseExploreQuery("where is explore.search registered on the host").objects).not.toContain("on");
  });

  it("does not invent relations outside the closed table", () => {
    expect(parseExploreQuery("who calls explore.search").relation).toBe("unknown");
    expect(parseExploreQuery("who references explore.search").relation).toBe("unknown");
  });

  it("keeps hyphenated package names as objects without treating them as connection values", () => {
    const parsed = parseExploreQuery("where do we decide a tree-sitter grammar can produce an outline");
    expect(parsed.objects).toEqual(expect.arrayContaining(["tree-sitter"]));
    expect(parsed.domain).toBe("implementation");
    expect(parsed.groups.find((group) => group.distinctive === "tree-sitter")?.kind).toBe("literal");
  });

  it("treats how-does questions as implementation without turning sentence words into identifiers", () => {
    const parsed = parseExploreQuery("how does explore decide which files to read after ripgrep returns hits");
    expect(parsed.domain).toBe("implementation");
    expect(parsed.objects).toEqual([]);
    expect(parsed.groups.every((group) => group.kind === "question")).toBe(true);
  });

  it("keeps blank anchors in supplied and omits them from used", () => {
    const { suppliedAnchors, usedAnchors, groups } = buildTermGroups("needle", ["foo", "", "  "]);
    expect(suppliedAnchors).toEqual(["foo", "", "  "]);
    expect(usedAnchors).toEqual(["foo"]);
    expect(groups.filter((group) => group.kind === "anchor").map((group) => group.distinctive)).toEqual(["foo"]);
  });
});

describe("file roles", () => {
  it("classifies source, test, docs, and lock without using provider status", () => {
    expect(classifyFileRole("packages/web/application-host/lib/harness/explore.ts")).toBe("source");
    expect(classifyFileRole("packages/pi-host/test/harness/session-e2e.test.ts")).toBe("test");
    expect(classifyFileRole("docs/design/agent-harness.md")).toBe("docs");
    expect(classifyFileRole("bun.lock")).toBe("lock");
    expect(classifyFileRole("LICENSE")).toBe("lock");
  });

  it("fits implementation questions to source, not lockfiles", () => {
    expect(fileRoleFit("source", "implementation", false)).toBeGreaterThan(fileRoleFit("docs", "implementation", false));
    expect(fileRoleFit("lock", "implementation", false)).toBeLessThan(0);
    expect(fileRoleFit("docs", "design", null)).toBeGreaterThan(fileRoleFit("source", "design", null));
    expect(fileRoleFit("lock", "dependency", null)).toBe(2);
  });
});
