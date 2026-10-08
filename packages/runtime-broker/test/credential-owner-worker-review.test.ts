import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { HostCredentialAuthority, CredentialStoreServer } from '@varin/pi-host/credentials';
import { PiHostClient } from '../src/host-client.js';

test('actual Pi worker delegates credential reads and logout to the Host owner', { timeout: 45_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'varin-credential-worker-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerDir = join(root, 'owner');
  const workerDir = join(root, 'worker');
  const project = join(root, 'project');
  await Promise.all([mkdir(ownerDir), mkdir(workerDir), mkdir(project)]);
  const decoy = JSON.stringify({ openai: { type: 'api_key', key: 'fake-worker-local-must-stay' } });
  await writeFile(join(workerDir, 'auth.json'), decoy);
  const authority = HostCredentialAuthority.open(ownerDir);
  await authority.modifyWithIntent('openai', 'replace', async () => ({ type: 'api_key', key: 'fake-owner-only' }));
  const server = new CredentialStoreServer(authority);
  const observed: string[] = [];
  const accept = server.accept.bind(server);
  server.accept = (value, peer, send) => {
    if (value && typeof value === 'object' && 'operation' in value) observed.push(String(value.operation));
    return accept(value, peer, send);
  };
  const diagnostics: string[] = [];
  const client = new PiHostClient({
    credentialAuthority: server,
    agentDir: workerDir,
    cwd: project,
    hostEntry: resolve(import.meta.dirname, '../../pi-host/src/main.ts'),
    execArgv: ['--import', import.meta.resolve('tsx')],
    handshake: { clientName: 'credential-owner-review', clientVersion: '0', mode: 'test' },
    projectTrustOverride: false,
    onDiagnostic: (_level, message) => diagnostics.push(message),
    startupTimeoutMs: 20_000,
    shutdownTimeoutMs: 2_000,
    requestTimeoutMs: 20_000,
  });
  t.after(() => client.dispose());
  try {
    await client.start();
    await client.request('session.create', { cwd: project, tools: [] });
    const providers = await client.request('provider.list', {});
    assert.ok(providers.some(provider => provider.id === 'openai'));
    assert.ok(observed.some(operation => operation === 'list' || operation === 'read'));
    assert.deepEqual(await client.request('provider.logout', { providerId: 'openai' }), { authenticated: false });
    assert.ok(observed.includes('delete'), 'logout must cross the private parent authority channel');
    assert.equal(await authority.readRaw('openai'), undefined);
    assert.equal(await readFile(join(workerDir, 'auth.json'), 'utf8'), decoy, 'worker must not open a second writable credential authority');
    assert.equal(JSON.stringify(providers).includes('fake-owner-only'), false);
  } catch (error) {
    assert.fail(`${error instanceof Error ? error.message : String(error)}\n${diagnostics.join('\n')}`);
  }
});
