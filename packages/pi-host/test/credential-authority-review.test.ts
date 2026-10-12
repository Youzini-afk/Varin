import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostCredentialAuthority } from '../src/credential-authority.js';

const credential = (version: string, accountId = 'fake-provider-account') => ({
  type: 'oauth' as const, access: `fake-access-${version}`, refresh: `fake-refresh-${version}`,
  expires: 2_000_000_000_000, accountId,
});

test('existing credential file commits rotation and binding metadata together, retaining identity across reopen', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-credential-authority-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authority = HostCredentialAuthority.open(directory);
  await authority.modifyWithIntent('fixture-provider', 'replace', async () => credential('initial'));
  const before = await authority.currentScope('fixture-provider');
  assert.notEqual(before.account, 'fake-provider-account');
  assert.equal(await authority.currentProviderAccount('fixture-provider'), 'fake-provider-account');
  await authority.modifyWithIntent('fixture-provider', 'refresh', async current => {
    assert.equal(current?.type, 'oauth');
    assert.equal('$varinCredentialBinding' in current!, false);
    return credential('rotated');
  });
  assert.deepEqual(await authority.currentScope('fixture-provider'), before);
  const disk = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')) as Record<string, { access: string; refresh: string; $varinCredentialBinding: { handle: string; generation: number; providerAccount: string } }>;
  assert.equal(disk['fixture-provider']!.access, 'fake-access-rotated');
  assert.equal(disk['fixture-provider']!.refresh, 'fake-refresh-rotated');
  assert.equal(disk['fixture-provider']!.$varinCredentialBinding.handle, before.account);
  assert.equal(disk['fixture-provider']!.$varinCredentialBinding.generation, before.generation);
  const reopened = HostCredentialAuthority.open(directory);
  assert.deepEqual(await reopened.currentScope('fixture-provider'), before);
  await reopened.modifyWithIntent('fixture-provider', 'replace', async () => credential('relinked', 'another-provider-account'));
  const relinked = await reopened.currentScope('fixture-provider');
  assert.equal(relinked.account, before.account);
  assert.equal(relinked.generation, before.generation + 1);
  assert.equal(await reopened.currentProviderAccount('fixture-provider'), 'another-provider-account');
  assert.deepEqual(await HostCredentialAuthority.open(directory).currentScope('fixture-provider'), relinked);
});

test('a failed credential-owner update preserves both token and binding metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-credential-failure-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authority = HostCredentialAuthority.open(directory);
  await authority.modifyWithIntent('fixture-provider', 'replace', async () => credential('kept'));
  const original = await readFile(join(directory, 'auth.json'), 'utf8');
  await assert.rejects(authority.modifyWithIntent('fixture-provider', 'refresh', async () => { throw new Error('fake refresh failed before commit'); }), /fake refresh failed/);
  assert.equal(await readFile(join(directory, 'auth.json'), 'utf8'), original);
  assert.deepEqual(await HostCredentialAuthority.open(directory).currentScope('fixture-provider'), await authority.currentScope('fixture-provider'));
});


test('configured literal key uses its temporary models file identity and detects edits without changing stored-key identity', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-configured-key-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelsPath = join(directory, 'models.json');
  await writeFile(modelsPath, JSON.stringify({ providers: { openai: { apiKey: 'fake-configured-key-initial' } } }));
  const authority = HostCredentialAuthority.open(directory);
  const original = await authority.currentScope('openai');
  assert.equal(await authority.readRaw('openai'), undefined);
  assert.equal((await authority.getAuth('openai'))?.auth.apiKey, 'fake-configured-key-initial');
  assert.deepEqual(await HostCredentialAuthority.open(directory).currentScope('openai'), original);
  const document = JSON.parse(await readFile(modelsPath, 'utf8')) as { providers: Record<string, { apiKey: string; name?: string }> };
  document.providers.openai!.apiKey = 'fake-configured-key-rotated';
  await writeFile(modelsPath, JSON.stringify(document));
  const changed = await authority.currentScope('openai');
  assert.notDeepEqual(changed, original);
  assert.equal((await authority.getAuth('openai'))?.auth.apiKey, 'fake-configured-key-rotated');
  await authority.modifyWithIntent('anthropic', 'replace', async () => ({ type: 'api_key', key: 'fake-stored-key' }));
  const stored = await authority.currentScope('anthropic');
  document.providers.openai!.name = 'Unrelated model display edit';
  await writeFile(modelsPath, JSON.stringify(document));
  assert.notDeepEqual(await authority.currentScope('openai'), changed);
  assert.deepEqual(await authority.currentScope('anthropic'), stored);
});


test('dynamic environment credentials rotate only the in-memory lease and require fresh owner binding after restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-dynamic-env-review-'));
  const variable = `VARIN_FAKE_NATIVE_KEY_${randomUUID().replaceAll('-', '')}`;
  t.after(async () => { delete process.env[variable]; await rm(directory, { recursive: true, force: true }); });
  process.env[variable] = 'fake-dynamic-value-one';
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { openai: { apiKey: `$${variable}` } } }));
  const authority = HostCredentialAuthority.open(directory);
  const first = await authority.currentScope('openai');
  assert.equal((await authority.getAuth('openai'))?.auth.apiKey, 'fake-dynamic-value-one');
  assert.deepEqual(await authority.currentScope('openai'), first);
  process.env[variable] = 'fake-dynamic-value-two';
  const changed = await authority.currentScope('openai');
  assert.notDeepEqual(changed, first);
  assert.equal((await authority.getAuth('openai'))?.auth.apiKey, 'fake-dynamic-value-two');
  assert.notDeepEqual(await HostCredentialAuthority.open(directory).currentScope('openai'), changed);
  for (const name of ['models.json', 'auth.json']) {
    const saved = await readFile(join(directory, name), 'utf8');
    assert.equal(saved.includes('fake-dynamic-value-one'), false);
    assert.equal(saved.includes('fake-dynamic-value-two'), false);
    assert.equal(saved.includes(':lease:'), false);
  }
});

test('model listing leaves a temporary helper unevaluated and native dispatch reuses its pinned result', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-dynamic-helper-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const helper = join(directory, 'fake-helper.cjs');
  const marker = join(directory, 'helper-count.txt');
  await writeFile(helper, `const fs = require('node:fs'); const marker = ${JSON.stringify(marker)}; const count = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) : 0; fs.writeFileSync(marker, String(count + 1)); process.stdout.write('fake-helper-result');`);
  const expression = `!${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`;
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { openai: { apiKey: expression } } }));
  const authority = HostCredentialAuthority.open(directory);
  assert.ok((await authority.listModels()).some(model => model.providerId === 'openai'));
  assert.equal(await readFile(marker, 'utf8').catch(() => null), null);
  const scope = await authority.currentScope('openai');
  assert.equal((await authority.getAuth('openai'))?.auth.apiKey, 'fake-helper-result');
  assert.deepEqual(await authority.currentScope('openai'), scope);
  assert.equal(await readFile(marker, 'utf8'), '1');
  assert.equal((await readFile(join(directory, 'models.json'), 'utf8')).includes('fake-helper-result'), false);
});

test('header-only configured providers list without helper execution and preserve model-specific headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-header-only-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { 'header-fixture': {
    api: 'openai-completions', baseUrl: 'https://model.example.test/v1', headers: { authorization: 'Bearer fake-provider-header' },
    models: [{ id: 'fixture-model', name: 'Fixture', headers: { authorization: 'Bearer fake-model-header' } }],
  } } }));
  const authority = HostCredentialAuthority.open(directory);
  assert.ok((await authority.listModels()).some(model => model.providerId === 'header-fixture' && model.modelId === 'fixture-model'));
  const scope = await authority.currentScope('header-fixture', 'fixture-model');
  assert.equal((await authority.getAuth('header-fixture', 'fixture-model'))?.auth.headers?.authorization, 'Bearer fake-model-header');
  assert.deepEqual(await authority.currentScope('header-fixture', 'fixture-model'), scope);
  assert.equal(await authority.readRaw('header-fixture'), undefined);
});

test('ambient API key rotation and owner restart invalidate only opaque in-memory scopes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-ambient-key-review-'));
  const previous = process.env.OPENAI_API_KEY;
  t.after(async () => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; await rm(directory, { recursive: true, force: true }); });
  process.env.OPENAI_API_KEY = 'fake-ambient-first';
  const authority = HostCredentialAuthority.open(directory);
  const first = await authority.currentScope('openai');
  assert.equal((await authority.getAuth('openai'))?.auth.apiKey, 'fake-ambient-first');
  process.env.OPENAI_API_KEY = 'fake-ambient-second';
  const second = await authority.currentScope('openai');
  assert.notDeepEqual(second, first);
  assert.equal((await authority.getAuth('openai'))?.auth.apiKey, 'fake-ambient-second');
  assert.notDeepEqual(await HostCredentialAuthority.open(directory).currentScope('openai'), second);
  assert.ok((await authority.listModels()).some(model => model.providerId === 'openai'));
  assert.equal((await readFile(join(directory, 'auth.json'), 'utf8')).includes('fake-ambient'), false);
});

test('decision bindings retain accepted protocol routes, fence model-header credentials, and never publish header values', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-decision-binding-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'models.json');
  const document = { providers: { decision: { apiKey: 'fixture-provider-secret', baseUrl: 'https://classifier.invalid',
    models: [{ id: 'judge', type: 'classifier', api: 'typesafe-system-one', headers: { 'x-account': 'fixture-model-header-secret' } }],
    capabilities: { decision: { protocol: 'pi-classifier', endpoint: '/original', enabled: true } } } } };
  await writeFile(file, JSON.stringify(document));
  const authority = HostCredentialAuthority.open(directory);
  const binding = await authority.resolveDecisionBinding('decision', 'judge');
  assert.equal(binding.requestUrl, 'https://classifier.invalid/original');
  assert.equal((await binding.getAuth())?.auth.headers?.['x-account'], 'fixture-model-header-secret');
  const publicBinding = JSON.stringify({ configurationId: binding.configurationId, scope: binding.credentialScope });
  assert.equal(publicBinding.includes('fixture-provider-secret'), false);
  assert.equal(publicBinding.includes('fixture-model-header-secret'), false);
  document.providers.decision.capabilities.decision.endpoint = '/replacement';
  await writeFile(file, JSON.stringify(document));
  await binding.assertAvailable();
  assert.equal(binding.requestUrl, 'https://classifier.invalid/original');
  assert.notEqual((await authority.resolveDecisionBinding('decision', 'judge')).configurationId, binding.configurationId);
  await writeFile(file, '{bad candidate');
  await binding.assertAvailable();
  assert.equal((await binding.getAuth())?.auth.apiKey, 'fixture-provider-secret');
  document.providers.decision.models[0]!.headers['x-account'] = 'fixture-model-header-relinked';
  await writeFile(file, JSON.stringify(document));
  await assert.rejects(binding.assertAvailable(), /credential-scope-changed/);
  const fresh = await authority.resolveDecisionBinding('decision', 'judge');
  assert.notDeepEqual(fresh.credentialScope, binding.credentialScope);
  document.providers.decision.capabilities.decision.enabled = false;
  await writeFile(file, JSON.stringify(document));
  await assert.rejects(fresh.assertAvailable(), /decision-provider-disabled/);
});

test('decision capability preserves each classifier protocol and llama server routes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-decision-api-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'models.json'), JSON.stringify({ providers: { decision: {
    apiKey: 'fixture-only', baseUrl: 'https://cloudflare.invalid/accounts/fixture/ai',
    models: [{ id: 'remote', type: 'classifier', api: 'cloudflare-workers-ai-system-one' },
      { id: 'local', type: 'classifier', api: 'llama-cpp-classify', baseUrl: 'http://localhost:8080' }],
  } } }));
  const authority = HostCredentialAuthority.open(directory);
  const cloudflare = await authority.resolveDecisionBinding('decision', 'remote');
  assert.equal(cloudflare.api, 'cloudflare-workers-ai-system-one');
  assert.equal(cloudflare.requestUrl, 'https://cloudflare.invalid/accounts/fixture/ai/run');
  const local = await authority.resolveDecisionBinding('decision', 'local');
  assert.equal(local.api, 'llama-cpp-classify');
  assert.equal(local.requestUrl, 'http://localhost:8080/completion');
  assert.deepEqual(local.routes, [
    { requestUrl: 'http://localhost:8080/tokenize', requestKind: 'preparation' },
    { requestUrl: 'http://localhost:8080/apply-template', requestKind: 'preparation' },
    { requestUrl: 'http://localhost:8080/completion', requestKind: 'model_compute' },
  ]);
  await assert.rejects(authority.resolveDecisionBinding('decision', 'local', '/systemone'), /decision-endpoint-invalid/);
});

test('dynamic decision model headers keep one private owner and revoke old leases on environment rotation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-decision-dynamic-header-'));
  const variable = `VARIN_FAKE_DECISION_HEADER_${randomUUID().replaceAll('-', '')}`;
  t.after(async () => { delete process.env[variable]; await rm(directory, { recursive: true, force: true }); });
  process.env[variable] = 'fixture-header-first';
  const file = join(directory, 'models.json');
  await writeFile(file, JSON.stringify({ providers: { decision: { apiKey: 'fixture-only', baseUrl: 'https://classifier.invalid',
    modelOverrides: { judge: { headers: { 'x-chat-only': 'must-not-leak' } } },
    models: [{ id: 'judge', type: 'classifier', api: 'typesafe-system-one', headers: { 'x-account': `$${variable}` } }],
  } } }));
  const originalFile = await readFile(file, 'utf8');
  const authority = HostCredentialAuthority.open(directory);
  const first = await authority.resolveDecisionBinding('decision', 'judge');
  const same = await authority.resolveDecisionBinding('decision', 'judge');
  assert.deepEqual(same.credentialScope, first.credentialScope);
  assert.equal((await first.getAuth())?.auth.headers?.['x-account'], 'fixture-header-first');
  assert.equal((await first.getAuth())?.auth.headers?.['x-chat-only'], undefined);
  process.env[variable] = 'fixture-header-next';
  await assert.rejects(first.assertAvailable(), /credential-scope-changed/);
  const second = await authority.resolveDecisionBinding('decision', 'judge');
  assert.notDeepEqual(second.credentialScope, first.credentialScope);
  assert.equal((await second.getAuth())?.auth.headers?.['x-account'], 'fixture-header-next');
  assert.equal(await readFile(file, 'utf8'), originalFile, 'capturing private leases never rewrites user configuration');
});

test('keyless llama retains its original credential owner and never masks a missing explicit key', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-decision-keyless-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'models.json');
  const provider: Record<string, unknown> = { baseUrl: 'http://localhost:8080/v1', models: [
    { id: 'local', type: 'classifier', api: 'llama-cpp-classify' },
    { id: 'typesafe', type: 'classifier', api: 'typesafe-system-one' },
    { id: 'cloudflare', type: 'classifier', api: 'cloudflare-workers-ai-system-one' },
  ] };
  await writeFile(file, JSON.stringify({ providers: { decision: provider } }));
  const authority = HostCredentialAuthority.open(directory);
  const original = await authority.resolveDecisionBinding('decision', 'local');
  assert.equal(original.requestUrl, 'http://localhost:8080/completion');
  assert.deepEqual((await original.getAuth())?.auth, { headers: {} });
  assert.deepEqual((await authority.resolveDecisionBinding('decision', 'local')).credentialScope, original.credentialScope);
  await assert.rejects(authority.resolveDecisionBinding('decision', 'typesafe'), /credential-missing/);
  await assert.rejects(authority.resolveDecisionBinding('decision', 'cloudflare'), /credential-missing/);
  provider.apiKey = 'fixture-explicit-key';
  await writeFile(file, JSON.stringify({ providers: { decision: provider } }));
  await assert.rejects(original.assertAvailable(), /credential-scope-changed/);
  const authenticated = await authority.resolveDecisionBinding('decision', 'local');
  assert.equal((await authenticated.getAuth())?.auth.apiKey, 'fixture-explicit-key');
  assert.notDeepEqual(authenticated.credentialScope, original.credentialScope);
  provider.apiKey = `$VARIN_UNSET_KEY_${randomUUID().replaceAll('-', '')}`;
  await writeFile(file, JSON.stringify({ providers: { decision: provider } }));
  await assert.rejects(authority.resolveDecisionBinding('decision', 'local'), /credential-missing/);
});

test('keyless llama honors the configured credential owner and classifier headers without borrowing chat headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-decision-keyless-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'models.json');
  const document = { providers: {
    decision: { baseUrl: 'http://localhost:8080/v1', modelOverrides: { local: { headers: { 'x-chat-only': 'forbidden' } } },
      models: [{ id: 'local', type: 'classifier', api: 'llama-cpp-classify', headers: { 'x-model': 'classifier-header' } }],
      capabilities: { decision: { protocol: 'pi-classifier', credentialRef: 'keyless-owner', enabled: true } } },
    'keyless-owner': { baseUrl: 'http://localhost:8081/v1', models: [{ id: 'owner', type: 'classifier', api: 'llama-cpp-classify' }] },
  } };
  await writeFile(file, JSON.stringify(document));
  const authority = HostCredentialAuthority.open(directory);
  const binding = await authority.resolveDecisionBinding('decision', 'local');
  assert.equal(binding.credentialScope.reference, 'provider:keyless-owner');
  assert.deepEqual((await binding.getAuth())?.auth, { headers: { 'x-model': 'classifier-header' } });
  document.providers.decision.capabilities.decision.credentialRef = 'absent-owner';
  await writeFile(file, JSON.stringify(document));
  await assert.rejects(binding.assertAvailable(), /credential-scope-changed/);
  await assert.rejects(authority.resolveDecisionBinding('decision', 'local'), /credential-missing/);
});

test('rerank retains its dedicated route and credential owner across candidates, then honors explicit revocation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-rerank-owner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'models.json');
  const document = { providers: {
    ranking: { baseUrl: 'https://chat.invalid/v1', apiKey: 'fake-chat-only',
      capabilities: { rerank: { protocol: 'http-rerank', baseUrl: 'https://ranking.invalid/v1',
        endpoint: '/original', credentialRef: 'ranking-owner', enabled: true, models: [{ id: 'rank' }] } } },
    'ranking-owner': { apiKey: 'fake-ranking-key', headers: { 'x-owner': 'fake-ranking-header' } },
  } };
  await writeFile(file, JSON.stringify(document));
  const authority = HostCredentialAuthority.open(directory);
  const original = await authority.resolveRerankBinding('ranking', 'rank');
  assert.equal(original.requestUrl, 'https://ranking.invalid/v1/original');
  assert.equal(original.api, 'http-rerank');
  assert.equal(original.credentialScope.reference, 'provider:ranking-owner');
  assert.equal((await original.getAuth())?.auth.apiKey, 'fake-ranking-key');
  assert.equal((await original.getAuth())?.auth.headers?.['x-owner'], 'fake-ranking-header');
  assert.equal(JSON.stringify({ configurationId: original.configurationId, scope: original.credentialScope }).includes('fake-ranking'), false);
  document.providers.ranking.capabilities.rerank.endpoint = '/replacement';
  await writeFile(file, JSON.stringify(document));
  await original.assertAvailable();
  assert.equal(original.requestUrl, 'https://ranking.invalid/v1/original');
  const next = await authority.resolveRerankBinding('ranking', 'rank');
  assert.equal(next.requestUrl, 'https://ranking.invalid/v1/replacement');
  assert.notEqual(next.configurationId, original.configurationId);
  await writeFile(file, '{invalid candidate');
  await original.assertAvailable();
  assert.equal((await original.getAuth())?.auth.apiKey, 'fake-ranking-key');
  document.providers.ranking.capabilities.rerank.enabled = false;
  await writeFile(file, JSON.stringify(document));
  await assert.rejects(original.assertAvailable(), /rerank-provider-disabled/);
  await assert.rejects(next.assertAvailable(), /rerank-provider-disabled/);
});
