import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceCombinedRecoveryOperation, WorkspaceCombinedRecoveryPlan, WorkspaceRecoveryAPI, WorkspaceRecoveryStatus } from '@varin/extension-contract';
import type { ThreadIdentity } from '@varin/application-client';
type ThreadState = { selectedIdentity: ThreadIdentity | null };
import { WorkspaceRecoveryPanel } from './WorkspaceRecoveryPanel';

const mocks = vi.hoisted(() => ({ api: undefined as WorkspaceRecoveryAPI | undefined, state: {} as ThreadState,
  host: 1, listeners: new Set<() => void>(), t: (key: string) => key }));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => mocks.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
}));
vi.mock('@/stores/useThreadStore', () => ({ useThreadStore: <T,>(select: (state: ThreadState) => T) => select(mocks.state) }));
vi.mock('@/lib/extensions/workbench-workspace', () => ({ useWorkbenchWorkspaceId: () => 'original-owner' }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({ recoveryPreference: 'both', setSettingsPage: vi.fn(), setSettingsDialogOpen: vi.fn() }) }));
vi.mock('@/lib/recovery/workspaceRecovery', async original => ({
  ...await original<typeof import('@/lib/recovery/workspaceRecovery')>(), getWorkspaceRecoveryAPI: () => mocks.api!,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));
vi.mock('@/components/views/PierreDiffViewer', () => ({ PierreDiffViewer: ({ original, modified }: { original: string; modified: string }) =>
  <div data-preview><pre>{original}</pre><pre>{modified}</pre></div> }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/dropdown-menu', () => {
  const Menu = React.createContext({ open: false, setOpen: (_open: boolean) => {} });
  return {
    DropdownMenu: ({ children }: React.PropsWithChildren) => {
      const [open, setOpen] = React.useState(false);
      return <Menu.Provider value={{ open, setOpen }}>{children}</Menu.Provider>;
    },
    DropdownMenuTrigger: ({ render, children }: React.PropsWithChildren<{ render: React.ReactElement<{ onClick(): void }> }>) => {
      const menu = React.useContext(Menu);
      return React.cloneElement(render, { onClick: () => menu.setOpen(!menu.open) }, children);
    },
    DropdownMenuContent: ({ children }: React.PropsWithChildren) => React.useContext(Menu).open ? <div>{children}</div> : null,
    DropdownMenuItem: ({ children, onClick, disabled }: React.PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) => {
      const menu = React.useContext(Menu);
      return <button disabled={disabled} onClick={() => { onClick?.(); menu.setOpen(false); }}>{children}</button>;
    },
  };
});
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>, DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element); vi.stubGlobal('Node', window.Node);
  Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
  mocks.host = 1; mocks.api = undefined;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button, [role="menuitem"]')].find(item => item.textContent === text)!;
const openHistory = async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="contextPanel.recovery.files.actions"]')!.click());
  await act(async () => button('contextPanel.recovery.files.history').click());
};
function fixture() {
  const original: WorkspaceCombinedRecoveryOperation = { id: 'original-recovery', revision: 'original-revision', conversation: { kind: 'thread', threadId: 'original-thread', branchId: 'original-branch' }, workspaceId: 'original-owner',
    state: 'complete', fileState: 'restored', conversationState: 'navigated', entryId: 'original-entry', expectedLeafId: 'before-recovery', targetLeafId: 'after-recovery',
    affectedPathCount: 1, appliedPathCount: 1, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' };
  const undoOperation: WorkspaceCombinedRecoveryOperation = { ...original, id: 'undo-original', undoOf: original.id, revision: 'undo-revision', expectedLeafId: original.targetLeafId, targetLeafId: original.expectedLeafId };
  const plan: WorkspaceCombinedRecoveryPlan = { id: undoOperation.id, revision: undoOperation.revision, conversation: original.conversation, workspaceId: original.workspaceId,
    entryId: original.entryId, undoOf: original.id, expectedLeafId: undoOperation.expectedLeafId, targetLeafId: undoOperation.targetLeafId, removedEntryIds: [],
    affectedPaths: ['file.txt'], changedBytes: 2, conflicts: [], coverage: 'ready', uncoveredPaths: [], uncoveredReasons: [], createdAt: original.createdAt };
  const operations = [original];
  mocks.state = { selectedIdentity: { runtime: 'agent', threadId: 'original-thread', branchId: 'original-branch' } };
  const status: WorkspaceRecoveryStatus = { status: 'ready', failures: [],
    capabilities: { bindings: true, catalogLifecycle: false, checkpoints: true, combined: true, conflictConfirmation: true,
      dirtyStateBarrier: true, journal: true, redo: false, retention: false, storageManagement: false, workspaceLease: false },
    identity: { authorityId: 'host', canonicalRoot: '/workspace', filesystemProfile: 'fixture', workspaceId: original.workspaceId },
    retention: { workspaceId: original.workspaceId, eligibleCheckpointCount: 0, lastRunAt: null, oldestProtectedOperationAt: null,
      policy: { maxAgeDays: null, maxByteLength: null, maxCheckpointCount: null, maxOperationCount: null },
      protectedCheckpointCount: 1, protectedOperationCount: 1, retainedByteLength: 0, terminalOperationCount: 1 },
    storage: { authorityId: 'host', workspaceId: original.workspaceId, location: { mode: 'application-data' }, locationSource: 'global',
      state: 'ready', byteLength: 0, checkpointCount: 1, readyCheckpointCount: 1, objectCount: 1, registryRevision: 1,
      catalog: { currentSchemaVersion: 1, retiredCatalogCount: 0, state: 'ready' }, encryption: { available: false, enabled: false } },
  };
  const prepareCombinedUndo = vi.fn<WorkspaceRecoveryAPI['prepareCombinedUndo']>(async () => ({ status: 'ready', plan }));
  const applyCombinedRecovery = vi.fn<WorkspaceRecoveryAPI['applyCombinedRecovery']>(async () => {
    operations.splice(0, operations.length, original, undoOperation); return { status: 'ready', operation: undoOperation };
  });
  const getCombinedOperation = vi.fn<WorkspaceRecoveryAPI['getCombinedOperation']>(async () => ({ status: 'ready', operation: undoOperation }));
  const cancelCombinedOperation = vi.fn<WorkspaceRecoveryAPI['cancelCombinedOperation']>(async () => ({ status: 'ready', operation: { ...undoOperation, state: 'aborted', fileState: 'unchanged', conversationState: 'unchanged' } }));
  mocks.api = { fileRecovery: async () => ({ points: [], operations: [] }), status: async () => status, listCheckpoints: async () => ({ status: 'ready', page: { checkpoints: [], nextCursor: null } }),
    listCombinedOperations: async () => ({ status: 'ready', operations: [...operations] }), prepareCombinedUndo, applyCombinedRecovery, getCombinedOperation, cancelCombinedOperation } as unknown as WorkspaceRecoveryAPI;
  return { original, undoOperation, plan, operations, prepareCombinedUndo, applyCombinedRecovery, getCombinedOperation, cancelCombinedOperation };
}

it('reads the original undo operation after a lost reply without changing its native conversation identity', async () => {
  const f = fixture(); const apply = f.applyCombinedRecovery.getMockImplementation()!;
  f.applyCombinedRecovery.mockImplementationOnce(async input => { await apply(input); throw new Error('Undo response lost'); });
  await act(async () => root.render(<WorkspaceRecoveryPanel />));
  await openHistory();
  await act(async () => button('contextPanel.recovery.actions.undo').click());
  expect(f.prepareCombinedUndo).toHaveBeenCalledOnce(); expect(f.getCombinedOperation).toHaveBeenCalledWith('undo-original');
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain('contextPanel.recovery.native.undoOperation');
});

it('loads a file diff only when opened and keeps the selected original worktree', async () => {
  fixture();
  const fileRecovery = vi.fn<WorkspaceRecoveryAPI['fileRecovery']>(async input => {
    if (input.action === 'list') return { points: [{ id: 'p-saved', label: 'Saved files', runId: 'original-run',
      sourceRunId: 'original-worktree-run', before: 'p-saved', after: 'p-saved', createdAt: '2026-10-20T10:00:00Z',
      state: 'ready', paths: ['a.ts'], byteLength: 20 }], currentSourceRunId: 'different-current-run' };
    if (input.action === 'inspect') return { files: [{ path: 'a.ts', target: { kind: 'regular-file' } }] };
    if (input.action === 'preview') return { preview: { path: 'a.ts',
      current: { kind: 'text', text: 'current source', byteLength: 14, nextOffset: 14, eof: true, version: 'now' },
      target: { kind: 'text', text: 'saved source', byteLength: 12, nextOffset: 12, eof: true, version: 'then' } } };
    throw new Error('Unexpected recovery request');
  });
  mocks.api!.fileRecovery = fileRecovery;
  await act(async () => root.render(<WorkspaceRecoveryPanel />));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('Saved files'))!.click());
  expect(fileRecovery.mock.calls.some(([input]) => input.action === 'preview')).toBe(false);
  await act(async () => button('a.ts').click());
  expect(fileRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'preview', point: 'p-saved', path: 'a.ts', sourceRunId: 'original-worktree-run' }));
  expect(container.querySelector('[data-preview]')?.textContent).toBe('current sourcesaved source');
});

it('retains the exact undo attempt across an unavailable readback and a dismissed recovery dialog', async () => {
  const f = fixture(); f.applyCombinedRecovery.mockRejectedValueOnce(new Error('Reply lost'));
  f.getCombinedOperation.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => root.render(<WorkspaceRecoveryPanel />));
  await openHistory();
  await act(async () => button('contextPanel.recovery.actions.undo').click());
  expect(button('contextPanel.recovery.actions.undo').disabled).toBe(true);
  await act(async () => button('sessions.sidebar.dialogs.cancel').click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => button('contextPanel.recovery.files.checkOperation').click());
  f.getCombinedOperation.mockResolvedValueOnce({ status: 'ready', operation: { ...f.undoOperation, state: 'navigating-conversation', conversationState: 'unchanged' } });
  await act(async () => button('Check recovery status').click());
  expect(f.prepareCombinedUndo).toHaveBeenCalledOnce();
  expect(f.applyCombinedRecovery.mock.calls[1]![0]).toEqual(f.applyCombinedRecovery.mock.calls[0]![0]);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('resumes a rediscovered original undo instead of preparing another undo intent', async () => {
  const f = fixture(); const interrupted = { ...f.undoOperation, state: 'files-restored' as const, conversationState: 'unchanged' as const };
  f.operations.push(interrupted); f.getCombinedOperation.mockResolvedValueOnce({ status: 'ready', operation: interrupted });
  await act(async () => root.render(<WorkspaceRecoveryPanel />));
  await openHistory();
  await act(async () => button('contextPanel.recovery.actions.undo').click());
  expect(f.prepareCombinedUndo).not.toHaveBeenCalled();
  expect(f.applyCombinedRecovery).toHaveBeenCalledWith({ operationId: f.undoOperation.id, expectedRevision: f.undoOperation.revision, conflictPolicy: 'abort', confirmedConflicts: [] });

});

it('never applies an undo prepared by a previous Host after the user switches Hosts', async () => {
  const f = fixture(); let resolve!: (result: Awaited<ReturnType<WorkspaceRecoveryAPI['prepareCombinedUndo']>>) => void;
  f.prepareCombinedUndo.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(<WorkspaceRecoveryPanel />));
  await openHistory();
  await act(async () => button('contextPanel.recovery.actions.undo').click());
  mocks.host += 1; await act(async () => mocks.listeners.forEach(listener => listener()));
  await act(async () => resolve({ status: 'ready', plan: f.plan }));
  expect(f.applyCombinedRecovery).not.toHaveBeenCalled(); expect(f.cancelCombinedOperation).not.toHaveBeenCalled();
});

it('inspects the original worktree and reads a lost file-restore reply by its original operation ID', async () => {
  fixture();
  const point = { id: 'p-saved', label: 'Saved files', runId: 'named-operation', sourceRunId: 'original-worktree-run',
    before: 'p-saved', after: 'p-saved', createdAt: '2026-10-20T00:00:00Z', state: 'ready', paths: ['a.ts'], byteLength: 12 };
  const fileRecovery = vi.fn<WorkspaceRecoveryAPI['fileRecovery']>(async input => {
    if (input.action === 'list') return { points: [point], currentSourceRunId: 'current-worktree-run' };
    if (input.action === 'inspect') return { files: [{ path: 'a.ts', target: { kind: 'regular-file' } }] };
    if (input.action === 'restore') throw new Error('Reply lost');
    if (input.action === 'operation') return { operation: { operationId: input.operationId!, sourceRunId: input.sourceRunId!,
      status: 'applied', appliedPaths: ['a.ts'], conflictPaths: [], files: [{ path: 'a.ts', status: 'applied' }] } };
    throw new Error('Unexpected recovery request');
  });
  mocks.api!.fileRecovery = fileRecovery;
  await act(async () => root.render(<WorkspaceRecoveryPanel />));
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.includes('Saved files'))!.click());
  expect(fileRecovery).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'inspect', sourceRunId: 'original-worktree-run', point: 'p-saved' }));
  await act(async () => button('contextPanel.recovery.files.restorePoint').click());
  const original = fileRecovery.mock.calls.find(([input]) => input.action === 'restore')![0];
  expect(original).toMatchObject({ sourceRunId: 'original-worktree-run', paths: ['a.ts'], point: 'p-saved' });
  await act(async () => button('contextPanel.recovery.files.checkOperation').click());
  expect(fileRecovery.mock.calls.filter(([input]) => input.action === 'restore')).toHaveLength(1);
  expect(fileRecovery).toHaveBeenCalledWith(expect.objectContaining({ action: 'operation', operationId: original.requestId, sourceRunId: original.sourceRunId }));
});
