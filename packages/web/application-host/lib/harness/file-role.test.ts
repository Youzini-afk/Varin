import { describe, expect, it } from "vitest";
import { classifyFileRole, classifyFileRoleDecision, fileRoleFit } from "./file-role.js";
import { classifyFileRole as exploreClassifyFileRole } from "./explore-query.js";

describe("shared file role", () => {
  it("uses filename patterns for source, test, docs, and lock", () => {
    expect(classifyFileRoleDecision("packages/web/application-host/lib/harness/explore.ts")).toEqual({
      role: "source",
      ground: "filename-pattern",
    });
    expect(classifyFileRoleDecision("packages/pi-host/test/harness/session-e2e.test.ts")).toEqual({
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

  it("is the same function explore already uses", () => {
    expect(exploreClassifyFileRole).toBe(classifyFileRole);
    expect(fileRoleFit("source", "implementation", false)).toBeGreaterThan(fileRoleFit("docs", "implementation", false));
  });
});
