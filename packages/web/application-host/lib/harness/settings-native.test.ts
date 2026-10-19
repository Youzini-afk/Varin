import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentSettingsService } from '../models/settings.js';
import { createSettingsService, type SettingsServiceCaller } from './settings-service.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-settings-')); roots.push(root);
  const project = join(root, 'project'); await mkdir(join(project, '.varin'), { recursive: true });
  let trusted = false;
  const owner = new AgentSettingsService(root, () => trusted);
  const service = createSettingsService({ agentSettings: () => owner, readAppSettings: async () => ({}),
    persistAppSettings: async () => { throw new Error('not the owner'); }, resolveWorkspaceRoot: async () => project });
  const caller: SettingsServiceCaller = { threadId: 'thread', branchId: 'branch', workspaceId: null };
  return { root, project, owner, service, caller, trust: () => { trusted = true; } };
}
describe('native global/project settings ownership', () => {
  it('reads and atomically saves global settings without inventing a workspace or importing old assets', async () => {
    const f = await fixture();
    await mkdir(join(f.root, '.pi')); await writeFile(join(f.root, '.pi', 'settings.json'), '{"defaultProvider":"old"}');
    const before = await f.service.read(f.caller, { id: 'sessions.default-model', scope: 'global' });
    expect(before.state).toBe('ok');
    expect(before.fields?.every(field => !field.isSet)).toBe(true);
    const revision = before.revisions?.global;
    if (!revision) throw new Error('Global settings revision is unavailable');
    const written = await f.service.update(f.caller, { id: 'sessions.default-model', set: { defaultProvider: 'native', defaultModel: 'model' }, expectedRevision: revision });
    expect(written.status).toBe('applied');
    expect(JSON.parse(await readFile(join(f.root, 'agent-settings.json'), 'utf8'))).toMatchObject({ defaultProvider: 'native', defaultModel: 'model' });
    expect(await readFile(join(f.root, '.pi', 'settings.json'), 'utf8')).toBe('{"defaultProvider":"old"}');
    const stale = await f.service.update(f.caller, { id: 'sessions.default-model', set: { defaultModel: 'clobber' }, expectedRevision: revision });
    expect(stale.status).toBe('failed');
    expect((await f.owner.snapshot()).global.defaultModel).toBe('model');
  });
  it('denies untrusted project settings and ignores malformed project data for an explicit global read/write', async () => {
    const f = await fixture(), caller = { ...f.caller, workspaceId: 'admitted-project' };
    expect((await f.service.read(caller, { id: 'harness.shell', scope: 'project' })).state).toBe('denied');
    await expect(f.service.update(caller, { id: 'harness.shell', scope: 'project', set: { 'harness.shell': 'auto' } })).rejects.toThrow(/trusted/);
    f.trust(); await writeFile(join(f.project, '.varin', 'settings.json'), '{ malformed');
    expect((await f.service.read(caller, { id: 'harness.shell', scope: 'global' })).state).toBe('ok');
    expect((await f.service.update(caller, { id: 'harness.shell', scope: 'global', set: { 'harness.shell': 'auto' } })).status).toBe('applied');
    expect((await f.service.read(caller, { id: 'harness.shell', scope: 'project' })).state).toBe('malformed');
    expect(await readFile(join(f.project, '.varin', 'settings.json'), 'utf8')).toBe('{ malformed');
  });
  it('rejects malformed native utility bindings and their project overrides', async () => {
    const f = await fixture();
    await expect(f.service.update(f.caller, { id: 'sessions.small-model', set: { utilityModel: { providerId: 'native' } } })).rejects.toThrow(/providerId and modelId/);
    f.trust();
    const denied = await f.service.update({ ...f.caller, workspaceId: 'project' }, { id: 'sessions.small-model', scope: 'project', set: { utilityModel: { providerId: 'native', modelId: 'model' } } });
    expect(denied.status).toBe('failed');
    expect((await f.owner.snapshot()).global).toEqual({});
  });

});
