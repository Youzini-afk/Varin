import {
  isVarinExtensionId,
  parseVarinExtensionServiceInvocationRequest,
  parseVarinExtensionServiceProvision,
  parseVarinToolJson,
  type JsonValue,
  type VarinExtensionServiceCatalogSnapshot,
  type VarinExtensionServiceInvocationRequest,
  type VarinExtensionServiceProviderSnapshot,
  type VarinExtensionServiceProvision,
  type VarinExtensionServiceRequirement,
} from "@varin/extension-contract";

export interface HostServiceOwnerIdentity {
  entrypointId: string;
  extensionId: string;
  extensionVersion: string;
  generation: number;
}

/** Trusted Host-only authority. Only an opaque reference may cross an extension worker boundary. */
export interface HostInvocationScope {
  readonly id: string;
  readonly value: unknown;
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
  status: "active" | "draining";
}

const ownerKey = (owner: HostServiceOwnerIdentity): string => `${owner.extensionId}\0${owner.entrypointId}`;
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
  readonly #selections = new Map<string, string>();
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
        providerId: provider.providerId,
        providerKey: provider.providerKey,
        status: provider.status,
      }))
      .sort((left, right) => left.descriptor.id.localeCompare(right.descriptor.id)
        || left.descriptor.version - right.descriptor.version
        || left.providerId.localeCompare(right.providerId)),
    revision: this.#revision,
    selections: Object.fromEntries(this.#selections),
  });

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  prepareOwnerReplacement(owner: HostServiceOwnerIdentity, provisions: readonly HostServiceProvision[]): {
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
    const changedSelections = new Map<string, { previous: string; next: string | undefined }>();
    return {
      commit: () => {
        if (committed) return;
        this.#validateReplacement(owner, normalized);
        previousProviders = [...this.#providers.values()].filter((provider) => ownerKey(provider.owner) === ownerKey(owner));

        for (const provider of previousProviders) provider.status = "draining";
        nextProviders = normalized.map((provision) => this.#createProvider(owner, provision));
        for (const provider of nextProviders) this.#providers.set(provider.providerId, provider);
        for (const previous of previousProviders) {
          const key = serviceKey(previous.descriptor.id, previous.descriptor.version);
          if (this.#selections.get(key) !== previous.providerId) continue;
          const replacement = nextProviders.find((provider) => serviceKey(provider.descriptor.id, provider.descriptor.version) === key);
          changedSelections.set(key, { previous: previous.providerId, next: replacement?.providerId });
          if (replacement) this.#selections.set(key, replacement.providerId);
          else this.#selections.delete(key);
        }
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
        for (const [key, selection] of changedSelections) {
          if (this.#selections.get(key) === selection.next) this.#selections.set(key, selection.previous);
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
      ownerKey(provider.owner) !== ownerKey(owner) && provider.status === "active"
    ));
    for (const reservation of this.#replacements.values()) {
      if (ownerKey(reservation.owner) === ownerKey(owner)) continue;
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
    for (const [key, providerId] of [...this.#selections]) {
      if (removed.has(providerId)) this.#selections.delete(key);
    }
    if (changed) this.#publish();
  }

  setSelection(id: string, version: number, providerId: string | null): void {
    if (!isVarinExtensionId(id) || !Number.isSafeInteger(version) || version <= 0) {
      throw new Error(`Invalid Host service selection: ${id}@${version}`);
    }
    const key = serviceKey(id, version);
    if (providerId === null) this.#selections.delete(key);
    else {
      const provider = this.#providers.get(providerId);
      if (!provider || provider.status !== "active" || provider.revoked || serviceKey(provider.descriptor.id, provider.descriptor.version) !== key) {
        throw new Error(`Selected Host service provider is unavailable: ${providerId}`);
      }
      this.#selections.set(key, providerId);
    }
    this.#publish();
  }

  providersFor(requirement: VarinExtensionServiceRequirement): VarinExtensionServiceProviderSnapshot[] {
    const matches = this.getSnapshot().providers.filter((provider) => (
      provider.status === "active"
      && provider.descriptor.id === requirement.id
      && provider.descriptor.version === requirement.version
    ));
    if (requirement.binding === "all") return matches;
    if (requirement.binding === "selected") {
      const selected = this.#selections.get(serviceKey(requirement.id, requirement.version));
      return selected ? matches.filter((provider) => provider.providerId === selected) : [];
    }
    return matches.length === 1 ? matches : [];
  }

  /** Bind after scoped routing/preparation. Only the affected service's index is consulted. */
  bind(serviceId: string, version: number, providerId?: string): HostServiceBinding {
    return this.#bind(serviceId, version, providerId, false);
  }

  /** Derive an independent exchange from an already pinned exact generation. This never
   * revives an unretained retired provider or relaxes explicit revocation. */
  bindPinned(serviceId: string, version: number, providerId: string): HostServiceBinding {
    return this.#bind(serviceId, version, providerId, true);
  }

  #bind(serviceId: string, version: number, providerId: string | undefined, retained: boolean): HostServiceBinding {
    const key = serviceKey(serviceId, version);
    const selected = providerId ?? this.#selections.get(key);
    const matches = this.#activeByService.get(key) ?? [];
    const provider = selected ? this.#providers.get(selected) : matches.length === 1 ? matches[0] : undefined;
    if (!provider || (provider.status !== "active" && (!retained || provider.pins.size === 0)) || provider.revoked || serviceKey(provider.descriptor.id, provider.descriptor.version) !== key) {
      throw new HostServiceBindingError(selected ? "selected_unavailable" : matches.length > 1 ? "ambiguous" : "missing",
        `Host service provider is unavailable or ambiguous: ${key}`);
    }
    const available = (pinned: boolean): void => {
      if (provider.revoked || this.#providers.get(provider.providerId) !== provider || (!pinned && provider.status !== "active")) {
        throw new HostServiceBindingError(provider.revoked || this.#providers.get(provider.providerId) !== provider
          ? "binding_revoked" : "binding_retired", `Bound Host service provider is no longer available: ${provider.providerId}`);
      }
    };
    return Object.freeze({
      providerId: provider.providerId,
      providerKey: provider.providerKey,
      descriptor: Object.freeze({ ...provider.descriptor }),
      invoke: async (method: string, args: JsonValue[], signal?: AbortSignal) => {
        available(false);
        return this.#invokeProvider(provider, method, args, signal);
      },
      pin: () => {
        available(retained && provider.pins.size > 0);
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
    return this.bind(request.serviceId, request.version, request.providerId).invoke(request.method, request.args, signal);
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
