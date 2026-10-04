/**
 * Execution presets — named, fixed configurations a dispatch can opt into.
 *
 * Design: design/harness-verification.md §9.2.2 / D-285
 * Plan: plan/agent-harness-plan.md §3.18A
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
import { resolveHarnessModelSlot, type HarnessModelBinding } from "./harness-model-slots.js";
import { customizeHarnessAgent, type HarnessCustomAgent, type HarnessAgentModelSettings } from "./harness-agents.js";
import type { WorkFocusId } from "./work-focus.js";

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
  id: string;
  slot?: HarnessModelRole;
  tools: string[];
  worktree: PresetWorktree;
  /** Included in the thread's initial task input. */
  systemPromptFragment: string;
  /** One clause describing the preset, used to build the team prompt. */
  teamDescription: string;
  name?: string;
  modelSettings?: HarnessAgentModelSettings;
}

// ── Preset definitions ─────────────────────────────────────────────

export const EXECUTION_PRESETS: Readonly<Record<PresetId, ExecutionPreset & { slot: HarnessModelRole }>> = {
  "quick-implement": {
    id: "quick-implement",
    slot: "quickImplement",
    tools: ["read", "edit", "write", "apply_patch", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell"],
    worktree: "isolated",
    systemPromptFragment:
      "Preset focus: well-specified implementation tasks.",
    teamDescription: "mechanical, well-specified changes",
  },
  "hard-implement": {
    id: "hard-implement",
    slot: "hardImplement",
    tools: ["read", "edit", "write", "apply_patch", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell", "explore", "recall", "todo", "dispatch", "threads", "wait", "send", "read_thread", "merge", "update", "kill"],
    worktree: "isolated",
    systemPromptFragment:
      "Preset focus: complex implementation tasks.",
    teamDescription: "ambiguous or cross-cutting work",
  },
  "frontend": {
    id: "frontend",
    slot: "frontend",
    tools: ["read", "edit", "write", "apply_patch", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell", "explore", "dispatch", "threads", "wait", "send", "read_thread", "merge", "update", "kill"],
    worktree: "isolated",
    systemPromptFragment:
      "Preset focus: frontend implementation.",
    teamDescription: "UI specialist",
  },
  "review": {
    id: "review",
    slot: "review",
    tools: ["read", "grep", "glob", "bash", "get_output", "write_to_process", "kill_shell"],
    worktree: "none",
    systemPromptFragment: "Preset focus: review.",
    teamDescription: "independent review of a diff",
  },
  "check": {
    id: "check",
    slot: "check",
    tools: ["read", "bash", "grep", "glob", "get_output", "write_to_process", "kill_shell"],
    worktree: "isolated",
    systemPromptFragment:
      "Preset focus: checks and validation.",
    teamDescription: "run tests/lint and report",
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
      "Preset focus: information retrieval.",
    teamDescription: "multi-step fact retrieval",
  },
};

export function isPresetId(value: string): value is PresetId {
  return Object.prototype.hasOwnProperty.call(EXECUTION_PRESETS, value);
}

// ── Catalog resolution ─────────────────────────────────────────────

export interface ResolvedPreset {
  id: string;
  model: ModelSelection;
  definition: ExecutionPreset;
}

export function resolvePresets(
  slots: Partial<Record<HarnessModelRole, HarnessModelBinding | null>>,
  mainModel: ModelSelection | null,
  custom: Record<string, HarnessCustomAgent> = {},
  focus?: WorkFocusId,
): ResolvedPreset[] {
  const resolved: ResolvedPreset[] = [];
  for (const preset of Object.values(EXECUTION_PRESETS)) {
    const model = resolveHarnessModelSlot(preset.slot, slots, mainModel);
    const definition = customizeHarnessAgent(preset, slots[preset.slot]?.agent);
    if (definition.description !== undefined) definition.teamDescription = definition.description;
    if (model) resolved.push({ id: preset.id, model, definition });
  }
  for (const [key, agent] of Object.entries(custom)) {
    if (!agent.enabled || (focus && agent.workFocus.length && !agent.workFocus.includes(focus))) continue;
    const model = agent.model ?? mainModel;
    if (!model) continue;
    const id = `custom:${key}`;
    resolved.push({ id, model, definition: { id, tools: agent.tools, worktree: agent.worktree,
      systemPromptFragment: agent.instructions, teamDescription: `${agent.name}: ${agent.description}`,
      name: agent.name, ...(agent.modelSettings ? { modelSettings: { ...agent.modelSettings } } : {}) } });
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
    .map((p) => `${p.definition.id} (${p.definition.name ? `${p.definition.name}: ` : ''}${p.definition.teamDescription})`)
    .join(", ");
  const base =
    "You can hand work to a sub-agent thread with dispatch(task). Without a preset it runs on your " +
    "current model and tools; an optional preset picks a fixed execution configuration.";
  const list = presetList ? ` Available presets: ${presetList}.` : "";
  return (
    `${base}${list} ` +
    "Dispatch is asynchronous: wait blocks until a teammate changes state, threads is a quick glance, " +
    "send passes a teammate new information, read_thread shows their notes. " +
    "The user may also open and talk to teammates directly; their final report tells you what actually happened."
  );
}
