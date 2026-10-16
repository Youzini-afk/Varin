import { describe, expect, it } from "vitest";
import { classifyFileRole, classifyFileRoleDecision, fileRoleFit } from "./file-role.js";

describe("shared file role", () => {
  it("uses filename patterns for source, test, docs, and lock", () => {
    expect(classifyFileRoleDecision("packages/web/application-host/lib/harness/explore.ts")).toEqual({
      role: "source",
      ground: "filename-pattern",
    });
    expect(classifyFileRoleDecision("packages/web/application-host/lib/harness/explore.test.ts")).toEqual({
      role: "test",
      ground: "filename-pattern",
    });
    expect(classifyFileRoleDecision("docs/design/agent-harness.md")).toEqual({
      role: "docs",
      ground: "filename-pattern",
    });
    expect(classifyFileRoleDecision("bun.lock")).toEqual({
      role: "lock",
      ground: "filename-pattern",
    });
  });

  it("marks project manifests as other via project-declaration, not a new persisted role", () => {
    expect(classifyFileRoleDecision("package.json")).toEqual({
      role: "other",
      ground: "project-declaration",
    });
    expect(classifyFileRoleDecision("tsconfig.build.json")).toEqual({
      role: "other",
      ground: "project-declaration",
    });
    expect(classifyFileRoleDecision("apps/api/pyproject.toml")).toEqual({
      role: "other",
      ground: "project-declaration",
    });
    expect(classifyFileRole("package.json")).toBe("other");
    expect(classifyFileRole("LICENSE")).toBe("lock");
  });

  it("keeps lockfiles on the lock filename pattern even when they look like manifests", () => {
    expect(classifyFileRoleDecision("package-lock.json")).toEqual({
      role: "lock",
      ground: "filename-pattern",
    });
  });

  it("reports unknown when no pattern or project declaration matches", () => {
    expect(classifyFileRoleDecision("notes/todo.txt")).toEqual({
      role: "other",
      ground: "unknown",
    });
  });

  it("matches file roles to implementation, design and dependency questions", () => {
    expect(fileRoleFit("source", "implementation", false)).toBeGreaterThan(fileRoleFit("docs", "implementation", false));
    expect(fileRoleFit("lock", "implementation", false)).toBeLessThan(0);
    expect(fileRoleFit("docs", "design", null)).toBeGreaterThan(fileRoleFit("source", "design", null));
    expect(fileRoleFit("lock", "dependency", null)).toBeGreaterThan(fileRoleFit("source", "dependency", null));
  });
});
