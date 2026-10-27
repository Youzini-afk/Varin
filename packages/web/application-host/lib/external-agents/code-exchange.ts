/** External files cross the same snapshot/three-way merge journal as native peers. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ExternalChild, LaunchSource } from '../kernel/protocol.generated.js';
import type { ToolInvocationAuthority } from '../kernel/tool-invocation.js';
import {
  acknowledgedCode,
  captureCodeSelection,
  openCodeTarget,
  openExchangeScope,
  openFixedCodeSource,
  type CodeExchangeOwners,
  type CodeParticipant,
  type CodeSelection,
  type ExchangeScope,
} from '../kernel/code-exchange.js';
import { savedSourceLaunch } from '../kernel/source-launch.js';
import { mapSourcePath, sourcePathMap, type SourcePathMap } from '../kernel/source-path-map.js';
import { integrationCompletion } from '../kernel/integration-tool-owner.js';
import type { IntegrationPlanInput } from '../harness/working-state/integration-coordinator.js';
import type { ToolExecutionReceipt } from '../kernel/tool-bridge.js';
import { UnconfirmedIntegrationCommitError } from '../recovery/durable-file-operation.js';
import { normalizePathIdentity } from '../workspace/path-safety.js';
import { record, text } from './transport.js';

function scopedMapping(base: SourcePathMap, prefix: string): SourcePathMap {
  if (prefix === base.from) return { from: '', to: base.to };
  if (!base.from || prefix.startsWith(`${base.from}/`))
    return {
      from: '',
      to: [base.to, base.from ? prefix.slice(base.from.length + 1) : prefix].filter(Boolean).join('/'),
    };
  if (!prefix || base.from.startsWith(`${prefix}/`))
    return { from: prefix ? base.from.slice(prefix.length + 1) : base.from, to: base.to };
  throw new Error('The selected Agent sources are disjoint');
}
export async function exchangeExternalCode(
  owners: CodeExchangeOwners,
  caller: ToolInvocationAuthority,
  self: CodeParticipant,
  child: ExternalChild,
  direction: 'receive' | 'send',
  files: CodeSelection[] | undefined,
  signal: AbortSignal,
): Promise<ToolExecutionReceipt> {
  const opened: Array<{ release(): Promise<void> }> = [];
  let integration: (IntegrationPlanInput & { operationId: string }) | undefined;
  let dispatched = false;
  try {
    const saved = record(child.source),
      handoff = child.handoff,
      recordedCwd = text(saved.cwd);
    const native=record(saved.nativeSource);
    let cwd=recordedCwd;
    if(native.mode==='native_workspace'){
      const owner=owners.kernel.nativeWorkspaces;if(!owner)throw new Error('Native external source is unavailable');
      const entry=await owner.open(native as unknown as LaunchSource,signal);
      cwd=(await owner.acquire(native as unknown as LaunchSource,entry.grant,signal)).path;
    }
    if (!handoff || !cwd) throw new Error('This external Agent has not prepared a file source');
    if (
      handoff.source.resource_owner.kind !== 'local' ||
      self.source.resource_owner.kind !== 'local' ||
      handoff.source.workspace_id !== self.source.workspace_id ||
      !isDeepStrictEqual(handoff.source.resource_owner, self.source.resource_owner)
    )
      throw new Error('These sources belong to different resource owners');
    const toSelf = scopedMapping(
      await sourcePathMap(
        owners.runtime,
        { runId: handoff.source_run_id ?? child.parent_run_id, source: handoff.source },
        self,
        signal,
      ),
      handoff.source_path ?? '',
    );
    const mapping = direction === 'receive' ? toSelf : { from: toSelf.to, to: toSelf.from };
    if (files?.some((file) => !mapSourcePath(typeof file === 'string' ? file : file.path, mapping)))
      throw new Error('A selected file is outside the receiving source');
    const own =
      self.source.mode === 'fixed_branch'
        ? await openFixedCodeSource(owners, caller, self.source, signal)
        : await openExchangeScope(owners, caller, self, signal);
    opened.push(own);
    if (saved.kind === 'shared' && 'directory' in own) {
      const a = normalizePathIdentity(cwd),
        b = normalizePathIdentity(own.directory);
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
        return {
          executor_stopped: true,
          completion: {
            kind: 'result',
            outcome: 'succeeded',
            effect: 'none',
            content: {
              data: {
                status: 'shared_source',
                message: 'Both Agents use the same writable source; changes already apply there.',
              },
              parts: [],
            },
          },
        };
    }
    const preparedBaseline=record(saved.baseline);
    const baseline = record(native.mode==='native_workspace'?record(preparedBaseline.pin).source:preparedBaseline.source);
    if (typeof baseline.branch_id !== 'string' || typeof baseline.revision !== 'number')
      throw Object.assign(new Error('This external source has no isolated baseline for code exchange'), {
        code: 'baseline_unavailable',
      });
    const grant = await owners.kernel.issueGrant(
      {
        grantId: `exchange:${randomUUID()}`,
        owningWorkspace: handoff.source.workspace_id,
        executionWorkspace: text(native.execution_workspace_id)||handoff.source.execution_workspace_id,
        threadId: caller.threadId,
        runId: caller.runId,
        operationId: caller.operationId,
        capabilities: ['storage.read', 'storage.write'],
        pathScopes: [''],
      },
      signal,
    );
    let rootId: string;
    try {
      const root = await owners.kernel
        .scoped(grant)
        .fileRootRegister(
          {
            workspaceId: handoff.source.workspace_id,
            executionWorkspaceId: text(native.execution_workspace_id)||handoff.source.execution_workspace_id,
            canonicalRoot: cwd,
          },
          signal,
        );
      rootId = String(root.rootId);
    } finally {
      await owners.kernel.retireGrant(grant.grantId);
    }
    const source: LaunchSource = native.mode==='native_workspace'?native as unknown as LaunchSource:{
      workspace_id: handoff.source.workspace_id,
      execution_workspace_id: handoff.source.execution_workspace_id,
      resource_owner: handoff.source.resource_owner,
      mode: 'materialized',
      branch_id: baseline.branch_id,
      revision: baseline.revision,
      environment_run_id: child.conversation_id,
      live_root: null,
    };
    const external = await openCodeTarget(
      owners,
      caller,
      savedSourceLaunch(caller.runId, source, []),
      { rootId, canonicalRoot: cwd },
      signal,
    );
    opened.push(external);
    const target = direction === 'receive' ? own : external;
    if (!('directory' in target)) throw new Error('Resume this fixed source before receiving file changes');
    const from = direction === 'receive' ? external : own;
    const sourceId = direction === 'receive' ? child.conversation_id : caller.threadId;
    const targetId = direction === 'receive' ? caller.threadId : child.conversation_id;
    const acknowledged = await acknowledgedCode(from.store, sourceId, targetId);
    const result = await captureCodeSelection({
      ownerThreadId:caller.threadId,
      store: from.store,
      operationId: caller.operationId,
      workspaceId: source.workspace_id,
      ...('directory' in from
        ? { directory: from.directory }
        : { fixedSource: { branchId: self.source.branch_id!, revision: self.source.revision! } }),
      ...(direction==='receive'&&source.mode==='native_workspace'?{nativeSource:source,nativeWorkspaces:owners.kernel.nativeWorkspaces}
        :direction==='send'&&self.source.mode==='native_workspace'?{nativeSource:self.source,nativeWorkspaces:owners.kernel.nativeWorkspaces}:{}),
      baselineBranchId: baseline.branch_id,
      baselineRevision: baseline.revision,
      mapping,
      baselineMapping: direction === 'receive' ? { from: '', to: '' } : toSelf,
      ...(files ? { files } : {}),
      acknowledged,
      signal,
    });
    if (!result.root) throw new Error('External exchange snapshot has no retained root');
    integration = {
      operationId: `integration:${caller.operationId}`,
      workspaceId: source.workspace_id,
      threadId: sourceId,
      branchId: result.branchId,
      resultRevision: result.resultRevision,
      scopedWorkingStates: (target as ExchangeScope).workingStates,
      parentAuthority: {
        kind: 'directory',
        directory: target.directory,
        workspaceId: (target as ExchangeScope).documentWorkspaceId,
      },
      signal,
      operationBinding: {
        kind: 'external_code_exchange',
        externalOperationId: child.dispatch_operation_id ?? child.operation_id,
        direction,
        operationId: caller.operationId,
        parentRunId: caller.runId,
        parentThreadId: caller.threadId,
        parentBranchId: self.branchId,
        childThreadId: sourceId,
        targetThreadId: targetId,
        origin: caller.origin,
        callId: caller.callId,
        target: direction === 'receive' ? self.source : source,
        result: {
          workspaceId: source.workspace_id,
          branchId: result.branchId,
          resultRevision: result.resultRevision,
          root: result.root,
          publicationId: `code-exchange:${caller.operationId}`,
        },
      },
    };
    dispatched = true;
    const merged = await owners.coordinator.mergeResult(integration);
    return integrationCompletion(merged);
  } catch (error) {
    if (dispatched && integration) {
      const inspection = { ...integration };
      delete inspection.signal;
      const recovered = await owners.coordinator.inspectIntegration(inspection).catch(() => null);
      if (recovered) return integrationCompletion(recovered);
    }
    return {
      executor_stopped:
        !dispatched || (error instanceof UnconfirmedIntegrationCommitError && error.executorStopped),
      completion: {
        kind: 'result',
        outcome: dispatched ? 'indeterminate' : 'failed',
        effect: dispatched ? 'unknown' : 'none',
        content: {
          data: {
            code: 'external_code_exchange_failed',
            message: error instanceof Error ? error.message : String(error),
          },
          parts: [],
        },
      },
    };
  } finally {
    for (const scope of opened.reverse())
      await scope.release().catch((error) => owners.onCleanupError(caller.operationId, error));
  }
}
