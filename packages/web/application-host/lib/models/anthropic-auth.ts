/** Native Host-owned Anthropic workload identity. Assertions and access tokens stay in memory. */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ConnectionAuthentication } from '@varin/application-client';
import { ModelConfigurationError, object } from './configuration.js';

export type AnthropicFederationConfiguration = Extract<ConnectionAuthentication, { kind: 'anthropic-federation' }>;
interface Assertion { token: string; principal: string }
interface AccessToken { token: string; expiresAt: number }
interface FederationSource {
  identity: string; key: string; principal: string; config: AnthropicFederationConfiguration; endpoint: string;
  token?: AccessToken; pending?: Promise<AccessToken>; advisoryFailedAt?: number;
}
const fail = (code: string, message: string): never => { throw new ModelConfigurationError(code, message); };
const present = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const OAUTH_BETA = 'oauth-2025-04-20';
const FEDERATION_BETA = 'oidc-federation-2026-04-01';

export function federationEndpoint(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return fail('anthropic-federation-endpoint-invalid', 'The workload identity endpoint is invalid'); }
  if (url.username || url.password || url.search || url.hash || url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    return fail('anthropic-federation-endpoint-invalid', 'Workload identity requires HTTPS or a local loopback endpoint without credentials or query parameters');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/oauth/token`;
  return url.toString();
}
export function validateAnthropicFederation(value: Record<string, unknown>, baseUrl: string): void {
  if (Object.keys(value).some(key => !['kind', 'identityTokenFile', 'organizationId', 'federationRuleId', 'serviceAccountId', 'workspaceId'].includes(key))
    || !present(value.identityTokenFile) || !isAbsolute(value.identityTokenFile)
    || !present(value.organizationId) || !present(value.federationRuleId)
    || value.serviceAccountId !== undefined && !present(value.serviceAccountId)
    || value.workspaceId !== undefined && !present(value.workspaceId)) {
    return fail('channel-auth-invalid', 'Workload identity requires an absolute identity-token file, organization and federation rule');
  }
  federationEndpoint(baseUrl);
}
async function readAssertion(file: string): Promise<Assertion> {
  let token: string;
  try { token = (await readFile(file, 'utf8')).trim(); }
  catch { return fail('anthropic-identity-token-unavailable', 'The workload identity file is unavailable'); }
  try {
    // The exchange protocol limits assertions to 16 KiB. Claims here identify a source;
    // only the exchange service validates its signature, issuer, audience and expiry.
    if (Buffer.byteLength(token) > 16 * 1024) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    if (!object(claims)) throw new Error();
    const audience = typeof claims.aud === 'string' ? [claims.aud]
      : Array.isArray(claims.aud) && claims.aud.every(present) ? [...claims.aud].sort() : undefined;
    if (!present(claims.iss) || !present(claims.sub) || !audience?.length || audience.some(value => !value)) throw new Error();
    return { token, principal: JSON.stringify([claims.iss, claims.sub, audience]) };
  } catch { return fail('anthropic-identity-token-invalid', 'The workload identity file does not contain a valid JWT assertion'); }
}

export class AnthropicCredentialOwner {
  readonly #sources = new Map<string, FederationSource>();
  constructor(readonly fetchImpl: typeof fetch = globalThis.fetch, readonly now: () => number = Date.now) {}
  forget(reference: string) { this.#sources.delete(reference); }
  async source(reference: string, baseUrl: string, config: AnthropicFederationConfiguration): Promise<FederationSource> {
    validateAnthropicFederation(config, baseUrl);
    let assertion: Assertion;
    try { assertion = await readAssertion(config.identityTokenFile); }
    catch (error) { this.forget(reference); throw error; }
    const endpoint = federationEndpoint(baseUrl);
    const key = JSON.stringify([endpoint, config]);
    const previous = this.#sources.get(reference);
    if (previous?.key === key && previous.principal === assertion.principal) return previous;
    const source = { identity: randomUUID(), key, principal: assertion.principal, config: structuredClone(config), endpoint };
    this.#sources.set(reference, source);
    return source;
  }
  async #assertCurrent(reference: string, source: FederationSource): Promise<Assertion> {
    let assertion: Assertion;
    try { assertion = await readAssertion(source.config.identityTokenFile); }
    catch (error) { if (this.#sources.get(reference) === source) this.forget(reference); throw error; }
    if (this.#sources.get(reference) !== source || source.principal !== assertion.principal) {
      if (this.#sources.get(reference) === source) this.forget(reference);
      return fail('credential-scope-changed', 'The workload identity changed');
    }
    return assertion;
  }
  #refresh(reference: string, source: FederationSource): Promise<AccessToken> {
    if (source.pending) return source.pending;
    const work = (async () => {
      const assertion = await this.#assertCurrent(reference, source);
      const config = source.config;
      const response = await this.fetchImpl(source.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', 'anthropic-beta': `${OAUTH_BETA},${FEDERATION_BETA}` },
        body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion.token,
          organization_id: config.organizationId, federation_rule_id: config.federationRuleId,
          ...(config.serviceAccountId ? { service_account_id: config.serviceAccountId } : {}), ...(config.workspaceId ? { workspace_id: config.workspaceId } : {}) }),
      });
      // Never expose remote error bodies, JWT claims, credentials, or fetch exceptions.
      const body: unknown = await response.json();
      if (!response.ok || !object(body) || !present(body.access_token) || typeof body.expires_in !== 'number'
        || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.token_type !== undefined && body.token_type !== 'Bearer') {
        return fail('anthropic-federation-resolution-failed', 'Workload identity token exchange failed');
      }
      await this.#assertCurrent(reference, source);
      const token = { token: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
      source.token = token;
      return token;
    })().catch(() => fail('anthropic-federation-resolution-failed', 'Workload identity token exchange failed'));
    source.pending = work;
    void work.finally(() => { if (source.pending === work) delete source.pending; }).catch(() => {});
    return work;
  }
  async headers(reference: string, source: FederationSource): Promise<Record<string, string>> {
    await this.#assertCurrent(reference, source);
    let token = source.token;
    const remaining = token ? token.expiresAt - this.now() : 0;
    if (!token || remaining <= 30_000) token = await this.#refresh(reference, source);
    else if (remaining <= 120_000 && (source.advisoryFailedAt === undefined || this.now() - source.advisoryFailedAt >= 5_000)) {
      // A coalesced advisory refresh may finish after its caller leaves. The owner
      // retains it, and rechecks the current identity before publishing its result.
      void this.#refresh(reference, source).catch(() => { source.advisoryFailedAt = this.now(); });
    }
    await this.#assertCurrent(reference, source);
    return { authorization: `Bearer ${token.token}`, 'anthropic-beta': OAUTH_BETA };
  }
}
