import { useSyncExternalStore } from 'react';
import type { PiMcpConfigSnapshot, RuntimeContextTarget } from '@varin/protocol';
import { getPiMcpConfigSnapshot } from '@/lib/pi-runtime/mcp';
import { getRuntimeKey } from '@varin/application-client';

export type McpCatalogSelection =
  | { kind: 'new' }
  | { kind: 'server'; name: string }
  | { kind: 'settings' };

interface McpCatalogState {
  catalogRevision: number;
  editorDirty: boolean;
  error: string | null;
  loading: boolean;
  selection: McpCatalogSelection;
  snapshot: PiMcpConfigSnapshot | null;
  targetKey: string | null;
}

const initialState = (): McpCatalogState => ({
  catalogRevision: 0,
  editorDirty: false,
  error: null,
  loading: false,
  selection: { kind: 'settings' },
  snapshot: null,
  targetKey: null,
});

let state = initialState();
let generation = 0;
const listeners = new Set<() => void>();

const publish = (next: McpCatalogState): void => {
  state = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const snapshot = (): McpCatalogState => state;

export const useMcpCatalogState = (): McpCatalogState => (
  useSyncExternalStore(subscribe, snapshot, snapshot)
);

const sameSelection = (left: McpCatalogSelection, right: McpCatalogSelection): boolean => (
  left.kind === right.kind && (left.kind !== 'server' || (right.kind === 'server' && left.name === right.name))
);

export const selectMcpCatalogItem = (
  selection: McpCatalogSelection,
  options: { force?: boolean } = {},
): boolean => {
  if (state.editorDirty && !options.force && !sameSelection(state.selection, selection)) return false;
  publish({ ...state, selection });
  return true;
};

export const selectMcpCatalogItemIfCurrent = (
  expected: McpCatalogSelection,
  selection: McpCatalogSelection,
): boolean => {
  if (!sameSelection(state.selection, expected)) return false;
  return selectMcpCatalogItem(selection);
};

export const setMcpCatalogEditorDirty = (editorDirty: boolean): void => {
  if (state.editorDirty === editorDirty) return;
  publish({ ...state, editorDirty });
};

export const refreshMcpCatalog = async (
  target: RuntimeContextTarget,
  targetKey: string,
  options: { force?: boolean } = {},
): Promise<void> => {
  const previousTargetKey = state.targetKey;
  const runtimeKey = getRuntimeKey();
  const sameTarget = previousTargetKey === targetKey;
  if (sameTarget && state.editorDirty && !options.force) return;
  if (sameTarget && state.loading && !options.force) return;
  const requestGeneration = ++generation;
  publish({
    ...state,
    error: null,
    loading: true,
    ...(sameTarget ? {} : { editorDirty: false, selection: { kind: 'settings' }, snapshot: null }),
    targetKey,
  });
  try {
    const next = await getPiMcpConfigSnapshot(target);
    if (
      requestGeneration !== generation
      || runtimeKey !== getRuntimeKey()
      || state.targetKey !== targetKey
    ) return;
    // `force` allows a save to start a refresh while the committed draft is
    // still rendered dirty. It must not authorize replacing edits made after
    // that request started.
    if (state.editorDirty) {
      publish({ ...state, loading: false });
      return;
    }
    const names = new Set(next.catalog?.servers.map((server) => server.name) ?? []);
    const selection = state.selection.kind === 'server' && !names.has(state.selection.name)
      ? next.catalog?.servers[0]
        ? { kind: 'server', name: next.catalog.servers[0].name } as const
        : { kind: 'settings' } as const
      : (!sameTarget || state.snapshot === null) && state.selection.kind === 'settings' && next.catalog?.servers[0]
        ? { kind: 'server', name: next.catalog.servers[0].name } as const
        : state.selection;
    publish({
      ...state,
      catalogRevision: state.catalogRevision + 1,
      error: null,
      loading: false,
      selection,
      snapshot: next,
      targetKey,
    });
  } catch (error) {
    if (
      requestGeneration !== generation
      || runtimeKey !== getRuntimeKey()
      || state.targetKey !== targetKey
    ) return;
    publish({
      ...state,
      error: error instanceof Error ? error.message : String(error),
      loading: false,
    });
  }
};

export const resetMcpCatalogStoreForTests = (): void => {
  generation += 1;
  state = initialState();
  listeners.clear();
};

export const getMcpCatalogStateForTests = (): McpCatalogState => state;
