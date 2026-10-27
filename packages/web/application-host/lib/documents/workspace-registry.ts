import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import { DocumentAuthorityError, DocumentPathError, DocumentWorkspaceUnregisteredError } from './errors.js';

const SCHEMA_VERSION = 1;

interface WorkspaceEntry {
  workspaceId: string;
  canonicalPath: string;
  /**
   * Directory roots address a subtree; file roots address exactly one file.
   * Entries without an explicit kind are directory roots.
   */
  kind?: 'directory' | 'file';
  createdAt?: string;
  nativeSource?: NativeWorkspaceReference;
  nativeRetainers?: string[];
}
export interface NativeWorkspaceReference {
  workspace_id:string;
  execution_workspace_id:string;
  branch_id:string|null;
  native_scope?:string;
}

interface RegistryDocument {
  schemaVersion: number;
  hostId: string;
  workspaces: WorkspaceEntry[];
}

interface RegistryIndex {
  byId: Map<string, WorkspaceEntry>;
  byPath?: Map<string, WorkspaceEntry[]>;
}

export interface WorkspaceMapping {
  workspaceId: string;
  canonicalPath: string;
  hostId: string;
  kind: 'directory' | 'file';
  nativeSource?: NativeWorkspaceReference;
  nativeRetainers?: string[];
}

export interface WorkspaceRegistryResolveInput {
  canonicalPath?: string;
  workspaceId?: string;
  create?: boolean;
  /** Root kind recorded when create mints a new mapping. */
  kind?: 'directory' | 'file';
}

export interface WorkspaceRegistryOptions {
  hostId: string;
  filePath: string;
  fsPromises: Pick<typeof import('node:fs/promises'), 'mkdir' | 'readFile' | 'rename' | 'unlink' | 'writeFile'>;
  pathModule?: typeof path;
}

const normalizeComparePath = (value: string, pathModule: typeof path): string => (
  normalizePathIdentity(value, { pathModule })
);

const canonicalWorkspaceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const looksLikeCanonicalWorkspaceId = (value: unknown): value is string => (
  typeof value === 'string' && canonicalWorkspaceIdPattern.test(value)
);

export const looksLikeFilesystemWorkspaceScopeId = (value: unknown): boolean => (
  typeof value === 'string' && (/[\\/]/.test(value) || /^[A-Za-z]:/.test(value))
);
const validNativeReference = (value:unknown):value is NativeWorkspaceReference => {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const source=value as NativeWorkspaceReference;
  return looksLikeCanonicalWorkspaceId(source.workspace_id)&&looksLikeCanonicalWorkspaceId(source.execution_workspace_id)
    && typeof source.branch_id==='string'&&source.branch_id.length>0
    && (source.native_scope===undefined||typeof source.native_scope==='string'&&source.native_scope.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!part.includes('\\')));
};

export const createWorkspaceRegistry = ({
  hostId,
  filePath,
  fsPromises,
  pathModule = path,
}: WorkspaceRegistryOptions) => {
  let queue: Promise<unknown> = Promise.resolve();
  let document: RegistryDocument | null = null;
  let loading: Promise<RegistryDocument> | null = null;
  // Documents are immutable after publication. Indexes share that lifetime;
  // failed writes never publish a candidate document or its identities.
  const indexes = new WeakMap<RegistryDocument, RegistryIndex>();

  const empty = (): RegistryDocument => ({ schemaVersion: SCHEMA_VERSION, hostId, workspaces: [] });

  const indexFor = (current: RegistryDocument): RegistryIndex => {
    const existing = indexes.get(current);
    if (existing) return existing;
    const index: RegistryIndex = { byId: new Map() };
    for (const entry of current.workspaces) {
      if (!index.byId.has(entry.workspaceId)) index.byId.set(entry.workspaceId, entry);
    }
    indexes.set(current, index);
    return index;
  };

  const pathsFor = (current: RegistryDocument): Map<string, WorkspaceEntry[]> => {
    const index = indexFor(current);
    if (!index.byPath) {
      const byPath = new Map<string, WorkspaceEntry[]>();
      for (const entry of current.workspaces) {
        if(entry.nativeSource)continue;
        const key = normalizeComparePath(entry.canonicalPath, pathModule);
        const entries = byPath.get(key);
        if (entries) entries.push(entry);
        else byPath.set(key, [entry]);
      }
      index.byPath = byPath;
    }
    return index.byPath;
  };

  const read = (): Promise<RegistryDocument> => {
    if (document) return Promise.resolve(document);
    if (!loading) {
      loading = (async () => {
        try {
          const raw = JSON.parse(await fsPromises.readFile(filePath, 'utf8')) as Record<string, unknown>;
          if(raw&&raw.hostId!==hostId)throw new DocumentWorkspaceUnregisteredError();
          if (!raw || raw.schemaVersion !== SCHEMA_VERSION || !Array.isArray(raw.workspaces)) {
            throw new DocumentAuthorityError('Workspace registry format is unsupported; the stored registry was retained',{code:'workspace-registry-invalid',statusCode:409});
          } else {
            if(raw.workspaces.some(entry=>entry&&typeof entry==='object'&&'nativeSource' in entry&&!validNativeReference(entry.nativeSource))){
              throw new DocumentAuthorityError('Workspace registry has an invalid native source reference',{code:'workspace-registry-invalid',statusCode:409});
            }
            if(raw.workspaces.some(entry=>entry&&typeof entry==='object'&&'nativeRetainers' in entry&&(!Array.isArray(entry.nativeRetainers)||entry.nativeRetainers.some((id:unknown)=>typeof id!=='string'||!id))))throw new DocumentAuthorityError('Workspace registry has invalid retained editor references',{code:'workspace-registry-invalid',statusCode:409});
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
          }
          return document;
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
          document = empty();
          return document;
        }
      })().finally(() => { loading = null; });
    }
    return loading;
  };

  const persist = async (next: RegistryDocument): Promise<void> => {
    await fsPromises.mkdir(pathModule.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsPromises.writeFile(tmp, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
      document = next;
    } catch (error) {
      await fsPromises.unlink(tmp).catch(() => undefined);
      throw error;
    }
  };

  const findByPath = (current: RegistryDocument, canonicalPath: string): WorkspaceEntry | undefined => (
    pathsFor(current).get(normalizeComparePath(canonicalPath, pathModule))?.[0]
  );

  const findContainingPath = (current: RegistryDocument, canonicalPath: string): WorkspaceEntry | null => {
    const byPath = pathsFor(current);
    let candidate = normalizeComparePath(canonicalPath, pathModule);
    for (;;) {
      let match: WorkspaceEntry | null = null;
      for (const entry of byPath.get(candidate) ?? []) {
        // A file root addresses exactly one file; it never contains a path.
        if (entry.kind !== 'file' && (!match || entry.canonicalPath.length > match.canonicalPath.length)) match = entry;
      }
      if (match) return match;
      const parent = pathModule.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  };

  const findExactPath = (current: RegistryDocument, canonicalPath: string, kind?: 'directory' | 'file'): WorkspaceEntry | null => (
    pathsFor(current).get(normalizeComparePath(canonicalPath, pathModule))?.find((entry) => (
      kind === undefined || (entry.kind ?? 'directory') === kind
    )) ?? null
  );

  const toMapping = (entry: WorkspaceEntry): WorkspaceMapping => ({
    workspaceId: entry.workspaceId,
    canonicalPath: entry.canonicalPath,
    hostId,
    kind: entry.kind ?? 'directory',
    ...(entry.nativeSource?{nativeSource:{...entry.nativeSource}}:{}),
    ...(entry.nativeRetainers?.length?{nativeRetainers:[...entry.nativeRetainers]}:{}),
  });

  return {
    async setNativeRetention(workspaceId:string,ownerId:string,retained:boolean):Promise<void>{
      const work=queue.then(async()=>{
        const current=await read(),entry=indexFor(current).byId.get(workspaceId);
        if(!entry?.nativeSource)return;
        const owners=new Set(entry.nativeRetainers??[]);
        if(retained)owners.add(ownerId);else owners.delete(ownerId);
        await persist({...current,workspaces:current.workspaces.map(value=>value===entry?{...value,nativeRetainers:[...owners].sort()}:value)});
      });queue=work.catch(()=>undefined);return work;
    },
    async forgetNativeSource(workspaceId:string,branchId:string):Promise<void>{
      const work=queue.then(async()=>{
        const current=await read();
        const selected=current.workspaces.filter(entry=>entry.nativeSource?.workspace_id===workspaceId&&entry.nativeSource.branch_id===branchId);
        if(selected.some(entry=>entry.nativeRetainers?.length))throw new DocumentPathError('Saved editors still retain this source',409);
        if(selected.length)await persist({...current,workspaces:current.workspaces.filter(entry=>!selected.includes(entry))});
      });queue=work.catch(()=>undefined);return work;
    },
    async registerNative(workspaceId:string,originalPath:string,source:NativeWorkspaceReference):Promise<WorkspaceMapping>{
      if(!looksLikeCanonicalWorkspaceId(workspaceId)||!validNativeReference(source))throw new DocumentPathError('Native workspace identity is incomplete',400);
      const work=queue.then(async()=>{
        const current=await read(),previous=indexFor(current).byId.get(workspaceId);
        if(previous){
          if(!previous.nativeSource||['workspace_id','execution_workspace_id','branch_id','native_scope'].some(key=>previous.nativeSource![key as keyof NativeWorkspaceReference]!==source[key as keyof NativeWorkspaceReference])||previous.canonicalPath!==originalPath)throw new DocumentPathError('Native workspace registration changed',409);
          return toMapping(previous);
        }
        const entry:WorkspaceEntry={workspaceId,canonicalPath:originalPath,kind:'directory',nativeSource:{...source},createdAt:new Date().toISOString()};
        await persist({...current,workspaces:[...current.workspaces,entry]});return toMapping(entry);
      });queue=work.catch(()=>undefined);return work;
    },
    async resolve({ canonicalPath, workspaceId, create, kind }: WorkspaceRegistryResolveInput): Promise<WorkspaceMapping | null> {
      if (workspaceId) {
        const current = await read();
        const existing = indexFor(current).byId.get(workspaceId);
        return existing ? toMapping(existing) : null;
      }
      if (!canonicalPath) throw new DocumentPathError('Workspace path is required', 400);
      const current = await read();
      const existing = findByPath(current, canonicalPath);
      if (existing) return toMapping(existing);
      if (!create) return null;
      const next = queue.then(async () => {
        const current = await read();
        const existing = findByPath(current, canonicalPath);
        // Another queued registration may already have committed this root.
        if (existing) return toMapping(existing);
        const created: WorkspaceEntry = {
          workspaceId: randomUUID(),
          canonicalPath,
          ...(kind === 'file' ? { kind: 'file' as const } : {}),
          createdAt: new Date().toISOString(),
        };
        await persist({ ...current, workspaces: [...current.workspaces, created] });
        return toMapping(created);
      });
      queue = next.catch(() => undefined);
      return next;
    },

    async get(workspaceId: string): Promise<WorkspaceMapping | null> {
      const existing = indexFor(await read()).byId.get(workspaceId);
      return existing ? toMapping(existing) : null;
    },

    async list(): Promise<WorkspaceMapping[]> {
      return (await read()).workspaces.map(toMapping);
    },

    async findContaining(canonicalPath: string): Promise<WorkspaceMapping | null> {
      const existing = findContainingPath(await read(), canonicalPath);
      return existing ? toMapping(existing) : null;
    },

    /** Exact-path lookup; optionally restricted to one root kind. */
    async findExact(canonicalPath: string, kind?: 'directory' | 'file'): Promise<WorkspaceMapping | null> {
      const existing = findExactPath(await read(), canonicalPath, kind);
      return existing ? toMapping(existing) : null;
    },
  };
};
