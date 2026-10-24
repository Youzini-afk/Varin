import type {
  DirectoryListResult,
  FileSearchQuery,
  FileSearchResult,
  FilesAPI,
} from '@varin/application-client';
import {
  FilesystemError,
  parseFilesystemErrorReason,
} from '@varin/application-client';
import { runtimeFetch } from '@varin/application-client';

const normalizePath = (path: string): string => path.replace(/\\/g, '/');

interface WebFilesAPIOptions {
  urls?: unknown;
  getDirectory?: () => string | undefined;
}

type WebDirectoryEntry = {
  name?: string;
  path?: string;
  isDirectory?: boolean;
  isFile?: boolean;
  isSymbolicLink?: boolean;
};

type WebDirectoryListResponse = {
  directory?: string;
  path?: string;
  entries?: WebDirectoryEntry[];
};

const toDirectoryListResult = (fallbackDirectory: string, payload: WebDirectoryListResponse): DirectoryListResult => {
  if (!payload || !Array.isArray(payload.entries)) {
    throw new FilesystemError('Directory listing returned an invalid response', {
      reason: 'invalid-response',
    });
  }
  const directory = normalizePath(payload?.directory || payload?.path || fallbackDirectory);

  return {
    directory,
    entries: payload.entries
      .filter((entry): entry is Required<Pick<WebDirectoryEntry, 'name' | 'path'>> & { isDirectory?: boolean } =>
        Boolean(entry && typeof entry.name === 'string' && typeof entry.path === 'string')
      )
      .map((entry) => ({
        name: entry.name,
        path: normalizePath(entry.path),
        isDirectory: Boolean(entry.isDirectory),
      })),
  };
};

const directoryHeaders = (getDirectory?: () => string | undefined, override?: string): Record<string, string> | undefined => {
  const directory = override || getDirectory?.();
  return directory ? { 'x-varin-directory': directory } : undefined;
};

export const createWebFilesAPI = ({ getDirectory }: WebFilesAPIOptions): FilesAPI => ({
  async readOffice(path, input, options) {
    const params = new URLSearchParams({ path });
    for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value));
    if (options?.outsideFileGrant) params.set('outsideFileGrant', options.outsideFileGrant);
    const response = await runtimeFetch(`/api/fs/office?${params}`, { headers: directoryHeaders(getDirectory, options?.directory), signal: options?.signal });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      throw new Error((failure as { error?: string }).error || `Office reading failed (${response.status})`);
    }
    return response.json();
  },
  async getHomeDirectory(): Promise<string> {
    const response = await runtimeFetch('/api/fs/home', {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to resolve home directory');
    }

    const result = await response.json().catch(() => ({}));
    const home = typeof (result as { home?: unknown }).home === 'string'
      ? (result as { home: string }).home.trim()
      : '';
    if (!home) {
      throw new Error('Failed to resolve home directory');
    }
    return normalizePath(home);
  },

  async listDirectory(path: string, options): Promise<DirectoryListResult> {
    const target = normalizePath(path);
    const params = new URLSearchParams();
    if (target) {
      params.set('path', target);
    }
    if (options?.respectGitignore) {
      params.set('respectGitignore', 'true');
    }

    const response = await runtimeFetch('/api/fs/list', {
      query: params,
      headers: directoryHeaders(getDirectory),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText })) as {
        error?: string;
        reason?: unknown;
      };
      throw new FilesystemError(error.error || 'Failed to list directory', {
        reason: parseFilesystemErrorReason(error.reason),
        status: response.status,
      });
    }

    const result = (await response.json()) as WebDirectoryListResponse;
    return toDirectoryListResult(target, result);
  },

  async search(payload: FileSearchQuery, options?: { signal?: AbortSignal }): Promise<FileSearchResult[]> {
    const params = new URLSearchParams();

    const directory = normalizePath(payload.directory);
    if (directory) {
      params.set('directory', directory);
    }

    params.set('query', payload.query);
    params.set('dirs', 'false');
    params.set('type', 'file');

    if (typeof payload.maxResults === 'number' && Number.isFinite(payload.maxResults)) {
      params.set('limit', String(payload.maxResults));
    }

    const response = await runtimeFetch('/api/find/file', {
      query: params,
      headers: directoryHeaders(getDirectory),
      signal: options?.signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText })) as {
        error?: string;
        reason?: unknown;
      };
      throw new FilesystemError(error.error || 'Failed to search files', {
        reason: parseFilesystemErrorReason(error.reason),
        status: response.status,
      });
    }

    const result = (await response.json()) as string[];
    const files = Array.isArray(result) ? result : [];

    return files.map((relativePath) => ({
      path: normalizePath(`${directory}/${relativePath}`),
      preview: [normalizePath(relativePath)],
    }));
  },

  async createDirectory(path: string, options): Promise<{ success: boolean; path: string }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({
        path: target,
        allowOutsideWorkspace: options?.allowOutsideWorkspace === true,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to create directory');
    }

    const result = await response.json();
    return {
      success: Boolean(result?.success),
      path: typeof result?.path === 'string' ? normalizePath(result.path) : target,
    };
  },

  async statFile(path: string, options): Promise<{ path: string; isFile: boolean; size: number; mtimeMs?: number }> {
    const target = normalizePath(path);
    const params = new URLSearchParams({ path: target });
    if (options?.allowOutsideWorkspace) {
      params.set('allowOutsideWorkspace', 'true');
    }
    if (options?.outsideFileGrant) {
      params.set('outsideFileGrant', options.outsideFileGrant);
    }
    const response = await runtimeFetch('/api/fs/stat', {
      query: params,
      headers: directoryHeaders(getDirectory, options?.directory),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to stat file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : target,
      isFile: Boolean((result as { isFile?: boolean }).isFile),
      size: typeof (result as { size?: number }).size === 'number' ? (result as { size: number }).size : 0,
      mtimeMs: typeof (result as { mtimeMs?: number }).mtimeMs === 'number' ? (result as { mtimeMs: number }).mtimeMs : undefined,
    };
  },

  async delete(path: string): Promise<{ success: boolean }> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ path: target }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to delete file');
    }

    const result = await response.json().catch(() => ({}));
    return { success: Boolean((result as { success?: boolean }).success) };
  },

  async rename(oldPath: string, newPath: string): Promise<{ success: boolean; path: string }> {
    const response = await runtimeFetch('/api/fs/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ oldPath, newPath }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to rename file');
    }

    const result = await response.json().catch(() => ({}));
    return {
      success: Boolean((result as { success?: boolean }).success),
      path: typeof (result as { path?: string }).path === 'string' ? normalizePath((result as { path: string }).path) : newPath,
    };
  },

  async revealPath(targetPath: string): Promise<{ success: boolean }> {
    const response = await runtimeFetch('/api/fs/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...directoryHeaders(getDirectory) },
      body: JSON.stringify({ path: normalizePath(targetPath) }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to reveal path');
    }

    const result = await response.json().catch(() => ({}));
    return { success: Boolean((result as { success?: boolean }).success) };
  },

  async downloadFile(path: string): Promise<void> {
    const target = normalizePath(path);
    const response = await runtimeFetch('/api/fs/raw', {
      query: { path: target, download: true },
      headers: directoryHeaders(getDirectory),
    });
    if (!response.ok) {
      throw new Error(`Download failed (${response.status})`);
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = target.split('/').pop() || 'file';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
  },
});
