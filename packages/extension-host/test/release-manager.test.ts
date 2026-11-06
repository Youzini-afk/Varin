import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { c as createTar } from 'tar';
import { ApplicationExtensionRuntime, ApplicationExtensionCatalog, ExtensionPackageManager, ExtensionReleaseManager, extractExtensionRelease } from '../src/index.js';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'varin-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = new ApplicationExtensionCatalog({ dataDir: join(root, 'data') });
  const packages = new ExtensionPackageManager({ catalog, dataDir: join(root, 'data'), varinVersion: '1.2.3' });
  return { root, catalog, packages };
}
async function archive(root: string, version: string) {
  const source = join(root, version);
  await mkdir(join(source, 'package'), { recursive: true });
  await writeFile(join(source, 'package/varin.extension.json'), JSON.stringify({ schemaVersion: 1, id: 'dev.release.test', version, engines: { varin: '^1.0.0' },
    entrypoints: { host: { mode: 'brokered', file: 'host.cjs' } } }));
  // Preparing a preview must never evaluate author code or run a package lifecycle.
  await writeFile(join(source, 'package/host.cjs'), 'throw new Error("AUTHOR CODE EXECUTED");');
  await writeFile(join(source, 'package/package.json'), JSON.stringify({ version, dependencies: { missing: '1' }, scripts: { install: 'exit 1' } }));
  const file = join(root, `${version}.tgz`);
  await createTar({ cwd: source, file, gzip: true }, ['package']);
  return file;
}

test('local archive previews freeze bytes; source changes require approval; stale and failed candidates preserve selection', async t => {
  const { root, catalog, packages } = await fixture(t);
  const manager = new ExtensionReleaseManager({ packages, hostId: 'host-a' });
  const first = await archive(root, '1.0.0');
  await assert.rejects(manager.preview({ kind: 'release-archive', specifier: first, display: 'plugin.tgz' }), /archive upload/);
  const preview = await manager.previewArchive(first, 'plugin.tgz');
  assert.deepEqual(preview.source, { kind: 'release-archive', display: 'plugin.tgz' });
  await writeFile(first, 'replaced after review');
  await assert.rejects(manager.install({ previewId: preview.previewId, expectedHostId: 'host-b', expectedRevision: 0 }), /another Host/);
  const installed = await manager.install({ previewId: preview.previewId, expectedHostId: 'host-a', expectedRevision: 0 });
  assert.equal(installed.extensions[0]?.desired.enabled, false);
  assert.equal(installed.extensions[0]?.manifest.version, '1.0.0');
  const next = await manager.previewArchive(await archive(root, '1.1.0'), 'other.tgz');
  assert.equal(next.sourceChanged, true);
  await assert.rejects(manager.install({ previewId: next.previewId, expectedHostId: 'host-a', expectedRevision: installed.revision }), /explicit approval/);
  await assert.rejects(manager.install({ previewId: next.previewId, expectedHostId: 'host-a', expectedRevision: 0, replaceSource: true }));
  const staged = await manager.install({ previewId: next.previewId, expectedHostId: 'host-a', expectedRevision: installed.revision, replaceSource: true });
  assert.equal(staged.extensions[0]?.manifest.version, '1.0.0');
  assert.equal(staged.extensions[0]?.candidate?.manifest.version, '1.1.0');
  assert.equal((await catalog.snapshot()).extensions[0]?.integrity, preview.integrity);
  const replacement = await manager.previewArchive(await archive(root, '1.1.0'), 'third.tgz');
  assert.equal(replacement.integrity, next.integrity);
  await manager.install({ previewId: replacement.previewId, expectedHostId: 'host-a', expectedRevision: replacement.catalogRevision, replaceSource: true });
  const record = (await catalog.store.read()).document.extensions['dev.release.test']!;
  assert.equal(record.source.specifier, 'plugin.tgz');
  assert.equal(record.candidate?.source.specifier, 'third.tgz');
  assert.equal(record.manifest.version, '1.0.0');
});

test('npm metadata is deduplicated and revalidated, downloads honor integrity and confirmation never refetches latest', async t => {
  const { root, packages } = await fixture(t);
  const bytes = await readFile(await archive(root, '1.0.0'));
  let downloads = 0;
  let metadata = 0;
  let wrongBytes = false;
  let finishMetadata: (() => void) | undefined;
  let pendingMetadata: Promise<void> | undefined;
  const fetcher = new ExtensionReleaseManager({ packages, hostId: 'host', fetch: async (url, init) => {
    if (url.endsWith('.tgz')) { downloads++; return new Response(wrongBytes ? 'wrong' : bytes); }
    metadata++;
    await pendingMetadata;
    if (new Headers(init?.headers).get('if-none-match')) return new Response(null, { status: 304 });
    return Response.json({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { tarball: 'https://example.org/package.tgz', integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } } } }, { headers: { etag: 'v1' } });
  } });
  const source = { kind: 'npm' as const, display: 'example', specifier: 'example@>=1.0.0 <2.0.0' };
  const preview = await fetcher.preview(source, 'dev.release.test');
  await fetcher.install({ previewId: preview.previewId, expectedHostId: 'host', expectedRevision: 0 });
  assert.equal(downloads, 1);
  pendingMetadata = new Promise<void>(resolve => { finishMetadata = resolve; });
  const read = packages.catalog.store.read.bind(packages.catalog.store);
  let reads = 0;
  let readBoth!: () => void;
  const bothRead = new Promise<void>(resolve => { readBoth = resolve; });
  const readMock = t.mock.method(packages.catalog.store, 'read', async () => {
    const result = await read();
    if (++reads === 2) readBoth();
    return result;
  });
  const checksPending = Promise.all([fetcher.checkUpdates(), fetcher.checkUpdates()]);
  await bothRead;
  finishMetadata!();
  const checks = await checksPending;
  readMock.mock.restore();
  pendingMetadata = undefined;
  assert.equal(checks[0]?.[0]?.status, 'current');
  assert.equal(metadata, 2);
  assert.equal(downloads, 1);
  wrongBytes = true;
  await assert.rejects(fetcher.preview(source), /integrity mismatch/);
});

test('release archives reject links before extraction', async t => {
  const { root } = await fixture(t);
  const source = join(root, 'unsafe');
  await mkdir(join(source, 'package'), { recursive: true });
  await writeFile(join(source, 'package/varin.extension.json'), '{}');
  await symlink('/tmp', join(source, 'package/escape'));
  const file = join(root, 'unsafe.tgz');
  await createTar({ cwd: source, file, gzip: true }, ['package']);
  await assert.rejects(extractExtensionRelease(file, join(root, 'extract')), /Unsafe release archive entry/);
});

test('GitHub series resolves semver-compatible targets and reports newer undeliverable versions without downloading archives', async t => {
  const { root, packages } = await fixture(t);
  const bytes = await readFile(await archive(root, '1.9.0'));
  const requests: string[] = [];
  const manager = new ExtensionReleaseManager({ packages, hostId: 'host', platform: 'linux', arch: 'x64', fetch: async url => {
    requests.push(url);
    if (url.includes('api.github.com')) return Response.json([
      { tag_name: 'other-v9.0.0', draft: false, prerelease: false, assets: [] },
      { tag_name: 'plugin-v1.10.0', draft: false, prerelease: false, assets: [{ name: 'plugin.release.json', browser_download_url: 'https://example.org/new.json' }] },
      { tag_name: 'plugin-v1.9.0', draft: false, prerelease: false, assets: [{ name: 'plugin.release.json', browser_download_url: 'https://example.org/old.json' }, { name: 'plugin.tgz', browser_download_url: 'https://example.org/plugin.tgz' }] },
    ]);
    if (url.endsWith('.json')) return Response.json({ schemaVersion: 1, extensionId: 'dev.release.test', version: url.endsWith('new.json') ? '1.10.0' : '1.9.0',
      engines: { varin: url.endsWith('new.json') ? '>=9' : '^1.0.0' }, assets: [{ file: 'plugin.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), platform: 'linux', arch: 'x64' }] });
    return new Response(bytes);
  } });
  const preview = await manager.preview({ kind: 'github-release', display: 'Plugin', specifier: 'Owner/Repo#stable?tagPrefix=plugin-v&manifest=plugin.release.json' }, 'dev.release.test');
  assert.equal(preview.version, '1.9.0');
  assert.equal(preview.releaseNotesUrl, 'https://github.com/owner/repo/releases/tag/plugin-v1.9.0');
  assert.match(preview.warnings[0]!, /requires Varin/);
  await manager.install({ previewId: preview.previewId, expectedHostId: 'host', expectedRevision: 0 });
  const before = requests.filter(url => url.endsWith('.tgz')).length;
  const updates = await manager.checkUpdates();
  assert.equal(updates[0]?.status, 'unavailable');
  assert.equal(requests.filter(url => url.endsWith('.tgz')).length, before);
});

test('confirmation rejects damaged immutable preview content before writing installation state', async t => {
  const { root, packages, catalog } = await fixture(t);
  const manager = new ExtensionReleaseManager({ packages, hostId: 'host' });
  const preview = await manager.previewArchive(await archive(root, '1.0.0'), 'plugin.tgz');
  await writeFile(join(packages.artifacts.directory, preview.integrity.slice('sha256-'.length), 'package/host.cjs'), 'tampered');
  await assert.rejects(manager.install({ previewId: preview.previewId, expectedHostId: 'host', expectedRevision: 0 }));
  assert.equal((await catalog.snapshot()).extensions.length, 0);
});


test('runtime release staging publishes observer state without cold-activating author code', async t => {
  const { root, catalog, packages } = await fixture(t);
  let starts = 0;
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: join(root, 'data'), catalog, packages,
    varinVersion: '1.2.3', brokerScript: join(root, 'never-launch.cjs'),
    transportFactory: () => { starts++; throw new Error('Preview/staging must not activate'); } });
  t.after(() => runtime.stop());
  let changes = 0;
  runtime.subscribe(() => { changes++; });
  const manager = new ExtensionReleaseManager({ packages, hostId: runtime.services.hostId, install: runtime.installPreparedRelease.bind(runtime) });
  const preview = await manager.previewArchive(await archive(root, '1.0.0'), 'plugin.tgz');
  assert.equal(changes, 0);
  await manager.install({ previewId: preview.previewId, expectedHostId: preview.hostId, expectedRevision: preview.catalogRevision });
  assert.ok(changes > 0);
  assert.equal(starts, 0);
  assert.equal((await runtime.catalog.snapshot()).extensions[0]?.desired.enabled, false);
});

for (const replaceSource of [false, true]) {
  test(`update checks use current installed facts while an old ${replaceSource ? 'source' : 'version'} check is pending`, async t => {
    const { root, catalog, packages } = await fixture(t);
    const firstBytes = await readFile(await archive(root, '1.0.0'));
    const nextBytes = await readFile(await archive(root, '2.0.0'));
    let latest = '1.0.0';
    let delayOld = false;
    let releaseOld!: () => void, enteredOld!: () => void;
    const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
    const oldEntered = new Promise<void>(resolve => { enteredOld = resolve; });
    const manager = new ExtensionReleaseManager({ packages, hostId: 'host', fetch: async url => {
      if (url.endsWith('.tgz')) return new Response(url.includes('2.0.0') ? nextBytes : firstBytes);
      if (delayOld && url.endsWith('/original')) { enteredOld(); await oldGate; }
      const available = url.endsWith('/replacement') ? '1.0.0' : latest;
      return Response.json({ 'dist-tags': { latest: available }, versions: Object.fromEntries(([
        ['1.0.0', firstBytes], ['2.0.0', nextBytes],
      ] as const).map(([version, bytes]) => [version, { engines: { varin: '^1.0.0' }, dist: {
        tarball: `https://example.org/${version}.tgz`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      } }])) });
    } });
    const source = { kind: 'npm' as const, display: 'Original', specifier: 'original' };
    const first = await manager.preview(source);
    await manager.install({ previewId: first.previewId, expectedHostId: 'host', expectedRevision: first.catalogRevision });
    latest = '2.0.0';
    const replacement = await manager.preview(replaceSource ? { ...source, specifier: 'replacement' } : source);
    delayOld = true;
    const oldCheck = manager.checkUpdates();
    await oldEntered;
    const staged = await manager.install({ previewId: replacement.previewId, expectedHostId: 'host',
      expectedRevision: replacement.catalogRevision, replaceSource });
    const requested = await catalog.requestCandidateApplication('dev.release.test', replacement.integrity, staged.revision);
    await catalog.selectCandidate('dev.release.test', replacement.integrity, requested.revision);
    const currentCheck = manager.checkUpdates();
    releaseOld();
    assert.equal((await oldCheck)[0]?.status, 'available');
    const current = (await currentCheck)[0];
    assert.equal(current?.status, 'current');
    assert.equal(current?.version, replaceSource ? '1.0.0' : '2.0.0');
    assert.equal((await catalog.store.read()).document.extensions['dev.release.test']?.source.specifier,
      replaceSource ? 'replacement' : 'original');
  });
}
