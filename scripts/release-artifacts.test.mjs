import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCandidate, releaseTargets, recordAssets, verifyArtifacts, finalizeAssets, assertReleaseRef } from './release-artifacts.mjs';

const sourceSha = 'a'.repeat(40), toolingSha = 'b'.repeat(40);
test('release retries retain the accepted source even after a tag moves', async () => {
  const options = { releaseRef: 'v0.9.34', toolingSha, runId: '123', androidVersionCode: '42', includeIntel: false };
  const existing = await resolveCandidate({ ...options, resolveSource: async () => ({ sha: sourceSha, version: '0.9.34' }) });
  assert.equal((await resolveCandidate({ ...options, existing, resolveSource() { throw new Error('must not re-resolve the tag'); } })).sourceSha, sourceSha);
  await assertReleaseRef(existing, async () => sourceSha);
  await assert.rejects(assertReleaseRef(existing, async () => 'c'.repeat(40)), /tag moved/);
  await assert.rejects(resolveCandidate({ ...options, runId: 'different', existing }), /does not match/);
});
test('assembly requires every selected desktop, component and Android product from the same source with intact files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-release-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = { schema: 1, sourceSha, toolingSha, version: '0.9.34', includeIntel: false };
  for (const target of releaseTargets()) for (const kind of ['desktop', 'component']) {
    const directory = path.join(root, `${kind}-${target.nodePlatform}-${target.architecture}`);
    await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'asset.bin'), kind);
    await recordAssets(directory, { ...candidate, kind, platform: target.nodePlatform, arch: target.architecture });
  }
  const android = path.join(root, 'android'); await fs.mkdir(android); await fs.writeFile(path.join(android, 'app.apk'), 'apk');
  await recordAssets(android, { ...candidate, kind: 'android', platform: 'android', arch: 'universal' });
  await verifyArtifacts(root, candidate);
  await assert.rejects(verifyArtifacts(root, { ...candidate, sourceSha: 'c'.repeat(40) }), /source mismatch/);
  await fs.writeFile(path.join(android, 'app.apk'), 'corrupt');
  await assert.rejects(verifyArtifacts(root, candidate), /digest mismatch/);
  await fs.writeFile(path.join(android, 'app.apk'), 'apk');
  await fs.writeFile(path.join(android, 'stale.apk'), 'old artifact');
  await assert.rejects(verifyArtifacts(root, candidate), /Unrecorded/);
  await fs.rm(path.join(android, 'stale.apk')); await fs.rm(path.join(root, 'component-linux-x64'), { recursive: true });
  await assert.rejects(verifyArtifacts(root, candidate), /Missing release products/);
});
test('final checksums describe final installer and updater bytes with their source receipt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-release-final-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'latest.yml'), 'updater');
  await finalizeAssets(root, { sourceSha });
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'release-source.json'), 'utf8')).files[0].name, 'latest.yml');
  assert.match(await fs.readFile(path.join(root, 'SHA256SUMS'), 'utf8'), /[a-f0-9]{64}  release-source.json/u);
});
