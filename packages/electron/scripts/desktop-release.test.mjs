import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { desktopReleaseProduct, stageDesktopRelease } from '../../../scripts/desktop-release-product.mjs';
import { releaseMatrices } from '../../../scripts/release-artifacts.mjs';
import { resolveUpdaterChannel } from '../updater-channel.ts';
import { matchesDesktopUpdate } from '../updater-check.ts';
import { assertUpdaterCapability } from '../updater-capability.ts';
import { desktopBuilderConfiguration } from './desktop-distribution.mjs';

const require = createRequire(import.meta.url);
const base = require('../package.json').build;
const library = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'));
const { validateConfiguration } = library('./util/config/config');
const { Platform } = library('./core');
const { createUpdateInfoTasks, writeUpdateInfoFiles } = library('./publish/updateInfoBuilder');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider.js');
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider.js');
const version = '1.2.3';

// Exercise the locked release writer and native client's provider offline, not
// just two copies of our expected YAML names. No installer, signing or network.
test('each release row stages its own assets and resolves the locked native provider to the corresponding manifest', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-release-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const saved = process.env.TEST_UPDATER_ARCH;
  t.after(() => { if (saved === undefined) delete process.env.TEST_UPDATER_ARCH; else process.env.TEST_UPDATER_ARCH = saved; });
  const { matrix, linux_matrix } = releaseMatrices({ includeIntel: true, desktopRoles: require('../package.json').desktopReleaseRoles });
  for (const row of [...matrix.include, ...linux_matrix.include]) {
    const target = { platform: row.nodePlatform, architecture: row.architecture, role: row.role };
    const { platform, architecture, role } = target;
    const record = { platform, arch: architecture, version, role };
    const product = desktopReleaseProduct(record);
    const workspace = path.join(root, row.artifact);
    const outDir = path.join(workspace, product.dist);
    const stage = path.join(workspace, 'staged');
    const config = desktopBuilderConfiguration(base, { directory: path.join(path.dirname(outDir), 'app'),
      webDist: '/test/web-dist', unpackPatterns: [] }, target);
    await validateConfiguration(config, { isEnabled: false });
    const native = Platform.fromString(platform);
    if (role === 'light') {
      assert.equal(config.directories.output, outDir);
      assert.equal(config.mac.sign, base.mac.sign);
      assert.equal(config.mac.notarize, base.mac.notarize);
      assert.equal(config.win.verifyUpdateCodeSignature, base.win.verifyUpdateCodeSignature);
      assert.equal(config.win.extraResources, undefined);
      assert.equal(config.nsis.include, undefined);
    }
    await fs.mkdir(outDir, { recursive: true });
    const { required } = product;
    const events = [];
    for (const name of required) {
      const bytes = Buffer.from('native fixture ' + name);
      const file = path.join(outDir, name);
      await fs.writeFile(file, bytes);
      if (name.endsWith('.blockmap')) continue;
      // electron-builder expands this product's template using the native target.
      const ext = name.split('.').at(-1);
      const archToken = platform === 'linux' && architecture === 'x64' ? 'x86_64' : architecture;
      assert.equal(config[native.buildConfigurationKey].artifactName.replace('${productName}', config.productName)
        .replace('${version}', version).replace('${arch}', archToken).replace('${ext}', ext), name);
      const packager = { platform: native, config, appInfo: { version }, platformSpecificBuildOptions: config[native.buildConfigurationKey],
        info: { metadata: { dependencies: { 'electron-updater': '6.8.11' } } }, getResource: async () => null };
      events.push(...await createUpdateInfoTasks({ packager, file, target: { outDir }, arch: architecture === 'x64' ? 1 : 3,
        updateInfo: { size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') } }, [config.publish]));
    }
    await writeUpdateInfoFiles(events, { emitArtifactCreated: async () => {} });
    await stageDesktopRelease(record, stage, workspace);
    if (!product.manifest) {
      assert.deepEqual([platform, role], ['darwin', 'light']);
      assert.throws(() => assertUpdaterCapability({ platform, role, packaged: true }), /manual update/);
      assert.ok(!(await fs.readdir(stage)).some(name => name.endsWith('.yml')));
      assert.ok(!(await fs.readdir(outDir)).some(name => name.endsWith('.yml')));
      continue;
    }
    const data = await fs.readFile(path.join(stage, product.manifest), 'utf8');
    const info = parseUpdateInfo(data, product.manifest, 'fixture');
    assert.equal(matchesDesktopUpdate(info, target), true);
    assert.equal(matchesDesktopUpdate(info, { ...target, role: role === 'full' ? 'light' : 'full' }), false);
    assert.equal(matchesDesktopUpdate(info, { ...target, architecture: architecture === 'x64' ? 'arm64' : 'x64' }), false);
    process.env.TEST_UPDATER_ARCH = architecture;
    const provider = new GitHubProvider(config.publish, { channel: resolveUpdaterChannel(target) }, { platform, executor: null });
    assert.equal(provider.channel + '.yml', product.finalManifest);
    assert.deepEqual(new Set(await fs.readdir(stage)), new Set([...required, product.manifest]));
  }
});
