/** Shared permission policy validation and native tool admission. */

export type PermissionMode = "normal" | "accept-edits" | "bypass" | "smart";
export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionRule {
  tool: string | "*";
  match?: { param: string; pattern: string };
  decision: PermissionDecision;
}

export interface PermissionPolicy {
  mode: PermissionMode;
  rules: PermissionRule[];
}

export interface GateResult {
  decision: PermissionDecision;
  reason?: string;
}

export const MAX_PERMISSION_PATTERN_LENGTH = 512;

export class PermissionPolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionPolicyValidationError";
  }
}

const PERMISSION_MODES = new Set<PermissionMode>(["normal", "accept-edits", "bypass", "smart"]);

export function validatePermissionMode(value: unknown, source = "permission"): PermissionMode {
  if (typeof value !== "string" || !PERMISSION_MODES.has(value as PermissionMode)) {
    throw new PermissionPolicyValidationError(`${source} mode is invalid`);
  }
  return value as PermissionMode;
}

/**
 * Accept the regular subset needed by command/path policies while rejecting
 * constructs that can make JavaScript's backtracking engine super-linear.
 * 512 characters is over ten times the built-in policy patterns and still
 * leaves ample room for path/command matchers; it is a configuration error,
 * not a limit on commands or paths being evaluated.
 */
export function permissionPatternIssue(pattern: string): string | null {
  if (pattern.length > MAX_PERMISSION_PATTERN_LENGTH) {
    return `pattern exceeds ${MAX_PERMISSION_PATTERN_LENGTH} characters`;
  }
  try {
    new RegExp(pattern);
  } catch {
    return "pattern is not a valid regular expression";
  }
  if (/\\(?:[1-9]|k<)/.test(pattern)) return "backreferences are not supported";
  if (/\(\?(?:[=!]|<[=!])/.test(pattern)) return "lookaround is not supported";

  const stack: Array<{ alternation: boolean; variableQuantifier: boolean }> = [];
  let inClass = false;
  let escaped = false;
  let closedGroup: { alternation: boolean; variableQuantifier: boolean } | null = null;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (escaped) {
      escaped = false;
      closedGroup = null;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      closedGroup = null;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === "(") {
      if (pattern.slice(index, index + 3) === "(?:") index += 2;
      stack.push({ alternation: false, variableQuantifier: false });
      closedGroup = null;
      continue;
    }
    if (char === ")") {
      closedGroup = stack.pop() ?? null;
      if (closedGroup && stack.length > 0) {
        const parent = stack[stack.length - 1]!;
        parent.alternation ||= closedGroup.alternation;
        parent.variableQuantifier ||= closedGroup.variableQuantifier;
      }
      continue;
    }
    if (char === "|") {
      if (stack.length > 0) stack[stack.length - 1]!.alternation = true;
      closedGroup = null;
      continue;
    }
    let variableQuantifier = char === "*" || char === "+" || char === "?";
    if (char === "{") {
      const match = pattern.slice(index).match(/^\{(\d+)(?:,(\d*)?)?\}/);
      if (match) {
        index += match[0].length - 1;
        variableQuantifier = match[2] !== undefined && match[2] !== match[1];
      }
    }
    if (variableQuantifier) {
      if (closedGroup?.alternation || closedGroup?.variableQuantifier) {
        return "quantified groups cannot contain alternation or another variable quantifier";
      }
      for (const group of stack) group.variableQuantifier = true;
      closedGroup = null;
      continue;
    }
    closedGroup = null;
  }
  return null;
}

export function validatePermissionRule(rule: PermissionRule, source = "permission"): PermissionRule {
  if (!rule || typeof rule !== "object") {
    throw new PermissionPolicyValidationError(`${source} rule must be an object`);
  }
  if (typeof rule.tool !== "string" || !rule.tool.trim()) {
    throw new PermissionPolicyValidationError(`${source} rule tool must be non-empty`);
  }
  if (rule.decision !== "allow" && rule.decision !== "ask" && rule.decision !== "deny") {
    throw new PermissionPolicyValidationError(`${source} rule has an invalid decision`);
  }
  const match = (rule as PermissionRule & { match?: unknown }).match;
  if (match !== undefined) {
    if (!match || typeof match !== "object" || Array.isArray(match)) {
      throw new PermissionPolicyValidationError(`${source} rule match must be an object`);
    }
    const candidate = match as Record<string, unknown>;
    if (typeof candidate.param !== "string" || !candidate.param.trim() || typeof candidate.pattern !== "string") {
      throw new PermissionPolicyValidationError(`${source} rule match must contain param and pattern strings`);
    }
    const issue = permissionPatternIssue(candidate.pattern);
    if (issue) throw new PermissionPolicyValidationError(`${source} rule ${issue}`);
  }
  return {
    tool: rule.tool,
    decision: rule.decision,
    ...(match ? {
      match: {
        param: (match as Record<string, unknown>).param as string,
        pattern: (match as Record<string, unknown>).pattern as string,
      },
    } : {}),
  };
}

// ── Gate evaluation (pure function, shared) ────────────────────────

export function evaluateGate(
  tool: string,
  params: Record<string, unknown>,
  policy: PermissionPolicy,
): GateResult {
  if (tool === "dispatch" && params.preset === undefined && params.capability === undefined && params.kind !== "discussion") {
    params = { ...params, preset: "worker" };
  }
  for (const rule of policy.rules) {
    if (rule.tool !== "*" && rule.tool !== tool) continue;

    if (rule.match) {
      const paramValue = params[rule.match.param];
      if (typeof paramValue !== "string") continue;
      const issue = permissionPatternIssue(rule.match.pattern);
      if (issue) return { decision: "deny", reason: `invalid permission rule: ${issue}` };
      if (!new RegExp(rule.match.pattern).test(paramValue)) continue;
    }

    return { decision: rule.decision, reason: `matched rule: tool=${rule.tool}` };
  }

  if (policy.mode === "bypass") {
    return { decision: "allow", reason: "bypass mode" };
  }

  // There is no second permission authority to delegate to. Unknown tools and
  // tools not covered by explicit/generated rules ask rather than pass through.
  return {
    decision: "ask",
    reason: "no matching permission rule; tool requires confirmation",
  };
}





export function mergePolicies(user: PermissionPolicy, workspace: Partial<PermissionPolicy>): PermissionPolicy {
  if (!Array.isArray(user.rules)) {
    throw new PermissionPolicyValidationError("user permission rules must be an array");
  }
  if (workspace.rules !== undefined && !Array.isArray(workspace.rules)) {
    throw new PermissionPolicyValidationError("workspace permission rules must be an array");
  }
  const userMode = validatePermissionMode(user.mode, "user permission");
  const requestedMode = workspace.mode === undefined
    ? undefined
    : validatePermissionMode(workspace.mode, "workspace permission");
  const ranks: Record<Exclude<PermissionMode, "smart">, number> = {
    bypass: 0,
    "accept-edits": 1,
    normal: 2,
  };
  const mode = requestedMode === undefined
    ? userMode
    : requestedMode === "smart"
      ? userMode
      : userMode === "smart"
        ? requestedMode === "normal" ? "normal" : "smart"
        : ranks[requestedMode] > ranks[userMode] ? requestedMode : userMode;
  const userRules = user.rules.map((rule, index) => (
    validatePermissionRule(rule, `user permission[${index}]`)
  ));
  const workspaceRules = (workspace.rules ?? [])
    .map((rule, index) => validatePermissionRule(rule, `workspace permission[${index}]`))
    .filter((rule) => rule.decision !== "allow");
  return {
    mode,
    // A workspace constraint must run before user allows or it would not
    // tighten a first-match policy at all.
    rules: [...workspaceRules, ...userRules],
  };
}
