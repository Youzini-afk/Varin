import { createHash, randomBytes } from 'node:crypto';
import type { VarinCredentialAuthenticationCall, VarinCredentialAuthenticationResult, VarinCredentialValue } from '@varin/extension-contract';
export interface OAuthConfiguration { clientId: string; redirectUri: string; clientSecret?: string }
export const scopes = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
export function configuration(env = process.env): OAuthConfiguration {
  const clientId = env.VARIN_GMAIL_CLIENT_ID, redirectUri = env.VARIN_GMAIL_REDIRECT_URI;
  if (!clientId || !redirectUri) throw new Error('Configure VARIN_GMAIL_CLIENT_ID and VARIN_GMAIL_REDIRECT_URI on this Host. Register the callback with Google; remote deployments must provide their own reachable callback page.');
  const url = new URL(redirectUri);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('OAuth callback must be HTTPS or a native loopback URL');
  return { clientId, redirectUri, ...(env.VARIN_GMAIL_CLIENT_SECRET ? { clientSecret: env.VARIN_GMAIL_CLIENT_SECRET } : {}) };
}
export async function authenticate(call: VarinCredentialAuthenticationCall, config: OAuthConfiguration, fetcher = fetch, signal?: AbortSignal): Promise<VarinCredentialAuthenticationResult> {
  if (call.provider !== 'gmail') throw new Error('Invalid Gmail provider');
  if (call.kind === 'begin') {
    const verifier = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: scopes.join(' '), access_type: 'offline', prompt: 'consent', state: nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    return { kind: 'pending', authorizationUrl: url.href, state: { verifier, nonce, clientId: config.clientId, redirectUri: config.redirectUri } };
  }
  const parameters = new URLSearchParams({ client_id: config.clientId, ...(config.clientSecret ? { client_secret: config.clientSecret } : {}) });
  let previous: Extract<VarinCredentialValue, { kind: 'oauth' }> | undefined;
  if (call.kind === 'complete') {
    const state = call.state as { verifier?: string; nonce?: string; clientId?: string; redirectUri?: string }, redirect = new URL(call.redirect), expected = new URL(config.redirectUri);
    if (!state || state.clientId !== config.clientId || state.redirectUri !== config.redirectUri || !state.verifier || !state.nonce || redirect.origin !== expected.origin || redirect.pathname !== expected.pathname || redirect.hash || redirect.searchParams.getAll('state').length !== 1 || redirect.searchParams.get('state') !== state.nonce || redirect.searchParams.getAll('code').length !== 1 || !redirect.searchParams.get('code') || redirect.searchParams.has('error')) throw new Error('OAuth callback or state does not match this sign-in');
    parameters.set('grant_type', 'authorization_code'); parameters.set('code', redirect.searchParams.get('code')!); parameters.set('redirect_uri', config.redirectUri); parameters.set('code_verifier', state.verifier);
  } else {
    previous = call.token;
    if (!previous.refreshToken) throw new Error('Gmail needs reconnection: no refresh token');
    parameters.set('grant_type', 'refresh_token'); parameters.set('refresh_token', previous.refreshToken);
  }
  const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', body: parameters, redirect: 'error', ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`Google token exchange failed (HTTP ${response.status}); reconnect Gmail if authorization expired`);
  const result = await response.json() as Record<string, unknown>;
  if (typeof result.access_token !== 'string' || !result.access_token || typeof result.expires_in !== 'number' || !Number.isFinite(result.expires_in) || result.expires_in <= 0 || result.token_type !== 'Bearer') throw new Error('Invalid Google token response');
  if (typeof result.scope === 'string' && scopes.some(scope => !(result.scope as string).split(' ').includes(scope))) throw new Error('Google did not grant the required Gmail scopes');
  const profile = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${result.access_token}` }, redirect: 'error', ...(signal ? { signal } : {}) });
  if (!profile.ok) throw new Error(`Google account verification failed (HTTP ${profile.status})`);
  const identity = await profile.json() as { emailAddress?: string };
  if (!identity.emailAddress || previous?.accountId && previous.accountId !== identity.emailAddress) throw new Error('Google account identity changed');
  const refreshToken = typeof result.refresh_token === 'string' ? result.refresh_token : previous?.refreshToken;
  return { kind: 'token', token: { kind: 'oauth', provider: 'gmail', accessToken: result.access_token, accountId: identity.emailAddress, expiresAt: Date.now() + result.expires_in * 1000, ...(refreshToken ? { refreshToken } : {}) } };
}
