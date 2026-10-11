import { createHash } from 'node:crypto';
import fs, { type Dirent } from 'node:fs';
import path from 'node:path';
import { RecoveryPrimitiveError } from './errors.js';
import {
  assertAbsolutePathInWorkspace,
  resolveWorkspacePath,
  WorkspacePathError,
} from '../workspace/path-safety.js';

export interface RecoveryIdentity {
  authorityId: string;
  canonicalRoot: string;
  filesystemProfile: string;
  workspaceId: string;
}

export interface MissingState {
  kind: 'missing';
}

export interface DirectoryState {
  kind: 'directory';
  mode?: number | undefined;
}

export interface SymlinkState {
  kind: 'symlink';
  mode?: number | undefined;
  symlinkTarget: string;
}

export interface RegularFileState {
  kind: 'regular-file';
  byteLength: number;
  mode?: number | undefined;
  objectHash: string;
}

export interface UnsupportedState {
  kind: 'unsupported';
}

export type RecoveryState =
  | DirectoryState
  | MissingState
  | RegularFileState
  | SymlinkState
  | UnsupportedState;

export interface RecoveryStateLike {
  kind: string;
  byteLength?: number | undefined;
  mode?: number | undefined;
  objectHash?: string | undefined;
  symlinkTarget?: string | undefined;
}

export interface CapturedState {
  path: string;
  state: RecoveryState;
}

export interface FileHashResult {
  byteLength: number;
  objectHash: string;
}

export interface ResolvedPath {
  absolute: string;
  relative: string;
}

export interface StatTreeResult {
  byteLength: number;
  objectCount: number;
}

export interface CaptureStateOptions {
  store?: boolean | undefined;
}

export interface RecoveryFileStoreOptions {
  fsModule?: typeof fs | undefined;
  fsPromises?: typeof fs.promises | undefined;
  pathModule?: typeof path | undefined;
}

export interface RecoveryFileStore {
  applyState: (
    identity: RecoveryIdentity,
    root: string,
    relativePath: string,
    state: RecoveryState,
  ) => Promise<void>;
  captureState: (
    identity: RecoveryIdentity,
    root: string,
    inputPath: string,
    options?: CaptureStateOptions | undefined,
  ) => Promise<CapturedState>;
  hashFile: (filePath: string) => Promise<FileHashResult>;
  relativePathFor: (identity: RecoveryIdentity, inputPath: string) => Promise<ResolvedPath>;
  verifyObject: (root: string, state: RecoveryState) => Promise<void>;
}

const parseOptionalMode = (value: unknown): number | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery file mode is malformed', { origin: 'storage' });
  }
  return value as number;
};

export const parseRecoveryState = (value: unknown): RecoveryState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RecoveryPrimitiveError('storage-malformed', 'Recovery file state is malformed', { origin: 'storage' });
  }
  const record = value as Record<string, unknown>;
  const mode = parseOptionalMode(record.mode);
  if (record.kind === 'missing') return { kind: 'missing' };
  if (record.kind === 'unsupported') return { kind: 'unsupported' };
  if (record.kind === 'directory') {
    return { kind: 'directory', ...(mode === undefined ? {} : { mode }) };
  }
  if (record.kind === 'symlink') {
    if (typeof record.symlinkTarget !== 'string') {
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery symlink state is malformed', { origin: 'storage' });
    }
    return {
      kind: 'symlink',
      symlinkTarget: record.symlinkTarget,
      ...(mode === undefined ? {} : { mode }),
    };
  }
  if (record.kind === 'regular-file') {
    if (!Number.isSafeInteger(record.byteLength) || (record.byteLength as number) < 0
      || typeof record.objectHash !== 'string' || !/^sha256-[0-9a-f]{64}$/u.test(record.objectHash)) {
      throw new RecoveryPrimitiveError('storage-malformed', 'Recovery regular-file state is malformed', { origin: 'storage' });
    }
    return {
      byteLength: record.byteLength as number,
      kind: 'regular-file',
      objectHash: record.objectHash,
      ...(mode === undefined ? {} : { mode }),
    };
  }
  throw new RecoveryPrimitiveError('storage-malformed', 'Recovery file state kind is unsupported', { origin: 'storage' });
};

export const normalizeResourceId = (value: unknown): string => String(value || '')
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .replace(/\/+/g, '/');

/**
 * Mode usable for state comparison. Symlink permissions are not portably
 * settable and commonly describe the link implementation rather than the
 * target's recoverable state. On Windows the filesystem cannot express POSIX
 * permission bits (lstat reports 0o666 for writable regular files), so only
 * the readonly/writable dimension is observable there; states may still carry
 * the full Git/recorded mode for materialization on capable platforms.
 */
const comparableMode = (kind: RecoveryStateLike['kind'], mode: number | undefined): number | null => {
  if (kind === 'symlink' || mode === undefined) return null;
  if (process.platform !== 'win32') return mode;
  return (mode & 0o222) === 0 ? 0o444 : 0o666;
};

/**
 * Platform-agnostic persistent mode identity (D-243 rework). The persistent
 * hash must distinguish 0644 from 0755 on every platform — a capture-window
 * mode change must trigger baseline-changed even on Windows, where the
 * filesystem cannot express the executable bit. `comparableMode` is only for
 * disk comparison (sameState); the persistent identity uses the full mode.
 */
const persistentMode = (kind: RecoveryStateLike['kind'], mode: number | undefined): number | null => {
  if (kind === 'symlink' || mode === undefined) return null;
  return mode;
};

export const stateIdentity = (state: RecoveryStateLike): string => JSON.stringify({
  byteLength: state.byteLength ?? null,
  kind: state.kind,
  mode: persistentMode(state.kind, state.mode),
  objectHash: state.objectHash ?? null,
  symlinkTarget: state.symlinkTarget ?? null,
});

/**
 * Disk-surface comparison: uses the platform-comparable mode so a Git-recorded
 * 0755 state compares equal to a Windows filesystem capture (0o666) when the
 * writable dimension matches. The persistent identity (stateIdentity) still
 * distinguishes them for hashes and fingerprints.
 */
export const sameState = (left: RecoveryStateLike, right: RecoveryStateLike): boolean => {
  const leftId = JSON.stringify({
    byteLength: left.byteLength ?? null,
    kind: left.kind,
    mode: comparableMode(left.kind, left.mode),
    objectHash: left.objectHash ?? null,
    symlinkTarget: left.symlinkTarget ?? null,
  });
  const rightId = JSON.stringify({
    byteLength: right.byteLength ?? null,
    kind: right.kind,
    mode: comparableMode(right.kind, right.mode),
    objectHash: right.objectHash ?? null,
    symlinkTarget: right.symlinkTarget ?? null,
  });
  return leftId === rightId;
};

/** Read-only Host path/hash helpers. File capture, object installation and mutation require the native backend. */
export const createRecoveryFileReader = ({
  fsModule = fs, fsPromises = fs.promises, pathModule = path,
}: RecoveryFileStoreOptions = {}): Pick<RecoveryFileStore, 'relativePathFor' | 'hashFile'> => {
  const relativePathFor = async (
    identity: RecoveryIdentity,
    inputPath: string,
  ): Promise<ResolvedPath> => {
    let contained: { relativePath: string; absolutePath: string };
    try {
      contained = pathModule.isAbsolute(inputPath)
        ? await assertAbsolutePathInWorkspace(inputPath, {
            allowMissing: true,
            fsPromises,
            pathModule,
            root: identity.canonicalRoot,
          })
        : await resolveWorkspacePath(normalizeResourceId(inputPath), {
            allowMissing: true,
            fsPromises,
            pathModule,
            root: identity.canonicalRoot,
          });
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        throw new RecoveryPrimitiveError(
          'workspace-untrusted',
          `Recovery path is outside the workspace: ${inputPath}`,
          { cause: error },
        );
      }
      throw error;
    }
    const relative = normalizeResourceId(contained.relativePath);
    if (!relative || relative === '.' || relative.split('/').includes('..')) {
      throw new RecoveryPrimitiveError('workspace-untrusted', `Recovery path is invalid: ${inputPath}`);
    }
    return { absolute: contained.absolutePath, relative };
  };

  const hashFile = async (filePath: string): Promise<FileHashResult> => {
    const hash = createHash('sha256');
    let byteLength = 0;
    for await (const chunk of fsModule.createReadStream(filePath)) {
      hash.update(chunk);
      byteLength += chunk.length;
    }
    return { byteLength, objectHash: `sha256-${hash.digest('hex')}` };
  };

  return { relativePathFor, hashFile };
};

export const statTree = async (
  root: string,
  fsPromises: typeof fs.promises = fs.promises,
  pathModule: typeof path = path,
): Promise<StatTreeResult> => {
  let byteLength = 0;
  let objectCount = 0;
  const walk = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const target = pathModule.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) {
        objectCount += 1;
        byteLength += (await fsPromises.stat(target)).size;
      }
    }
  };
  await walk(root);
  return { byteLength, objectCount };
};
