import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tempDir: string;
let workspaceRoot: string;
const dirLinkType = process.platform === 'win32' ? 'junction' : 'dir';

async function loadPathSafetyModule() {
  vi.resetModules();
  return import('./path-safety.js');
}

describe('workspace path safety', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'varin-workspace-path-'));
    workspaceRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects parent traversal, absolute paths, Windows drive paths, and NUL bytes', async () => {
    const { normalizeWorkspaceRelativePath } = await loadPathSafetyModule();

    expect(() => normalizeWorkspaceRelativePath('../secret')).toThrow(/outside workspace/i);
    expect(() => normalizeWorkspaceRelativePath('/etc/passwd')).toThrow(/relative path/i);
    expect(() => normalizeWorkspaceRelativePath('C:/Users/test')).toThrow(/relative path/i);
    expect(() => normalizeWorkspaceRelativePath('demo\0file')).toThrow(/invalid path/i);
  });

  it('allows symlinks whose real target stays inside the workspace', async () => {
    const { resolveWorkspacePath } = await loadPathSafetyModule();
    fs.mkdirSync(path.join(workspaceRoot, 'real'), { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'real', 'note.txt'), 'hello');
    fs.symlinkSync(path.join(workspaceRoot, 'real'), path.join(workspaceRoot, 'inside-link'), dirLinkType);

    const result = await resolveWorkspacePath('inside-link/note.txt', {
      root: workspaceRoot,
      fsPromises: fs.promises,
      pathModule: path,
    });

    expect(result.relativePath).toBe('inside-link/note.txt');
    expect(result.absolutePath).toBe(path.join(workspaceRoot, 'inside-link', 'note.txt'));
  });

  it('rejects symlinks whose real target escapes the workspace', async () => {
    const { resolveWorkspacePath } = await loadPathSafetyModule();
    const outside = path.join(tempDir, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    fs.symlinkSync(outside, path.join(workspaceRoot, 'outside-link'), dirLinkType);

    await expect(resolveWorkspacePath('outside-link/secret.txt', {
      root: workspaceRoot,
      fsPromises: fs.promises,
      pathModule: path,
    })).rejects.toThrow(/outside workspace/i);
  });

  it('resolves a missing child only when the nearest existing parent is inside the workspace', async () => {
    const { resolveWorkspacePath } = await loadPathSafetyModule();
    fs.mkdirSync(path.join(workspaceRoot, 'project'), { recursive: true });

    const result = await resolveWorkspacePath('project/src/new.txt', {
      root: workspaceRoot,
      fsPromises: fs.promises,
      pathModule: path,
      allowMissing: true,
    });

    expect(result.absolutePath).toBe(path.join(workspaceRoot, 'project', 'src', 'new.txt'));
  });

  it('accepts a workspace root whose canonical path uses a different filesystem alias', async () => {
    const { resolveWorkspacePath } = await loadPathSafetyModule();
    const aliases = new Map([
      ['/short/workspace', '/canonical/workspace'],
      ['/short/workspace/note.txt', '/canonical/workspace/note.txt'],
    ]);
    const fsPromises = {
      realpath: async (targetPath: string) => aliases.get(targetPath) ?? targetPath,
      stat: async () => ({ isDirectory: () => false }),
    };

    const result = await resolveWorkspacePath('note.txt', {
      root: '/short/workspace',
      fsPromises,
      pathModule: path.posix,
    });

    expect(result.rootPath).toBe('/short/workspace');
    expect(result.rootRealPath).toBe('/canonical/workspace');
    expect(result.realPath).toBe('/canonical/workspace/note.txt');
  });

  it('accepts an absolute child whose workspace prefix uses a different filesystem alias', async () => {
    const { assertAbsolutePathInWorkspace } = await loadPathSafetyModule();
    const aliases = new Map([
      ['/short/workspace', '/canonical/workspace'],
      ['/short/workspace/note.txt', '/canonical/workspace/note.txt'],
      ['/canonical/workspace', '/canonical/workspace'],
      ['/canonical/workspace/note.txt', '/canonical/workspace/note.txt'],
    ]);
    const fsPromises = {
      realpath: async (targetPath: string) => aliases.get(targetPath) ?? targetPath,
      stat: async () => ({ isDirectory: () => false }),
    };

    const result = await assertAbsolutePathInWorkspace('/short/workspace/note.txt', {
      root: '/canonical/workspace',
      fsPromises,
      pathModule: path.posix,
    });

    expect(result.relativePath).toBe('note.txt');
    expect(result.absolutePath).toBe('/canonical/workspace/note.txt');
  });

  it('canonicalizes a missing child through the nearest existing parent identity', async () => {
    const { canonicalizePathIdentity } = await loadPathSafetyModule();
    const fsPromises = {
      realpath: async (targetPath: string) => {
        if (targetPath === '/short/workspace') return '/canonical/workspace';
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
    };

    await expect(canonicalizePathIdentity('/short/workspace/new/note.txt', {
      allowMissing: true,
      fsPromises,
      pathModule: path.posix,
    })).resolves.toBe('/canonical/workspace/new/note.txt');
  });

  it('normalizes Windows namespace prefixes and case for identity keys', async () => {
    const { isPathWithinRoot, normalizePathIdentity } = await loadPathSafetyModule();

    expect(normalizePathIdentity('\\\\?\\C:\\Users\\Runner\\Repo', {
      pathModule: path.win32,
      platform: 'win32',
    })).toBe('c:\\users\\runner\\repo');
    expect(isPathWithinRoot('\\\\?\\C:\\Users\\RUNNER\\Repo\\src', 'C:\\Users\\Runner\\Repo', path.win32, {
      platform: 'win32',
    })).toBe(true);
  });

  it('treats dot-prefixed child names as children rather than parent traversal', async () => {
    const { isPathWithinRoot } = await loadPathSafetyModule();

    expect(isPathWithinRoot('/workspace/..cache/file', '/workspace', path.posix)).toBe(true);
    expect(isPathWithinRoot('/workspace-copy/file', '/workspace', path.posix)).toBe(false);
  });
});
