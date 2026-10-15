import {
  isVarinExtensionId,
  type JsonValue,
  type VarinApplicationSurface,
  type VarinExtensionServiceRoutingContext,
} from "@varin/extension-contract";
import type { SurfaceOwnerIdentity } from "./types.js";

export interface SurfaceCapabilityAccessContext {
  access: "local" | "remote";
  projectTrusted: boolean;
  surface: VarinApplicationSurface;
  routing?: VarinExtensionServiceRoutingContext;
}

export interface SurfaceCapabilityDescriptor {
  exposure: "local-only" | "remote-safe";
  id: string;
  projectTrust?: "required";
  supports: readonly VarinApplicationSurface[];
}

export interface SurfaceCapabilityCallContext extends SurfaceCapabilityAccessContext {
  owner: SurfaceOwnerIdentity;
  signal: AbortSignal;
}

export type SurfaceCapabilityHandler = (
  method: string,
  params: JsonValue,
  context: SurfaceCapabilityCallContext,
) => JsonValue | Promise<JsonValue>;

interface RegisteredCapability {
  descriptor: SurfaceCapabilityDescriptor;
  handler: SurfaceCapabilityHandler;
}

const isAvailable = (
  descriptor: SurfaceCapabilityDescriptor,
  context: SurfaceCapabilityAccessContext,
): boolean => (
  descriptor.supports.includes(context.surface)
  && (descriptor.exposure === "remote-safe" || context.access === "local")
  && (descriptor.projectTrust !== "required" || context.projectTrusted)
);

export class SurfaceCapabilityRegistry {
  readonly #capabilities = new Map<string, RegisteredCapability>();

  register(descriptor: SurfaceCapabilityDescriptor, handler: SurfaceCapabilityHandler): () => void {
    if (!isVarinExtensionId(descriptor.id)) throw new Error(`Invalid Surface capability ID: ${descriptor.id}`);
    if (descriptor.supports.length === 0) throw new Error(`Surface capability must support at least one Surface: ${descriptor.id}`);
    if (new Set(descriptor.supports).size !== descriptor.supports.length) {
      throw new Error(`Surface capability contains duplicate Surface values: ${descriptor.id}`);
    }
    if (this.#capabilities.has(descriptor.id)) throw new Error(`Surface capability is already registered: ${descriptor.id}`);
    const registered = { descriptor: { ...descriptor, supports: [...descriptor.supports] }, handler };
    this.#capabilities.set(descriptor.id, registered);
    return () => {
      if (this.#capabilities.get(descriptor.id) === registered) this.#capabilities.delete(descriptor.id);
    };
  }

  resolveGranted(
    grants: Iterable<string>,
    context: SurfaceCapabilityAccessContext,
  ): string[] {
    return [...new Set(grants)].filter((capability) => {
      const registered = this.#capabilities.get(capability);
      return Boolean(registered && isAvailable(registered.descriptor, context));
    });
  }

  async invoke(
    capability: string,
    method: string,
    params: JsonValue,
    owner: SurfaceOwnerIdentity,
    grants: Iterable<string>,
    context: SurfaceCapabilityAccessContext,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    if (!new Set(grants).has(capability)) throw new Error(`Surface capability is not granted: ${capability}`);
    const registered = this.#capabilities.get(capability);
    if (!registered || !isAvailable(registered.descriptor, context)) {
      throw new Error(`Surface capability is unavailable in this Surface context: ${capability}`);
    }
    return registered.handler(method, params, { ...context, owner, signal });
  }
}
