/** Existing user-owned execution presets -> immutable native dispatch choices.
 * This reads no secrets, prepares no child and owns no configuration or execution state. */
import { createHash } from 'node:crypto';
import { HarnessSettingsValidationError, agentPresetTools, resolveAgentTools, mergeHarnessSettings, observePresets, type HarnessSettingsInput, type WorkFocusId } from '@varin/protocol';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import type { ThreadModelAuthority } from './thread-adapter.js';
import type { ThreadThinkingLevel } from '@varin/application-client';
import type { ChildCapabilityDescriptor, ChildCapabilityFailure, ChildDispatchCatalog, ChildModelBinding, ChildPreset } from './protocol.generated.js';
import { waitWithSignal } from '../cancellation.js';
import { waitForModelBinding } from './model-binding-lifetime.js';

export interface ChildProfileInput {
  parent: ChildModelBinding;
  workFocus?: WorkFocusId;
  /** The original parent selection retains implementations referenced by its frozen child catalog. */
  modelOwner?: ExistingHostCredentialOwner;
}
export type ChildProfilePreparer = (input: ChildProfileInput, signal?: AbortSignal) => Promise<ChildDispatchCatalog>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const freeze = (presets: ChildPreset[], normal_unavailable: ChildCapabilityFailure | null, native_capabilities: ChildCapabilityDescriptor[] = []): ChildDispatchCatalog => ({
  identity: createHash('sha256').update(JSON.stringify(canonical({ presets, normal_unavailable, native_capabilities }))).digest('hex'), presets, normal_unavailable, native_capabilities,
});
const unavailable = (code: string, capabilities: string[] = []): ChildCapabilityFailure => ({ code, capabilities });

export function createChildProfilePreparer(owners: {
  /** The existing global SettingsManager snapshot, never project overrides or a Pi Session. */
  settings(): Promise<unknown>;
  capabilities(signal?: AbortSignal): Promise<ChildCapabilityDescriptor[]>;
  models: ThreadModelAuthority;
}): ChildProfilePreparer {
  return async (input, signal) => {
    signal?.throwIfAborted();
    let settings;
    try {
      const raw = await waitWithSignal(owners.settings(), signal);
      if (!record(raw) || (raw.harness !== undefined && !record(raw.harness))) return freeze([], unavailable('child-settings-invalid'));
      settings = mergeHarnessSettings((raw.harness ?? {}) as HarnessSettingsInput, {});
    } catch (error) {
      signal?.throwIfAborted();
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      return freeze([], unavailable(error instanceof HarnessSettingsValidationError || code === 'inference-settings-invalid'
        || code === 'invalid_config_file' ? 'child-settings-invalid' : 'child-settings-unavailable'));
    }
    const descriptors = await waitWithSignal(owners.capabilities(signal), signal);
    const parent = input.parent;
    const catalogModelId = (parent.configuration.modelOptions as { catalogModelId?: string } | undefined)?.catalogModelId ?? parent.configuration.model;
    const main = parent.configuration.providerId ? { providerId: parent.configuration.providerId, modelId: catalogModelId } : null;
    const observations = observePresets(settings.models, main, settings.agents, input.workFocus, 'agent', agentPresetTools(descriptors));
    const presets = await Promise.all(observations.map(async (entry): Promise<ChildPreset> => {
      const definition = entry.definition;
      const toolsSource = definition.slot
        ? resolveAgentTools(settings.models[definition.slot]?.agent?.tools, 'agent', definition.tools).source
        : 'explicit';
      const profile: ChildPreset = { id: entry.id, name: definition.name ?? entry.id, instructions: definition.systemPromptFragment,
        tools: [...definition.tools], tools_source: toolsSource === 'default' ? 'default' : 'explicit', work_mode: definition.worktree === 'isolated' ? 'isolated_write' : 'read_only',
        model_source: entry.modelSource, model: null, inherit_base: null, unavailable: null };
      if (!input.workFocus && definition.workFocus?.length) { profile.unavailable = unavailable('child-profile-scope_unavailable'); return profile; }
      if (entry.availability !== 'available') { profile.unavailable = unavailable(`child-profile-${entry.availability}`); return profile; }
      // Host service capabilities are resolved only against the actual frozen Run directory.
      const overrides = definition.modelSettings;
      if (entry.modelSource === 'inherit' && (overrides?.temperature === undefined && overrides?.thinkingLevel === undefined)) return profile;
      try {
        if (!entry.model) { profile.unavailable = unavailable('child-model-unconfigured'); return profile; }
        const inherited = entry.modelSource === 'inherit' ? {
          ...(parent.configuration.thinkingLevel === undefined ? {} : { thinkingLevel: parent.configuration.thinkingLevel as ThreadThinkingLevel }),
          ...((parent.configuration.modelOptions as { temperature?: number } | undefined)?.temperature === undefined ? {}
            : { temperature: (parent.configuration.modelOptions as { temperature: number }).temperature }),
        } : {};
        const resolved = await waitForModelBinding(owners.models.resolveModel({ ...entry.model, ...inherited, ...overrides }),
          model => model.credentialOwner.release(), signal);
        try {
          const scope = await waitWithSignal(resolved.credentialOwner.scope(), signal);
          profile.model = { configuration: resolved.configuration, credential_scope: scope };
          if (entry.modelSource === 'inherit') {
            if (!parent.credential_scope) throw new Error('Inherited Host model requires its original scope');
            // The mapping metadata used to normalize overrides must still match the original
            // parent generation; changed catalog defaults cannot silently enter an inherited model.
            const inheritedOwner = await waitForModelBinding(owners.models.rebindModel(parent.configuration, parent.credential_scope),
              owner => owner.release(), signal);
            try { profile.inherit_base = structuredClone(parent); }
            finally { inheritedOwner.release(); }
          }
          signal?.throwIfAborted();
          input.modelOwner?.retainDependency(resolved.credentialOwner);
        } finally { resolved.credentialOwner.release(); }
      } catch {
        signal?.throwIfAborted(); profile.model = null; profile.inherit_base = null; profile.unavailable = unavailable('child-model-unavailable');
      }
      return profile;
    }));
    signal?.throwIfAborted();
    return freeze(presets, settings.models.worker?.enabled === false ? unavailable('child-worker-disabled') : null, descriptors);
  };
}
