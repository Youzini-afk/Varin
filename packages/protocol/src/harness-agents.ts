import { HarnessSettingsValidationError, type ModelSelection } from "./harness-settings.js";
import { isWorkFocusId, type WorkFocusId } from "./work-focus.js";
import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";
import { isAgentAvatarId } from './agent-avatars.js';
import type { AgentAvatarId } from './agent-runtime.generated.js';

/** Exact native registered tool names. Missing inherits defaults; an empty list disables tools. */
export type AgentRuntime = "agent";
export type AgentToolSelection = string[];
export interface AgentToolsView { source: "default" | "explicit" | "unconfigured"; names: string[] }

export function parseAgentToolSelection(value: unknown): AgentToolSelection {
  if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !name.trim())) {
    throw new HarnessSettingsValidationError("Agent tools must be an array of non-empty registered tool names");
  }
  return [...new Set(value as string[])];
}
export function resolveAgentTools(selection: AgentToolSelection | undefined, _runtime: AgentRuntime, defaults?: readonly string[]): AgentToolsView {
  return selection !== undefined ? { source: "explicit", names: parseAgentToolSelection(selection) }
    : defaults !== undefined ? { source: "default", names: [...defaults] }
      : { source: "unconfigured", names: [] };
}
export function updateAgentToolSelection(names: string[] | null): AgentToolSelection | undefined {
  return names === null ? undefined : parseAgentToolSelection(names);
}

export interface HarnessAgentModelSettings {
  temperature?: number;
  thinkingLevel?: ThinkingLevel;
}

/** User overrides of a built-in profile; unset fields keep the shipped definition. */
export interface HarnessAgentOverrides {
  avatar?: AgentAvatarId;
  name?: string;
  description?: string;
  instructions?: string;
  tools?: AgentToolSelection;
  modelSettings?: HarnessAgentModelSettings;
}

/**
 * Agents no longer choose their file placement; each dispatch selects `workMode`. A stored
 * value of the retired `worktree` key is validated and dropped here, at the one settings
 * entry, so it never reaches a dispatch decision and is not written back when saved.
 */
const RETIRED_WORKTREE = "worktree";
const retiredWorktreeValid = (value: unknown) => value === undefined || value === "none" || value === "shared" || value === "isolated";

export function parseHarnessAgentModelSettings(value: unknown): HarnessAgentModelSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessSettingsValidationError("Agent model settings must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "temperature" && key !== "thinkingLevel")
    || (input.temperature !== undefined && (typeof input.temperature !== "number" || !Number.isFinite(input.temperature) || input.temperature < 0))
    || (input.thinkingLevel !== undefined && !THINKING_LEVELS.includes(input.thinkingLevel as ThinkingLevel))) {
    throw new HarnessSettingsValidationError("Invalid agent model settings: temperature must be a finite non-negative number and thinkingLevel must be supported by the model");
  }
  return { ...(input.temperature === undefined ? {} : { temperature: input.temperature as number }),
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel as ThinkingLevel }) };
}

export function parseHarnessAgentOverrides(value: unknown): HarnessAgentOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessSettingsValidationError("Agent overrides must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["name", "description", "instructions", "tools", RETIRED_WORKTREE, "modelSettings", "avatar"].includes(key))
    || (v.avatar !== undefined && !isAgentAvatarId(v.avatar))
    || (v.name !== undefined && (typeof v.name !== "string" || !v.name.trim()))
    || (v.description !== undefined && typeof v.description !== "string")
    || (v.instructions !== undefined && typeof v.instructions !== "string")
    || !retiredWorktreeValid(v[RETIRED_WORKTREE])) {
    throw new HarnessSettingsValidationError("Invalid built-in agent overrides");
  }
  return {
    ...(isAgentAvatarId(v.avatar) ? { avatar: v.avatar } : {}),
    ...(v.name === undefined ? {} : { name: (v.name as string).trim() }),
    ...(v.description === undefined ? {} : { description: v.description as string }),
    ...(v.instructions === undefined ? {} : { instructions: v.instructions as string }),
    ...(v.tools === undefined ? {} : { tools: parseAgentToolSelection(v.tools) }),
    ...(v.modelSettings === undefined ? {} : { modelSettings: parseHarnessAgentModelSettings(v.modelSettings) }),
  };
}

export function customizeHarnessAgent<T extends { tools: string[]; systemPromptFragment: string }>(
  definition: T, overrides?: HarnessAgentOverrides, runtime: AgentRuntime = "agent",
): T & { name?: string; description?: string; avatar?: AgentAvatarId; modelSettings?: HarnessAgentModelSettings } {
  return { ...definition,
    ...(overrides?.avatar === undefined ? {} : { avatar: overrides.avatar }),
    ...(overrides?.name === undefined ? {} : { name: overrides.name }),
    ...(overrides?.description === undefined ? {} : { description: overrides.description }),
    ...(overrides?.instructions === undefined ? {} : { systemPromptFragment: overrides.instructions }),
    tools: resolveAgentTools(overrides?.tools, runtime, definition.tools).names,
    ...(overrides?.modelSettings === undefined ? {} : { modelSettings: { ...overrides.modelSettings } }),
  };
}

export interface HarnessCustomAgent {
  avatar?: AgentAvatarId;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  /** Unset inherits the caller's model at dispatch. */
  model?: ModelSelection;
  modelSettings?: HarnessAgentModelSettings;
  tools?: AgentToolSelection;
  /** Empty means available in either work focus. */
  workFocus: WorkFocusId[];
}

export function parseHarnessAgent(value: unknown): HarnessCustomAgent {
  const fail = (): never => { throw new HarnessSettingsValidationError("Invalid agent definition: name, description, instructions, enabled and workFocus are required; model and tools are optional"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["name", "description", "instructions", "enabled", "model", "modelSettings", "tools", RETIRED_WORKTREE, "workFocus", "avatar"].includes(key))
    || (v.avatar !== undefined && !isAgentAvatarId(v.avatar))
    || typeof v.name !== "string" || !v.name.trim()
    || typeof v.description !== "string" || typeof v.instructions !== "string"
    || typeof v.enabled !== "boolean"
    || !retiredWorktreeValid(v[RETIRED_WORKTREE]) || !Array.isArray(v.workFocus) || !v.workFocus.every(isWorkFocusId)) return fail();
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
    ...(isAgentAvatarId(v.avatar) ? { avatar: v.avatar } : {}),
    enabled: v.enabled, ...(v.tools === undefined ? {} : { tools: parseAgentToolSelection(v.tools) }),
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
