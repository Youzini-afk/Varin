import { expect, it, vi } from 'vitest';
import { type ContentReference, getRuntimeEndpointGeneration } from '@varin/application-client';
import { useThreadDraftStore, type ThreadPendingInput } from '@/stores/useThreadDraftStore';
import { releaseUiSelection } from './selection-lifetime';
const release = vi.hoisted(() => vi.fn(async () => ({ released: true })));
vi.mock('@varin/application-client', async original => ({ ...await original<typeof import('@varin/application-client')>(), createInteractiveUiHttpAPI: () => ({ releaseSelection: release }) }));
vi.mock('@/lib/varinEvents', () => ({ subscribeVarinEvents: () => () => {} }));
it('keeps a removed draft source while its captured input is unresolved, then retires it after admission', async () => {
  const identity = { runtime: 'agent' as const, threadId: 'retirement', branchId: 'main' };
  const reference: ContentReference = { ref: 'ui-selection:pending', title: 'Selection', source: { kind: 'ui', thread: identity, snapshotRef: 'ui-snapshot:pending' } };
  const pending = { kind: 'submit', input: { ...identity, key: 'input', text: reference.ref }, status: 'unknown', fingerprint: 'test', editorText: 'draft' } as ThreadPendingInput;
  useThreadDraftStore.getState().patch('retirement', { pendingInput: pending });
  releaseUiSelection(reference, getRuntimeEndpointGeneration()); await Promise.resolve();
  expect(release).not.toHaveBeenCalled();
  useThreadDraftStore.getState().patch('retirement', { pendingInput: undefined });
  await vi.waitFor(() => expect(release).toHaveBeenCalledWith(identity, reference.ref));
  useThreadDraftStore.getState().remove('retirement');
});
