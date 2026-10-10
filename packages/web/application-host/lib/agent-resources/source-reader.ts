import { createHash } from 'node:crypto';
import type { AgentResourceCapture, AgentResourceDirectoryEntry, AgentResourceFailure, AgentResourceLocation, AgentResourceReference } from '../kernel/protocol.generated.js';
import path from 'node:path';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { DocumentAuthority } from '../documents/authority.js';
import type { WorkingStatePinnedRoot, WorkingStateRootStore, WorkingStateTreeEntry } from '../harness/working-state/types.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';

export type ResourceFailureStatus = AgentResourceFailure['status'];
export type ResourceLocation = AgentResourceLocation;
export type ResourceReference = AgentResourceReference;
export type ResourceFailure = AgentResourceFailure;
export type ResourceResult<T> = ({ status: 'ready' } & T) | ResourceFailure;
export type CapturedResource = AgentResourceCapture;
export type ResourceFileResult = ResourceResult<CapturedResource>;
export type ResourceDirectoryEntry = AgentResourceDirectoryEntry;
export type ResourceDirectoryResult = ResourceResult<{ reference: ResourceReference; entries: ResourceDirectoryEntry[] }>;
/** Already admitted by the owning Host. Never expose this handle or its selector to a model. */
export interface ResourceReader {
  readonly domainId: string;
  readonly viewId: string;
  readonly consistency: 'immutable' | 'capture-only';
  read(relativePath: string, signal?: AbortSignal): Promise<ResourceFileResult>;
  list(relativeDirectory: string, signal?: AbortSignal): Promise<ResourceDirectoryResult>;
}
export const contentVersion = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const referenceKey = (value: ResourceLocation): string => JSON.stringify([value.domainId, value.viewId, value.path]);
export function relativeResourcePath(value: string): string {
  if (value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new Error('Resource path must be relative to its admitted domain');
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('Resource path leaves its admitted domain');
  return normalized === '.' ? '' : normalized;
}
export function resourceFailure(reader: Pick<ResourceReader, 'domainId' | 'viewId'>, target: string, status: ResourceFailureStatus, reason: string): ResourceFailure {
  return { status, domainId: reader.domainId, viewId: reader.viewId, path: target, reason };
}
function ioFailure(reader: Pick<ResourceReader, 'domainId' | 'viewId'>, target: string, error: unknown, signal?: AbortSignal): ResourceFailure {
  if (signal?.aborted || (error as Error)?.name === 'AbortError') return resourceFailure(reader, target, 'cancelled', 'Resource read was cancelled');
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return resourceFailure(reader, target, 'missing', 'Resource does not exist in this view');
  if (code === 'EACCES' || code === 'EPERM') return resourceFailure(reader, target, 'denied', 'Resource owner denied this read');
  if (code === 'ENOTDIR' || code === 'EISDIR') return resourceFailure(reader, target, 'invalid', 'Resource has the wrong file type');
  return resourceFailure(reader, target, 'unavailable', 'Resource owner could not read this view');
}
function decode(reader: ResourceReader, target: string, bytes: Uint8Array, canonicalId: string, version: string): ResourceFileResult {
  try {
    // Preserve a BOM in captured content. Format parsing, rather than the reader, owns its meaning.
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { status: 'ready', reference: { domainId: reader.domainId, viewId: reader.viewId, path: target, canonicalId, version }, content };
  } catch { return resourceFailure(reader, target, 'invalid', 'Resource is not valid UTF-8'); }
}
function checkedPath(reader: ResourceReader, target: string): string | ResourceFailure {
  try { return relativeResourcePath(target); }
  catch { return resourceFailure(reader, target, 'denied', 'Path is outside the admitted resource domain'); }
}

/** The caller owns the existing pin and releases it after publication/reads, not this adapter. */
export function createPinnedResourceReader(input: {
  domainId: string;
  store: Pick<WorkingStateRootStore, 'readPath' | 'listPaths' | 'readContent'>;
  pin: WorkingStatePinnedRoot;
  /** Original source receipt coverage, not an inference from the entries that happen to exist. */
  coverage: { kind: 'complete' } | { kind: 'selected'; paths: readonly string[]; subtrees: readonly string[] };
  /** Instruction-only Host scope derivation from an observed same-pin link, never a disk lookup. */
  admitSymlinkTarget?(finalPath: string): Promise<void>;
}): ResourceReader {
  const { store, pin } = input;
  const covered = (relative: string, subtree = false): boolean => input.coverage.kind === 'complete'
    || input.coverage.subtrees.some(root => !root || relative === root || relative.startsWith(`${root}/`))
    || (!subtree && input.coverage.paths.includes(relative));
  // Existing readPath returns link states rather than resolving directory components. Resolve only
  // relative links whose complete target is in this same pin; never consult the displayed disk root.
  async function resolvePinned(target: string, signal?: AbortSignal, active = new Set<string>(), suffix = ''): Promise<WorkingStateTreeEntry | ResourceFailure> {
    signal?.throwIfAborted();
    const parts = target ? target.split('/') : [];
    for (let index = 0; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const entry = await store.readPath(pin.branchId, prefix, { pin, ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      if (!entry || entry.state.kind === 'missing') return resourceFailure(reader, covered(target) ? target : prefix, covered(target) || covered(prefix) ? 'missing' : 'unavailable',
        covered(target) || covered(prefix) ? 'Resource is absent from the captured resource scope' : 'Resource dependency was not covered by original source capture');
      if (entry.state.kind === 'symlink') {
        if (active.has(prefix)) return resourceFailure(reader, prefix, 'invalid', 'Resource symlink cycle in the pinned view');
        const link = entry.state.symlinkTarget;
        let destination: string;
        try {
          if (!link || path.posix.isAbsolute(link) || path.win32.isAbsolute(link) || /^[A-Za-z]:/.test(link)) throw new Error('external');
          destination = relativeResourcePath(path.posix.join(path.posix.dirname(prefix), link.replaceAll('\\', '/')));
        } catch { return resourceFailure(reader, prefix, 'unavailable', 'External symlink target needs an explicitly captured dependency'); }
        const rest = parts.slice(index).join('/');
        const remainder = relativeResourcePath(path.posix.join(rest, suffix));
        await input.admitSymlinkTarget?.(relativeResourcePath(path.posix.join(destination, remainder)));
        const resolved = await resolvePinned(destination, signal, new Set([...active, prefix]), remainder);
        if ('status' in resolved) return resolved;
        if (!rest) return resolved;
        if (resolved.state.kind !== 'directory') return resourceFailure(reader, prefix, 'invalid', 'Resource path crosses a non-directory');
        return resolvePinned(relativeResourcePath(path.posix.join(resolved.path, rest)), signal, active, suffix);
      }
      if (index === parts.length) return entry;
      if (entry.state.kind !== 'directory') return resourceFailure(reader, prefix, 'invalid', 'Resource path crosses a non-directory');
    }
    throw new Error('Unreachable pinned path resolution');
  }
  const reader: ResourceReader = {
    domainId: input.domainId,
    viewId: `working-state:${pin.workspaceId}:${pin.branchId}@${pin.revision}:${pin.root}`,
    consistency: 'immutable',
    async read(target, signal) {
      const relative = checkedPath(reader, target); if (typeof relative !== 'string') return relative;
      try {
        const entry = await resolvePinned(relative, signal); if ('status' in entry) return entry;
        if (entry.state.kind !== 'regular-file') return resourceFailure(reader, relative, 'invalid', 'Resource is not a regular file');
        const bytes = await store.readContent(entry, signal ? { signal } : {});
        signal?.throwIfAborted();
        if (!bytes) return resourceFailure(reader, relative, 'unavailable', 'Pinned content object is unavailable');
        return decode(reader, relative, bytes, `resource:${reader.domainId}/${entry.path}`, entry.state.objectHash);
      } catch (error) { return ioFailure(reader, relative, error, signal); }
    },
    async list(target, signal) {
      const relative = checkedPath(reader, target); if (typeof relative !== 'string') return relative;
      try {
        const directory = await resolvePinned(relative, signal); if ('status' in directory) return directory;
        if (directory.state.kind !== 'directory') return resourceFailure(reader, relative, 'invalid', 'Resource is not a directory');
        if (!covered(directory.path, true)) return resourceFailure(reader, directory.path, 'unavailable', 'Directory dependency was not completely covered by original source capture');
        const tree = await store.listPaths(pin.branchId, [directory.path], { pin, ...(signal ? { signal } : {}) });
        signal?.throwIfAborted();
        if (!tree) return resourceFailure(reader, relative, 'unavailable', 'Pinned resource tree is unavailable');
        const prefix = directory.path ? `${directory.path}/` : '';
        const entries = new Map<string, ResourceDirectoryEntry>();
        for (const entry of tree.entries) {
          if (!entry.path.startsWith(prefix) || entry.path === directory.path || entry.state.kind === 'missing') continue;
          const rest = entry.path.slice(prefix.length); const name = rest.split('/')[0]!;
          if (rest.includes('/')) { if (!entries.has(name)) entries.set(name, { name, kind: 'directory' }); continue; }
          let state: WorkingStateTreeEntry['state'] = entry.state;
          if (state.kind === 'symlink') {
            const resolved = await resolvePinned(entry.path, signal);
            if (!('status' in resolved)) state = resolved.state;
          }
          entries.set(name, { name, kind: state.kind === 'regular-file' ? 'file' : state.kind === 'directory' || state.kind === 'symlink' ? state.kind : 'unsupported' });
        }
        return { status: 'ready', reference: { domainId: reader.domainId, viewId: reader.viewId, path: relative,
          canonicalId: `resource:${reader.domainId}/${directory.path}`, version: pin.root }, entries: [...entries.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) };
      } catch (error) { return ioFailure(reader, relative, error, signal); }
    },
  };
  return reader;
}

/** Exact captured files/directories. An uncaptured path is unavailable, never inferred missing. */
export function createCapsuleResourceReader(input: {
  domainId: string; viewId: string; files: readonly CapturedResource[];
  directories: readonly { path: string; entries: ResourceDirectoryEntry[]; version: string; canonicalId?: string }[];
  missing?: readonly string[];
}): ResourceReader {
  const files = new Map(input.files.map(file => [file.reference.path, { reference: { ...file.reference }, content: file.content }]));
  const directories = new Map(input.directories.map(directory => [directory.path, { ...directory, entries: directory.entries.map(entry => ({ ...entry })) }]));
  const missing = new Set(input.missing ?? []);
  const reader: ResourceReader = {
    domainId: input.domainId, viewId: input.viewId, consistency: 'immutable',
    async read(target, signal) {
      const relative = checkedPath(reader, target); if (typeof relative !== 'string') return relative;
      if (signal?.aborted) return resourceFailure(reader, relative, 'cancelled', 'Resource read was cancelled');
      const file = files.get(relative);
      if (file) {
        if (file.reference.domainId !== reader.domainId || file.reference.viewId !== reader.viewId) return resourceFailure(reader, relative, 'invalid', 'Capsule reference does not match its admitted domain');
        return { status: 'ready', reference: { ...file.reference }, content: file.content };
      }
      if (directories.has(relative)) return resourceFailure(reader, relative, 'invalid', 'Resource is a directory');
      return resourceFailure(reader, relative, missing.has(relative) ? 'missing' : 'unavailable', missing.has(relative) ? 'Resource was absent when captured' : 'Resource dependency was not captured');
    },
    async list(target, signal) {
      const relative = checkedPath(reader, target); if (typeof relative !== 'string') return relative;
      if (signal?.aborted) return resourceFailure(reader, relative, 'cancelled', 'Resource read was cancelled');
      const directory = directories.get(relative);
      if (directory) return { status: 'ready', reference: { domainId: reader.domainId, viewId: reader.viewId, path: relative,
        canonicalId: directory.canonicalId ?? `resource:${reader.domainId}/${relative}`, version: directory.version }, entries: directory.entries.map(entry => ({ ...entry })) };
      if (files.has(relative)) return resourceFailure(reader, relative, 'invalid', 'Resource is a file');
      return resourceFailure(reader, relative, missing.has(relative) ? 'missing' : 'unavailable', missing.has(relative) ? 'Directory was absent when captured' : 'Directory dependency was not captured');
    },
  };
  return reader;
}

/** Uses Documents for content. Directory listing must come from the same admitted workspace owner. */
export function createDocumentResourceReader(input: {
  domainId: string; viewId: string; workspaceId: string;
  documents: Pick<DocumentAuthority, 'readSnapshot'>;
  list: ResourceReader['list'];
}): ResourceReader {
  const reader: ResourceReader = {
    domainId: input.domainId, viewId: input.viewId, consistency: 'capture-only',
    async list(target, signal) {
      const relative = checkedPath(reader, target); if (typeof relative !== 'string') return relative;
      try {
        const result = await input.list(relative, signal);
        signal?.throwIfAborted();
        if (result.status === 'ready' && (result.reference.domainId !== reader.domainId || result.reference.viewId !== reader.viewId)) {
          return resourceFailure(reader, relative, 'invalid', 'Directory owner returned a different admitted resource view');
        }
        return result;
      } catch (error) { return ioFailure(reader, relative, error, signal); }
    },
    async read(target, signal) {
      const relative = checkedPath(reader, target); if (typeof relative !== 'string') return relative;
      try {
        const result = await input.documents.readSnapshot({ workspaceId: input.workspaceId, resourceId: relative }, signal ? { signal } : {});
        signal?.throwIfAborted();
        if (result.status === 'missing') return resourceFailure(reader, relative, 'missing', 'Document is absent');
        if (result.status !== 'ready') return resourceFailure(reader, relative, 'invalid', `Document has unsupported content (${result.status})`);
        return { status: 'ready', reference: { domainId: reader.domainId, viewId: reader.viewId, path: relative,
          canonicalId: `document:${input.workspaceId}/${relative}`, version: result.revision }, content: result.content };
      } catch (error) { return ioFailure(reader, relative, error, signal); }
    },
  };
  return reader;
}

/** Read-only local user/package asset adapter. Root admission is supplied by the existing owner.
 * It is deliberately capture-only: a pathname is not an immutable revision or a new permission grant.
 */
export async function createAdmittedDirectoryReader(input: { domainId: string; viewId: string; root: string }): Promise<ResourceReader> {
  const root = await canonicalizePathIdentity(input.root, { allowMissing: true });
  const rootInfo = async () => {
    try { return await stat(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const admittedRoot = await rootInfo();
  async function resolveTarget(reader: ResourceReader, relative: string): Promise<string | ResourceFailure> {
    const currentRoot = await canonicalizePathIdentity(input.root, { allowMissing: true });
    if (currentRoot !== root) return resourceFailure(reader, relative, 'stale', 'Admitted resource root changed identity');
    const current = await rootInfo();
    if (admittedRoot && !current) return resourceFailure(reader, relative, 'unavailable', 'Admitted resource root is unavailable');
    if ((admittedRoot === null) !== (current === null) || (admittedRoot && current && (admittedRoot.dev !== current.dev || admittedRoot.ino !== current.ino))) {
      return resourceFailure(reader, relative, 'stale', 'Admitted resource root changed identity');
    }
    const target = await canonicalizePathIdentity(path.join(root, relative), { allowMissing: true });
    if (!isPathWithinRoot(target, root)) return resourceFailure(reader, relative, 'denied', 'Resource link leaves its admitted domain');
    return target;
  }
  const reader: ResourceReader = {
    domainId: input.domainId, viewId: input.viewId, consistency: 'capture-only',
    async read(target, signal) {
      const relative = checkedPath(reader, target); if (typeof relative !== 'string') return relative;
      try {
        signal?.throwIfAborted();
        const absolute = await resolveTarget(reader, relative); if (typeof absolute !== 'string') return absolute;
        const observed = await stat(absolute);
        signal?.throwIfAborted();
        if (!observed.isFile()) return resourceFailure(reader, relative, 'invalid', 'Resource is not a regular file');
        // A regular path can be replaced with a FIFO between stat and open. POSIX nonblocking open
        // avoids waiting for a writer; fstat still rejects that actual handle before reading bytes.
        const file = await open(absolute, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
        try {
          const before = await file.stat();
          signal?.throwIfAborted();
          if (!before.isFile()) return resourceFailure(reader, relative, 'invalid', 'Resource is not a regular file');
          if (before.dev !== observed.dev || before.ino !== observed.ino) return resourceFailure(reader, relative, 'stale', 'Resource changed before capture');
          const bytes = await file.readFile(signal ? { signal } : {});
          const after = await file.stat();
          signal?.throwIfAborted();
          const current = await stat(absolute);
          if (before.dev !== current.dev || before.ino !== current.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
            || before.ctimeMs !== after.ctimeMs || await realpath(absolute) !== absolute) {
            return resourceFailure(reader, relative, 'stale', 'Resource changed during capture');
          }
          return decode(reader, relative, bytes, `file:${absolute}`, contentVersion(bytes));
        } finally { await file.close(); }
      } catch (error) { return ioFailure(reader, relative, error, signal); }
    },
    async list(target, signal) {
      const relative = checkedPath(reader, target); if (typeof relative !== 'string') return relative;
      try {
        signal?.throwIfAborted();
        const absolute = await resolveTarget(reader, relative); if (typeof absolute !== 'string') return absolute;
        const entries: ResourceDirectoryEntry[] = [];
        for (const entry of await readdir(absolute, { withFileTypes: true })) {
          // A symlink is followed only when its target remains in this admitted root. The read repeats containment.
          let kind: ResourceDirectoryEntry['kind'] = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'unsupported';
          if (kind === 'symlink') {
            const resolved = await resolveTarget(reader, path.posix.join(relative, entry.name));
            if (typeof resolved === 'string') {
              try { const info = await stat(resolved); kind = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'unsupported'; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            }
          }
          entries.push({ name: entry.name, kind });
        }
        signal?.throwIfAborted();
        entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        return { status: 'ready', reference: { domainId: reader.domainId, viewId: reader.viewId, path: relative,
          canonicalId: `file:${absolute}`, version: contentVersion(JSON.stringify(entries)) }, entries };
      } catch (error) { return ioFailure(reader, relative, error, signal); }
    },
  };
  return reader;
}
