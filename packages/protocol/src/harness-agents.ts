import { HarnessSettingsValidationError, type ModelSelection } from "./harness-settings.js";
import { isWorkFocusId, type WorkFocusId } from "./work-focus.js";

export interface HarnessCustomAgent {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  /** Unset inherits the caller's model at dispatch. */
  model?: ModelSelection;
  tools: string[];
  worktree: "none" | "isolated";
  /** Empty means available in either work focus. */
  workFocus: WorkFocusId[];
}

export function parseHarnessAgent(value: unknown): HarnessCustomAgent {
  const fail = (): never => { throw new HarnessSettingsValidationError("Invalid agent definition: name, description, instructions, enabled, tools, worktree and workFocus are required; model is optional"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["name", "description", "instructions", "enabled", "model", "tools", "worktree", "workFocus"].includes(key))
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
    workFocus: [...new Set(v.workFocus as WorkFocusId[])], ...(model ? { model } : {}) };
}

export function parseHarnessAgents(value: unknown): Record<string, HarnessCustomAgent> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessSettingsValidationError("harness.agents must be an object");
  return Object.fromEntries(Object.entries(value).map(([id, agent]) => {
    if (!id.trim()) throw new HarnessSettingsValidationError("Agent identity must not be empty");
    return [id, parseHarnessAgent(agent)];
  }));
}
