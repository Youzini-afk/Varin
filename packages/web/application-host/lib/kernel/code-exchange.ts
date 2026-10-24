/** Selected changes use immutable WorkingResults and the existing Integration journal. */
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { HostCapabilityHandler } from '@varin/extension-host';
import { CODE_EXCHANGE_CAPABILITY, CODE_EXCHANGE_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { parseVarinToolJson } from '@varin/extension-contract';
import { compileToolJsonSchema } from '../models/schema.js';
import type { FamilyMember, LaunchIntent, LaunchSource } from './protocol.generated.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { runToolDomainCall, type ToolInvocationAuthority } from './tool-invocation.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import { openScopedIntegrationTarget, integrationCompletion, type IntegrationTargetOwners, type IntegrationTargetScope } from './integration-tool-owner.js';
import { KernelWorkingStateRootStore } from './storage-adapter.js';
import type { IntegrationCoordinator, IntegrationPlanInput } from '../harness/working-state/integration-coordinator.js';
import type { RecoveryState, WorkingResult, WorkingStateRootStore } from '../harness/working-state/types.js';
import { normalizeResourceId } from '../recovery/journal-files.js';
import { projectIntegrationOperation, UnconfirmedIntegrationCommitError } from '../recovery/durable-file-operation.js';
import { exchangeManagedCode } from './managed-code-exchange.js';
import { mapSourcePath, sourcePathMap, type SourcePathMap } from './source-path-map.js';
import path from 'node:path';
import { normalizePathIdentity } from '../workspace/path-safety.js';

export { CODE_EXCHANGE_CAPABILITY };
export type CodeSelection = string | { path: string; before: string; after: string };
export type CodeParticipant = { member: FamilyMember; runId: string; branchId: string; launch: LaunchIntent; source: LaunchSource };
type Participant = CodeParticipant;
export type ExchangeScope = IntegrationTargetScope & { store: WorkingStateRootStore };
export interface CodeExchangeOwners extends IntegrationTargetOwners {
  coordinator: Pick<IntegrationCoordinator, 'mergeResult' | 'inspectIntegration'>;
  onCleanupError(operationId: string, error: unknown): void;
}
const validators = new Map(CODE_EXCHANGE_TOOL_DECLARATIONS.map(d => [d.id.slice('varin.code.'.length),
  { tool: d.tool!, validate: compileToolJsonSchema(d.tool!.inputSchema) }]));

/** Same Host, workspace and actual writable directory: a live root by its registered root, or
 * a materialized execution directory by the Run that owns it. Fixed revisions are never shared. */
export function sameWritableSource(left: Pick<Participant, 'runId' | 'source'>, right: Pick<Participant, 'runId' | 'source'>): boolean {
  const [a, b] = [left.source, right.source];
  if (a.mode !== b.mode || a.mode === 'fixed_branch' || !isDeepStrictEqual(a.resource_owner, b.resource_owner)
    || a.workspace_id !== b.workspace_id || a.execution_workspace_id !== b.execution_workspace_id) return false;
  if (a.mode === 'live_root') {
    if (!a.live_root || !b.live_root || a.live_root.hostId !== b.live_root.hostId) return false;
    const [leftRoot, rightRoot] = [a.live_root.canonicalRoot, b.live_root.canonicalRoot].map(root => normalizePathIdentity(root));
    return leftRoot === rightRoot ? a.live_root.rootId === b.live_root.rootId
      : [path.relative(leftRoot!, rightRoot!), path.relative(rightRoot!, leftRoot!)]
        .some(relative => relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  return (a.environment_run_id ?? left.runId) === (b.environment_run_id ?? right.runId)
    && a.branch_id === b.branch_id && a.revision === b.revision;
}
/** Scoped shared descendants can name a live subroot of a materialized source.
 * Follow only actual sharing edges; independent copies retain distinct owners. */
export async function sameSharedWritableSource(runtime: Pick<AgentRuntimeClient, 'childExecutionForRun' | 'launch'>,
  left: Pick<Participant, 'runId' | 'source'>, right: Pick<Participant, 'runId' | 'source'>, signal: AbortSignal): Promise<boolean> {
  if (sameWritableSource(left, right)) return true;
  if (left.source.mode === 'fixed_branch' || right.source.mode === 'fixed_branch') return false;
  const environment = async (selected: typeof left) => {
    let current = selected;
    const seen = new Set<string>();
    while (!seen.has(current.runId)) {
      signal.throwIfAborted(); seen.add(current.runId);
      const child = await runtime.childExecutionForRun(current.runId, signal);
      if (child?.source?.kind !== 'shared') return current;
      if (child.source.handoff) {
        current = { source: child.source.handoff.source, runId: child.source.handoff.source_run_id ?? child.parent_run_id };
      } else if (child.trigger.kind !== 'dispatch') {
        const previous = await runtime.launch(child.trigger.previous_run_id, signal);
        if (!previous?.selection.source) throw new Error('Original shared source is unavailable');
        current = { source: previous.selection.source, runId: child.trigger.previous_run_id };
      } else return current;
    }
    throw new Error('Shared source handoff contains a cycle');
  };
  const [a, b] = await Promise.all([environment(left), environment(right)]);
  return sameWritableSource(a, b);
}
function baselineUnavailable(source: Participant, target: Participant): Error {
  const describe = (value: Participant) => `${value.member.name ?? value.member.agentId ?? value.member.threadId} (${value.source.mode})`;
  return Object.assign(new Error(`No common file baseline links ${describe(source)} and ${describe(target)}: `
    + 'neither side records the fixed revision both started from, so their changes cannot be merged. '
    + 'Dispatch with an independent copy or a fixed stage source to obtain one, or apply the changes directly.'), { code: 'baseline_unavailable' });
}

async function participant(runtime: AgentRuntimeClient, caller: string, identity: string, signal: AbortSignal,
  own?: { runId: string; branchId: string }): Promise<Participant> {
  const page = await runtime.familyList({ callerThreadId: caller, includeSelf: true, scope: 'all', query: identity }, signal);
  const member = page.members.find(m => m.threadId === identity || m.agentId?.toUpperCase() === identity.toUpperCase());
  if (!member) throw new Error(`Agent ${identity} is outside this task family`);
  const branch = own ? member.branches.find(b => b.branchId === own.branchId) : member.branches[0];
  const runId = own?.runId ?? branch?.activeRunId ?? branch?.latestRun?.runId;
  if (!branch || !runId) throw new Error(`Agent ${identity} has not prepared its file source`);
  const launch = await runtime.launch(runId, signal);
  const source = member.sourceRunId===runId && member.source?.mode==='fixed_branch' ? member.source : launch?.selection.source;
  if (!launch || !source) throw new Error(`Agent ${identity} has no file source`);
  return { member, runId, branchId: branch.branchId, launch, source };
}

/** Caller-scoped writes target the related Agent's original concrete workspace. */
export async function openExchangeScope(owners: IntegrationTargetOwners, caller: ToolInvocationAuthority,
  selected: Participant, signal: AbortSignal): Promise<ExchangeScope> {
  if(selected.source.mode==='fixed_branch')throw new Error('该 Agent 当前保存的是固定成果；续接后即可向它的工作目录交换改动。');
  const launch = savedSourceLaunch(selected.runId, selected.source, sourceToolSchemas(selected.launch.selection).map(t => t.name));
  const admitted = await admitRunSourceAuthority(owners.kernel, owners.runtime, launch,
    { signal, resolveLiveSource: owners.resolveLiveSource });
  try {
    if (admitted.kind !== 'local') throw new Error('Code exchange must execute on the selected resource Host');
    if (!admitted.canonicalRoot || !admitted.rootId) throw new Error('Code exchange needs a physical file source');
    return await openCodeTarget(owners,caller,launch,{rootId:admitted.rootId,canonicalRoot:admitted.canonicalRoot},signal);
  } finally { await admitted.release(); }
}
export async function openFixedCodeSource(owners:Pick<IntegrationTargetOwners,'kernel'|'storage'>,
  caller:ToolInvocationAuthority,source:LaunchSource,signal:AbortSignal) {
  const grant=await owners.kernel.issueGrant({grantId:`exchange:${randomUUID()}`,owningWorkspace:source.workspace_id,
    executionWorkspace:source.execution_workspace_id,threadId:caller.threadId,runId:caller.runId,operationId:caller.operationId,
    capabilities:['storage.read','storage.write'],pathScopes:['']},signal);
  try {
    const context=await owners.storage.contextFromBranchGrant({grant,owningWorkspaceId:source.workspace_id,executionWorkspaceId:source.execution_workspace_id});
    return {store:new KernelWorkingStateRootStore(context),release:()=>owners.kernel.retireGrant(grant.grantId).then(()=>{})};
  } catch(error){await owners.kernel.retireGrant(grant.grantId);throw error;}
}
export async function openCodeTarget(owners: Pick<IntegrationTargetOwners,'kernel'|'storage'|'documents'|'recovery'|'metadataReader'>,
  caller:ToolInvocationAuthority, launch:ReturnType<typeof savedSourceLaunch>, physical:{rootId:string;canonicalRoot:string},signal:AbortSignal):Promise<ExchangeScope> {
    const grant = await owners.kernel.issueGrant({ grantId: `exchange:${randomUUID()}`,
      owningWorkspace: launch.workspaceId, executionWorkspace: launch.executionWorkspaceId,
      threadId: caller.threadId, runId: caller.runId, operationId: caller.operationId,
      capabilities: ['storage.read', 'storage.write', 'recovery'], pathScopes: [''] }, signal);
    try {
    const release = async () => { await owners.kernel.retireGrant(grant.grantId); };
    const scope = await openScopedIntegrationTarget(owners, caller, launch,
      { grant, ...physical }, release, signal);
    const store = await scope.workingStates.withBranchStore(launch.workspaceId, 'code-exchange-store', s => s);
    return { ...scope, store };
  } catch (error) {
    await owners.kernel.retireGrant(grant.grantId);
    throw error;
  }
}

export function codeIntegration(authority:ToolInvocationAuthority, branchId:string, source:Participant,target:Participant,
  result:WorkingResult, scope:ExchangeScope, signal:AbortSignal):IntegrationPlanInput & {operationId:string} {
  if(!result.root)throw new Error('The source snapshot has no immutable root');
  return { operationId:`integration:${authority.operationId}`,workspaceId:source.source.workspace_id,
    threadId:source.member.threadId,branchId:result.branchId,resultRevision:result.resultRevision,
    scopedWorkingStates:scope.workingStates,signal,
    operationBinding:{kind:'code_exchange',operationId:authority.operationId,parentRunId:authority.runId,parentThreadId:authority.threadId,parentBranchId:branchId,
      childThreadId:source.member.threadId,sourceRunId:source.runId,targetRunId:target.runId,targetThreadId:target.member.threadId,
      origin:authority.origin,callId:authority.callId,target:target.source,
      result:{workspaceId:source.source.workspace_id,branchId:result.branchId,resultRevision:result.resultRevision,root:result.root,publicationId:`code-exchange:${authority.operationId}`}},
    parentAuthority:{kind:'directory',directory:scope.directory,workspaceId:scope.documentWorkspaceId} };
}

const missing = (): RecoveryState => ({ kind: 'missing' });
async function stateText(store: WorkingStateRootStore, state: RecoveryState): Promise<string> {
  if (state.kind === 'missing') return '';
  if (state.kind !== 'regular-file') throw new Error('A code fragment requires a text file');
  const bytes = await store.getObject(state.objectHash);
  if (!bytes) throw new Error('The selected text content is unavailable');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
function replaceOnce(text: string, before: string, after: string): string {
  if (!before) { if (text) throw new Error('An empty before fragment requires an empty source'); return after; }
  const index = text.indexOf(before);
  if (index < 0 || text.indexOf(before, index + before.length) >= 0) throw new Error('The before fragment must match once in the source baseline');
  return text.slice(0, index) + after + text.slice(index + before.length);
}

/** Capture only at an explicit exchange; never mutates the sender's branch or execution directory. */
export async function captureCodeSelection(input: {
  store: WorkingStateRootStore; operationId: string; workspaceId: string; directory?: string;
  fixedSource?: {branchId:string;revision:number};
  baselineBranchId: string; baselineRevision: number; files?: CodeSelection[];
  acknowledged?: Record<string, RecoveryState>; signal: AbortSignal;
  mapping?: SourcePathMap | undefined; baselineMapping?: SourcePathMap | undefined;
}): Promise<WorkingResult> {
  const { store, signal } = input;
  const branchId = `code-exchange:${input.operationId}`;
  const publicationId = `code-exchange:${input.operationId}`;
  const resumed = await store.resumeResultPublication(branchId, publicationId, { signal });
  if (resumed) return resumed;
  // Original create/commit/publication identities recover the same captured version after a retry.
  const existing = await store.getBranchRoot(branchId);
  if (existing && existing.writeRevision > 0) return store.publishHeadResult(branchId, { publicationId, signal });
  const baseView = { revision: input.baselineRevision, signal };
  const selections = input.files?.map(file => typeof file === 'string' ? normalizeResourceId(file) : { ...file, path: normalizeResourceId(file.path) });
  const mapping = input.mapping ?? { from: '', to: '' };
  const baselineMapping = input.baselineMapping ?? { from: '', to: '' };
  const paths = selections?.map(file => typeof file === 'string' ? file : file.path) ?? [...new Set([
    ...(await store.listPaths(input.baselineBranchId, [''], baseView))?.entries.flatMap(e => {
      const mapped = mapSourcePath(e.path, baselineMapping); return mapped ? [mapped] : [];
    }) ?? [],
    ...(input.fixedSource ? (await store.listPaths(input.fixedSource.branchId,[''],{revision:input.fixedSource.revision,signal}))?.entries.map(e=>e.path)??[]
      : await store.listWorkspaceBaselinePaths(input.directory!, signal)),
  ])].filter(file => Boolean(mapSourcePath(file, mapping)));
  const basePaths = paths.map(file => mapSourcePath(file, { from: baselineMapping.to, to: baselineMapping.from }));
  if (basePaths.some(file => !file) || paths.some(file => !mapSourcePath(file, mapping))) throw new Error('A selected file is outside the receiving source directory');
  const base = await store.readStateSlice(input.baselineBranchId, basePaths as string[], baseView);
  if (!base) throw new Error('The source baseline is unavailable');
  const captured = input.fixedSource ? await store.readStateSlice(input.fixedSource.branchId,paths,{revision:input.fixedSource.revision,signal})
    : await store.captureDirectory(input.directory!, paths, { store: true, signal });
  if(!captured)throw new Error('The retained Agent source is unavailable');
  const uploads:Array<()=>Promise<void>>=[];
  try {
    const baseline: Record<string, RecoveryState> = {};
    const selected: Record<string, RecoveryState> = {};
    for (const file of selections ?? paths) {
      const path = typeof file === 'string' ? file : file.path;
      const targetPath = mapSourcePath(path, mapping)!;
      const basePath = mapSourcePath(path, { from: baselineMapping.to, to: baselineMapping.from })!;
      baseline[targetPath] ??= input.acknowledged?.[targetPath] ?? base[basePath] ?? missing();
      if (typeof file === 'string') selected[targetPath] = captured[path] ?? missing();
      else {
        const before = await stateText(store, selected[targetPath] ?? baseline[targetPath]!);
        const after = replaceOnce(before, file.before, file.after);
        const actual = await stateText(store, captured[path] ?? missing());
        if (file.after && !actual.includes(file.after)) throw new Error(`The after fragment is absent from ${path}`);
        const object = await store.putObject(Buffer.from(after, 'utf8'));
        if(object.release)uploads.push(object.release);
        selected[targetPath] = { kind: 'regular-file', objectHash: object.hash, byteLength: object.byteLength,
          ...(baseline[targetPath]!.kind === 'regular-file' ? { mode: baseline[targetPath]!.mode } : {}) };
      }
    }
    if (!existing) await store.createBranch(input.workspaceId, branchId, baseline);
    const head = await store.getBranchRoot(branchId);
    if (!head) throw new Error('The exchange snapshot was not retained');
    const committed = await store.commitVirtualWrites(branchId, head.writeRevision, selected);
    if (committed.status !== 'committed') throw new Error('The exchange snapshot changed');
    return await store.publishHeadResult(branchId, { publicationId, signal });
  } finally { if(!input.fixedSource)await store.releaseCapturedStates(captured);for(const release of uploads)await release(); }
}

/** The last applied sender state is the next merge base, including repeated edits of the same file. */
export async function acknowledgedCode(store: WorkingStateRootStore, sourceThread: string, targetThread: string, operations?:Record<string,unknown>[]): Promise<Record<string, RecoveryState>> {
  const rows = operations??await store.listDurableOperations('integration');
  const acknowledged: Record<string, RecoveryState> = {};
  // The native journal lists newest updates first, including a stable tie break.
  for (const row of rows.filter(r => r.state === 'complete').reverse()) {
    const view = projectIntegrationOperation(String(row.operationId), row);
    const binding = view.operationBinding;
    if (binding?.kind !== 'code_exchange' || binding.childThreadId !== sourceThread || binding.targetThreadId !== targetThread) continue;
    const result=await store.getResult(binding.result.branchId,binding.result.resultRevision);
    if(!result || result.root!==binding.result.root)throw new Error('An acknowledged code snapshot is unavailable');
    for (const [path, state] of Object.entries(result.pathStates)) acknowledged[path] = state;
  }
  return acknowledged;
}

export function createCodeExchangeOwner(owners: CodeExchangeOwners): HostCapabilityHandler {
  return async (method, params, context) => {
    const selected = validators.get(method);
    if (!selected || !selected.validate(params)) throw new Error('Select an Agent and files or exact code fragments');
    const input = params as { source?: string; target?: string; files?: CodeSelection[] };
    return runToolDomainCall(context, { domain: CODE_EXCHANGE_CAPABILITY, toolName: selected.tool.name,
      operation: 'effect', arguments: params }, async authority => {
      const opened: Array<{release():Promise<void>}> = [];
      let integration: IntegrationPlanInput & { operationId: string } | undefined;
      let dispatched = false;
      try {
        const run = await owners.runtime.run(authority.runId, context.signal);
        const self = await participant(owners.runtime, authority.threadId, authority.threadId, context.signal,
          { runId: authority.runId, branchId: run.branch_id });
        const peerId = (method === 'submit' ? input.target : input.source) ?? self.member.parentThreadId;
        if (!peerId) throw Object.assign(new Error(method === 'submit'
          ? 'This is a root Agent with no parent to submit to. Set target to a related Agent from threads, or keep the work in this task.'
          : 'This Agent has no parent to update from. Set source to a related Agent from threads.'), { code: method === 'submit' ? 'target_required' : 'source_required' });
        const peer = await participant(owners.runtime, authority.threadId, peerId, context.signal);
        const [source, target] = method === 'submit' ? [self, peer] : [peer, self];
        if (source.member.threadId === target.member.threadId) throw new Error('Select another Agent');
        if (source.source.workspace_id !== target.source.workspace_id
          || !isDeepStrictEqual(source.source.resource_owner, target.source.resource_owner)) throw new Error('These file sources belong to different resource owners');
        if (await sameSharedWritableSource(owners.runtime, source, target, context.signal)) {
          const mapping = await sourcePathMap(owners.runtime, source, target, context.signal);
          if (input.files?.some(file => !mapSourcePath(typeof file === 'string' ? normalizeResourceId(file) : normalizeResourceId(file.path), mapping))) throw new Error('A selected file is outside the receiving source directory');
          // A shared child already changed this exact directory; there is nothing to merge.
          return { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: 'none', content: { data: parseVarinToolJson({
            status: 'shared_source', source: { name: source.member.name, agentId: source.member.agentId },
            target: { name: target.member.name, agentId: target.member.agentId },
            message: 'Both Agents work in the same shared source; their file changes already apply there and need no exchange.',
          }), parts: [] } } };
        }
        let result:WorkingResult;
        let merged:Awaited<ReturnType<IntegrationCoordinator['mergeResult']>>;
        if(source.source.resource_owner.kind==='managed_host') {
          ({result,merged}=await exchangeManagedCode(owners,authority,run.branch_id,source,target,input.files,context.signal,()=>{dispatched=true;}));
        } else {
        const targetScope = await openExchangeScope(owners, authority, target, context.signal); opened.push(targetScope);
        const sourceScope = source.source.mode==='fixed_branch'?await openFixedCodeSource(owners,authority,source.source,context.signal)
          :await openExchangeScope(owners, authority, source, context.signal); opened.push(sourceScope);
        const baseline = source.source.mode === 'live_root' ? target.source : source.launch.selection.source!;
        if (!baseline.branch_id || baseline.revision === null) throw baselineUnavailable(source, target);
        const acknowledged = await acknowledgedCode(sourceScope.store, source.member.threadId, target.member.threadId,
          source.source.mode==='fixed_branch'?await owners.metadataReader.listOperations(source.source.workspace_id,'integration'):undefined);
        result = await captureCodeSelection({ store: sourceScope.store, operationId: authority.operationId,
          mapping: await sourcePathMap(owners.runtime, source, target, context.signal),
          baselineMapping: await sourcePathMap(owners.runtime, source.source.mode === 'live_root' ? target : source, source, context.signal),
          workspaceId: source.source.workspace_id,
          ...('directory' in sourceScope?{directory:sourceScope.directory}:{}),
          ...(source.source.mode==='fixed_branch'?{fixedSource:{branchId:source.source.branch_id!,revision:source.source.revision!}}:{}),
          baselineBranchId: baseline.branch_id, baselineRevision: baseline.revision,
          ...(input.files ? { files: input.files } : {}), acknowledged, signal: context.signal });
        if (!result.root) throw new Error('The source snapshot has no immutable root');
        integration = codeIntegration(authority,run.branch_id,source,target,result,targetScope,context.signal);
        dispatched = true;
        merged = await owners.coordinator.mergeResult(integration);
        }
        const receipt = integrationCompletion(merged);
        const notification = { source: { name: source.member.name, agentId: source.member.agentId },
          target: { name: target.member.name, agentId: target.member.agentId }, result:{branchId:result.branchId,resultRevision:result.resultRevision,root:result.root},
          status: merged.status, appliedPaths: merged.appliedPaths, conflictPaths: merged.conflictPaths };
        // The native journal reader publishes the Agent notice with the original
        // operation identity, including after a Host interruption.
        await owners.runtime.reconcileHostTool({ operationId: authority.operationId, executionOwner: authority.executorOwner }, context.signal)
          .catch(error=>owners.onCleanupError(authority.operationId,error));
        if (receipt.completion.kind === 'result') receipt.completion.content = { data: parseVarinToolJson({ ...merged, ...notification }), parts: [] };
        return receipt;
      } catch (error) {
        if (dispatched && integration) {
          const inspection = { ...integration }; delete inspection.signal;
          const original = await owners.coordinator.inspectIntegration(inspection).catch(() => null);
          if (original) {
            await owners.runtime.reconcileHostTool({ operationId: authority.operationId, executionOwner: authority.executorOwner }, context.signal)
              .catch(error=>owners.onCleanupError(authority.operationId,error));
            return integrationCompletion(original);
          }
        }
        return { executor_stopped: !dispatched || (error instanceof UnconfirmedIntegrationCommitError && error.executorStopped),
          completion: { kind: 'result', outcome: dispatched ? 'indeterminate' : 'failed', effect: dispatched ? 'unknown' : 'none',
          content: { data: { status: 'failed', code: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'code_exchange_failed',
            message: error instanceof Error ? error.message : String(error) }, parts: [] } } };
      } finally {
        for (const scope of opened.reverse()) await scope.release().catch(error => owners.onCleanupError(authority.operationId, error));
      }
    });
  };
}
