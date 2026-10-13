import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  parseVarinExtensionPackageRequest, parseVarinToolJson, parseVarinExtensionPackagePath,
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
import { captureExtensionSource, materializeExtensionSource, type ExtensionSourceCapture } from './extension-source.js';

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

/** The compiler consumes one frozen capture from the actual Source owner. The
 * derived temporary tree never grants access to a coordinator-local workspace. */
export async function captureExtensionPackage(options: Omit<ExtensionPackageOwnerOptions, 'extensions'>,
  authority: ToolInvocationAuthority, packagePath: string, signal: AbortSignal,
  consume: (directory: string, source: VarinExtensionSourceViewProvenance) => Promise<VarinExtensionPackageResult>): Promise<VarinExtensionPackageResult> {
  packagePath = parseVarinExtensionPackagePath(packagePath);
  const launch = await options.runtime.launch(authority.runId, signal);
  if (!authority.source || !launch?.selection.source || !isDeepStrictEqual(authority.source, launch.selection.source)) {
    throw new Error('extension_package_source_required');
  }
  const source = authority.source;
  const selection = savedSourceLaunch(authority.runId, source, sourceToolSchemas(launch.selection).map(tool => tool.name));
  const admitted = await admitRunSourceAuthority(options.kernel, options.runtime, selection, {
    signal, resolveLiveSource: options.resolveLiveSource, retention: 'caller', operationId: authority.operationId,
  });
  let temporary: string | undefined;
  let capture: Pick<ExtensionSourceCapture, 'snapshot' | 'read'> | undefined;
  let releaseCapture: ExtensionSourceCapture['release'] | undefined;
  let completed: VarinExtensionPackageResult | undefined;
  let primaryError: unknown;
  let failed = false;
  try {
    if (admitted.kind === 'managed') {
      const address = { coordinatorHostId: options.runtime.coordinatorHostId, authorityId: admitted.binding.authorityId,
        resourceEpoch: admitted.binding.resourceEpoch };
      const captureId = randomUUID();
      const captured = await admitted.service.service({ ...address, requestId: randomUUID(),
        operation: { kind: 'package_capture', captureId, operationId: authority.operationId, packagePath } }, signal);
      const provenance = captured.snapshot.provenance;
      if (!isDeepStrictEqual(provenance.resourceOwner, source.resource_owner)
        || provenance.workspaceId !== source.workspace_id || provenance.executionWorkspaceId !== source.execution_workspace_id
        || provenance.runId !== authority.runId || provenance.operationId !== authority.operationId
        || provenance.mode !== source.mode || provenance.packagePath !== packagePath
        || provenance.branchId !== (source.branch_id ?? undefined) || provenance.revision !== (source.revision ?? undefined)
        || provenance.environmentRunId !== (source.environment_run_id ?? undefined)
        || provenance.rootId !== (admitted.binding.physicalRoot?.rootId ?? undefined)) {
        throw new Error('extension_package_source_changed');
      }
      capture = { snapshot: captured.snapshot,
        read: (name, offset, length, readSignal) => admitted.service.service({ ...address, requestId: randomUUID(),
          operation: { kind: 'package_read', captureId, path: name, offset, length } }, readSignal),
      };
      // This independent source authority owns every capture, including a capture
      // whose response was lost. Its normal retirement performs target cleanup.
    } else {
      const common = { grant: admitted.grant, owningWorkspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id };
      const context = source.mode === 'fixed_branch' ? await options.storage.contextFromBranchGrant(common)
        : await options.storage.contextFromSourceGrant({ ...common, rootId: admitted.rootId!, canonicalRoot: admitted.canonicalRoot! });
      const local = await captureExtensionSource({ store: new KernelWorkingStateRootStore(context), client: admitted.client, source,
        physicalRoot: admitted.rootId && admitted.canonicalRoot ? { hostId: options.kernel.handshake!.hostId,
          rootId: admitted.rootId, canonicalRoot: admitted.canonicalRoot } : null,
        runId: authority.runId, operationId: authority.operationId, packagePath, signal });
      capture = local;
      releaseCapture = local.release;
    }
    temporary = await mkdtemp(path.join(tmpdir(), 'varin-extension-source-'));
    await materializeExtensionSource(temporary, capture.snapshot, capture.read, signal);
    signal.throwIfAborted();
    completed = await consume(temporary, capture.snapshot.provenance);
  } catch (error) { primaryError = error; failed = true; }
  {
    // Readers/build have actually ended. Cleanup failure keeps an obtained
    // catalog receipt; it does not convert committed staging into a failed write.
    const errors: unknown[] = [];
    for (const cleanup of [
      async () => { if (temporary) await rm(temporary, { force: true, recursive: true }); },
      async () => { await releaseCapture?.(); },
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
