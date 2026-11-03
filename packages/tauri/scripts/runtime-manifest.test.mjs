import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import identity from '../../../scripts/kernel-binary-identity.cjs';
import { hostPackage, hostEntry, hostSettingsEntry, hostBrowserEntry, requiredHostAssets, inventory, legalPaths, manifestName, relativePath, sha256, targets, verifyRuntimeManifest, writeRuntimeManifest, kernelProtocolVersion } from './runtime-manifest.mjs';
import { nodeLock, nodeTarget } from './node-runtime.mjs';
import { publishRuntime } from './publish-runtime.mjs';
import { frameworkPath, macFrameworkFixture } from './test-fixtures/mac-framework.mjs';

export function binaryFixture(platform, architecture) {
  const bytes = Buffer.alloc(128);
  if (platform === 'win32') {
    bytes.write('MZ'); bytes.writeUInt32LE(64, 0x3c); bytes.write('PE\0\0', 64); bytes.writeUInt16LE(architecture === 'x64' ? 0x8664 : 0xaa64, 68);
  } else if (platform === 'linux') {
    bytes.write('\x7fELF'); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(architecture === 'x64' ? 62 : 183, 18);
  } else { bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(architecture === 'x64' ? 0x01000007 : 0x0100000c, 4); }
  return bytes;
}

async function fixture(t, platform = process.platform, architecture = process.arch) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-tauri-manifest-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const write = async (file, content) => {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), content);
  };
  const suffix = platform === 'win32' ? '.exe' : '';
  const node = nodeTarget(platform, architecture);
  await write(`node/node${suffix}`, binaryFixture(platform, architecture));
  await write(`kernel/varin-kernel${suffix}`, binaryFixture(platform, architecture));
  await write(`tools/rg${suffix}`, binaryFixture(platform, architecture));
  if (platform !== 'win32') for (const file of [`node/node${suffix}`, `kernel/varin-kernel${suffix}`, `tools/rg${suffix}`]) await fs.chmod(path.join(directory, file), 0o755);
  await write('kernel/manifest.json', JSON.stringify({ schema: 3, executable: `varin-kernel${suffix}`, platform, arch: architecture,
    buildIdentity: '1.2.3', protocolVersion: kernelProtocolVersion, kernelVersion: '0.1.0',
    binaryFormat: { win32: 'pe', linux: 'elf', darwin: 'macho' }[platform], targetTriple: identity.defaultKernelTargetTriple(platform, architecture),
    sha256: await sha256(path.join(directory, `kernel/varin-kernel${suffix}`)) }));
  for (const file of [hostEntry, hostSettingsEntry, hostBrowserEntry, ...requiredHostAssets, `${hostPackage}/server/index.js`, `${hostPackage}/server/public-contract.js`]) await write(file, 'export {};\n');
  await write(`${hostPackage}/server/production-boundary.json`, '{}');
  await write(`${hostPackage}/package.json`, JSON.stringify({ name: '@varin/web', version: '1.2.3' }));
  await write('frontend/index.html', '<!doctype html>');
  await write('frontend/assets/image.bin', Buffer.from([0, 1, 255]));
  for (const file of legalPaths) await write(file, 'license notice');
  const options = { platform, architecture, version: '1.2.3', node: { version: node.version, archive: node.archive, sourceSha256: node.sha256, source: node.url } };
  await writeRuntimeManifest(directory, options);
  return { directory, options, write };
}

for (const target of targets) test(`verifies actual inventory and executable identities for ${target}`, {
  skip: process.platform === 'win32' && !target.startsWith('win32-') ? 'Windows cannot represent foreign POSIX executable modes' : false,
}, async t => {
  const [platform, architecture] = target.split('-');
  const { directory } = await fixture(t, platform, architecture);
  const manifest = await verifyRuntimeManifest(directory, { platform, architecture });
  assert.equal(manifest.files.find(file => file.path === 'frontend/assets/image.bin').size, 3);
  assert.equal(manifest.node.sourceSha256, nodeLock.targets[target].sha256);
  await assert.rejects(verifyRuntimeManifest(directory, { architecture: architecture === 'x64' ? 'arm64' : 'x64' }), /target/);
});

test('byte corruption, missing assets, extra files, and removed licenses each reject a prepared product', async t => {
  const { directory, write } = await fixture(t);
  await write('frontend/assets/image.bin', Buffer.from([0, 1, 254]));
  await assert.rejects(verifyRuntimeManifest(directory), /integrity/);
  await write('frontend/assets/image.bin', Buffer.from([0, 1, 255]));
  await write('unlisted.js', 'untrusted');
  await assert.rejects(verifyRuntimeManifest(directory), /unlisted/);
  await fs.rm(path.join(directory, 'unlisted.js'));
  await fs.rm(path.join(directory, 'node/LICENSE'));
  await assert.rejects(verifyRuntimeManifest(directory), /missing/);
});

test('entry paths, inventory paths and duplicate records cannot escape the resource root', async t => {
  for (const invalid of ['../outside', '/absolute', 'C:/windows', 'a/../b', 'a//b', 'a\\b', '.', 'a\0b']) assert.throws(() => relativePath(invalid), /path/);
  const { directory } = await fixture(t);
  const file = path.join(directory, manifestName);
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...manifest, files: [...manifest.files, manifest.files[0]] }));
  await assert.rejects(verifyRuntimeManifest(directory), /file record/);
  await fs.writeFile(file, JSON.stringify({ ...manifest, host: { ...manifest.host, entry: '../outside' } }));
  await assert.rejects(verifyRuntimeManifest(directory), /entry points/);
});

test('symlinks are never accepted as bundled assets or as the manifest', { skip: process.platform === 'win32' }, async t => {
  const { directory } = await fixture(t);
  await fs.symlink('../node/LICENSE', path.join(directory, 'frontend/external'));
  await assert.rejects(inventory(directory), /symbolic link/);
  await fs.rm(path.join(directory, 'frontend/external'));
  await fs.rename(path.join(directory, manifestName), path.join(directory, 'saved-manifest.json'));
  await fs.symlink('saved-manifest.json', path.join(directory, manifestName));
  await assert.rejects(verifyRuntimeManifest(directory), /regular file/);
});

test('the macOS manifest seals framework alias text separately from physical file bytes', { skip: process.platform === 'win32' }, async t => {
  const { directory, options } = await fixture(t, 'darwin', 'arm64');
  const legacyRoot = path.join(directory, 'legacy-electron');
  const links = await macFrameworkFixture(legacyRoot);
  const legacyElectron = { schema: 1, protocol: 1, version: '1.2.3', sourceSha: 'a'.repeat(40), directory: 'legacy-electron',
    executable: 'legacy-electron/Varin.app/Contents/MacOS/Varin', links };
  const manifest = await writeRuntimeManifest(directory, { ...options, legacyElectron });
  assert.deepEqual(manifest.legacyElectron.links, links);
  await verifyRuntimeManifest(directory);
  const manifestFile = path.join(directory, manifestName), current = path.join(legacyRoot, frameworkPath, 'Versions/Current');
  const rewrite = value => fs.writeFile(manifestFile, JSON.stringify(value));
  const replace = async target => { await fs.rm(current); await fs.symlink(target, current); };
  await fs.cp(path.join(legacyRoot, frameworkPath, 'Versions/A'), path.join(legacyRoot, frameworkPath, 'Versions/B'), { recursive: true });
  await replace('B');
  await assert.rejects(verifyRuntimeManifest(directory), /symbolic link changed/);
  await replace('A'); await fs.rm(path.join(legacyRoot, frameworkPath, 'Versions/B'), { recursive: true });
  await rewrite({ ...manifest, legacyElectron: { ...legacyElectron, links: links.slice(1) } });
  await assert.rejects(verifyRuntimeManifest(directory), /unlisted symbolic link/);
  await rewrite({ ...manifest, legacyElectron: { ...legacyElectron, links: [...links, links[0]] } });
  await assert.rejects(verifyRuntimeManifest(directory), /Duplicate/);
  await rewrite(manifest);
  await fs.rm(current); await fs.cp(path.join(legacyRoot, frameworkPath, 'Versions/A'), current, { recursive: true });
  await assert.rejects(verifyRuntimeManifest(directory), /symbolic link changed/);
  await fs.rm(current, { recursive: true }); await fs.symlink('A', current);
  const binaryAlias = path.join(legacyRoot, frameworkPath, 'Electron Framework');
  for (const target of ['Versions//Current/Electron Framework', 'Versions/Current/Electron Framework/']) {
    await fs.rm(binaryAlias); await fs.symlink(target, binaryAlias);
    await assert.rejects(verifyRuntimeManifest(directory), /symbolic link changed/);
  }
  await fs.rm(binaryAlias); await fs.symlink('Versions/Current/Electron Framework', binaryAlias);
  await fs.writeFile(path.join(legacyRoot, frameworkPath, 'Versions/A/Resources/Info.plist'), 'tampered');
  await assert.rejects(verifyRuntimeManifest(directory), /integrity mismatch/);
});

test('wrong kernel identity and wrong Node provenance fail even when the byte inventory is recomputed', async t => {
  const { directory, options, write } = await fixture(t);
  const kernel = JSON.parse(await fs.readFile(path.join(directory, 'kernel/manifest.json'), 'utf8'));
  await write('kernel/manifest.json', JSON.stringify({ ...kernel, buildIdentity: 'unrelated' }));
  await assert.rejects(writeRuntimeManifest(directory, options), /Kernel manifest/);
  await write('kernel/manifest.json', JSON.stringify(kernel));
  await assert.rejects(writeRuntimeManifest(directory, { ...options, node: { ...options.node, sourceSha256: '0'.repeat(64) } }), /fixed distribution lock/);
});

test('development runtime cannot become a production release by editing eligibility', async t => {
  const { directory } = await fixture(t);
  const file = path.join(directory, manifestName);
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...manifest, release: { eligible: true, blockers: [] } }));
  await assert.rejects(verifyRuntimeManifest(directory, { production: true }), /production distribution is blocked/);
});

test('publication restores the previous generation when candidate promotion fails', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-tauri-publish-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const active = path.join(root, 'active'), candidate = path.join(root, 'candidate');
  await fs.mkdir(active); await fs.mkdir(candidate);
  await fs.writeFile(path.join(active, 'value'), 'old'); await fs.writeFile(path.join(candidate, 'value'), 'new');
  await assert.rejects(publishRuntime(candidate, active, { rename: (from, to) => from === candidate
    ? Promise.reject(Object.assign(new Error('busy destination'), { code: 'EPERM' })) : fs.rename(from, to) }), /busy destination/);
  assert.equal(await fs.readFile(path.join(active, 'value'), 'utf8'), 'old');
  await publishRuntime(candidate, active);
  assert.equal(await fs.readFile(path.join(active, 'value'), 'utf8'), 'new');
});

test('desktop launcher uses its verified generation and cannot request a production bundle', async t => {
  const { desktopInvocation } = await import('./desktop.mjs');
  const { directory, write } = await fixture(t);
  const invocation = await desktopInvocation('build', directory);
  assert.equal(invocation.env.VARIN_DESKTOP_RUNTIME_DIR, directory);
  assert.ok(invocation.args.includes('--debug'));
  assert.ok(invocation.args.includes('--no-bundle'));
  const config = JSON.parse(invocation.args.at(-1));
  assert.equal(config.build.frontendDist, path.join(directory, 'frontend'));
  assert.deepEqual(config.bundle.resources, []);
  await assert.rejects(desktopInvocation('release', directory), /production distribution/);
  await write('frontend/index.html', 'altered');
  await assert.rejects(desktopInvocation('dev', directory), /integrity/);
});

test('staging refuses to replace an unrelated populated output directory', async t => {
  const { validateRuntimeDestination } = await import('./stage-desktop.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-tauri-output-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await validateRuntimeDestination(path.join(root, 'new'));
  await validateRuntimeDestination(root);
  await fs.writeFile(path.join(root, 'important'), 'original asset');
  await assert.rejects(validateRuntimeDestination(root), /unrelated/);
  assert.equal(await fs.readFile(path.join(root, 'important'), 'utf8'), 'original asset');
  const { directory } = await fixture(t);
  await validateRuntimeDestination(directory);
});

test('production eligibility requires authenticated qualification for this exact immutable runtime', async t => {
  const { directory, options } = await fixture(t);
  const { publicKey, signFixture } = await import('./test-fixtures/signing.mjs');
  const { metadataBytes } = await import('../../../scripts/desktop-update-signatures.mjs');
  const { acceptanceDomains } = await import('./release.mjs');
  const sourceSha = 'a'.repeat(40);
  await writeRuntimeManifest(directory, { ...options, sources: { sourceSha, sourceDirty: false }, browser: { engine: 'CEF', version: 'fixture', architecture: options.architecture } });
  const receipt = { schema: 1, product: 'varin-tauri-qualification', version: options.version, sourceSha, targets: {
    [`${options.platform}-${options.architecture}`]: { runtimeManifestSha256: await sha256(path.join(directory, manifestName)), engineManifestSha256: 'b'.repeat(64), acceptanceSha256: 'c'.repeat(64), acceptedDomains: acceptanceDomains },
  } };
  receipt.varinSignature = signFixture(metadataBytes(receipt));
  await verifyRuntimeManifest(directory, { production: true, qualification: receipt, publicKey });
  const changed = structuredClone(receipt); changed.sourceSha = 'b'.repeat(40);
  await assert.rejects(verifyRuntimeManifest(directory, { production: true, qualification: changed, publicKey }), /verification/);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, manifestName), 'utf8'));
  manifest.version = '1.2.4'; await fs.writeFile(path.join(directory, manifestName), JSON.stringify(manifest));
  await assert.rejects(verifyRuntimeManifest(directory, { production: true, qualification: receipt, publicKey }), /identity|version|exact runtime/);
});
