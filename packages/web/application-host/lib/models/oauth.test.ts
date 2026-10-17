import { expect, test, vi } from 'vitest';
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
  for (const provider of providers.filter(provider => ['openai-codex', 'anthropic', 'openrouter'].includes(provider.id))) {
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

test('device accounts exchange identity tokens, renew inference credentials and stop polling on cancellation', async () => {
  vi.useFakeTimers();
  try {
    for (const id of ['kimi-coding', 'xai', 'github-copilot', 'meta', 'opencode']) {
      let polls = 0;
      const provider = modelOAuthProviders(async (url, init) => {
        const endpoint = String(url), form = Object.fromEntries(new URLSearchParams(String(init?.body)));
        if (endpoint.endsWith('/device_authorization') || endpoint.endsWith('/device/code') || endpoint.endsWith('/device/authorization/')) {
          if (id === 'opencode') { expect(form.client_id).toBe('varin'); expect(form.supports_org_scope).toBe('true'); }
          return Response.json({ device_code: 'private-device', user_code: 'ABCD-1234', verification_uri: id === 'opencode' ? '/console/device?user_code=ABCD-1234' : 'https://example.test/activate', interval: 1, expires_in: 600 });
        }
        if (endpoint.includes('copilot_internal')) {
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access');
          return Response.json({ token: 'proxy-ep=proxy.business.githubcopilot.com;token=fixture', expires_at: Date.now() / 1000 + 3600 });
        }
        if (endpoint.endsWith('/muse-code/key')) {
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access');
          return Response.json({ api_key: 'meta-inference-key' });
        }
        if (form.grant_type === 'refresh_token') {
          expect(form.refresh_token).toBe('refresh');
          return Response.json({ access_token: 'renewed', expires_in: 3600 });
        }
        expect(form.device_code).toBe('private-device');
        if (++polls === 1) return Response.json({ error: 'authorization_pending' }, { status: 400 });
        return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
      }).find(provider => provider.id === id)!;
      const shown = vi.fn();
      const login = provider.login({ signal: new AbortController().signal, showDeviceCode: shown,
        showAuthorizationUrl: () => { throw new Error('Device login must display its code'); }, promptForRedirectUrl: async () => { throw new Error('Device login must not request a callback'); } });
      await vi.advanceTimersByTimeAsync(2000);
      const value = await login;
      expect(shown.mock.calls[0]?.[1]).toBe('ABCD-1234');
      expect(provider.headers(value).authorization).toMatch(/^Bearer /);
      if (id === 'github-copilot') expect(provider.baseUrl?.(value)).toBe('https://api.business.githubcopilot.com');
      if (id === 'meta') expect(value.accessToken).toBe('meta-inference-key');
      const fresh = await provider.refresh(value);
      expect(fresh.refreshToken).toBe(value.refreshToken);
    }
    const request = vi.fn(async () => Response.json({ device_code: 'private-device', user_code: 'ABCD', verification_uri: 'https://example.test/activate', interval: 5, expires_in: 600 }));
    const controller = new AbortController();
    const provider = modelOAuthProviders(request).find(provider => provider.id === 'kimi-coding')!;
    const pending = provider.login({ signal: controller.signal, showDeviceCode: () => controller.abort(), showAuthorizationUrl() {}, promptForRedirectUrl: async () => undefined });
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(10000);
    expect(request).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
