import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import { DocumentPathError } from './errors.js';

const SCHEMA_VERSION = 1;

interface WorkspaceEntry {
  workspaceId: string;
  canonicalPath: string;
  /**
   * `directory` roots address a subtree; `file` roots address exactly one file
   * (HR0: resource-rooted Documents addressing for paths outside any project).
   * Legacy entries without the field are directory roots.
   */
  kind?: 'directory' | 'file';
  createdAt?: string;
}

interface RegistryDocument {
  schemaVersion: number;
  hostId: string;
  workspaces: WorkspaceEntry[];
}

export interface WorkspaceMapping {
  workspaceId: string;
  canonicalPath: string;
  hostId: string;
  kind: 'directory' | 'file';
}

export interface WorkspaceRegistryResolveInput {
  canonicalPath?: string;
  workspaceId?: string;
  create?: boolean;
  /** Root kind recorded when `create` mints a new mapping. */
  kind?: 'directory' | 'file';
}

export interface WorkspaceRegistryOptions {
  hostId: string;
  filePath: string;
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir' | 'readFile' | 'rename' | 'unlink' | 'writeFile'>;
  pathModule?: typeof path;
}

const normalizeComparePath = (value: string, pathModule: typeof path): string => {
  return normalizePathIdentity(value, { pathModule });
};

const canonicalWorkspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const looksLikeCanonicalWorkspaceId = (value: unknown): value is string => (
  typeof value === 'string' && canonicalWorkspaceIdPattern.test(value)
);

export const looksLikeFilesystemWorkspaceScopeId = (value: unknown): boolean => (
  typeof value === 'string' && (/[\\/]/.test(value) || /^[A-Za-z]:/.test(value))
);

export const createWorkspaceRegistry = ({
  hostId,
  filePath,
  fsPromises,
  pathModule = path,
}: WorkspaceRegistryOptions) => {
  let queue: Promise<unknown> = Promise.resolve();
  let document: RegistryDocument | null = null;

  const empty = (): RegistryDocument => ({
    schemaVersion: SCHEMA_VERSION,
    hostId,
    workspaces: [],
  });

  const read = async (): Promise<RegistryDocument> => {
    if (document) return document;
    try {
      const raw = JSON.parse(await fsPromises.readFile(filePath, 'utf8')) as Record<string, unknown>;
      if (!raw || raw.hostId !== hostId || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.workspaces)) {
        document = empty();
        return document;
      }
      document = {
        schemaVersion: SCHEMA_VERSION,
        hostId,
        workspaces: (raw.workspaces as unknown[]).filter((entry): entry is WorkspaceEntry => (
          entry !== null && typeof entry === 'object'
          && looksLikeCanonicalWorkspaceId((entry as WorkspaceEntry).workspaceId)
          && typeof (entry as WorkspaceEntry).canonicalPath === 'string'
          && (entry as WorkspaceEntry).canonicalPath.length > 0
        )),
      };
      return document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      document = empty();
      return document;
    }
  };

  const persist = async (next: RegistryDocument): Promise<void> => {
    await fsPromises.mkdir(pathModule.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = JSON.stringify(next);
    try {
      await fsPromises.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
      document = next;
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => undefined);
      throw error;
    }
  };

  const mutate = <Result>(work: (current: RegistryDocument) => Result | Promise<Result>): Promise<Result> => {
    const next = queue.then(async () => {
      const current = structuredClone(await read());
      const result = await work(current);
      await persist(current);
      return result;
    });
    queue = next.catch(() => undefined);
    return next;
  };

  const findByPath = (current: RegistryDocument, canonicalPath: string): WorkspaceEntry | undefined => {
    const needle = normalizeComparePath(canonicalPath, pathModule);
    return current.workspaces.find((entry) => normalizeComparePath(entry.canonicalPath, pathModule) === needle);
  };

  const findContainingPath = (current: RegistryDocument, canonicalPath: string): WorkspaceEntry | null => {
    const needle = normalizeComparePath(canonicalPath, pathModule);
    return current.workspaces
      .filter((entry) => {
        // A file root addresses exactly one file; it never "contains" a path.
        if (entry.kind === 'file') return false;
        const root = normalizeComparePath(entry.canonicalPath, pathModule);
        return needle === root || needle.startsWith(`${root}${pathModule.sep}`);
      })
      .sort((left, right) => right.canonicalPath.length - left.canonicalPath.length)[0] ?? null;
  };

  const findExactPath = (current: RegistryDocument, canonicalPath: string, kind?: 'directory' | 'file'): WorkspaceEntry | null => {
    const needle = normalizeComparePath(canonicalPath, pathModule);
    return current.workspaces.find((entry) => (
      normalizeComparePath(entry.canonicalPath, pathModule) === needle
      && (kind === undefined || (entry.kind ?? 'directory') === kind)
    )) ?? null;
  };

  const toMapping = (entry: WorkspaceEntry): WorkspaceMapping => ({
    workspaceId: entry.workspaceId,
    canonicalPath: entry.canonicalPath,
    hostId,
    kind: entry.kind ?? 'directory',
  });

  return {
    async resolve({ canonicalPath, workspaceId, create, kind }: WorkspaceRegistryResolveInput): Promise<WorkspaceMapping | null> {
      if (workspaceId) {
        const current = await read();
        const existing = current.workspaces.find((entry) => entry.workspaceId === workspaceId);
        if (!existing) return null;
        return toMapping(existing);
      }
      if (!canonicalPath) throw new DocumentPathError('Workspace path is required', 400);
      const current = await read();
      const existing = findByPath(current, canonicalPath);
      if (existing) {
        return toMapping(existing);
      }
      if (!create) return null;
      return mutate((current) => {
        const currentExisting = findByPath(current, canonicalPath);
        if (currentExisting) {
          return toMapping(currentExisting);
        }
        const created: WorkspaceEntry = {
          workspaceId: randomUUID(),
          canonicalPath,
          ...(kind === 'file' ? { kind: 'file' as const } : {}),
          createdAt: new Date().toISOString(),
        };
        current.workspaces.push(created);
        return toMapping(created);
      });
    },

    async get(workspaceId: string): Promise<WorkspaceMapping | null> {
      const current = await read();
      const existing = current.workspaces.find((entry) => entry.workspaceId === workspaceId);
      if (!existing) return null;
      return toMapping(existing);
    },

    async list(): Promise<WorkspaceMapping[]> {
      const current = await read();
      return current.workspaces.map(toMapping);
    },

    async findContaining(canonicalPath: string): Promise<WorkspaceMapping | null> {
      const current = await read();
      const existing = findContainingPath(current, canonicalPath);
      if (!existing) return null;
      return toMapping(existing);
    },

    /** Exact-path lookup; optionally restricted to one root kind. */
    async findExact(canonicalPath: string, kind?: 'directory' | 'file'): Promise<WorkspaceMapping | null> {
      const current = await read();
      const existing = findExactPath(current, canonicalPath, kind);
      if (!existing) return null;
      return toMapping(existing);
    },
  };
};
