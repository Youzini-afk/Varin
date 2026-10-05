import { randomUUID } from "node:crypto";
import {
  EXECUTION_PRESETS, RESEARCH_CAPABILITY_DEFINITIONS, mergeHarnessSettings,
  parseHarnessAgent, parseHarnessModelSlots, resolveHarnessModelSlot,
  type HarnessModelRole, type HarnessSettingsInput, type JsonValue,
  type PiAgentDescriptor, type PiAgentProviderActionResult,
} from "@varin/protocol";
import { HostError } from "../errors.js";
import type { AgentProviderAdapter, AgentProviderContext } from "./types.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The catalog and management surface of the existing native dispatch profiles. */
export class VarinAgentProvider implements AgentProviderAdapter {
  readonly descriptor = { id: "varin", label: "Varin", available: true,
    description: "Native agents dispatched through Varin Threads. User definitions share Pi settings ownership.",
    actions: [{ id: "create-agent", label: "Create agent" }] };
  constructor(private readonly context: AgentProviderContext) {}

  async list() {
    const snapshot = await this.context.nativeSettings!.read();
    const raw = record(snapshot.global?.harness);
    const settings = mergeHarnessSettings(raw as HarnessSettingsInput, {});
    const selected = this.context.session.model;
    const main = selected ? { providerId: selected.provider, modelId: selected.id } : null;
    const agents: PiAgentDescriptor[] = [];
    const addBuiltin = (slot: HarnessModelRole, name: string, description: string, tools: string[], instructions: string, worktree: string, workFocus: Array<"code" | "research"> | undefined, dispatch: Record<string, JsonValue>) => {
      const model = resolveHarnessModelSlot(slot, settings.models, main);
      const binding = settings.models[slot];
      const displayedModel = binding?.providerId && binding.modelId ? { providerId: binding.providerId, modelId: binding.modelId } : model;
      const enabled = settings.models[slot]?.enabled !== false;
      const overrides = binding?.agent;
      agents.push({ id: `varin:builtin:${slot}`, providerId: "varin", kind: "delegatable", name: overrides?.name ?? name, description: overrides?.description ?? description,
        source: { scope: "builtin" }, status: !enabled ? "disabled" : model ? "available" : "unconfigured",
        ...(workFocus?.length ? { workFocus } : {}),
        ...(displayedModel ? { model: `${displayedModel.providerId}/${displayedModel.modelId}` } : {}),
        definition: { revision: snapshot.globalRevision,
          config: { kind: "builtin", slot, binding: { ...settings.models[slot] } as unknown as JsonValue,
            tools: overrides?.tools ?? tools, instructions: overrides?.instructions ?? instructions,
            worktree: overrides?.worktree ?? worktree,
            ...(overrides?.modelSettings ? { modelSettings: overrides.modelSettings as JsonValue } : {}),
            defaults: { name, description, tools, instructions, worktree }, ...dispatch } },
        actions: [{ id: enabled ? "disable" : "enable", label: enabled ? "Disable" : "Enable" }, { id: "update", label: "Configure" }],
      });
    };
    for (const preset of Object.values(EXECUTION_PRESETS)) addBuiltin(preset.slot, preset.id, preset.teamDescription,
      preset.tools, preset.systemPromptFragment, preset.worktree, preset.workFocus, { preset: preset.id });
    for (const entry of Object.values(RESEARCH_CAPABILITY_DEFINITIONS)) addBuiltin(entry.slot, entry.capability, entry.systemPromptFragment,
      entry.tools, entry.systemPromptFragment, entry.worktree, ["research"], { capability: entry.capability });
    for (const [id, agent] of Object.entries(settings.agents)) {
      const model = agent.model ?? main;
      agents.push({ id: `varin:custom:${id}`, providerId: "varin", kind: "delegatable", name: agent.name, description: agent.description,
        source: { scope: "user" }, status: !agent.enabled ? "disabled" : model ? "available" : "unconfigured",
        workFocus: agent.workFocus, ...(model ? { model: `${model.providerId}/${model.modelId}` } : {}),
        definition: { revision: snapshot.globalRevision, config: { kind: "custom", key: id, agent: agent as unknown as JsonValue, preset: `custom:${id}` } },
        actions: [{ id: agent.enabled ? "disable" : "enable", label: agent.enabled ? "Disable" : "Enable" },
          { id: "update", label: "Edit" }, { id: "delete", label: "Delete", destructive: true }],
      });
    }
    return { agents, diagnostics: [] };
  }

  async action(action: string, agentId: string | undefined, input: JsonValue | undefined): Promise<PiAgentProviderActionResult> {
    const request = record(input);
    const snapshot = await this.context.nativeSettings!.read();
    if (action === "inspect") {
      const agent = (await this.list()).agents.find(entry => entry.id === agentId);
      if (!agent) throw new HostError("agent_not_found", "Agent no longer exists");
      return { providerId: "varin", agentId: agent.id, success: true, message: "Agent definition", data: agent as unknown as JsonValue };
    }
    const fields = action === "create-agent" || action === "update" ? ["expectedRevision", "config"] : ["expectedRevision"];
    if (Object.keys(request).some(key => !fields.includes(key))) throw new HostError("invalid_params", "Native agents use user settings; provide only expectedRevision and, for create/update, config");
    if (typeof request.expectedRevision !== "string" || request.expectedRevision !== snapshot.globalRevision) {
      throw new HostError("config_conflict", "Agent settings changed. Reload the catalog before editing.");
    }
    const harness = { ...record(snapshot.global?.harness) };
    const settings = mergeHarnessSettings(harness as HarnessSettingsInput, {});
    const profiles = { ...settings.agents };
    let resultId = agentId;
    if (action === "create-agent") {
      const id = randomUUID();
      profiles[id] = parseHarnessAgent(request.config);
      harness.agents = profiles;
      resultId = `varin:custom:${id}`;
    } else if (agentId?.startsWith("varin:custom:")) {
      const id = agentId.slice("varin:custom:".length);
      const agent = Object.hasOwn(profiles, id) ? profiles[id] : undefined;
      if (!agent) throw new HostError("agent_not_found", "Agent no longer exists");
      if (action === "update") profiles[id] = parseHarnessAgent(request.config);
      else if (action === "delete") delete profiles[id];
      else if (action === "enable" || action === "disable") profiles[id] = { ...agent, enabled: action === "enable" };
      else throw new HostError("unsupported_agent_action", `Unknown agent action: ${action}`);
      harness.agents = profiles;
    } else {
      const current = (await this.list()).agents.find(entry => entry.id === agentId && entry.source.scope === "builtin");
      const slot = current?.definition?.config.slot as HarnessModelRole | undefined;
      if (!slot) throw new HostError("agent_not_found", "Unknown built-in agent");
      const binding = action === "update" ? parseHarnessModelSlots({ [slot]: request.config })[slot]
        : action === "enable" || action === "disable" ? { ...settings.models[slot], enabled: action === "enable" } : undefined;
      if (!binding) throw new HostError("unsupported_agent_action", `Unknown agent action: ${action}`);
      harness.models = { ...settings.models, [slot]: binding };
    }
    await this.context.nativeSettings!.write(harness as JsonValue, request.expectedRevision);
    return { providerId: "varin", ...(resultId ? { agentId: resultId } : {}), success: true,
      ...(resultId?.startsWith("varin:custom:") ? { data: { preset: resultId.slice("varin:".length) } } : {}),
      message: "Saved. New task dispatches use this definition; accepted tasks retain their configuration." };
  }
}
