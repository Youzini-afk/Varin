import { projectFolders } from '@varin/application-client';

export interface SettingsPathModule {
  dirname(value: string): string;
  join(...segments: string[]): string;
  posix: { isAbsolute(value: string): boolean };
  resolve(...segments: string[]): string;
  sep: string;
}

export interface SettingsNormalizationDependencies {
  os: { homedir(): string };
  path: SettingsPathModule;
  processLike: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform };
  realpathSync?: ((value: string) => string) | undefined;
  tunnelBootstrapTtlDefaultMs: number;
  tunnelBootstrapTtlMaxMs: number;
  tunnelBootstrapTtlMinMs: number;
  tunnelSessionTtlDefaultMs: number;
  tunnelSessionTtlMaxMs: number;
  tunnelSessionTtlMinMs: number;
}

export interface NormalizedProject extends Record<string, unknown> {
  id: string;
  path: string;
  additionalPaths?: string[];
}

export const createSettingsNormalizationRuntime = (dependencies: SettingsNormalizationDependencies) => {
  const {
    os,
    path,
    processLike,
    realpathSync,
    tunnelBootstrapTtlDefaultMs,
    tunnelBootstrapTtlMinMs,
    tunnelBootstrapTtlMaxMs,
    tunnelSessionTtlDefaultMs,
    tunnelSessionTtlMinMs,
    tunnelSessionTtlMaxMs,
  } = dependencies;

  const normalizeDirectoryPath = <T>(value: T): T | string => {
    if (typeof value !== 'string') {
      return value;
    }

    let trimmed = value.trim();
    // Paths pasted from Windows "Copy as path" (or quoted shell snippets)
    // arrive wrapped in quotes — a literal quote character can never be part
    // of a real path, and it breaks every fs.stat/executable check.
    if (trimmed.length >= 2
      && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
        || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
      trimmed = trimmed.slice(1, -1).trim();
    }
    if (!trimmed) {
      return trimmed;
    }

    if (trimmed === '~') {
      return os.homedir();
    }

    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
      return path.join(os.homedir(), trimmed.slice(2));
    }

    return trimmed;
  };

  // Resolve symlinks, falling back to the original value on failure.
  const safeRealpathSync = <T>(value: T): T | string => {
    if (!realpathSync || typeof value !== 'string' || !value) {
      return value;
    }
    try {
      return realpathSync(value);
    } catch {
      return value;
    }
  };

  const normalizePathForPersistence = <T>(
    value: T,
    options: { resolveRealpath?: boolean | undefined } = {},
  ): T | string => {
    if (typeof value !== 'string') {
      return value;
    }

    const normalized = normalizeDirectoryPath(value);
    if (typeof normalized !== 'string') {
      return normalized;
    }

    const trimmed = normalized.trim();
    if (!trimmed) {
      return trimmed;
    }

    // Normalize Windows drive letter to uppercase to ensure consistent
    // case across all path representations on Windows. NTFS is case-insensitive
    // but case-preserving, so a path like "c:\\Users\\..." and "C:\\Users\\..."
    // would be stored differently in settings.json across sessions.
    const uppercaseDriveLetter = (value: string): string =>
      value.replace(/^([a-z]):/, (_match: string, letter: string) => letter.toUpperCase() + ':');

    const isWindows = processLike.platform === 'win32';
    const caseNormalized = isWindows ? uppercaseDriveLetter(trimmed) : trimmed;
    const resolved = options.resolveRealpath === false ? caseNormalized : safeRealpathSync(caseNormalized);

    // Re-normalize after realpath — safeRealpathSync may return a
    // lowercase drive letter on some Windows environments.
    const finalResolved = isWindows && typeof resolved === 'string'
      ? uppercaseDriveLetter(resolved)
      : resolved;

    if (!isWindows) {
      return finalResolved;
    }

    return finalResolved.replace(/\//g, '\\');
  };

  const areStringArraysEqual = (a: unknown, b: unknown): boolean => {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return false;
    }
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  };

  const normalizeStringArray = (input: unknown): string[] => {
    if (!Array.isArray(input)) {
      return [];
    }
    return Array.from(
      new Set(
        input.filter((entry) => typeof entry === 'string' && entry.length > 0)
      )
    );
  };

  const sanitizeProjects = (input: unknown): NormalizedProject[] | undefined => {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const hexColorPattern = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;
    const normalizeIconBackground = (value: unknown): string | null => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      return hexColorPattern.test(trimmed) ? trimmed.toLowerCase() : null;
    };

    const result: NormalizedProject[] = [];
    const seenIds = new Set<string>();

    for (const entry of input) {
      if (!entry || typeof entry !== 'object') continue;

      const candidate = entry as Record<string, unknown>;
      const rawPath = typeof candidate.path === 'string' ? candidate.path.trim() : '';
      const resolvedPath = rawPath ? safeRealpathSync(path.resolve(normalizeDirectoryPath(rawPath))) : '';
      const normalizedPath = resolvedPath ? normalizePathForPersistence(resolvedPath, { resolveRealpath: false }) : '';
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const additionalPaths = projectFolders({ path: normalizedPath, additionalPaths: Array.isArray(candidate.additionalPaths)
        ? candidate.additionalPaths.filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
          .map((value) => normalizePathForPersistence(safeRealpathSync(path.resolve(normalizeDirectoryPath(value))), { resolveRealpath: false }))
        : [] }).slice(1);
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
      const icon = typeof candidate.icon === 'string' ? candidate.icon.trim() : '';
      const iconImage = candidate.iconImage && typeof candidate.iconImage === 'object' && !Array.isArray(candidate.iconImage)
        ? candidate.iconImage as Record<string, unknown>
        : null;
      const iconBackground = normalizeIconBackground(candidate.iconBackground);
      const color = typeof candidate.color === 'string' ? candidate.color.trim() : '';
      const defaultModel = typeof candidate.defaultModel === 'string' ? candidate.defaultModel.trim() : '';
      const defaultWorkFocus = candidate.defaultWorkFocus === 'code' || candidate.defaultWorkFocus === 'research'
        ? candidate.defaultWorkFocus
        : null;
      const addedAt = typeof candidate.addedAt === 'number' && Number.isFinite(candidate.addedAt)
        ? candidate.addedAt
        : null;
      const lastOpenedAt = typeof candidate.lastOpenedAt === 'number' && Number.isFinite(candidate.lastOpenedAt)
        ? candidate.lastOpenedAt
        : null;

      if (!/^[a-zA-Z0-9_-]+$/.test(id) || !normalizedPath) continue;
      if (seenIds.has(id)) continue;

      seenIds.add(id);

      const project: NormalizedProject = {
        id,
        path: normalizedPath,
        ...(additionalPaths.length ? { additionalPaths } : {}),
        ...(label ? { label } : {}),
        ...(icon ? { icon } : {}),
        ...(iconBackground ? { iconBackground } : {}),
        ...(color ? { color } : {}),
        ...(defaultModel && defaultModel.includes('/') ? { defaultModel } : {}),
        ...(defaultWorkFocus ? { defaultWorkFocus } : {}),
        ...(addedAt !== null && addedAt >= 0 ? { addedAt } : {}),
        ...(lastOpenedAt !== null && lastOpenedAt >= 0 ? { lastOpenedAt } : {}),
      };

      if (candidate.iconImage === null) {
        project.iconImage = null;
      } else if (iconImage) {
        const mime = typeof iconImage.mime === 'string' ? iconImage.mime.trim() : '';
        const updatedAt = typeof iconImage.updatedAt === 'number' && Number.isFinite(iconImage.updatedAt)
          ? Math.max(0, Math.round(iconImage.updatedAt))
          : 0;
        const source = iconImage.source === 'custom' || iconImage.source === 'auto'
          ? iconImage.source
          : null;
        if (mime && updatedAt > 0 && source) {
          project.iconImage = { mime, updatedAt, source };
        }
      }

      if (candidate.iconBackground === null) {
        project.iconBackground = null;
      }

      if (typeof candidate.sidebarCollapsed === 'boolean') {
        project.sidebarCollapsed = candidate.sidebarCollapsed;
      }

      result.push(project);
    }

    return result;
  };

  const normalizeSettingsPaths = (input: unknown): { settings: Record<string, unknown>; changed: boolean } => {
    const settings: Record<string, unknown> = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    let next = settings;
    let changed = false;

    const ensureNext = () => {
      if (next === settings) {
        next = { ...settings };
      }
    };

    const normalizePathField = (key: string): void => {
      if (typeof settings[key] !== 'string' || settings[key].length === 0) {
        return;
      }
      const normalized = normalizePathForPersistence(settings[key]);
      if (normalized !== settings[key]) {
        ensureNext();
        next[key] = normalized;
        changed = true;
      }
    };

    const normalizePathArrayField = (key: string): void => {
      if (!Array.isArray(settings[key])) {
        return;
      }

      const normalized = normalizeStringArray(
        settings[key]
          .map((entry) => (typeof entry === 'string' ? normalizePathForPersistence(entry) : entry))
          .filter((entry) => typeof entry === 'string' && entry.length > 0)
      );

      if (!areStringArraysEqual(normalized, settings[key])) {
        ensureNext();
        next[key] = normalized;
        changed = true;
      }
    };

    normalizePathField('lastDirectory');
    normalizePathField('homeDirectory');
    normalizePathArrayField('pinnedDirectories');

    if (Array.isArray(settings.projects)) {
      const normalizedProjects = sanitizeProjects(settings.projects) || [];
      if (JSON.stringify(normalizedProjects) !== JSON.stringify(settings.projects)) {
        ensureNext();
        next.projects = normalizedProjects;
        changed = true;
      }
    }

    return { settings: next, changed };
  };

  const clampNumber = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

  const normalizeTunnelBootstrapTtlMs = (value: unknown): number | null => {
    if (value === null) {
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return tunnelBootstrapTtlDefaultMs;
    }
    return clampNumber(Math.round(value), tunnelBootstrapTtlMinMs, tunnelBootstrapTtlMaxMs);
  };

  const normalizeTunnelSessionTtlMs = (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return tunnelSessionTtlDefaultMs;
    }
    return clampNumber(Math.round(value), tunnelSessionTtlMinMs, tunnelSessionTtlMaxMs);
  };

  const normalizeManagedRemoteTunnelHostname = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = (() => {
      try {
        if (trimmed.includes('://')) {
          return new URL(trimmed);
        }
        return new URL(`https://${trimmed}`);
      } catch {
        return null;
      }
    })();

    const hostname = parsed?.hostname?.trim().toLowerCase() || '';
    if (!hostname) {
      return undefined;
    }
    return hostname;
  };

  const normalizeManagedRemoteTunnelPresets = (value: unknown): Array<{ id: string; name: string; hostname: string }> | undefined => {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const result = [];
    const seenIds = new Set();
    const seenHostnames = new Set();

    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      const hostname = normalizeManagedRemoteTunnelHostname(candidate.hostname);
      if (!id || !name || !hostname) continue;
      if (seenIds.has(id) || seenHostnames.has(hostname)) continue;
      seenIds.add(id);
      seenHostnames.add(hostname);
      result.push({ id, name, hostname });
    }

    return result;
  };

  const normalizeManagedRemoteTunnelPresetTokens = (value: unknown): Record<string, string> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    const result: Record<string, string> = {};
    for (const [rawId, rawToken] of Object.entries(value)) {
      const id = typeof rawId === 'string' ? rawId.trim() : '';
      const token = typeof rawToken === 'string' ? rawToken.trim() : '';
      if (!id || !token) {
        continue;
      }
      result[id] = token;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  };

  const isUnsafeSkillRelativePath = (value: unknown): boolean => {
    if (typeof value !== 'string' || value.length === 0) {
      return true;
    }

    const normalized = value.replace(/\\/g, '/');
    if (path.posix.isAbsolute(normalized)) {
      return true;
    }

    return normalized.split('/').some((segment) => segment === '..');
  };

  const sanitizeTypographySizesPartial = (input: unknown): Record<string, string> | undefined => {
    if (!input || typeof input !== 'object') {
      return undefined;
    }
    const candidate = input as Record<string, unknown>;
    const result: Record<string, string> = {};
    let populated = false;

    const assign = (key: string): void => {
      if (typeof candidate[key] === 'string' && candidate[key].length > 0) {
        result[key] = candidate[key];
        populated = true;
      }
    };

    assign('markdown');
    assign('code');
    assign('uiHeader');
    assign('uiLabel');
    assign('meta');
    assign('micro');

    return populated ? result : undefined;
  };

  const sanitizeModelRefs = (
    input: unknown,
    limit: number,
  ): Array<{ providerID: string; modelID: string }> | undefined => {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const result = [];
    const seen = new Set();

    for (const entry of input) {
      if (!entry || typeof entry !== 'object') continue;
      const candidate = entry as Record<string, unknown>;
      const providerID = typeof candidate.providerID === 'string' ? candidate.providerID.trim() : '';
      const modelID = typeof candidate.modelID === 'string' ? candidate.modelID.trim() : '';
      if (!providerID || !modelID) continue;
      const key = `${providerID}/${modelID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ providerID, modelID });
      if (result.length >= limit) break;
    }

    return result;
  };

  const sanitizeSkillCatalogs = (input: unknown): Array<Record<string, string>> | undefined => {
    if (!Array.isArray(input)) {
      return undefined;
    }

    const result = [];
    const seen = new Set();

    for (const entry of input) {
      if (!entry || typeof entry !== 'object') continue;

      const candidate = entry as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
      const source = typeof candidate.source === 'string' ? candidate.source.trim() : '';
      const subpath = typeof candidate.subpath === 'string' ? candidate.subpath.trim() : '';
      const gitIdentityId = typeof candidate.gitIdentityId === 'string' ? candidate.gitIdentityId.trim() : '';

      if (!id || !label || !source) continue;
      if (seen.has(id)) continue;
      seen.add(id);

      result.push({
        id,
        label,
        source,
        ...(subpath ? { subpath } : {}),
        ...(gitIdentityId ? { gitIdentityId } : {}),
      });
    }

    return result;
  };

  return {
    normalizeDirectoryPath,
    normalizePathForPersistence,
    normalizeSettingsPaths,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    normalizeManagedRemoteTunnelHostname,
    normalizeManagedRemoteTunnelPresets,
    normalizeManagedRemoteTunnelPresetTokens,
    isUnsafeSkillRelativePath,
    sanitizeTypographySizesPartial,
    normalizeStringArray,
    sanitizeModelRefs,
    sanitizeSkillCatalogs,
    sanitizeProjects,
  };
};
