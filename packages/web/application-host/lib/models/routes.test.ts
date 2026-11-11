import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import type { ModelChannel } from '@varin/application-client';
import { ModelsService } from './service.js';
import { registerModelRoutes } from './routes.js';
import { createEgressRuntime, EgressError, type EgressFetch } from '../harness/egress.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(fetchImpl: EgressFetch, baseUrl = 'http://127.0.0.1:8088/v1') {
  const directory = await mkdtemp(join(tmpdir(), 'varin-model-route-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const models = new ModelsService(directory, { projectTrusted: () => false, fetch: async () => { throw new Error("Unexpected model fixture network request"); } });
  const channel: ModelChannel = { id: 'local', name: 'Local', type: 'openai', enabled: true,
    baseUrl, authentication: { kind: 'none' }, parameters: {}, models: [] };
  const saved = await models.save(channel, (await models.read()).revision);
  const app = express(); app.use(express.json());
  registerModelRoutes(app, models, (_req, _res, next) => next(), fetchImpl);
  return { app, models, saved, channel, path: join(directory, 'models.json') };
}

test('saved and draft discovery reach a container gateway without changing configuration', async () => {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'local-chat' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const egress = createEgressRuntime({ env: {}, resolveAll: async () => [{ address: '127.0.0.1', family: 4 }] });
  cleanup.push(() => egress.close());
  const { app, models, saved, channel, path } = await fixture(egress.fetch, `http://magpie:${(server.address() as AddressInfo).port}/v1`);
  const original = await readFile(path, 'utf8');
  for (const [route, body] of [['discover', { id: 'local' }], ['discover-draft', { channel }]] as const) {
    const response = await request(app).post(`/api/models/${route}`).send(body).expect(200);
    expect(response.body.models).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'local-chat' })]));
  }
  expect(paths).toEqual(['/v1/models', '/v1/models']);
  expect(await models.read()).toMatchObject({ revision: saved.revision, channels: saved.channels });
  expect(await readFile(path, 'utf8')).toBe(original);
});

test.each(['proxy-auth', 'tls'] as const)('discovery preserves %s classification without exposing dependency messages or causes', async kind => {
  const { app } = await fixture(async () => { throw new EgressError(kind,
    'https://user:secret@example.test/?token=secret', { cause: new Error('Bearer private-token') }); });
  const response = await request(app).post('/api/models/discover').send({ id: 'local' }).expect(503);
  expect(response.body.code).toBe(`model-egress-${kind}`);
  expect(response.body.message).toMatch(kind === 'proxy-auth' ? /proxy authentication/i : /TLS/);
  expect(response.text).not.toMatch(/secret|private-token|example\.test|configuration file/);
});

test('an unclassified discovery failure stays sanitized without inventing a configuration-file diagnosis', async () => {
  const { app } = await fixture(async () => { throw new Error('request failed: Bearer private-token'); });
  const response = await request(app).post('/api/models/discover').send({ id: 'local' }).expect(503);
  expect(response.body.code).toBe('model-settings-unavailable');
  expect(response.text).not.toMatch(/private-token|configuration file/);
});

test('registered remote model defaults use their original coordinator settings owner, not a supplied local cwd or forged namespace', async () => {
  const { models } = await fixture(async () => { throw new Error('No network needed for settings'); });
  const app = express(); app.use(express.json());
  const source = { resourceOwner: { kind: 'managed_host' as const, hostId: 'remote', connectionId: 'saved', endpointIdentity: 'endpoint' }, workspaceId: 'remote-root' };
  registerModelRoutes(app, models, (_req, _res, next) => next(), async () => { throw new Error('No network'); }, undefined,
    async () => [{ id: 'remote-a', path: '/same', source }, { id: 'remote-b', path: '/same', source }]);
  const initial = await request(app).post('/api/models/settings/read').send({ projectId: 'remote-a', cwd: '/same' }).expect(200);
  expect(initial.body.project).toEqual({}); expect(initial.body.projectTrusted).toBe(true);
  await request(app).post('/api/models/settings/update').send({ projectId: 'remote-a', cwd: '/same', registeredProjectId: 'remote-b', scope: 'project',
    expectedRevision: initial.body.projectRevision, set: { defaultProvider: 'original', defaultModel: 'selected' }, remove: [] }).expect(200);
  const other = await request(app).post('/api/models/settings/read').send({ projectId: 'remote-b', cwd: '/same' }).expect(200);
  expect(other.body.project).toEqual({});
  const own = await request(app).post('/api/models/settings/read').send({ projectId: 'remote-a' }).expect(200);
  expect(own.body.project).toEqual({ defaultProvider: 'original', defaultModel: 'selected' });
  await request(app).post('/api/models/settings/read').send({ projectId: 'not-registered', cwd: '/same' }).expect(404);
});
