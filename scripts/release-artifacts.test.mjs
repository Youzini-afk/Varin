import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveCandidate, releaseTargets, releaseMatrices, recordAssets, verifyArtifacts, finalizeAssets, assertReleaseRef } from './release-artifacts.mjs';

import { desktopReleaseProduct } from './desktop-release-product.mjs';

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
  const candidate = { schema: 1, sourceSha, toolingSha, version: '0.9.34', includeIntel: false, desktopRoles: ['full','light'] };
  for (const target of releaseTargets()) {
    const options = { ...candidate, platform: target.nodePlatform, arch: target.architecture };
    for (const role of candidate.desktopRoles) {
      const directory = path.join(root, 'desktop-' + role + '-' + options.platform + '-' + options.arch);
      await fs.mkdir(directory);
      const product = desktopReleaseProduct({ ...options, role });
      for (const name of [...product.required, ...(product.manifest ? [product.manifest] : [])]) await fs.writeFile(path.join(directory, name), role);
      await recordAssets(directory, { ...options, role, kind: 'desktop' });
    }
    const directory = path.join(root, 'component-' + options.platform + '-' + options.arch);
    await fs.mkdir(directory); await fs.writeFile(path.join(directory, 'asset.bin'), 'component');
    await recordAssets(directory, { ...options, kind: 'component' });
  }
  const android = path.join(root, 'android'); await fs.mkdir(android); await fs.writeFile(path.join(android, 'app.apk'), 'apk');
  await recordAssets(android, { ...candidate, kind: 'android', platform: 'android', arch: 'universal' });
  await verifyArtifacts(root, candidate);
  const armLight = path.join(root, 'desktop-light-win32-arm64');
  const armFile = 'Varin-Light-0.9.34-win-arm64.exe';
  await fs.rename(path.join(armLight, armFile), path.join(armLight, 'Varin-0.9.34-win-arm64.exe'));
  const options = { ...candidate, kind: 'desktop', role: 'light', platform: 'win32', arch: 'arm64' };
  await recordAssets(armLight, options);
  await assert.rejects(verifyArtifacts(root, candidate), /Missing desktop.light.win32.arm64 asset/);
  await fs.rename(path.join(armLight, 'Varin-0.9.34-win-arm64.exe'), path.join(armLight, armFile));
  await recordAssets(armLight, options);
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

test('the official desktop matrix adds native role rows without duplicating inference components or VM inputs', () => {
  for (const includeIntel of [true, false]) {
    const native = releaseTargets(includeIntel);
    const legacy = releaseMatrices({ includeIntel });
    assert.equal(legacy.matrix.include.length + legacy.linux_matrix.include.length, native.length);
    const { matrix, linux_matrix, component_matrix } = releaseMatrices({ includeIntel, desktopRoles: ['full','light'] });
    const rows = [...matrix.include, ...linux_matrix.include];
    assert.equal(rows.length, 2 * native.length);
    assert.equal(new Set(rows.map(row => row.artifact)).size, rows.length);
    assert.deepEqual(component_matrix.include, native);
    assert.deepEqual(linux_matrix.include.map(row => [row.nodePlatform, row.architecture, row.role]), [['linux','x64','full']]);
    for (const target of native) {
      assert.deepEqual(rows.filter(row => row.runner === target.runner).map(row => row.role).sort(), ['full','light']);
    }
  }
});
