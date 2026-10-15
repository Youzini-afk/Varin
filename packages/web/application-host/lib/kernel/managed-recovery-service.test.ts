import { describe, expect, it, vi } from 'vitest';
import type { RecoveryFileTarget, WorkspaceCombinedRecoveryOperationResult, WorkspaceCombinedRecoveryPrepareResult } from '@varin/extension-contract';
import type { ManagedRecoveryRequest } from '../harness/managed-recovery-contract.js';
import type { ManagedSourcePrincipal } from '../harness/managed-remote-types.js';
import type { RecoveryIdentity } from '../recovery/journal-files.js';
import type { RecoveryFileParticipantAccess, RecoveryFileParticipantEngine, RecoveryFileParticipantPrepare } from '../recovery/managed-recovery-coordinator.js';
import { createManagedRecoveryService } from './managed-recovery-service.js';
import type { KernelClient } from './kernel-client.js';
import type { KernelRecoveryStore } from './kernel-recovery-store.js';
import type { KernelStorageAdapter } from './storage-adapter.js';
import type { LaunchSource, SourceAuthorityResult } from './protocol.generated.js';

const principal: ManagedSourcePrincipal = { principalId: 'paired-client', capabilities: ['filesystem:read', 'filesystem:write'] };
const root = { hostId: 'target-host', rootId: 'original-root', canonicalRoot: '/project' };
const source: LaunchSource = { resource_owner: { kind: 'managed_host', hostId: 'target-host',
  connectionId: 'connection', endpointIdentity: 'endpoint' }, mode: 'live_root', workspace_id: 'workspace',
  execution_workspace_id: 'workspace', branch_id: null, revision: null, live_root: root };
const target: RecoveryFileTarget = { kind: 'physical', workspaceId: 'workspace', executionWorkspaceId: 'workspace',
  threadId: 'thread', runId: 'run', rootId: root.rootId, canonicalRoot: root.canonicalRoot, sourceMode: 'live_root' };
const identity: RecoveryIdentity = { authorityId: 'kernel', workspaceId: 'workspace', canonicalRoot: root.canonicalRoot,
  filesystemProfile: 'test', fileTarget: target };
const request = (): ManagedRecoveryRequest => ({ coordinatorHostId: 'coordinator', binding: {
  operationId: 'recovery-attempt', workspaceId: 'workspace', conversation: { kind: 'thread', threadId: 'thread', branchId: 'history' },
  turns: [{ restore: true, turn: { anchor: { executionId: 'run:input', runId: 'run', threadId: 'thread',
    branchId: 'history', entryId: 'input', epoch: 99 }, entryIds: ['input', 'answer'], source,
    settled: true, uncovered: false } }],
}, action: { kind: 'prepare', entryId: 'input', navigation: { expectedLeafId: 'answer', targetLeafId: null, removedEntryIds: ['input', 'answer'] } } });

function fixture() {
  const events: string[] = [];
  const state = { trusted: true, rootId: root.rootId, originals: [{ authorityId: 'retired-authority',
    resourceEpoch: 'old-target-epoch', phase: 'retired', grantId: 'gone-grant', source, physicalRoot: root,
    scope: { kind: 'run', threadId: 'thread', runId: 'run', epoch: 1 } }] as SourceAuthorityResult[] };
  const sourceRequest = vi.fn(async (method: string, input: { principalId: string; coordinatorHostId: string }) => {
    events.push(method);
    return input.principalId === principal.principalId && input.coordinatorHostId === 'coordinator' ? state.originals : [];
  });
  const sourceAuthorityGrant = vi.fn(() => { throw new Error('Retired grant must not be used'); });
  const kernel = { start: vi.fn(async () => ({ hostId: 'target-host', kernelEpoch: 'new-target-epoch' })),
    sourceRequest, sourceAuthorityGrant } as unknown as KernelClient;
  const admitWorkspaceRegistration = vi.fn(async (workspaceId: string) => {
    events.push('registration'); if (!state.trusted) throw new Error('Trust withdrawn');
    return { workspaceId, canonicalPath: root.canonicalRoot, hostId: root.hostId };
  });
  const fileAuthorityContext = vi.fn(async (input: Record<string, unknown>) => {
    events.push('fresh-permission');
    return { ...input, rootId: state.rootId, client: {}, canonicalRoot: root.canonicalRoot };
  });
  const storage = { fileAuthorityContext } as unknown as KernelStorageAdapter;
  const store = { recordTurnStart: vi.fn(async () => { events.push('checkpoint'); }),
    recordTurnSettled: vi.fn(async () => { events.push('settle'); }) };
  const prepareFileRecovery = vi.fn(async (input: RecoveryFileParticipantPrepare): Promise<WorkspaceCombinedRecoveryPrepareResult> => ({ status: 'ready', plan: {
    id: input.operationId, revision: 'plan-revision', affectedPaths: ['files/path'], fileTargets: { 'files/path': { path: 'a.ts', target } },
    changedBytes: 1, conflicts: [], coverage: 'ready', createdAt: '2026-10-14T00:00:00.000Z', entryId: input.entryId,
    conversation: input.conversation, workspaceId: input.workspaceId, ...input.navigation, uncoveredPaths: [], uncoveredReasons: [],
  } }));
  const operation = (input: RecoveryFileParticipantAccess): WorkspaceCombinedRecoveryOperationResult => ({ status: 'ready',
    operation: { id: input.operationId, revision: 'operation-revision', state: 'files-restored', fileState: 'restored' } } as WorkspaceCombinedRecoveryOperationResult);
  const recovery = { prepareFileRecovery, prepareFileUndo: vi.fn(async () => ({ status: 'failed', failure: { code: 'unavailable', message: 'unused', retryable: false } })),
    applyFileRecovery: vi.fn(async (input: RecoveryFileParticipantAccess) => operation(input)),
    readFileRecovery: vi.fn(async (input: RecoveryFileParticipantAccess) => operation(input)),
    completeFileRecovery: vi.fn(async (input: RecoveryFileParticipantAccess) => operation(input)),
    compensateFileRecovery: vi.fn(async (input: RecoveryFileParticipantAccess) => operation(input)),
    cancelFileRecovery: vi.fn(async (input: RecoveryFileParticipantAccess) => operation(input)) };
  const validateLiveSource = vi.fn(async () => { events.push('live-source'); });
  const service = createManagedRecoveryService({ hostId: 'target-host', kernel,
    documents: { admitWorkspaceRegistration } as never, storage, store: store as unknown as KernelRecoveryStore,
    recovery: recovery as RecoveryFileParticipantEngine, validateLiveSource });
  return { service, recovery, store, state, events, sourceRequest, sourceAuthorityGrant, fileAuthorityContext,
    admitWorkspaceRegistration, validateLiveSource };
}

describe('managed Recovery original file owner', () => {
  it('uses retired old-epoch Source facts with fresh permission and the original checkpoint owner', async () => {
    const h = fixture();
    const result = await h.service.handle(principal, request());
    expect(result.status).toBe('ready');
    expect(h.sourceRequest).toHaveBeenCalledWith('source.authority.inspect_scope', {
      principalId: principal.principalId, coordinatorHostId: 'coordinator', threadId: 'thread', runId: 'run',
    }, undefined);
    expect(h.sourceAuthorityGrant).not.toHaveBeenCalled();
    expect(h.fileAuthorityContext).toHaveBeenCalledWith({ owningWorkspaceId: 'workspace', executionWorkspaceId: 'workspace',
      canonicalRoot: '/project', purpose: 'recovery-maintenance', capabilities: ['recovery.maintenance'] });
    expect(h.store.recordTurnStart).toHaveBeenCalledWith(expect.objectContaining({ executionId: 'run:input',
      conversation: { kind: 'thread', threadId: 'thread', branchId: 'history' }, runId: 'run', userEntryId: 'input',
      runtimeGeneration: 99, fileTarget: target }));
    expect(h.store.recordTurnSettled).toHaveBeenCalledWith(expect.objectContaining({ observationComplete: true, assistantEntryId: 'answer' }));
    expect(h.recovery.prepareFileRecovery).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'recovery-attempt',
      journalTurns: [{ workspaceId: 'workspace', executionId: 'run:input', restore: true }], allowedFileTargets: [target],
      binding: { principalId: principal.principalId, coordinatorHostId: 'coordinator',
        workspaceId: 'workspace', conversation: request().binding.conversation, turns: request().binding.turns } }));
    expect(h.events.indexOf('fresh-permission')).toBeLessThan(h.events.indexOf('checkpoint'));
    expect(JSON.stringify(result)).not.toContain('objectHash');
  });

  it('rejects withdrawn capability, trust, original ownership and changed registration before Recovery enters', async () => {
    for (const reason of ['capability', 'trust', 'principal', 'coordinator', 'root'] as const) {
      const h = fixture(); const input = request();
      let actor = principal;
      if (reason === 'capability') actor = { ...principal, capabilities: ['filesystem:read'] };
      if (reason === 'trust') h.state.trusted = false;
      if (reason === 'principal') actor = { ...principal, principalId: 'other-client' };
      if (reason === 'coordinator') input.coordinatorHostId = 'other-coordinator';
      if (reason === 'root') h.state.rootId = 'replacement-root';
      await expect(h.service.handle(actor, input)).rejects.toThrow();
      expect(h.store.recordTurnStart).not.toHaveBeenCalled();
      expect(h.recovery.prepareFileRecovery).not.toHaveBeenCalled();
    }
  });

  it('rejects a substituted source and multiple conflicting original roots', async () => {
    const h = fixture(); const input = request();
    input.binding.turns[0]!.turn.source = { ...source, execution_workspace_id: 'other-workspace' };
    await expect(h.service.handle(principal, input)).rejects.toThrow('no original Source');
    h.state.originals.push({ ...h.state.originals[0]!, physicalRoot: { ...root, rootId: 'other-root' } });
    await expect(h.service.handle(principal, request())).rejects.toThrow('unambiguous');
    expect(h.fileAuthorityContext).not.toHaveBeenCalled();
  });

  it('keeps each source workspace and root when one participant spans multiple target registrations', async () => {
    const h = fixture(); const input = request();
    const secondRoot = { ...root, rootId: 'second-root', canonicalRoot: '/second-project' };
    const secondSource: LaunchSource = { ...source, workspace_id: 'second-workspace',
      execution_workspace_id: 'second-workspace', live_root: secondRoot };
    input.binding.turns.push({ restore: true, turn: { ...input.binding.turns[0]!.turn, source: secondSource,
      entryIds: ['second-input'], anchor: { ...input.binding.turns[0]!.turn.anchor, executionId: 'second-run:second-input',
        runId: 'second-run', entryId: 'second-input' } } });
    h.state.originals.push({ ...h.state.originals[0]!, source: secondSource, physicalRoot: secondRoot,
      scope: { kind: 'run', runId: 'second-run', threadId: 'thread', epoch: 2 } });
    h.fileAuthorityContext.mockImplementation(async value => ({ ...value, client: {},
      canonicalRoot: String(value.canonicalRoot), rootId: value.owningWorkspaceId === 'workspace' ? root.rootId : secondRoot.rootId }));
    await h.service.handle(principal, input);
    expect(h.admitWorkspaceRegistration.mock.calls.map(([workspace]) => workspace)).toContain('second-workspace');
    expect(h.store.recordTurnStart).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'second-workspace',
      executionId: 'second-run:second-input', fileTarget: expect.objectContaining({ rootId: 'second-root', canonicalRoot: '/second-project' }) }));
    expect(h.recovery.prepareFileRecovery).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace',
      journalTurns: [{ workspaceId: 'workspace', executionId: 'run:input', restore: true },
        { workspaceId: 'second-workspace', executionId: 'second-run:second-input', restore: true }],
      allowedFileTargets: [target, expect.objectContaining({ workspaceId: 'second-workspace', rootId: 'second-root' })] }));
  });

  it('retains uncovered and unsettled coverage and fails a mismatched existing checkpoint', async () => {
    const h = fixture(); const input = request();
    input.binding.turns[0]!.turn.uncovered = true;
    await h.service.handle(principal, input);
    expect(h.store.recordTurnSettled).toHaveBeenCalledWith(expect.objectContaining({ observationComplete: false,
      activeWriterScopes: ['process/or-external'], failure: expect.objectContaining({ code: 'checkpoint-incomplete' }) }));
    const other = fixture(); other.store.recordTurnStart.mockRejectedValue(new Error('Original recovery checkpoint identity changed'));
    await expect(other.service.handle(principal, request())).rejects.toThrow('checkpoint identity changed');
    expect(other.recovery.prepareFileRecovery).not.toHaveBeenCalled();
  });

  it('only resolves authenticated physical targets inside the active Recovery request and rechecks trust', async () => {
    const h = fixture();
    expect(await h.service.resolveFileResources(identity)).toBeNull();
    h.recovery.readFileRecovery.mockImplementation(async input => {
      expect(await h.service.resolveFileResources(identity)).not.toBeNull();
      await expect(h.service.resolveFileResources({ ...identity, fileTarget: { ...target, runId: 'other-run' } })).rejects.toThrow('outside');
      h.state.trusted = false;
      await expect(h.service.resolveFileResources(identity)).rejects.toThrow('Trust withdrawn');
      return { status: 'ready', operation: { id: input.operationId } } as WorkspaceCombinedRecoveryOperationResult;
    });
    await h.service.handle(principal, { ...request(), action: { kind: 'read' } });
    expect(await h.service.resolveFileResources(identity)).toBeNull();
    expect(h.fileAuthorityContext).toHaveBeenCalledTimes(2);
    expect(h.store.recordTurnStart).not.toHaveBeenCalled();
  });

  it('continues the exact original journal operation and keeps an obtained receipt after trust changes', async () => {
    const h = fixture();
    h.recovery.applyFileRecovery.mockImplementation(async input => {
      h.state.trusted = false;
      return { status: 'ready', operation: { id: input.operationId, state: 'files-restored' } } as WorkspaceCombinedRecoveryOperationResult;
    });
    const input = { ...request(), action: { kind: 'apply' as const, input: { operationId: 'recovery-attempt',
      expectedRevision: 'reviewed-plan', conflictPolicy: 'abort' as const, confirmedConflicts: [] } } };
    expect(await h.service.handle(principal, input)).toMatchObject({ status: 'ready', operation: { state: 'files-restored' } });
    expect(h.recovery.applyFileRecovery).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'recovery-attempt',
      expectedRevision: 'reviewed-plan', binding: expect.objectContaining({ principalId: principal.principalId }) }));
    await expect(h.service.handle(principal, { ...request(), action: { kind: 'compensate' } })).rejects.toThrow('Trust withdrawn');
    expect(h.recovery.compensateFileRecovery).not.toHaveBeenCalled();
    input.action.input.operationId = 'different-operation';
    await expect(h.service.handle(principal, input)).rejects.toThrow('original operation');
  });

  it('checks deletion separately at the real apply boundary while admitting non-deleting recovery', async () => {
    const h = fixture();
    let canDelete = false;
    h.recovery.readFileRecovery.mockImplementation(async input => {
      const backend = (await h.service.resolveFileResources(identity))!;
      await expect(backend.assertApplyState(identity, 'a.ts', { kind: 'directory' })).resolves.toBeUndefined();
      if (canDelete) {
        await expect(backend.assertApplyState(identity, 'created.ts', { kind: 'missing' })).resolves.toBeUndefined();
      } else {
        await expect(backend.assertApplyState(identity, 'created.ts', { kind: 'missing' })).rejects.toThrow('filesystem:delete');
        // The original apply owner checks again, including compensation to a
        // missing safety state; callers cannot skip the plan-time check.
        await expect(backend.applyStateDetailed(identity, 'created.ts', { kind: 'missing' })).rejects.toThrow('filesystem:delete');
      }
      return { status: 'ready', operation: { id: input.operationId } } as WorkspaceCombinedRecoveryOperationResult;
    });
    await h.service.handle(principal, { ...request(), action: { kind: 'read' } });
    canDelete = true;
    await h.service.handle({ ...principal, capabilities: [...principal.capabilities, 'filesystem:delete'] },
      { ...request(), action: { kind: 'read' } });
  });
});
