/** The resource Host re-enters its original Recovery owner under current permission.
 * Retained Source records prove attribution; they never revive an execution grant. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import type { RecoveryFileTarget } from '@varin/extension-contract';
import type { DocumentAuthority } from '../documents/authority.js';
import type { ManagedRecoveryReply, ManagedRecoveryRequest } from '../harness/managed-recovery-contract.js';
import type { ManagedSourcePrincipal } from '../harness/managed-remote-types.js';
import { RecoveryPrimitiveError } from '../recovery/errors.js';
import type { RecoveryIdentity } from '../recovery/journal-files.js';
import type { RecoveryFileParticipantEngine } from '../recovery/managed-recovery-coordinator.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import { KernelFileResourceBackend } from './file-resource-backend.js';
import type { KernelClient } from './kernel-client.js';
import type { KernelRecoveryStore } from './kernel-recovery-store.js';
import type { LiveSourceResolver } from './live-source.js';
import type { LaunchSource, SourceAuthorityResult } from './protocol.generated.js';
import { SourceAdmissionError } from './source-admission-error.js';
import { admitMaterializedRoot } from './source-launch.js';
import type { KernelStorageAdapter } from './storage-adapter.js';
import { restoreFilesWithEditors, type RecoveryEditors } from '../recovery/file-recovery-editors.js';
import {sameRecoveryFileTarget} from '../recovery/file-target.js';

type PhysicalTarget = Extract<RecoveryFileTarget, { kind: 'physical' }>;
interface AdmittedTarget { source: LaunchSource; target: PhysicalTarget; canDelete: boolean }
export interface ManagedRecoveryServiceOptions {
  hostId: string;
  kernel: KernelClient;
  documents: Pick<DocumentAuthority, 'admitWorkspaceRegistration'> & RecoveryEditors;
  storage: KernelStorageAdapter;
  store: Pick<KernelRecoveryStore, 'recordTurnStart' | 'recordTurnSettled' | 'getTurn'>;
  recovery: RecoveryFileParticipantEngine;
  validateLiveSource: LiveSourceResolver;
}

export function createManagedRecoveryService(options: ManagedRecoveryServiceOptions) {
  // Request-local source proofs only. The original Recovery journal owns every
  // plan, checkpoint, safety object, file phase and receipt across Host restarts.
  const active = new AsyncLocalStorage<AdmittedTarget[]>();
  const denied = (message: string): never => {
    throw new RecoveryPrimitiveError('workspace-untrusted', message, { origin: 'storage' });
  };
  const registrations = async (source: LaunchSource, signal?: AbortSignal) => {
    await options.documents.admitWorkspaceRegistration(source.workspace_id, signal);
    if(source.mode==='native_workspace')await options.kernel.nativeWorkspaces?.open(source,signal);
    if (source.execution_workspace_id !== source.workspace_id) {
      await options.documents.admitWorkspaceRegistration(source.execution_workspace_id, signal);
    }
  };
  const fileResources = async ({ source, target, canDelete }: AdmittedTarget, signal?: AbortSignal) => {
    await registrations(source, signal);
    if (source.mode === 'live_root') {
      if (!source.live_root || source.live_root.rootId !== target.rootId
        || normalizePathIdentity(source.live_root.canonicalRoot) !== normalizePathIdentity(target.canonicalRoot)) {
        return denied('Recovery live root differs from its original Source');
      }
      await options.validateLiveSource({ workspaceId: source.workspace_id,
        executionWorkspaceId: source.execution_workspace_id, liveRoot: source.live_root }, signal);
    } else if(source.mode==='native_workspace'){
      const owner=options.kernel.nativeWorkspaces;if(!owner)throw new Error('Native recovery source is unavailable');
      const entry=await owner.open(source,signal),view=await owner.acquire(source,entry.grant,signal);
      if(view.rootId!==target.rootId||normalizePathIdentity(view.path)!==normalizePathIdentity(target.canonicalRoot))return denied('Native recovery branch or mount changed');
    }else {
      const root = await admitMaterializedRoot(target.canonicalRoot, signal);
      if (normalizePathIdentity(root) !== normalizePathIdentity(target.canonicalRoot)) {
        return denied('Original recovery materialization changed');
      }
    }
    signal?.throwIfAborted();
    const authority = await options.storage.fileAuthorityContext({ owningWorkspaceId: source.workspace_id,
      executionWorkspaceId: source.execution_workspace_id, canonicalRoot: target.canonicalRoot,
      purpose: 'recovery-maintenance', capabilities: ['recovery.maintenance'] });
    if (authority.rootId !== target.rootId
      || normalizePathIdentity(authority.canonicalRoot) !== normalizePathIdentity(target.canonicalRoot)) {
      return denied('Recovery registration differs from its original physical root');
    }
    return new KernelFileResourceBackend(options.storage, { authority, authorizeApplyState(_identity, _path, state) {
      if (state.kind === 'missing' && !canDelete) {
        denied('The target Host has not granted filesystem:delete for this recovery path');
      }
    } });
  };
  const resolveFileResources = async (identity: RecoveryIdentity): Promise<KernelFileResourceBackend | null> => {
    const targets = active.getStore();
    if (!targets) return null;
    const admitted = targets.find(value => sameRecoveryFileTarget(value.target, identity.fileTarget));
    if (!admitted || identity.workspaceId !== admitted.target.workspaceId
      || normalizePathIdentity(identity.canonicalRoot) !== normalizePathIdentity(admitted.target.canonicalRoot)) {
      return denied('Recovery path is outside the current authenticated file participant');
    }
    // Recheck actual registration and trust at every original file-owner entry.
    return fileResources(admitted);
  };
  const handle = async (principal: ManagedSourcePrincipal, input: ManagedRecoveryRequest,
    signal?: AbortSignal): Promise<ManagedRecoveryReply> => {
    if (!principal.principalId || !['filesystem:read', 'filesystem:write'].every(value => principal.capabilities.includes(value))) {
      throw new SourceAdmissionError('source_authority_denied');
    }
    const request = structuredClone(input);
    const { binding, action, coordinatorHostId } = request;
    if (!coordinatorHostId || !binding.operationId || !binding.workspaceId || binding.conversation.kind !== 'thread'
      || !binding.conversation.threadId || !binding.conversation.branchId || !binding.turns.length
      || !binding.turns.some(value => value.turn.source?.workspace_id === binding.workspaceId)) {
      return denied('Recovery requires its original coordinator, Thread and target workspace');
    }
    if (action.kind === 'apply' && action.input.operationId !== binding.operationId) {
      return denied('Recovery apply differs from its original operation');
    }
    await options.kernel.start();
    const targets: AdmittedTarget[] = [];
    const turns: Array<{ selection: typeof binding.turns[number]; target?: PhysicalTarget }> = [];
    const executions = new Set<string>();
    for (const selection of binding.turns) {
      const { turn } = selection;
      const { anchor, source } = turn;
      if (!source || source.resource_owner.kind !== 'managed_host' || source.resource_owner.hostId !== options.hostId
        || anchor.threadId !== binding.conversation.threadId || !anchor.branchId || !anchor.runId || !anchor.entryId
        || anchor.executionId !== `${anchor.runId}:${anchor.entryId}` || executions.has(anchor.executionId)) {
        return denied('Recovery checkpoint differs from its original Thread Source');
      }
      executions.add(anchor.executionId);
      const originals = await options.kernel.sourceRequest<SourceAuthorityResult[]>('source.authority.inspect_scope', {
        principalId: principal.principalId, coordinatorHostId, threadId: anchor.threadId, runId: anchor.runId,
      }, signal);
      const matching = originals.filter(original => original.scope.kind === 'run'
        && original.scope.threadId === anchor.threadId && original.scope.runId === anchor.runId
        && isDeepStrictEqual(original.source, source));
      if (!matching.length) return denied('Recovery has no original Source belonging to this authenticated coordinator');
      await registrations(source, signal);
      if (source.mode === 'fixed_branch') { turns.push({ selection }); continue; }
      const roots = matching.flatMap(original => original.physicalRoot ? [original.physicalRoot] : []);
      let root = roots[0];
      if (!root || root.hostId !== options.hostId || roots.some(value => source.mode==='native_workspace'?value.rootId!==root!.rootId:!isDeepStrictEqual(value, root))) {
        return denied('Recovery has no unambiguous original physical Source');
      }
      if(source.mode==='native_workspace'){
        const owner=options.kernel.nativeWorkspaces;if(!owner)throw new Error('Native recovery source is unavailable');
        const entry=await owner.open(source,signal),view=await owner.acquire(source,entry.grant,signal);
        if(root.rootId!==view.rootId)return denied('Native recovery branch or scope changed');
        root={hostId:options.hostId,rootId:view.rootId,canonicalRoot:view.path};
      }
      const target: PhysicalTarget = { kind: 'physical', workspaceId: source.workspace_id,
        executionWorkspaceId: source.execution_workspace_id, threadId: anchor.threadId, runId: anchor.runId,
        rootId: root.rootId, canonicalRoot: root.canonicalRoot, sourceMode: source.mode };
      const admitted = { source, target, canDelete: principal.capabilities.includes('filesystem:delete') };
      // A retired/old-epoch original is evidence only. This obtains current
      // maintenance permission and never calls sourceAuthorityGrant or bind.
      await fileResources(admitted, signal);
      if (!targets.some(value => isDeepStrictEqual(value.target, target))) targets.push(admitted);
      turns.push({ selection, target });
    }
    signal?.throwIfAborted();
    const { operationId, ...originalBinding } = binding;
    const access = { operationId, binding: { principalId: principal.principalId, coordinatorHostId, ...originalBinding } };
    return active.run(targets, async () => {
      if (action.kind === 'files') {
        const target = targets[0];
        if (!target || action.input.threadId !== binding.conversation.threadId
          || action.input.sourceRunId !== target.target.runId || (action.input.operationId && action.input.operationId !== binding.operationId)) {
          return denied('File recovery differs from its original source');
        }
        if (action.input.journal && !turns.some(value => isDeepStrictEqual(value.selection.turn.anchor, action.input.journal)
          && value.target?.rootId === target.target.rootId)) return denied('File recovery has no original active-round journal');
        if (action.method === 'recovery.files.restore' && !target.canDelete) return denied('File recovery requires filesystem:delete for removing files created after the point');
        const files = await fileResources(target, signal);
        const identity = { authorityId: 'kernel', workspaceId: target.target.workspaceId,
          canonicalRoot: target.target.canonicalRoot, filesystemProfile: process.platform, fileTarget: target.target };
        const result: Record<string, unknown> = action.storage ? { storage: await files.recoveryStorage(identity) } : action.preview
          ? { preview: await files.previewRecoveryFile(identity, action.input, action.preview, signal) }
          : action.method === 'recovery.files.restore'
          ? await restoreFilesWithEditors(options.documents, files, identity, action.input, signal)
          : await files.recoveryFiles(identity, action.method, action.input, signal);
        if (Array.isArray(result.points)) result.points = result.points.map(point => ({ ...point, sourcePath: target.target.canonicalRoot }));
        result.source = { runId: target.target.runId, workspaceId: target.target.workspaceId, path: target.target.canonicalRoot };
        return { status: 'files', result };
      }
      if (action.kind === 'prepare' || action.kind === 'settle') {
        for (const { selection: { turn }, target } of turns) {
          const { anchor, source } = turn;
          if (action.kind === 'settle' && (!turn.settled || !await options.store.getTurn(source!.workspace_id, anchor.executionId))) continue;
          await options.store.recordTurnStart({ workspaceId: source!.workspace_id,
            conversation: { kind: 'thread', threadId: anchor.threadId, branchId: anchor.branchId },
            executionId: anchor.executionId, runId: anchor.runId, userEntryId: anchor.entryId,
            runtimeGeneration: anchor.epoch, workerId: 'kernel', activeWriterScopes: [], provenance: 'caused-by',
            ...(target ? { fileTarget: target } : {}) });
          if (turn.settled) await options.store.recordTurnSettled({ workspaceId: source!.workspace_id, executionId: anchor.executionId,
            ...(turn.entryIds.at(-1) ? { assistantEntryId: turn.entryIds.at(-1)! } : {}),
            activeWriterScopes: turn.uncovered ? ['process/or-external'] : [], mutationObserved: turn.uncovered,
            observationComplete: !turn.uncovered, observedResourceIds: [], provenance: 'caused-by',
            ...(!turn.settled || turn.uncovered ? { failure: { code: 'checkpoint-incomplete' as const,
              message: !turn.settled ? 'Original input work is not settled' : 'Shell or external tool effects do not have complete before-images',
              retryable: false } } : {}) });
        }
        if (action.kind === 'settle') return { status: 'settled' };
        return options.recovery.prepareFileRecovery({ ...access, workspaceId: binding.workspaceId,
          conversation: binding.conversation, entryId: action.entryId, navigation: action.navigation,
          journalTurns: turns.map(({ selection: { turn, restore } }) => ({ workspaceId: turn.source!.workspace_id,
            executionId: turn.anchor.executionId, restore })), allowedFileTargets: targets.map(value => value.target) });
      }
      switch (action.kind) {
        case 'prepare_undo': return options.recovery.prepareFileUndo({ ...access, undoOf: action.undoOf, navigation: action.navigation });
        case 'apply': return options.recovery.applyFileRecovery({ ...action.input, ...access });
        case 'read': return options.recovery.readFileRecovery(access);
        case 'complete': return options.recovery.completeFileRecovery(access);
        case 'compensate': return options.recovery.compensateFileRecovery(access);
        case 'cancel': return options.recovery.cancelFileRecovery(access);
      }
    });
  };
  const resolveFileTarget=(target:RecoveryFileTarget)=>active.getStore()?.find(value=>sameRecoveryFileTarget(value.target,target))?.target;
  return { handle, resolveFileResources,resolveFileTarget };
}
