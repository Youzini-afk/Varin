/** Ephemeral proof of an already consumed Catalog permission, never another approval store.
 * Only ExtensionToolOwner creates it after authorization, inside the original live invocation. */
import { isDeepStrictEqual } from 'node:util';
import type { HostCapabilityCallContext, HostInvocationScope, HostServiceOwnerIdentity } from '@varin/extension-host';
import { requireToolInvocation, type ToolInvocationAuthority } from './tool-invocation.js';

interface Confirmation {
  owner: HostServiceOwnerIdentity;
  toolName: string;
  arguments: unknown;
  consumed: boolean;
}
const confirmations = new WeakMap<HostInvocationScope, Confirmation>();
const ownerKey = (owner: HostServiceOwnerIdentity) => JSON.stringify([
  owner.extensionId, owner.entrypointId, owner.extensionVersion, owner.instanceKey, owner.generation,
]);

export async function withToolConfirmation<T>(
  scope: HostInvocationScope,
  owner: HostServiceOwnerIdentity,
  authority: ToolInvocationAuthority,
  work: () => Promise<T>,
): Promise<T> {
  if (confirmations.has(scope)) throw new Error('tool_confirmation_already_active');
  confirmations.set(scope, { owner: { ...owner }, toolName: authority.toolName,
    arguments: structuredClone(authority.resolvedArguments ?? authority.arguments), consumed: false });
  try { return await work(); }
  finally { confirmations.delete(scope); }
}

/** Consume once immediately before the original trusted domain dispatches a mutation.
 * A dependency, direct service RPC, changed arguments, duplicate call or expired scope is rejected.
 * This does not sandbox trusted native plugin code or certify its semantic HTTP serialization. */
export function requireConfirmedToolInvocation(context: HostCapabilityCallContext, input: unknown): ToolInvocationAuthority {
  const authority = requireToolInvocation(context);
  const proof = context.invocation && confirmations.get(context.invocation);
  if (!proof || proof.consumed || authority.operation !== 'effect'
    || ownerKey(proof.owner) !== ownerKey(context.owner) || proof.toolName !== authority.toolName
    || !isDeepStrictEqual(proof.arguments, input) || !isDeepStrictEqual(authority.resolvedArguments ?? authority.arguments, input)) {
    throw new Error('tool_confirmation_unavailable');
  }
  proof.consumed = true;
  return authority;
}
