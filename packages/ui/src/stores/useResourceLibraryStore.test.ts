import { beforeEach, expect, it, vi } from 'vitest';
import type { NativeResourceDescriptor, NativeResourceDocumentSnapshot } from '@varin/application-client';
const fixture = vi.hoisted(() => ({ host: 1, trustListeners: new Set<() => void>(), listeners: new Set<() => void>(), api: { list: vi.fn(), read: vi.fn(), create: vi.fn(), update: vi.fn(), copy: vi.fn(), remove: vi.fn() } }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(),
  createResourceManagementHttpAPI: () => fixture.api, getRuntimeEndpointGeneration: () => fixture.host,
  subscribeRuntimeEndpointWillChange: (listener: () => void) => { fixture.listeners.add(listener); return () => fixture.listeners.delete(listener); } }));
vi.mock('@/lib/projectTrust', () => ({ subscribeProjectTrustChanges: (listener: () => void) => { fixture.trustListeners.add(listener); return () => fixture.trustListeners.delete(listener); } }));
import { useResourceLibraryStore } from './useResourceLibraryStore';
const resource = (id: string, writable = true): NativeResourceDescriptor => ({ id, name: id, description: '', filePath: `/skills/${id}/SKILL.md`, kind: 'skill', active: true, valid: true, writable,
  sourceInfo: { origin: writable ? 'top-level' : 'package', scope: 'user', path: `/skills/${id}/SKILL.md`, source: 'user' } });
const document = (id = 'review', content = '# Original', revision = 'one', writable = true): NativeResourceDocumentSnapshot => ({ descriptor: resource(id, writable), content, revision, projectTrusted: true });
const target = { projectId: 'project' }; const targetKey = 'host:project';
const load = () => useResourceLibraryStore.getState().loadCatalog('skill', target, targetKey);
const pane = () => useResourceLibraryStore.getState().panes.skill;
beforeEach(() => {
  for (const listener of fixture.listeners) listener(); fixture.host += 1; vi.clearAllMocks();
  fixture.api.list.mockResolvedValue({ resources: [resource('review')], diagnostics: [], projectTrusted: true });
  fixture.api.read.mockResolvedValue(document()); fixture.api.update.mockImplementation(async (_target, input) => document(input.id, input.content, 'two'));
  fixture.api.copy.mockImplementation(async (_target, input) => document(input.name)); fixture.api.remove.mockResolvedValue({ deleted: true });
  fixture.api.create.mockImplementation(async (_target, input) => document(input.name, input.content));
});
it('saves the original revision and adopts the native returned revision', async () => {
  await load(); useResourceLibraryStore.getState().setDraft('skill', '# Changed');
  expect(await useResourceLibraryStore.getState().saveResource('skill', target, targetKey)).toBe(true);
  expect(fixture.api.update).toHaveBeenCalledWith(target, { id: 'review', expectedRevision: 'one', content: '# Changed', key: expect.any(String) });
  expect(pane()).toMatchObject({ document: { revision: 'two' }, draft: '# Changed', mutating: false });
});
it('keeps original draft and key after an uncertain mutation result', async () => {
  await load(); useResourceLibraryStore.getState().setDraft('skill', '# Changed'); fixture.api.update.mockRejectedValueOnce(new Error('reply lost'));
  expect(await useResourceLibraryStore.getState().saveResource('skill', target, targetKey)).toBe(false);
  expect(pane()).toMatchObject({ draft: '# Changed', document: { revision: 'one' }, error: 'reply lost' });
  expect(await useResourceLibraryStore.getState().saveResource('skill', target, targetKey)).toBe(true);
  expect(fixture.api.update.mock.calls[1]).toEqual(fixture.api.update.mock.calls[0]);
});
it('does not write a document into a different selected project', async () => {
  await load(); useResourceLibraryStore.getState().setDraft('skill', '# Changed');
  expect(await useResourceLibraryStore.getState().saveResource('skill', { projectId: 'other' }, 'host:other')).toBe(false);
  expect(fixture.api.update).not.toHaveBeenCalled();
});
it('leaves package resources read-only but copies with their original revision', async () => {
  fixture.api.read.mockResolvedValue(document('review', '# package', 'package-revision', false)); await load();
  useResourceLibraryStore.getState().setDraft('skill', '# Changed');
  expect(await useResourceLibraryStore.getState().saveResource('skill', target, targetKey)).toBe(false);
  expect(await useResourceLibraryStore.getState().deleteResource('skill', target, targetKey)).toBe(false);
  expect(await useResourceLibraryStore.getState().copyResource('skill', target, targetKey, 'project', 'my-copy')).toBe(true);
  expect(fixture.api.copy).toHaveBeenCalledWith(target, { id: 'review', expectedRevision: 'package-revision', scope: 'project', name: 'my-copy', key: expect.any(String) });
});
it('retires a late original Host response without loading a replacement Host catalog', async () => {
  await load(); useResourceLibraryStore.getState().setDraft('skill', '# Changed');
  let resolve!: (result: NativeResourceDocumentSnapshot) => void;
  fixture.api.update.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const saved = useResourceLibraryStore.getState().saveResource('skill', target, targetKey);
  for (const listener of fixture.listeners) listener(); fixture.host += 1;
  resolve(document('review', '# Changed', 'two')); expect(await saved).toBe(false);
  expect(fixture.api.list).toHaveBeenCalledOnce(); expect(pane().document).toBeNull();
});
it('adopts a confirmed save even if its subsequent catalog refresh fails', async () => {
  await load(); useResourceLibraryStore.getState().setDraft('skill', '# Changed'); fixture.api.list.mockRejectedValueOnce(new Error('catalog offline'));
  expect(await useResourceLibraryStore.getState().saveResource('skill', target, targetKey)).toBe(true);
  expect(pane()).toMatchObject({ document: { revision: 'two' }, draft: '# Changed', mutating: false, error: 'catalog offline' });
  expect(await useResourceLibraryStore.getState().saveResource('skill', target, targetKey)).toBe(false);
  expect(fixture.api.update).toHaveBeenCalledOnce();
});

it('freezes project writes immediately on trust invalidation and preserves dirty text through a revoked catalog', async () => {
  const projectResource = { ...resource('review'), sourceInfo: { ...resource('review').sourceInfo, scope: 'project' as const } };
  fixture.api.list.mockResolvedValue({ resources: [projectResource], diagnostics: [], projectTrusted: true });
  fixture.api.read.mockResolvedValue({ ...document(), descriptor: projectResource });
  await load(); useResourceLibraryStore.getState().setDraft('skill', '# Unsaved work');
  for (const listener of fixture.trustListeners) listener();
  expect(pane()).toMatchObject({ draft: '# Unsaved work', document: { descriptor: { writable: false } } });
  expect(await useResourceLibraryStore.getState().saveResource('skill', target, targetKey)).toBe(false);
  expect(await useResourceLibraryStore.getState().createResource('skill', target, targetKey, 'project', 'new', 'text')).toBe(false);
  expect(await useResourceLibraryStore.getState().copyResource('skill', target, targetKey, 'user')).toBe(false);
  fixture.api.list.mockResolvedValue({ resources: [], diagnostics: [], projectTrusted: false }); await load();
  expect(pane()).toMatchObject({ draft: '# Unsaved work', selectedId: 'review', document: { descriptor: { writable: false } } });
  expect(fixture.api.update).not.toHaveBeenCalled();
});

it('ignores an already accepted project save response after trust invalidation', async () => {
  await load(); useResourceLibraryStore.getState().setDraft('skill', '# Unsaved work');
  let resolve!: (value: NativeResourceDocumentSnapshot) => void;
  fixture.api.update.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const saving = useResourceLibraryStore.getState().saveResource('skill', target, targetKey);
  for (const listener of fixture.trustListeners) listener();
  resolve(document('review', '# Saved elsewhere', 'new')); expect(await saving).toBe(false);
  expect(pane().draft).toBe('# Unsaved work');
});
