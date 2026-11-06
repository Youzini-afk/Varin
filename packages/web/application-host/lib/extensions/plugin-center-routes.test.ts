import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import { c as createTar } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { ApplicationExtensionCatalog, ExtensionPackageManager, ExtensionReleaseManager } from '@varin/extension-host';
import { PluginDiscoveryService } from './discovery.js';
import { registerPluginCenterRoutes } from './plugin-center-routes.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'varin-plugin-route-')); roots.push(root);
  const catalog = new ApplicationExtensionCatalog({ dataDir: join(root, 'data') });
  const packages = new ExtensionPackageManager({ catalog, dataDir: join(root, 'data'), varinVersion: '1.2.3' });
  const hostId = (await catalog.snapshot()).hostId;
  const releases = new ExtensionReleaseManager({ packages, hostId });
  const discovery = new PluginDiscoveryService({ dataDir: join(root, 'data'), hostId, catalog });
  const app = express(); app.use(express.json());
  registerPluginCenterRoutes(app, { discovery, releases,
    requireAuth: (req, res, next) => req.headers['x-session'] === 'yes' ? next() : res.sendStatus(401) });
  const packageRoot = join(root, 'package'); await mkdir(packageRoot);
  await writeFile(join(packageRoot, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id: 'dev.example.upload', version: '1.0.0', engines: { varin: '^1.0.0' },
    entrypoints: { host: { mode: 'brokered', file: 'host.cjs' } } }));
  await writeFile(join(packageRoot, 'host.cjs'), 'throw new Error("must not evaluate during preview");');
  const archive = join(root, 'release.tgz'); await createTar({ cwd: root, file: archive, gzip: true }, ['package']);
  return { app, catalog, packages, packageRoot, hostId, bytes: await readFile(archive) };
}

describe('Plugin center authenticated Host routes', () => {
  it('uploads and previews actual archive bytes without executing code, then installs that fixed artifact disabled', async () => {
    const { app, catalog, hostId, bytes } = await fixture();
    await request(app).get('/api/varin/extensions/v1/discovery').expect(401);
    const preview = (await request(app).post('/api/varin/extensions/v1/releases/preview-archive').set('x-session', 'yes')
      .set('Content-Type', 'application/octet-stream').set('X-Varin-Archive-Name', encodeURIComponent('天气.tgz')).send(bytes).expect(200)).body;
    expect(preview.manifest.id).toBe('dev.example.upload');
    expect(preview.source).toEqual({ kind: 'release-archive', display: '天气.tgz' });
    expect((await catalog.snapshot()).extensions).toHaveLength(0);
    const confirmation = { previewId: preview.previewId, expectedHostId: hostId, expectedRevision: preview.catalogRevision };
    await request(app).post('/api/varin/extensions/v1/releases/install').set('x-session', 'yes').send({ ...confirmation, expectedHostId: 'other-host' }).expect(400);
    const installed = (await request(app).post('/api/varin/extensions/v1/releases/install').set('x-session', 'yes').send(confirmation).expect(200)).body;
    expect(installed.extensions[0]).toMatchObject({ integrity: preview.integrity, desired: { enabled: false } });
    expect(JSON.stringify(installed)).not.toContain('varin-plugin-upload-');
    const updates = (await request(app).post('/api/varin/extensions/v1/updates').set('x-session', 'yes').send({}).expect(200)).body;
    expect(updates).toMatchObject([{ extensionId: 'dev.example.upload', status: 'manual' }]);
  });

  it('discarded preview and invalid confirmation cannot mutate installation state', async () => {
    const { app, catalog, hostId, bytes } = await fixture();
    const preview = (await request(app).post('/api/varin/extensions/v1/releases/preview-archive').set('x-session', 'yes')
      .set('Content-Type', 'application/octet-stream').set('X-Varin-Archive-Name', 'plugin.tgz').send(bytes).expect(200)).body;
    await request(app).post('/api/varin/extensions/v1/releases/install').set('x-session', 'yes').send({ previewId: preview.previewId, expectedHostId: hostId }).expect(400);
    await request(app).post('/api/varin/extensions/v1/releases/discard').set('x-session', 'yes').send({ previewId: preview.previewId }).expect(200);
    await request(app).post('/api/varin/extensions/v1/releases/install').set('x-session', 'yes').send({ previewId: preview.previewId, expectedHostId: hostId, expectedRevision: 0 }).expect(400);
    expect((await catalog.snapshot()).extensions).toHaveLength(0);
  });

  it('locates a source-matched installation after all discovery directories are removed', async () => {
    const { app, catalog, packages, packageRoot, hostId } = await fixture();
    const source = { kind: 'npm' as const, specifier: '@example/upload', display: 'Upload' };
    const artifact = await packages.artifacts.prepareRelease(packageRoot, source);
    await packages.installPrepared(artifact, 0, true);
    await request(app).put('/api/varin/extensions/v1/discovery/sources').set('x-session', 'yes').send({ sources: [] }).expect(200);
    const lookup = (value: typeof source) => request(app).post('/api/varin/extensions/v1/discovery/resolve-installed')
      .set('x-session', 'yes').send({ source: value, extensionId: 'dev.example.upload' });
    expect((await lookup({ ...source, specifier: '@example/upload@latest' }).expect(200)).body)
      .toEqual({ hostId, extensionId: 'dev.example.upload' });
    expect((await lookup({ ...source, specifier: '@other/upload' }).expect(200)).body).toEqual({ hostId });
    expect((await request(app).get('/api/varin/extensions/v1/discovery').set('x-session', 'yes').expect(200)).body.entries).toEqual([]);
    await writeFile(catalog.store.catalogPath, '{ invalid');
    await lookup(source).expect(400);
    expect(await readFile(catalog.store.catalogPath, 'utf8')).toBe('{ invalid');
  });
});
