import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ProjectEntry } from '@varin/application-client';
import type { WorkFocusId } from '@varin/protocol';
import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { projectFolders, projectPathKey } from '@varin/application-client';
import { NO_ACTIVE_PROJECT_STORAGE_VALUE } from '@/lib/projectSelection';
import { getDeferredSafeStorage } from './utils/safeStorage';
import { useDirectoryStore } from './useDirectoryStore';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { PROJECT_COLORS } from '@/lib/projectMeta';
import { runtimeFetch } from '@varin/application-client';
import { getRuntimeApiBaseUrl } from '@varin/application-client';

/** Pick a color key that's least used among existing projects */
const pickAutoColor = (projects: ProjectEntry[]): string => {
  const colorKeys = PROJECT_COLORS.map((c) => c.key);
  const usageCounts = new Map<string, number>();
  for (const key of colorKeys) {
    usageCounts.set(key, 0);
  }
  for (const p of projects) {
    if (p.color && usageCounts.has(p.color)) {
      usageCounts.set(p.color, (usageCounts.get(p.color) ?? 0) + 1);
    }
  }
  // Find minimum usage, then pick randomly among those with min usage
  const minUsage = Math.min(...usageCounts.values());
  const candidates = colorKeys.filter((k) => usageCounts.get(k) === minUsage);
  return candidates[Math.floor(Math.random() * candidates.length)];
};

interface ProjectPathValidationResult {
  ok: boolean;
  normalizedPath?: string;
  reason?: string;
}

interface ProjectsStore {
  projects: ProjectEntry[];
  activeProjectId: string | null;
  manualProjectOrder: string[];

  addProject: (path: string, options?: { label?: string; id?: string; additionalPaths?: string[] }) => Promise<ProjectEntry | null>;
  updateProjectFolders: (id: string, folders: string[]) => Promise<void>;
  removeProject: (id: string) => void;
  setActiveProject: (id: string | null) => Promise<boolean>;
  setActiveProjectIdOnly: (id: string | null) => void;
  renameProject: (id: string, label: string) => void;
  updateProjectMeta: (id: string, meta: {
    label?: string;
    icon?: string | null;
    color?: string | null;
    iconBackground?: string | null;
    defaultModel?: string | null;
    defaultWorkFocus?: WorkFocusId;
  }) => void;
  uploadProjectIcon: (id: string, file: File) => Promise<{ ok: boolean; error?: string }>;
  removeProjectIcon: (id: string) => Promise<{ ok: boolean; error?: string }>;
  discoverProjectIcon: (id: string, options?: { force?: boolean }) => Promise<{ ok: boolean; skipped?: boolean; reason?: string; error?: string }>;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  resetForRuntimeSwitch: () => void;
  validateProjectPath: (path: string) => ProjectPathValidationResult;
  synchronizeFromSettings: (settings: DesktopSettings) => void;
  getActiveProject: () => ProjectEntry | null;
}

const safeStorage = getDeferredSafeStorage();
const PROJECTS_STORAGE_KEY = 'projects';
const ACTIVE_PROJECT_STORAGE_KEY = 'activeProjectId';

const getLocalRuntimeOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const value = (window as typeof window & { __VARIN_LOCAL_ORIGIN__?: string }).__VARIN_LOCAL_ORIGIN__;
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
};

const getProjectsStorageNamespace = (): string => {
  const apiBaseUrl = getRuntimeApiBaseUrl().trim().replace(/\/+$/, '');
  if (!apiBaseUrl) return '';
  return apiBaseUrl;
};

const getProjectsStorageKey = (): string => {
  const namespace = getProjectsStorageNamespace();
  return namespace ? `${PROJECTS_STORAGE_KEY}:${encodeURIComponent(namespace)}` : PROJECTS_STORAGE_KEY;
};

const getActiveProjectStorageKey = (): string => {
  const namespace = getProjectsStorageNamespace();
  return namespace ? `${ACTIVE_PROJECT_STORAGE_KEY}:${encodeURIComponent(namespace)}` : ACTIVE_PROJECT_STORAGE_KEY;
};

const shouldReadLegacyProjectsCache = (): boolean => {
  const namespace = getProjectsStorageNamespace();
  if (!namespace) return true;
  const localOrigin = getLocalRuntimeOrigin();
  return Boolean(localOrigin && namespace === localOrigin);
};

const resolveTildePath = (value: string, homeDir?: string | null): string => {
  const trimmed = value.trim();
  if (!trimmed.startsWith('~')) {
    return trimmed;
  }
  if (!homeDir) {
    return trimmed;
  }
  if (trimmed === '~') {
    return homeDir;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return `${homeDir}${trimmed.slice(1)}`;
  }
  return trimmed;
};

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

const normalizeDefaultModel = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const separatorIndex = trimmed.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) {
    return undefined;
  }
  return trimmed;
};

const normalizeIconBackground = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

const normalizeProjectPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const homeDirectory = safeStorage.getItem('homeDirectory') || useDirectoryStore.getState().homeDirectory || '';
  const expanded = resolveTildePath(trimmed, homeDirectory);

  const normalized = expanded.replace(/\\/g, '/');
  if (normalized === '/') return '/';
  if (/^[A-Za-z]:\/?$/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

const deriveProjectLabel = (path: string): string => {
  const normalized = normalizeProjectPath(path);
  if (!normalized || normalized === '/') {
    return 'Root';
  }
  const segments = normalized.split('/').filter(Boolean);
  const raw = segments[segments.length - 1] || normalized;
  return raw.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

const sanitizeProjectIconImage = (value: unknown): ProjectEntry['iconImage'] | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const mime = typeof candidate.mime === 'string' ? candidate.mime.trim() : '';
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? Math.max(0, Math.round(candidate.updatedAt))
    : 0;
  const source = candidate.source === 'custom' || candidate.source === 'auto'
    ? candidate.source
    : null;

  if (!mime || !updatedAt || !source) {
    return undefined;
  }

  return { mime, updatedAt, source };
};

const resolveUploadMime = (file: File): 'image/png' | 'image/jpeg' | 'image/svg+xml' | null => {
  const rawType = typeof file.type === 'string' ? file.type.trim().toLowerCase() : '';
  if (rawType === 'image/png' || rawType === 'image/jpeg' || rawType === 'image/svg+xml') {
    return rawType;
  }

  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.svg')) return 'image/svg+xml';

  return null;
};

const readFileAsDataUrl = async (file: File): Promise<string> => {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('Failed to read icon file'));
    };
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error('Failed to read icon file'));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
};

const sanitizeProjects = (value: unknown): ProjectEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const result: ProjectEntry[] = [];
  const seenIds = new Set<string>();

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;

    const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
    if (!rawPath) continue;

    const normalizedPath = normalizeProjectPath(rawPath);
    if (!normalizedPath) continue;

    const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
    if (!id) continue;

    if (seenIds.has(id)) continue;
    seenIds.add(id);

    const project: ProjectEntry = {
      id,
      path: normalizedPath,
      additionalPaths: projectFolders({ path: normalizedPath, additionalPaths: Array.isArray(candidate.additionalPaths)
        ? candidate.additionalPaths.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
          .map(normalizeProjectPath)
        : [] }).slice(1),
    };

    if (typeof candidate.label === 'string' && candidate.label.trim().length > 0) {
      project.label = candidate.label.trim();
    }
    if (typeof candidate.icon === 'string' && candidate.icon.trim().length > 0) {
      project.icon = candidate.icon.trim();
    }
    if (candidate.iconImage === null) {
      project.iconImage = null;
    } else {
      const iconImage = sanitizeProjectIconImage(candidate.iconImage);
      if (iconImage) {
        project.iconImage = iconImage;
      }
    }
    if (typeof candidate.color === 'string' && candidate.color.trim().length > 0) {
      project.color = candidate.color.trim();
    }
    const defaultModel = normalizeDefaultModel(candidate.defaultModel);
    if (defaultModel) {
      project.defaultModel = defaultModel;
    }
    if (candidate.defaultWorkFocus === 'code' || candidate.defaultWorkFocus === 'research') {
      project.defaultWorkFocus = candidate.defaultWorkFocus;
    }
    if (candidate.iconBackground === null) {
      project.iconBackground = null;
    } else {
      const iconBackground = normalizeIconBackground(candidate.iconBackground);
      if (iconBackground) {
        project.iconBackground = iconBackground;
      }
    }
    if (typeof candidate.addedAt === 'number' && Number.isFinite(candidate.addedAt) && candidate.addedAt >= 0) {
      project.addedAt = candidate.addedAt;
    }
    if (typeof candidate.lastOpenedAt === 'number' && Number.isFinite(candidate.lastOpenedAt) && candidate.lastOpenedAt >= 0) {
      project.lastOpenedAt = candidate.lastOpenedAt;
    }
    if (typeof candidate.sidebarCollapsed === 'boolean') {
      project.sidebarCollapsed = candidate.sidebarCollapsed;
    }
    result.push(project);
  }

  return result;
};

const readPersistedProjects = (): ProjectEntry[] => {
  try {
    const raw = safeStorage.getItem(getProjectsStorageKey())
      || (shouldReadLegacyProjectsCache() ? safeStorage.getItem(PROJECTS_STORAGE_KEY) : null);
    if (!raw) {
      return [];
    }
    return sanitizeProjects(JSON.parse(raw));
  } catch {
    return [];
  }
};

const readPersistedManualOrder = (): string[] => {
  try {
    const raw = safeStorage.getItem(getProjectsStorageKey() + ':manualOrder');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

const readPersistedActiveProjectSelection = (): string | null | undefined => {
  try {
    const raw = safeStorage.getItem(getActiveProjectStorageKey())
      || (shouldReadLegacyProjectsCache() ? safeStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY) : null);
    if (raw === NO_ACTIVE_PROJECT_STORAGE_VALUE) return null;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      return raw.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const readPersistedActiveProjectId = (): string | null => (
  readPersistedActiveProjectSelection() ?? null
);

const cacheProjects = (projects: ProjectEntry[], activeProjectId: string | null) => {
  try {
    safeStorage.setItem(getProjectsStorageKey(), JSON.stringify(projects));
  } catch {
    // ignored
  }

  try {
    const activeProjectStorageKey = getActiveProjectStorageKey();
    if (activeProjectId) {
      safeStorage.setItem(activeProjectStorageKey, activeProjectId);
    } else {
      safeStorage.setItem(activeProjectStorageKey, NO_ACTIVE_PROJECT_STORAGE_VALUE);
    }
  } catch {
    // ignored
  }
};

const persistProjects = async (
  projects: ProjectEntry[],
  activeProjectId: string | null,
  manualOrder?: string[],
): Promise<boolean> => {
  cacheProjects(projects, activeProjectId);
  if (manualOrder) {
    persistManualProjectOrder(manualOrder);
  }
  return updateDesktopSettings({ projects, activeProjectId });
};

let activeProjectSelectionGeneration = 0;

const persistManualProjectOrder = (manualOrder: string[]) => {
  try {
    safeStorage.setItem(getProjectsStorageKey() + ':manualOrder', JSON.stringify(manualOrder));
  } catch {
    // ignored
  }
};

const initialProjects = readPersistedProjects();
const persistedInitialActiveProjectId = readPersistedActiveProjectId();
const initialActiveProjectId = initialProjects.some((project) => project.id === persistedInitialActiveProjectId)
  ? persistedInitialActiveProjectId
  : null;

export const useProjectsStore = create<ProjectsStore>()(
  devtools((set, get) => ({
    projects: initialProjects,
    activeProjectId: initialActiveProjectId,
    manualProjectOrder: readPersistedManualOrder(),

    validateProjectPath: (path: string): ProjectPathValidationResult => {
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { ok: false, reason: 'Provide a directory path.' };
      }

      const normalized = normalizeProjectPath(path);
      if (!normalized) {
        return { ok: false, reason: 'Directory path cannot be empty.' };
      }

      return { ok: true, normalizedPath: normalized };
    },

    addProject: async (path: string, options?: { label?: string; id?: string; additionalPaths?: string[] }) => {
      const { validateProjectPath } = get();
      const validation = validateProjectPath(path);
      if (!validation.ok || !validation.normalizedPath) {
        return null;
      }

      const normalizedPath = validation.normalizedPath;
      const existing = options?.label || options?.additionalPaths?.length ? undefined
        : get().projects.find((project) => projectPathKey(project.path) === projectPathKey(normalizedPath));
      if (existing) {
        if (!await get().setActiveProject(existing.id)) {
          throw new Error('Failed to persist the selected workspace.');
        }
        return existing;
      }

      const now = Date.now();
      const label = options?.label?.trim() || deriveProjectLabel(normalizedPath);
      const id = options?.id ?? `project_${crypto.randomUUID()}`;
      const entry: ProjectEntry = {
        id,
        path: normalizedPath,
        additionalPaths: projectFolders({ path: normalizedPath, additionalPaths: options?.additionalPaths?.map(normalizeProjectPath) }).slice(1),
        label,
        color: pickAutoColor(get().projects),
        addedAt: now,
        lastOpenedAt: now,
      };

      const nextProjects = [...get().projects, entry];
      set({ projects: nextProjects });

      if (streamDebugEnabled()) {
        console.info('[ProjectsStore] Added project', entry);
      }

      const activated = await get().setActiveProject(entry.id);
      if (!activated) {
        const current = get();
        const remainingProjects = current.projects.filter((project) => project.id !== entry.id);
        set({ projects: remainingProjects });
        cacheProjects(remainingProjects, current.activeProjectId);
        throw new Error('Failed to persist the selected workspace.');
      }
      void get().discoverProjectIcon(entry.id);
      return entry;
    },

    updateProjectFolders: async (id, folders) => {
      const normalized = folders.map(normalizeProjectPath).filter(Boolean);
      const path = normalized[0];
      if (!path) throw new Error('A project needs at least one folder.');
      const current = get();
      const previous = current.projects.find((project) => project.id === id);
      if (!previous) throw new Error('Project no longer exists.');
      const updated = { ...previous, path, additionalPaths: projectFolders({ path, additionalPaths: normalized.slice(1) }).slice(1) };
      const projects = current.projects.map((project) => project.id === id ? updated : project);
      set({ projects });
      if (!await persistProjects(projects, current.activeProjectId, current.manualProjectOrder).catch(() => false)) {
        const rollback = get().projects.map((project) => project === updated ? previous : project);
        set({ projects: rollback });
        cacheProjects(rollback, get().activeProjectId);
        throw new Error('Failed to save project folders.');
      }
    },

    removeProject: (id: string) => {
      const current = get();
      const nextProjects = current.projects.filter((project) => project.id !== id);
      let nextActiveId = current.activeProjectId;

      if (current.activeProjectId === id) {
        nextActiveId = null;
      }

      const nextManualOrder = get().manualProjectOrder.filter((oid) => oid !== id);
      set({ projects: nextProjects, activeProjectId: nextActiveId, manualProjectOrder: nextManualOrder });
      activeProjectSelectionGeneration += 1;
      void persistProjects(nextProjects, nextActiveId, nextManualOrder);

      if (nextActiveId) {
        const nextActive = nextProjects.find((project) => project.id === nextActiveId);
        if (nextActive) {
          useDirectoryStore.getState().setDirectory(nextActive.path, { showOverlay: false });
        }
      } else {
        void useDirectoryStore.getState().goHome();
      }
    },

    setActiveProject: async (id: string | null) => {
      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return true;
      }
      const selectionGeneration = ++activeProjectSelectionGeneration;
      if (id === null) {
        const persisted = await persistProjects(projects, null, get().manualProjectOrder).catch(() => false);
        if (selectionGeneration !== activeProjectSelectionGeneration) return false;
        if (!persisted) {
          cacheProjects(projects, activeProjectId);
          return false;
        }
        set({ activeProjectId: null });
        await useDirectoryStore.getState().goHome();
        return true;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return false;
      }

      const now = Date.now();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, lastOpenedAt: now } : project
      );

      const persisted = await persistProjects(nextProjects, id, get().manualProjectOrder).catch(() => false);
      if (selectionGeneration !== activeProjectSelectionGeneration) return false;
      if (!persisted) {
        cacheProjects(projects, activeProjectId);
        return false;
      }
      set({ projects: nextProjects, activeProjectId: id });
      useDirectoryStore.getState().setDirectory(target.path, { showOverlay: false });
      return true;
    },

    setActiveProjectIdOnly: (id: string | null) => {
      activeProjectSelectionGeneration += 1;
      const { projects, activeProjectId } = get();
      if (activeProjectId === id) {
        return;
      }
      if (id === null) {
        set({ activeProjectId: null });
        void persistProjects(projects, null, get().manualProjectOrder);
        return;
      }
      const target = projects.find((project) => project.id === id);
      if (!target) {
        return;
      }

      const now = Date.now();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, lastOpenedAt: now } : project
      );

      set({ projects: nextProjects, activeProjectId: id });
      void persistProjects(nextProjects, id, get().manualProjectOrder);
    },

    renameProject: (id: string, label: string) => {
      const trimmed = label.trim();
      if (!trimmed) {
        return;
      }

      const { projects, activeProjectId } = get();
      const nextProjects = projects.map((project) =>
        project.id === id ? { ...project, label: trimmed } : project
      );
      set({ projects: nextProjects });
      void persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
    },

    updateProjectMeta: (id: string, meta: {
      label?: string;
      icon?: string | null;
      color?: string | null;
      iconBackground?: string | null;
      defaultModel?: string | null;
      defaultWorkFocus?: WorkFocusId;
    }) => {
      const { projects, activeProjectId } = get();
      const nextProjects = projects.map((project) => {
        if (project.id !== id) return project;
        const updated = { ...project };
        if (meta.label !== undefined) {
          const trimmed = meta.label.trim();
          if (trimmed) updated.label = trimmed;
        }
        if (meta.icon !== undefined) updated.icon = meta.icon;
        if (meta.color !== undefined) updated.color = meta.color;
        if (meta.iconBackground !== undefined) {
          updated.iconBackground = normalizeIconBackground(meta.iconBackground);
        }
        if (meta.defaultModel !== undefined) {
          const normalized = normalizeDefaultModel(meta.defaultModel);
          if (normalized) {
            updated.defaultModel = normalized;
          } else {
            delete updated.defaultModel;
          }
        }
        if (meta.defaultWorkFocus !== undefined) updated.defaultWorkFocus = meta.defaultWorkFocus;
        return updated;
      });
      set({ projects: nextProjects });
      void persistProjects(nextProjects, activeProjectId, get().manualProjectOrder);
    },

    uploadProjectIcon: async (id: string, file: File) => {
      const mime = resolveUploadMime(file);
      if (!mime) {
        return { ok: false, error: 'Only PNG, JPEG, and SVG are supported' };
      }
      if (!Number.isFinite(file.size) || file.size <= 0) {
        return { ok: false, error: 'Icon file is empty' };
      }
      if (file.size > 5 * 1024 * 1024) {
        return { ok: false, error: 'Icon exceeds size limit (5 MB)' };
      }

      try {
        const dataUrl = await readFileAsDataUrl(file);
        const normalizedDataUrl = dataUrl.replace(/^data:[^;]+;/i, `data:${mime};`);

        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ dataUrl: normalizedDataUrl }),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to upload project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings } | null;
        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to upload project icon' };
      }
    },

    removeProjectIcon: async (id: string) => {
      try {
        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon`, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json',
          },
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          return { ok: false, error: payload?.error || 'Failed to remove project icon' };
        }

        const payload = (await response.json().catch(() => null)) as { settings?: DesktopSettings } | null;
        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to remove project icon' };
      }
    },

    discoverProjectIcon: async (id: string, options?: { force?: boolean }) => {
      try {
        const response = await runtimeFetch(`/api/projects/${encodeURIComponent(id)}/icon/discover`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ force: options?.force === true }),
        });

        const payload = (await response.json().catch(() => null)) as {
          error?: string;
          skipped?: boolean;
          reason?: string;
          settings?: DesktopSettings;
        } | null;

        if (!response.ok) {
          return { ok: false, error: payload?.error || 'Failed to discover project icon' };
        }

        if (payload?.settings) {
          get().synchronizeFromSettings(payload.settings);
        }

        return {
          ok: true,
          skipped: payload?.skipped === true,
          reason: typeof payload?.reason === 'string' ? payload.reason : undefined,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || 'Failed to discover project icon' };
      }
    },

    reorderProjects: (fromIndex: number, toIndex: number) => {
      const { projects, activeProjectId } = get();
      if (
        fromIndex < 0 ||
        fromIndex >= projects.length ||
        toIndex < 0 ||
        toIndex >= projects.length ||
        fromIndex === toIndex
      ) {
        return;
      }

      const nextProjects = [...projects];
      const [moved] = nextProjects.splice(fromIndex, 1);
      nextProjects.splice(toIndex, 0, moved);

      const newOrder = nextProjects.map((p) => p.id);
      set({ projects: nextProjects, manualProjectOrder: newOrder });
      void persistProjects(nextProjects, activeProjectId, newOrder);
    },

    resetForRuntimeSwitch: () => {
      activeProjectSelectionGeneration += 1;
      const projects = readPersistedProjects();
      const activeProjectId = readPersistedActiveProjectId();
      const nextActiveProjectId = projects.some((project) => project.id === activeProjectId)
        ? activeProjectId
        : null;
      set({ projects, activeProjectId: nextActiveProjectId, manualProjectOrder: [] });
    },

    synchronizeFromSettings: (settings: DesktopSettings) => {
      const incomingProjects = sanitizeProjects(settings.projects ?? []);
      const requestedActive = typeof settings.activeProjectId === 'string' && settings.activeProjectId.trim()
        ? settings.activeProjectId.trim()
        : null;
      const incomingActive = requestedActive && incomingProjects.some((project) => project.id === requestedActive)
        ? requestedActive
        : null;

      const current = get();

      const projectsChanged = JSON.stringify(current.projects) !== JSON.stringify(incomingProjects);
      const activeChanged = current.activeProjectId !== incomingActive;

      if (!projectsChanged && !activeChanged) {
        return;
      }

      const incomingIds = new Set(incomingProjects.map((p) => p.id));
      const cleanedOrder = get().manualProjectOrder.filter((id) => incomingIds.has(id));
      set({ projects: incomingProjects, activeProjectId: incomingActive, manualProjectOrder: cleanedOrder });
      cacheProjects(incomingProjects, incomingActive);
      persistManualProjectOrder(cleanedOrder);

      if (incomingActive) {
        const activeProject = incomingProjects.find((project) => project.id === incomingActive);
        if (activeProject) {
          useDirectoryStore.getState().setDirectory(activeProject.path, { showOverlay: false });
        }
      } else if (activeChanged) {
        void useDirectoryStore.getState().goHome();
      }
    },

    getActiveProject: () => {
      const { projects, activeProjectId } = get();
      if (!activeProjectId) {
        return null;
      }
      return projects.find((project) => project.id === activeProjectId) ?? null;
    },

  }), { name: 'projects-store' })
);

if (typeof window !== 'undefined') {
  window.addEventListener('varin:settings-synced', (event: Event) => {
    const detail = (event as CustomEvent<DesktopSettings>).detail;
    if (detail && typeof detail === 'object') {
      useProjectsStore.getState().synchronizeFromSettings(detail);
    }
  });
}
