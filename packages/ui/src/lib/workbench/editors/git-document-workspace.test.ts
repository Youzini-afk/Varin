import { beforeEach, expect, it, vi } from 'vitest';
import type { DocumentsAPI } from '@varin/application-client';
const f = vi.hoisted(() => ({ request: vi.fn(), epoch: 0, reset: [] as Array<() => void>, scope: { documents: {}, api: {}, models: {} } }));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createResourceFilesHttpAPI: () => ({ request: f.request }), getRuntimeEndpointGeneration: () => f.epoch, subscribeRuntimeEndpointWillChange: (callback: () => void) => { f.reset.push(callback); return () => {}; } }));
vi.mock('@/lib/documents/resource-session', () => ({ retainResourceWorkspace: vi.fn(), getResourceDocumentScope: () => f.scope }));
import { projectGitAddress } from '@varin/application-client';
import { resolveGitDocumentWorkspace } from './git-document-workspace';
const location = (hostId: string) => ({ projectId: 'project', path: '/same/root', source: { workspaceId: 'native', resourceOwner: { kind: 'managed_host' as const, hostId, connectionId: `pair-${hostId}`, endpointIdentity: `https://${hostId}.example` } }, selection: { mode: 'native_workspace' as const, workspaceId: 'native', executionWorkspaceId: 'actual-adopted-view', branchId: 'branch', adoptionOperationId: 'original-adoption' } });
const local = { resolveWorkspace: vi.fn(async () => ({ workspaceId: 'local-documents' })) } as unknown as DocumentsAPI;
beforeEach(() => { f.reset.forEach(callback => callback()); f.epoch += 1; f.request.mockReset(); vi.mocked(local.resolveWorkspace).mockClear(); });
it('opens the frozen native selection and keeps target Documents identity separate from the editor view', async () => {
  f.request.mockResolvedValue({ kind: 'opened', root: '/same/root', workspaceId: 'actual-adopted-view' });
  const a = await resolveGitDocumentWorkspace(projectGitAddress(location('a')), local);
  const b = await resolveGitDocumentWorkspace(projectGitAddress(location('b')), local);
  expect(f.request).toHaveBeenNthCalledWith(1, { resourceOwner: location('a').source.resourceOwner, selection: location('a').selection, command: { kind: 'open', path: '/same/root' } }, expect.any(AbortSignal));
  expect(a.workspaceId).toBe('actual-adopted-view');
  expect(a.editorWorkspaceId).not.toBe(a.workspaceId);
  expect(a.editorWorkspaceId).not.toBe(b.editorWorkspaceId);
  expect(a.scope).toBe(f.scope);
  expect(local.resolveWorkspace).not.toHaveBeenCalled();
  expect(await resolveGitDocumentWorkspace(projectGitAddress(location('a')), local)).toBe(a);
  expect(f.request).toHaveBeenCalledTimes(2);
});
it('rejects a late source resolution after a Host switch rather than reusing it', async () => {
  let resolve!: (value: unknown) => void;
  f.request.mockImplementation(() => new Promise(done => { resolve = done; }));
  const pending = resolveGitDocumentWorkspace(projectGitAddress(location('a')), local);
  const failure = expect(pending).rejects.toThrow();
  f.reset.forEach(callback => callback()); f.epoch += 1;
  resolve({ kind: 'opened', root: '/same/root', workspaceId: 'old' });
  await failure;
});
it('keeps explicit local Git directories with their original Documents resolver', async () => {
  const workspace = await resolveGitDocumentWorkspace('/original/local', local);
  expect(local.resolveWorkspace).toHaveBeenCalledWith({ path: '/original/local' });
  expect(workspace).toEqual({ directory: '/original/local', workspaceId: 'local-documents', editorWorkspaceId: 'local-documents' });
  expect(f.request).not.toHaveBeenCalled();
});
