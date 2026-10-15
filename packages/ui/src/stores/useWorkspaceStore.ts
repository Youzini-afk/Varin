import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

import type {
  CreateGitCommitOptions,
  GitLogOptions,
  GitLogResponse,
  GitRemote,
  GitPullResult,
  GitPushResult,
  ProjectEntry,
  SettingsPayload,
  WorkspaceArchiveExtractRequest,
  WorkspaceArchiveExtractResult,
  WorkspaceArchivePreview,
  WorkspaceEntry,
  WorkspaceGitCloneOptions,
  WorkspaceGitCloneResult,
  WorkspaceGitStatus,
  WorkspaceListResult,
  WorkspaceRootInfo,
  WorkspaceUploadFile,
} from '@varin/application-client';
import { getWorkspaceAPI } from '@/lib/workspaceApi';
import type { WorkspaceArchiveMode } from '@/lib/workspaceArchive';
import { useProjectsStore } from '@/stores/useProjectsStore';

export type WorkspaceTerminalDialogState = {
  open: boolean;
  /** null is an attached process view with no local workspace root. */
  workspacePath: string | null;
  title: string;
  directoryKey: string;
};

export type WorkspaceGitPanelState = {
  open: boolean;
  path: string;
};

export type WorkspaceArchiveDialogState = {
  open: boolean;
  path: string;
  mode: WorkspaceArchiveMode;
};

type WorkspaceStore = {
  root: WorkspaceRootInfo | null;
  entriesByPath: Record<string, WorkspaceEntry[]>;
  directoryMetaByPath: Record<string, Omit<WorkspaceListResult, 'entries'>>;
  expandedPaths: Record<string, boolean>;
  selectedPath: string | null;
  gitStatusByPath: Record<string, WorkspaceGitStatus>;
  gitLogByPath: Record<string, GitLogResponse>;
  gitRemotesByPath: Record<string, GitRemote[]>;
  loadingRoot: boolean;
  loadingPaths: Record<string, boolean>;
  actionPending: string | null;
  error: string | null;
  terminalDialog: WorkspaceTerminalDialogState;
  gitPanel: WorkspaceGitPanelState;
  archiveDialog: WorkspaceArchiveDialogState;

  loadRoot: () => Promise<WorkspaceRootInfo | null>;
  refreshWorkspace: () => Promise<void>;
  loadDirectory: (path?: string) => Promise<WorkspaceEntry[]>;
  toggleExpandedPath: (path: string) => void;
  setSelectedPath: (path: string | null) => void;
  createFolder: (path: string) => Promise<WorkspaceEntry | null>;
  createFile: (path: string, content?: string) => Promise<WorkspaceEntry | null>;
  moveEntry: (from: string, to: string) => Promise<WorkspaceEntry | null>;
  renameEntry: (path: string, name: string) => Promise<WorkspaceEntry | null>;
  deleteEntry: (path: string, options?: { permanent?: boolean }) => Promise<boolean>;
  uploadFiles: (path: string, files: WorkspaceUploadFile[]) => Promise<WorkspaceEntry[]>;
  downloadFile: (path: string) => Promise<void>;
  previewArchive: (path: string) => Promise<WorkspaceArchivePreview | null>;
  extractArchive: (request: WorkspaceArchiveExtractRequest) => Promise<WorkspaceArchiveExtractResult | null>;
  openProject: (path: string) => Promise<ProjectEntry | null>;
  refreshGitStatus: (path: string) => Promise<WorkspaceGitStatus | null>;
  gitFetch: (path: string, options?: { remote?: string; branch?: string }) => Promise<boolean>;
  gitClone: (path: string, options: WorkspaceGitCloneOptions) => Promise<WorkspaceGitCloneResult | null>;
  gitPull: (path: string, options?: { remote?: string; branch?: string }) => Promise<GitPullResult | null>;
  gitPush: (path: string, options?: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> }) => Promise<GitPushResult | null>;
  gitCheckout: (path: string, branch: string) => Promise<boolean>;
  gitCommit: (path: string, message: string, options?: CreateGitCommitOptions) => Promise<boolean>;
  loadGitLog: (path: string, options?: GitLogOptions) => Promise<GitLogResponse | null>;
  loadGitRemotes: (path: string) => Promise<GitRemote[]>;
  openTerminal: (path?: string) => void;
  openAttachedTerminal: (directoryKey: string, title: string) => void;
  closeTerminal: () => void;
  openGitPanel: (path: string) => void;
  closeGitPanel: () => void;
  openArchiveDialog: (path: string, mode?: WorkspaceArchiveMode) => void;
  closeArchiveDialog: () => void;
  clearWorkspaceCache: () => void;
  resetForTests: () => void;
};

const EMPTY_TERMINAL_DIALOG: WorkspaceTerminalDialogState = {
  open: false,
  workspacePath: '',
  title: 'Terminal - /workspace',
  directoryKey: 'workspace:',
};

const EMPTY_GIT_PANEL: WorkspaceGitPanelState = {
  open: false,
  path: '',
};

const EMPTY_ARCHIVE_DIALOG: WorkspaceArchiveDialogState = {
  open: false,
  path: '',
  mode: 'preview',
};

const normalizeWorkspacePath = (value = ''): string => (
  value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/g, '')
);

const parentPathOf = (path: string): string => {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized) return '';
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(0, index) : '';
};

const isSafeEntryName = (name: string): boolean => {
  const trimmed = name.trim();
  return Boolean(
    trimmed
    && trimmed !== '.'
    && trimmed !== '..'
    && !trimmed.includes('/')
    && !trimmed.includes('\\')
    && !trimmed.includes('\0')
  );
};

const pathAndParents = (path: string): string[] => {
  const result: string[] = [];
  let current = normalizeWorkspacePath(path);
  while (current) {
    result.push(current);
    current = parentPathOf(current);
  }
  result.push('');
  return Array.from(new Set(result));
};

const directoryKeyForTerminal = (path: string): string => `workspace:${normalizeWorkspacePath(path)}`;

const buildTerminalTitle = (root: WorkspaceRootInfo | null, path: string): string => {
  const workspacePath = normalizeWorkspacePath(path);
  const rootLabel = root?.root || '/workspace';
  return workspacePath ? `Terminal - ${rootLabel}/${workspacePath}` : `Terminal - ${rootLabel}`;
};

const pruneCachedBranch = <TValue>(map: Record<string, TValue>, path: string): Record<string, TValue> => {
  const normalized = normalizeWorkspacePath(path);
  if (!normalized && map[''] === undefined) return map;

  let changed = false;
  const next: Record<string, TValue> = {};
  for (const [key, value] of Object.entries(map)) {
    const isMatch = normalized
      ? key === normalized || key.startsWith(`${normalized}/`)
      : key === '';
    if (isMatch) {
      changed = true;
      continue;
    }
    next[key] = value;
  }
  return changed ? next : map;
};

const withAction = async <TResult>(
  action: string,
  task: () => Promise<TResult>,
): Promise<TResult | null> => {
  useWorkspaceStore.setState({ actionPending: action, error: null });
  try {
    return await task();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useWorkspaceStore.setState({ error: message || 'Workspace action failed' });
    return null;
  } finally {
    useWorkspaceStore.setState((state) => (
      state.actionPending === action ? { actionPending: null } : {}
    ));
  }
};

const initialState = {
  root: null,
  entriesByPath: {},
  directoryMetaByPath: {},
  expandedPaths: {},
  selectedPath: null,
  gitStatusByPath: {},
  gitLogByPath: {},
  gitRemotesByPath: {},
  loadingRoot: false,
  loadingPaths: {},
  actionPending: null,
  error: null,
  terminalDialog: EMPTY_TERMINAL_DIALOG,
  gitPanel: EMPTY_GIT_PANEL,
  archiveDialog: EMPTY_ARCHIVE_DIALOG,
};

export const useWorkspaceStore = create<WorkspaceStore>()(
  devtools((set, get) => ({
    ...initialState,

    loadRoot: async () => {
      set({ loadingRoot: true, error: null });
      try {
        const root = await getWorkspaceAPI().getRoot();
        set({ root, loadingRoot: false });
        return root;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ error: message || 'Failed to load workspace root', loadingRoot: false });
        return null;
      }
    },

    refreshWorkspace: async () => {
      await get().loadRoot();
      await get().loadDirectory('');
    },

    loadDirectory: async (path = '') => {
      const target = normalizeWorkspacePath(path);
      set((state) => ({
        loadingPaths: { ...state.loadingPaths, [target]: true },
        error: null,
      }));
      try {
        const result = await getWorkspaceAPI().list(target);
        const normalized = normalizeWorkspacePath(result.relativePath ?? target);
        set((state) => ({
          entriesByPath: {
            ...state.entriesByPath,
            [normalized]: result.entries,
          },
          directoryMetaByPath: {
            ...state.directoryMetaByPath,
            [normalized]: {
              path: result.path,
              relativePath: normalized,
            },
          },
          loadingPaths: { ...state.loadingPaths, [target]: false },
        }));
        return result.entries;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          error: message || 'Failed to load workspace directory',
          loadingPaths: { ...state.loadingPaths, [target]: false },
        }));
        return [];
      }
    },

    toggleExpandedPath: (path: string) => {
      const target = normalizeWorkspacePath(path);
      set((state) => ({
        expandedPaths: {
          ...state.expandedPaths,
          [target]: !state.expandedPaths[target],
        },
      }));
    },

    setSelectedPath: (path: string | null) => {
      set({ selectedPath: path === null ? null : normalizeWorkspacePath(path) });
    },

    createFolder: async (path: string) => {
      const target = normalizeWorkspacePath(path);
      const parent = parentPathOf(target);
      const result = await withAction(`create-folder:${target}`, async () => {
        const response = await getWorkspaceAPI().createFolder(target);
        await get().loadDirectory(parent);
        return response.entry;
      });
      return result;
    },

    createFile: async (path: string, content = '') => {
      const target = normalizeWorkspacePath(path);
      const parent = parentPathOf(target);
      return withAction(`create-file:${target}`, async () => {
        const response = await getWorkspaceAPI().createFile(target, content);
        await get().loadDirectory(parent);
        return response.entry;
      });
    },

    moveEntry: async (from: string, to: string) => {
      const fromPath = normalizeWorkspacePath(from);
      const toPath = normalizeWorkspacePath(to);
      const fromParent = parentPathOf(fromPath);
      const toParent = parentPathOf(toPath);
      return withAction(`move:${fromPath}`, async () => {
        const response = await getWorkspaceAPI().move(fromPath, toPath);
        set((state) => ({
          entriesByPath: pruneCachedBranch(pruneCachedBranch(state.entriesByPath, fromPath), toPath),
          gitStatusByPath: pruneCachedBranch(pruneCachedBranch(state.gitStatusByPath, fromPath), toPath),
        }));
        await Promise.all(Array.from(new Set([fromParent, toParent])).map((parent) => get().loadDirectory(parent)));
        return response.entry;
      });
    },

    renameEntry: async (path: string, name: string) => {
      const fromPath = normalizeWorkspacePath(path);
      const nextName = name.trim();
      if (!fromPath || !isSafeEntryName(nextName)) return null;
      const currentName = fromPath.split('/').pop() || fromPath;
      if (nextName === currentName) return null;
      const parent = parentPathOf(fromPath);
      const toPath = parent ? `${parent}/${nextName}` : nextName;
      return get().moveEntry(fromPath, toPath);
    },

    deleteEntry: async (path: string, options = {}) => {
      const target = normalizeWorkspacePath(path);
      const parent = parentPathOf(target);
      const result = await withAction(`delete:${target}`, async () => {
        await getWorkspaceAPI().deleteEntry(target, options);
        set((state) => ({
          entriesByPath: pruneCachedBranch(state.entriesByPath, target),
          gitStatusByPath: pruneCachedBranch(state.gitStatusByPath, target),
          gitLogByPath: pruneCachedBranch(state.gitLogByPath, target),
          gitRemotesByPath: pruneCachedBranch(state.gitRemotesByPath, target),
        }));
        await get().loadDirectory(parent);
        return true;
      });
      return result === true;
    },

    uploadFiles: async (path: string, files: WorkspaceUploadFile[]) => {
      const target = normalizeWorkspacePath(path);
      const result = await withAction(`upload:${target}`, async () => {
        const response = await getWorkspaceAPI().upload(target, files);
        await get().loadDirectory(target);
        return response.entries;
      });
      return result ?? [];
    },

    downloadFile: async (path: string) => {
      const target = normalizeWorkspacePath(path);
      await getWorkspaceAPI().download(target);
    },

    previewArchive: async (path: string) => {
      const target = normalizeWorkspacePath(path);
      return withAction(`archive-preview:${target}`, async () => getWorkspaceAPI().previewArchive(target));
    },

    extractArchive: async (request) => {
      const target = normalizeWorkspacePath(request.path);
      const destination = normalizeWorkspacePath(request.destination);
      return withAction(`archive-extract:${target}`, async () => {
        const response = await getWorkspaceAPI().extractArchive({
          ...request,
          path: target,
          destination,
        });
        const destinationParent = parentPathOf(response.destination || destination);
        await Promise.all(Array.from(new Set([
          parentPathOf(target),
          destinationParent,
          response.destination,
        ])).map((pathToLoad) => get().loadDirectory(pathToLoad)));
        return response;
      });
    },

    openProject: async (path: string) => {
      const target = normalizeWorkspacePath(path);
      return withAction(`open-project:${target}`, async () => {
        const result = await getWorkspaceAPI().openProject(target);
        useProjectsStore.getState().synchronizeFromSettings(result.settings as SettingsPayload);
        return result.project;
      });
    },

    refreshGitStatus: async (path: string) => {
      const target = normalizeWorkspacePath(path);
      try {
        const status = await getWorkspaceAPI().gitStatus(target);
        set((state) => ({
          gitStatusByPath: {
            ...state.gitStatusByPath,
            [target]: status,
          },
        }));
        return status;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ error: message || 'Failed to refresh git status' });
        return null;
      }
    },

    gitFetch: async (path: string, options) => {
      const target = normalizeWorkspacePath(path);
      const result = await withAction(`git-fetch:${target}`, async () => {
        await getWorkspaceAPI().gitFetch(target, options);
        await get().refreshGitStatus(target);
        return true;
      });
      return result === true;
    },

    gitClone: async (path: string, options) => {
      const target = normalizeWorkspacePath(path);
      return withAction(`git-clone:${target}`, async () => {
        const result = await getWorkspaceAPI().gitClone(target, {
          url: options.url,
          branch: options.branch,
          directoryName: options.directoryName,
        });
        await get().loadDirectory(target);
        await get().refreshGitStatus(target);
        return result;
      });
    },

    gitPull: async (path: string, options) => {
      const target = normalizeWorkspacePath(path);
      return withAction(`git-pull:${target}`, async () => {
        const result = await getWorkspaceAPI().gitPull(target, options);
        await get().refreshGitStatus(target);
        await get().loadDirectory(parentPathOf(target));
        return result;
      });
    },

    gitPush: async (path: string, options) => {
      const target = normalizeWorkspacePath(path);
      return withAction(`git-push:${target}`, async () => {
        const result = await getWorkspaceAPI().gitPush(target, options);
        await get().refreshGitStatus(target);
        return result;
      });
    },

    gitCheckout: async (path: string, branch: string) => {
      const target = normalizeWorkspacePath(path);
      const result = await withAction(`git-checkout:${target}`, async () => {
        await getWorkspaceAPI().gitCheckout(target, branch);
        await get().refreshGitStatus(target);
        return true;
      });
      return result === true;
    },

    gitCommit: async (path: string, message: string, options) => {
      const target = normalizeWorkspacePath(path);
      const result = await withAction(`git-commit:${target}`, async () => {
        await getWorkspaceAPI().gitCommit(target, message, options);
        await get().refreshGitStatus(target);
        return true;
      });
      return result === true;
    },

    loadGitLog: async (path: string, options) => {
      const target = normalizeWorkspacePath(path);
      try {
        const log = await getWorkspaceAPI().gitLog(target, options);
        set((state) => ({
          gitLogByPath: {
            ...state.gitLogByPath,
            [target]: log,
          },
        }));
        return log;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ error: message || 'Failed to load git log' });
        return null;
      }
    },

    loadGitRemotes: async (path: string) => {
      const target = normalizeWorkspacePath(path);
      try {
        const remotes = await getWorkspaceAPI().gitRemotes(target);
        set((state) => ({
          gitRemotesByPath: {
            ...state.gitRemotesByPath,
            [target]: remotes,
          },
        }));
        return remotes;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set({ error: message || 'Failed to load git remotes' });
        return [];
      }
    },

    openTerminal: (path = '') => {
      const workspacePath = normalizeWorkspacePath(path);
      const title = buildTerminalTitle(get().root, workspacePath);
      set({
        terminalDialog: {
          open: true,
          workspacePath,
          title,
          directoryKey: directoryKeyForTerminal(workspacePath),
        },
      });
    },

    openAttachedTerminal: (directoryKey, title) => {
      set({ terminalDialog: { open: true, workspacePath: null, directoryKey, title } });
    },

    closeTerminal: () => {
      set((state) => ({
        terminalDialog: {
          ...state.terminalDialog,
          open: false,
        },
      }));
    },

    openGitPanel: (path: string) => {
      const target = normalizeWorkspacePath(path);
      set({ gitPanel: { open: true, path: target }, error: null });
      void get().refreshGitStatus(target).then((status) => {
        if (status?.isGitRepository) {
          void get().loadGitLog(target, { maxCount: 8 });
          void get().loadGitRemotes(target);
          return;
        }

        set((state) => ({
          gitLogByPath: pruneCachedBranch(state.gitLogByPath, target),
          gitRemotesByPath: pruneCachedBranch(state.gitRemotesByPath, target),
        }));
      });
    },

    closeGitPanel: () => {
      set({ gitPanel: EMPTY_GIT_PANEL });
    },

    openArchiveDialog: (path: string, mode = 'preview') => {
      set({
        archiveDialog: {
          open: true,
          path: normalizeWorkspacePath(path),
          mode,
        },
      });
    },

    closeArchiveDialog: () => {
      set({ archiveDialog: EMPTY_ARCHIVE_DIALOG });
    },

    clearWorkspaceCache: () => {
      set({
        ...initialState,
        terminalDialog: EMPTY_TERMINAL_DIALOG,
        gitPanel: EMPTY_GIT_PANEL,
        archiveDialog: EMPTY_ARCHIVE_DIALOG,
      });
    },

    resetForTests: () => {
      set({
        ...initialState,
        terminalDialog: EMPTY_TERMINAL_DIALOG,
        gitPanel: EMPTY_GIT_PANEL,
        archiveDialog: EMPTY_ARCHIVE_DIALOG,
      });
    },
  }), { name: 'workspace-store' })
);

export const getWorkspaceParentPath = parentPathOf;
export const normalizeWorkspaceRelativePath = normalizeWorkspacePath;
export const getWorkspacePathChain = pathAndParents;
