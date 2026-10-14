/** User profile settings, independent of Pi sessions. Persistence stays with SettingsManager. */
import { randomUUID } from 'node:crypto';
import type { GlobalSettingsAuthority, GlobalSettingsSnapshot } from '@varin/pi-host/settings-authority';
import {
  EXECUTION_PRESETS, RESEARCH_CAPABILITY_DEFINITIONS, HarnessSettingsValidationError,
  agentPresetTools, mergeHarnessSettings, parseHarnessAgent, parseHarnessModelSlots,
  resolveAgentTools, updateAgentToolSelection,
  type AgentRuntime, type HarnessSettingsInput, type HarnessModelBinding,
  type HarnessCustomAgent, type JsonValue, type ChildCapabilityDescriptor,
} from '@varin/protocol';
import type {
  AgentProfilesAPI, AgentProfilesSnapshot, AgentProfileView, AgentProfileConfig, AgentProfileSaveRequest,
} from '@varin/application-client';
import { waitWithSignal } from '../cancellation.js';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
class ProfileRequestFailure extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const invalid = (message: string): never => { throw new ProfileRequestFailure('agent-profile-invalid', message); };
function runtime(value: unknown): AgentRuntime {
  if (value !== 'pi' && value !== 'agent') return invalid('Choose Pi or Agent as the configuration runtime.');
  return value;
}
function settings(snapshot: GlobalSettingsSnapshot) {
  const raw = snapshot.document.harness;
  if (raw !== undefined && !record(raw)) throw new HarnessSettingsValidationError('harness must be an object');
  return mergeHarnessSettings((raw ?? {}) as HarnessSettingsInput, {});
}
function sharedBinding(binding: HarnessModelBinding) {
  const { agent, ...model } = binding;
  if (!agent) return model;
  const { tools: _tools, ...shared } = agent;
  return { ...model, agent: shared };
}
function sharedAgent(agent: HarnessCustomAgent) {
  const { tools: _tools, ...shared } = agent;
  return shared;
}
function definitions(target: AgentRuntime, capabilities: ChildCapabilityDescriptor[] | null) {
  const native = capabilities && agentPresetTools(capabilities);
  return [
    ...Object.values(EXECUTION_PRESETS).map(definition => ({ slot: definition.slot, name: definition.id,
      description: definition.teamDescription, instructions: definition.systemPromptFragment,
      worktree: definition.worktree, workFocus: definition.workFocus ?? [],
      tools: target === 'agent' ? native![definition.id as 'worker' | 'retrieval'] : definition.tools })),
    ...(target === 'pi' ? Object.values(RESEARCH_CAPABILITY_DEFINITIONS).map(definition => ({
      slot: definition.slot, name: definition.capability, description: definition.systemPromptFragment,
      instructions: definition.systemPromptFragment, worktree: definition.worktree,
      workFocus: ['research' as const], tools: definition.tools,
    })) : []),
  ];
}
function project(snapshot: GlobalSettingsSnapshot, target: AgentRuntime, capabilities: ChildCapabilityDescriptor[] | null): AgentProfilesSnapshot {
  const selected = settings(snapshot);
  const profiles: AgentProfileView[] = definitions(target, capabilities).map(definition => {
    const binding = selected.models[definition.slot] ?? {};
    const overrides = binding.agent;
    const model = binding.providerId && binding.modelId ? { providerId: binding.providerId, modelId: binding.modelId } : null;
    return {
      id: `varin:builtin:${definition.slot}`, kind: 'builtin',
      config: { kind: 'builtin', slot: definition.slot, binding: sharedBinding(binding) },
      effective: { name: overrides?.name ?? definition.name, description: overrides?.description ?? definition.description,
        instructions: overrides?.instructions ?? definition.instructions, enabled: binding.enabled !== false,
        model, modelSource: model ? 'selected' : definition.slot === 'worker' ? 'inherit' : 'unconfigured',
        ...(overrides?.modelSettings ? { modelSettings: overrides.modelSettings } : {}),
        worktree: overrides?.worktree ?? definition.worktree, workFocus: [...definition.workFocus] },
      tools: resolveAgentTools(overrides?.tools, target, definition.tools),
      defaults: { name: definition.name, description: definition.description, instructions: definition.instructions,
        tools: [...definition.tools], worktree: definition.worktree },
    };
  });
  for (const [key, agent] of Object.entries(selected.agents)) {
    profiles.push({ id: `varin:custom:${key}`, kind: 'custom', config: { kind: 'custom', key, agent: sharedAgent(agent) },
      effective: { name: agent.name, description: agent.description, instructions: agent.instructions, enabled: agent.enabled,
        model: agent.model ?? null, modelSource: agent.model ? 'selected' : 'inherit',
        ...(agent.modelSettings ? { modelSettings: agent.modelSettings } : {}), worktree: agent.worktree, workFocus: [...agent.workFocus] },
      tools: resolveAgentTools(agent.tools, target), defaults: null });
  }
  return { runtime: target, revision: snapshot.revision, profiles, capabilities };
}
function validateSave(input: AgentProfileSaveRequest): void {
  runtime(input.runtime);
  if (!input.expectedRevision || !record(input.config)) invalid('Reload agent settings before saving.');
  if (input.id !== undefined && (typeof input.id !== 'string' || !input.id)) invalid('Select an existing agent profile.');
  const config = input.config as unknown as Record<string, unknown>;
  if (config.kind === 'builtin') {
    if (Object.keys(config).some(key => !['kind', 'slot', 'binding'].includes(key)) || !record(config.binding)) invalid('Invalid built-in agent configuration.');
    const binding = config.binding as Record<string, unknown>;
    if (record(binding.agent) && 'tools' in binding.agent) invalid('Save tools for the selected runtime separately.');
  } else if (config.kind === 'custom') {
    if (Object.keys(config).some(key => !['kind', 'key', 'agent'].includes(key)) || typeof config.key !== 'string' || !record(config.agent)) invalid('Invalid custom agent configuration.');
    if ('tools' in (config.agent as Record<string, unknown>)) invalid('Save tools for the selected runtime separately.');
  } else invalid('Choose a built-in or custom agent profile.');
}

export function createAgentProfilesAPI(owners: {
  settings: Pick<GlobalSettingsAuthority, 'read' | 'updateHarness'>;
  agentSettings?: Pick<GlobalSettingsAuthority, 'read' | 'updateHarness'>;
  capabilities(signal?: AbortSignal): Promise<ChildCapabilityDescriptor[]>;
  onChanged?(): void;
}): AgentProfilesAPI {
  const settingsFor = (target: AgentRuntime) => target === 'agent' ? owners.agentSettings ?? owners.settings : owners.settings;
  const capabilities = async (target: AgentRuntime, signal?: AbortSignal) => {
    if (target === 'pi') return null;
    try { return await waitWithSignal(owners.capabilities(signal), signal); }
    catch {
      signal?.throwIfAborted();
      throw new ProfileRequestFailure('agent-capabilities-unavailable', 'Native tool capabilities are unavailable. Check the Agent runtime connection and reload.', 503);
    }
  };
  return {
    async read(input, signal) {
      const target = runtime(input.runtime);
      const [snapshot, tools] = await Promise.all([waitWithSignal(settingsFor(target).read(), signal), capabilities(target, signal)]);
      return project(snapshot, target, tools);
    },
    async save(input, signal) {
      validateSave(input);
      const target = runtime(input.runtime);
      const tools = await capabilities(target, signal);
      const config: AgentProfileConfig = input.config;
      let profileId = input.id;
      if (!profileId && (config.kind !== 'custom' || config.key !== '' || !Array.isArray(input.tools))) {
        invalid('New agents require a custom profile and an explicit tool selection for this runtime.');
      }
      const builtin = definitions(target, tools).find(definition => config.kind === 'builtin' && definition.slot === config.slot);
      if (config.kind === 'builtin' && (!builtin || profileId !== `varin:builtin:${config.slot}`)) invalid('Select a built-in profile available in this runtime.');
      if (config.kind === 'custom' && profileId !== undefined && profileId !== `varin:custom:${config.key}`) invalid('The selected agent identity changed. Reload agent settings.');
      signal?.throwIfAborted();
      // The callback sees the current document protected by the original revision CAS.
      const snapshot = await settingsFor(target).updateHarness(input.expectedRevision, harness => {
        const selected = mergeHarnessSettings(harness as HarnessSettingsInput, {});
        if (config.kind === 'builtin') {
          const original = selected.models[config.slot];
          const choice = input.tools === undefined ? original?.agent?.tools
            : updateAgentToolSelection(original?.agent?.tools, target, input.tools);
          const binding = parseHarnessModelSlots({ [config.slot]: { ...config.binding,
            ...(config.binding.agent || choice !== undefined ? { agent: { ...config.binding.agent, ...(choice === undefined ? {} : { tools: choice }) } } : {}) } })[config.slot]!;
          return { ...harness, agents: selected.agents as unknown as JsonValue,
            models: { ...selected.models, [config.slot]: binding } as unknown as JsonValue };
        }
        const key = profileId ? config.key : randomUUID();
        const original = Object.hasOwn(selected.agents, key) ? selected.agents[key] : undefined;
        if (profileId && !original) throw new ProfileRequestFailure('agent-profile-not-found', 'This agent was removed. Reload agent settings.');
        const choice = input.tools === undefined ? original?.tools : updateAgentToolSelection(original?.tools, target, input.tools);
        const agent = parseHarnessAgent({ ...config.agent, tools: choice });
        profileId = `varin:custom:${key}`;
        return { ...harness, models: selected.models as unknown as JsonValue,
          agents: { ...selected.agents, [key]: agent } as unknown as JsonValue };
      });
      owners.onChanged?.();
      return { snapshot: project(snapshot, target, tools), profileId: profileId! };
    },
    async remove(input, signal) {
      const target = runtime(input.runtime);
      if (typeof input.id !== 'string' || !input.id.startsWith('varin:custom:')) invalid('Only custom agent profiles can be deleted.');
      const tools = await capabilities(target, signal);
      signal?.throwIfAborted();
      const snapshot = await settingsFor(target).updateHarness(input.expectedRevision, harness => {
        const key = input.id.slice('varin:custom:'.length);
        const selected = mergeHarnessSettings(harness as HarnessSettingsInput, {});
        if (!Object.hasOwn(selected.agents, key)) throw new ProfileRequestFailure('agent-profile-not-found', 'This agent was removed. Reload agent settings.');
        const agents = { ...selected.agents };
        delete agents[key];
        return { ...harness, models: selected.models as unknown as JsonValue, agents: agents as unknown as JsonValue };
      });
      owners.onChanged?.();
      return project(snapshot, target, tools);
    },
  };
}

/** Only the owning safe failure crosses HTTP; arbitrary upstream errors never do. */
export function agentProfileFailure(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ProfileRequestFailure) return { status: error.code === 'agent-profile-not-found' ? 404 : error.status, code: error.code, message: error.message };
  if (error instanceof HarnessSettingsValidationError) return { status: 400, code: 'agent-settings-invalid', message: error.message };
  const code = record(error) && typeof error.code === 'string' ? error.code : '';
  if (code === 'config_conflict') return { status: 409, code: 'agent-settings-conflict', message: 'Agent settings changed. Reload them before saving.' };
  if (['invalid_settings', 'invalid_config_file', 'inference-settings-invalid'].includes(code)) return {
    status: 400, code: 'agent-settings-invalid', message: 'Agent settings are invalid. Correct the configuration and reload it.',
  };
  return { status: 503, code: 'agent-settings-unavailable', message: 'Agent settings could not be loaded or saved. Check the Host connection and try again.' };
}
