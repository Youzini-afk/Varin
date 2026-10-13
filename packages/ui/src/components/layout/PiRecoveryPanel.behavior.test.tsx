import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '@varin/protocol';
import type { WorkspaceCombinedRecoveryOperation, WorkspaceCombinedRecoveryPlan, WorkspaceRecoveryAPI, WorkspaceRecoveryStatus } from '@varin/extension-contract';
import type { PiSessionStoreState } from '@/stores/usePiSessionStore';
import { PiRecoveryPanel } from './PiRecoveryPanel';

const mocks = vi.hoisted(() => ({ api: undefined as WorkspaceRecoveryAPI | undefined, state: {} as PiSessionStoreState,
  host: 1, listeners: new Set<() => void>() }));
vi.mock('@varin/application-client', async original => ({
  ...await original<typeof import('@varin/application-client')>(),
  getRuntimeEndpointGeneration: () => mocks.host,
  subscribeRuntimeEndpointChanged: (listener: () => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); },
}));
vi.mock('@/stores/usePiSessionStore', () => ({ usePiSessionStore: <T,>(select: (state: PiSessionStoreState) => T) => select(mocks.state) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({ recoveryPreference: 'both', setSettingsPage: vi.fn(), setSettingsDialogOpen: vi.fn() }) }));
vi.mock('@/lib/recovery/workspaceRecovery', async original => ({
  ...await original<typeof import('@/lib/recovery/workspaceRecovery')>(), getWorkspaceRecoveryAPI: () => mocks.api!,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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
  Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
  mocks.host = 1; mocks.api = undefined;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = (text: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;
function fixture() {
  const original: WorkspaceCombinedRecoveryOperation = { id: 'original-recovery', revision: 'original-revision', conversation: { kind: 'pi', sessionId: 'original-session' }, workspaceId: 'original-owner',
    state: 'complete', fileState: 'restored', conversationState: 'navigated', entryId: 'original-entry', expectedLeafId: 'before-recovery', targetLeafId: 'after-recovery',
    affectedPathCount: 1, appliedPathCount: 1, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:00Z' };
  const undoOperation: WorkspaceCombinedRecoveryOperation = { ...original, id: 'undo-original', undoOf: original.id, revision: 'undo-revision', expectedLeafId: original.targetLeafId, targetLeafId: original.expectedLeafId };
  const plan: WorkspaceCombinedRecoveryPlan = { id: undoOperation.id, revision: undoOperation.revision, conversation: original.conversation, workspaceId: original.workspaceId,
    entryId: original.entryId, undoOf: original.id, expectedLeafId: undoOperation.expectedLeafId, targetLeafId: undoOperation.targetLeafId, removedEntryIds: [],
    affectedPaths: ['file.txt'], changedBytes: 2, conflicts: [], coverage: 'ready', uncoveredPaths: [], uncoveredReasons: [], createdAt: original.createdAt };
  const operations = [original];
  const refreshEntries = vi.fn<PiSessionStoreState['refreshEntries']>(async sessionId => ({ sessionId, scope: 'branch', leafId: undoOperation.targetLeafId, entries: [] }));
  mocks.state = { currentSessionId: 'original-session', records: { 'original-session': { snapshot: { sessionId: 'original-session', workspace: { kind: 'workspace', id: 'display-id', authorityId: 'original-owner' } } as SessionSnapshot } }, refreshEntries } as unknown as PiSessionStoreState;
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
  mocks.api = { status: async () => status, listCheckpoints: async () => ({ status: 'ready', page: { checkpoints: [], nextCursor: null } }),
    listCombinedOperations: async () => ({ status: 'ready', operations: [...operations] }), prepareCombinedUndo, applyCombinedRecovery, getCombinedOperation, cancelCombinedOperation } as unknown as WorkspaceRecoveryAPI;
  return { original, undoOperation, plan, operations, refreshEntries, prepareCombinedUndo, applyCombinedRecovery, getCombinedOperation, cancelCombinedOperation };
}

it('reads the original undo operation after a lost reply and refreshes only its Pi conversation', async () => {
  const f = fixture(); const apply = f.applyCombinedRecovery.getMockImplementation()!;
  f.applyCombinedRecovery.mockImplementationOnce(async input => { await apply(input); throw new Error('Undo response lost'); });
  await act(async () => root.render(<PiRecoveryPanel />));
  await act(async () => button('contextPanel.recovery.actions.undo').click());
  expect(f.prepareCombinedUndo).toHaveBeenCalledOnce(); expect(f.getCombinedOperation).toHaveBeenCalledWith('undo-original');
  expect(f.refreshEntries).toHaveBeenCalledWith('original-session'); expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).toContain('contextPanel.recovery.native.undoOperation');
});

it('retains the exact undo attempt across an unavailable readback and a dismissed recovery dialog', async () => {
  const f = fixture(); f.applyCombinedRecovery.mockRejectedValueOnce(new Error('Reply lost'));
  f.getCombinedOperation.mockRejectedValueOnce(new Error('Offline'));
  await act(async () => root.render(<PiRecoveryPanel />));
  await act(async () => button('contextPanel.recovery.actions.undo').click());
  expect(button('contextPanel.recovery.actions.undo').disabled).toBe(true);
  await act(async () => button('sessions.sidebar.dialogs.cancel').click());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => button('Check undo recovery status').click());
  f.getCombinedOperation.mockResolvedValueOnce({ status: 'ready', operation: { ...f.undoOperation, state: 'navigating-conversation', conversationState: 'unchanged' } });
  await act(async () => button('Check recovery status').click());
  expect(f.prepareCombinedUndo).toHaveBeenCalledOnce();
  expect(f.applyCombinedRecovery.mock.calls[1]![0]).toEqual(f.applyCombinedRecovery.mock.calls[0]![0]);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it('resumes a rediscovered original undo instead of preparing another undo intent', async () => {
  const f = fixture(); const interrupted = { ...f.undoOperation, state: 'files-restored' as const, conversationState: 'unchanged' as const };
  f.operations.push(interrupted); f.getCombinedOperation.mockResolvedValueOnce({ status: 'ready', operation: interrupted });
  await act(async () => root.render(<PiRecoveryPanel />));
  await act(async () => button('contextPanel.recovery.actions.undo').click());
  expect(f.prepareCombinedUndo).not.toHaveBeenCalled();
  expect(f.applyCombinedRecovery).toHaveBeenCalledWith({ operationId: f.undoOperation.id, expectedRevision: f.undoOperation.revision, conflictPolicy: 'abort', confirmedConflicts: [] });
  expect(f.refreshEntries).toHaveBeenCalledWith('original-session');
});

it('never applies an undo prepared by a previous Host after the user switches Hosts', async () => {
  const f = fixture(); let resolve!: (result: Awaited<ReturnType<WorkspaceRecoveryAPI['prepareCombinedUndo']>>) => void;
  f.prepareCombinedUndo.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => root.render(<PiRecoveryPanel />));
  await act(async () => button('contextPanel.recovery.actions.undo').click());
  mocks.host += 1; await act(async () => mocks.listeners.forEach(listener => listener()));
  await act(async () => resolve({ status: 'ready', plan: f.plan }));
  expect(f.applyCombinedRecovery).not.toHaveBeenCalled(); expect(f.cancelCombinedOperation).not.toHaveBeenCalled();
  expect(f.refreshEntries).not.toHaveBeenCalled();
});
