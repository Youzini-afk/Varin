import { expect, it, vi } from 'vitest';
import type { ResourceDocumentScope } from '@/lib/documents/resource-session';
import { resolveProjectEditorWorkspace, getEditorResourceWorkspace, openProjectResourceFile } from './resource-workspace';
import { activeEditorTab } from './groups';
import { closeWorkbenchEditor, peekEditorWorkbench } from './session';
const mocks = vi.hoisted(() => ({ scopes: new Map<string, ResourceDocumentScope>(), activeMain: vi.fn() }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ setActiveMainTab: mocks.activeMain }) } }));
vi.mock('@/lib/documents/resource-session', () => ({ getResourceDocumentScope: (owner: {hostId:string}) => {
  let scope = mocks.scopes.get(owner.hostId);
  if (!scope) { scope = { api: { setWorkspaceRetention: vi.fn(async () => undefined) }, documents: { releaseClosedWorkspace: vi.fn() } } as unknown as ResourceDocumentScope; mocks.scopes.set(owner.hostId, scope); }
  return scope;
} }));
const location = (hostId: string) => ({ root: '/same/root', workspaceId: 'same-target-id', resourceOwner: { kind: 'managed_host' as const, hostId, connectionId: `${hostId}-connection`, endpointIdentity: `${hostId}-endpoint` }, selection: {mode:'live_root' as const} });
it('isolates identical target workspaces and retains the original owner rather than a navigation identity', async () => {
  const a = resolveProjectEditorWorkspace(location('a')), b = resolveProjectEditorWorkspace(location('b'));
  expect(a.workspaceId).not.toBe(b.workspaceId);
  const openedA = openProjectResourceFile(location('a'), 'file.txt');
  const openedB = openProjectResourceFile(location('b'), 'other.txt');
  await vi.waitFor(() => expect(a.scope.api.setWorkspaceRetention).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'same-target-id', retained: true })));
  closeWorkbenchEditor(a.workspaceId, activeEditorTab(openedA)!.tabId);
  await vi.waitFor(() => expect(a.scope.api.setWorkspaceRetention).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'same-target-id', retained: false })));
  expect(b.scope.api.setWorkspaceRetention).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'same-target-id', retained: true }));
  expect(activeEditorTab(peekEditorWorkbench(b.workspaceId)!)?.resourceId).toBe(activeEditorTab(openedB)?.resourceId);
});
it('freezes the source independently of later project changes', () => {
  const input = location('frozen'), original = resolveProjectEditorWorkspace(input);
  input.root = '/changed';
  expect(original.location.root).toBe('/same/root');
  expect(resolveProjectEditorWorkspace(input).workspaceId).not.toBe(original.workspaceId);
  expect(getEditorResourceWorkspace(original.workspaceId)).toBe(original);
});
