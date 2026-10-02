import {
  createSettingsFileStore,
  type VarinSettingsDocument,
  type SettingsFileStore,
  type SettingsFileStoreOptions,
} from '@varin/settings-store';
import { randomUUID } from 'node:crypto';
import { projectFolders, projectPathKey } from '@varin/application-client';

interface ProjectEntry extends Record<string, unknown> {
  id: string;
  path: string;
  additionalPaths?: string[];
}

interface ManagedTunnelPreset {
  hostname: string;
  id: string;
  name: string;
}

interface ManagedTunnelTokenUpdate extends ManagedTunnelPreset {
  token: string;
}

export interface SettingsRuntimeDependencies {
  SETTINGS_FILE_PATH: string;
  formatSettingsResponse(settings: VarinSettingsDocument): VarinSettingsDocument;
  fsPromises: NonNullable<SettingsFileStoreOptions['fsPromises']>;
  mergePersistedSettings(
    current: VarinSettingsDocument,
    changes: VarinSettingsDocument,
  ): VarinSettingsDocument;
  normalizeSettingsPaths(settings: VarinSettingsDocument): {
    changed: boolean;
    settings: VarinSettingsDocument;
  };
  path: NonNullable<SettingsFileStoreOptions['pathModule']>;
  sanitizeProjects?: ((projects: unknown) => ProjectEntry[] | undefined) | undefined;
  sanitizeSettingsUpdate(settings: unknown): VarinSettingsDocument;
  settingsStore?: SettingsFileStore | undefined;
  syncManagedRemoteTunnelConfigWithPresets(presets: unknown): Promise<void>;
  upsertManagedRemoteTunnelToken(update: ManagedTunnelTokenUpdate): Promise<void>;
}

export const createSettingsRuntime = (deps: SettingsRuntimeDependencies) => {
  const {
    fsPromises,
    path,
    SETTINGS_FILE_PATH,
    sanitizeSettingsUpdate,
    mergePersistedSettings,
    normalizeSettingsPaths,
    formatSettingsResponse,
    syncManagedRemoteTunnelConfigWithPresets,
    upsertManagedRemoteTunnelToken,
  } = deps;

  const settingsStore = deps.settingsStore ?? createSettingsFileStore({
    filePath: SETTINGS_FILE_PATH,
    fsPromises,
    pathModule: path,
  });
  const listeners = new Set<(settings: VarinSettingsDocument) => void>();
  const notify = (settings: VarinSettingsDocument): void => {
    for (const listener of listeners) {
      try { listener(settings); } catch (error) { console.error('[Settings] Change observer failed:', error); }
    }
  };
  const readSettingsFromDisk = () => settingsStore.read();
  const updateSettingsOnDisk = (
    mutator: Parameters<SettingsFileStore['update']>[0],
  ): Promise<VarinSettingsDocument> => settingsStore.update(mutator).then((settings) => { notify(settings); return settings; });

  const validateProjectEntries = async (projects: unknown, previous: unknown): Promise<ProjectEntry[]> => {
    if (!Array.isArray(projects)) {
      return [];
    }

    const validations = projects.map(async (project): Promise<ProjectEntry | null> => {
      if (!project || typeof project.path !== 'string' || project.path.length === 0) {
        console.warn('[validateProjectEntries] Dropping project entry with missing or empty path');
        return null;
      }
      const existing = Array.isArray(previous) ? previous.find((entry) => entry?.id === project.id) as ProjectEntry | undefined : undefined;
      const known = new Set(existing ? projectFolders(existing).map(projectPathKey) : []);
      for (const directory of projectFolders(project)) {
        // Removing/moving an existing folder must not erase the project on an
        // unrelated metadata save. New selections must name actual folders.
        if (known.has(projectPathKey(directory))) continue;
        const stats = await fsPromises.stat(directory);
        if (!stats.isDirectory()) {
          throw new Error(`Project folder is not a directory: ${directory}`);
        }
      }
      return project;
    });

    return (await Promise.all(validations)).filter((p) => p !== null);
  };

  const applyPersistedChanges = async (
    current: VarinSettingsDocument,
    changes: VarinSettingsDocument,
    removals: readonly string[],
  ): Promise<VarinSettingsDocument> => {
    // Log field names only — changes can carry credentials (UI password,
    // client tokens, tunnel tokens) that must never reach the log file.
    console.log('[persistSettings] Updating fields:', Object.keys(changes || {}).join(', ') || '(none)');
    const sanitized = sanitizeSettingsUpdate(changes);
    if (sanitized.outboundNetwork && typeof sanitized.outboundNetwork === 'object' && !Array.isArray(sanitized.outboundNetwork)) {
      const incoming = sanitized.outboundNetwork as Record<string, unknown>;
      const previous = current.outboundNetwork && typeof current.outboundNetwork === 'object' && !Array.isArray(current.outboundNetwork)
        ? current.outboundNetwork as Record<string, unknown> : null;
      sanitized.outboundNetwork = {
        ...incoming,
        credentialRef: previous && previous.proxyUrl === incoming.proxyUrl && typeof previous.credentialRef === 'string'
          ? previous.credentialRef : randomUUID(),
      };
    }
    const removed = new Set(removals);
    let next = mergePersistedSettings(current, sanitized);
    for (const field of removals) {
      if (Object.prototype.hasOwnProperty.call(next, field)) {
        next = { ...next };
        delete next[field];
      }
    }

      const normalizedState = normalizeSettingsPaths(next);
      if (normalizedState.changed) {
        next = normalizedState.settings;
      }

      // Validating project paths hits the filesystem for every entry, so only
      // do it when the incoming update actually touches the projects list —
      // not on every theme/window-state/etc. save.
      if (Object.prototype.hasOwnProperty.call(sanitized, 'projects') && Array.isArray(next.projects)) {
        const validated = await validateProjectEntries(next.projects, current.projects);
        next = { ...next, projects: validated };
      }

      const nextProjects = Array.isArray(next.projects)
        ? next.projects.filter((project): project is ProjectEntry => (
            Boolean(project) && typeof project === 'object'
            && typeof (project as { id?: unknown }).id === 'string'
            && typeof (project as { path?: unknown }).path === 'string'
          ))
        : [];
      if (nextProjects.length > 0) {
        const activeId = typeof next.activeProjectId === 'string' ? next.activeProjectId : null;
        const active = activeId
          ? nextProjects.find((project) => project.id === activeId) || null
          : null;
        if (activeId && !active) {
          console.log(`[persistSettings] Active project ID ${activeId} not found, clearing the workspace selection`);
          next = { ...next, activeProjectId: null };
        }
      } else if (typeof next.activeProjectId === 'string') {
        console.log(`[persistSettings] No projects found, clearing activeProjectId ${next.activeProjectId}`);
        next = { ...next, activeProjectId: null };
      }

      if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresets')
        || removed.has('managedRemoteTunnelPresets')) {
        await syncManagedRemoteTunnelConfigWithPresets(next.managedRemoteTunnelPresets);
      }

      if (Object.prototype.hasOwnProperty.call(sanitized, 'managedRemoteTunnelPresetTokens') && sanitized.managedRemoteTunnelPresetTokens) {
        const presets = Array.isArray(next.managedRemoteTunnelPresets)
          ? next.managedRemoteTunnelPresets.filter((entry): entry is ManagedTunnelPreset => (
              Boolean(entry) && typeof entry === 'object'
              && typeof (entry as { id?: unknown }).id === 'string'
              && typeof (entry as { name?: unknown }).name === 'string'
              && typeof (entry as { hostname?: unknown }).hostname === 'string'
            ))
          : [];
        const presetsById = new Map(presets.map((entry) => [entry.id, entry]));
        const updates = Object.entries(sanitized.managedRemoteTunnelPresetTokens)
          .map(([presetId, token]) => {
            const preset = presetsById.get(presetId);
            if (!preset || typeof token !== 'string' || token.trim().length === 0) {
              return null;
            }
            return {
              id: preset.id,
              name: preset.name,
              hostname: preset.hostname,
              token: token.trim(),
            };
          })
          .filter((entry): entry is ManagedTunnelTokenUpdate => Boolean(entry));

        for (const update of updates) {
          await upsertManagedRemoteTunnelToken(update);
        }
      }

      return next;
  };

  const persistSettings = async (
    changes: VarinSettingsDocument,
  ): Promise<VarinSettingsDocument> => {
    const next = await updateSettingsOnDisk((current) => applyPersistedChanges(current, changes, []));
    return formatSettingsResponse(next);
  };

  /**
   * CAS variant for the agent-facing settings service (D-306): the caller's
   * expectedRevision is checked inside the store lock so concurrent UI writes
   * are never silently overwritten. `null` revision signals a conflict — the
   * document is left untouched.
   */
  const persistSettingsCas = async (
    changes: VarinSettingsDocument,
    removals: readonly string[],
    expectedRevision: string | undefined,
    revisionOf: (document: VarinSettingsDocument) => string,
  ): Promise<{ conflict: boolean; document: VarinSettingsDocument; revision: string }> => {
    const result = await settingsStore.transact(async (current): Promise<{
      document?: VarinSettingsDocument;
      write?: boolean;
      result: { conflict: boolean; document: VarinSettingsDocument; revision: string };
    }> => {
      const revision = revisionOf(current);
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        return { write: false, result: { conflict: true, document: current, revision } };
      }
      const next = await applyPersistedChanges(current, changes, removals);
      return {
        document: next,
        result: { conflict: false, document: next, revision: revisionOf(next) },
      };
    });
    if (!result.conflict) notify(result.document);
    return result;
  };

  return {
    readSettingsFromDisk,
    updateSettingsOnDisk,
    persistSettings,
    persistSettingsCas,
    subscribe: (listener: (settings: VarinSettingsDocument) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};
