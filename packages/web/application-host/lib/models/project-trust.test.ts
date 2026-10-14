import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import express from 'express';
import { ProjectTrustService, registerProjectTrustRoutes } from './project-trust.js';
import { AgentSettingsService } from './settings.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'varin-native-trust-')); roots.push(root);
  const data = join(root, 'data'), project = join(root, 'project');
  await mkdir(data); await mkdir(join(project, 'nested'), { recursive: true });
  await symlink(project, join(root, 'alias'), 'dir');
  const workspaces = new Map([['project', project], ['nested', join(project, 'nested')], ['alias', join(root, 'alias')]]);
  const trust = new ProjectTrustService(data, async id => {
    const canonicalPath = workspaces.get(id);
    if (!canonicalPath) throw new Error('Workspace not admitted');
    return { canonicalPath };
  });
  return { root, data, project, workspaces, trust };
}
it('trust is explicit, canonical and revisioned, independent of Pi, and gates native configuration', async () => {
  const { data, project, trust } = await fixture();
  await writeFile(join(data, 'trust.json'), JSON.stringify({ [project]: true }));
  const initial = await trust.snapshot('project');
  expect(initial).toMatchObject({ decision: null, directDecision: null });
  expect(await readdir(data)).toEqual(['trust.json']);
  const settings = new AgentSettingsService(data, cwd => trust.trusted(cwd));
  await mkdir(join(project, '.varin'));
  await writeFile(join(project, '.varin', 'settings.json'), JSON.stringify({ resources: { skills: ['extra'] } }));
  expect((await settings.snapshot(project)).project).toEqual({});
  const accepted = await trust.update({ workspaceId: 'alias', decision: true, expectedRevision: initial.revision });
  expect(accepted).toMatchObject({ path: project, decision: true });
  expect((await settings.snapshot(project)).project.resources).toEqual({ skills: ['extra'] });
  await expect(trust.update({ workspaceId: 'project', decision: false, expectedRevision: initial.revision })).rejects.toMatchObject({ code: 'config_conflict' });
  const denied = await trust.update({ workspaceId: 'nested', decision: false, expectedRevision: accepted.revision });
  expect(denied.decision).toBe(false);
  const inherited = await trust.update({ workspaceId: 'nested', decision: null, expectedRevision: denied.revision });
  expect(inherited).toMatchObject({ decision: true, directDecision: null });
  await trust.update({ workspaceId: 'project', decision: false, expectedRevision: inherited.revision });
  expect((await settings.snapshot(project)).project).toEqual({});
  expect(await readFile(join(data, 'trust.json'), 'utf8')).toBe(JSON.stringify({ [project]: true }));
  await writeFile(join(data, 'project-trust.json'), '{broken');
  expect(() => trust.trusted(project)).toThrow();
  await expect(trust.update({ workspaceId: 'project', decision: true, expectedRevision: initial.revision })).rejects.toThrow();
  expect(await readFile(join(data, 'project-trust.json'), 'utf8')).toBe('{broken');
});

it('authenticated trust API admits workspace IDs and preserves CAS instead of accepting raw paths', async () => {
  const { trust, data } = await fixture();
  const app = express(); app.use(express.json());
  registerProjectTrustRoutes(app, trust, (request, response, next) => request.headers.authorization === 'test-owner' ? next() : void response.sendStatus(401));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address() as { port: number };
  const request = (action: string, body: unknown, authenticated = true) => fetch(`http://127.0.0.1:${address.port}/api/project-trust/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'test-owner' } : {}) }, body: JSON.stringify(body),
  });
  try {
    expect((await request('read', { workspaceId: 'project' }, false)).status).toBe(401);
    expect((await request('update', { cwd: '/arbitrary', decision: true })).status).toBe(400);
    expect((await request('read', { workspaceId: 'unregistered' })).status).toBe(503);
    expect(await readdir(data)).toEqual([]);
    const snapshot = await (await request('read', { workspaceId: 'project' })).json() as { revision: string };
    const update = { workspaceId: 'project', decision: true, expectedRevision: snapshot.revision };
    expect((await request('update', update)).status).toBe(200);
    expect((await request('update', { ...update, decision: false })).status).toBe(409);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
