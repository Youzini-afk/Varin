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

async function kernelFixture(t, arch) {
  const root = await fixture(t);
  for (const file of ['scripts/build-products.mjs', 'scripts/build-cache.mjs', 'scripts/build-kernel.mjs',
    'scripts/kernel-binary-identity.cjs', 'packages/workspace-driver/macos/build-helper.mjs',
    'kernel/rust-toolchain.toml', 'kernel/protocol/schema.json', 'package.json']) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(new URL(`../${file}`, import.meta.url), path.join(root, file));
  }
  // Header-only fixture: exercise real target validation/staging without a Rust compilation.
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(arch === 'arm64' ? 183 : 62, 18);
  const prebuilt = path.join(root, 'prebuilt-kernel');
  await fs.writeFile(prebuilt, bytes);
  return { root, bytes, env: { ...process.env, VARIN_TARGET_PLATFORM: 'linux', VARIN_TARGET_ARCH: 'aarch64',
    VARIN_TARGET_TRIPLE: '', VARIN_KERNEL_ARTIFACT: '', VARIN_RELEASE_SOURCE_SHA: '', VARIN_KERNEL_PREBUILT: prebuilt } };
}

test('kernel product stages and exports the requested Docker target rather than the build host', async t => {
  const { root, bytes, env } = await kernelFixture(t, 'arm64');
  execFileSync(process.execPath, ['scripts/build-products.mjs', 'kernel', '--export', 'exported-kernel'],
    { cwd: root, env, encoding: 'utf8', windowsHide: true });
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'exported-kernel/payload/manifest.json'), 'utf8'));
  assert.equal(manifest.platform, 'linux');
  assert.equal(manifest.arch, 'arm64');
  assert.equal(manifest.targetTriple, 'aarch64-unknown-linux-gnu');
  assert.deepEqual(await fs.readFile(path.join(root, 'artifacts/build/kernel-linux-arm64/varin-kernel')), bytes);
  const receipt = JSON.parse(await fs.readFile(path.join(root, 'exported-kernel/build-artifact.json'), 'utf8'));
  assert.equal(receipt.values.arch, 'arm64');
  assert.equal(receipt.values.platform, 'linux');
});

test('explicit kernel product targets override environment aliases and still reject wrong-architecture binaries', async t => {
  const { root, env } = await kernelFixture(t, 'x64');
  execFileSync(process.execPath, ['--input-type=module', '-e',
    'import { prepareKernel } from "./scripts/build-products.mjs"; await prepareKernel("linux", "amd64");'],
  { cwd: root, env, encoding: 'utf8', windowsHide: true });
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'artifacts/build/kernel-linux-x64/manifest.json'), 'utf8'));
  assert.equal(manifest.arch, 'x64');
  assert.throws(() => execFileSync(process.execPath, ['scripts/build-products.mjs', 'kernel'],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }),
  error => /binary is linux\/x64, expected linux\/arm64/.test(error.stderr));
});

test('frontend reuse and artifact restore include dependency patch bytes', async t => {
  const root = await fixture(t);
  for (const file of ['scripts/build-products.mjs', 'scripts/build-cache.mjs',
    'scripts/kernel-binary-identity.cjs', 'package.json']) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(new URL(`../${file}`, import.meta.url), path.join(root, file));
  }
  await fs.mkdir(path.join(root, 'bun-patches'));
  const patch = path.join(root, 'bun-patches/list.patch');
  await fs.writeFile(patch, 'original dependency patch');
  // Use the production frontend input selection and real cache/transfer code. Only the expensive
  // bundler is replaced: its output identifies the dependency bytes that it consumed.
  const run = action => execFileSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { BuildCache } from './scripts/build-cache.mjs';
    const task = BuildCache.prototype.task;
    BuildCache.prototype.task = function (name, spec) {
      if (name !== 'frontend') throw new Error('Unexpected producer: ' + name);
      return task.call(this, name, { ...spec, async build() {
        await fs.mkdir(spec.outputs[0], { recursive: true });
        await fs.copyFile('bun-patches/list.patch', path.join(spec.outputs[0], 'app.js'));
      } });
    };
    const { prepareFrontend, exportFrontend } = await import('./scripts/build-products.mjs');
    ${action}
  `], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe',
    env: { ...process.env, BUN: process.execPath, VARIN_FRONTEND_ARTIFACT: '' } });
  run('await exportFrontend("exported-frontend");');
  assert.match(run('await prepareFrontend();'), /frontend: reused/);
  await fs.writeFile(patch, 'updated dependency patch');
  assert.throws(() => run('await prepareFrontend({ importDirectory: "exported-frontend" });'),
    error => /artifact source or build options mismatch/.test(error.stderr));
  assert.match(run('await prepareFrontend();'), /frontend: building/);
  assert.equal(await fs.readFile(path.join(root, 'artifacts/build/frontend/app.js'), 'utf8'),
    'updated dependency patch');
});
