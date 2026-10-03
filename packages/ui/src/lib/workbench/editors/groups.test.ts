import { afterEach, describe, expect, test } from 'vitest';
import {
  closeEditorTab,
  createEmptyEditorWorkbench,
  listEditorGroups,
  moveEditorTab,
  openEditor,
  pinEditorTab,
  splitEditorGroup,
  updateEditorViewState,
} from './groups';
import { selectEditorProvider, resetEditorProvidersForTests, setEditorProviderEnabled } from './providers';
import { BUILTIN_EDITOR_PROVIDER_IDS } from './types';
import { restoreEditorWorkbenchSnapshot, serializeEditorWorkbenchSnapshot } from './snapshot';
import { executeWorkbenchCommand, registerWorkbenchCommand, resetWorkbenchCommands } from './commands';
import { setWorkbenchContextKey, whenWorkbenchContext, clearWorkbenchContextKeys, subscribeWorkbenchContextKey } from './context-keys';
import { textEditorSummaryFromViewState } from './view-state-core';

let seq = 0;
const ids = () => `id-${++seq}`;

afterEach(() => {
  resetEditorProvidersForTests();
  resetWorkbenchCommands();
  clearWorkbenchContextKeys();
});

describe('editor groups', () => {
  test('keeps independent views of the same document after a split', () => {
    seq = 0;
    let state = createEmptyEditorWorkbench('ws-1', ids);
    state = openEditor(state, { resourceId: 'note.md', providerId: 'text' }, ids);
    state = splitEditorGroup(state, { direction: 'vertical' }, ids);
    const groups = listEditorGroups(state.tree);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.tabs[0]?.resourceId).toBe('note.md');
    expect(groups[1]?.tabs[0]?.resourceId).toBe('note.md');
    expect(groups[0]?.tabs[0]?.viewId).not.toBe(groups[1]?.tabs[0]?.viewId);
  });

  test('replaces a preview tab and keeps pinned tabs', () => {
    seq = 0;
    let state = createEmptyEditorWorkbench('ws-1', ids);
    state = openEditor(state, { resourceId: 'a.ts', providerId: 'text', preview: true }, ids);
    state = openEditor(state, { resourceId: 'b.ts', providerId: 'text', preview: true }, ids);
    expect(listEditorGroups(state.tree)[0]?.tabs.map((tab) => tab.resourceId)).toEqual(['b.ts']);
    state = pinEditorTab(state, listEditorGroups(state.tree)[0]?.tabs[0]?.tabId ?? '');
    state = openEditor(state, { resourceId: 'c.ts', providerId: 'text', preview: true }, ids);
    expect(listEditorGroups(state.tree)[0]?.tabs.map((tab) => tab.resourceId)).toEqual(['b.ts', 'c.ts']);
  });

  test('moves the last tab out of a group and closes the empty source', () => {
    seq = 0;
    let state = createEmptyEditorWorkbench('ws-1', ids);
    state = openEditor(state, { resourceId: 'a.ts', providerId: 'text' }, ids);
    state = splitEditorGroup(state, { direction: 'horizontal' }, ids);
    const [first, second] = listEditorGroups(state.tree);
    const moved = first?.tabs[0]?.tabId;
    if (!first || !second || !moved) throw new Error('expected split groups');
    state = moveEditorTab(state, moved, second.groupId);
    expect(listEditorGroups(state.tree)).toHaveLength(1);
    expect(listEditorGroups(state.tree)[0]?.tabs.some((tab) => tab.tabId === moved)).toBe(true);
  });

  test('closing a tab does not require saving', () => {
    seq = 0;
    let state = createEmptyEditorWorkbench('ws-1', ids);
    state = openEditor(state, { resourceId: 'a.ts', providerId: 'text' }, ids);
    state = openEditor(state, { resourceId: 'b.ts', providerId: 'text' }, ids);
    const firstTab = listEditorGroups(state.tree)[0]?.tabs[0]?.tabId;
    if (!firstTab) throw new Error('expected tab');
    state = closeEditorTab(state, firstTab);
    expect(listEditorGroups(state.tree)[0]?.tabs.map((tab) => tab.resourceId)).toEqual(['b.ts']);
  });

  test('a pinned provider opens a distinct tab beside the ordinary view of the same resource', () => {
    seq = 0;
    let state = createEmptyEditorWorkbench('ws-1', ids);
    state = openEditor(state, { resourceId: 'a.ts', providerId: 'text' }, ids);
    state = openEditor(state, {
      resourceId: 'a.ts',
      providerId: BUILTIN_EDITOR_PROVIDER_IDS.gitDiff,
      providerPinned: true,
    }, ids);

    const tabs = listEditorGroups(state.tree)[0]?.tabs ?? [];
    expect(tabs.map((tab) => tab.providerId)).toEqual(['text', BUILTIN_EDITOR_PROVIDER_IDS.gitDiff]);
    expect(tabs.map((tab) => tab.providerPinned)).toEqual([undefined, true]);
  });

  test('repeat opens reuse their own tab and never steal the other kind', () => {
    seq = 0;
    let state = createEmptyEditorWorkbench('ws-1', ids);
    state = openEditor(state, { resourceId: 'a.ts', providerId: 'text' }, ids);
    state = openEditor(state, {
      resourceId: 'a.ts',
      providerId: BUILTIN_EDITOR_PROVIDER_IDS.gitDiff,
      providerPinned: true,
    }, ids);

    // A second diff request focuses the existing diff tab rather than adding another.
    state = openEditor(state, {
      resourceId: 'a.ts',
      providerId: BUILTIN_EDITOR_PROVIDER_IDS.gitDiff,
      providerPinned: true,
    }, ids);
    // Opening the file normally focuses the text tab, not the diff tab.
    state = openEditor(state, { resourceId: 'a.ts', providerId: 'text' }, ids);

    const group = listEditorGroups(state.tree)[0];
    expect(group?.tabs).toHaveLength(2);
    const active = group?.tabs.find((tab) => tab.tabId === group.activeTabId);
    expect(active?.providerId).toBe('text');
  });

  test('a pinned tab survives a snapshot round trip', () => {
    seq = 0;
    let state = openEditor(createEmptyEditorWorkbench('ws-1', ids), {
      resourceId: 'a.ts',
      providerId: BUILTIN_EDITOR_PROVIDER_IDS.gitDiff,
      providerPinned: true,
    }, ids);
    const opened = listEditorGroups(state.tree)[0]?.tabs[0];
    if (!opened) throw new Error('expected a Git diff tab');
    state = updateEditorViewState(state, opened.viewId, {
      diffScope: 'staged',
      diffRepositoryResourceId: 'packages/app',
    });
    const restored = restoreEditorWorkbenchSnapshot(serializeEditorWorkbenchSnapshot(state), 'ws-1');
    if (restored.status !== 'ready') throw new Error('expected a ready snapshot');
    const tab = listEditorGroups(restored.state.tree)[0]?.tabs[0];
    expect(tab?.providerId).toBe(BUILTIN_EDITOR_PROVIDER_IDS.gitDiff);
    expect(tab?.providerPinned).toBe(true);
    expect(tab?.viewState.diffScope).toBe('staged');
    expect(tab?.viewState.diffRepositoryResourceId).toBe('packages/app');
  });
});

describe('editor snapshot restore', () => {
  test('distinguishes missing, empty, malformed, and ready snapshots', () => {
    expect(restoreEditorWorkbenchSnapshot(null, 'ws-1').status).toBe('missing');
    expect(restoreEditorWorkbenchSnapshot('', 'ws-1').status).toBe('empty');
    expect(restoreEditorWorkbenchSnapshot('{', 'ws-1').status).toBe('failure');
    expect(restoreEditorWorkbenchSnapshot({ version: 1, workspaceId: 'other' }, 'ws-1').status).toBe('malformed');
    seq = 0;
    const state = openEditor(createEmptyEditorWorkbench('ws-1', ids), { resourceId: 'a.ts', providerId: 'text' }, ids);
    const restored = restoreEditorWorkbenchSnapshot(serializeEditorWorkbenchSnapshot(state), 'ws-1');
    expect(restored.status).toBe('ready');
  });

  test('migrates legacy cursor fields once and drops only malformed provider state', () => {
    seq = 0;
    const state = openEditor(createEmptyEditorWorkbench('ws-1', ids), { resourceId: 'a.ts', providerId: 'text' }, ids);
    const legacy = structuredClone(serializeEditorWorkbenchSnapshot(state)) as unknown as {
      version: number;
      state: { tree: { tabs: Array<{ viewState: Record<string, unknown> }> } };
    };
    legacy.version = 1;
    legacy.state.tree.tabs[0].viewState = {
      cursorLine: 12,
      cursorColumn: 4,
      selectionStartLine: 12,
      selectionStartColumn: 4,
      selectionEndLine: 13,
      selectionEndColumn: 2,
    };
    const migrated = restoreEditorWorkbenchSnapshot(legacy, 'ws-1');
    if (migrated.status !== 'ready') throw new Error('expected migrated snapshot');
    expect(migrated.migrated).toBe(true);
    const migratedTab = listEditorGroups(migrated.state.tree)[0]?.tabs[0];
    expect(migratedTab ? textEditorSummaryFromViewState(migratedTab.viewState) : undefined).toEqual({
      cursor: { line: 12, column: 4 },
      selection: {
        start: { line: 12, column: 4 },
        end: { line: 13, column: 2 },
      },
    });

    const malformed = structuredClone(serializeEditorWorkbenchSnapshot(state)) as unknown as {
      state: { tree: { tabs: Array<{ viewState: Record<string, unknown> }> } };
    };
    malformed.state.tree.tabs[0].viewState = {
      previewMode: 'edit',
      providerState: { providerId: 'text', schemaVersion: 2, value: { broken: undefined } },
    };
    const restored = restoreEditorWorkbenchSnapshot(malformed, 'ws-1');
    if (restored.status !== 'ready') throw new Error('expected ready snapshot');
    const restoredViewState = listEditorGroups(restored.state.tree)[0]?.tabs[0]?.viewState;
    expect(restoredViewState).toEqual({ previewMode: 'edit' });
  });
});

describe('editor providers', () => {
  test('skips disabled providers, falls back to text, and reports ambiguity', () => {
    resetEditorProvidersForTests();
    expect(selectEditorProvider('note.md', [
      { id: 'markdown', extensionId: 'a', enabled: false, languages: ['md'], priority: 10 },
      { id: 'text', extensionId: 'b', enabled: true, languages: ['md'], priority: 1 },
    ])).toEqual({ status: 'selected', providerId: 'text' });

    expect(selectEditorProvider('note.md', [
      { id: 'one', extensionId: 'a', enabled: true, languages: ['md'], priority: 5 },
      { id: 'two', extensionId: 'b', enabled: true, languages: ['md'], priority: 5 },
    ])).toEqual({ status: 'ambiguous', providerIds: ['one', 'two'] });

    expect(selectEditorProvider('note.md', [
      { id: 'semantic-markdown', extensionId: 'c', enabled: true, languages: ['markdown'], priority: 10 },
    ])).toEqual({ status: 'selected', providerId: 'semantic-markdown' });

    expect(selectEditorProvider('notes.txt')).toEqual({
      status: 'selected',
      providerId: BUILTIN_EDITOR_PROVIDER_IDS.text,
    });

    setEditorProviderEnabled(BUILTIN_EDITOR_PROVIDER_IDS.markdown, false);
    expect(selectEditorProvider('note.md')).toEqual({
      status: 'selected',
      providerId: BUILTIN_EDITOR_PROVIDER_IDS.text,
    });
  });

  test('the Git diff provider is never selected by resolution', () => {
    resetEditorProvidersForTests();
    for (const resourceId of ['a.ts', 'notes.md', 'patch.diff', 'change.patch', 'noextension']) {
      const selection = selectEditorProvider(resourceId);
      const selected = selection.status === 'selected' ? selection.providerId : '';
      expect(selected).not.toBe(BUILTIN_EDITOR_PROVIDER_IDS.gitDiff);
      expect(selection.status === 'ambiguous' ? selection.providerIds : []).not.toContain(
        BUILTIN_EDITOR_PROVIDER_IDS.gitDiff,
      );
    }
  });
});

describe('commands and context keys', () => {
  test('owner-scoped commands and exact context matches', async () => {
    resetWorkbenchCommands();
    clearWorkbenchContextKeys();
    let ran = 0;
    const dispose = registerWorkbenchCommand('workbench.action.splitEditor', 'kernel', () => {
      ran += 1;
    });
    expect(await executeWorkbenchCommand('workbench.action.splitEditor')).toBe(true);
    dispose();
    expect(await executeWorkbenchCommand('workbench.action.splitEditor')).toBe(false);
    expect(ran).toBe(1);
    setWorkbenchContextKey('editorIsOpen', true);
    expect(whenWorkbenchContext({ editorIsOpen: true })).toBe(true);
    expect(whenWorkbenchContext({ editorIsOpen: false })).toBe(false);
    let notified = 0;
    const unsubscribe = subscribeWorkbenchContextKey('editorIsOpen', () => {
      notified += 1;
    });
    setWorkbenchContextKey('editorResource', 'note.ts');
    expect(notified).toBe(0);
    setWorkbenchContextKey('editorIsOpen', false);
    expect(notified).toBe(1);
    unsubscribe();
  });
});
