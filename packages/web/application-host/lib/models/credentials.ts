/** Model policy and request authentication adapter over the shared Host credential owner. */
import { randomUUID } from 'node:crypto';
import type { ConnectionAuthentication } from '@varin/application-client';
import type { CredentialScope, CredentialDispatch } from '../kernel/credential-owner.js';
import { HostCredentialService, sameAccount, type AccountCredential, type SecretStore, type OAuthRefreshProvider } from '../credentials/service.js';
import { ModelConfigurationError } from './configuration.js';
export { fileSecretStore, type AccountCredential, type SecretStore } from '../credentials/service.js';

export interface ResolvedCredential { auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }; source?: string; anthropicOauth?: boolean }
/** Optional caller-owned source policy; undefined leaves non-model credential consumers unchanged. */
export type OAuthSourcePolicy = readonly string[];
export interface OAuthProvider extends OAuthRefreshProvider {
  /** Retain the exact reviewed implementation for a captured execution. */
  capture?(): { provider: OAuthProvider; release(): void };
  refresh(value: Extract<AccountCredential['value'], { kind: 'oauth' }>): Promise<Extract<AccountCredential['value'], { kind: 'oauth' }>>;
  headers(value: Extract<AccountCredential['value'], { kind: 'oauth' }>): Record<string, string>;
  baseUrl?(value: Extract<AccountCredential['value'], { kind: 'oauth' }>): string;
  anthropicOauth?: boolean;
}

const invalid = (code: string, message: string): never => { throw new ModelConfigurationError(code, message); };
export class CredentialService extends HostCredentialService<OAuthProvider> {
  readonly #dynamic = new Map<string, { value: string; account: string }>();
  constructor(authorityId: string, store: SecretStore) {
    super(authorityId, store, (code, message) => new ModelConfigurationError(code, message));
  }
  #admitOAuth(record: AccountCredential, policy?: OAuthSourcePolicy) {
    if (record.value.kind === 'oauth' && policy && !policy.includes(record.value.provider)) {
      return invalid('oauth-provider-mismatch', 'The selected OAuth account is not supported by this channel type. Select a matching channel type or use an API key.');
    }
  }
  async captureResolver(source: ConnectionAuthentication, reference: string, oauthPolicy?: OAuthSourcePolicy) {
    const policy = oauthPolicy === undefined ? undefined : [...oauthPolicy];
    const record = source.kind === 'credential' ? await this.readRecord(source.reference) : undefined;
    if (record) this.#admitOAuth(record, policy);
    const oauth = record?.value.kind === 'oauth' ? this.oauthProvider(record.value.provider) : undefined;
    if (record?.value.kind === 'oauth' && !oauth) return invalid('oauth-provider-unavailable', 'The selected authentication provider is unavailable');
    const captured = oauth?.capture?.();
    let released = false;
    return {
      resolve: (signal?: AbortSignal, dispatch?: CredentialDispatch) => {
        if (released) return Promise.reject(new ModelConfigurationError('credential-binding-released', 'The account binding has been released'));
        return this.#resolve(source, reference, signal, dispatch, record && oauth ? { account: record, provider: captured?.provider ?? oauth } : undefined, policy);
      },
      release: () => { if (!released) { released = true; captured?.release(); } },
    };
  }
  #environment(source: Extract<ConnectionAuthentication, { kind: 'environment' }>, reference: string) {
    const value = process.env[source.variable];
    if (!value) return invalid('credential-environment-missing', `Credential environment variable is not set: ${source.variable}`);
    const key = JSON.stringify([reference, source.variable]);
    let state = this.#dynamic.get(key);
    if (!state || state.value !== value) { state = { value, account: randomUUID() }; this.#dynamic.set(key, state); }
    return state;
  }
  async scope(source: ConnectionAuthentication, reference: string): Promise<CredentialScope> {
    if (source.kind === 'credential') {
      const record = await this.readRecord(source.reference);
      return { reference, authority: this.authorityId, account: record.account, generation: record.generation };
    }
    if (source.kind === 'environment') return { reference, authority: this.authorityId, account: this.#environment(source, reference).account, generation: 0 };
    if (source.kind === 'none') return { reference, authority: this.authorityId, account: 'anonymous', generation: 0 };
    return invalid('credential-resolver-required', 'Cloud authentication must be resolved by its registered owner');
  }
  resolve(source: ConnectionAuthentication, reference: string, signal?: AbortSignal, dispatch?: CredentialDispatch, oauthPolicy?: OAuthSourcePolicy): Promise<ResolvedCredential> {
    return this.#resolve(source, reference, signal, dispatch, undefined, oauthPolicy === undefined ? undefined : [...oauthPolicy]);
  }
  async #resolve(source: ConnectionAuthentication, reference: string, signal?: AbortSignal, _dispatch?: CredentialDispatch,
    captured?: { account: AccountCredential; provider: OAuthProvider }, oauthPolicy?: OAuthSourcePolicy): Promise<ResolvedCredential> {
    signal?.throwIfAborted();
    if (source.kind === 'none') return { auth: {}, source: 'anonymous' };
    if (source.kind === 'environment') return { auth: { apiKey: this.#environment(source, reference).value }, source: 'environment' };
    if (source.kind !== 'credential') return invalid('credential-resolver-required', 'Cloud authentication must be resolved by its registered owner');
    const record = await this.readRecord(source.reference);
    this.#admitOAuth(record, oauthPolicy);
    if (captured && (!sameAccount(captured.account, record) || record.value.kind !== 'oauth'
      || captured.account.value.kind !== 'oauth' || record.value.provider !== captured.account.value.provider)) return invalid('credential-scope-changed', 'The selected account changed');
    const provider = record.value.kind === 'oauth' ? captured?.provider ?? this.oauthProvider(record.value.provider) : undefined;
    const fresh = await this.resolveValue(source.reference, signal, { account: record, provider });
    if (fresh.value.kind === 'api-key') return { auth: { apiKey: fresh.value.key }, source: 'credential file' };
    if (!provider) return invalid('oauth-provider-unavailable', 'The selected authentication provider is unavailable');
    return { auth: { headers: provider.headers(fresh.value), ...(provider.baseUrl ? { baseUrl: provider.baseUrl(fresh.value) } : {}) }, source: 'oauth', anthropicOauth: provider.anthropicOauth ?? false };
  }
}
