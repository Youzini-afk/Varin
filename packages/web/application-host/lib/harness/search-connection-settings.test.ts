import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import { getSettingsCatalogEntry } from '@varin/application-client';
import { AgentSettingsService } from '../models/settings.js';
import { createServiceCredentialStore } from '../service-credentials/store.js';
import { createSearchConnectionSettings } from './search-connection-settings.js';
import { createSettingsActionRegistry, type SettingsActionDeps } from './settings-actions.js';
import { registerWebSearchCredentialRoutes } from './web-search-routes.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const entry = getSettingsCatalogEntry('harness.web.search.connections')!;
const ctx = { caller: { threadId: 'thread', branchId: 'branch', workspaceId: null }, workspaceRoot: null };
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-search-settings-')); roots.push(root);
  const settings = new AgentSettingsService(root, () => false);
  const credentials = createServiceCredentialStore(root);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { headers: { 'Content-Type': 'application/json' } }));
  const surfaces = { listForThread: () => [{ id: 'surface', kind: 'web' as const }], request: vi.fn(async () => ({
    surface: { id: 'surface', kind: 'web' as const }, results: [{ id: entry.id, status: 'applied' as const, mutation: 'none' as const }],
  })) };
  const changed = vi.fn();
  const owner = createSearchConnectionSettings({ settings, credentials, searchFetch: fetch as typeof globalThis.fetch, surfaces, changed });
  const adapter = createSettingsActionRegistry({ searchConnections: () => owner } as SettingsActionDeps).adapterFor('service:web-search')!;
  const call = (verb: string, args: Record<string, unknown> = {}) => adapter.invoke(ctx, entry, verb, args);
  const add = async (name: string) => owner.add((await owner.list()).revision, { provider: 'exa', name });
  return { settings, credentials, fetch, surfaces, changed, owner, adapter, call, add };
}

it('edits one connection with the real settings revision, preserving other connections and unrelated settings', async () => {
  const f = await fixture();
  await f.settings.updateHarness((await f.settings.read()).revision, () => ({ web: { sourcePreferences: { preferredDomains: ['example.com'] } }, models: { webSelection: { enabled: false } } }));
  const first = await f.add('Research'); const second = await f.add('General');
  expect(second.configuration?.connections).toHaveLength(2);
  const firstConnection = second.configuration!.connections![0]!;
  const secondConnection = second.configuration!.connections![1]!;
  expect(firstConnection.credentialRef).not.toBe(secondConnection.credentialRef);
  const changed = await f.call('patch', { id: first.connectionId, expectedRevision: second.revision, set: { name: 'Papers', description: 'Academic sources' } });
  expect(changed).toMatchObject({ status: 'applied', mutation: 'applied' });
  expect((await f.owner.list()).configuration?.connections?.[1]).toEqual(secondConnection);
  expect(await f.call('patch', { id: first.connectionId, expectedRevision: second.revision, set: { name: 'Stale' } })).toMatchObject({ status: 'failed', mutation: 'none' });
  expect(await f.call('patch', { id: first.connectionId, expectedRevision: (await f.owner.list()).revision, set: { credentialRef: 'foreign' } })).toMatchObject({ status: 'failed', mutation: 'none' });
  const routed = await f.owner.route((await f.owner.list()).revision, { defaultConnectionId: second.connectionId, fallbackConnectionIds: [first.connectionId], smartSelection: true });
  const removed = await f.owner.remove(routed.revision, first.connectionId);
  expect(removed.configuration).toMatchObject({ defaultConnectionId: second.connectionId, fallbackConnectionIds: [], smartSelection: true });
  expect((await f.settings.read()).document.harness).toMatchObject({ web: { sourcePreferences: { preferredDomains: ['example.com'] } }, models: { webSelection: { enabled: false } } });
  expect((await f.owner.restoreDefault(removed.revision)).keylessDefault).toBe(true);
});

it('allows selection preferences on the anonymous route and preserves them when adding a connection', async () => {
  const f = await fixture();
  const routed = await f.owner.route((await f.owner.list()).revision, { smartSelection: true });
  expect(routed).toMatchObject({ keylessDefault: true, configuration: { smartSelection: true } });
  expect(routed.connections.map(connection => connection.id)).toEqual(['default-exa', 'default-parallel']);
  const added = await f.add('Research');
  expect(added).toMatchObject({ keylessDefault: false, configuration: { smartSelection: true } });
  expect(added.connections).toHaveLength(1);
});

it('lets Agent settings add and test an anonymous AnySearch connection using the same saved route', async () => {
  const f = await fixture();
  const added = await f.call('add', { expectedRevision: (await f.owner.list()).revision,
    connection: { provider: 'anysearch', name: 'General search', description: 'General web lookup' } });
  expect(added).toMatchObject({ status: 'applied', mutation: 'applied' });
  const saved = await f.owner.list();
  const connection = saved.configuration!.connections![0]!;
  expect(saved.connections[0]).toMatchObject({ available: true, credentialConfigured: false });
  expect(connection).toMatchObject({ provider: 'anysearch', description: 'General web lookup' });
  f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { results: [] } }), { headers: { 'Content-Type': 'application/json' } }));
  expect(await f.owner.test(connection.id)).toMatchObject({ providerId: 'configured-anysearch', status: 'empty', resultCount: 0 });
});

it('opens a private UI request and saves through the authenticated credential route without exposing the key to actions', async () => {
  const f = await fixture(); const added = await f.add('Research');
  const result = await f.call('enter-credential', { id: added.connectionId });
  expect(result.status).toBe('pending');
  const operationId = result.operation!.id;
  expect(f.surfaces.request).toHaveBeenCalledWith({ type: 'present-credential', entries: [{ id: entry.id, values: { requestId: operationId } }] }, ctx.caller);
  const app = express(); app.use(express.json());
  registerWebSearchCredentialRoutes(app, { connections: f.owner, readAuth: f.credentials.read, saveAuth: f.credentials.save, removeAuth: f.credentials.remove,
    requireAuth: (req, res, next) => { if (req.get('x-test-user') === 'user') next(); else res.sendStatus(401); } });
  const route = `/api/harness/web-search/credential-requests/${operationId}`;
  await request(app).post(route).send({ apiKey: 'private-key' }).expect(401);
  const saved = await request(app).post(route).set('x-test-user', 'user').send({ apiKey: 'private-key' }).expect(200);
  expect(saved.body.status).toBe('completed');
  const observed = await f.adapter.getOperation!(ctx, entry, operationId, {});
  expect(observed).toMatchObject({ status: 'applied', operation: { id: operationId, state: 'succeeded' } });
  const reference = added.configuration!.connections![0]!.credentialRef!;
  expect(f.credentials.read()[reference]).toEqual({ type: 'api_key', key: 'private-key' });
  for (const value of [result, saved.body, observed, await f.owner.list(), f.changed.mock.calls, f.surfaces.request.mock.calls]) expect(JSON.stringify(value)).not.toContain('private-key');
  expect(await f.call('enter-credential', { id: added.connectionId, apiKey: 'do-not-accept' })).toMatchObject({ status: 'failed', mutation: 'none' });
});

it('cancels pending input and refuses a connection changed after the user was asked', async () => {
  const f = await fixture(); const added = await f.add('Research');
  const pending = await f.owner.requestCredential(added.connectionId, ctx.caller);
  expect(f.owner.cancelCredential(pending.id).status).toBe('cancelled');
  await expect(f.owner.submitCredential(pending.id, 'cancelled-secret')).rejects.toThrow(/no longer/);
  const changed = await f.owner.requestCredential(added.connectionId, ctx.caller);
  await f.owner.patch(added.revision, added.connectionId, { endpoint: 'https://different.example/search' });
  await expect(f.owner.submitCredential(changed.id, 'changed-secret')).rejects.toThrow(/changed/);
  expect(f.credentials.read()).toEqual({});
  expect(f.owner.credentialRequest(changed.id).status).toBe('failed');
  f.surfaces.request.mockRejectedValueOnce(new Error('No bound surface'));
  expect(await f.call('enter-credential', { id: added.connectionId })).toMatchObject({ status: 'failed', mutation: 'none' });
});

it('tests exactly the selected saved connection without fallback, returns real zero hits and supports credential removal', async () => {
  const f = await fixture(); const first = await f.add('Research'); const second = await f.add('Backup');
  await f.owner.route(second.revision, { fallbackConnectionIds: [second.connectionId] });
  await f.owner.saveCredential(first.connectionId, 'first-secret');
  await f.owner.saveCredential(second.connectionId, 'backup-secret');
  const success = await f.call('test', { id: first.connectionId });
  expect(success).toMatchObject({ status: 'applied', data: { connectionId: first.connectionId, status: 'empty', resultCount: 0 } });
  f.fetch.mockImplementationOnce(async () => new Response('Denied', { status: 401 }));
  const failure = await f.call('test', { id: first.connectionId });
  expect(failure).toMatchObject({ status: 'failed', data: { status: 'failed', failure: { kind: 'authentication' } } });
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(JSON.stringify([success, failure])).not.toContain('first-secret');
  expect(await f.call('remove-credential', { id: first.connectionId })).toMatchObject({ status: 'applied', data: { removed: true, configured: false } });
  expect(await f.owner.credential(second.connectionId)).toMatchObject({ configured: true });
});
