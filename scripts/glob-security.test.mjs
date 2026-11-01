import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = createRequire(new URL('../package.json', import.meta.url));
const web = createRequire(new URL('../packages/web/package.json', import.meta.url));
const electron = createRequire(new URL('../packages/electron/package.json', import.meta.url));
const mobile = createRequire(new URL('../packages/mobile/package.json', import.meta.url));
const from = (parent, name) => createRequire(parent.resolve(name));
const lock = fs.readFileSync(new URL('../bun.lock', import.meta.url), 'utf8');
const lockedVersions = name => [...new Set([...lock.matchAll(new RegExp(`\\["${name}@([^"]+)"`, 'g'))].map(match => match[1]))].sort();
const minimatchConsumers = [
  from(from(from(root, 'typescript-eslint'), '@typescript-eslint/parser'), '@typescript-eslint/typescript-estree'),
  from(root, 'nodemon'),
  from(from(root, 'eslint'), '@eslint/config-array'),
  from(from(from(electron, 'electron-builder'), 'app-builder-lib'), '@electron/universal'),
  from(from(from(web, 'exceljs'), 'archiver'), 'readdir-glob'),
  from(from(from(from(web, 'exceljs'), 'archiver'), 'archiver-utils'), 'glob'),
];

test('all installed minimatch lines preserve matches and avoid globparts amplification (GHSA-g3hv-75wg-m249)', async () => {
  const tested = new Set();
  for (const consumer of minimatchConsumers) {
    const manifest = consumer('minimatch/package.json');
    if (tested.has(manifest.version)) continue;
    tested.add(manifest.version);
    const modern = Number(manifest.version.split('.')[0]) >= 9;
    const modules = [consumer('minimatch')];
    if (modern) modules.push(await import(pathToFileURL(join(dirname(consumer.resolve('minimatch/package.json')), 'dist/esm/index.js')).href));
    for (const { Minimatch } of modules) {
      const amplified = new Minimatch(Array(8).fill('**/../a/b').join('/'), { optimizationLevel: 2, braceExpandMax: 64 });
      if (modern) {
        assert.ok(amplified.set.length <= 64, `minimatch ${manifest.version} must honor the upstream preprocessing bound`);
        const large = new Minimatch('{x,*}/{0..999}', { optimizationLevel: 2 });
        assert.equal(large.set.length, 2000, 'skip only quadratic deduplication, preserving every pattern');
        assert.equal(large.match('y/999'), true);
        assert.equal(large.match('.y/5'), false);
        const ordinary = new Minimatch('**/../a/b/**/../c/d', { optimizationLevel: 2 });
        assert.equal(ordinary.match('../a/b/../c/d'), true);
      } else {
        // Versions 3 and 5 predate this optimization; the advisory's broad range
        // also lists them, but they never enter either affected preprocessing pass.
        assert.equal(amplified.firstPhasePreProcess, undefined);
        assert.equal(amplified.secondPhasePreProcess, undefined);
        assert.equal(amplified.set.length, 1);
      }
      assert.equal(new Minimatch('**/*.js').match('src/app.js'), true);
    }
  }
  assert.deepEqual([...tested].sort(), lockedVersions('minimatch'), 'audit exclusions require exercising every locked minimatch version');
});

test('all affected glob walkers stop filesystem work after abort, for CJS and ESM (GHSA-3g3m-2fjr-6pw4)', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'varin-glob-abort-'));
  const tested = new Set();
  try {
    for (const directory of ['a/b/c', 'a/c/d', 'b/c/d']) {
      await mkdir(join(cwd, directory), { recursive: true });
      await writeFile(join(cwd, directory, 'file.txt'), 'fixture');
    }
    const consumers = [from(mobile, '@capacitor/cli'), from(from(web, 'vite-plugin-pwa'), 'workbox-build')];
    for (const consumer of consumers) {
      const manifest = consumer('glob/package.json');
      tested.add(manifest.version);
      const modules = [consumer('glob'), await import(pathToFileURL(join(dirname(consumer.resolve('glob/package.json')), 'dist/esm/index.js')).href)];
      for (const { glob, globStreamSync } of modules) {
        for (const stream of [false, true]) {
          const controller = new AbortController();
          const reason = new Error('stop traversal');
          let reads = 0;
          const count = () => { if (++reads === 1) controller.abort(reason); };
          const counted = { ...fs,
            readdir(...args) { count(); return fs.readdir(...args); },
            readdirSync(...args) { count(); return fs.readdirSync(...args); },
          };
          const options = { cwd, fs: counted, signal: controller.signal };
          if (stream) {
            const result = globStreamSync('**', options);
            const failed = new Promise(resolve => result.once('error', resolve));
            result.resume();
            assert.equal(await failed, reason);
          } else {
            await assert.rejects(glob('**', options), error => error === reason);
          }
          const atAbort = reads;
          await new Promise(resolve => setTimeout(resolve, 30));
          assert.equal(reads, atAbort, `glob ${manifest.version} continued traversing after abort`);
          assert.equal(reads, 1);
        }
        assert.deepEqual((await glob('**/*.txt', { cwd })).map(value => value.replaceAll('\\', '/')).sort(), ['a/b/c/file.txt', 'a/c/d/file.txt', 'b/c/d/file.txt']);
      }
    }
    assert.deepEqual([...tested].sort(), lockedVersions('glob').filter(version => Number(version.split('.')[0]) >= 9));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
