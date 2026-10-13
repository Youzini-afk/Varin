/** Original Run source authority handed to ExperimentService's accepted worker. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { LiveSourceResolver } from './live-source.js';
import type { LaunchSource, LiveRoot } from './protocol.generated.js';
import type { ManagedSourceAddress } from '../harness/managed-remote-types.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import type { ExperimentCaller } from '../harness/research-identity.js';
import { installExperimentInput, prepareExperimentInput, type ExperimentInputSnapshot, type PrepareExperimentInputOptions, ExperimentInputCaptureError } from '../harness/experiment-workspace.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';
export type ExperimentSourceAdmission = {
  selection: LaunchSource;
  cwd: string;
} & ({
  kind: 'physical';
  canonicalRoot: string;
} | {
  kind: 'managed';
  address: ManagedSourceAddress;
  physicalRoot: LiveRoot | null;
} | {
  kind: 'fixed';
  branchId: string;
  revision: number;
  root: string;
  pinId: string;
});
export interface ResearchSourceAuthority {
  admit(caller: ExperimentCaller, cwd: string | undefined, signal?: AbortSignal): Promise<ExperimentSourceAdmission>;
  capture(caller: ExperimentCaller, admitted: ExperimentSourceAdmission, options: PrepareExperimentInputOptions): Promise<ExperimentInputSnapshot>;
  release(caller: ExperimentCaller, admitted: ExperimentSourceAdmission): Promise<void>;
  /** Original pin receipt reconciliation before any attempt was accepted; never creates input. */
  reconcileUnaccepted(caller: ExperimentCaller): Promise<boolean>;
}
const relative = (value: string): string => {
  const normalized = value.replaceAll('\\', '/');
  if (path.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0') || normalized.split('/').includes('..'))
    throw new Error('Experiment cwd must stay inside its exact source');
  return normalized.split('/').filter(p => p && p !== '.').join('/');
};
export function createResearchSourceAuthority(options: {
  kernel: KernelClient;
  runtime: () => AgentRuntimeClient;
  resolveLiveSource: LiveSourceResolver;
}): ResearchSourceAuthority {
  const open = async (caller: ExperimentCaller, signal?: AbortSignal) => {
    if (caller.owner.runtime !== 'agent' || !('operationId' in caller.owner))
      throw new Error('Research source authority requires its actual native owner');
    const runtime = options.runtime();
    const launch = await runtime.launch(caller.owner.runId, signal);
    if (!launch || !isDeepStrictEqual(launch.selection.source, caller.owner.source))
      throw new Error('Original research LaunchSource changed');
    const admitted = await admitRunSourceAuthority(options.kernel, runtime, savedSourceLaunch(caller.owner.runId, caller.owner.source, sourceToolSchemas(launch.selection).map(tool => tool.name) as Parameters<typeof savedSourceLaunch>[2]), { ...(signal ? { signal } : {}), resolveLiveSource: options.resolveLiveSource, retention: 'caller', operationId: caller.owner.operationId });
    return admitted;
  };
  const releaseManaged = async (caller: ExperimentCaller, admitted: Extract<ExperimentSourceAdmission, { kind: 'managed' }>) => {
    if (caller.owner.runtime !== 'agent' || caller.owner.source.resource_owner.kind !== 'managed_host'
      || !isDeepStrictEqual(caller.owner.source, admitted.selection) || admitted.address.coordinatorHostId !== options.runtime().coordinatorHostId)
      throw new Error('Original managed research cleanup owner changed');
    const service = await options.runtime().managedSource(caller.owner.source.resource_owner);
    const result = await service.release({ ...admitted.address, mode: 'retire' }) as { authorityId?: string; phase?: string };
    if (result?.authorityId !== admitted.address.authorityId || result.phase !== 'retired') throw new Error('Original managed research source has not drained');
  };
  // Release only this original Operation's recorded pin. Cleanup does not reacquire source
  // reading or physical-root authority after trust has been withdrawn.
  const releaseFixedPin = async (caller: ExperimentCaller, admitted?: Extract<ExperimentSourceAdmission, { kind: 'fixed' }>): Promise<boolean> => {
    const owner = caller.owner;
    if (owner.runtime === 'agent' && 'source' in owner && owner.source.resource_owner.kind === 'managed_host') throw new Error('Managed experiment input cleanup requires its original remote source owner');
    if (owner.runtime !== 'agent' || !('operationId' in owner) || owner.source.mode !== 'fixed_branch'
      || !owner.source.branch_id || owner.source.revision === null
      || caller.workspaceId !== owner.source.workspace_id || caller.executionWorkspaceId !== owner.source.execution_workspace_id)
      throw new Error('Original fixed research cleanup owner is required');
    const pinId = `research-input:${owner.operationId}`;
    if (admitted && (!isDeepStrictEqual(admitted.selection, owner.source) || admitted.pinId !== pinId
      || admitted.branchId !== owner.source.branch_id || admitted.revision !== owner.source.revision))
      throw new Error('Original fixed research admission differs');
    const runtime = options.runtime();
    const [run, launch, operation] = await Promise.all([runtime.run(owner.runId), runtime.launch(owner.runId), runtime.operation(owner.operationId)]);
    if (run.id !== owner.runId || run.thread_id !== owner.threadId || run.branch_id !== owner.branchId
      || !launch || !isDeepStrictEqual(launch.selection.source, owner.source)
      || operation.id !== owner.operationId || operation.run_id !== run.id || operation.lifetime !== 'thread'
      || operation.execution_owner?.kind !== 'external' || !isDeepStrictEqual(operation.execution_owner, owner.executionOwner))
      throw new Error('Original research cleanup attribution changed');
    const grant = await options.kernel.issueGrant({ grantId: `research-source-cleanup:${randomUUID()}`,
      threadId: run.thread_id, runId: run.id, operationId: operation.id,
      owningWorkspace: owner.source.workspace_id, executionWorkspace: owner.source.execution_workspace_id,
      capabilities: ['storage.read', 'storage.maintenance'], pathScopes: [''] });
    const client = options.kernel.scoped(grant);
    try {
      const receiptId = `research-input-pin:${owner.operationId}`;
      const receipt = await client.getOperation(receiptId);
      if (!receipt) {
        if (admitted) throw new Error('Original fixed source pin receipt is unavailable');
        return true;
      }
      if (receipt.state !== 'committed') return false;
      const result = receipt.result as { pinId?: string; branchId?: string; workspaceId?: string; revision?: number; view?: string; root?: string } | undefined;
      if (receipt.operationId !== receiptId || receipt.kind !== 'branch.pin' || !result || result.pinId !== pinId
        || result.branchId !== owner.source.branch_id || result.workspaceId !== owner.source.workspace_id
        || result.view !== 'revision' || result.revision !== owner.source.revision || typeof result.root !== 'string' || !result.root
        || admitted && result.root !== admitted.root)
        throw new Error('Original fixed source pin receipt differs');
      await client.unpinBranch({ operationId: `research-input-unpin:${owner.operationId}`, branchId: owner.source.branch_id, pinId });
      return true;
    } finally { await options.kernel.retireGrant(grant.grantId); }
  };
  return {
    async admit(caller, cwd, signal) {
      const owner = caller.owner;
      if (owner.runtime !== 'agent' || !('operationId' in owner))
        throw new Error('Native research source provenance is required');
      const source = await open(caller, signal);
      let retained = false;
      try {
        if (source.kind === 'managed') {
          const address = { coordinatorHostId: options.runtime().coordinatorHostId, authorityId: source.binding.authorityId,
            resourceEpoch: source.binding.resourceEpoch };
          const result = await source.service.service({ ...address, requestId: randomUUID(),
            operation: { kind: 'experiment_admit', operationId: owner.operationId, ...(cwd === undefined ? {} : { cwd }) } }, signal);
          if (relative(result.cwd) !== result.cwd) throw new Error('Managed experiment cwd changed');
          signal?.throwIfAborted(); retained = true;
          return { kind: 'managed', selection: owner.source, address, physicalRoot: source.binding.physicalRoot, cwd: result.cwd };
        }
        if (owner.source.mode === 'fixed_branch') {
          if (!owner.source.branch_id || owner.source.revision === null)
            throw new Error('Fixed source identity missing');
          const branch = await source.client.readBranch({ branchId: owner.source.branch_id, revision: owner.source.revision, includeEntries: false }, signal);
          const selectedCwd = relative(cwd ?? "");
          const pinId = `research-input:${owner.operationId}`;
          const pinned = await source.client.pinBranch({ operationId: `research-input-pin:${owner.operationId}`, branchId: owner.source.branch_id,
            revision: owner.source.revision, pinId });
          if (pinned.root !== branch.root || pinned.pinId !== pinId)
            throw new Error('Research source pin differs from its exact revision');
          return { kind: 'fixed', selection: owner.source, branchId: owner.source.branch_id, revision: owner.source.revision, root: branch.root, pinId, cwd: selectedCwd };
        }
        if (!source.canonicalRoot)
          throw new Error('Physical research source root missing');
        let directory = relative(cwd && !path.isAbsolute(cwd) ? cwd : '');
        if (cwd && path.isAbsolute(cwd)) {
          const exact = await canonicalizePathIdentity(cwd);
          if (!isPathWithinRoot(exact, source.canonicalRoot))
            throw new Error('Experiment cwd escapes the original source');
          directory = relative(path.relative(source.canonicalRoot, exact));
        }
        return { kind: 'physical', selection: owner.source, canonicalRoot: source.canonicalRoot, cwd: directory };
      }
      finally {
        if (!retained) await source.release();
      }
    },
    async capture(caller, admitted, capture) {
      if (caller.owner.runtime !== 'agent' || !isDeepStrictEqual(caller.owner.source, admitted.selection))
        throw new Error('Experiment capture source changed');
      if (!('operationId' in caller.owner))
        throw new Error('Original capture operation is missing');
      const operationId = caller.owner.operationId;
      const operation = await options.runtime().operation(operationId, capture.signal);
      if (operation.cancel_requested)
        throw new ExperimentInputCaptureError('Original research operation no longer admits capture', false, { drained: true, retryable: false, cause: undefined });
      if (admitted.kind === 'managed') {
        if (admitted.selection.resource_owner.kind !== 'managed_host' || !capture.captureScopes) throw new Error('Original managed research input is unavailable');
        const service = await options.runtime().managedSource(admitted.selection.resource_owner, capture.signal);
        const captureScopes = [...new Set(capture.captureScopes.map(relative))].sort();
        let dispatched = false;
        let installing = false;
        try {
          const input = await service.service({ ...admitted.address, requestId: randomUUID(), operation: {
            kind: 'experiment_capture', operationId, cwd: admitted.cwd, captureScopes } }, capture.signal);
          if (input.snapshot.workspaceId !== caller.workspaceId || input.snapshot.executionWorkspaceId !== caller.executionWorkspaceId
            || (input.snapshot.cwd ?? '') !== admitted.cwd || !isDeepStrictEqual(input.snapshot.captureScopes, captureScopes)
            || admitted.selection.mode === 'fixed_branch' && (input.snapshot.source.kind !== 'fixed-branch'
              || input.snapshot.source.branchId !== admitted.selection.branch_id || input.snapshot.source.revision !== admitted.selection.revision
              || input.snapshot.source.root !== input.snapshot.root)
            || admitted.selection.mode !== 'fixed_branch' && (input.snapshot.source.kind !== 'physical-capture'
              || input.snapshot.sourceRoot !== admitted.physicalRoot?.canonicalRoot)) throw new Error('Managed experiment input source changed');
          installing = true;
          return await installExperimentInput(options.kernel, caller, input, admitted.selection, admitted.address.resourceEpoch,
            (name, offset, length, signal) => service.service({ ...admitted.address, requestId: randomUUID(), operation: {
              kind: 'experiment_read', operationId, path: name, offset, length } }, signal),
            { ...capture, beforeBranchCreate: async value => { await capture.beforeBranchCreate?.(value); dispatched = true; } });
        } catch (error) {
          // A source-side branch create is not the coordinator's input create.
          const localFailure = installing && error instanceof ExperimentInputCaptureError ? error : undefined;
          let drained = false;
          try { await releaseManaged(caller, admitted); drained = localFailure?.drained !== false; }
          catch (cleanup) { throw new ExperimentInputCaptureError('Managed experiment input cleanup is unconfirmed',
            localFailure?.branchCreateDispatched ?? dispatched,
            { drained: false, retryable: true, cause: new AggregateError([error, cleanup]) }); }
          throw new ExperimentInputCaptureError(error instanceof Error ? error.message : String(error),
            localFailure?.branchCreateDispatched ?? dispatched,
            { drained, retryable: localFailure?.retryable ?? false, cause: error });
        }
      }
      const source = await open(caller, capture.signal);
      if (source.kind !== 'local') { await source.release(); throw new Error('Research input owner changed'); }
      let dispatched = false;
      let drained = true;
      try {
        if (admitted.kind === 'physical') {
          if (source.canonicalRoot !== admitted.canonicalRoot || !source.rootId)
            throw new Error('Original physical research root changed');
          return await prepareExperimentInput(options.kernel, caller, admitted.canonicalRoot, { ...capture, cwd: admitted.cwd,
            sourceAuthority: { scoped: source.client, rootId: source.rootId } });
        }
        if (!capture.branchId)
          throw new Error('Research input candidate needs its original stable branch identity');
        const branch = await source.client.readBranch({ branchId: admitted.branchId, revision: admitted.revision, includeEntries: false }, capture.signal);
        if (branch.root !== admitted.root)
          throw new Error('Fixed research revision changed');
        const candidate: Omit<ExperimentInputSnapshot, 'root'> = { schemaVersion: 2, branchId: capture.branchId, sourceRoot: null,
          workspaceId: caller.workspaceId, executionWorkspaceId: caller.executionWorkspaceId, captureScopes: [...(caller.workspaceScope ?? [])],
          capturedPathCount: null, inventoryFingerprint: null, captureSemantics: null,
          source: { kind: 'fixed-branch', branchId: admitted.branchId, revision: admitted.revision, root: admitted.root },
          ...(admitted.cwd ? { cwd: admitted.cwd } : {}) };
        if (admitted.cwd) {
          const selected = await source.client.readBranch({ branchId: admitted.branchId, revision: admitted.revision, paths: [admitted.cwd], includeEntries: true }, capture.signal);
          if (!selected.entries.some(e => e.path === admitted.cwd && e.state.kind === 'directory'))
            throw new Error('Fixed research cwd is not a directory');
        }
        await capture.beforeBranchCreate?.(candidate);
        capture.signal?.throwIfAborted();
        dispatched = true;
        const created = await source.client.createBranch({ operationId: `experiment-input-branch:${capture.branchId}`, branchId: capture.branchId,
          workspaceId: caller.workspaceId, baseRef: `pin:${admitted.pinId}`, entries: [], draftBasePaths: [], captureScopes: [...(caller.workspaceScope ?? [])] });
        if (created.root !== admitted.root || created.branchId !== capture.branchId)
          throw new Error('Fixed experiment input creation changed its immutable root');
        return { ...candidate, root: admitted.root };
      }
      catch (error) {
        if (error instanceof ExperimentInputCaptureError && !error.drained) drained = false;
        if (admitted.kind === 'fixed')
          throw new ExperimentInputCaptureError(error instanceof Error ? error.message : String(error), dispatched, { drained: true, retryable: dispatched, cause: error });
        throw error;
      }
      finally {
        if (drained) await source.release();
      }
    },
    async reconcileUnaccepted(caller) {
      const owner = caller.owner;
      if (owner.runtime !== 'agent' || !('operationId' in owner))
        throw new Error('Original domain invocation is required');
      if (owner.source.resource_owner.kind === 'managed_host') {
        const runtime = options.runtime(), service = await runtime.managedSource(owner.source.resource_owner);
        const authorities = await service.inspectScope({ coordinatorHostId: runtime.coordinatorHostId, threadId: owner.threadId, runId: owner.runId });
        for (const authority of authorities.filter(value => value.operationId === owner.operationId && value.purpose === 'source')) {
          if (!isDeepStrictEqual(authority.binding.source, owner.source)) throw new Error('Original research cleanup source changed');
          await releaseManaged(caller, { kind: 'managed', selection: owner.source, cwd: '', physicalRoot: authority.binding.physicalRoot,
            address: { coordinatorHostId: runtime.coordinatorHostId, authorityId: authority.binding.authorityId, resourceEpoch: authority.binding.resourceEpoch } });
        }
        return true;
      }
      // Physical admission only reads source identity. No capture/worker can begin before the
      // original attempt row. A fixed admission may additionally own this exact durable pin.
      if (owner.source.mode !== 'fixed_branch') {
        await options.kernel.retireOperationGrants(owner.operationId);
        return true;
      }
      const drained = await releaseFixedPin(caller);
      if (drained) await options.kernel.retireOperationGrants(owner.operationId);
      return drained;
    },
    async release(caller, admitted) {
      if (admitted.kind === 'managed') { await releaseManaged(caller, admitted); return; }
      if (admitted.kind !== 'fixed')
        return;
      if (!await releaseFixedPin(caller, admitted))
        throw new Error('Original fixed source pin has not drained');
    },
  };
}
