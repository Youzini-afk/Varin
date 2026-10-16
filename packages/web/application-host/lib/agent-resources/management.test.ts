import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentAuthority } from '../documents/authority.js';
import { AgentSettingsService } from '../models/settings.js';
import { createResourceManagement } from './management.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const skill = (name: string, body = 'Use the native owner.') => `---\nname: ${name}\ndescription: A useful skill\n---\n${body}\n`;
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-resource-management-')));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), project = path.join(root, 'project'), userAgents = path.join(root, 'home', '.agents');
  await fs.mkdir(data); await fs.mkdir(project); await fs.mkdir(userAgents, { recursive: true });
  let trusted = true;
  const settings = new AgentSettingsService(data, cwd => trusted && cwd === project);
  const documents = createDocumentAuthority({ hostId: '11111111-1111-4111-8111-111111111111', dataDir: data, isAllowedRoot: async candidate => candidate === root || candidate.startsWith(`${root}${path.sep}`) });
  cleanups.push(() => documents.dispose());
  const owner = createResourceManagement({ dataDirectory: data, settings, documents, userAgentsDirectory: userAgents, resolveProjectRoot: id => id === 'project-1' ? project : null });
  return { root, data, project, userAgents, settings, documents, owner, setTrusted(value: boolean) { trusted = value; } };
}

describe('native resource management', () => {
  it('previews current system resources before a conversation exists', async () => {
    const { owner, data, project, setTrusted } = await fixture();
    expect((await owner.prompt({})).original.preamble).toContain('You are Varin');
    await fs.mkdir(path.join(data, 'resources'), { recursive: true });
    await fs.writeFile(path.join(data, 'resources', 'SYSTEM.md'), 'Current global identity');
    await fs.writeFile(path.join(data, 'resources', 'APPEND_SYSTEM.md'), 'Appended instructions');
    await owner.create({}, { scope: 'user', name: 'review', content: skill('review'), key: 'preview-skill' });
    const global = await owner.prompt({});
    expect(global.original).toMatchObject({ preamble: 'Current global identity', append_system: 'Appended instructions' });
    expect(global.original.skills).toContain('review');
    await fs.mkdir(path.join(project, '.varin', 'resources'), { recursive: true });
    await fs.writeFile(path.join(project, '.varin', 'resources', 'SYSTEM.md'), 'Project identity');
    await fs.writeFile(path.join(project, 'AGENTS.md'), 'Project rules');
    const scoped = await owner.prompt({ projectId: 'project-1' });
    expect(scoped.original.preamble).toBe('Project identity');
    expect(scoped.original.workspace_instructions).toContain('Project rules');
    expect((await owner.prompt({})).original.workspace_instructions).toBeUndefined();
    setTrusted(false);
    expect((await owner.prompt({ projectId: 'project-1' })).original.preamble).toBe('Current global identity');
  });
  it('creates, reads, updates and removes global skills without any Thread or project', async () => {
    const { owner, data } = await fixture();
    expect((await owner.list({})).resources).toEqual([]);
    const created = await owner.create({}, { scope: 'user', name: 'hello', content: skill('hello'), key: 'create-hello' });
    expect(created.descriptor).toMatchObject({ name: 'hello', writable: true, valid: true, sourceInfo: { scope: 'user' } });
    expect(await fs.readFile(path.join(data, 'resources', 'skills', 'hello', 'SKILL.md'), 'utf8')).toBe(skill('hello'));
    const listed = await owner.list({});
    expect(listed.resources).toHaveLength(1);
    expect(listed.resources[0]).toMatchObject({ id: created.descriptor.id, active: true });
    const read = await owner.read({}, created.descriptor.id);
    expect(read.revision).toBe(created.revision);
    const updated = await owner.update({}, { id: read.descriptor.id, content: skill('hello', 'Updated.'), expectedRevision: read.revision, key: 'save-hello' });
    expect(updated.revision).not.toBe(read.revision);
    await expect(owner.update({}, { id: read.descriptor.id, content: 'lost update', expectedRevision: read.revision, key: 'stale-save' })).rejects.toMatchObject({ status: 409, code: 'resource-conflict' });
    await fs.writeFile(path.join(data, 'resources', 'skills', 'hello', 'support.txt'), 'Keep bundle support files.');
    await expect(owner.remove({}, { id: read.descriptor.id, expectedRevision: read.revision, key: 'stale-delete' })).rejects.toMatchObject({ status: 409 });
    expect(await owner.remove({}, { id: read.descriptor.id, expectedRevision: updated.revision, key: 'delete-hello' })).toEqual({ removed: true });
    expect(await fs.readFile(path.join(data, 'resources', 'skills', 'hello', 'support.txt'), 'utf8')).toBe('Keep bundle support files.');
  });

  it('requires the saved project and native trust; global remains usable with no project', async () => {
    const { owner, project, setTrusted } = await fixture();
    await expect(owner.list({ projectId: project })).rejects.toMatchObject({ code: 'project-missing' });
    await expect(owner.list({ cwd: project } as never)).rejects.toMatchObject({ code: 'resource-invalid' });
    const created = await owner.create({ projectId: 'project-1' }, { scope: 'project', name: 'project-skill', content: skill('project-skill'), key: 'create-project' });
    expect(created.descriptor.filePath).toBe(path.join(project, '.varin', 'resources', 'skills', 'project-skill', 'SKILL.md'));
    setTrusted(false);
    expect(await owner.list({ projectId: 'project-1' })).toMatchObject({ projectTrusted: false, resources: [] });
    await expect(owner.update({ projectId: 'project-1' }, { id: created.descriptor.id, content: 'forbidden', expectedRevision: created.revision, key: 'untrusted-save' })).rejects.toMatchObject({ code: 'resource-missing' });
    await expect(owner.create({ projectId: 'project-1' }, { scope: 'project', name: 'new', content: skill('new'), key: 'untrusted-create' })).rejects.toMatchObject({ status: 403 });
    expect((await owner.create({}, { scope: 'user', name: 'global', content: skill('global'), key: 'global-create' })).descriptor.writable).toBe(true);
  });

  it('shows invalid, disabled and colliding resources; malformed native settings are never overwritten', async () => {
    const { owner, data, project } = await fixture();
    const target = { projectId: 'project-1' };
    await owner.create({}, { scope: 'user', name: 'shared', content: skill('shared'), key: 'shared-global' });
    await owner.create(target, { scope: 'project', name: 'shared', content: skill('shared'), key: 'shared-project' });
    const broken = await owner.create({}, { scope: 'user', name: 'broken', content: '---\nname: broken\n---\nMissing description.', key: 'broken' });
    const view = await owner.list(target);
    expect(view.resources.find(item => item.id === broken.descriptor.id)).toMatchObject({ valid: false, active: false, writable: true });
    expect(view.resources.filter(item => item.name === 'shared' && item.active)).toHaveLength(1);
    expect(view.resources.find(item => item.name === 'shared' && item.active)?.sourceInfo.scope).toBe('project');
    expect(view.diagnostics.some(item => item.kind === 'collision')).toBe(true);
    await owner.update({}, { id: broken.descriptor.id, expectedRevision: broken.revision, content: skill('broken'), key: 'repair' });
    await fs.writeFile(path.join(data, 'agent-settings.json'), JSON.stringify({ resources: { skills: ['!skills/broken/SKILL.md'] } }));
    expect((await owner.list({})).resources.find(item => item.name === 'broken')).toMatchObject({ active: false, valid: true });
    await fs.writeFile(path.join(project, '.varin', 'settings.json'), '{invalid');
    await expect(owner.list(target)).rejects.toBeDefined();
    expect((await owner.list({})).resources.length).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(project, '.varin', 'settings.json'), 'utf8')).toBe('{invalid');
  });

  it('lists installed package and configured resources read-only and copies reviewed bytes with source CAS', async () => {
    const { owner, root, data } = await fixture();
    const pkg = path.join(root, 'resource-package'), extra = path.join(root, 'explicit-skill.md');
    await fs.mkdir(path.join(pkg, 'skills', 'package-skill'), { recursive: true });
    await fs.writeFile(path.join(pkg, 'skills', 'package-skill', 'SKILL.md'), skill('package-skill'));
    await fs.writeFile(extra, skill('configured-skill'));
    await fs.writeFile(path.join(data, 'agent-settings.json'), JSON.stringify({ resources: { packages: [pkg], skills: [extra] } }));
    const view = await owner.list({});
    expect(view.resources.map(item => [item.name, item.writable]).sort()).toEqual([['configured-skill', false], ['package-skill', false]]);
    const source = await owner.read({}, view.resources.find(item => item.name === 'package-skill')!.id);
    await expect(owner.update({}, { id: source.descriptor.id, expectedRevision: source.revision, content: 'forbidden', key: 'package-write' })).rejects.toMatchObject({ code: 'resource-read-only' });
    const copied = await owner.copy({}, { id: source.descriptor.id, expectedRevision: source.revision, scope: 'user', name: 'copied', key: 'copy-package' });
    expect(copied.content).toBe(source.content);
    expect(copied.descriptor.writable).toBe(true);
    await fs.writeFile(source.descriptor.filePath, skill('package-skill', 'New bytes.'));
    await expect(owner.copy({}, { id: source.descriptor.id, expectedRevision: source.revision, scope: 'user', name: 'stale-copy', key: 'stale-copy' })).rejects.toMatchObject({ code: 'resource-conflict' });
  });

  it('rejects arbitrary authority, traversal and symlink write selectors; preserves old runtime assets', async () => {
    const { owner, data, project, root } = await fixture();
    const old = path.join(project, '.pi', 'skills', 'old', 'SKILL.md');
    await fs.mkdir(path.dirname(old), { recursive: true }); await fs.writeFile(old, skill('old'));
    expect((await owner.list({ projectId: 'project-1' })).resources).toEqual([]);
    await expect(owner.create({}, { scope: 'user', name: '../escape', content: skill('escape'), key: 'traversal' })).rejects.toMatchObject({ code: 'resource-invalid' });
    await expect(owner.create({}, { scope: 'user', name: 'fake', content: skill('fake'), key: 'forged', grantId: 'forged' } as never)).rejects.toMatchObject({ code: 'resource-invalid' });
    await fs.mkdir(path.join(data, 'resources', 'skills'), { recursive: true });
    const destination = path.join(root, 'outside'); await fs.mkdir(destination);
    await fs.symlink(destination, path.join(data, 'resources', 'skills', 'link'));
    await expect(owner.create({}, { scope: 'user', name: 'link', content: skill('escape'), key: 'symlink' })).rejects.toMatchObject({ code: 'resource-read-only' });
    expect(await fs.readFile(old, 'utf8')).toBe(skill('old'));
  });

  it('passes the original key and CAS into the existing Documents owner without an alternate writer', async () => {
    const { owner, documents } = await fixture();
    const write = vi.spyOn(documents, 'write');
    const created = await owner.create({}, { scope: 'user', name: 'receipt', content: skill('receipt'), key: 'original-key' });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'original-key', expectedRevision: null, token: expect.objectContaining({ owner: { kind: 'resource-editor', id: 'original-key' } }) }));
    await owner.update({}, { id: created.descriptor.id, expectedRevision: created.revision, content: skill('receipt', 'Changed.'), key: 'original-save' });
    expect(write).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: 'original-save', expectedRevision: created.revision }));
  });
});

it('keeps authenticated HTTP fields, native owner conflicts and original Host generation through the public client', async () => {
  const { EventEmitter } = await import('node:events');
  const { registerResourceManagementRoutes } = await import('./management-routes.js');
  const { createResourceManagementHttpAPI } = await import('@varin/application-client');
  const { owner } = await fixture();
  const handlers = new Map<string, import('express').RequestHandler>();
  const auth: import('express').RequestHandler = (_request, _response, next) => next();
  registerResourceManagementRoutes({ post(route: string, guard: import('express').RequestHandler, handler: import('express').RequestHandler) {
    expect(guard).toBe(auth); handlers.set(route, handler);
  } } as unknown as import('express').Express, owner, auth);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    let status = 200; let body: unknown;
    const response = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false,
      status(code: number) { status = code; return this; }, json(value: unknown) { body = value; this.writableEnded = true; return this; } });
    const handler = handlers.get(String(url));
    if (!handler) throw new Error('Unexpected route');
    await handler({ body: JSON.parse(String(init?.body)) } as import('express').Request, response as unknown as import('express').Response, () => {});
    return Response.json(body, { status });
  };
  try {
    const api = createResourceManagementHttpAPI();
    const created = await api.create({}, { scope: 'user', name: 'http', content: skill('http'), key: 'http-create' });
    expect((await api.read({}, created.descriptor.id)).revision).toBe(created.revision);
    await api.update({}, { id: created.descriptor.id, content: skill('http', 'Changed'), expectedRevision: created.revision, key: 'http-save' });
    await expect(api.remove({}, { id: created.descriptor.id, expectedRevision: created.revision, key: 'http-stale' })).rejects.toMatchObject({ status: 409, code: 'resource-conflict' });
    for (const fields of [{ cwd: '/tmp' }, { grant: 'fake' }, { threadId: 'fake' }]) {
      const response = await fetch('/api/resources/list', { method: 'POST', body: JSON.stringify({ target: {}, ...fields }) });
      expect(response.status).toBe(400);
    }
    await expect(createResourceManagementHttpAPI(-1).list({})).rejects.toMatchObject({ code: 'host-changed' });
  } finally { globalThis.fetch = originalFetch; }
});

it('edits conventional .agents skills through their actual admitted directory owner', async () => {
  const { owner, userAgents, project, setTrusted } = await fixture();
  const userPath = path.join(userAgents, 'skills', 'user-agent', 'SKILL.md');
  const projectPath = path.join(project, '.agents', 'skills', 'project-agent', 'SKILL.md');
  for (const [file, name] of [[userPath, 'user-agent'], [projectPath, 'project-agent']] as const) {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, skill(name));
  }
  const target = { projectId: 'project-1' };
  const view = await owner.list(target);
  expect(view.resources.every(resource => resource.writable)).toBe(true);
  for (const resource of view.resources) {
    const document = await owner.read(target, resource.id);
    await owner.update(target, { id: resource.id, content: skill(resource.name, 'Edited.'), expectedRevision: document.revision, key: `save-${resource.name}` });
    expect(await fs.readFile(resource.filePath, 'utf8')).toContain('Edited.');
  }
  setTrusted(false);
  expect((await owner.list(target)).resources.map(resource => resource.name)).toEqual(['user-agent']);
});

it('rechecks original project trust after document observation and before dispatching a write', async () => {
  const { owner, documents, setTrusted } = await fixture();
  const target = { projectId: 'project-1' };
  const created = await owner.create(target, { scope: 'project', name: 'revoked', content: skill('revoked'), key: 'revoked-create' });
  const write = vi.spyOn(documents, 'write');
  const originalRead = documents.read.bind(documents);
  vi.spyOn(documents, 'read').mockImplementation(async (...args) => {
    const result = await originalRead(...args); setTrusted(false); return result;
  });
  await expect(owner.update(target, { id: created.descriptor.id, content: 'never saved', expectedRevision: created.revision, key: 'revoked-update' })).rejects.toMatchObject({ status: 403, code: 'project-trust-revoked' });
  expect(write).not.toHaveBeenCalled();
  expect(await fs.readFile(created.descriptor.filePath, 'utf8')).toBe(skill('revoked'));
});
