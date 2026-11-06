import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { releaseProject } from '../../extension-cli/src/release.js';
import { ApplicationExtensionRuntime, ExtensionReleaseManager } from '../src/index.js';

test('Gmail release installs with reviewed capabilities, activates real brokered services, and sends once through confirmation', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gmail-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'plugin');
  await cp(fileURLToPath(new URL('../../../examples/extensions/gmail', import.meta.url)), project, { recursive: true, filter: source => !/(?:^|\/)(?:node_modules|dist|release)(?:\/|$)/.test(source) });
  await mkdir(join(project, 'node_modules/@varin'), { recursive: true });
  for (const name of ['extension-contract', 'extension-sdk']) await symlink(fileURLToPath(new URL(`../../${name}`, import.meta.url)), join(project, 'node_modules/@varin', name), 'junction');
  const result = await releaseProject(project);
  const broker = join(root, 'broker.mjs');
  await writeFile(broker, `process.env.VARIN_GMAIL_CLIENT_ID = 'simulated';
  process.env.VARIN_GMAIL_REDIRECT_URI = 'http://127.0.0.1:8085/callback';
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/messages/send')) {
      if (init.headers.Authorization !== 'Bearer simulated-access') throw new Error('Missing simulated token');
      return Response.json({ id: 'sent', threadId: 'thread' });
    }
    throw new Error('Unexpected network request');
  };
  await import(${JSON.stringify(new URL('../broker/broker-child.mjs', import.meta.url).href)});`);
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), varinVersion: '1.2.3', brokerScript: broker });
  t.after(() => runtime.stop());
  let confirmed = 0; let deny = false; let rejectedAuthentication = 0;
  runtime.capabilities.register('varin.credentials', (method, params) => {
    // No ordinary RPC invocation in this fixture has retained credential adapter authority.
    // Legitimate authorization/refresh scope is tested by the real Host capability owner.
    if (method === 'assertAuthentication') {
      assert.deepEqual(params, {}); rejectedAuthentication++;
      throw new Error('Credential authentication authority required');
    }
    if (method === 'start') return { id: (params as { connectionId: string }).connectionId, status: 'pending' };
    if (method === 'cancel') return { id: (params as { id: string }).id, status: 'cancelled' };
    if (method === 'namespace') return 'trusted-user-plugin';
    if (method === 'inspect') return { connected: true, account: 'identity', accountId: 'me@example.test' };
    if (method === 'resolve') { assert.equal((params as { expectedAccount: string }).expectedAccount, 'identity'); return { kind: 'oauth', provider: 'gmail', accessToken: 'simulated-access' }; }
    throw new Error(`Unexpected credentials method ${method}`);
  });
  const input = { binding: { connectionId: 'connection', account: 'identity' }, from: 'me@example.test', to: ['to@example.test'], cc: ['cc@example.test'], subject: 'Exact subject', body: 'Exact body' };
  runtime.capabilities.register('varin.tools.confirmation', (method, params) => {
    assert.equal(method, 'consume'); assert.deepEqual(params, input); confirmed++;
    if (deny) throw new Error('cancelled permission'); return null;
  });
  await runtime.start();
  const releases = new ExtensionReleaseManager({ packages: runtime.packages, hostId: runtime.services.hostId, install: runtime.installPreparedRelease.bind(runtime) });
  const preview = await releases.previewArchive(result.archive, 'gmail.tgz');
  const installed = await releases.install({ previewId: preview.previewId, expectedHostId: preview.hostId, expectedRevision: preview.catalogRevision });
  assert.equal(installed.extensions.find(e => e.manifest.id === 'varin.gmail')!.desired.enabled, false);
  assert.equal(runtime.services.getSnapshot().providers.filter(p => p.extensionId === 'varin.gmail').length, 0);
  const reviewed = await runtime.reviewCapabilities({ extensionId: 'varin.gmail', expectedRevision: installed.revision, decisions: ['varin.credentials', 'varin.tools.confirmation'].map(capability => ({ capability, realm: 'host', granted: true })) });
  await runtime.setEnabled('varin.gmail', true, reviewed.revision);
  const settings = await runtime.prepareService({ serviceId: 'varin.gmail.settings', version: 1, method: 'list', args: [] });
  t.after(() => settings.release());
  assert.deepEqual(await settings.invoke('list', []), []);
  // This is the installed package's actual broker/RPC path, not a source-level handler test.
  // A caller cannot extract a PKCE verifier, exchange a supplied code, or refresh a supplied token.
  for (const authentication of [
    { kind: 'begin', provider: 'gmail', connectionId: 'connection' },
    { kind: 'complete', provider: 'gmail', connectionId: 'connection', state: { verifier: 'supplied', nonce: 'supplied' }, redirect: 'http://127.0.0.1:8085/callback?code=code&state=supplied' },
    { kind: 'refresh', provider: 'gmail', connectionId: 'connection', token: { kind: 'oauth', provider: 'gmail', accessToken: 'supplied', refreshToken: 'supplied' } },
  ]) await assert.rejects(runtime.invokeService({ serviceId: 'varin.gmail.oauth', version: 1, method: 'authenticate', args: [authentication] }), /Credential authentication authority required/);
  assert.equal(rejectedAuthentication, 3);
  const pending = await Promise.all([settings.invoke('connect', []), settings.invoke('connect', [])]) as Array<{ connectionId: string; id: string }>;
  assert.equal((await settings.invoke('list', []) as unknown[]).length, 2);
  await Promise.all(pending.map(attempt => settings.invoke('cancel', [attempt.connectionId, attempt.id])));
  assert.deepEqual(await settings.invoke('list', []), []);
  const storage = { extensionId: 'varin.gmail', key: 'connections-trusted-user-plugin', scope: 'application' as const };
  await runtime.storage.update(storage, (await runtime.storage.read(storage)).document.revision, 0, { connections: ['connection'] });
  assert.deepEqual(await settings.invoke('list', []), [{ connectionId: 'connection', account: 'identity', accountId: 'me@example.test' }]);
  assert.deepEqual(await runtime.invokeService({ serviceId: 'varin.gmail.send', version: 1, method: 'execute', args: [input] }), { id: 'sent', threadId: 'thread' });
  assert.equal(confirmed, 1);
  deny = true;
  await assert.rejects(runtime.invokeService({ serviceId: 'varin.gmail.send', version: 1, method: 'execute', args: [input] }), /cancelled permission/);
  assert.equal(confirmed, 2);
});
