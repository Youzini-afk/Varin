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
