import { createRealpathCache } from '../path-realpath-cache.js';

// Browser transport percent-encodes directory hints and marks them explicitly.
// Only marked values are decoded so literal percent sequences from direct API
// clients are preserved.
const safeDecodeMarkedURIComponent = (value: string, encoding: unknown): string => {
  if (encoding !== 'uri') return value;
  try { return decodeURIComponent(value); } catch { return value; }
};

interface ProjectEntry { id: string; path: string; source?: import('@varin/application-client').ProjectSourceBinding }
type SettingsDocument = Record<string, unknown>;

export interface ProjectDirectoryRequest {
  get?(name: string): string | null | undefined;
  query?: { directory?: string | string[] | undefined } | undefined;
}

export type DirectoryValidationResult =
  | { directory: string; ok: true }
  | { error: string; ok: false };
export interface DirectoryResolutionResult {
  directory: string | null;
  error: string | null;
}

export interface ProjectDirectoryDependencies {
  fsPromises: {
    realpath(value: string): Promise<string>;
    stat(value: string): Promise<Pick<import('node:fs').Stats, 'isDirectory'>>;
  };
  getReadSettingsFromDisk?: (() => (() => Promise<SettingsDocument>)) | undefined;
  normalizeDirectoryPath(value: string): string;
  path: Pick<typeof import('node:path'), 'resolve'>;
  readSettingsFromDisk(): Promise<SettingsDocument>;
  sanitizeProjects(value: unknown): ProjectEntry[] | undefined;
}

const errorCode = (error: unknown): string | undefined => (
  error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
);

export const createProjectDirectoryRuntime = (dependencies: ProjectDirectoryDependencies) => {
  const {
    fsPromises,
    path,
    normalizeDirectoryPath,
    readSettingsFromDisk,
    getReadSettingsFromDisk,
    sanitizeProjects,
  } = dependencies;
  const realpathCache = createRealpathCache({
    realpath: fsPromises.realpath.bind(fsPromises),
  });

  const resolveDirectoryCandidate = (value: unknown): string | null => {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = normalizeDirectoryPath(trimmed);
    return path.resolve(normalized);
  };

  const validateDirectoryPath = async (candidate: unknown): Promise<DirectoryValidationResult> => {
    const resolved = resolveDirectoryCandidate(candidate);
    if (!resolved) {
      return { ok: false, error: 'Directory parameter is required' };
    }
    try {
      const stats = await fsPromises.stat(resolved);
      if (!stats.isDirectory()) {
        return { ok: false, error: 'Specified path is not a directory' };
      }
      const realPath = await realpathCache.resolve(resolved);
      return { ok: true, directory: realPath };
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return { ok: false, error: 'Directory not found' };
      }
      if (errorCode(error) === 'EACCES') {
        return { ok: false, error: 'Access to directory denied' };
      }
      return { ok: false, error: 'Failed to validate directory' };
    }
  };

  const requestedDirectories = (req: ProjectDirectoryRequest): string[] => {
    const rawHeaderDirectory = typeof req.get === 'function' ? req.get('x-varin-directory') : null;
    const headerEncoding = typeof req.get === 'function' ? req.get('x-varin-directory-encoding') : null;
    const headerDirectory = rawHeaderDirectory ? safeDecodeMarkedURIComponent(rawHeaderDirectory, headerEncoding) : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    return [headerDirectory, queryDirectory]
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
  };

  const resolveProjectDirectory = async (req: ProjectDirectoryRequest): Promise<DirectoryResolutionResult> => {
    const requested = requestedDirectories(req);

    if (requested.length > 0) {
      let lastError: string | null = null;
      for (const candidate of requested) {
        const validated = await validateDirectoryPath(candidate);
        if (validated.ok) {
          return { directory: validated.directory, error: null };
        }
        lastError = validated.error;
      }
      return { directory: null, error: lastError };
    }

    const readSettings = typeof getReadSettingsFromDisk === 'function'
      ? getReadSettingsFromDisk()
      : readSettingsFromDisk;
    const settings = await readSettings();

    // `lastDirectory` reflects the directory the UI is currently browsing —
    // useDirectoryStore.setDirectory() persists it on every navigation.
    // Prefer it over activeProjectId, because the user may have navigated
    // away from the project that was last "clicked" in the sidebar (e.g. via
    // `go to parent`, directory picker, or a deep link), leaving
    // activeProjectId stale. Fetches scoped to the stale project would 400
    // with "Path is outside of active workspace".
    if (typeof settings.lastDirectory === 'string' && settings.lastDirectory.trim()) {
      const validated = await validateDirectoryPath(settings.lastDirectory);
      if (validated.ok) {
        return { directory: validated.directory, error: null };
      }
    }

    const projects = (sanitizeProjects(settings.projects) || []).filter(project => project.source?.resourceOwner.kind !== 'managed_host');
    if (projects.length === 0) {
      return { directory: null, error: 'Directory parameter or active project is required' };
    }

    const activeId = typeof settings.activeProjectId === 'string' ? settings.activeProjectId : '';
    const active = projects.find((project) => project.id === activeId) || projects[0];
    if (!active || !active.path) {
      return { directory: null, error: 'Directory parameter or active project is required' };
    }

    const validated = await validateDirectoryPath(active.path);
    if (!validated.ok) {
      return { directory: null, error: validated.error };
    }

    return { directory: validated.directory, error: null };
  };

  const resolveOptionalProjectDirectory = async (req: ProjectDirectoryRequest): Promise<DirectoryResolutionResult> => {
    const requested = requestedDirectories(req);

    if (requested.length === 0) {
      return { directory: null, error: null };
    }

    let lastError: string | null = null;
    for (const candidate of requested) {
      const validated = await validateDirectoryPath(candidate);
      if (validated.ok) {
        return { directory: validated.directory, error: null };
      }
      lastError = validated.error;
    }
    return { directory: null, error: lastError };
  };

  return {
    resolveDirectoryCandidate,
    validateDirectoryPath,
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
  };
};
