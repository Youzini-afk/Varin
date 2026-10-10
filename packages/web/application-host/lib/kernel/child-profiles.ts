/** Existing user-owned execution presets -> immutable native dispatch choices.
 * This reads no secrets, prepares no child and owns no configuration or execution state. */
import { createHash } from 'node:crypto';
import { mergeHarnessSettings, observePresets, type HarnessSettingsInput, type WorkFocusId } from '@varin/protocol';
import type { ThreadModelAuthority } from './thread-adapter.js';
import type { ThreadThinkingLevel } from '@varin/application-client';
import type { ChildCapabilityDescriptor, ChildCapabilityFailure, ChildDispatchCatalog, ChildModelBinding, ChildPreset } from './protocol.generated.js';
import { waitWithSignal } from '../cancellation.js';

export interface ChildProfileInput { parent: ChildModelBinding; workFocus?: WorkFocusId }
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
      return freeze([], unavailable(error instanceof Error && /invalid|malformed/i.test(error.message) ? 'child-settings-invalid' : 'child-settings-unavailable'));
    }
    const descriptors = await waitWithSignal(owners.capabilities(signal), signal);
    const parent = input.parent;
    const main = parent.configuration.providerId ? { providerId: parent.configuration.providerId, modelId: parent.configuration.model } : null;
    const observations = observePresets(settings.models, main, settings.agents, input.workFocus);
    const presets = await Promise.all(observations.map(async (entry): Promise<ChildPreset> => {
      const definition = entry.definition;
      const profile: ChildPreset = { id: entry.id, name: definition.name ?? entry.id, instructions: definition.systemPromptFragment,
        tools: [...definition.tools], work_mode: definition.worktree === 'isolated' ? 'isolated_write' : 'read_only',
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
        const resolved = await waitWithSignal(owners.models.resolveModel({ ...entry.model, ...inherited, ...overrides }), signal);
        const scope = await waitWithSignal(resolved.credentialOwner.scope(), signal);
        profile.model = { configuration: resolved.configuration, credential_scope: scope };
        if (entry.modelSource === 'inherit') {
          if (!parent.credential_scope) throw new Error('Inherited Host model requires its original scope');
          // The mapping metadata used to normalize overrides must still match the original
          // parent generation; changed catalog defaults cannot silently enter an inherited model.
          await waitWithSignal(owners.models.rebindModel(parent.configuration, parent.credential_scope), signal);
          profile.inherit_base = structuredClone(parent);
        }
      } catch {
        signal?.throwIfAborted(); profile.model = null; profile.inherit_base = null; profile.unavailable = unavailable('child-model-unavailable');
      }
      return profile;
    }));
    signal?.throwIfAborted();
    return freeze(presets, settings.models.worker?.enabled === false ? unavailable('child-worker-disabled') : null, descriptors);
  };
}
