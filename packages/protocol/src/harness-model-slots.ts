import type { HarnessModelRole, ModelSelection } from "./harness-settings.js";

export type HarnessModelPreset = "anthropic" | "openai" | "gemini";
export type HarnessModelSlots = Partial<Record<HarnessModelRole, ModelSelection>>;

export const HARNESS_MODEL_ROLES: readonly HarnessModelRole[] = [
  "explore",
  "retrievalAgent",
  "quickImplement",
  "hardImplement",
  "frontend",
  "review",
  "check",
  "reader",
  "nextStep",
  "permissionJudge",
  "researchInvestigation",
  "researchExperimentalDesign",
  "researchFastExploration",
  "researchHighThroughputExecution",
  "memoryOrganizer",
];

const DEFAULTING_TO_MAIN = new Set<HarnessModelRole>(["hardImplement", "review"]);

export const resolveHarnessModelSlot = (
  slot: HarnessModelRole,
  slots: Partial<Record<HarnessModelRole, ModelSelection | null>>,
  mainModel: ModelSelection | null,
): ModelSelection | null => slots[slot] ?? (DEFAULTING_TO_MAIN.has(slot) ? mainModel : null);

const PRESET_PATTERNS: Record<HarnessModelPreset, readonly string[]> = {
  anthropic: ["haiku"],
  openai: ["gpt-5-nano", "gpt-5-mini", "gpt-4.1-nano", "gpt-4.1-mini", "gpt-4o-nano", "gpt-4o-mini", "o4-mini", "nano", "mini"],
  gemini: ["flash-lite", "flash"],
};

const PRESET_SLOTS: readonly HarnessModelRole[] = [
  "explore",
  "retrievalAgent",
  "quickImplement",
  "frontend",
  "check",
  "reader",
  "permissionJudge",
  "memoryOrganizer",
  "researchInvestigation",
  "researchExperimentalDesign",
  "researchFastExploration",
  "researchHighThroughputExecution",
];

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
