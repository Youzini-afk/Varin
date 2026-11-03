import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { nodeLock, nodeTarget, stageNodeRuntime, verifyNodeArchive } from './node-runtime.mjs';
import { readBinaryIdentity, sha256 } from './runtime-manifest.mjs';

// A foreign architecture fixture is inspected, not executed. No fixture claims
// to prove the real distributed binary's execution; smoke-runtime owns that.
async function archiveFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-node-archive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const platform = 'linux', architecture = process.platform === 'linux' && process.arch === 'arm64' ? 'x64' : 'arm64';
  const pin = nodeTarget(platform, architecture);
  const distribution = `node-v${pin.version}-${platform}-${architecture}`;
  const binary = Buffer.alloc(64);
  binary.write('\x7fELF'); binary[4] = 2; binary[5] = 1; binary.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
  await fs.mkdir(path.join(root, distribution, 'bin'), { recursive: true });
  await fs.writeFile(path.join(root, distribution, 'bin/node'), binary);
  await fs.writeFile(path.join(root, distribution, 'LICENSE'), 'Node and bundled dependencies licenses');
  await fs.writeFile(path.join(root, distribution, 'bin/npm'), 'must not ship');
  const archive = path.join(root, pin.archive);
  execFileSync('tar', ['-czf', archive, '-C', root, distribution]);
  const lock = structuredClone(nodeLock);
  lock.targets[`${platform}-${architecture}`].sha256 = await sha256(archive);
  return { root, archive, platform, architecture, lock, destination: path.join(root, 'node') };
}

test('Node pin covers all six native targets with one exact version and distinct archives', () => {
  const targets = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64', 'win32-arm64'];
  assert.deepEqual(Object.keys(nodeLock.targets).sort(), targets.sort());
  assert.equal(new Set(targets.map(target => { const [platform, architecture] = target.split('-'); return nodeTarget(platform, architecture).url; })).size, 6);
  assert.throws(() => nodeTarget('linux', 'arm'), /fixed Node target/);
  assert.throws(() => nodeTarget('freebsd', 'x64'), /fixed Node target/);
});

test('staging extracts only fixed Node executable and legal notice from a checksum-verified archive', async t => {
  const options = await archiveFixture(t);
  const result = await stageNodeRuntime(options);
  assert.deepEqual((await fs.readdir(options.destination)).sort(), ['LICENSE', 'node']);
  assert.equal(result.sourceSha256, await sha256(options.archive));
  assert.deepEqual(await readBinaryIdentity(path.join(options.destination, 'node')), { platform: options.platform, arch: options.architecture, format: 'elf' });
});

test('missing or altered Node archive fails before touching an existing generation and does not fetch', async t => {
  const options = await archiveFixture(t);
  await fs.mkdir(options.destination);
  await fs.writeFile(path.join(options.destination, 'previous'), 'retained');
  await assert.rejects(stageNodeRuntime({ ...options, archive: path.join(options.root, 'missing') }), /not prepared/);
  await fs.appendFile(options.archive, 'corrupt');
  await assert.rejects(stageNodeRuntime(options), /SHA256 mismatch/);
  assert.equal(await fs.readFile(path.join(options.destination, 'previous'), 'utf8'), 'retained');
});

test('archive verification rejects directory and symbolic-link substitutions', { skip: process.platform === 'win32' }, async t => {
  const options = await archiveFixture(t);
  await assert.rejects(verifyNodeArchive(options.root, nodeTarget(options.platform, options.architecture)), /regular file/);
  const alias = path.join(options.root, 'alias');
  await fs.symlink(options.archive, alias);
  await assert.rejects(verifyNodeArchive(alias, nodeTarget(options.platform, options.architecture)), /regular file/);
});
