import { describe, expect, it } from "vitest";
import {
  LOCAL_DEFAULT_MAX_TOKENS,
  blockIdentity,
  intraOpThreads,
  parentUnitIdentity,
  recipeIdOf,
  semanticGenerationDir,
  spaceIdOf,
  workspaceScope,
  LOCAL_DEFAULT_SPACE,
  defaultRecipeIdentity,
} from "./identity.js";

describe("semantic identity", () => {
  it("builds generation paths from the scope key and never names a workspaceId segment", () => {
    const alpha = semanticGenerationDir("data", "host-1", { scopeKind: "workspace", scopeId: "alpha" }, "space", "g1");
    const beta = semanticGenerationDir("data", "host-1", { scopeKind: "workspace", scopeId: "beta" }, "space", "g1");
    expect(alpha).toContain("semantic");
    expect(alpha).toContain("workspace");
    expect(alpha).toContain("alpha");
    expect(alpha).not.toBe(beta);
    expect(alpha.includes("workspaceId")).toBe(false);
    expect(blockIdentity("src/a.ts", 1, 4)).not.toContain("alpha");
    expect(parentUnitIdentity("src/a.ts", "run", "function")).not.toContain("alpha");
  });

  it("treats documentId as an opaque identity, including non-path characters", () => {
    const id = blockIdentity("mail:abc123", 4, 12);
    expect(id).toContain(encodeURIComponent("mail:abc123"));
    expect(id).not.toMatch(/mail:abc123#/u);
    expect(parentUnitIdentity("mail:abc123", "Handler", "class")).toContain(encodeURIComponent("mail:abc123"));
  });

  it("puts effective source packing length into the default space identity", () => {
    expect(LOCAL_DEFAULT_MAX_TOKENS).toBe(512);
    expect(LOCAL_DEFAULT_SPACE.maxTokens).toBe(512);
    expect(LOCAL_DEFAULT_SPACE.dim).toBe(384);
    expect(spaceIdOf(LOCAL_DEFAULT_SPACE)).not.toBe(spaceIdOf({ ...LOCAL_DEFAULT_SPACE, maxTokens: 256 }));
    expect(recipeIdOf()).toBe(recipeIdOf(defaultRecipeIdentity()));
  });

  it("maps a workspace id to a scope key only at the workspaceScope helper", () => {
    expect(workspaceScope("ws-9")).toEqual({ scopeKind: "workspace", scopeId: "ws-9" });
  });

  it("caps intra-op threads at half the cores", () => {
    expect(intraOpThreads(12)).toBe(6);
    expect(intraOpThreads(1)).toBe(1);
  });
});
