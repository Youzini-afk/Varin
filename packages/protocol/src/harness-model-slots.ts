import { HarnessSettingsValidationError, type HarnessModelRole, type ModelSelection } from "./harness-settings.js";
import { parseHarnessAgents, parseHarnessAgentOverrides, type HarnessAgentOverrides } from "./harness-agents.js";

/** An enabled flag preserves the selected model while the user turns a role off. */
export interface HarnessModelBinding {
  enabled?: boolean;
  providerId?: string;
  modelId?: string;
  agent?: HarnessAgentOverrides;
}

export type HarnessModelPreset = "anthropic" | "openai" | "gemini";
export type HarnessModelSlots = Partial<Record<HarnessModelRole, HarnessModelBinding>>;

export const HARNESS_MODEL_ROLES: readonly HarnessModelRole[] = [
  "explore",
  "retrievalAgent",
  "worker",
  "reader",
  "nextStep",
  "permissionJudge",
  "researchInvestigation",
  "researchExperimentalDesign",
  "researchFastExploration",
  "researchHighThroughputExecution",
  "memoryOrganizer",
];

const DEFAULTING_TO_MAIN = new Set<HarnessModelRole>(["worker"]);

export const resolveHarnessModelSlot = (
  slot: HarnessModelRole,
  slots: Partial<Record<HarnessModelRole, HarnessModelBinding | null>>,
  mainModel: ModelSelection | null,
): ModelSelection | null => {
  const binding = slots[slot];
  if (binding?.enabled === false) return null;
  return binding?.providerId && binding.modelId
    ? { providerId: binding.providerId, modelId: binding.modelId }
    : DEFAULTING_TO_MAIN.has(slot) ? mainModel : null;
};

export function parseHarnessModelSlots(value: unknown): HarnessModelSlots {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessSettingsValidationError("harness.models must be an object");
  const result: Partial<Record<HarnessModelRole, HarnessModelBinding>> = {};
  for (const [role, raw] of Object.entries(value)) {
    if (!HARNESS_MODEL_ROLES.includes(role as HarnessModelRole) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new HarnessSettingsValidationError(`Invalid model role: ${role}`);
    }
    const input = raw as Record<string, unknown>;
    if (Object.keys(input).some(key => !["enabled", "providerId", "modelId", "agent"].includes(key))
      || (input.enabled !== undefined && typeof input.enabled !== "boolean")
      || ((input.providerId !== undefined || input.modelId !== undefined)
        && (typeof input.providerId !== "string" || !input.providerId.trim() || typeof input.modelId !== "string" || !input.modelId.trim()))) {
      throw new HarnessSettingsValidationError(`Invalid binding for harness.models.${role}`);
    }
    result[role as HarnessModelRole] = {
      ...(input.enabled === undefined ? {} : { enabled: input.enabled as boolean }),
      ...(input.providerId === undefined ? {} : { providerId: input.providerId as string, modelId: input.modelId as string }),
      ...(input.agent === undefined ? {} : { agent: parseHarnessAgentOverrides(input.agent) }),
    };
  }
  return result;
}

const PRESET_PATTERNS: Record<HarnessModelPreset, readonly string[]> = {
  anthropic: ["haiku"],
  openai: ["gpt-5-nano", "gpt-5-mini", "gpt-4.1-nano", "gpt-4.1-mini", "gpt-4o-nano", "gpt-4o-mini", "o4-mini", "nano", "mini"],
  gemini: ["flash-lite", "flash"],
};

const PRESET_SLOTS: readonly HarnessModelRole[] = [
  "explore",
  "retrievalAgent",
  "reader",
  "permissionJudge",
  "memoryOrganizer",
  "researchInvestigation",
  "researchExperimentalDesign",
  "researchFastExploration",
  "researchHighThroughputExecution",
];

/** Preserve externally configured profiles when retiring the old built-in categories. */
export function normalizeHarnessAgentConfiguration(models: unknown, agents: unknown) {
  const profiles = parseHarnessAgents(agents);
  const source = models === undefined ? {} : models;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new HarnessSettingsValidationError("harness.models must be an object");
  const bindings = { ...source } as Record<string, unknown>;
  const legacy = ["hardImplement", "quickImplement", "frontend", "review", "check"] as const;
  const tools = ["read", "edit", "write", "apply_patch", "bash", "grep", "find", "ls", "explore", "related", "get_output", "write_to_process", "kill_shell", "threads", "wait", "send", "read_thread", "merge", "submit_code", "update", "dispatch", "kill"];
  for (const role of legacy) {
    const raw = bindings[role];
    delete bindings[role];
    if (raw === undefined) continue;
    const binding = parseHarnessModelSlots({ worker: raw }).worker!;
    if (role === "hardImplement" && bindings.worker === undefined) { bindings.worker = binding; continue; }
    const overrides = binding.agent;
    const readOnly = role === "review" || role === "check";
    const id = `saved-${role}`;
    if (profiles[id]) throw new HarnessSettingsValidationError(`Saved profile identity conflicts with harness.agents.${id}`);
    profiles[id] = {
      name: overrides?.name ?? ({ hardImplement: "Saved implementation profile", quickImplement: "Saved implementation profile", frontend: "Saved UI profile", review: "Saved review profile", check: "Saved verification profile" }[role]),
      description: overrides?.description ?? "User configuration retained from a former built-in profile.",
      instructions: overrides?.instructions ?? "Complete the assigned task, coordinate relevant decisions, and report the actual result.",
      enabled: binding.enabled !== false && (Boolean(binding.providerId && binding.modelId) || role === "hardImplement" || role === "review"),
      ...(binding.providerId && binding.modelId ? { model: { providerId: binding.providerId, modelId: binding.modelId } } : {}),
      ...(overrides?.modelSettings ? { modelSettings: overrides.modelSettings } : {}),
      tools: overrides?.tools ?? (readOnly ? ["read", "grep", "find", "ls", "bash", "get_output", "write_to_process", "kill_shell", "threads", "send", "wait", "read_thread"] : tools),
      worktree: overrides?.worktree ?? (role === "review" ? "none" : "isolated"),
      workFocus: readOnly ? [] : ["code"],
    };
  }
  return { models: parseHarnessModelSlots(bindings), agents: profiles };
}

export const applyHarnessModelPreset = (
  preset: HarnessModelPreset,
  input: { providerId: string; modelIds: readonly string[] },
): HarnessModelSlots => {
  const modelId = PRESET_PATTERNS[preset]
    .flatMap((pattern) => input.modelIds.filter((candidate) => candidate.toLowerCase().includes(pattern)))
    .at(0);
  if (!modelId) return {};
  return Object.fromEntries(PRESET_SLOTS.map((slot) => [slot, { providerId: input.providerId, modelId }])) as HarnessModelSlots;
};
