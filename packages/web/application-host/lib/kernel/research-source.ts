/** Original Run source authority handed to ExperimentService's accepted worker. */
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { LiveSourceResolver } from './live-source.js';
import type { LaunchSource } from './protocol.generated.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import type { ExperimentCaller } from '../harness/research-identity.js';
import { prepareExperimentInput, type ExperimentInputSnapshot, type PrepareExperimentInputOptions, ExperimentInputCaptureError } from '../harness/experiment-workspace.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';
export type ExperimentSourceAdmission = {
  selection: LaunchSource;
  cwd: string;
} & ({
  kind: 'physical';
  canonicalRoot: string;
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
    return admitRunSourceAuthority(options.kernel, runtime, savedSourceLaunch(caller.owner.runId, caller.owner.source, sourceToolSchemas(launch.selection).map(tool => tool.name) as Parameters<typeof savedSourceLaunch>[2]), { ...(signal ? { signal } : {}), resolveLiveSource: options.resolveLiveSource, retention: 'caller', operationId: caller.owner.operationId });
  };
  return {
    async admit(caller, cwd, signal) {
      const owner = caller.owner;
      if (owner.runtime !== 'agent' || !('operationId' in owner))
        throw new Error('Native research source provenance is required');
      const source = await open(caller, signal);
      try {
        if (owner.source.mode === 'fixed_branch') {
          if (!owner.source.branch_id || owner.source.revision === null)
            throw new Error('Fixed source identity missing');
          const branch = await source.client.readBranch({ branchId: owner.source.branch_id, revision: owner.source.revision, includeEntries: false }, signal);
          const selectedCwd = relative(cwd ?? "");
          const pinId = `research-input:${owner.operationId}`;
          const pinned = await source.client.pinBranch({ operationId: `research-input-pin:${owner.operationId}`, branchId: owner.source.branch_id,
            revision: owner.source.revision, pinId, persistent: true });
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
        await source.release();
      }
    },
    async capture(caller, admitted, capture) {
      if (caller.owner.runtime !== 'agent' || !isDeepStrictEqual(caller.owner.source, admitted.selection))
        throw new Error('Experiment capture source changed');
      if (!('operationId' in caller.owner))
        throw new Error('Original capture operation is missing');
      const operation = await options.runtime().operation(caller.owner.operationId, capture.signal);
      if (operation.cancel_requested)
        throw new ExperimentInputCaptureError('Original research operation no longer admits capture', false, { drained: true, retryable: false, cause: undefined });
      const source = await open(caller, capture.signal);
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
      // Physical admission only reads source identity. No capture/worker can begin before the
      // original attempt row. A fixed admission may additionally own this exact durable pin.
      if (owner.source.mode !== 'fixed_branch') {
        await options.kernel.retireOperationGrants(owner.operationId);
        return true;
      }
      const source = await open(caller);
      let drained = false;
      try {
        const receipt = await source.client.getOperation(`research-input-pin:${owner.operationId}`);
        if (!receipt) { drained = true; return true; }
        if (receipt.state !== 'committed')
          return false;
        const result = receipt.result as {
          pinId?: string;
          branchId?: string;
          root?: string;
        } | undefined;
        const pinId = `research-input:${owner.operationId}`;
        if (!result || result.pinId !== pinId || result.branchId !== owner.source.branch_id)
          throw new Error('Original fixed source pin receipt differs');
        await source.client.unpinBranch({ operationId: `research-input-unpin:${owner.operationId}`, branchId: owner.source.branch_id!, pinId });
        drained = true;
        return true;
      }
      finally {
        await source.release();
        if (drained) await options.kernel.retireOperationGrants(owner.operationId);
      }
    },
    async release(caller, admitted) {
      if (admitted.kind !== 'fixed')
        return;
      const source = await open(caller);
      try {
        await source.client.unpinBranch({ operationId: `research-input-unpin:${caller.owner.runtime === 'agent' && 'operationId' in caller.owner ? caller.owner.operationId : ''}`,
          branchId: admitted.branchId, pinId: admitted.pinId });
      }
      finally {
        await source.release();
      }
    },
  };
}
