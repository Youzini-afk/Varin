import { expect, test } from 'vitest';
import { modelOAuthProviders } from './oauth.js';

test('browser account protocols exchange PKCE callbacks and preserve their actual account headers', async () => {
  const access = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })).toString('base64url')}.signature`;
  const calls: Array<{ url: string; body: Record<string, string> }> = [];
  const providers = modelOAuthProviders(async (url, init) => {
    const json = new Headers(init?.headers).get('content-type') === 'application/json';
    const body = json ? JSON.parse(String(init?.body)) : Object.fromEntries(new URLSearchParams(String(init?.body)));
    calls.push({ url: String(url), body });
    return Response.json(String(url).endsWith('/auth/keys') ? { key: 'router-key' } : { access_token: access, refresh_token: 'refresh', expires_in: 3600 });
  });
  for (const provider of providers) {
    let authorize!: URL;
    const result = await provider.login({ signal: new AbortController().signal, showAuthorizationUrl: url => { authorize = url; },
      promptForRedirectUrl: async () => {
        const callback = new URL(authorize.searchParams.get(provider.id === 'openrouter' ? 'callback_url' : 'redirect_uri')!);
        callback.searchParams.set('code', 'authorization-code');
        if (authorize.searchParams.has('state')) callback.searchParams.set('state', authorize.searchParams.get('state')!);
        return callback.href;
      },
    });
    const exchange = calls.at(-1)!;
    expect(exchange.body.code).toBe('authorization-code');
    expect(exchange.body.code_verifier).toBeTruthy();
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(provider.headers(result).authorization).toBe(`Bearer ${provider.id === 'openrouter' ? 'router-key' : access}`);
    if (provider.id === 'openai-codex') expect(provider.headers(result)['chatgpt-account-id']).toBe('account');
    if (provider.id === 'openrouter') expect(result.expiresAt).toBeUndefined();
    else { await provider.refresh(result); expect(calls.at(-1)!.body.grant_type).toBe('refresh_token'); }
  }
});
