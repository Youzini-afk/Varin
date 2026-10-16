import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { ModelChannel } from '@varin/application-client';
import { ModelsService } from './service.js';
import { registerModelRoutes } from './routes.js';
import { createEgressRuntime, EgressError, type EgressFetch } from '../harness/egress.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(fetchImpl: EgressFetch) {
  const directory = await mkdtemp(join(tmpdir(), 'varin-model-route-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const models = new ModelsService(directory, { projectTrusted: () => false, fetch: async () => { throw new Error("Unexpected model fixture network request"); } });
  const channel: ModelChannel = { id: 'local', name: 'Local', type: 'openai', enabled: true,
    baseUrl: 'http://127.0.0.1:8088/v1', authentication: { kind: 'none' }, parameters: {}, models: [] };
  const saved = await models.save(channel, (await models.read()).revision);
  const app = express(); app.use(express.json());
  registerModelRoutes(app, models, (_req, _res, next) => next(), fetchImpl);
  return { app, models, saved, path: join(directory, 'models.json') };
}

test('discovery reports the real remote Host private-network denial without claiming valid settings are broken', async () => {
  const egress = createEgressRuntime({ env: {} }); cleanup.push(() => egress.close());
  const { app, models, saved, path } = await fixture(egress.fetch);
  const original = await readFile(path, 'utf8');
  const response = await request(app).post('/api/models/discover').send({ id: 'local' }).expect(403);
  expect(response.body.code).toBe('model-egress-private-network');
  expect(response.body.message).toContain('local or private network addresses');
  expect(response.text).not.toContain('configuration file');
  expect(await models.read()).toEqual(saved);
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
