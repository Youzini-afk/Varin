/** Call-scoped authority carried only by a Host-created service invocation. Broker payloads
 * carry an opaque identifier; extension-supplied Run/workspace fields never grant authority.
 */
import { randomUUID } from 'node:crypto';
import type { HostCapabilityCallContext, HostInvocationScope, HostServiceOwnerIdentity } from '@varin/extension-host';
import type { LaunchSource, ToolOrigin } from './protocol.generated.js';

export interface ToolInvocationAuthority {
  readonly invocationId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly operationId: string;
  readonly origin: ToolOrigin;
  readonly source: Readonly<LaunchSource> | null;
}
interface Registration {
  authority: ToolInvocationAuthority;
  owner: Readonly<HostServiceOwnerIdentity>;
  signal: AbortSignal;
}
// This recognizes the very same object owned by the service invocation. It neither schedules
// execution nor stores an independent Operation/receipt or accepts extension-reported identities.
const registrations = new WeakMap<HostInvocationScope, Registration>();

/** Host-only bridge entry. The caller must first validate the original Catalog invocation and
 * immutable Run launch. `work` must be the real pin.invoke promise, never a cancelled reader race.
 */
export async function withToolInvocation<T>(options: {
  authority: ToolInvocationAuthority;
  owner: HostServiceOwnerIdentity;
  signal: AbortSignal;
}, work: (scope: HostInvocationScope) => Promise<T>): Promise<T> {
  options.signal.throwIfAborted();
  const authority = structuredClone(options.authority);
  const { origin } = authority;
  const expected = origin.kind === 'model_step'
    ? `${origin.request_id}:tool:`
    : `${origin.action_id}:node:${origin.node_id}`;
  if (!authority.invocationId || !authority.runId || !authority.threadId || !authority.operationId
    || (origin.kind === 'model_step' ? !origin.request_id || !authority.operationId.startsWith(expected)
      : !origin.action_id || !origin.node_id || authority.operationId !== expected)) {
    throw new Error('tool_invocation_identity_invalid');
  }
  Object.freeze(authority.origin);
  if (authority.source) {
    if (authority.source.live_root) Object.freeze(authority.source.live_root);
    Object.freeze(authority.source);
  }
  Object.freeze(authority);
  const scope: HostInvocationScope = Object.freeze({ id: randomUUID(), value: null });
  registrations.set(scope, { authority, owner: Object.freeze({ ...options.owner }), signal: options.signal });
  try { return await work(scope); }
  finally { registrations.delete(scope); }
}

/** Domain adapters use this typed boundary; they do not cast unknown broker data to authority. */
export function requireToolInvocation(context: HostCapabilityCallContext): ToolInvocationAuthority {
  const registration = context.invocation ? registrations.get(context.invocation) : undefined;
  if (!registration || registration.signal.aborted || context.signal.aborted
    || registration.owner.entrypointId !== context.owner.entrypointId
    || registration.owner.extensionId !== context.owner.extensionId
    || registration.owner.extensionVersion !== context.owner.extensionVersion
    || registration.owner.generation !== context.owner.generation) {
    throw new Error('tool_invocation_unavailable');
  }
  return registration.authority;
}
