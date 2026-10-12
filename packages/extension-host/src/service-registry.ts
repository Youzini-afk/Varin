import {
  parseVarinExtensionServiceInvocationRequest,
  parseVarinExtensionServiceProvision,
  parseVarinToolJson,
  type JsonValue,
  type VarinExtensionServiceCatalogSnapshot,
  type VarinExtensionServiceInvocationRequest,
  type VarinExtensionServiceProviderSnapshot,
  type VarinExtensionServiceProvision,
  type VarinHostServiceComposition,
} from "@varin/extension-contract";

export interface HostServiceOwnerIdentity {
  entrypointId: string;
  extensionId: string;
  extensionVersion: string;
  generation: number;
  instanceKey: string;
}

/** Trusted Host-only authority. Only an opaque reference may cross an extension worker boundary. */
export interface HostInvocationScope {
  readonly id: string;
  readonly value: unknown;
  /** Trusted Host-only lifetime hook, entered only after the supervisor verifies a frozen edge.
   * It preserves the original invocation/permission identity across the actual dependent callback. */
  invokeDependency?<T>(from: HostServiceOwnerIdentity, to: HostServiceOwnerIdentity, invoke: () => Promise<T>): Promise<T>;
}

export interface HostServiceInvocationContext {
  readonly signal: AbortSignal;
  readonly invocation?: HostInvocationScope;
}

export type HostServiceHandler = (
  method: string,
  args: JsonValue[],
  context: HostServiceInvocationContext,
) => JsonValue | Promise<JsonValue>;

export interface HostServiceProvision {
  descriptor: VarinExtensionServiceProvision;
  handler: HostServiceHandler;
}

export class HostServiceBindingError extends Error {
  constructor(readonly code: "missing" | "ambiguous" | "selected_unavailable" | "binding_retired" | "binding_revoked", message: string) {
    super(message);
    this.name = "HostServiceBindingError";
  }
}

/** A resolved implementation, never a recipe that silently chooses a different provider. */
export interface HostServiceBinding {
  readonly providerId: string;
  readonly providerKey: string;
  readonly descriptor: Readonly<VarinExtensionServiceProvision>;
  readonly composition: VarinHostServiceComposition | null;
  /** Check this retained lease without acquiring another reference. */
  assertAvailable(): void;
  /** Release this preparation/consumer lease; existing independent pins retain their own lifetime. */
  release(): void;
  invoke(method: string, args: JsonValue[], signal?: AbortSignal): Promise<JsonValue>;
  /** Retain this exact generation for a frozen exchange; release when the exchange settles. */
  pin(): HostServicePin;
}

export interface HostServicePin {
  readonly providerId: string;
  /** Explicit disable/revocation/crash, never ordinary generation retirement. */
  readonly revocationSignal: AbortSignal;
  /** Check revocation without calling the worker; ordinary retirement preserves a held pin. */
  assertAvailable(): void;
  invoke(method: string, args: JsonValue[], signal?: AbortSignal, invocation?: HostInvocationScope): Promise<JsonValue>;
  release(): void;
}

interface ActiveProvider {
  descriptor: VarinExtensionServiceProvision;
  handler: HostServiceHandler;
  inFlight: number;
  revoked: boolean;
  revocation: AbortController;
  pins: Set<() => void>;
  onDrained: Array<() => void>;
  owner: HostServiceOwnerIdentity;
  providerId: string;
  providerKey: string;
  status: "active" | "candidate" | "draining";
}

const implementationKey = (owner: HostServiceOwnerIdentity): string => `${owner.extensionId}\0${owner.entrypointId}`;
const ownerKey = (owner: HostServiceOwnerIdentity): string => `${implementationKey(owner)}\0${owner.instanceKey}`;
const exactOwnerKey = (owner: HostServiceOwnerIdentity): string => `${ownerKey(owner)}\0${owner.generation}`;
const serviceKey = (id: string, version: number): string => `${id}@${version}`;

const freezeDescriptor = (descriptor: VarinExtensionServiceProvision): VarinExtensionServiceProvision => {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  };
  const parsed = parseVarinExtensionServiceProvision(descriptor);
  freeze(parsed);
  return parsed;
};

const assertJsonValue = (value: unknown): JsonValue => parseVarinToolJson(value, "Host service result");

export class HostServiceRegistry {
  readonly hostId: string;
  readonly #listeners = new Set<() => void>();
  readonly #providers = new Map<string, ActiveProvider>();
  readonly #activeByService = new Map<string, readonly ActiveProvider[]>();
  readonly #ownerLifetimes = new Map<string, { composition: VarinHostServiceComposition | null; onUnused?: () => void }>();
  readonly #replacements = new Map<string, { owner: HostServiceOwnerIdentity; provisions: readonly { descriptor: VarinExtensionServiceProvision }[] }>();
  #revision = 0;

  constructor(hostId: string) {
    this.hostId = hostId;
  }

  getSnapshot = (): VarinExtensionServiceCatalogSnapshot => ({
    hostId: this.hostId,
    providers: [...this.#providers.values()]
      .map<VarinExtensionServiceProviderSnapshot>((provider) => ({
        descriptor: { ...provider.descriptor },
        entrypointId: provider.owner.entrypointId,
        extensionId: provider.owner.extensionId,
        extensionVersion: provider.owner.extensionVersion,
        generation: provider.owner.generation,
        instanceKey: provider.owner.instanceKey,
        providerId: provider.providerId,
        providerKey: provider.providerKey,
        status: provider.status,
      }))
      .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id)
        || left.descriptor.version - right.descriptor.version
        || left.providerId.localeCompare(right.providerId)),
    revision: this.#revision,
  });

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  prepareOwnerReplacement(owner: HostServiceOwnerIdentity, provisions: readonly HostServiceProvision[], options: {
    composition?: VarinHostServiceComposition | null;
    onUnused?: () => void;
    previousOwners?: readonly HostServiceOwnerIdentity[];
    candidate?: boolean;
  } = {}): {
    commit(): void;
    finalize(): Promise<void>;
    rollback(): Promise<void>;
  } {
    const normalized = this.#normalizeProvisions(provisions);
    this.#validateReplacement(owner, normalized);
    const reservationKey = exactOwnerKey(owner);
    this.#replacements.set(reservationKey, { owner, provisions: normalized });
    let committed = false;
    let finalized = false;
    let previousProviders: ActiveProvider[] = [];
    let nextProviders: ActiveProvider[] = [];
    return {
      commit: () => {
        if (committed) return;
        this.#validateReplacement(owner, normalized);
        // Already-draining generations belong to their original retirement. A long-lived
        // pin on A must not delay unpinned B's cleanup when B is subsequently replaced by C.
        previousProviders = [...this.#providers.values()].filter((provider) => (
          (options.previousOwners ? options.previousOwners.some(previous => exactOwnerKey(previous) === exactOwnerKey(provider.owner))
            : ownerKey(provider.owner) === ownerKey(owner)) && provider.status === "active"
        ));

        for (const provider of previousProviders) provider.status = "draining";
        nextProviders = normalized.map((provision) => this.#createProvider(owner, provision));
        for (const provider of nextProviders) { if (options.candidate) provider.status = 'candidate'; this.#providers.set(provider.providerId, provider); }
        this.#ownerLifetimes.set(exactOwnerKey(owner), { composition: options.composition ?? null,
          ...(options.onUnused ? { onUnused: options.onUnused } : {}) });
        committed = true;
        this.#replacements.delete(reservationKey);
        this.#publish();
      },
      finalize: async () => {
        if (!committed || finalized) return;
        await this.#waitForProviders(previousProviders);
        for (const provider of previousProviders) this.#providers.delete(provider.providerId);
        finalized = true;
        if (previousProviders.length > 0) this.#publish();
      },
      rollback: async () => {
        this.#replacements.delete(reservationKey);
        if (!committed || finalized) return;
        for (const provider of nextProviders) provider.status = "draining";
        this.#publish();
        await this.#waitForProviders(nextProviders);
        for (const provider of nextProviders) this.#providers.delete(provider.providerId);
        for (const provider of previousProviders) {
          provider.status = "active";
          this.#providers.set(provider.providerId, provider);
        }
        committed = false;
        this.#publish();
      },
    };
  }

  async replaceOwner(owner: HostServiceOwnerIdentity, provisions: readonly HostServiceProvision[]): Promise<void> {
    const replacement = this.prepareOwnerReplacement(owner, provisions);
    replacement.commit();
    await replacement.finalize();
  }

  #normalizeProvisions(provisions: readonly HostServiceProvision[]): Array<{
    descriptor: VarinExtensionServiceProvision;
    handler: HostServiceHandler;
  }> {
    const normalized = provisions.map((provision) => ({
      descriptor: freezeDescriptor(provision.descriptor),
      handler: provision.handler,
    }));
    const ownKeys = new Set<string>();
    for (const provision of normalized) {
      const key = serviceKey(provision.descriptor.id, provision.descriptor.version);
      if (ownKeys.has(key)) throw new Error(`Host owner provides a service more than once: ${key}`);
      ownKeys.add(key);
    }
    return normalized;
  }

  #validateReplacement(
    owner: HostServiceOwnerIdentity,
    provisions: readonly { descriptor: VarinExtensionServiceProvision }[],
  ): void {
    const otherProviders = [...this.#providers.values()].filter((provider) => (
      implementationKey(provider.owner) !== implementationKey(owner) && provider.status === "active"
    ));
    for (const reservation of this.#replacements.values()) {
      if (implementationKey(reservation.owner) === implementationKey(owner)) continue;
      for (const provision of reservation.provisions) {
        for (const proposed of provisions) {
          if (serviceKey(provision.descriptor.id, provision.descriptor.version) === serviceKey(proposed.descriptor.id, proposed.descriptor.version)
            && (provision.descriptor.multiple !== true || proposed.descriptor.multiple !== true)) {
            throw new Error(`Host service ${serviceKey(provision.descriptor.id, provision.descriptor.version)} has a pending exclusive provider`);
          }
        }
      }
    }
    for (const provision of provisions) {
      const key = serviceKey(provision.descriptor.id, provision.descriptor.version);
      const existing = otherProviders.filter((provider) => serviceKey(provider.descriptor.id, provider.descriptor.version) === key);
      if (existing.length > 0 && (provision.descriptor.multiple !== true || existing.some((provider) => provider.descriptor.multiple !== true))) {
        throw new Error(`Host service ${key} does not allow multiple providers`);
      }
    }
  }

  #createProvider(
    owner: HostServiceOwnerIdentity,
    provision: { descriptor: VarinExtensionServiceProvision; handler: HostServiceHandler },
  ): ActiveProvider {
    const providerId = `${owner.extensionId}:${owner.entrypointId}:${owner.generation}:${serviceKey(provision.descriptor.id, provision.descriptor.version)}`;
    const providerKey = `${owner.extensionId}:${owner.entrypointId}:${serviceKey(provision.descriptor.id, provision.descriptor.version)}`;
    return {
      descriptor: provision.descriptor,
      handler: provision.handler,
      inFlight: 0,
      revoked: false,
      revocation: new AbortController(),
      pins: new Set(),
      onDrained: [],
      owner: { ...owner },
      providerId,
      providerKey,
      status: "active",
    };
  }

  async #waitForProviders(providers: readonly ActiveProvider[]): Promise<void> {
    await Promise.all(providers.map((provider) => provider.inFlight === 0
      ? Promise.resolve()
      : new Promise<void>((resolveDrain) => provider.onDrained.push(resolveDrain))));
  }

  /** Close admission synchronously, before an owner queue can wait for a retired exchange.
   * Revoke retained older generations too, but never a newer owner from stale teardown. */
  revokeOwner(owner: HostServiceOwnerIdentity): void {
    let changed = false;
    for (const provider of this.#providers.values()) {
      if (ownerKey(provider.owner) !== ownerKey(owner) || provider.owner.generation > owner.generation) continue;
      if (!provider.revoked || provider.status !== "draining") changed = true;
      this.#revokeProvider(provider);
      provider.status = "draining";
    }
    if (changed) this.#publish();
  }

  /** After revocation drops exchange pins, remaining ownership represents unsettled callbacks. */
  hasPendingOwnerCalls(owner: HostServiceOwnerIdentity): boolean {
    return [...this.#providers.values()].some(provider => exactOwnerKey(provider.owner) === exactOwnerKey(owner) && provider.inFlight > 0);
  }

  async drainOwner(owner: HostServiceOwnerIdentity): Promise<void> {
    this.revokeOwner(owner);
    const providers = [...this.#providers.values()].filter((provider) => (
      ownerKey(provider.owner) === ownerKey(owner) && provider.owner.generation <= owner.generation
    ));
    await this.#waitForProviders(providers);
  }

  removeOwner(owner: HostServiceOwnerIdentity): void {
    let changed = false;
    const removed = new Set<string>();
    for (const [providerId, provider] of [...this.#providers]) {
      if (exactOwnerKey(provider.owner) !== exactOwnerKey(owner)) continue;
      this.#revokeProvider(provider);
      this.#providers.delete(providerId);
      removed.add(providerId);
      changed = true;
    }
    this.#ownerLifetimes.delete(exactOwnerKey(owner));
    if (changed) this.#publish();
  }

  /** Normal retirement closes new unbound admission but preserves real retained references. */
  retireOwner(owner: HostServiceOwnerIdentity): Promise<void> {
    const providers = [...this.#providers.values()].filter(provider => exactOwnerKey(provider.owner) === exactOwnerKey(owner));
    for (const provider of providers) provider.status = 'draining';
    if (providers.length) this.#publish();
    return this.#waitForProviders(providers);
  }

  publishOwner(owner: HostServiceOwnerIdentity): void {
    for (const provider of this.#providers.values()) if (exactOwnerKey(provider.owner) === exactOwnerKey(owner) && !provider.revoked) provider.status = 'active';
    this.#publish();
  }

  bindPrepared(serviceId: string, version: number, providerId: string): HostServiceBinding {
    return this.#bind(serviceId, version, providerId, 'prepared');
  }

  ownerInUse(owner: HostServiceOwnerIdentity): boolean {
    return [...this.#providers.values()].some(provider => exactOwnerKey(provider.owner) === exactOwnerKey(owner) && provider.inFlight > 0);
  }

  /** Bind after scoped routing/preparation. Only the affected service's index is consulted. */
  bind(serviceId: string, version: number, providerId?: string): HostServiceBinding {
    return this.#bind(serviceId, version, providerId, false);
  }

  /** Pure current-admission check, never a preparation lease. */
  assertBinding(serviceId: string, version: number, providerId: string): void {
    const provider = this.#providers.get(providerId);
    if (!provider || provider.revoked || provider.status !== 'active'
      || serviceKey(provider.descriptor.id, provider.descriptor.version) !== serviceKey(serviceId, version)) {
      throw new HostServiceBindingError('selected_unavailable', `Host service provider is unavailable: ${providerId}`);
    }
  }

  /** Derive an independent exchange from an already pinned exact generation. This never
   * revives an unretained retired provider or relaxes explicit revocation. */
  bindPinned(serviceId: string, version: number, providerId: string): HostServiceBinding {
    return this.#bind(serviceId, version, providerId, true);
  }

  #bind(serviceId: string, version: number, providerId: string | undefined, retained: boolean | 'prepared'): HostServiceBinding {
    const key = serviceKey(serviceId, version);
    const selected = providerId;
    const matches = this.#activeByService.get(key) ?? [];
    const provider = selected ? this.#providers.get(selected) : matches.length === 1 ? matches[0] : undefined;
    if (!provider || (provider.status !== "active" && !(retained === "prepared" && provider.status === "candidate") && (!retained || provider.pins.size === 0)) || provider.revoked || serviceKey(provider.descriptor.id, provider.descriptor.version) !== key) {
      throw new HostServiceBindingError(selected ? "selected_unavailable" : matches.length > 1 ? "ambiguous" : "missing",
        `Host service provider is unavailable or ambiguous: ${key}`);
    }
    const available = (pinned: boolean): void => {
      if (provider.revoked || this.#providers.get(provider.providerId) !== provider || (!pinned && provider.status !== "active")) {
        throw new HostServiceBindingError(provider.revoked || this.#providers.get(provider.providerId) !== provider
          ? "binding_revoked" : "binding_retired", `Bound Host service provider is no longer available: ${provider.providerId}`);
      }
    };
    provider.inFlight += 1;
    let released = false;
    const release = () => { if (released) return; released = true; provider.pins.delete(release); this.#releaseProvider(provider); };
    provider.pins.add(release);
    const assertLease = () => { if (released) throw new HostServiceBindingError('binding_retired', 'Host service lease has been released'); available(true); };
    return Object.freeze({
      composition: this.#ownerLifetimes.get(exactOwnerKey(provider.owner))?.composition ?? null,
      assertAvailable: assertLease,
      release,
      providerId: provider.providerId,
      providerKey: provider.providerKey,
      descriptor: Object.freeze({ ...provider.descriptor }),
      invoke: async (method: string, args: JsonValue[], signal?: AbortSignal) => {
        assertLease(); available(retained === 'prepared');
        return this.#invokeProvider(provider, method, args, signal);
      },
      pin: () => {
        assertLease();
        provider.inFlight += 1;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          provider.pins.delete(release);
          this.#releaseProvider(provider);
        };
        provider.pins.add(release);
        return Object.freeze({
          providerId: provider.providerId,
          revocationSignal: provider.revocation.signal,
          assertAvailable: () => {
            if (released) throw new Error("Host service exchange pin has been released");
            available(true);
          },
          invoke: async (method: string, args: JsonValue[], signal?: AbortSignal, invocation?: HostInvocationScope) => {
            if (released) throw new Error("Host service exchange pin has been released");
            available(true);
            return this.#invokeProvider(provider, method, args, signal, invocation);
          },
          release,
        });
      },
    });
  }

  async invoke(requestValue: VarinExtensionServiceInvocationRequest | unknown, signal?: AbortSignal): Promise<JsonValue> {
    const request = parseVarinExtensionServiceInvocationRequest(requestValue);
    const binding = this.bind(request.serviceId, request.version, request.providerId);
    try { return await binding.invoke(request.method, request.args, signal); } finally { binding.release(); }
  }

  async #invokeProvider(provider: ActiveProvider, method: string, args: JsonValue[], signal?: AbortSignal, invocation?: HostInvocationScope): Promise<JsonValue> {
    if (signal?.aborted) throw signal.reason ?? new Error("Host service invocation cancelled");
    const callSignal = signal
      ? AbortSignal.any([signal, provider.revocation.signal])
      : provider.revocation.signal;
    callSignal.throwIfAborted();
    provider.inFlight += 1;
    try {
      // This is the worker boundary. Typed native callers never enter this JSON contract.
      return assertJsonValue(await provider.handler(method, args, { signal: callSignal, ...(invocation ? { invocation } : {}) }));
    } finally {
      this.#releaseProvider(provider);
    }
  }

  #revokeProvider(provider: ActiveProvider): void {
    provider.revoked = true;
    provider.revocation.abort(new HostServiceBindingError("binding_revoked", `Host service binding was revoked: ${provider.providerId}`));
    for (const release of [...provider.pins]) release();
  }

  #releaseProvider(provider: ActiveProvider): void {
    provider.inFlight -= 1;
    if (provider.inFlight === 0) {
      for (const resolveDrain of provider.onDrained.splice(0)) resolveDrain();
      if (!this.ownerInUse(provider.owner)) this.#ownerLifetimes.get(exactOwnerKey(provider.owner))?.onUnused?.();
    }
  }

  #publish(): void {
    this.#activeByService.clear();
    for (const provider of this.#providers.values()) {
      if (provider.status !== "active" || provider.revoked) continue;
      const key = serviceKey(provider.descriptor.id, provider.descriptor.version);
      this.#activeByService.set(key, [...(this.#activeByService.get(key) ?? []), provider]);
    }
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }
}
