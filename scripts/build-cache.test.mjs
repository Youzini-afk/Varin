import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { BuildCache } from './build-cache.mjs';

async function fixture(t, checkout = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-build-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  if (checkout) execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/input.txt'), 'source');
  return root;
}
test('build reuse follows real source and output bytes, including untracked edits and failed producers', async t => {
  const root = await fixture(t), output = path.join(root, 'output');
  let builds = 0;
  const spec = { inputs: ['src'], values: { option: 1 }, outputs: [output], async build() {
    builds++; await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'app.js'), 'built');
  } };
  await new BuildCache(root).task('app', spec);
  await new BuildCache(root).task('app', spec);
  assert.equal(builds, 1);
  await fs.writeFile(path.join(root, 'src/new.txt'), 'new source');
  await new BuildCache(root).task('app', spec); assert.equal(builds, 2);
  await fs.writeFile(path.join(output, 'app.js'), 'corrupted');
  await new BuildCache(root).task('app', spec); assert.equal(builds, 3);
  await assert.rejects(new BuildCache(root).task('app', { ...spec, values: { option: 2 }, build() { throw new Error('compile failed'); } }), /compile failed/);
  await new BuildCache(root).task('app', spec); assert.equal(builds, 4);
});

test('source archives build without Git and never reuse or export checkout receipts', async t => {
  const root = await fixture(t, false), output = path.join(root, 'output');
  let builds = 0;
  const spec = { inputs: ['src'], outputs: [output], async build() {
    builds++; await fs.mkdir(output, { recursive: true });
    await fs.writeFile(path.join(output, 'app.js'), await fs.readFile(path.join(root, 'src/input.txt')));
  } };
  const first = await new BuildCache(root).task('app', spec);
  assert.match(first.digest, /^[a-f0-9]{64}$/u);
  await fs.writeFile(path.join(root, 'src/input.txt'), 'changed');
  const cache = new BuildCache(root);
  const second = await cache.task('app', spec);
  assert.equal(builds, 2); assert.notEqual(first.digest, second.digest);
  assert.equal(await fs.readFile(path.join(output, 'app.js'), 'utf8'), 'changed');
  await assert.rejects(cache.export('app', path.join(root, 'artifact'), output), /requires a Git checkout/);
});
test('browser/native artifact transfer verifies the same source/options and all transported bytes across checkout paths', async t => {
  const source = await fixture(t), consumer = await fixture(t), output = path.join(source, 'output');
  const cache = new BuildCache(source);
  await cache.task('app', { inputs: ['src'], values: { target: 'browser' }, outputs: [output], async build() {
    await fs.mkdir(output); await fs.writeFile(path.join(output, 'app.js'), 'browser code');
  } });
  const artifact = path.join(source, 'artifact'); await cache.export('app', artifact, output);
  const spec = { inputs: ['src'], values: { target: 'browser' }, output: path.join(consumer, 'output') };
  await new BuildCache(consumer).restore('app', artifact, spec);
  assert.equal(await fs.readFile(path.join(spec.output, 'app.js'), 'utf8'), 'browser code');
  await assert.rejects(new BuildCache(consumer).restore('app', artifact, { ...spec, values: { target: 'other' } }), /options mismatch/);
  await fs.writeFile(path.join(artifact, 'payload/app.js'), 'different code');
  await assert.rejects(new BuildCache(consumer).restore('app', artifact, spec), /content mismatch/);
});
