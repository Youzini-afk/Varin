/** Format engines transform bytes; native Storage owns conditional writes and recovery. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient, KernelScopedClient } from './kernel-client.js';
import type { LiveSourceResolver } from './live-source.js';
import type { LaunchSource, RecoveryAnchor, KernelBranchState } from './protocol.generated.js';
import { toolOperationId } from './protocol.generated.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import { resourceThreadSource } from './thread-context.js';
import type { ToolInvocationAuthority } from './tool-invocation.js';
import type { ManagedSourceLocalScope } from '../harness/managed-remote-types.js';

export interface BinaryFileWrite {
  path: string;
  /** Native content hash from the read. null means create without replacing a file. */
  expectedRevision: string | null;
  bytes: Uint8Array;
}
export interface BinaryFileWriteResult {
  status: 'applied' | 'conflict' | 'unknown';
  path: string;
  operationId: string;
  revision?: string;
  byteLength?: number;
  executorStopped: boolean;
  fileJournal: true;
  cleanupPending?: boolean;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const resultFrom = (value: unknown, path: string, operationId: string): BinaryFileWriteResult | undefined => {
  if (!object(value) || !['applied', 'conflict'].includes(String(value.status)) || typeof value.stateJson !== 'string') return undefined;
  const state = JSON.parse(value.stateJson) as KernelBranchState;
  return { status: value.status as 'applied' | 'conflict', path, operationId, executorStopped: true, fileJournal: true,
    ...(state.kind === 'regular-file' ? { revision: state.objectHash, byteLength: state.byteLength } : {}) };
};

/** Shared by the local Host and an explicitly admitted remote source Host. */
export async function writeSourceBinary(input: BinaryFileWrite & {
  client: KernelScopedClient; rootId: string; source: LaunchSource;
  operationId: string; tool: string; journal: RecoveryAnchor; signal?: AbortSignal;
}): Promise<BinaryFileWriteResult> {
  const { client, rootId, source, operationId, path, signal } = input;
  if (source.mode === 'fixed_branch') throw new Error('This file source is an immutable revision; prepare its writable execution view before saving');
  // Each native method has its own exact parameters: the root address, the lease identity and
  // the write identity are distinct. Native Storage rejects fields that belong to another method.
  const root = { workspaceId: source.workspace_id, rootId };
  const unknown = (): BinaryFileWriteResult => ({ status: 'unknown', path, operationId, executorStopped: false, fileJournal: true });
  const inspect = async () => {
    const saved = await client.fileOperationReconcile({ ...root, operationId });
    return saved.status === 'missing' ? null : saved.status === 'reconciled' ? resultFrom(saved.result, path, operationId) ?? unknown() : unknown();
  };
  signal?.throwIfAborted();
  const saved = await inspect();
  if (saved) return saved;
  const leaseId = `binary-write:${randomUUID()}`;
  const lease = await client.fileLeaseAcquire({ ...root, leaseId, resources: [{ path, scope: 'exact' }] }, signal);
  if (lease.status !== 'acquired') throw new Error('The file is being changed by another operation; read it again when that operation finishes');
  let beforeOwner: string | undefined;
  let targetOwner: string | undefined;
  let pending = false;
  let receipt: BinaryFileWriteResult | undefined;
  try {
    const captured = await client.fileCapture({ ...root, operationId: `${operationId}:before`, path, store: true, leaseId }, signal);
    if (typeof captured.stateJson !== 'string' || typeof captured.path !== 'string') throw new Error('The file owner returned an incomplete capture');
    const state = JSON.parse(captured.stateJson) as KernelBranchState;
    beforeOwner = typeof captured.ownerId === 'string' ? captured.ownerId : undefined;
    if (state.kind !== 'regular-file' && state.kind !== 'missing') throw new Error(`The selected output is a ${state.kind}, not a file`);
    const revision = state.kind === 'regular-file' ? state.objectHash : null;
    if (revision !== input.expectedRevision) return receipt = { status: 'conflict', path: captured.path, operationId, executorStopped: true, fileJournal: true,
      ...(state.kind === 'regular-file' ? { revision: state.objectHash, byteLength: state.byteLength } : {}) };
    signal?.throwIfAborted();
    const stored = await client.putBlob(input.bytes, `${operationId}:content`, signal);
    targetOwner = stored.ownerId;
    signal?.throwIfAborted();
    pending = true;
    // Keep the original writer until its actual receipt settles, even if the observer cancels.
    const applied = await client.fileApply({ ...root, operationId, path: captured.path, leaseId,
      ownerId: stored.ownerId, expectedJson: JSON.stringify(state),
      targetJson: JSON.stringify({ kind: 'regular-file', objectHash: stored.hash, byteLength: stored.byteLength,
        ...(state.kind === 'regular-file' && state.mode !== undefined ? { mode: state.mode } : {}) }),
      journalBinding: { anchor: input.journal, sourceMode: source.mode, tool: input.tool, ...(beforeOwner ? { beforeOwnerId: beforeOwner } : {}) },
    });
    const result = resultFrom(applied, captured.path, operationId);
    if (!result) return receipt = unknown();
    pending = false;
    return receipt = result;
  } catch (error) {
    if (!pending) throw error;
    try {
      const saved = await inspect();
      if (saved) { pending = !saved.executorStopped; return receipt = saved; }
      pending = false;
    } catch { return receipt = unknown(); }
    throw error;
  } finally {
    if (!pending) {
      const cleaned = await Promise.allSettled([
        ...[beforeOwner, targetOwner].filter((owner): owner is string => Boolean(owner)).map(owner => client.releaseBlob(owner)),
        client.fileLeaseRelease({ ...root, leaseId }),
      ]);
      if (receipt && cleaned.some(result => result.status === 'rejected')) receipt.cleanupPending = true;
    }
  }
}

export function createBinaryFileOwner(options: { kernel: KernelClient; runtime: AgentRuntimeClient; resolveLiveSource: LiveSourceResolver }) {
  return {
    async write(authority: ToolInvocationAuthority, input: BinaryFileWrite, signal: AbortSignal): Promise<BinaryFileWriteResult> {
      const launch = await options.runtime.launch(authority.runId, signal);
      if (!authority.source || !launch || !isDeepStrictEqual(launch.selection.source, authority.source)) throw new Error('The original file source is unavailable');
      const journal = await options.runtime.journalAnchor(authority.operationId, signal);
      if (authority.source.resource_owner.kind === 'managed_host') {
        let sent = false;
        try { return await options.runtime.withManagedSourceAuthority(authority.runId, resourceThreadSource(authority.source)!, ({ client, binding }) => {
          signal.throwIfAborted(); sent = true;
          return client.service({ coordinatorHostId: options.runtime.coordinatorHostId, authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch,
            requestId: `binary-write:${randomUUID()}`, operation: { kind: 'binary_write', invocation: authority, journal,
              path: input.path, expectedRevision: input.expectedRevision, bytesBase64: Buffer.from(input.bytes).toString('base64'), byteLength: input.bytes.byteLength } }, signal);
        }, signal); } catch (error) {
          if (!sent) throw error;
          return { status: 'unknown', path: input.path, operationId: authority.operationId, executorStopped: false, fileJournal: true };
        }
      }
      const admitted = await admitRunSourceAuthority(options.kernel, options.runtime,
        savedSourceLaunch(authority.runId, authority.source, sourceToolSchemas(launch.selection).map(tool => tool.name)),
        { signal, resolveLiveSource: options.resolveLiveSource });
      let receipt: BinaryFileWriteResult | undefined;
      try {
        if (admitted.kind !== 'local' || !admitted.rootId) throw new Error('The original writable file source has not been prepared');
        return receipt = await writeSourceBinary({ ...input, client: admitted.client, rootId: admitted.rootId, source: authority.source,
          operationId: authority.operationId, tool: authority.toolName, journal, signal });
      } finally {
        try { await admitted.release(); }
        catch { if (receipt) receipt.cleanupPending = true; }
      }
    },
  };
}

export async function writeManagedBinary(kernel: KernelClient, scope: ManagedSourceLocalScope,
  request: Extract<import('../harness/managed-remote-types.js').SourceServiceOperation, { kind: 'binary_write' }>, signal?: AbortSignal): Promise<BinaryFileWriteResult> {
  const { invocation, journal } = request;
  if (scope.scope.kind !== 'run' || scope.scope.runId !== invocation.runId || scope.scope.threadId !== invocation.threadId
    || !isDeepStrictEqual(scope.source, invocation.source) || !scope.physicalRoot
    || invocation.operation !== 'effect' || invocation.operationId !== toolOperationId(invocation.origin, invocation.callId)
    || journal.runId !== invocation.runId || journal.threadId !== invocation.threadId
    || !['office_write', 'office_export', 'browser_files'].includes(invocation.toolName)
    || !object(invocation.arguments) || invocation.arguments.path !== request.path
    || !scope.principal.capabilities.includes('filesystem:write')) throw new Error('The file write differs from its original admitted operation');
  const bytes = Buffer.from(request.bytesBase64, 'base64');
  if (bytes.byteLength !== request.byteLength) throw new Error('The transferred file content is incomplete');
  return writeSourceBinary({ client: kernel.scoped(scope.grant), source: scope.source, rootId: scope.physicalRoot.rootId,
    operationId: invocation.operationId, tool: invocation.toolName, journal, path: request.path,
    expectedRevision: request.expectedRevision, bytes, ...(signal ? { signal } : {}) });
}
