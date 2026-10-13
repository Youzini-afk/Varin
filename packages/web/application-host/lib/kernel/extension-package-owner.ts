import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, open, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  parseVarinExtensionPackageRequest, parseVarinToolJson, parseVarinPackageSourcePath, parseVarinExtensionPackagePath,
  VARIN_EXTENSION_PACKAGES_CAPABILITY, type VarinExtensionSourceViewProvenance, type VarinExtensionPackageResult,
} from '@varin/extension-contract';
import {
  ExtensionPackageApplicationError, ExtensionCatalogRevisionConflictError, type ApplicationExtensionRuntime, type HostCapabilityHandler,
} from '@varin/extension-host';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { LiveSourceResolver } from './live-source.js';
import { KernelWorkingStateRootStore, type KernelStorageAdapter } from './storage-adapter.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import { requireToolInvocation, runToolDomainCall, type ToolInvocationAuthority } from './tool-invocation.js';
import type { RecoveryState } from '../recovery/journal-files.js';
import type { WorkingStatePin } from '../harness/working-state/types.js';

export { VARIN_EXTENSION_PACKAGES_CAPABILITY };
export interface ExtensionPackageOwnerOptions {
  extensions: ApplicationExtensionRuntime;
  kernel: KernelClient;
  runtime: AgentRuntimeClient;
  storage: KernelStorageAdapter;
  resolveLiveSource: LiveSourceResolver;
  onCleanupError?(operationId: string, error: unknown): void;
}

class ExtensionPackageCleanupError extends Error {
  constructor(readonly result: VarinExtensionPackageResult, errors: unknown[]) {
    super('extension_package_cleanup_incomplete', { cause: new AggregateError(errors) });
  }
}

/** Only the original admitted Source is read. The temporary tree is a derived compiler input,
 * not a source authority or a second package store. Storage pins/capture owners retain its bytes. */
export async function captureExtensionPackage(options: Omit<ExtensionPackageOwnerOptions, 'extensions'>,
  authority: ToolInvocationAuthority, packagePath: string, signal: AbortSignal,
  consume: (directory: string, source: VarinExtensionSourceViewProvenance) => Promise<VarinExtensionPackageResult>): Promise<VarinExtensionPackageResult> {
  packagePath = parseVarinExtensionPackagePath(packagePath);
  const sourcePath = packagePath === '.' ? '' : packagePath;
  const launch = await options.runtime.launch(authority.runId, signal);
  if (!authority.source || !launch?.selection.source || !isDeepStrictEqual(authority.source, launch.selection.source)) {
    throw new Error('extension_package_source_required');
  }
  const source = authority.source;
  if (source.resource_owner.kind === 'managed_host') throw new Error('Extension package staging from a managed Source is not available yet. Stage the package on its owning Host; reviewed candidates can still be applied here.');
  const selection = savedSourceLaunch(authority.runId, source, sourceToolSchemas(launch.selection).map(tool => tool.name));
  const admitted = await admitRunSourceAuthority(options.kernel, options.runtime, selection, {
    signal, resolveLiveSource: options.resolveLiveSource, retention: 'caller', operationId: authority.operationId,
  });
  let temporary: string | undefined;
  let captured: Record<string, RecoveryState> | undefined;
  let pin: WorkingStatePin | undefined;
  let store: KernelWorkingStateRootStore | undefined;
  let completed: VarinExtensionPackageResult | undefined;
  let primaryError: unknown;
  let failed = false;
  try {
    if (admitted.kind !== 'local') throw new Error('Extension package source owner changed during admission');
    const common = { grant: admitted.grant, owningWorkspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id };
    const context = source.mode === 'fixed_branch'
      ? await options.storage.contextFromBranchGrant(common)
      : await options.storage.contextFromSourceGrant({ ...common, rootId: admitted.rootId!, canonicalRoot: admitted.canonicalRoot! });
    store = new KernelWorkingStateRootStore(context);
    const entries: Array<{ path: string; state: RecoveryState; originalPath: string }> = [];
    if (source.mode === 'fixed_branch') {
      pin = await store.pinBranch(source.branch_id!, { revision: source.revision!, signal });
      const root = await store.readPath(source.branch_id!, sourcePath, { pin, signal });
      if (root?.state.kind !== 'directory') throw new Error('extension_package_directory_required');
      const tree = await store.listPaths(source.branch_id!, [sourcePath], { pin, signal });
      if (!tree) throw new Error('extension_package_source_unavailable');
      const prefix = sourcePath ? `${sourcePath}/` : '';
      for (const entry of tree.entries) {
        if (entry.path !== sourcePath && entry.path.startsWith(prefix)) entries.push({ path: entry.path.slice(prefix.length), state: entry.state, originalPath: entry.path });
      }
    } else {
      const directory = path.join(admitted.canonicalRoot!, ...packagePath.split('/'));
      // Both passes use the original native capture/lease owner. The second pass checks
      // the complete inventory as well as content; mutable source is never rebuilt later.
      captured = await store.captureDirectory(directory, undefined, { signal });
      const observed = await store.captureDirectory(directory, undefined, { signal, store: false });
      if (!isDeepStrictEqual(captured, observed)) throw new Error('extension_package_source_changed');
      for (const [relative, state] of Object.entries(captured)) entries.push({ path: relative, state, originalPath: `${packagePath}/${relative}` });
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const hash = createHash('sha256');
    for (const entry of entries) {
      parseVarinPackageSourcePath(entry.path);
      if (entry.state.kind !== 'regular-file' && entry.state.kind !== 'directory' && entry.state.kind !== 'symlink') {
        throw new Error(`extension_package_unsupported_entry: ${entry.path}; special files are not supported`);
      }
      hash.update(JSON.stringify([entry.path, entry.state])).update('\n');
    }
    const provenance: VarinExtensionSourceViewProvenance = {
      workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
      runId: authority.runId, operationId: authority.operationId, mode: source.mode, packagePath,
      captureIntegrity: `sha256-${hash.digest('hex')}`,
      ...(source.branch_id ? { branchId: source.branch_id, revision: source.revision! } : {}),
      ...(source.environment_run_id ? { environmentRunId: source.environment_run_id } : {}),
      ...(admitted.rootId ? { rootId: admitted.rootId } : {}),
    };
    temporary = await mkdtemp(path.join(tmpdir(), 'varin-extension-source-'));
    for (const entry of entries) {
      signal.throwIfAborted();
      const target = path.join(temporary, ...entry.path.split('/'));
      if (entry.state.kind === 'directory') { await mkdir(target, { recursive: true }); continue; }
      if (entry.state.kind === 'symlink') continue;
      if (entry.state.kind !== 'regular-file') throw new Error('extension_package_unsupported_entry');
      const state = entry.state;
      await mkdir(path.dirname(target), { recursive: true });
      const file = await open(target, 'wx', state.mode ?? 0o600);
      const contentHash = createHash('sha256');
      try {
        let offset = 0;
        while (offset < state.byteLength) {
          signal.throwIfAborted();
          const ownerId = store.ownerIdForObject(state.objectHash);
          const blobSource = pin ? { pinId: pin.pinId, path: entry.originalPath } : { ownerId: ownerId! };
          if (!pin && !ownerId) throw new Error('extension_package_capture_owner_missing');
          const page = await admitted.client.getBlob(state.objectHash, blobSource, { offset, length: Math.min(64 * 1024, state.byteLength - offset), signal });
          const bytes = Buffer.from(page.bytesBase64, 'base64');
          if (page.offset !== offset || !bytes.length || offset + bytes.length > state.byteLength) throw new Error('extension_package_capture_page_invalid');
          contentHash.update(bytes);
          let written = 0;
          while (written < bytes.length) written += (await file.write(bytes, written, bytes.length - written)).bytesWritten;
          offset += bytes.length;
        }
        if (`sha256-${contentHash.digest('hex')}` !== state.objectHash) throw new Error('extension_package_capture_hash_changed');
      } finally { await file.close(); }
    }
    const byPath = new Map(entries.map(entry => [entry.path, entry.state]));
    const linkTarget = (name: string, target: string): string => {
      const normalized = path.isAbsolute(target)
        ? admitted.canonicalRoot ? path.relative(path.join(admitted.canonicalRoot, ...packagePath.split('/')), target).split(path.sep).join('/') : '..'
        : path.posix.normalize(path.posix.join(path.posix.dirname(name), target.replace(/\\/g, '/')));
      if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
        throw new Error(`extension_package_link_outside_capture: ${name}; include the dependency inside the package or prebuild its entrypoint`);
      }
      return normalized;
    };
    const checkTarget = (name: string, seen = new Set<string>()): void => {
      if (seen.has(name)) throw new Error(`extension_package_link_cycle: ${name}`);
      seen.add(name);
      const state = byPath.get(name);
      if (!state) throw new Error(`extension_package_link_target_missing: ${name}`);
      if (state.kind === 'symlink') checkTarget(linkTarget(name, state.symlinkTarget), seen);
    };
    for (const entry of entries) {
      if (entry.state.kind !== 'symlink') continue;
      signal.throwIfAborted();
      const target = linkTarget(entry.path, entry.state.symlinkTarget);
      checkTarget(target);
      const destination = path.join(temporary, ...entry.path.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await symlink(path.posix.relative(path.posix.dirname(entry.path), target), destination,
        byPath.get(target)?.kind === 'directory' ? 'dir' : 'file');
    }
    signal.throwIfAborted();
    completed = await consume(temporary, provenance);
  } catch (error) { primaryError = error; failed = true; }
  {
    // Readers/build have actually ended. A failed cleanup is not evidence that
    // their executor is still running, nor does it erase an obtained catalog receipt.
    const errors: unknown[] = [];
    for (const cleanup of [
      async () => { if (temporary) await rm(temporary, { force: true, recursive: true }); },
      async () => { if (captured && store) await store.releaseCapturedStates(captured); },
      async () => { await pin?.release(); },
      admitted.release,
    ]) { try { await cleanup(); } catch (error) { errors.push(error); } }
    if (errors.length) {
      const error = completed ? new ExtensionPackageCleanupError(completed, errors)
        : new AggregateError(failed ? [primaryError, ...errors] : errors, 'extension_package_cleanup_incomplete');
      try { options.onCleanupError?.(authority.operationId, error); }
      catch (reportError) {
        throw completed ? new ExtensionPackageCleanupError(completed, [...errors, reportError])
          : new AggregateError([error, reportError], 'extension_package_cleanup_reporting_failed');
      }
      throw error;
    }
  }
  if (failed) throw primaryError;
  return completed!;
}

export function createExtensionPackageOwner(options: ExtensionPackageOwnerOptions): HostCapabilityHandler {
  return (method, params, context) => {
    if (method !== 'manage') throw new Error('extension_package_method_invalid');
    const request = parseVarinExtensionPackageRequest(params);
    return runToolDomainCall(context, { operation: 'effect', domain: VARIN_EXTENSION_PACKAGES_CAPABILITY,
      toolName: 'extension_package', arguments: parseVarinToolJson(params) }, async authority => {
      let enteredMutation = false;
      try {
        const result = request.action === 'stage'
          ? await captureExtensionPackage(options, authority, request.packagePath, context.signal, async (directory, source) => {
              requireToolInvocation(context);
              // Artifact construction precedes the short, revision-checked catalog mutation.
              return options.extensions.stageCapturedPackage(directory, source, request.expectedRevision, context.signal, () => { enteredMutation = true; });
            })
          : await (async () => {
              requireToolInvocation(context);
              return options.extensions.applyPackageCandidate(request, context.signal, () => { enteredMutation = true; });
            })();
        return { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed',
          content: { data: parseVarinToolJson(result), parts: [] } } };
      } catch (error) {
        if (error instanceof ExtensionPackageCleanupError) {
          return { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: 'confirmed',
            content: { data: parseVarinToolJson({ ...error.result, cleanupError: error.message }), parts: [] } } };
        }
        if (error instanceof ExtensionPackageApplicationError) {
          return { executor_stopped: true, completion: { kind: 'result', outcome: 'failed', effect: 'confirmed',
            content: { data: parseVarinToolJson({ ...error.result, error: error.message }), parts: [] } } };
        }
        if (error instanceof ExtensionCatalogRevisionConflictError) enteredMutation = false;
        // No guessed receipt from today's hash. Unknown catalog-write outcomes remain
        // unknown after a full Host restart and never rerun the mutable source operation.
        return { executor_stopped: true, completion: { kind: 'result', outcome: enteredMutation ? 'indeterminate' : 'failed',
          effect: enteredMutation ? 'unknown' : 'none', content: { data: { error: error instanceof Error ? error.message : 'extension_package_failed' }, parts: [] } } };
      }
    });
  };
}
