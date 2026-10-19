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
 * The catalog is a pure static table with no host dependencies. Native
 * profile preparation uses it to freeze Thread configuration and reject
 * presets whose model slot is not configured.
 */

import type { HarnessModelRole, ModelSelection } from "./harness-settings.js";
import { resolveHarnessModelSlot, type HarnessModelBinding } from "./harness-model-slots.js";
import { customizeHarnessAgent, resolveAgentTools, type AgentRuntime, type HarnessCustomAgent, type HarnessAgentModelSettings } from "./harness-agents.js";
import type { WorkFocusId } from "./work-focus.js";

// ── Types ──────────────────────────────────────────────────────────

export type PresetId = "worker" | "verifier" | "retrieval";

/** Projects the selected runtime's owning declarations; this is not a tool-name registry. */
export function agentPresetTools(capabilities: readonly { name: string; default_presets: readonly PresetId[] }[]): Record<PresetId, string[]> {
  return {
    worker: capabilities.filter(tool => tool.default_presets.includes("worker")).map(tool => tool.name),
    verifier: capabilities.filter(tool => tool.default_presets.includes("verifier")).map(tool => tool.name),
    retrieval: capabilities.filter(tool => tool.default_presets.includes("retrieval")).map(tool => tool.name),
  };
}

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

export const EXECUTION_PRESETS: Readonly<Record<PresetId, Omit<ExecutionPreset, "tools"> & { id: PresetId; slot: HarnessModelRole }>> = {
  worker: {
    id: "worker", slot: "worker",
    worktree: "isolated",
    name: "实现 Agent",
    systemPromptFragment: "Understand how the assigned work fits the overall goal. Complete the implementation or fix while coordinating related work and keeping the design consistent. Adjust your approach based on findings and deliver results that subsequent work can use.",
    teamDescription: "Complete implementations or fixes",
  },
  verifier: {
    id: "verifier", slot: "verifier", name: "验证 Agent",
    worktree: "isolated",
    systemPromptFragment: "Starting from the user's goal and the system as a whole, independently assess correctness, completeness, and design quality, including behavior across related modules. Choose verification methods as needed, base conclusions on evidence, and explain significant findings and their impact. Verify enough to support judgment, balancing new tests and proposed improvements against practical value, design simplicity, and maintenance cost.",
    teamDescription: "Independently assess correctness, completeness, and design quality",
  },
  "retrieval": {
    id: "retrieval",
    slot: "retrievalAgent",
    worktree: "none",
    systemPromptFragment:
      "Find, verify, and synthesize facts relevant to the assigned question. Understand the surrounding context and follow useful leads across sources and their relationships. Let the evidence guide further retrieval, filling gaps that matter to the answer and examining differences between sources that could change the conclusion.\n\nLet the question and evidence determine the depth of investigation. Deliver when the material answers the question or further retrieval offers little practical value.\n\nProvide a concise, usable synthesis with precise source locations and enough context to understand the conclusions, clearly distinguishing confirmed facts, inferences, and unresolved questions.",
    teamDescription: "multi-step fact retrieval",
  },
};

/** Preparation/discovery can retain unavailable choices without authorizing them. */
export interface PresetObservation {
  id: string;
  model: ModelSelection | null;
  modelSource: "inherit" | "selected";
  definition: ExecutionPreset;
  availability: "available" | "disabled" | "unconfigured" | "scope_unavailable" | "runtime_unconfigured";
}

export function observePresets(
  slots: Partial<Record<HarnessModelRole, HarnessModelBinding | null>>,
  mainModel: ModelSelection | null,
  custom: Record<string, HarnessCustomAgent> = {},
  focus?: WorkFocusId,
  runtime: AgentRuntime = "agent",
  builtinTools?: Readonly<Record<PresetId, readonly string[]>>,
): PresetObservation[] {
  if (!builtinTools) throw new Error("Agent runtime preset defaults are unavailable");
  const observations: PresetObservation[] = [];
  for (const preset of Object.values(EXECUTION_PRESETS)) {
    const binding = slots[preset.slot];
    const model = resolveHarnessModelSlot(preset.slot, slots, mainModel);
    const definition = customizeHarnessAgent({ ...preset, tools: [...builtinTools[preset.id]] }, binding?.agent, runtime);
    if (definition.description !== undefined) definition.teamDescription = definition.description;
    observations.push({ id: preset.id, model, definition,
      modelSource: binding?.providerId && binding.modelId ? "selected" : "inherit",
      availability: binding?.enabled === false ? "disabled"
        : focus && definition.workFocus?.length && !definition.workFocus.includes(focus) ? "scope_unavailable"
          : model ? "available" : "unconfigured" });
  }
  for (const [key, agent] of Object.entries(custom)) {
    const tools = resolveAgentTools(agent.tools, runtime);
    const model = agent.model ?? mainModel;
    const id = `custom:${key}`;
    observations.push({ id, model, modelSource: agent.model ? "selected" : "inherit",
      availability: !agent.enabled ? "disabled" : tools.source === "unconfigured" ? "runtime_unconfigured"
        : focus && agent.workFocus.length && !agent.workFocus.includes(focus) ? "scope_unavailable"
          : model ? "available" : "unconfigured",
      definition: { id, tools: tools.names, worktree: agent.worktree,
        systemPromptFragment: agent.instructions, teamDescription: `${agent.name}: ${agent.description}`,
        name: agent.name, workFocus: [...agent.workFocus], ...(agent.modelSettings ? { modelSettings: { ...agent.modelSettings } } : {}) } });
  }
  return observations;
}
