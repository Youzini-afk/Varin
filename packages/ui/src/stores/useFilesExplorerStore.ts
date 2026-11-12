import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { getRuntimeKey } from '@varin/application-client';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

export interface LegacyEditorTabsSnapshot {
  openPaths: string[];
  selectedPath: string | null;
}

interface RootExplorerState {
  sourceRoot?: string;
  expandedPaths: string[];
  legacyOpenPaths: string[];
  legacySelectedPath: string | null;
  touchedAt: number;
}

interface FilesExplorerState {
  activeRuntimeKey: string;
  byRoot: Record<string, RootExplorerState>;
  runtimeSnapshots: Record<string, { byRoot: Record<string, RootExplorerState>; updatedAt: number }>;
}

interface FilesExplorerActions {
  collapseAllExpandedPaths(root: string, scopeKey?: string): void;
  consumeLegacyEditorTabs(root: string): LegacyEditorTabsSnapshot;
  expandPath(root: string, path: string, scopeKey?: string): void;
  expandPaths(root: string, paths: string[], scopeKey?: string): void;
  removeExpandedPathsByPrefix(root: string, prefixPath: string, scopeKey?: string): void;
  renameExpandedPathsByPrefix(root: string, from: string, to: string, scopeKey?: string): void;
  resetForRuntimeSwitch(runtimeKey: string): void;
  toggleExpandedPath(root: string, path: string, scopeKey?: string): void;
}

export type FilesExplorerStore = FilesExplorerState & FilesExplorerActions;

const normalizePath = (value: string): string => {
  if (!value) return '';
  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) normalized = `/${normalized}`;
  if (normalized !== '/' && !/^[A-Za-z]:\/$/.test(normalized)) normalized = normalized.replace(/\/+$/, '');
  return normalized;
};

const comparable = (value: string): string => (
  /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value
);

const withinRoot = (value: string, root: string): boolean => {
  const path = comparable(normalizePath(value));
  const normalizedRoot = comparable(normalizePath(root));
  return Boolean(path && normalizedRoot && (path === normalizedRoot || path.startsWith(`${normalizedRoot}/`)));
};

const emptyRoot = (): RootExplorerState => ({
  expandedPaths: [],
  legacyOpenPaths: [],
  legacySelectedPath: null,
  touchedAt: Date.now(),
});

const sanitizeByRoot = (input: unknown): Record<string, RootExplorerState> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const output: Record<string, RootExplorerState> = {};
  for (const [rawRoot, raw] of Object.entries(input)) {
    if (!rawRoot || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const value = raw as Record<string, unknown>;
    const scoped = typeof value.sourceRoot === 'string';
    const root = normalizePath(scoped ? value.sourceRoot as string : rawRoot);
    if (!root) continue;
    const paths = (candidate: unknown): string[] => Array.isArray(candidate)
      ? [...new Set(candidate
        .filter((item): item is string => typeof item === 'string')
        .map(normalizePath)
        .filter((item) => withinRoot(item, root)))]
      : [];
    const legacyOpenPaths = paths(value.legacyOpenPaths ?? value.openPaths);
    const legacySelectedCandidate = typeof (value.legacySelectedPath ?? value.selectedPath) === 'string'
      ? normalizePath(String(value.legacySelectedPath ?? value.selectedPath))
      : null;
    output[scoped ? rawRoot : root] = {
      ...(scoped ? { sourceRoot: root } : {}),
      expandedPaths: paths(value.expandedPaths),
      legacyOpenPaths,
      legacySelectedPath: legacySelectedCandidate && withinRoot(legacySelectedCandidate, root)
        ? legacySelectedCandidate
        : legacyOpenPaths[0] ?? null,
      touchedAt: typeof value.touchedAt === 'number' && Number.isFinite(value.touchedAt)
        ? value.touchedAt
        : Date.now(),
    };
  }
  return output;
};

const updateRoot = (
  state: FilesExplorerState,
  root: string,
  update: (current: RootExplorerState) => RootExplorerState,
): Pick<FilesExplorerState, 'byRoot'> => ({
  byRoot: { ...state.byRoot, [root]: update(state.byRoot[root] ?? emptyRoot()) },
});

export const useFilesExplorerStore = create<FilesExplorerStore>()(
  devtools(
    persist(
      (set, get) => ({
        activeRuntimeKey: getRuntimeKey(),
        byRoot: {},
        runtimeSnapshots: {},

        resetForRuntimeSwitch: (runtimeKey) => {
          set((state) => {
            const runtimeSnapshots = {
              ...state.runtimeSnapshots,
              [state.activeRuntimeKey]: { byRoot: sanitizeByRoot(state.byRoot), updatedAt: Date.now() },
            };
            return {
              activeRuntimeKey: runtimeKey,
              runtimeSnapshots,
              byRoot: sanitizeByRoot(runtimeSnapshots[runtimeKey]?.byRoot),
            };
          });
        },

        consumeLegacyEditorTabs: (rootValue) => {
          const root = normalizePath(rootValue);
          const current = get().byRoot[root];
          const snapshot = {
            openPaths: [...(current?.legacyOpenPaths ?? [])],
            selectedPath: current?.legacySelectedPath ?? null,
          };
          if (current && (current.legacyOpenPaths.length > 0 || current.legacySelectedPath)) {
            set((state) => updateRoot(state, root, (entry) => ({
              ...entry,
              legacyOpenPaths: [],
              legacySelectedPath: null,
              touchedAt: Date.now(),
            })));
          }
          return snapshot;
        },

        toggleExpandedPath: (rootValue, pathValue, scopeKey) => {
          const root = normalizePath(rootValue);
          const path = normalizePath(pathValue);
          if (!withinRoot(path, root)) return;
          set((state) => updateRoot(state, scopeKey ?? root, (current) => ({
            ...current,
            ...(scopeKey ? { sourceRoot: root } : {}),
            expandedPaths: current.expandedPaths.includes(path)
              ? current.expandedPaths.filter((item) => item !== path)
              : [...current.expandedPaths, path],
            touchedAt: Date.now(),
          })));
        },

        collapseAllExpandedPaths: (rootValue, scopeKey) => {
          const root = normalizePath(rootValue);
          if (!root) return;
          set((state) => updateRoot(state, scopeKey ?? root, (current) => ({
            ...current,
            ...(scopeKey ? { sourceRoot: root } : {}),
            expandedPaths: [],
            touchedAt: Date.now(),
          })));
        },

        expandPath: (rootValue, pathValue, scopeKey) => {
          const root = normalizePath(rootValue);
          const path = normalizePath(pathValue);
          if (!withinRoot(path, root)) return;
          set((state) => updateRoot(state, scopeKey ?? root, (current) => ({
            ...current,
            ...(scopeKey ? { sourceRoot: root } : {}),
            expandedPaths: current.expandedPaths.includes(path)
              ? current.expandedPaths
              : [...current.expandedPaths, path],
            touchedAt: Date.now(),
          })));
        },

        expandPaths: (rootValue, pathValues, scopeKey) => {
          const root = normalizePath(rootValue);
          const paths = pathValues.map(normalizePath).filter((path) => withinRoot(path, root));
          if (!root || paths.length === 0) return;
          set((state) => updateRoot(state, scopeKey ?? root, (current) => ({
            ...current,
            ...(scopeKey ? { sourceRoot: root } : {}),
            expandedPaths: [...new Set([...current.expandedPaths, ...paths])],
            touchedAt: Date.now(),
          })));
        },

        removeExpandedPathsByPrefix: (rootValue, prefixValue, scopeKey) => {
          const root = normalizePath(rootValue);
          const prefix = comparable(normalizePath(prefixValue));
          if (!root || !prefix) return;
          set((state) => updateRoot(state, scopeKey ?? root, (current) => ({
            ...current,
            ...(scopeKey ? { sourceRoot: root } : {}),
            expandedPaths: current.expandedPaths.filter((item) => {
              const path = comparable(item);
              return path !== prefix && !path.startsWith(`${prefix}/`);
            }),
            touchedAt: Date.now(),
          })));
        },

        renameExpandedPathsByPrefix: (rootValue, fromValue, toValue, scopeKey) => {
          const root = normalizePath(rootValue);
          const from = normalizePath(fromValue);
          const to = normalizePath(toValue);
          if (!withinRoot(from, root) || !withinRoot(to, root)) return;
          const fromComparable = comparable(from);
          set((state) => updateRoot(state, scopeKey ?? root, (current) => ({
            ...current,
            ...(scopeKey ? { sourceRoot: root } : {}),
            expandedPaths: current.expandedPaths.map((item) => {
              const itemComparable = comparable(item);
              if (itemComparable !== fromComparable && !itemComparable.startsWith(`${fromComparable}/`)) return item;
              const suffix = item.slice(from.length).replace(/^\//, '');
              return suffix ? `${to}/${suffix}` : to;
            }),
            touchedAt: Date.now(),
          })));
        },
      }),
      {
        name: 'varin.filesExplorer.v1',
        storage: createDeferredSafeJSONStorage(),
        partialize: (state) => ({
          activeRuntimeKey: state.activeRuntimeKey,
          runtimeSnapshots: {
            ...state.runtimeSnapshots,
            [state.activeRuntimeKey]: { byRoot: sanitizeByRoot(state.byRoot), updatedAt: Date.now() },
          },
        }),
        merge: (persistedState, currentState) => {
          const persisted = persistedState && typeof persistedState === 'object'
            ? persistedState as Partial<FilesExplorerState>
            : {};
          const runtimeSnapshots = persisted.runtimeSnapshots && typeof persisted.runtimeSnapshots === 'object'
            ? persisted.runtimeSnapshots
            : {};
          const activeRuntimeKey = getRuntimeKey();
          return {
            ...currentState,
            activeRuntimeKey,
            runtimeSnapshots,
            byRoot: sanitizeByRoot(runtimeSnapshots[activeRuntimeKey]?.byRoot),
          };
        },
      },
    ),
    { name: 'varin-files-explorer' },
  ),
);
