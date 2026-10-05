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

export type PresetId = "worker" | "retrieval";

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
  /** Empty or unset means shared across work focuses. */
  workFocus?: WorkFocusId[];
}

// ── Preset definitions ─────────────────────────────────────────────

export const EXECUTION_PRESETS: Readonly<Record<PresetId, ExecutionPreset & { slot: HarnessModelRole }>> = {
  worker: {
    id: "worker", slot: "worker",
    tools: ["read", "edit", "write", "apply_patch", "bash", "grep", "find", "ls", "get_output", "write_to_process", "kill_shell", "explore", "related", "diagnostics", "symbols", "definition", "references", "hover", "webfetch", "document_read", "websearch", "todo", "dispatch", "threads", "wait", "send", "read_thread", "merge", "submit_code", "update", "kill"],
    worktree: "isolated",
    systemPromptFragment: "Complete the assigned work with awareness of the overall goal and related tasks. Read teammates' relevant work, coordinate shared interfaces directly, and inform the main agent of decisions affecting the overall design. Revisit the task boundary when evidence calls for it. Verify the actual result in proportion to its risk.",
    teamDescription: "independent implementation or other assigned work, including coordination and relevant verification",
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
      "threads",
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
    if (focus && preset.workFocus?.length && !preset.workFocus.includes(focus)) continue;
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
 * The team prompt is stable for a given available preset set. Its owner refreshes
 * the set at run boundaries when settings, model, or work focus changes.
 */
export function buildTeamPrompt(presets: ResolvedPreset[], activeTools?: readonly string[], additionalProfiles: readonly { tools: readonly string[] }[] = []): string {
  const available = (tool: string) => activeTools === undefined || activeTools.includes(tool);
  const worker = presets.some(preset => preset.id === "worker");
  const retrieval = presets.some(preset => preset.id === "retrieval");
  const canDispatch = available("dispatch") && (presets.length > 0 || additionalProfiles.length > 0);
  const responsibility = "You are responsible for the overall goal, design, implementation consistency, integration and final delivery. Work directly by default. ";
  if (!canDispatch) return responsibility + "New sub-agent dispatch is currently unavailable. Continue the work yourself; disabled profiles are not available for new work."
    + (available("read_thread") ? " You may inspect existing task-family conversations with read_thread when relevant." : "");
  const writing = worker || [...presets.map(preset => preset.definition), ...additionalProfiles].some(profile => profile.tools.some(tool => ["write", "edit", "apply_patch", "bash", "experiment"].includes(tool)));
  let guidance = responsibility;
  if (writing) guidance += "Delegate independent work only when it has a concrete benefit. Give delegated agents the overall goal, relevant decisions, responsibilities and collaborators. Continue global design and unassigned work while they run. Inspect important implementations and integrate their actual changes; their reports alone do not prove the overall task is complete. ";
  else guidance += "Use the enabled read-only profiles for independent fact finding and investigation. Design, implementation and final verification remain your own work; no implementation worker is enabled. Read the decisive evidence yourself. ";
  if (worker) guidance += "Use dispatch(task) for a worker on your current model and authorized tools, or select a configured profile explicitly. ";
  else if (presets.length) guidance += "Choose an available configured profile explicitly with dispatch(task, preset). ";
  if (additionalProfiles.length) guidance += "Choose an enabled research capability explicitly with dispatch(task, capability) when relevant. ";
  if (retrieval && writing) guidance += "Use retrieval for multi-step fact finding when its independent context has a concrete benefit. ";
  const profiles = presets.map(preset => `${preset.id} (${preset.definition.name ? `${preset.definition.name}: ` : ""}${preset.definition.teamDescription})`).join(", ");
  if (profiles) guidance += `Available profiles: ${profiles}. `;
  return guidance + "Threads run independently. "
    + (available("read_thread") ? "Use read_thread to inspect relevant task-family conversations. " : "")
    + (available("threads") ? "Use threads to discover related work. " : "")
    + (available("send") ? "Use send to coordinate interfaces or request help. " : "")
    + (writing && available("submit_code") ? "Use submit_code to send selected files or original/replacement snippets directly to a teammate or parent. Queued acceptance is not application; its receipt arrives through task state and passive messages. " : "")
    + (available("wait") ? "Use wait for dependencies when no useful independent work remains; omit its duration for indefinite event waiting. " : "")
    + "Routine progress does not require polling or a response.";
}
