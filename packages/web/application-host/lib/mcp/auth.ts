/** MCP grants own their file; model accounts share the storage primitive and sign-in interaction contract. */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createSettingsFileStore } from '@varin/settings-store';
import { auth, extractWWWAuthenticateParams, type OAuthClientProvider, type OAuthClientMetadata, type StoredOAuthClientInformation, type StoredOAuthTokens, type OAuthDiscoveryState } from '@modelcontextprotocol/client';
import { fileSecretStore } from '../models/credentials.js';
import { object } from '../models/configuration.js';
import { waitWithSignal } from '../cancellation.js';
export interface McpOAuthSettings { clientId?: string; clientSecret?: string; callbackPort?: number; callbackUrl?: string; scope?: string; clientName?: string }
export interface McpOAuthState {
  tokens?: StoredOAuthTokens; client?: StoredOAuthClientInformation; verifier?: string; discovery?: OAuthDiscoveryState;
  expiresAt?: number; redirectUrl?: string; state?: string; bindingAccount?: string;
}
export interface McpOAuthServerStore { load(): McpOAuthState | undefined; save(state: McpOAuthState): Promise<void>; withRefreshLock<T>(action: () => Promise<T>): Promise<T> }
export interface McpSignInPrompt { signal?: AbortSignal; showAuthorizationUrl(url: URL): void; promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined> }
const refreshes = new Map<string, Promise<unknown>>();
export const mcpCredentialPath = (directory: string) => join(directory, 'mcp-auth.json');
export class McpOAuthCredentialStore {
  readonly #file;
  readonly #secrets;
  #document: Record<string, unknown> | undefined;
  #error: unknown;
  #pending: Promise<void> | undefined;
  #revision = 0;
  constructor(readonly directory: string) { this.#file = createSettingsFileStore({ filePath: mcpCredentialPath(directory) }); this.#secrets = fileSecretStore(this.#file.filePath); }
  prepare(reload = false): Promise<void> {
    if (!reload && this.#document && !this.#pending) return Promise.resolve();
    if (reload) this.#revision++;
    if (!this.#pending) {
      const work = (async () => {
        for (;;) {
          const revision = this.#revision;
          try {
            const document = await this.#file.read();
            if (revision !== this.#revision) continue;
            this.#document = document; this.#error = undefined;
          } catch (error) {
            if (revision !== this.#revision) continue;
            this.#error = error;
          }
          return;
        }
      })();
      this.#pending = work;
      void work.finally(() => { if (this.#pending === work) this.#pending = undefined; });
    }
    return this.#pending;
  }
  #key(name: string, url: string) { return `mcp:${createHash('sha256').update(JSON.stringify([name, url])).digest('hex')}`; }
  #record(name: string, url: string): { account: string; state: McpOAuthState } | undefined {
    const key = this.#key(name, url), document = this.#document;
    // Keep the last valid bytes for recovery, but an unsuccessful reload cannot prove
    // that their grant is still current. Do not dispatch with a stale credential.
    if (this.#error !== undefined) throw new Error('MCP credential store is unavailable');
    if (!document) throw this.#error ?? new Error('MCP credentials have not been prepared');
    if (!Object.hasOwn(document, key)) return undefined;
    const value = document[key];
    if (!object(value) || value.version !== 1 || typeof value.account !== 'string' || !object(value.state)) throw new Error('MCP credential is invalid');
    return value as unknown as { account: string; state: McpOAuthState };
  }
  binding(name: string, url: string) { const record = this.#record(name, url); return record ? { reference: record.account, generation: 1,
    ...(record.state.tokens?.scope === undefined ? {} : { scope: [...new Set(record.state.tokens.scope.split(/\s+/).filter(Boolean))].sort().join(' ') }) } : undefined; }
  tokens(name: string, url: string) { return this.#record(name, url)?.state.tokens; }
  async remove(name: string, url: string) {
    let existed = false;
    await this.#secrets.modify(this.#key(name, url), current => { existed = current !== null; return null; });
    this.#revision++;
    if (this.#document) delete this.#document[this.#key(name, url)];
    return existed;
  }
  forServer(name: string, url: string): McpOAuthServerStore {
    const key = this.#key(name, url);
    let expected = this.#record(name, url)?.account;
    return {
      load: () => { const state = this.#record(name, url)?.state; return state ? structuredClone(state) : undefined; },
      save: async state => {
        let savedRecord: { version: 1; account: string; state: McpOAuthState } | undefined;
        await this.#secrets.modify(key, raw => {
          const current = raw === null ? undefined : JSON.parse(raw) as { account: string; state: McpOAuthState };
          if (current?.account !== expected) throw new Error('MCP account changed while authenticating');
          const account = state.bindingAccount ?? current?.account ?? randomUUID();
          const { bindingAccount: _binding, ...saved } = state;
          savedRecord = { version: 1, account, state: saved };
          return JSON.stringify(savedRecord);
        });
        expected = savedRecord!.account;
        this.#revision++;
        this.#document ??= {};
        this.#error = undefined;
        Object.defineProperty(this.#document, key, { value: structuredClone(savedRecord), enumerable: true, writable: true, configurable: true });
      },
      withRefreshLock: async action => {
        const refreshKey = JSON.stringify([this.#file.filePath, key, expected]);
        let work = refreshes.get(refreshKey);
        if (!work) { work = action(); refreshes.set(refreshKey, work); void work.then(() => { if (refreshes.get(refreshKey) === work) refreshes.delete(refreshKey); }, () => { if (refreshes.get(refreshKey) === work) refreshes.delete(refreshKey); }); }
        return work as Promise<Awaited<ReturnType<typeof action>>>;
      },
    };
  }
}
/** Service headers belong only to the configured resource origin. SDK OAuth headers
 * take precedence, and credential-bearing requests cannot acquire a redirect target. */
export function mcpOAuthFetch(serverUrl: string, serviceHeaders: Record<string, string>, fetchImpl: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  const origin = new URL(serverUrl).origin;
  let configured: Headers;
  try { configured = new Headers(serviceHeaders); }
  catch { throw new TypeError('MCP OAuth headers are invalid'); }
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const sameOrigin = new URL(request?.url ?? String(input)).origin === origin;
    const headers = new Headers(sameOrigin ? configured : undefined);
    const protectedRequest = sameOrigin && [...configured].length > 0;
    new Headers(init?.headers ?? request?.headers).forEach((value, key) => headers.set(key, value));
    try {
      const response = await fetchImpl(input, { ...init, headers, ...(protectedRequest ? { redirect: 'error' } : {}) });
      // A custom fetch port may expose a redirect response instead of enforcing error.
      // Reject it here too, before the SDK's same-origin redirect loop can follow it.
      if (protectedRequest && (response.type === 'opaqueredirect' || [301, 302, 303, 307, 308].includes(response.status))) {
        await response.body?.cancel(); throw new TypeError('MCP OAuth HTTP request failed');
      }
      return response;
    } catch (error) {
      if (protectedRequest) throw new TypeError('MCP OAuth HTTP request failed');
      throw error;
    }
  };
}
export function oauthProvider(options: { store: Pick<McpOAuthServerStore, 'load' | 'save'>; settings: McpOAuthSettings; redirectUrl: string; redirect?(url: URL): void; replace?: boolean }): OAuthClientProvider {
  const update = async (patch: Partial<McpOAuthState>) => options.store.save({ ...options.store.load(), ...patch });
  return {
    redirectUrl: options.redirectUrl,
    clientMetadata: { client_name: options.settings.clientName ?? 'Varin', redirect_uris: [options.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: options.settings.clientSecret ? 'client_secret_post' : 'none', ...(options.settings.scope ? { scope: options.settings.scope } : {}) } as OAuthClientMetadata,
    state: () => options.store.load()?.state ?? '',
    clientInformation: () => {
      const saved = options.store.load()?.client;
      if (!options.settings.clientId) return saved;
      // The SDK stamps configured clients too. Preserve that original issuer evidence
      // instead of presenting the same secret as a fresh, unbound client every time.
      const configured = { client_id: options.settings.clientId, ...(options.settings.clientSecret ? { client_secret: options.settings.clientSecret } : {}) };
      return saved?.client_id === configured.client_id && saved.client_secret === configured.client_secret ? saved : configured;
    },
    saveClientInformation: client => update({ client }),
    tokens: () => options.store.load()?.tokens,
    saveTokens: tokens => {
      const { expiresAt: _expiry, ...current } = options.store.load() ?? {};
      return options.store.save({ ...current, tokens: { ...tokens, ...(tokens.scope === undefined && current.tokens?.scope !== undefined ? { scope: current.tokens.scope } : {}) },
        ...(tokens.expires_in === undefined ? {} : { expiresAt: Date.now() + tokens.expires_in * 1000 }),
        ...(options.replace ? { bindingAccount: randomUUID() } : {}) });
    },
    redirectToAuthorization: url => { if (!options.redirect) throw Object.assign(new Error('MCP sign-in required'), { status: 401 }); options.redirect(url); },
    saveCodeVerifier: verifier => update({ verifier, redirectUrl: options.redirectUrl }),
    codeVerifier: () => { const verifier = options.store.load()?.verifier; if (!verifier) throw new Error('MCP sign-in verifier is unavailable'); return verifier; },
    saveDiscoveryState: discovery => update({ discovery }),
    discoveryState: () => options.store.load()?.discovery,
  };
}
/** A caller may cancel its wait; account-owned refresh still finishes saving any rotated token. */
export function mcpAuthProvider(name: string, url: string, credentials: McpOAuthCredentialStore, settings: McpOAuthSettings, fetchImpl?: typeof globalThis.fetch) {
  const expected = JSON.stringify(credentials.binding(name, url));
  const store = credentials.forServer(name, url);
  return { token: async () => {
    if (JSON.stringify(credentials.binding(name, url)) !== expected) throw new Error('MCP credential changed');
    const state = store.load();
    if (!state?.tokens) return undefined;
    if (state.expiresAt !== undefined && state.expiresAt <= Date.now()) {
      await store.withRefreshLock(async () => {
      const current = store.load();
      if (current?.expiresAt !== undefined && current.expiresAt <= Date.now()) {
        await auth(oauthProvider({ store, settings, redirectUrl: current.redirectUrl ?? 'http://127.0.0.1/' }), { serverUrl: url, ...(settings.scope ? { scope: settings.scope } : {}), ...(fetchImpl ? { fetchFn: fetchImpl } : {}) });
      }
      });
      // Another consumer may have owned this shared refresh; publish its saved result here too.
      await credentials.prepare(true);
    }
    if (JSON.stringify(credentials.binding(name, url)) !== expected) throw new Error('MCP credential changed');
    return store.load()?.tokens?.access_token;
  } };
}
export async function signInMcpServer(options: { serverUrl: string; store: Pick<McpOAuthServerStore, 'load' | 'save'>; settings: McpOAuthSettings; challenge?: unknown; prompt: McpSignInPrompt; fetch?: typeof globalThis.fetch }) {
  options.prompt.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = options.prompt.signal ? AbortSignal.any([controller.signal, options.prompt.signal]) : controller.signal;
  const state = randomUUID();
  let callback!: (value: URL) => void;
  const arrived = new Promise<URL>(resolve => { callback = resolve; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('state') !== state || !url.searchParams.get('code') && !url.searchParams.get('error')) { response.writeHead(400).end('Invalid sign-in callback'); return; }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(url.searchParams.get('error')
      ? 'Sign-in was not authorized. You can return to Varin.' : 'Signed in. You can return to Varin.'); callback(url);
  });
  const configured = options.settings.callbackUrl ? new URL(options.settings.callbackUrl) : undefined;
  if (configured && (configured.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname))) throw new Error('OAuth callback must use a local HTTP address');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(configured?.port ? Number(configured.port) : options.settings.callbackPort ?? 0, configured?.hostname === '[::1]' ? '::1' : configured?.hostname ?? '127.0.0.1', resolve); });
  try {
    const port = (server.address() as { port: number }).port;
    if (configured && !configured.port) configured.port = String(port);
    const redirectUrl = configured?.toString() ?? `http://127.0.0.1:${port}/callback`;
    const challenge = typeof options.challenge === 'string' ? extractWWWAuthenticateParams(new Response(null, { headers: { 'www-authenticate': options.challenge } })) : undefined;
    const scope = [...new Set([options.settings.scope, challenge?.scope].filter(Boolean).flatMap(value => value!.split(/\s+/)))].join(' ');
    const fetchFn: typeof globalThis.fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, { ...init,
      ...(options.prompt.signal ? { signal: init?.signal ? AbortSignal.any([options.prompt.signal, init.signal]) : options.prompt.signal } : {}) });
    const authOptions = { serverUrl: options.serverUrl, fetchFn, ...(scope ? { scope } : {}), ...(challenge?.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}) };
    await options.store.save({ ...options.store.load(), state });
    const provider = oauthProvider({ store: options.store, settings: options.settings, redirectUrl, redirect: url => options.prompt.showAuthorizationUrl(url), replace: true });
    const result = await auth(provider, { ...authOptions, forceReauthorization: true });
    if (result === 'AUTHORIZED') return;
    const manual = options.prompt.promptForRedirectUrl(signal).then(value => value ? new URL(value) : Promise.reject(new Error('MCP sign-in cancelled')));
    const url = await waitWithSignal(Promise.race([arrived, manual]), signal);
    controller.abort();
    if (url.searchParams.get('state') !== state) throw new Error('Invalid sign-in callback');
    if (url.searchParams.get('error')) throw new Error('MCP sign-in was not authorized');
    if (!url.searchParams.get('code')) throw new Error('Invalid sign-in callback');
    const authorizationCode = url.searchParams.get('code')!;
    if (await auth(provider, { ...authOptions, authorizationCode, ...(url.searchParams.get('iss') ? { iss: url.searchParams.get('iss')! } : {}) }) !== 'AUTHORIZED') throw new Error('MCP sign-in did not complete');
  } finally { controller.abort(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
