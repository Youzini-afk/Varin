import { HarnessSettingsValidationError, type HarnessModelRole, type ModelSelection } from "./harness-settings.js";
import { parseHarnessAgentOverrides, type HarnessAgentOverrides } from "./harness-agents.js";

/** An enabled flag preserves the selected model while the user turns a role off. */
export interface HarnessModelBinding {
  enabled?: boolean;
  providerId?: string;
  modelId?: string;
  agent?: HarnessAgentOverrides;
}
export type HarnessModelSlots = Partial<Record<HarnessModelRole, HarnessModelBinding>>;

export const HARNESS_MODEL_ROLES: readonly HarnessModelRole[] = [
  "agentPlanning",
  "explore",
  "retrievalAgent",
  "worker",
  "verifier",
  "reader",
  "nextStep",
  "permissionJudge",
  "researchInvestigation",
  "researchExperimentalDesign",
  "researchFastExploration",
  "researchHighThroughputExecution",
  "memoryOrganizer",
];

const DEFAULTING_TO_MAIN = new Set<HarnessModelRole>(["worker", "verifier"]);

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
