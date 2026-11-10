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

it('holds undo and redo roots, then releases a removed selection after the real history prunes it', async () => {
  const { EditorState } = await import('@codemirror/state');
  const { history, isolateHistory, undo, redo } = await import('@codemirror/commands');
  const { composerReferences, referenceHistory } = await import('@/components/chat/composer/editor/references');
  const { composerMarkerObjects, insertComposerMarker, replaceComposerMarkerObjects, markerObjectHistory } = await import('@/components/chat/composer/editor/markers');
  const idle = new Map<number, () => void>(); let id = 0;
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle.set(++id, callback); return id; });
  vi.stubGlobal('cancelIdleCallback', (id: number) => idle.delete(id));
  const flushIdle = () => { for (const [key, callback] of [...idle]) { idle.delete(key); callback(); } };
  const identity = { runtime: 'agent' as const, threadId: 'history', branchId: 'main' };
  const reference: ContentReference = { ref: 'ui-selection:history', title: 'Frozen', source: { kind: 'ui', thread: identity, snapshotRef: 'ui-snapshot:history' } };
  const host = getRuntimeEndpointGeneration();
  let state = EditorState.create({ extensions: [history({ minDepth: 2 }), composerReferences, referenceHistory, composerMarkerObjects, markerObjectHistory] });
  const save = () => useThreadDraftStore.getState().patch('history', { text: state.doc.toString(), references: state.field(composerReferences), markerObjects: state.field(composerMarkerObjects), editorState: state });
  const target = { get state() { return state; }, dispatch(transaction: ReturnType<typeof state.update>) { state = transaction.state; save(); } };
  try {
    state = state.update(insertComposerMarker(state, { id: reference.ref, host, kind: 'quote', label: '[引用点1]', number: 1, payload: { kind: 'quote', reference } })).state; save();
    state = state.update(replaceComposerMarkerObjects(state, [])!).state; save();
    flushIdle(); await Promise.resolve();
    expect(release).not.toHaveBeenCalledWith(identity, reference.ref);
    expect(useThreadDraftStore.getState().drafts.history.retainedContentReferences?.map(item => item.ref)).toContain(reference.ref);
    undo(target); redo(target); flushIdle(); await Promise.resolve();
    expect(release).not.toHaveBeenCalledWith(identity, reference.ref);
    for (let i = 0; i < 30; i++) state = state.update({ changes: { from: state.doc.length, insert: 'x' }, annotations: isolateHistory.of('full'), userEvent: 'input.type' }).state;
    save(); flushIdle();
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(identity, reference.ref));
    expect(useThreadDraftStore.getState().drafts.history.retainedContentReferences).toEqual([]);
  } finally { useThreadDraftStore.getState().remove('history'); vi.unstubAllGlobals(); }
});

it('cancels pending history cleanup on draft deletion and never recreates the removed draft', async () => {
  let callback: (() => void) | undefined;
  const cancel = vi.fn();
  vi.stubGlobal('requestIdleCallback', (run: () => void) => { callback = run; return 42; });
  vi.stubGlobal('cancelIdleCallback', cancel);
  const reference: ContentReference = { ref: 'ui-selection:discarded-history', title: 'Removed', source: { kind: 'ui', thread: { runtime: 'agent', threadId: 'discarded', branchId: 'main' }, snapshotRef: 'ui-snapshot:discarded' } };
  try {
    useThreadDraftStore.getState().patch('discarded', { retainedContentReferences: [reference] });
    expect(callback).toBeDefined();
    useThreadDraftStore.getState().remove('discarded');
    expect(cancel).toHaveBeenCalledWith(42);
    callback?.(); await Promise.resolve();
    expect(useThreadDraftStore.getState().drafts.discarded).toBeUndefined();
  } finally { vi.unstubAllGlobals(); }
});
