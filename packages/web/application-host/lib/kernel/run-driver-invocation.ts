/** A real Run driver invocation, not a synthetic tool call. The private kernel bridge
 * supplies the live Run/epoch capability; extension JSON never chooses its authority. */
import { randomUUID } from 'node:crypto';
import type { HostCapabilityCallContext, HostInvocationScope, HostServiceOwnerIdentity } from '@varin/extension-host';

export interface RunDriverAuthority {
  readonly runId: string;
  readonly kernelEpoch: string;
  readonly instanceId: string;
}
interface Registration {
  authority: Readonly<RunDriverAuthority>;
  owner: Readonly<HostServiceOwnerIdentity>;
  signal: AbortSignal;
  currentEpoch(): string | null;
  accepting: boolean;
  pending: Set<Promise<unknown>>;
  dependencies: Map<string, number>;
}
const registrations = new WeakMap<HostInvocationScope, Registration>();
const ownerKey = (owner: HostServiceOwnerIdentity): string => JSON.stringify([
  owner.extensionId, owner.entrypointId, owner.extensionVersion, owner.instanceKey, owner.generation,
]);
const owns = (registration: Registration, owner: HostServiceOwnerIdentity): boolean =>
  ownerKey(registration.owner) === ownerKey(owner) || (registration.dependencies.get(ownerKey(owner)) ?? 0) > 0;
const assertAvailable = (registration: Registration, owner: HostServiceOwnerIdentity): void => {
  if (!registration.accepting || registration.signal.aborted
    || registration.currentEpoch() !== registration.authority.kernelEpoch || !owns(registration, owner)) {
    throw new Error('run_driver_invocation_unavailable');
  }
};
function retain<T>(registration: Registration, work: () => Promise<T>): Promise<T> {
  const pending = Promise.resolve().then(work);
  registration.pending.add(pending);
  void pending.then(() => registration.pending.delete(pending), () => registration.pending.delete(pending));
  return pending;
}

/** `work` must be the actual retained service callback, not an abort-raced reader.
 * Its return closes new admission, then all already accepted primitive RPCs drain. */
export async function withRunDriverInvocation<T>(options: {
  authority: RunDriverAuthority;
  owner: HostServiceOwnerIdentity;
  signal: AbortSignal;
  currentEpoch(): string | null;
  /** Notify the native instance before draining, so abandoned observer waits can stop. */
  closing?(): Promise<void>;
}, work: (scope: HostInvocationScope) => Promise<T>): Promise<T> {
  options.signal.throwIfAborted();
  const authority = Object.freeze({ ...options.authority });
  if (!authority.runId || !authority.instanceId || !authority.kernelEpoch
    || authority.kernelEpoch !== options.currentEpoch()) throw new Error('run_driver_invocation_identity_invalid');
  const registration: Registration = { authority, owner: Object.freeze({ ...options.owner }),
    signal: options.signal, currentEpoch: options.currentEpoch, accepting: true,
    pending: new Set(), dependencies: new Map() };
  const scope: HostInvocationScope = Object.freeze({ id: randomUUID(), value: null,
    invokeDependency: <Result>(from: HostServiceOwnerIdentity, to: HostServiceOwnerIdentity, invoke: () => Promise<Result>): Promise<Result> => {
      assertAvailable(registration, from);
      const key = ownerKey(to);
      registration.dependencies.set(key, (registration.dependencies.get(key) ?? 0) + 1);
      return retain(registration, invoke).finally(() => {
        const remaining = (registration.dependencies.get(key) ?? 1) - 1;
        if (remaining) registration.dependencies.set(key, remaining); else registration.dependencies.delete(key);
      });
    },
  });
  registrations.set(scope, registration);
  try { return await work(scope); }
  finally {
    registration.accepting = false;
    try { await options.closing?.(); }
    finally {
      try { await Promise.allSettled(registration.pending); }
      finally { registrations.delete(scope); }
    }
  }
}

/** The original scope—not runId, instanceId or a copied token from extension input—
 * supplies authority. The native owner performs permission/resource admission and
 * records receipts; this map is only a live callback identity and lifetime lease. */
export function runDriverCall<T>(context: HostCapabilityCallContext, execute: (authority: Readonly<RunDriverAuthority>) => Promise<T>): Promise<T> {
  context.signal.throwIfAborted();
  const registration = context.invocation && registrations.get(context.invocation);
  if (!registration) throw new Error('run_driver_invocation_unavailable');
  assertAvailable(registration, context.owner);
  return retain(registration, () => execute(registration.authority));
}
