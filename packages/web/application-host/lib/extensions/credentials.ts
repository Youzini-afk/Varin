/** Scoped access to the existing Host credential and authorization owners. */
import { createHash, randomUUID } from 'node:crypto';
import type { ApplicationExtensionRuntime, HostCapabilityCallContext, HostInvocationScope, HostServiceOwnerIdentity } from '@varin/extension-host';
import { VARIN_CREDENTIALS_CAPABILITY, parseVarinCredentialAuthenticationResult,
  type JsonValue, type VarinCredentialAdapter, type VarinCredentialAuthenticationCall } from '@varin/extension-contract';
import { HostCredentialService, type OAuthRefreshProvider } from '../credentials/service.js';
import { AuthorizationFlows } from '../authorization-flows.js';
import { bindPluginInvocationPrincipal, requirePluginPrincipal } from './invocation-principal.js';
const invalid = () => new Error('Plugin credential request is unavailable or invalid');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export class PluginCredentialCapability {
  readonly #listeners = new Set<(identity: { principalId: string; extensionId: string; connectionId: string }) => void>();
  subscribe(listener: (identity: { principalId: string; extensionId: string; connectionId: string }) => void): () => void {
    this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  #changed(principalId: string, extensionId: string, connectionId: string): void {
    for (const listener of this.#listeners) listener({ principalId, extensionId, connectionId });
  }
  readonly #authentication = new WeakMap<HostInvocationScope, { owner: HostServiceOwnerIdentity; assertAvailable(): void }>();
  readonly #discovery = new WeakSet<HostInvocationScope>();
  /** Listing connections cannot resolve secrets or mutate credentials as a side effect. */
  bindConnectionDiscovery(scope: HostInvocationScope): () => void {
    this.#discovery.add(scope); return () => { this.#discovery.delete(scope); };
  }
  readonly #receivers = new WeakMap<HostInvocationScope, { connectionId: string; accountId: string }>();
  /** Restrict a background receiver to reading its exact selected credential, never replacing it. */
  bindEventReceiver(scope: HostInvocationScope, connectionId: string, accountId: string): () => void {
    if (this.#receivers.has(scope)) throw invalid();
    this.#receivers.set(scope, { connectionId, accountId });
    return () => { this.#receivers.delete(scope); };
  }
  readonly #stop = new AbortController();
  readonly #attempts = new Map<string, { scope: string; extensionId: string; cancel(): void }>();
  #unregister: (() => void) | undefined;
  constructor(readonly runtime: ApplicationExtensionRuntime, readonly credentials: HostCredentialService,
    readonly flows: AuthorizationFlows) {}
  start() {
    this.#stop.signal.throwIfAborted();
    this.#unregister ??= this.runtime.capabilities.register(VARIN_CREDENTIALS_CAPABILITY, (method, raw, context) => this.call(method, raw, context));
  }
  #scope(context: HostCapabilityCallContext, connection: string) {
    this.#stop.signal.throwIfAborted();
    return createHash('sha256').update(JSON.stringify([requirePluginPrincipal(context), context.owner.extensionId, connection])).digest('hex');
  }
  #adapter(raw: unknown): VarinCredentialAdapter {
    if (!object(raw) || Object.keys(raw).some(key => !['serviceId', 'version', 'provider'].includes(key))
      || typeof raw.serviceId !== 'string' || !raw.serviceId || !Number.isSafeInteger(raw.version) || Number(raw.version) < 1
      || typeof raw.provider !== 'string' || !raw.provider) throw invalid();
    return raw as unknown as VarinCredentialAdapter;
  }
  #retain(adapter: VarinCredentialAdapter, context: HostCapabilityCallContext, connectionId: string) {
    const providers = this.runtime.services.getSnapshot().providers.filter(provider => (provider.status === 'active' || provider.status === 'draining')
      && provider.extensionId === context.owner.extensionId && provider.entrypointId === context.owner.entrypointId
      && provider.extensionVersion === context.owner.extensionVersion && provider.instanceKey === context.owner.instanceKey
      && provider.generation === context.owner.generation && provider.descriptor.id === adapter.serviceId
      && provider.descriptor.version === adapter.version);
    if (providers.length !== 1) throw invalid();
    const binding = this.runtime.services.bindPinned(adapter.serviceId, adapter.version, providers[0]!.providerId);
    const pin = binding.pin(); binding.release();
    const principal = requirePluginPrincipal(context);
    const invocation = { id: randomUUID(), value: undefined };
    const retainedContext: HostCapabilityCallContext = { owner: context.owner, invocation,
      signal: AbortSignal.any([this.#stop.signal, pin.revocationSignal]) };
    const unbind = bindPluginInvocationPrincipal(invocation, principal);
    const assertAvailable = () => { requirePluginPrincipal(retainedContext); pin.assertAvailable(); };
    let references = 1;
    const release = () => { if (--references === 0) { unbind(); pin.release(); } };
    const invoke = async (call: VarinCredentialAuthenticationCall, signal?: AbortSignal) => {
      assertAvailable();
      // This unforgeable Host annotation admits only the selected adapter exchange.
      // An authenticated Surface/service invocation alone never grants token access.
      this.#authentication.set(invocation, { owner: { ...context.owner }, assertAvailable });
      try {
        const result = parseVarinCredentialAuthenticationResult(await pin.invoke('authenticate', [call as unknown as JsonValue],
          AbortSignal.any([this.#stop.signal, pin.revocationSignal, ...(signal ? [signal] : [])]), invocation));
        assertAvailable();
        if (result.kind === 'token' && result.token.provider !== adapter.provider) throw invalid();
        return result;
      } finally { this.#authentication.delete(invocation); }
    };
    const provider: OAuthRefreshProvider = {
      capture: () => { pin.assertAvailable(); references++; let released = false;
        return { provider, release: () => { if (!released) { released = true; release(); } } }; },
      refresh: async token => {
        if (token.provider !== adapter.provider) throw invalid();
        const result = await invoke({ kind: 'refresh', provider: adapter.provider, connectionId, token });
        if (result.kind !== 'token') throw invalid(); return result.token;
      },
    };
    return { invoke, provider, release, assertAvailable, signal: pin.revocationSignal };
  }
  async call(method: string, raw: JsonValue, context: HostCapabilityCallContext): Promise<JsonValue> {
    if (method === 'assertAuthentication') {
      const selected = context.invocation && this.#authentication.get(context.invocation);
      if (!object(raw) || Object.keys(raw).length || !selected
        || selected.owner.extensionId !== context.owner.extensionId || selected.owner.entrypointId !== context.owner.entrypointId
        || selected.owner.extensionVersion !== context.owner.extensionVersion || selected.owner.instanceKey !== context.owner.instanceKey
        || selected.owner.generation !== context.owner.generation) throw invalid();
      context.signal.throwIfAborted(); selected.assertAvailable();
      return null;
    }
    if (method === 'namespace') {
      this.#stop.signal.throwIfAborted();
      if (!object(raw) || Object.keys(raw).length) throw invalid();
      // A plugin can organize its own nonsecret connection documents without learning
      // a Host-wide subject ID or introducing a second platform account directory.
      return createHash('sha256').update(JSON.stringify([requirePluginPrincipal(context), context.owner.extensionId])).digest('hex');
    }
    if (context.invocation && this.#discovery.has(context.invocation) && method !== 'inspect') throw invalid();
    const receiver = context.invocation && this.#receivers.get(context.invocation);
    if (receiver && (!object(raw) || !['inspect', 'resolve'].includes(method)
      || raw.connectionId !== receiver.connectionId || raw.expectedAccount !== receiver.accountId)) throw invalid();
    const fields: Record<string, string[]> = { put: ['key'], inspect: [], resolve: ['adapter'], remove: [], start: ['adapter'], read: ['id'], reply: ['id', 'redirect'], cancel: ['id'] };
    if (!object(raw) || !Object.hasOwn(fields, method) || Object.keys(raw).some(key => key !== 'connectionId' && key !== 'expectedAccount' && !fields[method]!.includes(key))
      || typeof raw.connectionId !== 'string' || !raw.connectionId) throw invalid();
    const principalId = requirePluginPrincipal(context);
    const connectionId = raw.connectionId, scope = this.#scope(context, connectionId), reference = `plugin:${createHash('sha256').update(context.owner.extensionId).digest('hex')}:${scope}`;
    const assertCurrent = () => { if (this.#scope(context, connectionId) !== scope) throw invalid(); };
    if (['read', 'reply', 'cancel'].includes(method)) {
      if (typeof raw.id !== 'string' || this.#attempts.get(raw.id)?.scope !== scope) throw invalid();
      if (method === 'reply') { if (typeof raw.redirect !== 'string') throw invalid(); this.flows.reply(raw.id, raw.redirect); }
      if (method === 'cancel') this.#attempts.get(raw.id)!.cancel();
      return this.flows.read(raw.id) as unknown as JsonValue;
    }
    if (raw.expectedAccount !== undefined && typeof raw.expectedAccount !== 'string') throw invalid();
    const expected = await this.credentials.identity(reference); assertCurrent();
    if (raw.expectedAccount !== undefined && raw.expectedAccount !== expected) throw new Error('The selected credential changed');
    if (method === 'put') {
      if (typeof raw.key !== 'string' || !raw.key.trim()) throw invalid();
      const record = await this.credentials.replace({ kind: 'api-key', key: raw.key }, reference, expected, assertCurrent); assertCurrent();
      this.#changed(principalId, context.owner.extensionId, connectionId);
      return { connected: true, kind: 'api-key', account: record.account, generation: record.generation };
    }
    if (method === 'remove') { for (const attempt of this.#attempts.values()) if (attempt.scope === scope) attempt.cancel(); await this.credentials.removeIfCurrent(reference, expected); assertCurrent(); this.#changed(principalId, context.owner.extensionId, connectionId); return { connected: false }; }
    if (method === 'inspect') {
      if (!expected) return { connected: false };
      const record = await this.credentials.read(reference); assertCurrent();
      return { connected: true, account: record.account, generation: record.generation, kind: record.value.kind, ...(record.value.kind === 'oauth' && record.value.accountId ? { accountId: record.value.accountId } : {}) };
    }
    if (method === 'resolve') {
      const record = await this.credentials.read(reference); assertCurrent();
      if (record.account !== expected) throw new Error('The selected credential changed');
      const held = record.value.kind === 'oauth' ? this.#retain(this.#adapter(raw.adapter), context, connectionId) : undefined;
      try {
        if (record.value.kind === 'oauth' && record.value.provider !== this.#adapter(raw.adapter).provider) throw invalid();
        const value = await this.credentials.resolveValue(reference, AbortSignal.any([context.signal, this.#stop.signal]), { account: record, ...(held ? { provider: held.provider } : {}) });
        assertCurrent(); return value.value as unknown as JsonValue;
      } finally { held?.release(); }
    }
    const adapter = this.#adapter(raw.adapter), held = this.#retain(adapter, context, connectionId);
    const cancel = new AbortController();
    const signal = AbortSignal.any([cancel.signal, held.signal, this.#stop.signal]);
    let flowId = '', committing = false;
    const abort = () => { if (flowId && !committing) this.flows.cancel(flowId); };
    const state = this.flows.start(async prompt => {
      try {
        signal.throwIfAborted(); held.assertAvailable();
        const begin = await held.invoke({ kind: 'begin', provider: adapter.provider, connectionId }, signal);
        if (begin.kind !== 'pending') throw invalid();
        if (begin.deviceCode) prompt.showDeviceCode?.(new URL(begin.authorizationUrl), begin.deviceCode);
        else prompt.showAuthorizationUrl(new URL(begin.authorizationUrl));
        const redirect = await prompt.promptForRedirectUrl(signal); signal.throwIfAborted(); held.assertAvailable();
        if (!redirect) throw invalid();
        const result = await held.invoke({ kind: 'complete', provider: adapter.provider, connectionId, state: begin.state, redirect }, signal);
        signal.throwIfAborted(); held.assertAvailable(); if (result.kind !== 'token') throw invalid();
        await this.credentials.replace(result.token, reference, expected, () => { signal.throwIfAborted(); held.assertAvailable(); committing = true; });
        this.#changed(principalId, context.owner.extensionId, connectionId);
      } finally { signal.removeEventListener('abort', abort); held.release(); }
    });
    flowId = state.id;
    this.#attempts.set(state.id, { scope, extensionId: context.owner.extensionId, cancel: () => { cancel.abort(); if (!committing) this.flows.cancel(state.id); } });
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    return state as unknown as JsonValue;
  }
  async deleteExtensionData(extensionId: string) {
    for (const attempt of this.#attempts.values()) if (attempt.extensionId === extensionId) attempt.cancel();
    await this.credentials.removePrefix(`plugin:${createHash('sha256').update(extensionId).digest('hex')}:`);
  }
  close() { this.#stop.abort(); this.#unregister?.(); this.#unregister = undefined; for (const attempt of this.#attempts.values()) attempt.cancel(); this.#attempts.clear(); this.#listeners.clear(); this.flows.close(); }
}
