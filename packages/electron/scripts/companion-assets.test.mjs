import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { prepareCompanionCatalog, stageDesktopWebAsset } from './companion-assets.mjs';
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const libraryRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { FileMatcher } = libraryRequire('./fileMatcher');

test('desktop payload keeps the player and preview but excludes full artwork even with stale staging', async () => {
  const resource = require('../package.json').build.extraResources.find(item => item.to === 'web-dist');
  const source = await mkdtemp(path.join(os.tmpdir(), 'varin-companion-payload-'));
  const matcher = new FileMatcher(source, path.join(source, 'target'), value => value, resource.filter);
  const select = matcher.createFilter();
  try { for (const [file, expected] of [
    ['companion.html', true], ['companion-catalog.json', true], ['companion-previews/varin.png', true],
    ['companion-assets/bundle.json', false], ['companion-assets/atlas-000.png', false], ['companion-review-director/atlas.png', false],
  ]) {
    assert.equal(stageDesktopWebAsset(file), expected);
    const filename = path.join(source, file);
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, 'fixture');
    assert.equal(select(filename, await stat(filename)), expected, `electron-builder ${file}`);
  } } finally { await rm(source, { recursive: true, force: true }); }
});

test('catalog pins the actual bundle, all referenced art and alpha pages to a reproducible source tree', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-companion-catalog-'));
  try {
    const catalog = await prepareCompanionCatalog({ output: path.join(root, 'catalog.json'), sourceRevision: 'a'.repeat(40) });
    const pack = catalog.packs[0];
    assert.match(pack.baseUrl, /\/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\/packages\/web\/public\/companion-assets\/$/u);
    assert.ok(pack.files.some(file => file.path === 'bundle.json'));
    assert.ok(pack.files.some(file => file.path === 'occlusion.json'));
    assert.ok(pack.files.some(file => file.path.startsWith('occlusion-atlas-')));
    assert.equal(pack.bytes, pack.files.reduce((sum, file) => sum + file.bytes, 0));
    assert.ok(pack.files.every(file => file.bytes > 0 && /^[a-f0-9]{64}$/u.test(file.sha256)));
  } finally { await rm(root, { recursive: true, force: true }); }
});
