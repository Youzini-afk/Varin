/**
 * Native permission gate — tool_call gating with policy file.
 *
 * Design: design/harness-verification.md §9.1.2
 * Plan: plan/agent-harness-plan.md §3b.1
 *
 * Policy schema: { mode, rules: [{ tool, match?, decision }] }
 * mode: normal | accept-edits | bypass | smart
 * Default rules: mutation:none → allow; edit/write/apply_patch/merge →
 *   ask (normal) / allow (accept-edits); bash/write_to_process → ask;
 *   bypass → all allow; dispatch → askBefore[preset]
 * Rules evaluated top-down, first match wins.
 *
 * Pure types and evaluation functions are in @varin/protocol
 * (permission-gate.ts) so both pi-host and web host can use them
 * without cross-package imports.
 */

export {
  type PermissionMode,
  type PermissionDecision,
  type PermissionRule,
  type PermissionPolicy,
  type GateResult,
  evaluateGate,
  defaultRules,
  mergePolicies,
  normalizeFrozenHarnessPermissions,
  isHighRisk,
  HIGH_RISK_PATTERNS,
  MAX_PERMISSION_PATTERN_LENGTH,
  PermissionPolicyValidationError,
  permissionPatternIssue,
  validatePermissionMode,
  validatePermissionRule,
} from "@varin/protocol";
