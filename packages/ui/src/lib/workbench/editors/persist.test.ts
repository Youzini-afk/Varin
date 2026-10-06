import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  editorWorkbenchPersistKey,
  flushPersistedEditorWorkbench,
  rememberLastGoodEditorWorkbench,
  setEditorWorkbenchPersistBackendForTests,
} from './persist';
import {
  ensureEditorWorkbench,
  openWorkbenchEditor,
  patchEditorViewState,
  peekEditorWorkbench,
  resetEditorWorkbenchForRuntimeSwitch,
  resetEditorWorkbenchForTests,
  subscribeEditorWorkbench,
  subscribeEditorViewState,
} from './session';
import { restoreEditorWorkbenchSnapshot } from './snapshot';
import { activeEditorTab } from './groups';
import { createLegacyTextEditorViewState, textEditorSummaryFromViewState } from './view-state-core';

const memoryStore = (): { store: Map<string, string>; writes: string[]; backend: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
} } => {
  const store = new Map<string, string>();
  const writes: string[] = [];
  return {
    store,
    writes,
    backend: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        writes.push(key);
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    },
  };
};

afterEach(() => {
  resetEditorWorkbenchForTests();
  setEditorWorkbenchPersistBackendForTests(undefined);
});

describe('editor workbench persist', () => {
  test('peek does not create workspace state', () => {
    expect(peekEditorWorkbench('ws-peek')).toBeUndefined();
  });

  test('cursor patches stay in memory until an explicit flush', () => {
    const { store, backend } = memoryStore();
    setEditorWorkbenchPersistBackendForTests(backend);
    const workspaceId = 'ws-view';
    openWorkbenchEditor(workspaceId, 'note.ts');
    flushPersistedEditorWorkbench(workspaceId);
    const before = store.get(editorWorkbenchPersistKey(workspaceId));
    const tab = activeEditorTab(ensureEditorWorkbench(workspaceId));
    if (!tab) throw new Error('expected tab');
    const layoutUpdated = vi.fn();
    const viewUpdated = vi.fn();
    const disposeLayout = subscribeEditorWorkbench(layoutUpdated);
    const disposeView = subscribeEditorViewState(viewUpdated);
    patchEditorViewState(workspaceId, tab.viewId, createLegacyTextEditorViewState({ cursorLine: 12, cursorColumn: 4 }));
    expect(viewUpdated).toHaveBeenCalledTimes(1);
    expect(layoutUpdated).not.toHaveBeenCalled();
    expect(store.get(editorWorkbenchPersistKey(workspaceId))).toBe(before);
    flushPersistedEditorWorkbench(workspaceId);
    const after = store.get(editorWorkbenchPersistKey(workspaceId));
    expect(after).not.toBe(before);
    const restored = restoreEditorWorkbenchSnapshot(after, workspaceId);
    expect(restored.status).toBe('ready');
    if (restored.status === 'ready') {
      const active = activeEditorTab(restored.state);
      expect(active ? textEditorSummaryFromViewState(active.viewState)?.cursor.line : undefined).toBe(12);
    }
    patchEditorViewState(workspaceId, tab.viewId, { diffLayout: 'inline' }, { notify: true });
    expect(layoutUpdated).toHaveBeenCalledTimes(1);
    flushPersistedEditorWorkbench(workspaceId);
    const preferredLayout = restoreEditorWorkbenchSnapshot(store.get(editorWorkbenchPersistKey(workspaceId)), workspaceId);
    if (preferredLayout.status !== 'ready') throw new Error('expected saved editor preference');
    expect(activeEditorTab(preferredLayout.state)?.viewState.diffLayout).toBe('inline');
    disposeLayout();
    disposeView();
  });

  test('failure restore keeps last-good and does not write empty over the failed snapshot', () => {
    const { store, backend, writes } = memoryStore();
    setEditorWorkbenchPersistBackendForTests(backend);
    const workspaceId = 'ws-fail';
    openWorkbenchEditor(workspaceId, 'kept.ts');
    flushPersistedEditorWorkbench(workspaceId);
    const key = editorWorkbenchPersistKey(workspaceId);
    const lastGood = peekEditorWorkbench(workspaceId);
    if (!lastGood) throw new Error('expected last-good');

    resetEditorWorkbenchForTests();
    rememberLastGoodEditorWorkbench(lastGood);
    let shouldFail = true;
    setEditorWorkbenchPersistBackendForTests({
      getItem: () => {
        if (shouldFail) throw new Error('disk');
        return store.get(key) ?? null;
      },
      setItem: (itemKey, value) => {
        writes.push(itemKey);
        store.set(itemKey, value);
      },
      removeItem: (itemKey) => {
        store.delete(itemKey);
      },
    });
    const writeCount = writes.length;
    const restored = ensureEditorWorkbench(workspaceId);
    expect(activeEditorTab(restored)?.resourceId).toBe('kept.ts');
    expect(writes.length).toBe(writeCount);

    resetEditorWorkbenchForTests();
    store.set(key, '{');
    shouldFail = false;
    setEditorWorkbenchPersistBackendForTests({
      getItem: () => store.get(key) ?? null,
      setItem: (itemKey, value) => {
        writes.push(`overwrite:${itemKey}`);
        store.set(itemKey, value);
      },
      removeItem: (itemKey) => {
        store.delete(itemKey);
      },
    });
    const emptyRestore = ensureEditorWorkbench(workspaceId, { resourceIds: ['other.ts'] });
    expect(store.get(key)).toBe('{');
    expect(emptyRestore.tree.type === 'group' ? emptyRestore.tree.tabs.map((tab) => tab.resourceId) : []).toEqual(['other.ts']);
    expect(writes.some((entry) => entry.startsWith('overwrite:'))).toBe(false);
  });

  test('runtime switch drops in-memory tabs for the previous host', () => {
    const { backend } = memoryStore();
    setEditorWorkbenchPersistBackendForTests(backend);
    openWorkbenchEditor('ws-switch', 'a.ts');
    resetEditorWorkbenchForRuntimeSwitch('runtime-b');
    expect(peekEditorWorkbench('ws-switch')).toBeUndefined();
  });

  test('writes a migrated v1 view-state snapshot back as v2', () => {
    const { store, backend } = memoryStore();
    setEditorWorkbenchPersistBackendForTests(backend);
    const workspaceId = 'ws-migrate';
    const key = editorWorkbenchPersistKey(workspaceId);
    store.set(key, JSON.stringify({
      version: 1,
      workspaceId,
      state: {
        workspaceId,
        activeGroupId: 'group',
        tree: {
          type: 'group',
          groupId: 'group',
          activeTabId: 'tab',
          tabs: [{
            tabId: 'tab',
            viewId: 'view',
            resourceId: 'file.ts',
            preview: false,
            pinned: true,
            providerId: 'varin.builtin.text',
            viewState: { cursorLine: 4, cursorColumn: 2 },
          }],
        },
      },
    }));

    ensureEditorWorkbench(workspaceId);
    flushPersistedEditorWorkbench(workspaceId);
    expect((JSON.parse(store.get(key) ?? '{}') as { version?: number }).version).toBe(2);
  });
});
