/** Model-neutral Host secret storage, account identity and refresh coordination. */
import { randomUUID } from 'node:crypto';
import { createSettingsFileStore } from '@varin/settings-store';
import { waitWithSignal } from '../cancellation.js';

export class HostCredentialError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export interface AccountCredential {
  version: 1;
  account: string;
  generation: number;
  value: { kind: 'api-key'; key: string } | { kind: 'oauth'; accessToken: string; refreshToken?: string; expiresAt?: number; provider: string; accountId?: string };
}
const validValue = (value: unknown): value is AccountCredential['value'] => object(value) && (
  value.kind === 'api-key' && typeof value.key === 'string' && !!value.key.trim()
  || value.kind === 'oauth' && typeof value.accessToken === 'string' && !!value.accessToken
    && typeof value.provider === 'string' && !!value.provider
    && (value.refreshToken === undefined || typeof value.refreshToken === 'string')
    && (value.accountId === undefined || typeof value.accountId === 'string')
    && (value.expiresAt === undefined || typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt))
);
export interface SecretStore {
  read(reference: string): Promise<string | null>;
  modify(reference: string, change: (current: string | null) => string | null): Promise<void>;
  /** Atomic deletion for a namespace owned by a trusted Host caller. */
  removePrefix?(prefix: string): Promise<void>;
}
export interface OAuthRefreshProvider {
  capture?(): { provider: OAuthRefreshProvider; release(): void };
  refresh(value: Extract<AccountCredential['value'], { kind: 'oauth' }>): Promise<Extract<AccountCredential['value'], { kind: 'oauth' }>>;
}
export interface CapturedCredential<P extends OAuthRefreshProvider = OAuthRefreshProvider> {
  account: AccountCredential;
  provider?: P | undefined;
}
/** Local credentials use the shared file transaction owner for locking and atomic replacement. */
export function fileSecretStore(path: string): SecretStore {
  const file = createSettingsFileStore({ filePath: path });
  return {
    read: async reference => { const document = await file.read(); return Object.hasOwn(document, reference) ? JSON.stringify(document[reference]) : null; },
    removePrefix: prefix => {
      if (!prefix) throw new HostCredentialError('credential-reference-missing', 'A credential namespace is required');
      return file.transact(document => {
        const keys = Object.keys(document).filter(reference => reference.startsWith(prefix));
        if (!keys.length) return { result: undefined, write: false };
        for (const key of keys) delete document[key];
        return { document, result: undefined };
      });
    },
    modify: (reference, change) => file.transact(document => {
      const current = Object.hasOwn(document, reference) ? JSON.stringify(document[reference]) : null;
      const value = change(current);
      if (value === current) return { result: undefined, write: false };
      if (value === null) delete document[reference]; else Object.defineProperty(document, reference, { value: JSON.parse(value), enumerable: true, writable: true, configurable: true });
      return { document, result: undefined };
    }),
  };
}
export const sameAccount = (left: AccountCredential, right: AccountCredential) => left.account === right.account && left.generation === right.generation;

export class HostCredentialService<P extends OAuthRefreshProvider = OAuthRefreshProvider> {
  readonly #refreshes = new Map<string, Promise<AccountCredential>>();
  readonly #oauth = new Map<string, P>();
  readonly #oauthOwners = new Map<string, string>();
  constructor(readonly authorityId: string, readonly store: SecretStore,
    private readonly error: (code: string, message: string) => Error = (code, message) => new HostCredentialError(code, message)) {}
  protected invalid(code: string, message: string): never { throw this.error(code, message); }
  protected oauthProvider(id: string): P | undefined { return this.#oauth.get(id); }
  registerOAuth(id: string, provider: P) {
    if (this.#oauth.has(id)) throw new Error(`Authentication provider already registered: ${id}`);
    this.#oauth.set(id, provider);
    return () => { if (this.#oauth.get(id) === provider) this.#oauth.delete(id); };
  }
  prepareOAuthReplacement(owner: string, providers: readonly { id: string; provider: P }[]): () => void {
    const next = new Map<string, P>();
    for (const value of providers) {
      if (next.has(value.id) || this.#oauth.has(value.id) && this.#oauthOwners.get(value.id) !== owner) throw new Error(`Authentication provider already registered: ${value.id}`);
      next.set(value.id, value.provider);
    }
    return () => {
      for (const [id, current] of this.#oauthOwners) if (current === owner) { this.#oauth.delete(id); this.#oauthOwners.delete(id); }
      for (const [id, provider] of next) { this.#oauth.set(id, provider); this.#oauthOwners.set(id, owner); }
    };
  }
  protected async readRecord(reference: string): Promise<AccountCredential> {
    if (!reference) return this.invalid('credential-reference-missing', 'Select a credential');
    let raw: string | null;
    try { raw = await this.store.read(reference); }
    catch { return this.invalid('credential-store-unavailable', 'The credential file could not be read'); }
    if (raw === null) return this.invalid('credential-missing', 'The selected credential is unavailable');
    return this.#decodeRecord(raw);
  }
  #decodeRecord(raw: string): AccountCredential {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return this.invalid('credential-invalid', 'The selected credential is malformed'); }
    if (!object(parsed) || parsed.version !== 1 || typeof parsed.account !== 'string' || !parsed.account
      || !Number.isSafeInteger(parsed.generation) || Number(parsed.generation) < 1 || !validValue(parsed.value)) {
      return this.invalid('credential-invalid', 'The selected credential is malformed');
    }
    return parsed as unknown as AccountCredential;
  }
  /** Trusted Host metadata/value read. Never expose this record to a renderer. */
  read(reference: string): Promise<AccountCredential> { return this.readRecord(reference); }
  /** Compare-and-swap a connection after authorization, including an initially absent connection.
   * assertCommit runs under the store transaction lock: cancellation while queued cannot
   * publish a credential. Once the mutation is admitted, cancellation does not roll back its write.
   */
  async replace(value: AccountCredential['value'], reference: string, expectedAccount: string | undefined,
    assertCommit?: () => void) {
    if (!reference || !validValue(value)) return this.invalid('credential-invalid', 'Enter a credential');
    const record: AccountCredential = { version: 1, account: randomUUID(), generation: 1, value: structuredClone(value) };
    await this.store.modify(reference, raw => {
      assertCommit?.();
      const current = raw === null ? undefined : this.#decodeRecord(raw);
      if (current?.account !== expectedAccount) return this.invalid('credential-scope-changed', 'The account changed during sign-in');
      return JSON.stringify(record);
    });
    return record;
  }
  removeIfCurrent(reference: string, expectedAccount: string | undefined) {
    return this.store.modify(reference, raw => {
      const current = raw === null ? undefined : this.#decodeRecord(raw);
      if (current?.account !== expectedAccount) return this.invalid('credential-scope-changed', 'The selected account changed');
      return null;
    });
  }
  async put(secret: string, reference: string = randomUUID()): Promise<string> {
    if (typeof secret !== 'string' || !secret.trim() || typeof reference !== 'string' || !reference) return this.invalid('credential-invalid', 'Enter a credential');
    // Explicit replacement changes identity; an outstanding refresh cannot overwrite it.
    const record: AccountCredential = { version: 1, account: randomUUID(), generation: 1, value: { kind: 'api-key', key: secret } };
    await this.store.modify(reference, () => JSON.stringify(record));
    return reference;
  }
  async linkOAuth(value: Extract<AccountCredential['value'], { kind: 'oauth' }>, reference: string = randomUUID()) {
    if (!validValue(value)) return this.invalid('credential-invalid', 'The selected credential is malformed');
    if (!this.#oauth.has(value.provider)) return this.invalid('oauth-provider-unavailable', 'This authentication provider is unavailable');
    await this.store.modify(reference, () => JSON.stringify({ version: 1, account: randomUUID(), generation: 1, value } satisfies AccountCredential));
    return reference;
  }
  async identity(reference: string) {
    const raw = await this.store.read(reference); if (raw === null) return undefined;
    return (await this.readRecord(reference)).account;
  }
  async providerAccount(reference: string) { const value = (await this.readRecord(reference)).value; return value.kind === 'oauth' ? value.accountId : undefined; }
  async acceptOAuth(value: Extract<AccountCredential['value'], { kind: 'oauth' }>, reference: string, expectedAccount: string | undefined) {
    if (!validValue(value)) return this.invalid('credential-invalid', 'The selected credential is malformed');
    if (!this.#oauth.has(value.provider)) return this.invalid('oauth-provider-unavailable', 'This authentication provider is unavailable');
    await this.replace(value, reference, expectedAccount);
  }
  removePrefix(prefix: string): Promise<void> {
    if (!prefix) return this.invalid('credential-reference-missing', 'A credential namespace is required');
    if (!this.store.removePrefix) return this.invalid('credential-store-unavailable', 'The credential store does not support namespace removal');
    return this.store.removePrefix(prefix);
  }
  remove(reference: string) { return this.store.modify(reference, () => null); }
  async #fresh(reference: string, record: AccountCredential, capturedProvider?: P): Promise<AccountCredential> {
    if (record.value.kind !== 'oauth' || record.value.expiresAt === undefined || record.value.expiresAt > Date.now()) return record;
    const key = JSON.stringify([reference, record.account, record.generation]);
    let pending = this.#refreshes.get(key);
    if (!pending) {
      const provider = capturedProvider ?? this.#oauth.get(record.value.provider);
      if (!provider) return this.invalid('oauth-provider-unavailable', 'The selected authentication provider is unavailable');
      const oauth = record.value;
      const retained = provider.capture?.();
      pending = (async () => {
        try {
        const value = await (retained?.provider ?? provider).refresh(oauth);
        if (!validValue(value)) return this.invalid('credential-invalid', 'The refreshed credential is malformed');
        if (value.provider !== oauth.provider || value.accountId !== oauth.accountId) return this.invalid('credential-account-changed', 'Sign in again to confirm the account');
        const next = { ...record, value };
        await this.store.modify(reference, raw => {
          const current = raw === null ? undefined : this.#decodeRecord(raw);
          if (!current || !sameAccount(record, current)) return this.invalid('credential-scope-changed', 'The credential was replaced while refreshing');
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
  /** Resolves secrets only for trusted Host callers; the returned record carries its bound identity. */
  async resolveValue(reference: string, signal?: AbortSignal, captured?: CapturedCredential<P>): Promise<AccountCredential> {
    signal?.throwIfAborted();
    const record = await this.readRecord(reference);
    if (captured && (!sameAccount(captured.account, record)
      || captured.account.value.kind !== record.value.kind
      || record.value.kind === 'oauth' && captured.account.value.kind === 'oauth' && record.value.provider !== captured.account.value.provider)) {
      return this.invalid('credential-scope-changed', 'The selected account changed');
    }
    const provider = record.value.kind === 'oauth' ? captured?.provider ?? this.#oauth.get(record.value.provider) : undefined;
    if (record.value.kind === 'oauth' && !provider) return this.invalid('oauth-provider-unavailable', 'The selected authentication provider is unavailable');
    return waitWithSignal(this.#fresh(reference, record, provider), signal);
  }
  async captureValue(reference: string, suppliedProvider?: P) {
    const account = await this.readRecord(reference);
    const provider = account.value.kind === 'oauth' ? suppliedProvider ?? this.#oauth.get(account.value.provider) : undefined;
    if (account.value.kind === 'oauth' && !provider) return this.invalid('oauth-provider-unavailable', 'The selected authentication provider is unavailable');
    const retained = provider?.capture?.();
    let released = false;
    return {
      resolve: (signal?: AbortSignal) => released
        ? Promise.reject(this.error('credential-binding-released', 'The account binding has been released'))
        : this.resolveValue(reference, signal, { account, provider: (retained?.provider ?? provider) as P | undefined }),
      release: () => { if (!released) { released = true; retained?.release(); } },
    };
  }
}
