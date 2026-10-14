import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicCredentialOwner, federationEndpoint } from './anthropic-auth.js';
import { ModelsService } from './service.js';
import { createModelAuthority } from '../kernel/model-authority.js';
import type { ModelChannel } from '@varin/application-client';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const assertion = (sub = 'principal-one', nonce = 'first') => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'https://issuer.invalid', sub, aud: ['anthropic'], exp: 2000000000, nonce })).toString('base64url')}.signature`;
const token = 'fixture-access-token';
async function fixture(fetchImpl: typeof fetch = async () => Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 })) {
  const directory = await mkdtemp(join(tmpdir(), 'varin-native-federation-')); roots.push(directory);
  const file = join(directory, 'assertion.jwt'); await writeFile(file, assertion());
  const auth = { kind: 'anthropic-federation' as const, identityTokenFile: file, organizationId: 'org-fixture', federationRuleId: 'rule-fixture', workspaceId: 'workspace-fixture', serviceAccountId: 'service-fixture' };
  const models = new ModelsService(directory, { projectTrusted: () => false, fetch: fetchImpl });
  const channel: ModelChannel = { id: 'anthropic', name: 'Anthropic', type: 'anthropic', enabled: true, baseUrl: 'https://anthropic.invalid/v1', authentication: auth, parameters: {},
    connection: { headers: { 'anthropic-beta': 'fixture-feature' } }, models: [{ id: 'claude-fixture', name: 'Claude', enabled: true, operations: ['chat'], maxOutputTokens: 128 }] };
  await models.save(channel, (await models.read()).revision);
  return { directory, file, auth, models, channel };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it('native authority exchanges explicit WIF once, scopes headers, and persists no JWT or minted token', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const f = await fixture(async (url, init) => { requests.push({ url: String(url), init: init! }); return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 }); });
  const binding = await createModelAuthority(f.models).resolveModel({ providerId: f.channel.id, modelId: 'claude-fixture' });
  try {
    expect(binding.configuration.anthropicOauth).toBe(false);
    const scope = await binding.credentialOwner.scope();
    const resolved = await binding.credentialOwner.resolve(scope);
    expect(resolved.headers).toEqual({ authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://anthropic.invalid/v1/oauth/token');
    expect(requests[0]!.init.redirect).toBe('error');
    expect(new Headers(requests[0]!.init.headers).get('anthropic-beta')).toBe('oauth-2025-04-20,oidc-federation-2026-04-01');
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({ assertion: assertion(), grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', organization_id: 'org-fixture', federation_rule_id: 'rule-fixture', workspace_id: 'workspace-fixture', service_account_id: 'service-fixture' });
    const publicState = JSON.stringify({ catalog: await f.models.read(), scope, configuration: binding.configuration });
    for (const secret of [token, assertion(), 'principal-one', 'https://issuer.invalid']) expect(publicState).not.toContain(secret);
    expect(await readdir(f.directory)).not.toContain('model-auth.json');
    const config = await readFile(join(f.directory, 'models.json'), 'utf8'); expect(config).not.toContain(token); expect(config).not.toContain(assertion());
  } finally { binding.credentialOwner.release(); }
});

it('retains subscription auth mode separately from federation bearer headers', async () => {
  const f = await fixture();
  await f.models.credentials.linkOAuth({ kind: 'oauth', provider: 'anthropic', accessToken: 'subscription-token', expiresAt: Date.now() + 3600_000 }, 'subscription');
  await f.models.save({ ...f.channel, authentication: { kind: 'credential', reference: 'subscription' } }, (await f.models.read()).revision);
  const binding = await createModelAuthority(f.models).resolveModel({ providerId: f.channel.id, modelId: 'claude-fixture' });
  try { expect(binding.configuration.anthropicOauth).toBe(true); expect((await binding.credentialOwner.resolve(await binding.credentialOwner.scope())).headers.authorization).toBe('Bearer subscription-token'); }
  finally { binding.credentialOwner.release(); }
});

it('normal assertion rotation preserves identity; changed or withdrawn principals invalidate captured selections', async () => {
  const f = await fixture(); const capture = await f.models.captureModel(f.channel.id, 'claude-fixture');
  const scope = await capture.authority.currentScope(f.channel.id);
  await writeFile(f.file, assertion('principal-one', 'rotated'));
  expect(await capture.authority.currentScope(f.channel.id)).toEqual(scope);
  await writeFile(f.file, assertion('principal-two'));
  await expect(capture.authority.getAuth(f.channel.id)).rejects.toMatchObject({ code: 'credential-scope-changed' });
  const second = await f.models.currentScope(f.channel.id); expect(second.account).not.toBe(scope.account);
  await rm(f.file); await expect(f.models.getAuth(f.channel.id)).rejects.toMatchObject({ code: 'anthropic-identity-token-unavailable' });
  await writeFile(f.file, assertion()); expect((await f.models.currentScope(f.channel.id)).account).not.toBe(scope.account);
  capture.release();
});

it('explicit channel removal and disable/re-enable do not resurrect old federation handles', async () => {
  const f = await fixture(); const capture = await f.models.captureModel(f.channel.id, 'claude-fixture');
  await f.models.save({ ...f.channel, enabled: false }, (await f.models.read()).revision);
  await f.models.save(f.channel, (await f.models.read()).revision);
  await expect(capture.authority.getAuth(f.channel.id)).rejects.toMatchObject({ code: 'credential-scope-changed' });
  const second = await f.models.captureModel(f.channel.id, 'claude-fixture');
  await f.models.remove(f.channel.id, (await f.models.read()).revision); await f.models.save(f.channel, (await f.models.read()).revision);
  await expect(second.authority.getAuth(f.channel.id)).rejects.toMatchObject({ code: 'credential-scope-changed' });
  capture.release(); second.release();
});

it('coalesces exchange and rejects an in-flight token after identity withdrawal without leaking remote errors', async () => {
  const entered = deferred(), release = deferred(); let requests = 0;
  const f = await fixture(async () => { requests++; entered.resolve(); await release.promise; return Response.json({ access_token: token, expires_in: 3600 }); });
  const first = f.models.getAuth(f.channel.id).catch(error => error), second = f.models.getAuth(f.channel.id).catch(error => error);
  await entered.promise; await rm(f.file); release.resolve();
  const results = await Promise.all([first, second]); expect(requests).toBe(1);
  for (const error of results) { expect(error).toMatchObject({ code: 'anthropic-federation-resolution-failed' }); expect(String(error)).not.toContain(token); expect(String(error)).not.toContain(assertion()); }
});

it('refreshes cached federation tokens with a coalesced advisory/mandatory boundary', async () => {
  const f = await fixture(); let now = 1_000_000, requests = 0;
  const owner = new AnthropicCredentialOwner(async () => { requests++; return Response.json({ access_token: `token-${requests}`, expires_in: 180 }); }, () => now);
  const source = await owner.source('channel', f.channel.baseUrl, f.auth);
  expect((await owner.headers('channel', source)).authorization).toBe('Bearer token-1');
  now += 61_000; expect((await owner.headers('channel', source)).authorization).toBe('Bearer token-1');
  // Mandatory consumers join the same advisory refresh instead of duplicating it.
  now += 100_000; const values = await Promise.all([owner.headers('channel', source), owner.headers('channel', source)]);
  expect(requests).toBe(2); expect(values.map(value => value.authorization)).toEqual(['Bearer token-2', 'Bearer token-2']);
});

it('rejects credential redirects, insecure endpoints and embedded assertion configuration before exchange', async () => {
  expect(() => federationEndpoint('http://external.invalid/v1')).toThrow();
  expect(() => federationEndpoint('https://external.invalid/v1?key=secret')).toThrow();
  expect(federationEndpoint('http://127.0.0.1:1234/router/v1')).toBe('http://127.0.0.1:1234/router/v1/oauth/token');
  const f = await fixture(async () => { throw new Error(`remote echo ${token} ${assertion()}`); });
  await expect(f.models.save({ ...f.channel, authentication: { ...f.auth, assertion: assertion() } } as ModelChannel, (await f.models.read()).revision)).rejects.toMatchObject({ code: 'channel-auth-invalid' });
  const error = await f.models.getAuth(f.channel.id).catch(error => error); expect(error.code).toBe('anthropic-federation-resolution-failed'); expect(String(error)).not.toContain(token); expect(String(error)).not.toContain(assertion());
});
