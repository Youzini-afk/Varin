/** Call-scoped authority carried only by a Host-created service invocation. Broker payloads
 * carry an opaque identifier; extension-supplied Run/workspace fields never grant authority.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseVarinToolJson, type JsonValue } from '@varin/extension-contract';
import { unknownToolReceipt, type ToolExecutionReceipt } from './tool-bridge.js';
import type { HostCapabilityCallContext, HostInvocationScope, HostServiceOwnerIdentity } from '@varin/extension-host';
import type { LaunchSource, ToolOrigin } from './protocol.generated.js';

export interface ToolInvocationAuthority {
  readonly invocationId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly operationId: string;
  readonly origin: ToolOrigin;
  readonly source: Readonly<LaunchSource> | null;
  readonly toolName: string;
  readonly operation: 'read' | 'effect';
  readonly arguments: unknown;
}
interface Registration {
  authority: ToolInvocationAuthority;
  owner: Readonly<HostServiceOwnerIdentity>;
  signal: AbortSignal;
  accepting: boolean;
  effect?: { domain: string; work: Promise<ToolExecutionReceipt> };
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
  /** Only trusted Host domain handlers can supply original executor evidence. */
  onEffectReceipt?: (receipt: ToolExecutionReceipt) => void;
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
  const registration: Registration = { authority, owner: Object.freeze({ ...options.owner }), signal: options.signal, accepting: true };
  registrations.set(scope, registration);
  try { return await work(scope); }
  finally {
    // A broker response/exit stops new capabilities, but does not stop a Host file writer
    // already admitted by that invocation. Keep the original lease until its real promise settles.
    registration.accepting = false;
    try {
      if (registration.effect) {
        // An unclassified domain error is not evidence that its physical writer stopped.
        const receipt = await registration.effect.work.catch(unknownToolReceipt);
        options.onEffectReceipt?.(receipt);
      }
    } finally { registrations.delete(scope); }
  }
}

/** Domain adapters use this typed boundary; they do not cast unknown broker data to authority. */
export function requireToolInvocation(context: HostCapabilityCallContext): ToolInvocationAuthority {
  const registration = context.invocation ? registrations.get(context.invocation) : undefined;
  if (!registration || !registration.accepting || registration.signal.aborted || context.signal.aborted
    || registration.owner.entrypointId !== context.owner.entrypointId
    || registration.owner.extensionId !== context.owner.extensionId
    || registration.owner.extensionVersion !== context.owner.extensionVersion
    || registration.owner.generation !== context.owner.generation) {
    throw new Error('tool_invocation_unavailable');
  }
  return registration.authority;
}


/** Bind an effectful trusted domain to this exact admitted call. The original domain journal
 * remains the effect owner. This only retains its actual promise and projects its receipt back
 * through the existing ToolBridge; extension JSON can never supply stop/effect evidence. */
export function runToolDomainEffect(
  context: HostCapabilityCallContext,
  input: { domain: string; toolName: string; arguments: JsonValue },
  execute: (authority: ToolInvocationAuthority) => Promise<ToolExecutionReceipt>,
): Promise<JsonValue> {
  const authority = requireToolInvocation(context);
  if (authority.operation !== 'effect' || authority.toolName !== input.toolName || !isDeepStrictEqual(authority.arguments, input.arguments)) {
    throw new Error('tool_domain_call_changed');
  }
  const registration = registrations.get(context.invocation!)!;
  if (registration.effect && registration.effect.domain !== input.domain) throw new Error('tool_domain_owner_changed');
  if (!registration.effect) {
    const work = Promise.resolve().then(() => execute(authority));
    registration.effect = { domain: input.domain, work };
    // An extension may abandon its capability promise. withToolInvocation still observes it.
    void work.catch(() => undefined);
  }
  return registration.effect.work.then(receipt => {
    if (receipt.completion.kind !== 'result') throw new Error('tool_domain_result_unavailable');
    return parseVarinToolJson(receipt.completion.content);
  });
}
