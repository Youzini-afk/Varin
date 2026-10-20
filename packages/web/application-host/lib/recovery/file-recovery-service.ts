import { randomUUID } from 'node:crypto';
import type { FileRecoveryRequest, FileRecoveryResult, FileRecoveryPoint } from '@varin/extension-contract';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { KernelStorageAdapter } from '../kernel/storage-adapter.js';
import type { KernelRecoveryStore } from '../kernel/kernel-recovery-store.js';
import type { KernelFileResourceBackend } from '../kernel/file-resource-backend.js';
import type { RecoveryIdentity } from './journal-files.js';
import { admitMaterializedRoot, originalMaterializationLocation } from '../kernel/source-launch.js';
import type { LaunchSource, RecoveryRangeTurn } from '../kernel/protocol.generated.js';
import { restoreFilesWithEditors, type RecoveryEditors } from './file-recovery-editors.js';

type RecoveryMethod = 'recovery.points' | 'recovery.files.restore' | 'recovery.point.create' | 'recovery.point.release';
const sourceKey = (runId: string, source: LaunchSource) => JSON.stringify([
  source.resource_owner, source.workspace_id, source.execution_workspace_id, source.mode,
  source.live_root?.rootId, source.mode === 'materialized' ? source.environment_run_id ?? runId : null,
]);
export function createFileRecoveryService(options: {
  runtime: AgentRuntimeClient;
  kernel: KernelClient;
  storage: KernelStorageAdapter;
  store: KernelRecoveryStore;
  documents: RecoveryEditors;
  resolveFiles(identity: RecoveryIdentity): Promise<KernelFileResourceBackend>;
}) {
  const request = async (input: FileRecoveryRequest, sourceRunId: string): Promise<Record<string, unknown>> => {
    const run = await options.runtime.run(sourceRunId);
    const launch = await options.runtime.launch(sourceRunId);
    const source = launch?.selection.source;
    if (run.thread_id !== input.conversation.threadId || !source || source.mode === 'fixed_branch') throw new Error('This recovery point has no original physical worktree');
    const method: RecoveryMethod = input.action === 'restore' || input.action === 'undo' ? 'recovery.files.restore'
      : input.action === 'name' ? 'recovery.point.create' : input.action === 'release' ? 'recovery.point.release' : 'recovery.points';
    const args: Record<string, unknown> = input.action === 'undo' ? { undo: input.operationId }
      : input.action === 'name' ? { name: input.name } : input.action === 'operation' ? { operation: input.operationId }
      : { ...(input.point ? { point: input.point } : {}), ...(input.cursor !== undefined ? { cursor: input.cursor } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) };
    if (input.paths) args.paths = input.paths;
    if (input.overwritePaths) args.overwritePaths = input.overwritePaths;
    if (input.action === 'history') args.operations = true;
    const preview = input.action === 'preview' ? { path: input.path!,
      ...(input.currentOffset !== undefined ? { currentOffset: input.currentOffset } : {}),
      ...(input.targetOffset !== undefined ? { targetOffset: input.targetOffset } : {}) } : undefined;
    // One identifier survives a transport retry; undo identifies a new operation.
    const operationId = method === 'recovery.points' ? undefined : input.requestId ?? randomUUID();
    let activeTurns: RecoveryRangeTurn[] = [];
    if (method === 'recovery.files.restore' || input.point?.startsWith('current:')) {
      const latest = (await options.runtime.recoverySources(input.conversation)).find(item => sourceKey(item.runId, item.source) === sourceKey(sourceRunId, source));
      if (latest) {
        const active = await options.runtime.run(latest.runId);
        if (!['completed', 'cancelled', 'failed'].includes(active.state)) activeTurns = await options.runtime.recoveryRun(latest.runId);
      }
    }
    const journal = activeTurns.filter(turn => !turn.settled).at(-1)?.anchor;
    const command = { threadId: run.thread_id, sourceRunId, arguments: args, sourceMode: source.mode,
      ...(journal ? { journal } : {}), ...(operationId ? { operationId } : {}) };
    if (source.resource_owner.kind === 'managed_host') {
      const turns = [...new Map([...(await options.runtime.recoveryRun(sourceRunId)), ...activeTurns].filter(turn => turn.source).map(turn => [turn.anchor.executionId, turn])).values()];
      if (!turns.length) throw new Error('The original managed source has no recovery anchor');
      const service = await options.runtime.managedSource(source.resource_owner);
      const result = await service.recovery({ coordinatorHostId: options.runtime.coordinatorHostId,
        binding: { operationId: operationId ?? `points:${sourceRunId}`, workspaceId: source.workspace_id,
          conversation: input.conversation, turns: turns.map(turn => ({ turn, restore: false })) },
        action: { kind: 'files', method, input: command, ...(preview ? { preview } : {}), ...(input.action === 'storage' ? { storage: true } : {}) } });
      if (result.status !== 'files') throw new Error('The original Host did not return its file recovery result');
      if (Array.isArray(result.result.operations)) result.result.operations = result.result.operations.map(operation => ({ ...operation, sourceRunId: operation.sourceRunId ?? sourceRunId }));
      return result.result;
    }
    await options.store.listCheckpoints(source.workspace_id);
    const handshake = options.kernel.handshake ?? await options.kernel.start();
    const root = source.mode === 'live_root' ? source.live_root!.canonicalRoot
      : await admitMaterializedRoot((await originalMaterializationLocation(handshake.storageRoot, source.workspace_id, source.environment_run_id ?? sourceRunId)).targetPath);
    const rootId = source.live_root?.rootId ?? (await options.storage.fileAuthorityContext({
      owningWorkspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id, canonicalRoot: root,
      purpose: 'recovery-maintenance', capabilities: ['recovery.maintenance'],
    })).rootId;
    const identity: RecoveryIdentity = { authorityId: 'kernel', workspaceId: source.workspace_id, canonicalRoot: root, filesystemProfile: process.platform,
      fileTarget: { kind: 'physical', workspaceId: source.workspace_id, executionWorkspaceId: source.execution_workspace_id,
        threadId: run.thread_id, runId: sourceRunId, rootId, canonicalRoot: root, sourceMode: source.mode } };
    const files = await options.resolveFiles(identity);
    const result: Record<string, unknown> = input.action === 'storage' ? { storage: await files.recoveryStorage(identity) }
      : preview ? { preview: await files.previewRecoveryFile(identity, command, preview) }
      : method === 'recovery.files.restore'
      ? await restoreFilesWithEditors(options.documents, files, identity, command)
      : await files.recoveryFiles(identity, method, command);
    if (Array.isArray(result.points)) result.points = result.points.map(point => ({ ...point, sourcePath: root }));
    result.source = { runId: sourceRunId, workspaceId: source.workspace_id, path: root };
    if (Array.isArray(result.operations)) result.operations = result.operations.map(operation => ({ ...operation, sourceRunId: operation.sourceRunId ?? sourceRunId }));
    return result;
  };
  return async (input: FileRecoveryRequest): Promise<FileRecoveryResult> => {
    if (input.action !== 'list' && input.action !== 'history') {
      if (!input.sourceRunId) throw new Error('Select a recovery point in its original worktree');
      const result = await request(input, input.sourceRunId);
      return input.action === 'restore' || input.action === 'undo' || input.action === 'operation'
        ? { operation: { ...result, sourceRunId: input.sourceRunId } as unknown as NonNullable<FileRecoveryResult['operation']> } : result as FileRecoveryResult;
    }
    const sources = (await options.runtime.recoverySources(input.conversation)).filter(item => item.source.mode !== 'fixed_branch');
    const offset = input.cursor ?? 0;
    const limit = input.limit ?? 20;
    const pages = await Promise.allSettled(sources.map(source => request({ ...input, cursor: 0, limit: offset + limit + 1 }, source.runId)));
    const points: FileRecoveryPoint[] = [];
    const operations: NonNullable<FileRecoveryResult['operations']> = [];
    const failures: string[] = [];
    let currentSource: FileRecoveryResult['source'];
    for (const [index, result] of pages.entries()) {
      if (result.status === 'rejected') { failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason)); continue; }
      if (Array.isArray(result.value.points)) points.push(...result.value.points as FileRecoveryPoint[]);
      if (Array.isArray(result.value.operations)) operations.push(...result.value.operations as typeof operations);
      if (index === 0 && result.value.source) currentSource = result.value.source as FileRecoveryResult['source'];
    }
    points.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    operations.sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''));
    const visible = input.action === 'history' ? [] : points.slice(offset, offset + limit);
    const runIds = [...new Set(visible.filter(point => !point.label && !point.runId.startsWith('restore:')).map(point => point.runId))];
    if (runIds.length) {
      try {
        const labels = await options.runtime.recoveryLabels(input.conversation.threadId, runIds);
        for (const point of visible) { const label = labels[point.runId]; if (label) point.title = label; }
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    }
    return { ...(currentSource ? { currentSourceRunId: currentSource.runId, source: currentSource } : {}),
      points: visible, operations: input.action === 'history' ? operations.slice(offset, offset + limit) : operations.slice(0, limit),
      nextCursor: (input.action === 'history' ? operations.length : points.length) > offset + limit ? offset + limit : null,
      ...(failures.length ? { failures } : {}) };
  };
}
