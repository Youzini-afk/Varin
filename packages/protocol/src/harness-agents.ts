import { HarnessSettingsValidationError, type ModelSelection } from "./harness-settings.js";
import { isWorkFocusId, type WorkFocusId } from "./work-focus.js";
import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";

export interface HarnessAgentModelSettings {
  temperature?: number;
  thinkingLevel?: ThinkingLevel;
}

/** User overrides of a built-in profile; unset fields keep the shipped definition. */
export interface HarnessAgentOverrides {
  name?: string;
  description?: string;
  instructions?: string;
  tools?: string[];
  worktree?: "none" | "isolated";
  modelSettings?: HarnessAgentModelSettings;
}

export function parseHarnessAgentModelSettings(value: unknown): HarnessAgentModelSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessSettingsValidationError("Agent model settings must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "temperature" && key !== "thinkingLevel")
    || (input.temperature !== undefined && (typeof input.temperature !== "number" || !Number.isFinite(input.temperature) || input.temperature < 0))
    || (input.thinkingLevel !== undefined && !THINKING_LEVELS.includes(input.thinkingLevel as ThinkingLevel))) {
    throw new HarnessSettingsValidationError("Invalid agent model settings: temperature must be a finite non-negative number and thinkingLevel must be supported by Pi");
  }
  return { ...(input.temperature === undefined ? {} : { temperature: input.temperature as number }),
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel as ThinkingLevel }) };
}

export function parseHarnessAgentOverrides(value: unknown): HarnessAgentOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessSettingsValidationError("Agent overrides must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["name", "description", "instructions", "tools", "worktree", "modelSettings"].includes(key))
    || (v.name !== undefined && (typeof v.name !== "string" || !v.name.trim()))
    || (v.description !== undefined && typeof v.description !== "string")
    || (v.instructions !== undefined && typeof v.instructions !== "string")
    || (v.tools !== undefined && (!Array.isArray(v.tools) || v.tools.some(tool => typeof tool !== "string" || !tool.trim())))
    || (v.worktree !== undefined && v.worktree !== "none" && v.worktree !== "isolated")) {
    throw new HarnessSettingsValidationError("Invalid built-in agent overrides");
  }
  return {
    ...(v.name === undefined ? {} : { name: (v.name as string).trim() }),
    ...(v.description === undefined ? {} : { description: v.description as string }),
    ...(v.instructions === undefined ? {} : { instructions: v.instructions as string }),
    ...(v.tools === undefined ? {} : { tools: [...new Set(v.tools as string[])] }),
    ...(v.worktree === undefined ? {} : { worktree: v.worktree as "none" | "isolated" }),
    ...(v.modelSettings === undefined ? {} : { modelSettings: parseHarnessAgentModelSettings(v.modelSettings) }),
  };
}

export function customizeHarnessAgent<T extends { tools: string[]; worktree: "none" | "isolated"; systemPromptFragment: string }>(
  definition: T, overrides?: HarnessAgentOverrides,
): T & { name?: string; description?: string; modelSettings?: HarnessAgentModelSettings } {
  return { ...definition,
    ...(overrides?.name === undefined ? {} : { name: overrides.name }),
    ...(overrides?.description === undefined ? {} : { description: overrides.description }),
    ...(overrides?.instructions === undefined ? {} : { systemPromptFragment: overrides.instructions }),
    ...(overrides?.tools === undefined ? {} : { tools: [...overrides.tools] }),
    ...(overrides?.worktree === undefined ? {} : { worktree: overrides.worktree }),
    ...(overrides?.modelSettings === undefined ? {} : { modelSettings: { ...overrides.modelSettings } }),
  };
}

export interface HarnessCustomAgent {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  /** Unset inherits the caller's model at dispatch. */
  model?: ModelSelection;
  modelSettings?: HarnessAgentModelSettings;
  tools: string[];
  worktree: "none" | "isolated";
  /** Empty means available in either work focus. */
  workFocus: WorkFocusId[];
}

export function parseHarnessAgent(value: unknown): HarnessCustomAgent {
  const fail = (): never => { throw new HarnessSettingsValidationError("Invalid agent definition: name, description, instructions, enabled, tools, worktree and workFocus are required; model is optional"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["name", "description", "instructions", "enabled", "model", "modelSettings", "tools", "worktree", "workFocus"].includes(key))
    || typeof v.name !== "string" || !v.name.trim()
    || typeof v.description !== "string" || typeof v.instructions !== "string"
    || typeof v.enabled !== "boolean" || !Array.isArray(v.tools) || v.tools.some(tool => typeof tool !== "string" || !tool.trim())
    || (v.worktree !== "none" && v.worktree !== "isolated") || !Array.isArray(v.workFocus) || !v.workFocus.every(isWorkFocusId)) return fail();
  let model: ModelSelection | undefined;
  if (v.model !== undefined) {
    if (!v.model || typeof v.model !== "object" || Array.isArray(v.model)) return fail();
    const binding = v.model as Record<string, unknown>;
    if (Object.keys(binding).some(key => key !== "providerId" && key !== "modelId")
      || typeof binding.providerId !== "string" || !binding.providerId.trim()
      || typeof binding.modelId !== "string" || !binding.modelId.trim()) return fail();
    model = { providerId: binding.providerId, modelId: binding.modelId };
  }
  return { name: v.name.trim(), description: v.description, instructions: v.instructions,
    enabled: v.enabled, tools: [...new Set(v.tools as string[])], worktree: v.worktree,
    workFocus: [...new Set(v.workFocus as WorkFocusId[])], ...(model ? { model } : {}),
    ...(v.modelSettings === undefined ? {} : { modelSettings: parseHarnessAgentModelSettings(v.modelSettings) }) };
}

export function parseHarnessAgents(value: unknown): Record<string, HarnessCustomAgent> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessSettingsValidationError("harness.agents must be an object");
  return Object.fromEntries(Object.entries(value).map(([id, agent]) => {
    if (!id.trim()) throw new HarnessSettingsValidationError("Agent identity must not be empty");
    return [id, parseHarnessAgent(agent)];
  }));
}
