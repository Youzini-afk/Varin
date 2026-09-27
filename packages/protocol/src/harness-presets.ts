/**
 * Execution presets — named, fixed configurations a dispatch can opt into.
 *
 * Design: agent-harness.md §9.2.2 / D-285
 * Plan: agent-harness-plan.md §3.18A
 *
 * Dispatch is task-centered: `task` is the core input and `preset` is
 * optional. A normal dispatch runs on the caller's current model and its
 * authorized tool set; a preset freezes a declared tool list, prompt
 * fragment, and a model resolved from the user-configured slot or an
 * explicit inherit. Unconfigured presets are omitted from the catalog and
 * rejected — they never borrow the main model silently.
 *
 * The catalog is a pure static table with no host dependencies, so it lives
 * in the protocol package: the host needs it to build a thread from a
 * preset, and pi-host needs it to build the `dispatch` tool's team prompt
 * and to reject presets whose model slot is not configured.
 */

import type { HarnessModelRole, ModelSelection } from "./harness-settings.js";
import { resolveHarnessModelSlot } from "./harness-model-slots.js";

// ── Types ──────────────────────────────────────────────────────────

export type PresetId =
  | "quick-implement"
  | "hard-implement"
  | "frontend"
  | "review"
  | "check"
  | "retrieval";

/**
 * Preset materialization policy. Write-capable work defaults to an
 * isolated WorkingState; `shared` is never preset-forced — it is an
 * explicit dispatch-time choice (D-285). `none` marks read-only presets
 * that need no WorkingState materialization at all.
 */
export type PresetWorktree = "isolated" | "none";

export interface ExecutionPreset {
  id: PresetId;
  slot: HarnessModelRole;
  tools: string[];
  worktree: PresetWorktree;
  /** Appended to the end of the thread's system prompt (Zone 0 stays shared). */
  systemPromptFragment: string;
  /** One clause describing the preset, used to build the team prompt. */
  teamDescription: string;
  resultSchema: unknown;
}

// ── Preset definitions ─────────────────────────────────────────────

export const EXECUTION_PRESETS: Readonly<Record<PresetId, ExecutionPreset>> = {
  "quick-implement": {
    id: "quick-implement",
    slot: "quickImplement",
    tools: ["read", "edit", "write", "apply_patch", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell"],
    worktree: "isolated",
    systemPromptFragment:
      "You are a quick implementation agent. Make mechanical, well-specified changes efficiently.",
    teamDescription: "mechanical, well-specified changes",
    resultSchema: { changedFiles: "string[]", conclusion: "string" },
  },
  "hard-implement": {
    id: "hard-implement",
    slot: "hardImplement",
    tools: ["read", "edit", "write", "apply_patch", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell", "explore", "recall", "todo", "dispatch", "threads", "wait", "send", "read_thread", "merge", "update", "kill"],
    worktree: "isolated",
    systemPromptFragment:
      "You are a hard implementation agent. Handle ambiguous or cross-cutting work that requires deeper reasoning.",
    teamDescription: "ambiguous or cross-cutting work",
    resultSchema: { changedFiles: "string[]", conclusion: "string", unresolved: "string[]" },
  },
  "frontend": {
    id: "frontend",
    slot: "frontend",
    tools: ["read", "edit", "write", "apply_patch", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell", "explore", "dispatch", "threads", "wait", "send", "read_thread", "merge", "update", "kill"],
    worktree: "isolated",
    systemPromptFragment:
      "You are a frontend specialist. Focus on UI components, styles, and user-facing behavior.",
    teamDescription: "UI specialist",
    resultSchema: { changedFiles: "string[]", conclusion: "string" },
  },
  "review": {
    id: "review",
    slot: "review",
    tools: ["read", "grep", "glob", "bash", "get_output", "write_to_process", "kill_shell"],
    worktree: "none",
    systemPromptFragment: "You have not seen the conversation; review the diff on its own merits.",
    teamDescription: "independent review of a diff",
    resultSchema: { conclusion: "string", issues: "string[]", severity: "string" },
  },
  "check": {
    id: "check",
    slot: "check",
    tools: ["read", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell"],
    worktree: "isolated",
    systemPromptFragment:
      "You are a check agent. Run tests and lint, report results. Do not make changes.",
    teamDescription: "run tests/lint and report",
    resultSchema: { conclusion: "string", passed: "boolean", output: "string" },
  },
  "retrieval": {
    id: "retrieval",
    slot: "retrievalAgent",
    tools: [
      "read",
      "grep",
      "find",
      "ls",
      "explore",
      "related",
      "recall",
      "symbols",
      "definition",
      "references",
      "hover",
      "webfetch",
      "document_read",
      "websearch",
      "research_search",
      "research_decide",
      "materials",
      "send",
      "read_thread",
      "wait",
      "follow_up",
      "submit_facts",
    ],
    worktree: "none",
    systemPromptFragment:
      "You are a retrieval agent. Investigate the open question and give the parent the clearest useful report for the work at hand. "
      + "When precise source-addressable claim rows would help the parent reuse a finding, attach them with submit_facts; prose alone is a complete report. "
      + "Do not recommend product changes, priorities, or architecture. Do not edit, write, or run shell commands. "
      + "Cite local paths with compact line ranges or stored URL receipts. "
      + "The Host can mark a source source-checked or source-valid; it cannot prove a claim is true. "
      + "Record material you tried and could not obtain as unknown, in the report or structured facts.",
    teamDescription: "multi-step fact retrieval",
    resultSchema: {
      conclusion: "natural-language report",
      evidence: "optional Host-validated structured facts and unknowns",
    },
  },
};

export function isPresetId(value: string): value is PresetId {
  return Object.prototype.hasOwnProperty.call(EXECUTION_PRESETS, value);
}

// ── Catalog resolution ─────────────────────────────────────────────

export interface ResolvedPreset {
  id: PresetId;
  model: ModelSelection;
  definition: ExecutionPreset;
}

export function resolvePresets(
  slots: Partial<Record<HarnessModelRole, ModelSelection | null>>,
  mainModel: ModelSelection | null,
): ResolvedPreset[] {
  const resolved: ResolvedPreset[] = [];
  for (const preset of Object.values(EXECUTION_PRESETS)) {
    const model = resolveHarnessModelSlot(preset.slot, slots, mainModel);
    if (model) resolved.push({ id: preset.id, model, definition: preset });
  }
  return resolved;
}

// ── Team prompt ────────────────────────────────────────────────────

/**
 * The team prompt is static for a given preset set, so it can live in the
 * `dispatch` tool's promptGuidelines without invalidating the prefix cache
 * mid-session.
 */
export function buildTeamPrompt(presets: ResolvedPreset[]): string {
  const presetList = presets
    .map((p) => `${p.definition.id} (${p.definition.teamDescription})`)
    .join(", ");
  const base =
    "You can hand work to a sub-agent thread with dispatch(task). Without a preset it runs on your " +
    "current model and tools; an optional preset picks a fixed execution configuration.";
  const list = presetList ? ` Available presets: ${presetList}.` : "";
  return (
    `${base}${list} ` +
    "Judge by time and cost: if you can finish in a few tool calls yourself, do it yourself. " +
    "Dispatch is asynchronous: wait blocks until a teammate changes state, threads is a quick glance, " +
    "send passes a teammate new information, read_thread shows their notes. " +
    "The user may also open and talk to teammates directly; their final report tells you what actually happened."
  );
}
