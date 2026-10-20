import type { RecoveryConversation } from '@varin/extension-contract';
import type { ThreadAdapter } from '../kernel/thread-adapter.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelRecoveryStore } from '../kernel/kernel-recovery-store.js';
import type { KernelStorageAdapter } from '../kernel/storage-adapter.js';
import { KernelClientError, type KernelClient } from '../kernel/kernel-client.js';
import type { LiveSourceOwner } from '../kernel/live-source.js';
import { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
import { admitMaterializedRoot, originalMaterializationLocation } from '../kernel/source-launch.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import type { RecoveryIdentity } from './journal-files.js';
import type { RecoverySessionNavigation } from './journal-engine.js';
import { RecoveryPrimitiveError } from './errors.js';
interface Owners {
    threads: ThreadAdapter;
    runtime: AgentRuntimeClient;
    store: KernelRecoveryStore;
    storage: KernelStorageAdapter;
    kernel: KernelClient;
    liveSources: LiveSourceOwner;
}
const identity = (conversation: RecoveryConversation) => {
    if (conversation.kind !== 'thread')
        throw new Error('Thread navigation requires its original Thread');
    return { runtime: 'agent' as const, threadId: conversation.threadId, branchId: conversation.branchId };
};
export function createThreadRecoveryNavigation(owners: Owners): RecoverySessionNavigation {
    const { threads, runtime, store } = owners;
    const commit: RecoverySessionNavigation['commitLeaf'] = async (input) => {
        const selected = identity(input.conversation);
        const command = { ...selected, key: input.operationId, expectedHeadId: input.expectedLeafId, targetHeadId: input.preparedTargetLeafId, ...(input.undoOf ? { undoOf: input.undoOf } : {}) };
        try {
            const receipt = await threads.navigate(command);
            return { navigationMarkerId: receipt.key };
        }
        catch (error) {
            // A lost response is resolved by original command identity, never by current head equality.
            let known: Awaited<ReturnType<ThreadAdapter['navigationReceipt']>>;
            try {
                known = await threads.navigationReceipt({ ...selected, key: input.operationId });
            }
            catch {
                throw new RecoveryPrimitiveError('navigation-conflict', 'The original navigation outcome is not yet known', { cause: error, retryable: true, origin: 'navigation' });
            }
            if (known) {
                if (known.previousHeadId !== input.expectedLeafId || known.headId !== input.preparedTargetLeafId)
                    throw new RecoveryPrimitiveError('navigation-conflict', 'Original navigation receipt has different targets', { origin: 'navigation' });
                return { navigationMarkerId: known.key };
            }
            // An empty receipt cannot settle a transport failure: a queued commit may still be running.
            const rejected = error instanceof KernelClientError && ["operation-error", "protocol-error", "unauthorized"].includes(error.code);
            throw new RecoveryPrimitiveError('navigation-conflict', error instanceof Error ? error.message : 'History navigation was rejected', { cause: error, origin: 'navigation', retryable: !rejected });
        }
    };
    return {
        ready: () => true,
        commit,
        commitLeaf: commit,
        async prepare(input) {
            const selected = identity(input.conversation);
            const navigation = await threads.prepareNavigation({ ...selected, entryId: input.entryId });
            const range = await runtime.recoveryRange({ threadId: selected.threadId, branchId: selected.branchId, entryId: input.entryId });
            const managedTurns: import('./managed-recovery-coordinator.js').ManagedRecoveryTurn[] = [];
            const journalTurns: Array<{
                workspaceId: string;
                executionId: string;
                restore: boolean;
            }> = [];
            for (const turn of range) {
                if (!turn.source || !turn.entryIds.some(id => navigation.removedEntryIds.includes(id)))
                    continue;
                if (turn.source.resource_owner.kind === 'managed_host') {
                    managedTurns.push({ turn, restore: navigation.removedEntryIds.includes(turn.anchor.entryId) });
                    continue;
                }
                const workspaceId = turn.source.workspace_id;
                journalTurns.push({ workspaceId, executionId: turn.anchor.executionId, restore: navigation.removedEntryIds.includes(turn.anchor.entryId) });
                await store.recordTurnStart({ workspaceId, conversation: { kind: "thread", threadId: turn.anchor.threadId, branchId: turn.anchor.branchId }, executionId: turn.anchor.executionId,
                    runId: turn.anchor.runId, userEntryId: turn.anchor.entryId, runtimeGeneration: turn.anchor.epoch, workerId: 'kernel', activeWriterScopes: [], provenance: 'caused-by' });
                if (turn.settled) await store.recordTurnSettled({ workspaceId, executionId: turn.anchor.executionId,
                    ...(turn.entryIds.at(-1) ? { assistantEntryId: turn.entryIds.at(-1)! } : {}), activeWriterScopes: turn.uncovered ? ['process/or-external'] : [],
                    mutationObserved: turn.uncovered, observationComplete: !turn.uncovered, observedResourceIds: [], provenance: 'caused-by',
                    ...(!turn.settled || turn.uncovered ? { failure: { code: 'checkpoint-incomplete' as const, message: !turn.settled ? 'Original input work is not settled' : 'Shell or external tool effects do not have complete before-images', retryable: false } } : {}),
                });
            }
            return { journalTurns, managedTurns, expectedLeafId: navigation.expectedHeadId, targetLeafId: navigation.targetHeadId, removedEntryIds: navigation.removedEntryIds,
                ...(navigation.editorText !== undefined ? { editorText: navigation.editorText } : {}), ...('editorImages' in navigation ? { editorImages: navigation.editorImages } : {}) };
        },
        async prepareLeaf(input) {
            const selected = identity(input.conversation);
            if (!input.undoOf)
                throw new RecoveryPrimitiveError('navigation-conflict', 'Returning to removed history requires its original recovery receipt', { origin: 'navigation' });
            const receipt = await threads.navigationReceipt({ ...selected, key: input.undoOf });
            if (!receipt || receipt.previousHeadId !== input.targetLeafId)
                throw new RecoveryPrimitiveError('navigation-conflict', 'Original recovery navigation does not match this undo', { origin: 'navigation' });
            const current = await threads.snapshot(selected);
            if (current.historyPage.head !== receipt.headId)
                throw new RecoveryPrimitiveError('navigation-conflict', 'Conversation changed after recovery; undo requires a new review', { origin: 'navigation' });
            return { expectedLeafId: receipt.headId, targetLeafId: receipt.previousHeadId };
        },
    };
}
/** Read the original launch again and reacquire current, source-scoped authority for each access. */
export function createThreadRecoveryFileResolver({ runtime, storage, kernel, liveSources }: Owners) {
    return async (identity: RecoveryIdentity): Promise<KernelFileResourceBackend> => {
        const target = identity.fileTarget;
        if (!target || target.kind !== 'physical')
            throw new RecoveryPrimitiveError('unsupported-metadata', 'This source has no physical file target', { origin: 'storage' });
        const run = await runtime.run(target.runId);
        const launch = await runtime.launch(run.id);
        const source = launch?.selection.source;
        if (run.thread_id !== target.threadId || !source || source.workspace_id !== identity.workspaceId || source.execution_workspace_id !== target.executionWorkspaceId || source.mode !== target.sourceMode)
            throw new RecoveryPrimitiveError('workspace-untrusted', 'Recovery source no longer matches the original Run', { origin: 'storage' });
        if (source.resource_owner.kind === 'managed_host')
            throw new RecoveryPrimitiveError('unsupported-metadata', 'Managed Host files require their original remote recovery owner; no local directory was opened.', { origin: 'storage' });
        let root: string;
        if (source.mode === 'live_root') {
            if (!source.live_root)
                throw new Error('Original live root is unavailable');
            await liveSources.validate({ workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, liveRoot: source.live_root });
            root = source.live_root.canonicalRoot;
            if (source.live_root.rootId !== target.rootId)
                throw new Error('Original live root identity changed');
        }
        else {
            const handshake = kernel.handshake ?? await kernel.start();
            const original = await originalMaterializationLocation(handshake.storageRoot, source.workspace_id, source.environment_run_id ?? run.id);
            root = await admitMaterializedRoot(original.targetPath);
            // Current owning-workspace permission is required even for retained managed bytes.
            await storage.context(identity.workspaceId, 'recovery-maintenance', { owningWorkspace: identity.workspaceId, executionWorkspace: target.executionWorkspaceId, pathScopes: [''], capabilities: ['recovery.maintenance'] });
        }
        if (normalizePathIdentity(root) !== normalizePathIdentity(target.canonicalRoot) || normalizePathIdentity(identity.canonicalRoot) !== normalizePathIdentity(root))
            throw new Error('Recovery physical root changed');
        const authority = await storage.fileAuthorityContext({ owningWorkspaceId: identity.workspaceId, executionWorkspaceId: target.executionWorkspaceId, canonicalRoot: root, purpose: 'recovery-maintenance', capabilities: ['recovery.maintenance'] });
        if (authority.rootId !== target.rootId)
            throw new Error('Recovery registration differs from its original root');
        return new KernelFileResourceBackend(storage, { authority });
    };
}
