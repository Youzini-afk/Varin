/** Locked Anthropic federation exchange/cache, owned by the Host and never persisted. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface AccessToken { token: string; expiresAt: number | null }
interface TokenCache { getToken(): Promise<string> }
interface FederationSdk {
  oidcFederationProvider(options: { identityTokenProvider: () => Promise<string>; federationRuleId: string;
    organizationId: string; serviceAccountId?: string; workspaceId?: string; baseURL: string; fetch: typeof fetch }): () => Promise<AccessToken>;
  TokenCache: new (provider: () => Promise<AccessToken>) => TokenCache;
  OAUTH_API_BETA_HEADER: string;
}
interface FederationConfig { baseURL: string; organizationId: string; federationRuleId: string;
  identityTokenFile: string; serviceAccountId?: string; workspaceId?: string }
export interface AnthropicFederationSource { identity: string; cache: Promise<TokenCache>; beta: Promise<string> }
let sdkPromise: Promise<FederationSdk> | undefined;
function federationSdk(): Promise<FederationSdk> {
  if (!sdkPromise) {
    const ai = createRequire(import.meta.resolve('@earendil-works/pi-ai'));
    const entry = pathToFileURL(ai.resolve('@anthropic-ai/sdk'));
    // These are the same helpers the locked SDK client composes for explicit federation.
    sdkPromise = Promise.all(['oidc-federation', 'token-cache', 'types'].map(name =>
      import(new URL(`./lib/credentials/${name}.mjs`, entry).href)))
      .then(([exchange, cache, types]) => ({ oidcFederationProvider: exchange!.oidcFederationProvider,
        TokenCache: cache!.TokenCache, OAUTH_API_BETA_HEADER: types!.OAUTH_API_BETA_HEADER }) as FederationSdk);
  }
  return sdkPromise;
}
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
async function assertion(path: string): Promise<{ token: string; principal: string }> {
  let token: string;
  try { token = (await readFile(path, 'utf8')).trim(); }
  catch { return fail('anthropic-identity-token-unavailable'); }
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return fail('anthropic-identity-token-invalid');
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    const audience = typeof claims.aud === 'string' ? [claims.aud]
      : Array.isArray(claims.aud) && claims.aud.every(value => typeof value === 'string') ? [...claims.aud].sort() : undefined;
    if (typeof claims.iss !== 'string' || !claims.iss || typeof claims.sub !== 'string' || !claims.sub || !audience?.length) {
      return fail('anthropic-identity-token-invalid');
    }
    // This is equality/routing metadata, NOT JWT validation. The exchange service validates
    // issuer/signature/audience. No claims or token-derived digest enters durable scope.
    return { token, principal: JSON.stringify([claims.iss, claims.sub, audience]) };
  } catch { return fail('anthropic-identity-token-invalid'); }
}
export class NativeAnthropicCredentialOwner {
  readonly #sources = new Map<string, AnthropicFederationSource>();
  async source(baseURL: string, env?: Record<string, string>): Promise<AnthropicFederationSource | undefined> {
    const value = (name: string) => env?.[name] || process.env[name];
    const organizationId = value('ANTHROPIC_ORGANIZATION_ID');
    const federationRuleId = value('ANTHROPIC_FEDERATION_RULE_ID');
    const file = value('ANTHROPIC_IDENTITY_TOKEN_FILE');
    if (!organizationId || !federationRuleId || !file) return undefined;
    const serviceAccountId = value('ANTHROPIC_SERVICE_ACCOUNT_ID');
    const workspaceId = value('ANTHROPIC_WORKSPACE_ID');
    const config: FederationConfig = { baseURL: baseURL.replace(/\/+$/, ''), organizationId, federationRuleId,
      identityTokenFile: resolve(file), ...(serviceAccountId ? { serviceAccountId } : {}), ...(workspaceId ? { workspaceId } : {}) };
    const { principal } = await assertion(config.identityTokenFile);
    const key = JSON.stringify([config, principal]);
    const old = this.#sources.get(key);
    if (old) return old;
    const sdk = federationSdk();
    const source: AnthropicFederationSource = { identity: randomUUID(), beta: sdk.then(value => value.OAUTH_API_BETA_HEADER),
      cache: sdk.then(({ oidcFederationProvider, TokenCache }) => new TokenCache(oidcFederationProvider({
        ...config,
        // The trusted exchange endpoint may not forward an assertion to another target.
        // Keep the SDK's exchange/refresh contract, but do not follow credential redirects.
        fetch: (input, init) => globalThis.fetch(input, { ...init, redirect: 'error' }),
        identityTokenProvider: async () => {
          const current = await assertion(config.identityTokenFile);
          if (current.principal !== principal) return fail('anthropic-credential-principal-changed');
          return current.token;
        },
      }))) };
    this.#sources.set(key, source);
    return source;
  }
  async headers(source: AnthropicFederationSource): Promise<Record<string, string>> {
    try { return { authorization: `Bearer ${await (await source.cache).getToken()}`, 'anthropic-beta': await source.beta }; }
    catch { return fail('anthropic-federation-resolution-failed'); }
  }
}
