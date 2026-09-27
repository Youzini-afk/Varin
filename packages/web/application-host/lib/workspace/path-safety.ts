import fs from 'fs';
import path from 'path';

type PathModule = typeof import('path');
export interface RealpathFsPromises {
  realpath(targetPath: string): Promise<string>;
}

export interface PathSafetyFsPromises extends RealpathFsPromises {
  stat(targetPath: string): Promise<Pick<import('node:fs').Stats, 'isDirectory'>>;
}

export interface NormalizePathIdentityOptions {
  pathModule?: PathModule | undefined;
  platform?: string | undefined;
}

export interface CanonicalizePathIdentityOptions {
  allowMissing?: boolean | undefined;
  fsPromises?: RealpathFsPromises | undefined;
  pathModule?: PathModule | undefined;
}

export interface IsPathWithinRootOptions {
  platform?: string | undefined;
}

export interface ResolveWorkspacePathOptions {
  root: string;
  fsPromises?: PathSafetyFsPromises | undefined;
  pathModule?: PathModule | undefined;
  allowMissing?: boolean | undefined;
}

export interface ResolvedWorkspacePath {
  rootPath: string;
  rootRealPath: string;
  relativePath: string;
  absolutePath: string;
  realPath: string;
}

export class WorkspacePathError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'WorkspacePathError';
    this.statusCode = statusCode;
  }
}

export const isWinDriveAbsolute = (value: string): boolean => /^[A-Za-z]:[\\/]/.test(value);

const stripWindowsNamespacePrefix = (value: string): string => {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice(8)}`;
  if (value.startsWith('\\\\?\\')) return value.slice(4);
  return value;
};

export const normalizePathIdentity = (
  value: string,
  { pathModule = path, platform = process.platform }: NormalizePathIdentityOptions = {},
): string => {
  const resolved = pathModule.resolve(value);
  if (platform !== 'win32') return resolved;
  return pathModule.normalize(stripWindowsNamespacePrefix(resolved)).toLowerCase();
};

export const canonicalizePathIdentity = async (
  value: string,
  {
    allowMissing = false,
    fsPromises = fs.promises,
    pathModule = path,
  }: CanonicalizePathIdentityOptions = {},
): Promise<string> => {
  const suffix: string[] = [];
  let current = pathModule.resolve(value);

  for (;;) {
    try {
      const canonicalParent = await fsPromises.realpath(current);
      return pathModule.resolve(canonicalParent, ...suffix.reverse());
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      const parent = pathModule.dirname(current);
      if (parent === current) throw error;
      suffix.push(pathModule.basename(current));
      current = parent;
    }
  }
};

const normalizeForCompare = (
  value: string,
  pathModule: PathModule,
  platform: string,
): string => {
  return normalizePathIdentity(value, { pathModule, platform });
};

export const isPathWithinRoot = (
  candidatePath: string,
  rootPath: string,
  pathModule: PathModule = path,
  { platform = process.platform }: IsPathWithinRootOptions = {},
): boolean => {
  const candidate = normalizeForCompare(candidatePath, pathModule, platform);
  const root = normalizeForCompare(rootPath, pathModule, platform);
  const relative = pathModule.relative(root, candidate);
  const traversesParent = relative === '..' || relative.startsWith(`..${pathModule.sep}`);
  return relative === '' || (!traversesParent && !pathModule.isAbsolute(relative));
};

export const normalizeWorkspaceRelativePath = (value: unknown): string => {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  if (typeof value !== 'string') {
    throw new WorkspacePathError('Workspace path must be a string');
  }
  if (value.includes('\0')) {
    throw new WorkspacePathError('Invalid path: NUL bytes are not allowed');
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === '.') {
    return '';
  }
  if (path.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed) || isWinDriveAbsolute(trimmed)) {
    throw new WorkspacePathError('Workspace APIs require a relative path');
  }

  const segments = trimmed
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');

  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === '..') {
      throw new WorkspacePathError('Path is outside workspace');
    }
    normalized.push(segment);
  }

  return normalized.join('/');
};

const realpathOrResolved = async (
  targetPath: string,
  fsPromises: RealpathFsPromises,
  pathModule: PathModule,
): Promise<string> => {
  try {
    return await fsPromises.realpath(targetPath);
  } catch {
    return pathModule.resolve(targetPath);
  }
};

const findNearestExistingParent = async (
  absolutePath: string,
  rootPath: string,
  fsPromises: PathSafetyFsPromises,
  pathModule: PathModule,
): Promise<string> => {
  let current = absolutePath;
  while (isPathWithinRoot(current, rootPath, pathModule)) {
    try {
      const stat = await fsPromises.stat(current);
      if (stat.isDirectory()) {
        return current;
      }
      return pathModule.dirname(current);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
        throw error;
      }
      const parent = pathModule.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return rootPath;
};

const assertRealPathInsideRoot = async (
  candidatePath: string,
  rootRealPath: string,
  fsPromises: PathSafetyFsPromises,
  pathModule: PathModule,
): Promise<string> => {
  const candidateRealPath = await fsPromises.realpath(candidatePath);
  if (!isPathWithinRoot(candidateRealPath, rootRealPath, pathModule)) {
    throw new WorkspacePathError('Path is outside workspace', 403);
  }
  return candidateRealPath;
};

export const resolveWorkspacePath = async (
  relativePathValue: unknown,
  options: ResolveWorkspacePathOptions,
): Promise<ResolvedWorkspacePath> => {
  const {
    root,
    fsPromises = fs.promises,
    pathModule = path,
    allowMissing = false,
  } = options || {};

  if (!root || typeof root !== 'string') {
    throw new WorkspacePathError('Workspace root is not configured', 500);
  }

  const rootPath = pathModule.resolve(root);
  const rootRealPath = await realpathOrResolved(rootPath, fsPromises, pathModule);

  const relativePath = normalizeWorkspaceRelativePath(relativePathValue);
  const absolutePath = relativePath
    ? pathModule.resolve(rootPath, ...relativePath.split('/'))
    : rootPath;

  if (!isPathWithinRoot(absolutePath, rootPath, pathModule)) {
    throw new WorkspacePathError('Path is outside workspace', 403);
  }

  try {
    const realPath = await assertRealPathInsideRoot(absolutePath, rootRealPath, fsPromises, pathModule);
    return { rootPath, rootRealPath, relativePath, absolutePath, realPath };
  } catch (error) {
    if (!allowMissing || !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
      throw error;
    }
  }

  const nearestParent = await findNearestExistingParent(absolutePath, rootPath, fsPromises, pathModule);
  await assertRealPathInsideRoot(nearestParent, rootRealPath, fsPromises, pathModule);

  return {
    rootPath,
    rootRealPath,
    relativePath,
    absolutePath,
    realPath: absolutePath,
  };
};

export const assertAbsolutePathInWorkspace = async (
  absolutePathValue: unknown,
  options: ResolveWorkspacePathOptions,
): Promise<ResolvedWorkspacePath> => {
  const {
    root,
    fsPromises = fs.promises,
    pathModule = path,
    allowMissing = false,
  } = options || {};

  if (typeof absolutePathValue !== 'string' || absolutePathValue.trim().length === 0) {
    throw new WorkspacePathError('Path is required');
  }

  const rootPath = pathModule.resolve(root);
  const absolutePath = pathModule.resolve(absolutePathValue);
  let relative: string | undefined;
  if (isPathWithinRoot(absolutePath, rootPath, pathModule)) {
    relative = pathModule.relative(rootPath, absolutePath);
  } else {
    const rootRealPath = await realpathOrResolved(rootPath, fsPromises, pathModule);
    const rootIdentity = normalizePathIdentity(rootRealPath, { pathModule });
    const suffix: string[] = [];
    let current = absolutePath;
    for (;;) {
      try {
        const currentRealPath = await fsPromises.realpath(current);
        if (normalizePathIdentity(currentRealPath, { pathModule }) === rootIdentity) {
          relative = suffix.reverse().join(pathModule.sep);
          break;
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
      }
      const parent = pathModule.dirname(current);
      if (parent === current) break;
      suffix.push(pathModule.basename(current));
      current = parent;
    }
  }
  if (relative === undefined) throw new WorkspacePathError('Path is outside workspace', 403);
  return resolveWorkspacePath(relative.replace(/\\/g, '/'), {
    root,
    fsPromises,
    pathModule,
    allowMissing,
  });
};
