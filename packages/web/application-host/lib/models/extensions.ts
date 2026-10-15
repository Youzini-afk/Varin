/** Product model contributions, held by the existing extension composition and service pins. */
import { createHash, randomUUID } from 'node:crypto';
import {
  HostServiceBindingError, type ApplicationExtensionRuntime, type HostServiceBinding, type HostServicePin,
} from '@varin/extension-host';
import {
  VARIN_MODELS_SERVICE_ID, VARIN_MODELS_VERSION, VARIN_MODEL_AUTHENTICATION_CAPABILITY,
  parseVarinModelsDescription, parseVarinModelAuthenticationResult, canonicalServiceComposition,
  type JsonValue, type ModelProtocolCall, type ModelProtocolResult, type VarinModelAuthenticationDescription,
  type VarinModelAuthenticationCall, type VarinExtensionServiceProviderSnapshot,
} from '@varin/extension-contract';
import type { ModelsService } from './service.js';
import { BUILTIN_CHANNEL_TYPES, type ChannelType } from './channel-types.js';
import type { ModelOAuthProvider } from './oauth.js';
import type { OAuthProvider } from './credentials.js';
export interface ModelAdapterContribution {
  id: string; version: string; protocolFamily: string; bindingId: string; identity: string; headers: Record<string, string>;
}
export interface ModelAdaptersOwner {
  publish(input: { expectedRevision: number; adapters: ModelAdapterContribution[] }): Promise<{ revision: number }>;
  revoke(bindingId: string): Promise<void>;
  retain(bindingId: string, leaseId: string): Promise<void>;
  release(leaseId: string): Promise<void>;
}
interface ProtocolBinding { adapter: string; metadata: string; pin: HostServicePin; removeRevocation(): void }
interface AuthenticationBinding { description: VarinModelAuthenticationDescription; provider: VarinExtensionServiceProviderSnapshot; binding: HostServiceBinding; pins: Set<HostServicePin>; active: boolean }
const unavailable = () => new Error('The selected model extension is unavailable');
export class ModelsExtensionOwner {
  readonly #protocols = new Map<string, ProtocolBinding>();
  #authentication: AuthenticationBinding[] = [];
  #active: HostServiceBinding[] = [];
  #revision = 0;
  #signature: string | undefined;
  #refresh: Promise<void> | undefined;
  #dirty = false;
  #closed = false;
  #connected = true;
  #epoch = new AbortController();
  readonly #calls = new Set<Promise<ModelProtocolResult>>();
  #unwatch: (() => void) | undefined;
  #unregisterAuthentication: (() => void) | undefined;
  readonly #stop = new AbortController();
  constructor(readonly runtime: ApplicationExtensionRuntime, readonly models: ModelsService,
    readonly adapters: ModelAdaptersOwner, readonly fetchImpl: typeof fetch = globalThis.fetch) {}
  async start() {
    if (this.#closed) throw unavailable();
    if (!this.#unregisterAuthentication) this.#unregisterAuthentication = this.runtime.capabilities.register(VARIN_MODEL_AUTHENTICATION_CAPABILITY,
      async (method, raw, context) => {
        if (method !== 'request' || !raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid model authentication capability request');
        const input = raw as { provider?: unknown; url?: unknown; encoding?: unknown; body?: unknown };
        if (Object.keys(input).some(key => !['provider', 'url', 'encoding', 'body'].includes(key)) || typeof input.provider !== 'string'
          || typeof input.url !== 'string' || !['form', 'json'].includes(String(input.encoding)) || !input.body || typeof input.body !== 'object'
          || Array.isArray(input.body) || !Object.values(input.body).every(value => typeof value === 'string')) throw new Error('Invalid model authentication HTTP request');
        const selected = this.#authentication.find(value => value.description.id === input.provider && value.provider.extensionId === context.owner.extensionId
          && value.provider.instanceKey === context.owner.instanceKey && value.provider.generation === context.owner.generation);
        if (!selected || !selected.description.endpoints?.includes(input.url)) throw new Error('Model authentication endpoint is not granted');
        if (selected.pins.size) [...selected.pins][0]!.assertAvailable(); else selected.binding.assertAvailable();
        const response = await this.fetchImpl(input.url, { method: 'POST', signal: context.signal, redirect: 'manual',
          headers: { accept: 'application/json', 'content-type': input.encoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded' },
          body: input.encoding === 'json' ? JSON.stringify(input.body) : new URLSearchParams(input.body as Record<string, string>) });
        if (!response.ok) throw new Error(`Model authentication request failed (${response.status})`);
        return await response.json() as JsonValue;
      });
    this.#unwatch ??= this.runtime.subscribe(() => { if (this.#connected) { this.#dirty = true; void this.refresh().catch(() => {}); } });
    await this.refresh();
  }
  refresh(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#closed || !this.#connected) return Promise.reject(unavailable());
    this.#dirty = true;
    if (!this.#refresh) {
      this.#refresh = (async () => {
        while (this.#dirty && !this.#closed && this.#connected) {
          this.#dirty = false;
          try { await this.#prepare(AbortSignal.any([this.#stop.signal, this.#epoch.signal])); }
          catch (error) { this.models.contributionIssue('Model extensions could not be prepared. Check extension availability and permissions.'); throw error; }
        }
      })().finally(() => { this.#refresh = undefined; });
    }
    // A caller's cancelled observation never cancels shared publication or releases its pins.
    return this.#refresh;
  }
  async #prepare(signal: AbortSignal) {
    const request = { serviceId: VARIN_MODELS_SERVICE_ID, version: VARIN_MODELS_VERSION, method: 'describe', args: [], routing: { userId: 'default' } };
    let resolved;
    try { resolved = await this.runtime.resolveServiceCompositions(request, { collection: true, signal }); }
    catch (error) { if (!(error instanceof HostServiceBindingError) || error.code !== 'missing') throw error; resolved = { services: [], routingRevision: 0 }; }
    const signature = () => canonicalServiceComposition({ services: resolved.services,
      providers: resolved.services.map(service => this.runtime.services.getSnapshot().providers
        .filter(provider => provider.status === 'active' && provider.providerKey === service.providerKey).map(provider => provider.providerId)) });
    if (signature() === this.#signature) return;
    const prepared = resolved.services.length ? await this.runtime.prepareServiceCollection(request, { expectedRoutingRevision: resolved.routingRevision, signal }) : { bindings: [] };
    const bindings = [...prepared.bindings];
    const protocols: ModelAdapterContribution[] = [], authentication: AuthenticationBinding[] = [], types: ChannelType[] = [], oauth: ModelOAuthProvider[] = [];
    const staged: string[] = [];
    try {
      const catalog = await this.runtime.catalog.snapshot();
      for (const binding of bindings) {
        const description = parseVarinModelsDescription(await binding.invoke('describe', [], signal));
        binding.assertAvailable();
        const provider = this.runtime.services.getSnapshot().providers.find(provider => provider.providerId === binding.providerId);
        if (!provider || !binding.composition) throw unavailable();
        const entry = catalog.extensions.find(entry => entry.manifest.id === provider.extensionId);
        if (description.authentication.length && !entry?.capabilityGrants.some(grant => grant.realm === 'host' && grant.granted
          && grant.manifestVersion === provider.extensionVersion && grant.capability === VARIN_MODEL_AUTHENTICATION_CAPABILITY)) throw new Error('Model authentication capability is not granted');
        for (const adapter of description.adapters) {
          const identity = createHash('sha256').update(canonicalServiceComposition({ composition: binding.composition, adapter })).digest('hex');
          const metadata = canonicalServiceComposition({ adapter, identity });
          const previous = [...this.#protocols].find(([, value]) => value.pin.providerId === binding.providerId
            && value.adapter === adapter.id && value.metadata === metadata && !value.pin.revocationSignal.aborted);
          if (previous) { previous[1].pin.assertAvailable(); protocols.push({ ...adapter, identity, bindingId: previous[0] }); continue; }
          const bindingId = randomUUID(), pin = binding.pin();
          const revoke = () => { void this.adapters.revoke(bindingId).catch(() => {}); };
          pin.revocationSignal.addEventListener('abort', revoke, { once: true });
          this.#protocols.set(bindingId, { adapter: adapter.id, metadata, pin, removeRevocation: () => pin.revocationSignal.removeEventListener('abort', revoke) });
          staged.push(bindingId); protocols.push({ ...adapter, identity, bindingId });
        }
        for (const channel of description.channels) if (!channel.adapter) {
          const implemented = new Set(BUILTIN_CHANNEL_TYPES.filter(type => type.protocol === channel.protocol).flatMap(type => type.operations));
          if (channel.operations.some(operation => !implemented.has(operation))) throw new Error('Channel contribution has no implementation for a declared operation');
        }
        types.push(...description.channels.map(({ adapter, ...channel }) => {
          const protocol = adapter && protocols.find(value => value.id === adapter.id)!;
          const bindingId = protocol?.bindingId;
          return { ...channel, discovery: channel.catalog !== undefined,
            ...(adapter && bindingId ? { adapter: { ...adapter, bindingId, identity: protocol!.identity, capture: async () => {
              if (this.#closed || !this.#connected) throw unavailable();
              const leaseId = randomUUID();
              try { await this.adapters.retain(bindingId, leaseId); }
              catch (error) { await this.adapters.release(leaseId).catch(() => {}); throw error; }
              let released = false;
              return () => { if (!released) { released = true; void this.adapters.release(leaseId).catch(() => {}); } };
            } } } : {}) };
        }));
        for (const auth of description.authentication) {
          const registration = { description: auth, provider, binding, pins: new Set<HostServicePin>(), active: true };
          authentication.push(registration);
          oauth.push(this.#oauth(registration));
        }
      }
      const commit = this.models.prepareContributions(types, oauth);
      signal.throwIfAborted(); bindings.forEach(binding => binding.assertAvailable());
      const publication = await this.adapters.publish({ expectedRevision: this.#revision, adapters: protocols });
      // Publication is the only asynchronous commit boundary. No cancelled observation discards
      // a successful registry publication or mistakes its already-held pins for unaccepted work.
      signal.throwIfAborted();
      this.#revision = publication.revision;
      for (const id of staged) if (this.#protocols.get(id)?.pin.revocationSignal.aborted) void this.adapters.revoke(id).catch(() => {});
      commit();
      const previous = this.#active; this.#active = bindings;
      this.#authentication.forEach(value => { value.active = false; });
      this.#authentication = [...this.#authentication.filter(value => value.pins.size), ...authentication]; this.#signature = signature();
      previous.forEach(binding => binding.release());
    } catch (error) {
      staged.forEach(id => this.release(id)); bindings.forEach(binding => binding.release()); throw error;
    }
  }
  #oauth(registration: AuthenticationBinding): ModelOAuthProvider {
    const { description, binding } = registration;
    const retain = () => {
      const held = this.runtime.services.bindPinned(VARIN_MODELS_SERVICE_ID, VARIN_MODELS_VERSION, binding.providerId);
      const pin = held.pin(); held.release(); registration.pins.add(pin);
      let released = false;
      return { pin, release: () => {
        if (released) return; released = true; registration.pins.delete(pin); pin.release();
        if (!registration.active && !registration.pins.size) this.#authentication = this.#authentication.filter(value => value !== registration);
      } };
    };
    const headers: OAuthProvider['headers'] = value => ({ [description.header]: `${description.prefix}${value.accessToken}` });
    const invoke = async (pin: HostServicePin, input: VarinModelAuthenticationCall, signal?: AbortSignal) => {
      pin.assertAvailable();
      return parseVarinModelAuthenticationResult(await pin.invoke('authenticate', [input as unknown as JsonValue], signal));
    };
    const capture = (): { provider: OAuthProvider; release(): void } => {
      const held = retain(), pin = held.pin;
      return { provider: { capture, headers: token => { pin.assertAvailable(); return headers(token); }, refresh: async token => {
        const result = await invoke(pin, { kind: 'refresh', provider: description.id, token });
        if (result.kind !== 'token') throw new Error('Model account refresh did not return a token'); return result.token;
      } }, release: held.release };
    };
    const captureLogin: NonNullable<ModelOAuthProvider['captureLogin']> = () => {
      const held = retain(), pin = held.pin;
      return {
        release: held.release,
        login: async prompt => {
          prompt.signal.throwIfAborted();
          const begin = await invoke(pin, { kind: 'begin', provider: description.id }, prompt.signal);
          if (begin.kind !== 'pending') throw new Error('Model account sign-in did not return an authorization URL');
          prompt.showAuthorizationUrl(new URL(begin.authorizationUrl));
          const redirect = await prompt.promptForRedirectUrl(prompt.signal); prompt.signal.throwIfAborted();
          if (!redirect) throw new Error('Model account sign-in cancelled');
          const result = await invoke(pin, { kind: 'complete', provider: description.id, state: begin.state, redirect }, prompt.signal);
          if (result.kind !== 'token') throw new Error('Model account sign-in did not return a token'); return result.token;
        },
      };
    };
    return { id: description.id, name: description.name, capture, captureLogin, headers,
      refresh: async token => { const held = capture(); try { return await held.provider.refresh(token); } finally { held.release(); } },
      login: async prompt => {
        const held = captureLogin(); try { return await held.login(prompt); } finally { held.release(); }
      },
    };
  }
  protocol(bindingId: string, call: ModelProtocolCall, signal: AbortSignal): Promise<ModelProtocolResult> {
    const binding = this.#protocols.get(bindingId);
    if (!binding || this.#closed || !this.#connected) return Promise.reject(unavailable());
    binding.pin.assertAvailable();
    // Await actual completion, including cancellation. Rust parses this typed result and owns
    // the original operation; a Host promise race must not manufacture executor termination.
    const pending = binding.pin.invoke('protocol', [{ adapter: binding.adapter, call } as unknown as JsonValue],
      AbortSignal.any([signal, this.#epoch.signal])).then(value => value as unknown as ModelProtocolResult);
    this.#calls.add(pending);
    void pending.then(() => this.#calls.delete(pending), () => this.#calls.delete(pending));
    return pending;
  }
  release(bindingId: string) {
    const binding = this.#protocols.get(bindingId); if (!binding) return;
    this.#protocols.delete(bindingId); binding.removeRevocation(); binding.pin.release();
  }
  #retireContributions() {
    this.models.prepareContributions([], [])();
    this.#active.forEach(binding => binding.release()); this.#active = [];
    this.#authentication.forEach(value => { value.active = false; });
    this.#authentication = this.#authentication.filter(value => value.pins.size);
  }
  async kernelDisconnected() {
    this.#connected = false; this.#epoch.abort(unavailable());
    await this.#refresh?.catch(() => {});
    await Promise.allSettled([...this.#calls]);
    for (const id of this.#protocols.keys()) this.release(id);
    this.#retireContributions(); this.#revision = 0; this.#signature = undefined;
  }
  kernelReady() {
    if (this.#closed) return Promise.reject(unavailable());
    if (!this.#connected) { this.#connected = true; this.#epoch = new AbortController(); }
    return this.refresh();
  }
  async close() {
    if (this.#closed) return; this.#closed = true; this.#stop.abort(); this.#epoch.abort(); this.#unwatch?.();
    await this.#refresh?.catch(() => {});
    await Promise.allSettled([...this.#protocols.keys()].map(id => this.adapters.revoke(id)));
    await Promise.allSettled([...this.#calls]);
    for (const id of this.#protocols.keys()) this.release(id);
    this.#retireContributions(); this.#unregisterAuthentication?.();
  }
}
