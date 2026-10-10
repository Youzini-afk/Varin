/** Selected policy duties use the existing authenticated settings/catalog/credential authorities.
 * This is preparation, never model execution or a second configuration/credential store. */
import { createHash } from 'node:crypto';
import { parseHarnessModelSlots, resolveHarnessModelSlot } from '@varin/protocol';
import { waitWithSignal } from '../cancellation.js';
import type { ThreadModelAuthority } from './thread-adapter.js';
import type { PolicyModelCapability } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
export interface PreparedPolicyModel {
  capability: PolicyModelCapability;
  credentialOwner?: ExistingHostCredentialOwner;
}
export type PolicyModelPreparer = (input: {
  threadId: string; generation: number; requestedModelRoles: readonly 'agentPlanning'[];
  savedCapabilities?: readonly PolicyModelCapability[];
}, signal?: AbortSignal) => Promise<PreparedPolicyModel[]>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// Configuration object order is not identity; array order and every value remain significant.
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function createPolicyModelPreparer(options: {
  settings: (threadId: string) => Promise<unknown>; models: ThreadModelAuthority;
}): PolicyModelPreparer {
  return async (input, signal) => {
    if (!input.requestedModelRoles.length) {
      if (input.savedCapabilities?.length) throw new Error('policy-model-requirements-changed');
      return [];
    }
    const base: PolicyModelCapability = { capability_id: 'agentPlanning', purpose: 'planning', status: 'unconfigured',
      supported_operation: 'tool_free_text', binding_id: null, configuration_identity: null,
      binding: null, configuration: null, credential_scope: null };
    if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error('policy-model-generation-invalid');
    const saved = input.savedCapabilities;
    if (saved !== undefined) {
      const previous = saved[0];
      if (saved.length !== 1 || !previous || previous.capability_id !== 'agentPlanning'
        || previous.purpose !== 'planning' || previous.supported_operation !== 'tool_free_text') throw new Error('policy-model-requirements-changed');
      if (previous.status !== 'available') return [{ capability: structuredClone(previous) }];
      if (!previous.configuration || !previous.credential_scope) throw new Error('policy-model-selection-changed');
      const configurationIdentity = createHash('sha256').update(JSON.stringify(canonical({ configuration: previous.configuration, scope: previous.credential_scope }))).digest('hex');
      if (previous.configuration_identity !== configurationIdentity
        || previous.binding_id !== `policy:${input.generation}:agentPlanning:${configurationIdentity}`) throw new Error('policy-model-selection-changed');
      // Restore the committed model directly. Current settings and routing are unrelated intent.
      const credentialOwner = await waitWithSignal(options.models.rebindModel(previous.configuration, previous.credential_scope), signal);
      return [{ capability: structuredClone(previous), credentialOwner }];
    }
    const unavailable = (status: PolicyModelCapability['status']): PreparedPolicyModel[] => [{ capability: { ...base, status } }];
    let snapshot: unknown;
    try { snapshot = await waitWithSignal(options.settings(input.threadId), signal); }
    catch { signal?.throwIfAborted(); return unavailable('unavailable'); }
    if (!record(snapshot) || !record(snapshot.global)) return unavailable('invalid');
    const harness = snapshot.global.harness;
    if (harness !== undefined && !record(harness)) return unavailable('invalid');
    let slots;
    try { slots = parseHarnessModelSlots(record(harness) ? harness.models : undefined); }
    catch { return unavailable('invalid'); }
    if (slots.agentPlanning?.enabled === false) return unavailable('disabled');
    const selection = resolveHarnessModelSlot('agentPlanning', slots, null);
    if (!selection) return unavailable('unconfigured');
    let resolved;
    try { resolved = await waitWithSignal(options.models.resolveModel(selection), signal); }
    catch { signal?.throwIfAborted(); return unavailable('unavailable'); }
    signal?.throwIfAborted();
    let scope;
    try { scope = await waitWithSignal(resolved.credentialOwner.scope(), signal); }
    catch { signal?.throwIfAborted(); return unavailable('unavailable'); }
    const configurationIdentity = createHash('sha256').update(JSON.stringify(canonical({ configuration: resolved.configuration, scope }))).digest('hex');
    const bindingId = `policy:${input.generation}:agentPlanning:${configurationIdentity}`;
    const capability: PolicyModelCapability = { ...base, status: 'available', binding_id: bindingId,
      configuration_identity: configurationIdentity, configuration: resolved.configuration, credential_scope: scope };
    return [{ capability, credentialOwner: resolved.credentialOwner }];
  };
}
