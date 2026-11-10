import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { WorkspaceRecoveryAPI, WorkspaceCombinedRecoveryPlan } from '@varin/extension-contract';
import type { ThreadsAPI } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';
import { useThreadRecovery, type ThreadRecoveredEditor } from './useThreadRecovery';

vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), getRuntimeEndpointGeneration: () => 1 }));
const fixture = vi.hoisted(() => ({ recovery: undefined as WorkspaceRecoveryAPI | undefined }));
vi.mock('@/lib/recovery/workspaceRecovery', async original => ({ ...await original<typeof import('@/lib/recovery/workspaceRecovery')>(), getWorkspaceRecoveryAPI: () => fixture.recovery }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  const { document, window } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('document', document); vi.stubGlobal('window', window); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  useUIStore.setState({ recoveryPreference: 'conversation' });
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });

it('restores the original owner-prepared quote bindings, frozen files, and image numbers through uncertain recovery', async () => {
  const identity = { runtime: 'agent' as const, threadId: 'original', branchId: 'branch' };
  const frozen: ThreadRecoveredEditor = {
    editorText: '[引用点8] Compare [图片3].',
    editorImages: [{ mimeType: 'image/png', data: 'frozen-bytes', reference: 3 }],
    editorContentReferences: [{ ref: 'quote:old', number: 8, title: 'Original paragraph', text: 'Frozen before deletion',
      source: { kind: 'chat', thread: identity, passages: [{ entryId: 'deleted-source', start: 0, text: 'Frozen before deletion' }] } }],
    editorContentReferenceOccurrences: [{ kind: 'content', ref: 'quote:old', start: 0, end: 6 }, { kind: 'image', reference: 3, start: 15, end: 20 }],
    editorAttachments: [{ ref: 'attachment:retained', filename: 'old.txt', mimeType: 'text/plain', byteLength: 4 }],
    editorAttachmentImageReferences: { 'attachment:original-image': 3 },
  };
  const prepareNavigation = vi.fn(async () => ({ expectedHeadId: 'current', targetHeadId: 'before-input', removedEntryIds: ['user-message'], ...frozen }));
  let accepted: Parameters<ThreadsAPI['navigate']>[0] | undefined;
  const navigate = vi.fn(async (input: Parameters<ThreadsAPI['navigate']>[0]) => { accepted = input; throw new Error('Response lost after accepting recovery'); });
  const navigationReceipt = vi.fn(async () => ({ threadId: identity.threadId, branchId: identity.branchId, key: accepted!.key, previousHeadId: 'current', headId: 'before-input', alreadyApplied: true }));
  const onRecovered = vi.fn(async () => {});
  const api = { prepareNavigation, navigate, navigationReceipt } as unknown as ThreadsAPI;
  let recovery!: ReturnType<typeof useThreadRecovery>;
  function Harness() { recovery = useThreadRecovery({ api, identity, host: 1, disabled: false, onRecovered }); return null; }
  await act(async () => root.render(<Harness />));
  await act(async () => recovery.recover('user-message'));
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigationReceipt).toHaveBeenCalledTimes(1);
  expect(onRecovered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(frozen));
  expect(recovery.error).toBeUndefined();
  expect(prepareNavigation).toHaveBeenCalledExactlyOnceWith({ ...identity, entryId: 'user-message' });
});


it('keeps frozen relations and image numbers when combined recovery completes before editor state commits', async () => {
  useUIStore.setState({ recoveryPreference: 'both' });
  const identity = { runtime: 'agent' as const, threadId: 'original', branchId: 'branch' };
  const frozen: ThreadRecoveredEditor = { editorText: '[图片9]', editorImages: [{ mimeType: 'image/png', data: 'original', reference: 9 }],
    editorContentReferences: [{ ref: 'image:original', title: 'Frozen image', imageReference: 9,
      source: { kind: 'chat', thread: identity, itemId: 'original-image', passages: [] } }],
    editorContentReferenceOccurrences: [{ kind: 'image', reference: 9, start: 0, end: 5 }] };
  const conversation = { kind: 'thread' as const, threadId: identity.threadId, branchId: identity.branchId };
  const plan: WorkspaceCombinedRecoveryPlan = { id: 'combined', revision: '1', conversation, workspaceId: 'workspace', coverage: 'ready',
    conflicts: [], affectedPaths: [], changedBytes: 0, createdAt: '', entryId: 'user-message', expectedLeafId: 'current', targetLeafId: 'before', removedEntryIds: ['user-message'], uncoveredPaths: [], uncoveredReasons: [] };
  fixture.recovery = { prepareCombinedRecovery: vi.fn(async () => ({ status: 'ok', plan })),
    applyCombinedRecovery: vi.fn(async () => ({ status: 'ok', operation: { ...plan, state: 'complete', fileState: 'restored', conversationState: 'navigated', appliedPathCount: 0, affectedPathCount: 0,
      editorText: frozen.editorText, editorImages: [{ mimeType: 'image/png', data: 'original' }], updatedAt: '' } })),
  } as unknown as WorkspaceRecoveryAPI;
  const api = { prepareNavigation: async () => ({ expectedHeadId: 'current', targetHeadId: 'before', removedEntryIds: ['user-message'], ...frozen }),
    recoverySource: async () => ({ workspaceId: 'workspace', mode: 'live' }),
  } as unknown as ThreadsAPI;
  const onRecovered = vi.fn(async () => {});
  let recovery!: ReturnType<typeof useThreadRecovery>;
  function Harness() { recovery = useThreadRecovery({ api, identity, host: 1, disabled: false, onRecovered }); return null; }
  await act(async () => root.render(<Harness />));
  await act(async () => recovery.recover('user-message'));
  expect(recovery.error).toBeUndefined();
  expect(onRecovered).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(frozen));
  expect(fixture.recovery.applyCombinedRecovery).toHaveBeenCalledTimes(1);
});
