import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { expect, it } from 'vitest';
import type { EmbeddingRequestSettings } from '@varin/application-client';
import { createEmbeddingRequestSettings, registerEmbeddingRequestRoutes } from './request-settings.js';

it('persists embedding scheduling preferences with revisions and applies them at Host startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-embedding-settings-'));
  try {
    const settings = createEmbeddingRequestSettings(root);
    await settings.load();
    const initial = await settings.read();
    const saved = await settings.save({ concurrentRequests: 3, requestIntervalMs: 250 }, initial.revision);
    expect(await settings.snapshot()).toMatchObject({ config: saved.config, activeConfig: initial.config, restartRequired: true });
    await expect(settings.save(initial.config, initial.revision)).rejects.toThrow('changed elsewhere');
    await expect(settings.save({ ...saved.config, storageDirectory: root }, saved.revision)).rejects.toThrow('Unsupported');
    await expect(settings.save({ concurrentRequests: 0 }, saved.revision)).rejects.toThrow('positive integer');
    const restarted = createEmbeddingRequestSettings(root);
    await restarted.load();
    expect(await restarted.snapshot()).toMatchObject({ config: saved.config, activeConfig: saved.config, restartRequired: false });
    expect(JSON.parse(await readFile(path.join(root, 'embedding-request-settings.json'), 'utf8'))).toEqual(saved.config);
    await writeFile(path.join(root, 'embedding-request-settings.json'), '{broken');
    const broken = await settings.read();
    expect(broken.error).toBeTruthy();
    await settings.save(broken.config, broken.revision);
    expect((await settings.read()).error).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('authenticates read/write requests and leaves old code-index endpoints unavailable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-embedding-route-'));
  const settings = createEmbeddingRequestSettings(root);
  await settings.load();
  const app = express();
  registerEmbeddingRequestRoutes(app, settings, (request, response, next) => {
    if (request.header('x-test-auth') !== 'yes') response.sendStatus(401);
    else next();
  });
  const server = app.listen(0);
  try {
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/harness`;
    const headers = { 'x-test-auth': 'yes', 'Content-Type': 'application/json' };
    expect((await fetch(`${base}/embedding-requests`)).status).toBe(401);
    const initial = await (await fetch(`${base}/embedding-requests`, { headers })).json() as EmbeddingRequestSettings;
    const save = (revision: string) => fetch(`${base}/embedding-requests`, { method: 'PUT', headers,
      body: JSON.stringify({ revision, config: { concurrentRequests: 2, requestIntervalMs: 100 } }) });
    expect((await save(initial.revision)).status).toBe(200);
    expect((await save(initial.revision)).status).toBe(409);
    expect((await fetch(`${base}/semantic-index`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/semantic-index/directories`, { method: 'POST', headers, body: '{}' })).status).toBe(404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
