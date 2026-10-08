import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
