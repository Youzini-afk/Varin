import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertDesktopTarget, desktopBuilderConfiguration, parseRoleArgument } from './desktop-distribution.mjs';
import { stageRuntime } from './stage-runtime.mjs';
import verifyLightPayload from './verify-light-payload.cjs';

const require = createRequire(import.meta.url);
const base = require('../package.json').build;
const library = createRequire(createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'));
const asar = library('@electron/asar');

test('full stays the default builder composition; light has isolated identities, assets and manifests', () => {
  const prepared = { directory: '/tmp/product/app', unpackPatterns: [], webDist: '/tmp/product/resources/web-dist' };
  const args = ['--linux', '--role=light', '--x64', '--publish=never'];
  assert.equal(parseRoleArgument(args), 'light'); assert.deepEqual(args, ['--linux', '--x64', '--publish=never']);
  assert.equal(parseRoleArgument(args), 'full');
  assert.throws(() => parseRoleArgument(['--role=client']), /exactly one/);
  assert.throws(() => assertDesktopTarget('light', 'darwin', 'arm64'), /Unsupported/);
  const config = role => desktopBuilderConfiguration(base, prepared, { role, platform: 'linux', architecture: 'x64' });
  assert.deepEqual(config('full'), { ...base, directories: { ...base.directories, app: prepared.directory }, asarUnpack: [] });
  const light = config('light');
  assert.notEqual(light.appId, base.appId); assert.notEqual(light.directories.output, base.directories.output);
  assert.equal(light.linux.executableName, 'varin-light'); assert.equal(light.publish.channel, 'light');
  assert.equal(light.linux.artifactName, 'Varin-Light-${version}-linux-${arch}.${ext}');
  assert.deepEqual(light.extraResources.map(item => item.to).sort(), ['icons/icon.png', 'icons/tray', 'legal/LICENSE', 'legal/THIRD_PARTY_NOTICES.md', 'web-dist']);
  assert.equal(light.extraResources.find(item => item.to === 'web-dist').from, prepared.webDist);
});

test('light stages a closed shell, verifies the ASAR and rejects a mismatched target or leaked Host resources', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-role-layout-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const electron = path.join(root, 'packages/electron'), appOutDir = path.join(root, 'out'), resources = path.join(appOutDir, 'resources');
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); };
  const shell = ['electron-context-menu', 'electron-log', 'electron-updater'];
  await write(path.join(electron, 'package.json'), JSON.stringify({ name: '@varin/electron', version: '1.0.0',
    dependencies: Object.fromEntries([...shell, '@varin/web', 'puppeteer-core'].map(name => [name, '1.0.0'])) }));
  // Only shell dependencies exist. The full Host, kernel and browser driver cannot be resolved.
  for (const name of shell) {
    await write(path.join(electron, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    await write(path.join(electron, 'node_modules', name, 'index.js'), 'module.exports = 1');
  }
  await write(path.join(electron, 'bootstrap.mjs'), "await import('./dist-bundle/main.mjs')");
  const bundleDirectory = path.join(root, 'light-bundle');
  for (const entry of ['main', 'preload']) await write(path.join(bundleDirectory, `${entry}.mjs`), 'export {}');
  const destination = path.join(root, 'app');
  await stageRuntime({ repository: root, destination, platform: 'linux', architecture: 'x64', bundleDirectory, role: 'light' });
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'package.json')));
  assert.deepEqual(manifest.varinDistribution, { role: 'light', platform: 'linux', architecture: 'x64' });
  assert.deepEqual(Object.keys(manifest.dependencies), shell);
  for (const entry of ['web-dist/index.html', 'web-dist/companion-catalog.json', 'icons/icon.png', 'legal/LICENSE', 'legal/THIRD_PARTY_NOTICES.md']) {
    await write(path.join(resources, entry), 'fixture');
  }
  await asar.createPackage(destination, path.join(resources, 'app.asar'));
  const context = { appOutDir, electronPlatformName: 'linux', arch: 1 };
  verifyLightPayload(context);
  assert.throws(() => verifyLightPayload({ ...context, arch: 3 }), /architecture mismatch/);
  await write(path.join(resources, 'kernel/varin-kernel'), 'stale');
  assert.throws(() => verifyLightPayload(context), /Unexpected light package resource: kernel/);
});
