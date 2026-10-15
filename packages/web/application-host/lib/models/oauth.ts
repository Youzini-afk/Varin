/** Model account protocols, independent of Pi's provider/runtime registration. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { OAuthProvider, AccountCredential } from './credentials.js';
import type { AuthorizationPrompt } from '../authorization-flows.js';
import { waitWithSignal } from '../cancellation.js';
import { ModelConfigurationError, object } from './configuration.js';

type Token = Extract<AccountCredential['value'], { kind: 'oauth' }>;
export interface ModelOAuthProvider extends OAuthProvider {
  id: string; name: string;
  /** Hold the selected implementation before asynchronous account preparation starts. */
  captureLogin?(): { login(prompt: AuthorizationPrompt): Promise<Token>; release(): void };
  login(prompt: AuthorizationPrompt): Promise<Token>;
}
const fail = (code: string, message: string): never => { throw new ModelConfigurationError(code, message); };
async function post(fetchImpl: typeof fetch, url: string, body: Record<string, string>, json: boolean, signal?: AbortSignal) {
  const response = await fetchImpl(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded' },
    body: json ? JSON.stringify(body) : new URLSearchParams(body), ...(signal ? { signal } : {}) });
  if (!response.ok) return fail('oauth-request-failed', `Account authorization failed (${response.status})`);
  const value: unknown = await response.json(); if (!object(value)) return fail('oauth-response-invalid', 'Account authorization returned an invalid response'); return value;
}
function token(provider: string, value: Record<string, unknown>, previous?: Token): Token {
  if (typeof value.access_token !== 'string' || !value.access_token
    || value.expires_in !== undefined && (typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0)) return fail('oauth-response-invalid', 'Account authorization returned an invalid token');
  return { kind: 'oauth', provider, accessToken: value.access_token,
    ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : previous?.refreshToken ? { refreshToken: previous.refreshToken } : {}),
    ...(typeof value.expires_in === 'number' ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}),
    ...(previous?.accountId ? { accountId: previous.accountId } : {}) };
}
function codexAccount(value: Token) {
  let payload: unknown;
  try { payload = JSON.parse(Buffer.from(value.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')); } catch { return fail('oauth-account-missing', 'The account identity is missing from the authorization token'); }
  const account = object(payload) && object(payload['https://api.openai.com/auth']) ? payload['https://api.openai.com/auth'].chatgpt_account_id : undefined;
  if (typeof account !== 'string' || !account) return fail('oauth-account-missing', 'The account identity is missing from the authorization token');
  return { ...value, accountId: account };
}
interface BrowserFlow {
  id: string; authorize: string; callback: string; clientId?: string; scope?: string; state?: boolean;
  parameters?: Record<string, string>;
  exchange(code: string, verifier: string, state: string, redirect: string, signal: AbortSignal): Promise<Token>;
}
async function browserLogin(flow: BrowserFlow, prompt: AuthorizationPrompt): Promise<Token> {
  prompt.signal.throwIfAborted();
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url'), state = randomUUID();
  const redirect = new URL(flow.callback);
  let accept!: (url: URL) => void;
  const arrived = new Promise<URL>(resolve => { accept = resolve; });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', redirect);
    if (url.pathname !== redirect.pathname || !url.searchParams.get('code') || flow.state !== false && url.searchParams.get('state') !== state) { response.writeHead(400).end('Invalid sign-in callback'); return; }
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Signed in. You can return to Varin.'); accept(url);
  });
  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(redirect.port || 0), '127.0.0.1', () => { listening = true; resolve(); }); });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || !redirect.port) throw error; }
  if (!redirect.port && listening) redirect.port = String((server.address() as { port: number }).port);
  const url = new URL(flow.authorize);
  url.search = new URLSearchParams({ response_type: 'code', ...(flow.clientId ? { client_id: flow.clientId } : {}),
    ...(flow.scope ? { scope: flow.scope } : {}), ...(flow.state === false ? {} : { state }),
    code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: redirect.href, ...flow.parameters }).toString();
  if (flow.id === 'openrouter') { url.searchParams.delete('redirect_uri'); url.searchParams.set('callback_url', redirect.href); }
  const manual = new AbortController();
  try {
    prompt.showAuthorizationUrl(url);
    const result = await waitWithSignal(Promise.race([arrived, prompt.promptForRedirectUrl(manual.signal)]), prompt.signal);
    manual.abort();
    if (!result) return fail('oauth-cancelled', 'Sign-in cancelled');
    let code: string | null, actualState: string | null = null;
    if (result instanceof URL) { code = result.searchParams.get('code'); actualState = result.searchParams.get('state'); }
    else {
      const input = result.trim();
      try { const parsed = new URL(input); code = parsed.searchParams.get('code'); actualState = parsed.searchParams.get('state'); }
      catch { const parts = input.split('#', 2); code = parts[0] ?? null; actualState = parts[1] ?? null; }
    }
    if (!code || flow.state !== false && actualState !== null && actualState !== state) return fail('oauth-callback-invalid', 'The authorization callback does not match this sign-in');
    return await flow.exchange(code, verifier, state, redirect.href, prompt.signal);
  } finally { manual.abort(); if (listening) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } }
}
export function modelOAuthProviders(fetchImpl: typeof fetch): ModelOAuthProvider[] {
  const codexClient = 'app_EMoamEEZ73f0CkXaXp7hrann', anthropicClient = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
  return [
    {
      id: 'openai-codex', name: 'ChatGPT / Codex',
      login: prompt => browserLogin({ id: 'openai-codex', authorize: 'https://auth.openai.com/oauth/authorize', callback: 'http://localhost:1455/auth/callback', clientId: codexClient,
        scope: 'openid profile email offline_access', parameters: { id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'varin' },
        exchange: async (code, verifier, _state, redirect, signal) => codexAccount(token('openai-codex', await post(fetchImpl, 'https://auth.openai.com/oauth/token', { grant_type: 'authorization_code', client_id: codexClient, code, code_verifier: verifier, redirect_uri: redirect }, false, signal))),
      }, prompt),
      refresh: async previous => { if (!previous.refreshToken) return fail('oauth-refresh-unavailable', 'Sign in again to renew this account'); return codexAccount(token('openai-codex', await post(fetchImpl, 'https://auth.openai.com/oauth/token', { grant_type: 'refresh_token', client_id: codexClient, refresh_token: previous.refreshToken }, false), previous)); },
      headers: value => ({ authorization: `Bearer ${value.accessToken}`, 'chatgpt-account-id': value.accountId! }),
    },
    {
      id: 'anthropic', name: 'Claude Pro / Max',
      login: prompt => browserLogin({ id: 'anthropic', authorize: 'https://claude.ai/oauth/authorize', callback: 'http://localhost:53692/callback', clientId: anthropicClient,
        scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
        exchange: async (code, verifier, state, redirect, signal) => token('anthropic', await post(fetchImpl, 'https://platform.claude.com/v1/oauth/token', { grant_type: 'authorization_code', client_id: anthropicClient, code, state, code_verifier: verifier, redirect_uri: redirect }, true, signal)),
      }, prompt),
      refresh: async previous => { if (!previous.refreshToken) return fail('oauth-refresh-unavailable', 'Sign in again to renew this account'); return token('anthropic', await post(fetchImpl, 'https://platform.claude.com/v1/oauth/token', { grant_type: 'refresh_token', client_id: anthropicClient, refresh_token: previous.refreshToken }, true), previous); },
      headers: value => ({ authorization: `Bearer ${value.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }),
    },
    {
      id: 'openrouter', name: 'OpenRouter',
      login: prompt => browserLogin({ id: 'openrouter', authorize: 'https://openrouter.ai/auth', callback: `http://127.0.0.1/oauth/callback/${randomUUID()}`, state: false,
        exchange: async (code, verifier, _state, _redirect, signal) => { const data = await post(fetchImpl, 'https://openrouter.ai/api/v1/auth/keys', { code, code_verifier: verifier, code_challenge_method: 'S256' }, true, signal);
          if (typeof data.key !== 'string' || !data.key) return fail('oauth-response-invalid', 'OpenRouter did not return an API key'); return { kind: 'oauth', provider: 'openrouter', accessToken: data.key }; },
      }, prompt),
      refresh: async value => value,
      headers: value => ({ authorization: `Bearer ${value.accessToken}` }),
    },
  ];
}
