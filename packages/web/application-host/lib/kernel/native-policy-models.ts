/** Selected policy duties use the existing authenticated settings/catalog/credential authorities.
 * This is preparation, never model execution or a second configuration/credential store. */
import { createHash } from 'node:crypto';
import { parseHarnessModelSlots, resolveHarnessModelSlot } from '@varin/protocol';
import { waitWithSignal } from '../cancellation.js';
import type { NativeThreadModelAuthority } from './native-thread-adapter.js';
import type { NativePolicyModelCapability } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './native-credential-owner.js';
export interface NativePreparedPolicyModel {
  capability: NativePolicyModelCapability;
  credentialOwner?: ExistingHostCredentialOwner;
}
export type NativePolicyModelPreparer = (input: {
  threadId: string; requestedModelRoles: readonly 'agentPlanning'[];
  savedCapabilities?: readonly NativePolicyModelCapability[];
}, signal?: AbortSignal) => Promise<NativePreparedPolicyModel[]>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// Configuration object order is not identity; array order and every value remain significant.
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : record(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function createNativePolicyModelPreparer(options: {
  settings: (threadId: string) => Promise<unknown>; models: NativeThreadModelAuthority;
}): NativePolicyModelPreparer {
  return async (input, signal) => {
    if (!input.requestedModelRoles.length) {
      if (input.savedCapabilities?.length) throw new Error('native-policy-model-requirements-changed');
      return [];
    }
    const base: NativePolicyModelCapability = { capability_id: 'agentPlanning', purpose: 'planning', status: 'unconfigured',
      supported_operation: 'tool_free_text', binding_id: null, configuration_identity: null,
      binding: null, configuration: null, credential_scope: null };
    const unavailable = (status: NativePolicyModelCapability['status']): NativePreparedPolicyModel[] => {
      if (input.savedCapabilities?.length && (input.savedCapabilities.length !== 1 || input.savedCapabilities[0]?.status !== status)) {
        throw new Error('native-policy-model-selection-changed');
      }
      return [{ capability: { ...base, status } }];
    };
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
    const bindingId = `agentPlanning:${configurationIdentity}`;
    const capability: NativePolicyModelCapability = { ...base, status: 'available', binding_id: bindingId,
      configuration_identity: configurationIdentity, configuration: resolved.configuration, credential_scope: scope };
    const saved = input.savedCapabilities;
    if (saved?.length) {
      const previous = saved[0];
      if (saved.length !== 1 || !previous || previous.capability_id !== capability.capability_id || previous.status !== capability.status
        || previous.binding_id !== bindingId || previous.configuration_identity !== configurationIdentity
        || !previous.configuration || !previous.credential_scope) throw new Error('native-policy-model-selection-changed');
      const credentialOwner = await waitWithSignal(options.models.rebindModel(previous.configuration, previous.credential_scope), signal);
      return [{ capability: structuredClone(previous), credentialOwner }];
    }
    return [{ capability, credentialOwner: resolved.credentialOwner }];
  };
}
