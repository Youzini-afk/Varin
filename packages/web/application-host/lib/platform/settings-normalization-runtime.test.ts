import { describe, expect, it } from 'vitest';

import {
  createSettingsNormalizationRuntime,
  type SettingsNormalizationDependencies,
  type SettingsPathModule,
} from './settings-normalization-runtime.js';

type TestRuntimeOverrides = Omit<Partial<SettingsNormalizationDependencies>, 'path'> & {
  path?: Partial<SettingsPathModule> | undefined;
};

const createTestRuntime = (overrides: TestRuntimeOverrides = {}) => {
  const defaultPath: SettingsPathModule = {
    resolve: (...args: string[]) => args.at(-1) ?? '',
    join: (...args: string[]) => args.join('/'),
    posix: { isAbsolute: (value: string) => value.startsWith('/') },
    sep: '/',
    dirname: (value: string) => value.split('/').slice(0, -1).join('/') || '/',
  };
  const defaults: SettingsNormalizationDependencies = {
    os: { homedir: () => '/home/testuser' },
    path: defaultPath,
    processLike: { platform: 'linux', env: {} },
    realpathSync: (value: string) => value,
    tunnelBootstrapTtlDefaultMs: 600000,
    tunnelBootstrapTtlMinMs: 60000,
    tunnelBootstrapTtlMaxMs: 3600000,
    tunnelSessionTtlDefaultMs: 86400000,
    tunnelSessionTtlMinMs: 3600000,
    tunnelSessionTtlMaxMs: 604800000,
  };

  return createSettingsNormalizationRuntime({
    ...defaults,
    ...overrides,
    path: { ...defaultPath, ...overrides.path },
  });
};

const requireValue = <T>(value: T | null | undefined, label: string): T => {
  if (value === null || value === undefined) throw new Error(`${label} is required`);
  return value;
};

describe('settings normalization runtime - symlink resolution', () => {
  describe('normalizePathForPersistence', () => {
    it('resolves symlinks via realpathSync', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) =>
          p === '/home/user/workplace' ? '/workplace/user' : p,
      });

      const result = runtime.normalizePathForPersistence('/home/user/workplace');
      expect(result).toBe('/workplace/user');
    });

    it('falls back to original path when realpathSync throws', () => {
      const runtime = createTestRuntime({
        realpathSync: () => {
          throw new Error('ENOENT');
        },
      });

      const result = runtime.normalizePathForPersistence('/nonexistent/path');
      expect(result).toBe('/nonexistent/path');
    });

    it('passes through when realpathSync is not provided', () => {
      const runtime = createTestRuntime({ realpathSync: undefined });

      const result = runtime.normalizePathForPersistence('/some/path');
      expect(result).toBe('/some/path');
    });

    it('preserves lowercase colon-prefixed paths on non-Windows platforms', () => {
      const runtime = createTestRuntime({ realpathSync: undefined });

      expect(runtime.normalizePathForPersistence('c:project')).toBe('c:project');
    });

    it('uppercases Windows drive letter before and after realpath resolution', () => {
      const runtime = createTestRuntime({
        processLike: { platform: 'win32', env: {} },
        realpathSync: (p) => {
          // Simulate safeRealpathSync returning a lowercase drive letter
          if (p === 'C:\\Users\\me\\project') return 'c:\\real\\project';
          return p;
        },
      });

      const result = runtime.normalizePathForPersistence('c:\\Users\\me\\project');
      // Drive letter uppercased on input AND after realpath
      expect(result).toBe('C:\\real\\project');
    });
  });

  describe('sanitizeProjects', () => {
    it('preserves project identity and canonicalizes each selected folder independently', () => {
      const runtime = createTestRuntime({ realpathSync: (value) => value.replace('/alias/', '/actual/') });
      const result = runtime.sanitizeProjects([{ id: 'project_collection', path: '/alias/app',
        additionalPaths: ['/alias/docs', '/actual/app', '/other/library'], label: 'Product' }]);
      expect(result).toEqual([{ id: 'project_collection', path: '/actual/app', additionalPaths: ['/actual/docs', '/other/library'], label: 'Product' }]);
    });
    it('resolves symlinks in project paths', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) =>
          p === '/home/user/workplace/MyProject'
            ? '/workplace/user/MyProject'
            : p,
      });

      const projects = [
        { id: 'proj1', path: '/home/user/workplace/MyProject', label: 'MyProject', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(requireValue(result?.[0], 'Sanitized project').path).toBe('/workplace/user/MyProject');
      expect(requireValue(result?.[0], 'Sanitized project').id).toBe('proj1');
    });

    it('falls back to path.resolve when realpathSync throws', () => {
      const runtime = createTestRuntime({
        realpathSync: () => { throw new Error('ENOENT'); },
        path: { resolve: (p) => '/resolved' + p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const projects = [
        { id: 'proj1', path: '/missing/path', label: 'Missing', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(requireValue(result?.[0], 'Sanitized project').path).toBe('/resolved/missing/path');
    });

    it('keeps distinct project identities when they share a folder', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) => p.startsWith('/symlink') ? '/real/project' : p,
        path: { resolve: (p) => p, sep: '/', dirname: (p) => p.split('/').slice(0, -1).join('/') || '/' },
      });

      const projects = [
        { id: 'proj1', path: '/symlink/a', label: 'A', color: 'primary', addedAt: 1000, lastOpenedAt: 1000 },
        { id: 'proj2', path: '/symlink/b', label: 'B', color: 'keyword', addedAt: 2000, lastOpenedAt: 2000 },
      ];

      const result = runtime.sanitizeProjects(projects);
      expect(result?.map((project) => [project.id, project.path])).toEqual([['proj1', '/real/project'], ['proj2', '/real/project']]);
    });
  });

  describe('normalizeSettingsPaths', () => {
    it('resolves symlinks in lastDirectory', () => {
      const runtime = createTestRuntime({
        realpathSync: (p) =>
          p === '/home/user/workplace/LyraRefactoring'
            ? '/workplace/user/LyraRefactoring'
            : p,
      });

      const result = runtime.normalizeSettingsPaths({
        lastDirectory: '/home/user/workplace/LyraRefactoring',
      });

      expect(result.changed).toBe(true);
      expect(result.settings.lastDirectory).toBe('/workplace/user/LyraRefactoring');
    });

    it('does not flag as changed when path is already canonical', () => {
      const runtime = createTestRuntime();

      const result = runtime.normalizeSettingsPaths({
        lastDirectory: '/real/path',
      });

      expect(result.changed).toBe(false);
    });
  });
});
