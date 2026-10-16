/** Device authorization protocols. Tokens remain in the existing credential owner. */
import { setTimeout as delay } from 'node:timers/promises';
import type { AccountCredential } from './credentials.js';
import type { ModelOAuthProvider } from './oauth.js';
import type { AuthorizationPrompt } from '../authorization-flows.js';
import { ModelConfigurationError, object } from './configuration.js';

type Token = Extract<AccountCredential['value'], { kind: 'oauth' }>;
const fail = (code: string, message: string): never => { throw new ModelConfigurationError(code, message); };
const required = (body: Record<string, unknown>, key: string): string => typeof body[key] === 'string' && body[key]
  ? body[key] as string : fail('oauth-response-invalid', `Account authorization omitted ${key}`);
async function json(response: Response) {
  const value: unknown = await response.json();
  if (!object(value)) return fail('oauth-response-invalid', 'Account authorization returned an invalid response');
  return value;
}
interface DeviceFlow { id: string; clientId: string; authorize: string; token: string; parameters?: Record<string, string> }
async function form(fetchImpl: typeof fetch, url: string, body: Record<string, string>, signal?: AbortSignal) {
  const response = await fetchImpl(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), ...(signal ? { signal } : {}) });
  return { response, body: await json(response) };
}
async function login(fetchImpl: typeof fetch, flow: DeviceFlow, prompt: AuthorizationPrompt): Promise<Record<string, unknown>> {
  const start = await form(fetchImpl, flow.authorize, { client_id: flow.clientId, ...flow.parameters }, prompt.signal);
  if (!start.response.ok) return fail('oauth-request-failed', `Account authorization failed (${start.response.status})`);
  const device = required(start.body, 'device_code'), code = required(start.body, 'user_code');
  const url = new URL(typeof start.body.verification_uri_complete === 'string' ? start.body.verification_uri_complete : required(start.body, 'verification_uri'));
  if (!['https:', 'http:'].includes(url.protocol)) return fail('oauth-response-invalid', 'Invalid account authorization URL');
  if (!prompt.showDeviceCode) return fail('oauth-device-interaction-unavailable', 'This client cannot display device authorization');
  prompt.showDeviceCode(url, code);
  let interval = typeof start.body.interval === 'number' && start.body.interval > 0 ? start.body.interval : 5; // RFC 8628 default.
  const expires = typeof start.body.expires_in === 'number' && start.body.expires_in > 0 ? Date.now() + start.body.expires_in * 1000 : undefined;
  while (true) {
    await delay(interval * 1000, undefined, { signal: prompt.signal });
    if (expires !== undefined && Date.now() >= expires) return fail('oauth-expired', 'The sign-in code expired. Start sign-in again.');
    const signal = expires === undefined ? prompt.signal : AbortSignal.any([prompt.signal, AbortSignal.timeout(Math.max(1, Math.ceil(expires - Date.now())))]);
    const result = await form(fetchImpl, flow.token, { client_id: flow.clientId, device_code: device, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal);
    if (result.response.ok && typeof result.body.access_token === 'string') return result.body;
    switch (result.body.error) {
      case 'authorization_pending': break;
      case 'slow_down': interval = Math.max(interval + 5, typeof result.body.interval === 'number' ? result.body.interval : 0); break;
      case 'expired_token': return fail('oauth-expired', 'The sign-in code expired. Start sign-in again.');
      case 'access_denied': return fail('oauth-denied', 'Account authorization was declined.');
      default: return fail('oauth-request-failed', `Account authorization failed (${result.response.status})`);
    }
  }
}
function token(flow: DeviceFlow, value: Record<string, unknown>, previous?: Token): Token {
  const expiresIn = value.expires_in ?? (flow.id === 'xai' ? 3600 : undefined);
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return fail('oauth-response-invalid', 'Account authorization omitted token expiry');
  const refreshToken = typeof value.refresh_token === 'string' ? value.refresh_token : previous?.refreshToken;
  return { kind: 'oauth', provider: flow.id, accessToken: required(value, 'access_token'),
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: Date.now() + expiresIn * 1000 };
}
export const COPILOT_HEADERS = {
  'User-Agent': 'Varin', 'Editor-Version': 'vscode/1.107.0', 'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat', 'X-GitHub-Api-Version': '2026-06-01',
};
export function copilotBaseUrl(value: Token): string {
  const host = /(?:^|;)proxy-ep=([^;]+)/.exec(value.accessToken)?.[1];
  return host ? new URL(`https://${host.replace(/^proxy\./, 'api.')}`).origin : 'https://api.individual.githubcopilot.com';
}
export function deviceOAuthProviders(fetchImpl: typeof fetch): ModelOAuthProvider[] {
  const bearer = (value: Token) => ({ authorization: `Bearer ${value.accessToken}` });
  const standard = (flow: DeviceFlow, name: string): ModelOAuthProvider => ({ id: flow.id, name,
    login: async prompt => token(flow, await login(fetchImpl, flow, prompt)),
    refresh: async previous => {
      if (!previous.refreshToken) return fail('oauth-refresh-unavailable', 'Sign in again to renew this account');
      const result = await form(fetchImpl, flow.token, { client_id: flow.clientId, grant_type: 'refresh_token', refresh_token: previous.refreshToken });
      if (!result.response.ok) return fail('oauth-refresh-failed', 'Account renewal failed. Sign in again.');
      return token(flow, result.body, previous);
    }, headers: bearer,
  });
  const copilot: DeviceFlow = { id: 'github-copilot', clientId: 'Iv1.b507a08c87ecfe98', authorize: 'https://github.com/login/device/code', token: 'https://github.com/login/oauth/access_token', parameters: { scope: 'read:user' } };
  const exchangeCopilot = async (githubToken: string, signal?: AbortSignal): Promise<Token> => {
    const response = await fetchImpl('https://api.github.com/copilot_internal/v2/token', { headers: { ...COPILOT_HEADERS, authorization: `Bearer ${githubToken}` }, ...(signal ? { signal } : {}) });
    if (!response.ok) return fail('oauth-copilot-unavailable', 'GitHub Copilot access is unavailable for this account.');
    const body = await json(response);
    if (typeof body.expires_at !== 'number' || !Number.isFinite(body.expires_at)) return fail('oauth-response-invalid', 'Copilot omitted token expiry');
    return { kind: 'oauth', provider: copilot.id, accessToken: required(body, 'token'), refreshToken: githubToken, expiresAt: body.expires_at * 1000 };
  };
  const meta: DeviceFlow = { id: 'meta', clientId: '1031625952748946', authorize: 'https://auth.meta.com/oidc/device/authorization/', token: 'https://auth.meta.com/oidc/device/token/' };
  const mintMeta = async (identity: string, signal?: AbortSignal): Promise<Token> => {
    const response = await fetchImpl('https://api.meta.ai/muse-code/key', { method: 'POST', headers: { authorization: `Bearer ${identity}`, 'content-type': 'application/json', 'x-api-version': '1.0.0' }, body: '{}', ...(signal ? { signal } : {}) });
    if (!response.ok) return fail('oauth-meta-unavailable', 'Meta API access is unavailable. Sign in again.');
    return { kind: 'oauth', provider: meta.id, accessToken: required(await json(response), 'api_key'), refreshToken: identity, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
  };
  return [
    standard({ id: 'kimi-coding', clientId: '17e5f671-d194-4dfb-9706-5516cb48c098', authorize: 'https://auth.kimi.com/api/oauth/device_authorization', token: 'https://auth.kimi.com/api/oauth/token' }, 'Kimi Code'),
    standard({ id: 'xai', clientId: 'b1a00492-073a-47ea-816f-4c329264a828', authorize: 'https://auth.x.ai/oauth2/device/code', token: 'https://auth.x.ai/oauth2/token', parameters: { scope: 'openid profile email offline_access grok-cli:access api:access', referrer: 'varin' } }, 'Grok'),
    { id: copilot.id, name: 'GitHub Copilot', login: async prompt => exchangeCopilot(required(await login(fetchImpl, copilot, prompt), 'access_token'), prompt.signal),
      refresh: previous => exchangeCopilot(previous.refreshToken || fail('oauth-refresh-unavailable', 'Sign in again to renew this account')),
      headers: value => ({ ...COPILOT_HEADERS, ...bearer(value), 'Openai-Intent': 'conversation-edits' }), baseUrl: copilotBaseUrl },
    { id: meta.id, name: 'Meta', login: async prompt => mintMeta(required(await login(fetchImpl, meta, prompt), 'access_token'), prompt.signal),
      refresh: previous => mintMeta(previous.refreshToken || fail('oauth-refresh-unavailable', 'Sign in again to renew this account')), headers: bearer },
  ];
}
