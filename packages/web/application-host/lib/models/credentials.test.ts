import { expect, test, vi } from 'vitest';
import { CredentialService, type AccountCredential, type SecretStore } from './credentials.js';

function fixture() {
  const records = new Map<string, string>();
  const store: SecretStore = {
    read: async reference => records.get(reference) ?? null,
    modify: async (reference, change) => { const next = change(records.get(reference) ?? null); if (next === null) records.delete(reference); else records.set(reference, next); },
  };
  const credentials = new CredentialService('fixture', store);
  const refresh = vi.fn(async (value: Extract<AccountCredential['value'], { kind: 'oauth' }>) => ({ ...value, expiresAt: Date.now() + 60000 }));
  const headers = vi.fn(() => ({ authorization: 'Bearer fixture' }));
  const capture = vi.fn(() => ({ provider: { refresh, headers }, release: vi.fn() }));
  const unregister = credentials.registerOAuth('issuer', { refresh, headers, capture });
  return { records, credentials, refresh, headers, capture, unregister };
}

test('OAuth source admission rejects before provider capture, refresh, headers or storage mutation', async () => {
  const { credentials, records, refresh, headers, capture } = fixture();
  const reference = await credentials.linkOAuth({ kind: 'oauth', provider: 'issuer', accessToken: 'private-token', expiresAt: 0 });
  const source = { kind: 'credential' as const, reference };
  const original = records.get(reference);
  for (const policy of [[], ['other']]) {
    await expect(credentials.captureResolver(source, 'channel', policy)).rejects.toMatchObject({ code: 'oauth-provider-mismatch' });
    await expect(credentials.resolve(source, 'channel', undefined, undefined, policy)).rejects.toMatchObject({ code: 'oauth-provider-mismatch' });
  }
  expect(capture).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled(); expect(headers).not.toHaveBeenCalled();
  expect(records.get(reference)).toBe(original);
});

test('captured OAuth policy and implementation survive caller edits but account replacement does not', async () => {
  const { credentials, refresh, headers, unregister } = fixture();
  const reference = await credentials.linkOAuth({ kind: 'oauth', provider: 'issuer', accessToken: 'fixture', expiresAt: 0 });
  const source = { kind: 'credential' as const, reference };
  const policy = ['issuer'];
  const captured = await credentials.captureResolver(source, 'channel', policy);
  policy.length = 0;
  unregister();
  const replacementHeaders = vi.fn(() => ({ authorization: 'replacement' }));
  credentials.registerOAuth('issuer', { refresh, headers: replacementHeaders });
  expect((await captured.resolve()).auth.headers?.authorization).toBe('Bearer fixture');
  expect(headers).toHaveBeenCalledOnce(); expect(replacementHeaders).not.toHaveBeenCalled();
  await credentials.linkOAuth({ kind: 'oauth', provider: 'issuer', accessToken: 'new-account' }, reference);
  await expect(captured.resolve()).rejects.toMatchObject({ code: 'credential-scope-changed' });
  captured.release();
});

test('API keys remain generic while captured admission also checks later credential contents', async () => {
  const { credentials } = fixture();
  const reference = await credentials.put('fixture-key');
  const source = { kind: 'credential' as const, reference };
  const captured = await credentials.captureResolver(source, 'channel', []);
  expect((await captured.resolve()).auth.apiKey).toBe('fixture-key');
  expect((await credentials.resolve(source, 'channel', undefined, undefined, [])).auth.apiKey).toBe('fixture-key');
  await credentials.linkOAuth({ kind: 'oauth', provider: 'issuer', accessToken: 'fixture' }, reference);
  await expect(captured.resolve()).rejects.toMatchObject({ code: 'oauth-provider-mismatch' });
  captured.release();
});
