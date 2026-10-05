import { describe, it, expect } from "vitest";
import {
  evaluateGate,
  defaultRules,
  mergePolicies,
  isHighRisk,
  permissionPatternIssue,
  PermissionPolicyValidationError,
  type PermissionPolicy,
} from "./permission-gate.js";

describe("evaluateGate", () => {
  it("allows read-only tools in normal mode", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("read", {}, policy).decision).toBe("allow");
    expect(evaluateGate("grep", {}, policy).decision).toBe("allow");
    expect(evaluateGate("explore", {}, policy).decision).toBe("allow");
  });

  it("asks for edit tools in normal mode", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("edit", {}, policy).decision).toBe("ask");
    expect(evaluateGate("write", {}, policy).decision).toBe("ask");
    expect(evaluateGate("apply_patch", {}, policy).decision).toBe("ask");
    expect(evaluateGate("merge", {}, policy).decision).toBe("ask");
  });

  it("allows edit tools in accept-edits mode", () => {
    const policy: PermissionPolicy = { mode: "accept-edits", rules: defaultRules("accept-edits") };
    expect(evaluateGate("edit", {}, policy).decision).toBe("allow");
    expect(evaluateGate("write", {}, policy).decision).toBe("allow");
  });

  it("asks for bash in normal mode", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("bash", { command: "ls" }, policy).decision).toBe("ask");
  });

  it("asks for high-risk bash even in accept-edits", () => {
    const policy: PermissionPolicy = { mode: "accept-edits", rules: defaultRules("accept-edits") };
    expect(evaluateGate("bash", { command: "rm -rf /" }, policy).decision).toBe("ask");
    expect(evaluateGate("bash", { command: "sudo apt install foo" }, policy).decision).toBe("ask");
    expect(evaluateGate("bash", { command: "git push origin main" }, policy).decision).toBe("ask");
  });

  it("asks for npm install", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("bash", { command: "npm install foo" }, policy).decision).toBe("ask");
    expect(evaluateGate("bash", { command: "bun add foo" }, policy).decision).toBe("ask");
  });

  it("asks for .env paths", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("bash", { command: "cat .env" }, policy).decision).toBe("ask");
  });

  it("allows everything in bypass mode", () => {
    const policy: PermissionPolicy = { mode: "bypass", rules: defaultRules("bypass") };
    expect(evaluateGate("edit", {}, policy).decision).toBe("allow");
    expect(evaluateGate("bash", { command: "rm -rf /" }, policy).decision).toBe("allow");
  });

  it("dispatch respects askBefore", () => {
    const policy: PermissionPolicy = {
      mode: "normal",
      rules: defaultRules("normal", { "worker": true }),
    };
    expect(evaluateGate("dispatch", { preset: "worker" }, policy).decision).toBe("ask");
  });

  it("treats askBefore preset names as literals rather than regular expressions", () => {
    const policy: PermissionPolicy = {
      mode: "normal",
      rules: defaultRules("normal", { "review.*": true }),
    };
    expect(evaluateGate("dispatch", { preset: "review.*" }, policy).decision).toBe("ask");
    expect(evaluateGate("dispatch", { preset: "review-fast" }, policy).decision).toBe("allow");
  });

  it("rules evaluated top-down, first match wins", () => {
    const policy: PermissionPolicy = {
      mode: "normal",
      rules: [
        { tool: "bash", match: { param: "command", pattern: "^ls$" }, decision: "allow" },
        { tool: "bash", decision: "ask" },
      ],
    };
    expect(evaluateGate("bash", { command: "ls" }, policy).decision).toBe("allow");
    expect(evaluateGate("bash", { command: "rm" }, policy).decision).toBe("ask");
  });

  it("unknown tools ask because Varin is the sole permission authority", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("unknown_tool", {}, policy).decision).toBe("ask");
  });

  it("find/get_output/diagnostics/webfetch/websearch/kill_shell are allow (mutation: none)", () => {
    const policy: PermissionPolicy = { mode: "normal", rules: defaultRules("normal") };
    expect(evaluateGate("find", {}, policy).decision).toBe("allow");
    expect(evaluateGate("get_output", {}, policy).decision).toBe("allow");
    expect(evaluateGate("diagnostics", {}, policy).decision).toBe("allow");
    expect(evaluateGate("webfetch", {}, policy).decision).toBe("allow");
    expect(evaluateGate("websearch", {}, policy).decision).toBe("allow");
    expect(evaluateGate("kill_shell", {}, policy).decision).toBe("allow");
  });
});

describe("mergePolicies", () => {
  it("workspace cannot loosen the user mode", () => {
    const user: PermissionPolicy = { mode: "normal", rules: [] };
    const merged = mergePolicies(user, { mode: "accept-edits" });
    expect(merged.mode).toBe("normal");
  });

  it("workspace allow rules are ignored", () => {
    const user: PermissionPolicy = { mode: "normal", rules: [{ tool: "*", decision: "ask" }] };
    const merged = mergePolicies(user, { rules: [{ tool: "*", decision: "allow" }] });
    expect(merged.rules).toEqual(user.rules);
  });

  it("workspace deny rules precede user allows, including in bypass mode", () => {
    const user: PermissionPolicy = { mode: "bypass", rules: [{ tool: "bash", decision: "allow" }] };
    const merged = mergePolicies(user, {
      rules: [{ tool: "bash", match: { param: "command", pattern: "^deploy" }, decision: "deny" }],
    });
    expect(evaluateGate("bash", { command: "deploy prod" }, merged).decision).toBe("deny");
    expect(evaluateGate("bash", { command: "echo ok" }, merged).decision).toBe("allow");
  });

  it("falls back to user when workspace doesn't specify", () => {
    const user: PermissionPolicy = { mode: "normal", rules: [{ tool: "*", decision: "deny" }] };
    const merged = mergePolicies(user, {});
    expect(merged.mode).toBe("normal");
    expect(merged.rules).toEqual(user.rules);
  });

  it("rejects backtracking-prone workspace regexes", () => {
    expect(permissionPatternIssue("(a+)+$")).toContain("quantified groups");
    expect(permissionPatternIssue("(a|aa)+$")).toContain("quantified groups");
    expect(permissionPatternIssue("((a|aa))+$")).toContain("quantified groups");
    expect(() => mergePolicies(
      { mode: "normal", rules: [] },
      { rules: [{ tool: "bash", match: { param: "command", pattern: "(a+)+$" }, decision: "deny" }] },
    )).toThrow(PermissionPolicyValidationError);
  });

  it("rejects malformed modes, rule arrays, and match objects from JSON settings", () => {
    expect(() => mergePolicies(
      { mode: "surprise" as never, rules: [] },
      {},
    )).toThrow(PermissionPolicyValidationError);
    expect(() => mergePolicies(
      { mode: "normal", rules: {} as never },
      {},
    )).toThrow(PermissionPolicyValidationError);
    expect(() => mergePolicies(
      { mode: "normal", rules: [{ tool: "bash", match: null as never, decision: "ask" }] },
      {},
    )).toThrow(PermissionPolicyValidationError);
  });
});

describe("isHighRisk", () => {
  it("detects rm command", () => {
    expect(isHighRisk("bash", { command: "rm -rf /" })).toBe(true);
  });

  it("detects sudo", () => {
    expect(isHighRisk("bash", { command: "sudo make me a sandwich" })).toBe(true);
  });

  it("detects git push", () => {
    expect(isHighRisk("bash", { command: "git push origin main" })).toBe(true);
  });

  it("detects npm install", () => {
    expect(isHighRisk("bash", { command: "npm install express" })).toBe(true);
  });

  it("checks commands sent to a running process and apply_patch file headers", () => {
    expect(isHighRisk("write_to_process", { text: "git push origin main" })).toBe(true);
    expect(isHighRisk("apply_patch", { patch: "*** Begin Patch\n*** Update File: .ENV\n*** End Patch" })).toBe(true);
  });

  it("detects .env path", () => {
    expect(isHighRisk("write", { path: ".env" })).toBe(true);
  });

  it("detects id_rsa path", () => {
    expect(isHighRisk("write", { path: "~/.ssh/id_rsa" })).toBe(true);
  });

  it("non-shell tools are not high risk", () => {
    expect(isHighRisk("read", { path: ".env" })).toBe(false);
  });

  it("safe commands are not high risk", () => {
    expect(isHighRisk("bash", { command: "ls -la" })).toBe(false);
    expect(isHighRisk("bash", { command: "bun test" })).toBe(false);
  });
});
