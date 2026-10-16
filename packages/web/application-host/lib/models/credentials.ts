/** Secret storage and account refresh. No SDK runtime or model directory is constructed here. */
import { randomUUID } from 'node:crypto';
import { createSettingsFileStore } from '@varin/settings-store';
import type { ConnectionAuthentication } from '@varin/application-client';
import type { CredentialScope, CredentialDispatch } from '../kernel/credential-owner.js';
import { waitWithSignal } from '../cancellation.js';
import { ModelConfigurationError, object } from './configuration.js';

export interface AccountCredential {
  version: 1;
  account: string;
  generation: number;
  value: { kind: 'api-key'; key: string } | { kind: 'oauth'; accessToken: string; refreshToken?: string; expiresAt?: number; provider: string; accountId?: string };
}
export interface SecretStore {
  read(reference: string): Promise<string | null>;
  modify(reference: string, change: (current: string | null) => string | null): Promise<void>;
}
export interface ResolvedCredential { auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }; source?: string; anthropicOauth?: boolean }
export interface OAuthProvider {
  /** Retain the exact reviewed implementation for a captured execution. */
  capture?(): { provider: OAuthProvider; release(): void };
  refresh(value: Extract<AccountCredential['value'], { kind: 'oauth' }>): Promise<Extract<AccountCredential['value'], { kind: 'oauth' }>>;
  headers(value: Extract<AccountCredential['value'], { kind: 'oauth' }>): Record<string, string>;
  baseUrl?(value: Extract<AccountCredential['value'], { kind: 'oauth' }>): string;
  anthropicOauth?: boolean;
}

/** Local credentials use the shared file transaction owner for locking and atomic replacement. */
export function fileSecretStore(path: string): SecretStore {
  const file = createSettingsFileStore({ filePath: path });
  return {
    read: async reference => { const document = await file.read(); return Object.hasOwn(document, reference) ? JSON.stringify(document[reference]) : null; },
    modify: (reference, change) => file.transact(document => {
      const current = Object.hasOwn(document, reference) ? JSON.stringify(document[reference]) : null;
      const value = change(current);
      if (value === current) return { result: undefined, write: false };
      if (value === null) delete document[reference]; else Object.defineProperty(document, reference, { value: JSON.parse(value), enumerable: true, writable: true, configurable: true });
      return { document, result: undefined };
    }),
  };
}
const invalid = (code: string, message: string): never => { throw new ModelConfigurationError(code, message); };
const sameAccount = (left: AccountCredential, right: AccountCredential) => left.account === right.account && left.generation === right.generation;

export class CredentialService {
  readonly #refreshes = new Map<string, Promise<AccountCredential>>();
  readonly #dynamic = new Map<string, { value: string; account: string }>();
  readonly #oauth = new Map<string, OAuthProvider>();
  readonly #oauthOwners = new Map<string, string>();
  constructor(readonly authorityId: string, readonly store: SecretStore) {}
  registerOAuth(id: string, provider: OAuthProvider) {
    if (this.#oauth.has(id)) throw new Error(`Authentication provider already registered: ${id}`);
    this.#oauth.set(id, provider);
    return () => { if (this.#oauth.get(id) === provider) this.#oauth.delete(id); };
  }
  prepareOAuthReplacement(owner: string, providers: readonly { id: string; provider: OAuthProvider }[]): () => void {
    const next = new Map<string, OAuthProvider>();
    for (const value of providers) {
      if (next.has(value.id) || this.#oauth.has(value.id) && this.#oauthOwners.get(value.id) !== owner) throw new Error(`Authentication provider already registered: ${value.id}`);
      next.set(value.id, value.provider);
    }
    return () => {
      for (const [id, current] of this.#oauthOwners) if (current === owner) { this.#oauth.delete(id); this.#oauthOwners.delete(id); }
      for (const [id, provider] of next) { this.#oauth.set(id, provider); this.#oauthOwners.set(id, owner); }
    };
  }
  async captureResolver(source: ConnectionAuthentication, reference: string) {
    const record = source.kind === 'credential' ? await this.#read(source.reference) : undefined;
    const oauth = record?.value.kind === 'oauth' ? this.#oauth.get(record.value.provider) : undefined;
    if (record?.value.kind === 'oauth' && !oauth) return invalid('oauth-provider-unavailable', 'The selected authentication provider is unavailable');
    const captured = oauth?.capture?.();
    let released = false;
    return {
      resolve: (signal?: AbortSignal, dispatch?: CredentialDispatch) => {
        if (released) return Promise.reject(new ModelConfigurationError('credential-binding-released', 'The account binding has been released'));
        return this.#resolve(source, reference, signal, dispatch, record && oauth ? { account: record, provider: captured?.provider ?? oauth } : undefined);
      },
      release: () => { if (!released) { released = true; captured?.release(); } },
    };
  }
  async #read(reference: string): Promise<AccountCredential> {
    if (!reference) return invalid('credential-reference-missing', 'Select a credential');
    let raw: string | null;
    try { raw = await this.store.read(reference); }
    catch { return invalid('credential-store-unavailable', 'The credential file could not be read'); }
    if (raw === null) return invalid('credential-missing', 'The selected credential is unavailable');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return invalid('credential-invalid', 'The selected credential is malformed'); }
    if (!object(parsed) || parsed.version !== 1 || typeof parsed.account !== 'string' || !parsed.account
      || !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 1 || !object(parsed.value)
      || !(parsed.value.kind === 'api-key' && typeof parsed.value.key === 'string' && parsed.value.key
        || parsed.value.kind === 'oauth' && typeof parsed.value.accessToken === 'string' && parsed.value.accessToken && typeof parsed.value.provider === 'string'
          && (parsed.value.refreshToken === undefined || typeof parsed.value.refreshToken === 'string')
          && (parsed.value.accountId === undefined || typeof parsed.value.accountId === 'string')
          && (parsed.value.expiresAt === undefined || typeof parsed.value.expiresAt === 'number' && Number.isFinite(parsed.value.expiresAt)))) {
      return invalid('credential-invalid', 'The selected credential is malformed');
    }
    return parsed as unknown as AccountCredential;
  }
  async put(secret: string, reference: string = randomUUID()): Promise<string> {
    if (typeof secret !== 'string' || !secret.trim() || typeof reference !== 'string' || !reference) return invalid('credential-invalid', 'Enter a credential');
    // Explicit replacement changes identity; an outstanding refresh cannot overwrite it.
    const record: AccountCredential = { version: 1, account: randomUUID(), generation: 1, value: { kind: 'api-key', key: secret } };
    await this.store.modify(reference, () => JSON.stringify(record));
    return reference;
  }
  async linkOAuth(value: Extract<AccountCredential['value'], { kind: 'oauth' }>, reference: string = randomUUID()) {
    if (!this.#oauth.has(value.provider)) return invalid('oauth-provider-unavailable', 'This authentication provider is unavailable');
    await this.store.modify(reference, () => JSON.stringify({ version: 1, account: randomUUID(), generation: 1, value } satisfies AccountCredential));
    return reference;
  }
  async identity(reference: string) {
    const raw = await this.store.read(reference); if (raw === null) return undefined;
    return (await this.#read(reference)).account;
  }
  async providerAccount(reference: string) { const value = (await this.#read(reference)).value; return value.kind === 'oauth' ? value.accountId : undefined; }
  async acceptOAuth(value: Extract<AccountCredential['value'], { kind: 'oauth' }>, reference: string, expectedAccount: string | undefined) {
    if (!this.#oauth.has(value.provider)) return invalid('oauth-provider-unavailable', 'This authentication provider is unavailable');
    await this.store.modify(reference, raw => {
      const current = raw === null ? undefined : JSON.parse(raw) as AccountCredential;
      if (current?.account !== expectedAccount) return invalid('credential-scope-changed', 'The account changed during sign-in');
      return JSON.stringify({ version: 1, account: randomUUID(), generation: 1, value } satisfies AccountCredential);
    });
  }
  remove(reference: string) { return this.store.modify(reference, () => null); }
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
      const record = await this.#read(source.reference);
      return { reference, authority: this.authorityId, account: record.account, generation: record.generation };
    }
    if (source.kind === 'environment') return { reference, authority: this.authorityId, account: this.#environment(source, reference).account, generation: 0 };
    if (source.kind === 'none') return { reference, authority: this.authorityId, account: 'anonymous', generation: 0 };
    return invalid('credential-resolver-required', 'Cloud authentication must be resolved by its registered owner');
  }
  async #fresh(reference: string, record: AccountCredential, capturedProvider?: OAuthProvider): Promise<AccountCredential> {
    if (record.value.kind !== 'oauth' || record.value.expiresAt === undefined || record.value.expiresAt > Date.now()) return record;
    const key = JSON.stringify([reference, record.account, record.generation]);
    let pending = this.#refreshes.get(key);
    if (!pending) {
      const provider = capturedProvider ?? this.#oauth.get(record.value.provider);
      if (!provider) return invalid('oauth-provider-unavailable', 'The selected authentication provider is unavailable');
      const oauth = record.value;
      const retained = provider.capture?.();
      pending = (async () => {
        try {
        const value = await (retained?.provider ?? provider).refresh(oauth);
        if (value.provider !== oauth.provider || value.accountId !== oauth.accountId) return invalid('credential-account-changed', 'Sign in again to confirm the account');
        const next = { ...record, value };
        await this.store.modify(reference, raw => {
          const current = raw === null ? undefined : JSON.parse(raw) as AccountCredential;
          if (!current || !sameAccount(record, current)) return invalid('credential-scope-changed', 'The credential was replaced while refreshing');
          return JSON.stringify(next);
        });
        return next;
        } finally { retained?.release(); }
      })();
      this.#refreshes.set(key, pending);
      void pending.then(() => { if (this.#refreshes.get(key) === pending) this.#refreshes.delete(key); }, () => { if (this.#refreshes.get(key) === pending) this.#refreshes.delete(key); });
    }
    return pending;
  }
  resolve(source: ConnectionAuthentication, reference: string, signal?: AbortSignal, dispatch?: CredentialDispatch): Promise<ResolvedCredential> {
    return this.#resolve(source, reference, signal, dispatch);
  }
  async #resolve(source: ConnectionAuthentication, reference: string, signal?: AbortSignal, _dispatch?: CredentialDispatch,
    captured?: { account: AccountCredential; provider: OAuthProvider }): Promise<ResolvedCredential> {
    signal?.throwIfAborted();
    if (source.kind === 'none') return { auth: {}, source: 'anonymous' };
    if (source.kind === 'environment') return { auth: { apiKey: this.#environment(source, reference).value }, source: 'environment' };
    if (source.kind !== 'credential') return invalid('credential-resolver-required', 'Cloud authentication must be resolved by its registered owner');
    const record = await this.#read(source.reference);
    if (captured && (!sameAccount(captured.account, record) || record.value.kind !== 'oauth'
      || captured.account.value.kind !== 'oauth' || record.value.provider !== captured.account.value.provider)) return invalid('credential-scope-changed', 'The selected account changed');
    const provider = record.value.kind === 'oauth' ? captured?.provider ?? this.#oauth.get(record.value.provider) : undefined;
    const fresh = await waitWithSignal(this.#fresh(source.reference, record, provider), signal);
    if (fresh.value.kind === 'api-key') return { auth: { apiKey: fresh.value.key }, source: 'credential file' };
    if (!provider) return invalid('oauth-provider-unavailable', 'The selected authentication provider is unavailable');
    return { auth: { headers: provider.headers(fresh.value), ...(provider.baseUrl ? { baseUrl: provider.baseUrl(fresh.value) } : {}) }, source: 'oauth', anthropicOauth: provider.anthropicOauth ?? false };
  }
}
