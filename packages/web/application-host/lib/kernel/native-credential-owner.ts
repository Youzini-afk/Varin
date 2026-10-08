/** Private Host-only credential resolution. Never expose this module through renderer/RPC DTOs.
 * The injected runtime is the existing credential owner; this adapter opens no credential files,
 * creates no second store, and performs no login or credential persistence of its own.
 */
export interface NativeCredentialScope {
  reference: string;
  authority: string;
  account: string;
  generation: number;
}
export interface ExistingModelAuthRuntime {
  getAuth(providerId: string): Promise<{
    auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string };
  } | undefined>;
}
export interface NativeCredentialOwnerOptions {
  runtime: ExistingModelAuthRuntime;
  providerId: string;
  providerFamily: string;
  /** The credential owner supplies this metadata and advances it on relink/revocation. */
  currentScope(): Promise<NativeCredentialScope>;
  /** Verified external provider account metadata, distinct from the local binding handle. */
  currentProviderAccount?(): Promise<string | undefined>;
  /** Complete trusted model endpoint; resolution may not silently redirect a frozen request. */
  endpoint: string;
  allowAnonymous?: boolean;
}
export interface PrivateCredentialResolution {
  scope: NativeCredentialScope;
  /** Secret-bearing, transient value for the private Host/kernel channel only. */
  headers: Record<string, string>;
}
export class NativeCredentialOwnerError extends Error {
  constructor(readonly code: string) {
    // Provider/store errors may contain tokens or response bodies. Never include their message/cause.
    super(code);
    this.name = 'NativeCredentialOwnerError';
  }
}
const fail = (code: string): never => { throw new NativeCredentialOwnerError(code); };
const validateScope = (scope: NativeCredentialScope): NativeCredentialScope => {
  if (!scope || typeof scope.reference !== 'string' || !scope.reference
    || typeof scope.authority !== 'string' || !scope.authority
    || typeof scope.account !== 'string' || !scope.account
    || !Number.isSafeInteger(scope.generation) || scope.generation < 0) fail('invalid-credential-scope');
  return { reference: scope.reference, authority: scope.authority, account: scope.account, generation: scope.generation };
};
const sameScope = (left: NativeCredentialScope, right: NativeCredentialScope): boolean => (
  left.reference === right.reference && left.authority === right.authority
  && left.account === right.account && left.generation === right.generation
);
function waitWithoutCancellingOwner<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new NativeCredentialOwnerError('credential-cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    // Always attach both handlers, even if already cancelled, so a late refresh/store failure
    // settles quietly after its existing owner has finished persistence.
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
function registeredEndpoint(value: string): URL {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
      return fail('invalid-credential-endpoint');
    }
    return url;
  } catch { return fail('invalid-credential-endpoint'); }
}
/** Adapts the existing ModelRuntime.getAuth owner without copying or replacing its store. */
export class ExistingHostCredentialOwner {
  readonly #options: NativeCredentialOwnerOptions;
  readonly #endpoint: URL;
  constructor(options: NativeCredentialOwnerOptions) {
    if (!options.providerId || !options.providerFamily) fail('invalid-credential-owner');
    this.#options = Object.freeze({ ...options });
    this.#endpoint = registeredEndpoint(options.endpoint);
  }
  async scope(): Promise<NativeCredentialScope> {
    try { return validateScope(await this.#options.currentScope()); }
    catch { return fail('credential-scope-unavailable'); }
  }
  resolve(expectedScope: NativeCredentialScope, signal?: AbortSignal): Promise<PrivateCredentialResolution> {
    const expected = validateScope(expectedScope);
    if (signal?.aborted) return Promise.reject(new NativeCredentialOwnerError('credential-cancelled'));
    // No caller cancellation is passed to getAuth. The existing owner's bounded refresh must
    // finish and persist a rotated token even if the native request no longer needs the answer.
    return waitWithoutCancellingOwner(this.#resolve(expected), signal);
  }
  async #resolve(expected: NativeCredentialScope): Promise<PrivateCredentialResolution> {
    try {
      const before = validateScope(await this.#options.currentScope());
      if (!sameScope(before, expected)) return fail('credential-scope-changed');
      const resolved = await this.#options.runtime.getAuth(this.#options.providerId);
      const after = validateScope(await this.#options.currentScope());
      if (!sameScope(after, expected)) return fail('credential-scope-changed');
      if (!resolved) return fail('credential-missing');
      if (resolved.auth.baseUrl) {
        const base = registeredEndpoint(resolved.auth.baseUrl);
        const prefix = base.pathname.replace(/\/+$/, '');
        if (base.origin !== this.#endpoint.origin || (this.#endpoint.pathname !== prefix
          && !this.#endpoint.pathname.startsWith(`${prefix}/`))) return fail('credential-endpoint-changed');
        for (const [name, value] of base.searchParams) {
          if (!this.#endpoint.searchParams.getAll(name).includes(value)) return fail('credential-endpoint-changed');
        }
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(resolved.auth.headers ?? {})) {
        if (value !== null) headers.set(name, value);
      }
      const key = resolved.auth.apiKey;
      if (key) {
        switch (this.#options.providerFamily) {
          case 'openai-responses': case 'openai-completions': case 'mistral-conversations':
          case 'openai-codex-responses':
            if (!headers.has('authorization')) headers.set('authorization', `Bearer ${key}`);
            break;
          case 'anthropic-messages':
            if (!headers.has('authorization') && !headers.has('x-api-key')) headers.set('x-api-key', key);
            break;
          case 'azure-openai-responses':
            if (!headers.has('authorization') && !headers.has('api-key')) headers.set('api-key', key);
            break;
          case 'google-generative-ai':
            if (!headers.has('x-goog-api-key')) headers.set('x-goog-api-key', key);
            break;
          case 'google-vertex':
            // Vertex key and cloud bearer modes are deliberately not guessed from an apiKey.
            if (!headers.has('authorization') && !headers.has('x-goog-api-key')) return fail('vertex-auth-mode-required');
            break;
          default: return fail('unsupported-credential-family');
        }
      }
      if (this.#options.providerFamily === 'openai-codex-responses') {
        if (!/^Bearer +\S+$/i.test(headers.get('authorization') ?? '')) return fail('codex-credential-binding-required');
        const account = headers.get('chatgpt-account-id');
        const verified = await this.#options.currentProviderAccount?.();
        if (account && verified && account !== verified) return fail('credential-scope-changed');
        if (!verified && !account) return fail('codex-provider-account-required');
        headers.set('chatgpt-account-id', verified || account!);
      }
      const authenticated = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key']
        .some(name => Boolean(headers.get(name)));
      if (!authenticated && !this.#options.allowAnonymous) return fail('credential-missing');
      const values: Record<string, string> = Object.create(null);
      headers.forEach((value, name) => { values[name] = value; });
      const finalScope = validateScope(await this.#options.currentScope());
      if (!sameScope(finalScope, expected)) return fail('credential-scope-changed');
      return { scope: finalScope, headers: values };
    } catch (error) {
      if (error instanceof NativeCredentialOwnerError) throw error;
      return fail('credential-resolution-failed');
    }
  }
}
