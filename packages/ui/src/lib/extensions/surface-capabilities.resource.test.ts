import { expect, it, vi } from 'vitest';
import { surfaceCapabilityRegistry } from './surface-capabilities';
const mocks = vi.hoisted(() => ({ local: vi.fn(), open: vi.fn(), apply: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/runtime-api/registry', () => ({ getRegisteredRuntimeAPIs: () => ({ documents: {} }) }));
vi.mock('@/lib/documents/session', () => ({ getDocumentRegistry: mocks.local }));
vi.mock('@/lib/workbench/editors/resource-workspace', () => ({ getEditorResourceWorkspace: (id: string) => id === 'view-b' ? {
  documentWorkspaceId: 'same-workspace-id', scope: { documents: { open: mocks.open, applyTransaction: mocks.apply, save: mocks.save } },
} : undefined }));
const owner = { desiredRevision: 1, entrypointId: 'editor', extensionId: 'test.editor', extensionVersion: '1.0.0', generation: 1, hostId: 'coordinator', realmId: 'ui' };
const call = (method: string, params: Record<string, string | number | object>) => surfaceCapabilityRegistry.invoke('workspace.documents', method, params as never, owner, ['workspace.documents'], { access: 'remote', projectTrusted: true, surface: 'web' }, new AbortController().signal);
it('routes an isolated editor through its actual resource registry and returns the same view identity', async () => {
  mocks.open.mockResolvedValue({ identity: { workspaceId: 'same-workspace-id', resourceId: 'note.txt' }, status: 'ready', buffer: 'before', baseRevision: 'r1', localEditRevision: 3, dirty: false, saving: false, encoding: 'utf-8', bom: false, byteLength: 6 });
  const resource = { workspaceId: 'view-b', resourceId: 'note.txt' };
  expect(await call('read', { resource })).toMatchObject({ resource, content: 'before' });
  mocks.save.mockResolvedValue({ status: 'ready', baseRevision: 'r2', localEditRevision: 4, byteLength: 5 });
  expect(await call('write', { resource, content: 'after', expectedRevision: 'r1', expectedDocumentVersion: 3 })).toMatchObject({ status: 'written', revision: 'r2' });
  expect(mocks.open).toHaveBeenCalledWith({ workspaceId: 'same-workspace-id', resourceId: 'note.txt' });
  expect(mocks.apply).toHaveBeenCalledWith({ workspaceId: 'same-workspace-id', resourceId: 'note.txt' }, 'after', { origin: 'isolated-editor' });
  expect(mocks.local).not.toHaveBeenCalled();
});
