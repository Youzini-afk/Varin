/** Native agent profiles share the revisioned Agent settings owner. */
import { randomUUID } from 'node:crypto';
import {
  EXECUTION_PRESETS, HarnessSettingsValidationError,
  agentPresetTools, mergeHarnessSettings, parseHarnessAgent, parseHarnessModelSlots,
  resolveAgentTools, updateAgentToolSelection,
  type HarnessSettingsInput, type HarnessModelBinding,
  type HarnessCustomAgent, type JsonValue, type ChildCapabilityDescriptor,
  type ContextAgentDefinition,
} from '@varin/protocol';
import type {
  AgentProfilesAPI, AgentProfilesSnapshot, AgentProfileView, AgentProfileConfig, AgentProfileSaveRequest,
} from '@varin/application-client';
import { waitWithSignal } from '../cancellation.js';

export interface GlobalSettingsSnapshot { document: Record<string, JsonValue>; revision: string }
export interface AgentProfileSettingsOwner {
  read(): Promise<GlobalSettingsSnapshot>;
  updateHarness(expectedRevision: string, update: (harness: Record<string, JsonValue>) => Record<string, JsonValue>): Promise<GlobalSettingsSnapshot>;
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
class ProfileRequestFailure extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
const invalid = (message: string): never => { throw new ProfileRequestFailure('agent-profile-invalid', message); };
function runtime(value: unknown): 'agent' {
  if (value !== 'agent') return invalid('Choose the native Agent runtime.');
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
function definitions(capabilities: ChildCapabilityDescriptor[], context: ContextAgentDefinition) {
  const native = agentPresetTools(capabilities);
  return [...Object.values(EXECUTION_PRESETS).map(definition => ({ slot: definition.slot, name: definition.id,
    description: definition.teamDescription, instructions: definition.systemPromptFragment,
    worktree: definition.worktree, workFocus: definition.workFocus ?? [],
    tools: native[definition.id], automation: undefined as ContextAgentDefinition | undefined })),
    { slot: 'contextCompaction' as const, name: 'Context organization',
      description: 'Update conversation summaries and retain original material for subsequent work.',
      instructions: context.instructions, worktree: 'none' as const, workFocus: [],
      tools: context.tools.map(tool => tool.name), automation: context }];
}
function project(snapshot: GlobalSettingsSnapshot, target: 'agent', capabilities: ChildCapabilityDescriptor[], context: ContextAgentDefinition): AgentProfilesSnapshot {
  const selected = settings(snapshot);
  const profiles: AgentProfileView[] = definitions(capabilities, context).map(definition => {
    const binding = selected.models[definition.slot] ?? {};
    const overrides = binding.agent;
    const model = binding.providerId && binding.modelId ? { providerId: binding.providerId, modelId: binding.modelId } : null;
    return {
      id: `varin:builtin:${definition.slot}`, kind: 'builtin',
      config: { kind: 'builtin', slot: definition.slot, binding: sharedBinding(binding) },
      effective: { name: overrides?.name ?? definition.name, description: overrides?.description ?? definition.description,
        ...(overrides?.avatar ? { avatar: overrides.avatar } : {}),
        instructions: overrides?.instructions ?? definition.instructions, enabled: binding.enabled !== false,
        model, modelSource: model ? 'selected' : ['worker', 'verifier', 'contextCompaction'].includes(definition.slot) ? 'inherit' : 'unconfigured',
        ...(overrides?.modelSettings ? { modelSettings: overrides.modelSettings } : {}),
        worktree: overrides?.worktree ?? definition.worktree, workFocus: [...definition.workFocus] },
      tools: resolveAgentTools(definition.automation ? undefined : overrides?.tools, target, definition.tools),
      ...(definition.automation ? { automation: definition.automation } : {}),
      defaults: { name: definition.name, description: definition.description, instructions: definition.instructions,
        tools: [...definition.tools], worktree: definition.worktree },
    };
  });
  for (const [key, agent] of Object.entries(selected.agents)) {
    profiles.push({ id: `varin:custom:${key}`, kind: 'custom', config: { kind: 'custom', key, agent: sharedAgent(agent) },
      effective: { name: agent.name, description: agent.description, instructions: agent.instructions, enabled: agent.enabled,
        ...(agent.avatar ? { avatar: agent.avatar } : {}),
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
  settings: AgentProfileSettingsOwner;
  capabilities(signal?: AbortSignal): Promise<ChildCapabilityDescriptor[]>;
  contextAgentDefinition(signal?: AbortSignal): Promise<ContextAgentDefinition>;
  onChanged?(): void;
}): AgentProfilesAPI {
  const capabilities = async (signal?: AbortSignal) => {
    try { return await waitWithSignal(Promise.all([owners.capabilities(signal), owners.contextAgentDefinition(signal)]), signal); }
    catch {
      signal?.throwIfAborted();
      throw new ProfileRequestFailure('agent-capabilities-unavailable', 'Native tool capabilities are unavailable. Check the Agent runtime connection and reload.', 503);
    }
  };
  return {
    async read(input, signal) {
      const target = runtime(input.runtime);
      const [snapshot, [tools, context]] = await Promise.all([waitWithSignal(owners.settings.read(), signal), capabilities(signal)]);
      return project(snapshot, target, tools, context);
    },
    async save(input, signal) {
      validateSave(input);
      const target = runtime(input.runtime);
      const [tools, context] = await capabilities(signal);
      const config: AgentProfileConfig = input.config;
      let profileId = input.id;
      if (!profileId && (config.kind !== 'custom' || config.key !== '' || !Array.isArray(input.tools))) {
        invalid('New agents require a custom profile and an explicit tool selection for this runtime.');
      }
      const builtin = definitions(tools, context).find(definition => config.kind === 'builtin' && definition.slot === config.slot);
      if (config.kind === 'builtin' && (!builtin || profileId !== `varin:builtin:${config.slot}`)) invalid('Select a built-in profile available in this runtime.');
      if (builtin?.automation && (input.tools !== undefined || (config.kind === 'builtin' && config.binding.agent?.worktree !== undefined))) {
        invalid('Context organization uses its runtime-owned read tools and conversation source.');
      }
      if (config.kind === 'custom' && profileId !== undefined && profileId !== `varin:custom:${config.key}`) invalid('The selected agent identity changed. Reload agent settings.');
      signal?.throwIfAborted();
      // The callback sees the current document protected by the original revision CAS.
      const snapshot = await owners.settings.updateHarness(input.expectedRevision, harness => {
        const selected = mergeHarnessSettings(harness as HarnessSettingsInput, {});
        if (config.kind === 'builtin') {
          const original = selected.models[config.slot];
          const choice = input.tools === undefined ? original?.agent?.tools
            : updateAgentToolSelection(input.tools);
          const binding = parseHarnessModelSlots({ [config.slot]: { ...config.binding,
            ...(config.binding.agent || choice !== undefined ? { agent: { ...config.binding.agent, ...(choice === undefined ? {} : { tools: choice }) } } : {}) } })[config.slot]!;
          return { ...harness, agents: selected.agents as unknown as JsonValue,
            models: { ...selected.models, [config.slot]: binding } as unknown as JsonValue };
        }
        const key = profileId ? config.key : randomUUID();
        const original = Object.hasOwn(selected.agents, key) ? selected.agents[key] : undefined;
        if (profileId && !original) throw new ProfileRequestFailure('agent-profile-not-found', 'This agent was removed. Reload agent settings.');
        const choice = input.tools === undefined ? original?.tools : updateAgentToolSelection(input.tools);
        const agent = parseHarnessAgent({ ...config.agent, tools: choice });
        profileId = `varin:custom:${key}`;
        return { ...harness, models: selected.models as unknown as JsonValue,
          agents: { ...selected.agents, [key]: agent } as unknown as JsonValue };
      });
      owners.onChanged?.();
      return { snapshot: project(snapshot, target, tools, context), profileId: profileId! };
    },
    async remove(input, signal) {
      const target = runtime(input.runtime);
      if (typeof input.id !== 'string' || !input.id.startsWith('varin:custom:')) invalid('Only custom agent profiles can be deleted.');
      const [tools, context] = await capabilities(signal);
      signal?.throwIfAborted();
      const snapshot = await owners.settings.updateHarness(input.expectedRevision, harness => {
        const key = input.id.slice('varin:custom:'.length);
        const selected = mergeHarnessSettings(harness as HarnessSettingsInput, {});
        if (!Object.hasOwn(selected.agents, key)) throw new ProfileRequestFailure('agent-profile-not-found', 'This agent was removed. Reload agent settings.');
        const agents = { ...selected.agents };
        delete agents[key];
        return { ...harness, models: selected.models as unknown as JsonValue, agents: agents as unknown as JsonValue };
      });
      owners.onChanged?.();
      return project(snapshot, target, tools, context);
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
