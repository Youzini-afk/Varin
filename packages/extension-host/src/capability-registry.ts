import {
  isVarinExtensionId,
  type JsonValue,
  type VarinExtensionCapabilityGrant,
} from "@varin/extension-contract";
import type { HostInvocationScope, HostServiceOwnerIdentity } from "./service-registry.js";

export interface HostCapabilityCallContext {
  owner: HostServiceOwnerIdentity;
  signal: AbortSignal;
  readonly invocation?: HostInvocationScope;
}

export type HostCapabilityHandler = (
  method: string,
  params: JsonValue,
  context: HostCapabilityCallContext,
) => JsonValue | Promise<JsonValue>;

export class HostCapabilityRegistry {
  readonly #handlers = new Map<string, HostCapabilityHandler>();
  readonly #cleanupMethods = new Map<string, ReadonlySet<string>>();

  register(capability: string, handler: HostCapabilityHandler, options?: { cleanupMethods?: readonly string[] }): () => void {
    if (!isVarinExtensionId(capability)) throw new Error(`Invalid Host capability ID: ${capability}`);
    if (this.#handlers.has(capability)) throw new Error(`Host capability is already registered: ${capability}`);
    this.#handlers.set(capability, handler);
    this.#cleanupMethods.set(capability, new Set(options?.cleanupMethods));
    return () => { if (this.#handlers.get(capability) === handler) { this.#handlers.delete(capability); this.#cleanupMethods.delete(capability); } };
  }

  invoke(
    owner: HostServiceOwnerIdentity,
    grants: readonly VarinExtensionCapabilityGrant[],
    capability: string,
    method: string,
    params: JsonValue,
    signal: AbortSignal,
    invocation?: HostInvocationScope,
    disposing = false,
  ): Promise<JsonValue> {
    signal.throwIfAborted();
    const granted = grants.some((grant) => (
      grant.realm === "host"
      // Only trusted Host registrations can admit owner-scoped release methods
      // during teardown. Revocation still denies every ordinary capability call.
      && (grant.granted || disposing && this.#cleanupMethods.get(capability)?.has(method))
      && grant.capability === capability
      && grant.manifestVersion === owner.extensionVersion
    ));
    if (!granted) throw new Error(`Host capability is not granted: ${capability}`);
    const handler = this.#handlers.get(capability);
    if (!handler) throw new Error(`Host capability is unavailable: ${capability}`);
    return Promise.resolve(handler(method, params, { owner, signal, ...(invocation ? { invocation } : {}) }));
  }
}
