/** One source-owned capture serves both local compilation and cross-Host staging.
 * Object addresses stay behind the original reader; only bytes reach the compiler tree. */
import { createHash } from 'node:crypto';
import { mkdir, open, symlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseVarinExtensionPackagePath, parseVarinPackageSourcePath, parseVarinExtensionSourceViewProvenance,
  type VarinExtensionSourceViewProvenance } from '@varin/extension-contract';
import { parseRecoveryState, type RecoveryState } from '../recovery/journal-files.js';
import type { WorkingStatePin } from '../harness/working-state/types.js';
import type { KernelWorkingStateRootStore } from './storage-adapter.js';
import type { KernelScopedClient } from './kernel-client.js';
import type { KernelObjectSlice, LaunchSource, LiveRoot } from './protocol.generated.js';

export interface ExtensionSourceEntry {
  path: string;
  state: Exclude<RecoveryState, { kind: 'missing' | 'unsupported' }>;
  /** Package-relative resolved target, interpreted on the source Host. */
  linkTarget?: string;
}
export interface ExtensionSourceSnapshot {
  provenance: VarinExtensionSourceViewProvenance;
  entries: ExtensionSourceEntry[];
}
export interface ExtensionSourceCapture {
  snapshot: ExtensionSourceSnapshot;
  read(name: string, offset: number, length: number, signal?: AbortSignal): Promise<KernelObjectSlice>;
  release(): Promise<void>;
}
const sourceState = (value: unknown): ExtensionSourceEntry['state'] => {
  const state = parseRecoveryState(value);
  if (state.kind === 'missing' || state.kind === 'unsupported') throw new Error('extension_package_unsupported_entry');
  return state;
};
// The same manifest can cross Hosts with different locale settings.
const entryOrder = (a: ExtensionSourceEntry, b: ExtensionSourceEntry) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const integrityOf = (entries: ExtensionSourceEntry[]) => {
  const hash = createHash('sha256');
  for (const entry of entries) hash.update(JSON.stringify([entry.path, entry.state, entry.linkTarget ?? null])).update('\n');
  return `sha256-${hash.digest('hex')}`;
};

/** The network decoder and local capture use the same closed manifest shape. */
export function parseExtensionSourceSnapshot(value: unknown): ExtensionSourceSnapshot {
  const raw = value as ExtensionSourceSnapshot;
  if (!raw || !Array.isArray(raw.entries)) throw new Error('extension_package_capture_invalid');
  const provenance = parseVarinExtensionSourceViewProvenance(raw.provenance);
  const entries = raw.entries.map(entry => {
    const name = parseVarinPackageSourcePath(entry?.path);
    const state = sourceState(entry.state);
    if (state.kind === 'symlink') return { path: name, state, linkTarget: parseVarinPackageSourcePath(entry.linkTarget) };
    if (entry.linkTarget !== undefined) throw new Error('extension_package_capture_invalid');
    return { path: name, state };
  });
  // Check membership independently of the source OS. No link is created until
  // every regular file has been written, and no file may sit beneath a link.
  const byPath = new Map(entries.map(entry => [entry.path, entry]));
  if (byPath.size !== entries.length) throw new Error('extension_package_capture_duplicate_path');
  for (const entry of entries) {
    for (let parent = path.posix.dirname(entry.path); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (byPath.get(parent)?.state.kind !== 'directory') throw new Error('extension_package_capture_parent_missing');
    }
    if (entry.state.kind !== 'symlink') continue;
    const seen = new Set<string>([entry.path]);
    let target = entry.linkTarget!;
    for (;;) {
      if (seen.has(target)) throw new Error(`extension_package_link_cycle: ${entry.path}`);
      seen.add(target);
      const next = byPath.get(target);
      if (!next) throw new Error(`extension_package_link_target_missing: ${entry.path}`);
      if (next.state.kind !== 'symlink') break;
      target = next.linkTarget!;
    }
  }
  entries.sort(entryOrder);
  if (integrityOf(entries) !== provenance.captureIntegrity) throw new Error('extension_package_capture_integrity_changed');
  return { provenance, entries };
}

export async function captureExtensionSource(input: {
  store: KernelWorkingStateRootStore; client: KernelScopedClient; source: LaunchSource; physicalRoot: LiveRoot | null;
  runId: string; operationId: string; packagePath: string; signal: AbortSignal;
}): Promise<ExtensionSourceCapture> {
  const { store, client, source, signal } = input;
  const packagePath = parseVarinExtensionPackagePath(input.packagePath);
  const sourcePath = packagePath === '.' ? '' : packagePath;
  let captured: Record<string, RecoveryState> | undefined;
  let pin: WorkingStatePin | undefined;
  let closed = false;
  let releasing: Promise<void> | undefined;
  const pending = new Set<Promise<KernelObjectSlice>>();
  const release = () => {
    closed = true;
    releasing ??= (async () => {
      await Promise.allSettled([...pending]);
      // Preserve a failed release for the original owner's later cleanup attempt.
      if (captured) { await store.releaseCapturedStates(captured); captured = undefined; }
      if (pin) { await pin.release(); pin = undefined; }
    })();
    void releasing.catch(() => { releasing = undefined; });
    return releasing;
  };
  try {
    const entries: Array<ExtensionSourceEntry & { originalPath: string }> = [];
    if (source.mode === 'fixed_branch') {
      pin = await store.pinBranch(source.branch_id!, { revision: source.revision!, signal });
      const root = await store.readPath(source.branch_id!, sourcePath, { pin, signal });
      if (root?.state.kind !== 'directory') throw new Error('extension_package_directory_required');
      const tree = await store.listPaths(source.branch_id!, [sourcePath], { pin, signal });
      if (!tree) throw new Error('extension_package_source_unavailable');
      const prefix = sourcePath ? `${sourcePath}/` : '';
      for (const entry of tree.entries) {
        if (entry.path !== sourcePath && entry.path.startsWith(prefix)) entries.push({ path: entry.path.slice(prefix.length),
          state: sourceState(entry.state), originalPath: entry.path });
      }
    } else {
      if (!input.physicalRoot) throw new Error('extension_package_source_unavailable');
      const directory = path.join(input.physicalRoot.canonicalRoot, ...packagePath.split('/'));
      captured = await store.captureDirectory(directory, undefined, { signal });
      const observed = await store.captureDirectory(directory, undefined, { signal, store: false });
      if (!isDeepStrictEqual(captured, observed)) throw new Error('extension_package_source_changed');
      for (const [relative, state] of Object.entries(captured)) entries.push({ path: relative, state: sourceState(state),
        originalPath: sourcePath ? `${sourcePath}/${relative}` : relative });
    }
    for (const entry of entries) {
      parseVarinPackageSourcePath(entry.path);
      if (entry.state.kind !== 'symlink') continue;
      const target = entry.state.symlinkTarget;
      const relative = path.isAbsolute(target)
        ? input.physicalRoot ? path.relative(path.join(input.physicalRoot.canonicalRoot, ...packagePath.split('/')), target).split(path.sep).join('/') : '..'
        : path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), target.replace(/\\/g, '/')));
      try { entry.linkTarget = parseVarinPackageSourcePath(relative); }
      catch { throw new Error(`extension_package_link_outside_capture: ${entry.path}; include the dependency inside the package or prebuild its entrypoint`); }
    }
    const manifest = entries.map(({ originalPath: _originalPath, ...entry }) => entry).sort(entryOrder);
    const snapshot = parseExtensionSourceSnapshot({ entries: manifest, provenance: {
      resourceOwner: source.resource_owner, workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
      runId: input.runId, operationId: input.operationId, mode: source.mode, packagePath, captureIntegrity: integrityOf(manifest),
      ...(source.branch_id ? { branchId: source.branch_id, revision: source.revision! } : {}),
      ...(source.environment_run_id ? { environmentRunId: source.environment_run_id } : {}),
      ...(input.physicalRoot ? { rootId: input.physicalRoot.rootId } : {}),
    } });
    const byPath = new Map(entries.map(entry => [entry.path, entry]));
    signal.throwIfAborted();
    return { snapshot, release, read(name, offset, length, readSignal) {
      if (closed) return Promise.reject(new Error('extension_package_capture_released'));
      readSignal?.throwIfAborted();
      const entry = byPath.get(name);
      if (entry?.state.kind !== 'regular-file') return Promise.reject(new Error('extension_package_capture_file_missing'));
      const state = entry.state;
      const ownerId = store.ownerIdForObject(state.objectHash);
      if (!pin && !ownerId) return Promise.reject(new Error('extension_package_capture_owner_missing'));
      // Join the short native byte reader even when its caller cancels. A transport
      // rejection alone does not establish that the source owner can be released.
      const work = client.getBlob(state.objectHash, pin ? { pinId: pin.pinId, path: entry.originalPath } : { ownerId: ownerId! },
        { offset, length }).then(page => { readSignal?.throwIfAborted(); return page; });
      pending.add(work);
      return work.finally(() => { pending.delete(work); });
    } };
  } catch (error) {
    try { await release(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'extension_package_capture_cleanup_incomplete'); }
    throw error;
  }
}

/** Page immutable bytes directly into the existing compiler input, never into A's Storage. */
export async function materializeExtensionSource(directory: string, snapshot: ExtensionSourceSnapshot,
  read: ExtensionSourceCapture['read'], signal: AbortSignal): Promise<void> {
  for (const entry of snapshot.entries) {
    signal.throwIfAborted();
    const target = path.join(directory, ...entry.path.split('/'));
    if (entry.state.kind === 'directory') { await mkdir(target, { recursive: true }); continue; }
    if (entry.state.kind === 'symlink') continue;
    const state = entry.state;
    await mkdir(path.dirname(target), { recursive: true });
    const file = await open(target, 'wx', state.mode ?? 0o600);
    const hash = createHash('sha256');
    try {
      let offset = 0;
      while (offset < state.byteLength) {
        signal.throwIfAborted();
        const page = await read(entry.path, offset, Math.min(64 * 1024, state.byteLength - offset), signal);
        const bytes = Buffer.from(page.bytesBase64, 'base64');
        if (page.hash !== state.objectHash || page.byteLength !== state.byteLength || page.offset !== offset
          || !bytes.length || page.nextOffset !== offset + bytes.length || page.nextOffset > state.byteLength
          || page.eof !== (page.nextOffset === state.byteLength)) throw new Error('extension_package_capture_page_invalid');
        hash.update(bytes);
        let written = 0;
        while (written < bytes.length) written += (await file.write(bytes, written, bytes.length - written)).bytesWritten;
        offset = page.nextOffset;
      }
      if (`sha256-${hash.digest('hex')}` !== state.objectHash) throw new Error('extension_package_capture_hash_changed');
    } finally { await file.close(); }
  }
  const byPath = new Map(snapshot.entries.map(entry => [entry.path, entry]));
  for (const entry of snapshot.entries) {
    if (entry.state.kind !== 'symlink') continue;
    signal.throwIfAborted();
    let finalTarget = entry.linkTarget!;
    while (byPath.get(finalTarget)?.state.kind === 'symlink') finalTarget = byPath.get(finalTarget)!.linkTarget!;
    const destination = path.join(directory, ...entry.path.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(path.posix.relative(path.posix.dirname(entry.path), entry.linkTarget!), destination,
      byPath.get(finalTarget)?.state.kind === 'directory' ? 'dir' : 'file');
  }
}
