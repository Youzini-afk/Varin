import { SourceAdmissionError, sourceReadError } from './source-admission-error.js';
import type { LiveSourceResolver } from './live-source.js';
import type { ThreadSource } from '@varin/application-client';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { stat } from 'node:fs/promises';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { LaunchIntent, RunStartReceipt, SourceToolBinding } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';

/** The original materialized execution directory. Looking it up never creates a replacement. */
export async function originalMaterializationLocation(root:string,workspaceId:string,environmentRunId:string) {
  if (!workspaceId || !environmentRunId) throw new SourceAdmissionError('source_changed');
  const storageRoot=await canonicalizePathIdentity(root);
  const key=createHash('sha256').update(JSON.stringify([workspaceId,environmentRunId])).digest('hex');
  const relativeTarget=`managed/runs/${key}`;
  return {storageRoot,key,relativeTarget,targetPath:path.resolve(storageRoot,relativeTarget)};
}

/** The managed key must still name its original directory, not an alias to another working copy. */
export async function admitMaterializedRoot(targetPath: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  let root: string;
  try {
    root = await canonicalizePathIdentity(targetPath);
    if (!(await stat(root)).isDirectory()) throw new SourceAdmissionError('source_environment_unavailable');
  } catch (error) {
    if (error instanceof SourceAdmissionError) throw error;
    throw new SourceAdmissionError('source_environment_unavailable', { cause: error });
  }
  if (normalizePathIdentity(root) !== normalizePathIdentity(targetPath)) throw new SourceAdmissionError('source_changed');
  signal?.throwIfAborted();
  return root;
}

/** Explicit Host-selected source. Live identity is revalidated through Documents before binding. */
export type SourceLaunch = Omit<ThreadSource, 'mode' | 'branchId' | 'revision' | 'liveRoot' | 'tools'> & {
  runId: string;
  tools: readonly ThreadSource['tools'][number][];
} & (
  | { mode: 'fixed_branch' | 'materialized'; branchId: string; revision: number; environmentRunId?: string; liveRoot?: never }
  | { mode: 'live_root'; liveRoot: import('./protocol.generated.js').LiveRoot; branchId?: never; revision?: never; environmentRunId?: never }
);

/** Project only source-owned declarations from the same frozen launch directory. */
export function sourceToolSchemas(selection: LaunchIntent['selection']) {
  const external = new Set([
    ...(selection.mcp_binding?.tools.map(tool => tool.name) ?? []),
    ...selection.extension_bindings.map(binding => binding.tool.name),
  ]);
  return selection.tools.filter(tool => !external.has(tool.name) && tool.requirements !== undefined);
}

/** Uses the existing Storage authority for source reads, materialization and process containment.
 * Only an explicitly selected live_root uses the original workspace; fixed revisions never fall back to disk.
 */
export async function startRunFromSource(
  kernel: KernelClient,
  runtime: AgentRuntimeClient,
  selection: SourceLaunch,
  options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal; resolveLiveSource?: LiveSourceResolver } = {},
): Promise<RunStartReceipt> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (![selection.runId, selection.workspaceId, selection.executionWorkspaceId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Launch requires complete source identity');
  if (selection.mode === 'live_root' && selection.resourceOwner.kind === 'local') {
    if (!options.resolveLiveSource) throw new Error('Live source requires its Documents resource owner');
    if (!selection.liveRoot || ![selection.liveRoot.hostId, selection.liveRoot.rootId, selection.liveRoot.canonicalRoot].every(value => typeof value === 'string' && value.length > 0)
      || selection.branchId !== undefined || selection.revision !== undefined || selection.environmentRunId !== undefined) throw new Error('Live source identity is incomplete');
    await options.resolveLiveSource(selection, signal);
  } else if (selection.mode !== 'live_root' && ((selection.mode !== 'fixed_branch' && selection.mode !== 'materialized')
    || typeof selection.branchId !== 'string' || !selection.branchId || !Number.isSafeInteger(selection.revision) || selection.revision < 0)) {
    throw new Error('Fixed source requires a complete branch revision');
  }
  const tools = [...new Set(selection.tools)];
  const run = await runtime.run(selection.runId, signal);
  if (['completed', 'failed', 'cancelled'].includes(run.state) || run.cancel_requested) throw new Error('Run is closed to launch');
  const saved = await runtime.launch(run.id, signal);
  if (saved) {
    const source = saved.selection.source;
    if (!source || !isDeepStrictEqual(source.resource_owner, selection.resourceOwner) || source.workspace_id !== selection.workspaceId || source.execution_workspace_id !== selection.executionWorkspaceId
      || source.branch_id !== (selection.branchId ?? null) || source.revision !== (selection.revision ?? null)
      || source.mode !== selection.mode
      || source.live_root?.hostId !== selection.liveRoot?.hostId || source.live_root?.canonicalRoot !== selection.liveRoot?.canonicalRoot || source.live_root?.rootId !== selection.liveRoot?.rootId
      || (source.environment_run_id ?? undefined) !== selection.environmentRunId) throw new SourceAdmissionError('source_changed');
    const selectedNames = [...tools].sort();
    if (JSON.stringify(selectedNames) !== JSON.stringify(sourceToolSchemas(saved.selection).map(tool => tool.name).sort())) throw new Error('Rebind cannot change its durable tools');
  }
  const credentialScope = options.credentialOwner ? await options.credentialOwner.scope() : undefined;
  if (!saved) await runtime.selectLaunch({ runId: run.id,
    source: { resourceOwner: selection.resourceOwner, mode: selection.mode, liveRoot: selection.liveRoot ?? null, workspaceId: selection.workspaceId,
      executionWorkspaceId: selection.executionWorkspaceId, branchId: selection.branchId ?? null, revision: selection.revision ?? null,
      ...(selection.environmentRunId ? { environmentRunId: selection.environmentRunId } : {}) },
    enabledTools: tools, ...(credentialScope ? { credentialScope } : {}),
  }, signal);
  const authority = await admitRunSourceAuthority(kernel, runtime, selection, { ...options, allowMaterialization: true });
  try {
    await runtime.reconcileRun(run.id, authority.toolBinding, signal);
    await runtime.prepareMcp(run.id, selection, authority.kind === 'local' ? authority.canonicalRoot : undefined, signal);
    return options.credentialOwner
      ? await runtime.startRunWithCredentialOwner(run.id, options.credentialOwner, signal, authority.toolBinding)
      : await runtime.startRun(run.id, signal, authority.toolBinding);
  } catch (error) {
    await authority.release().catch(() => undefined);
    throw error;
  }
}

/** Rebinds the original durable source under a fresh permit. This never starts a Run.
 * Existing environments are only registered; materialization is reserved for initial launch. */
export async function admitRunSourceAuthority(
  kernel: KernelClient,
  runtime: AgentRuntimeClient,
  selection: SourceLaunch,
  options: { signal?: AbortSignal; resolveLiveSource?: LiveSourceResolver; allowMaterialization?: boolean; purpose?: 'source' | 'integration' | 'result'; operationId?: string; retention?: 'run' | 'caller' } = {},
) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const run = await runtime.run(selection.runId, signal);
  const saved = await runtime.launch(run.id, signal);
  const sourceSelection = saved?.selection.source;
  if (!sourceSelection || !isDeepStrictEqual(sourceSelection.resource_owner, selection.resourceOwner) || sourceSelection.workspace_id !== selection.workspaceId
    || sourceSelection.execution_workspace_id !== selection.executionWorkspaceId
    || sourceSelection.mode !== selection.mode
    || sourceSelection.branch_id !== (selection.branchId ?? null)
    || sourceSelection.revision !== (selection.revision ?? null)
    || (sourceSelection.environment_run_id ?? undefined) !== selection.environmentRunId
    || sourceSelection.live_root?.hostId !== selection.liveRoot?.hostId
    || sourceSelection.live_root?.rootId !== selection.liveRoot?.rootId
    || sourceSelection.live_root?.canonicalRoot !== selection.liveRoot?.canonicalRoot) throw new SourceAdmissionError('source_changed');
  const tools = [...new Set(selection.tools)];
  if (JSON.stringify([...tools].sort()) !== JSON.stringify(sourceToolSchemas(saved.selection).map(tool => tool.name).sort())) throw new Error('Source authority cannot change the admitted tools');
  if (selection.mode === 'live_root' && selection.resourceOwner.kind === 'local') {
    if (!options.resolveLiveSource) throw new Error('Live source requires its Documents resource owner');
    await options.resolveLiveSource(selection, signal);
  }
  const resultOnly = options.purpose === 'result';
  if (resultOnly) {
    const child = await runtime.childExecutionForRun(run.id, signal);
    if (!child || child.receipt?.run_id !== run.id || child.source?.kind !== 'ready'
      || !['settling', 'candidate', 'published'].includes(child.code_result.kind)
      || !['completed', 'failed', 'cancelled'].includes(run.state)) throw new Error('Fixed result authority requires the original stopped child settlement');
  }
  const integration = options.purpose === 'integration';
  if (integration) {
    if (selection.mode === 'fixed_branch' || !options.operationId) throw new Error('Integration requires an admitted physical target Operation');
    const operation = await runtime.operation(options.operationId, signal);
    if (operation.run_id !== run.id || operation.phase !== 'running' || operation.executor !== 'integrate_child'
      || operation.execution_owner?.kind !== 'external' || operation.cancel_requested) throw new Error('Integration target authority requires its original active Host tool Operation');
  }
  if (options.retention === 'caller') {
    if (!options.operationId) throw new Error('Independent source lifetime requires its actual Operation');
    const operation = await runtime.operation(options.operationId, signal);
    const liveCall = operation.lifetime === 'run' && operation.phase === 'running' && !operation.cancel_requested && !run.cancel_requested;
    if (operation.run_id !== run.id || (!liveCall && operation.lifetime !== 'thread' && !(operation.lifetime === 'environment' && operation.managed_process?.purpose.kind === 'script_environment')) || operation.execution_owner?.kind !== 'external') throw new Error('Caller-retained source Operation differs from its original Thread/Run owner');
  }
  if (selection.resourceOwner.kind === 'managed_host') {
    const service = await runtime.managedSource(selection.resourceOwner, signal);
    const binding = await service.bind({ coordinatorHostId: runtime.coordinatorHostId,
      scope: { kind: 'run', threadId: run.thread_id, runId: run.id, epoch: run.epoch },
      source: { ...selection, tools: [...selection.tools] }, purpose: options.purpose ?? 'source', retention: options.retention ?? 'run',
      ...(options.operationId ? { operationId: options.operationId } : {}),
    }, signal);
    if (!isDeepStrictEqual(binding.source, sourceSelection)) throw new SourceAdmissionError('source_changed');
    const fixed = { branchId: selection.branchId!, revision: selection.revision! };
    const toolBinding: SourceToolBinding = {
      resourceOwner: selection.resourceOwner, grantId: binding.authorityId, runId: run.id, threadId: run.thread_id,
      workspaceId: selection.workspaceId, executionWorkspaceId: selection.executionWorkspaceId,
      enabledTools: resultOnly ? [] : tools, sourceMode: selection.mode,
      remoteAuthority: { authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, executionOwner: binding.executionOwner },
      ...(selection.environmentRunId ? { environmentRunId: selection.environmentRunId } : {}),
      ...(selection.mode === 'fixed_branch' ? { fileSource: fixed } : selection.mode === 'materialized'
        ? { ...(binding.physicalRoot ? { rootId: binding.physicalRoot.rootId } : {}), materializedSource: fixed }
        : { ...(binding.physicalRoot ? { rootId: binding.physicalRoot.rootId } : {}), liveRoot: selection.liveRoot! }),
    };
    if ((options.purpose ?? 'source') === 'source' && (options.retention ?? 'run') === 'run') runtime.retainManagedSourceBinding(run.id, binding, service);
    return { kind: 'managed' as const, binding, service, toolBinding, release: async () => {
      await service.release({ coordinatorHostId: runtime.coordinatorHostId, authorityId: binding.authorityId,
        resourceEpoch: binding.resourceEpoch, mode: 'retire' });
    } };
  }
  if (selection.mode !== 'live_root') await runtime.admitSourceRegistration(selection, signal);
  // Do not use old grants from the durable selection. Each Host lifetime issues its own permit.
  const grant = await kernel.issueGrant({
    grantId: `source:${randomUUID()}`,
    owningWorkspace: selection.workspaceId,
    executionWorkspace: selection.executionWorkspaceId,
    threadId: run.thread_id,
    runId: run.id,
    ...(options.retention === 'caller' ? { operationId: options.operationId } : {}),
    capabilities: ['storage.read', 'storage.write', ...(integration ? ['recovery'] : []), ...(saved.selection.tools.some(tool => tool.requirements?.process) ? ['process'] : [])],
    pathScopes: [''],
  }, signal);

  if (options.retention !== 'caller') runtime.retainSourceGrant(run.id, grant.grantId);
  const release = async (): Promise<void> => { if (options.retention === 'caller') await kernel.retireGrant(grant.grantId); else await runtime.releaseSourceGrant(run.id, grant.grantId); };
  const actor = kernel.scoped(grant);
  try {
    let rootId: string | undefined;
    let executionCwd: string | undefined;
    const source = selection.mode === 'live_root' ? undefined : await actor.readBranch({ branchId: selection.branchId, revision: selection.revision, includeEntries: false }, signal).catch(error => { throw sourceReadError(error); });
    if (source && (source.workspaceId !== selection.workspaceId || source.branchId !== selection.branchId
      || source.view !== 'revision' || source.revision !== selection.revision)) throw new SourceAdmissionError('source_changed');
    if (!resultOnly && selection.mode === 'live_root') {
      // Fresh authority is mandatory even when the durable root identity is unchanged.
      const registered = await actor.fileRootRegister({ workspaceId: selection.workspaceId,
        executionWorkspaceId: selection.executionWorkspaceId, canonicalRoot: selection.liveRoot.canonicalRoot }, signal);
      signal?.throwIfAborted();
      if (registered.rootId !== selection.liveRoot.rootId || typeof registered.canonicalRoot !== 'string'
        || normalizePathIdentity(registered.canonicalRoot) !== normalizePathIdentity(selection.liveRoot.canonicalRoot)) throw new Error('Live source root changed');
      rootId = selection.liveRoot.rootId;
      executionCwd = selection.liveRoot.canonicalRoot;
    }
    if (!resultOnly && selection.mode === 'materialized') {
      const handshake = kernel.handshake ?? await kernel.start();
      const { storageRoot, key, relativeTarget, targetPath } = await originalMaterializationLocation(handshake.storageRoot, selection.workspaceId, selection.environmentRunId ?? run.id);
      if (options.allowMaterialization && !selection.environmentRunId) {
      const container = await actor.fileRootRegister({ workspaceId: selection.workspaceId, executionWorkspaceId: selection.executionWorkspaceId, canonicalRoot: storageRoot }, signal);
      if (typeof container.rootId !== 'string') throw new Error('Materialization root registration failed');
      const result = await actor.fileMaterialize({
        operationId: `source-materialize:${key}`,
        workspaceId: selection.workspaceId,
        rootId: container.rootId,
        path: relativeTarget,
        sourceRoot: source!.root,
      }, signal);
      if (result.status !== 'materialized') throw new Error('Source materialization requires reconciliation');
      }
      const canonicalRoot = await admitMaterializedRoot(targetPath, signal);
      const registered = await actor.fileRootRegister({ workspaceId: selection.workspaceId, executionWorkspaceId: selection.executionWorkspaceId, canonicalRoot }, signal);
      if (typeof registered.rootId !== 'string') throw new Error('Execution root registration failed');
      rootId = registered.rootId;
      executionCwd = canonicalRoot;
    }
    const fixed = { branchId: selection.branchId!, revision: selection.revision! };
    const toolBinding: SourceToolBinding = {
      resourceOwner: selection.resourceOwner, grantId: grant.grantId, runId: run.id, threadId: run.thread_id,
      workspaceId: selection.workspaceId, executionWorkspaceId: selection.executionWorkspaceId,
      enabledTools: resultOnly ? [] : tools, sourceMode: selection.mode,
      ...(selection.environmentRunId ? { environmentRunId: selection.environmentRunId } : {}),
      ...(selection.mode === 'fixed_branch' ? { fileSource: fixed }
        : selection.mode === 'materialized' ? { ...(rootId ? { rootId } : {}), materializedSource: fixed } : { ...(rootId ? { rootId } : {}), liveRoot: selection.liveRoot! }),
    };
    if (selection.mode !== 'live_root') await runtime.admitSourceRegistration(selection, signal);
    return { kind: 'local' as const, grant, client: actor, rootId, canonicalRoot: executionCwd, toolBinding,
      release };
  } catch (error) {
    await release().catch(() => undefined);
    throw error;
  }
}

export function savedSourceLaunch(
  runId: string,
  source: NonNullable<LaunchIntent['selection']['source']>,
  tools: SourceLaunch['tools'],
  previousRunId?: string,
): SourceLaunch {
  const base = {
    resourceOwner: source.resource_owner, runId,
    workspaceId: source.workspace_id,
    executionWorkspaceId: source.execution_workspace_id,
    tools,
  };
  if (source.mode === 'live_root') {
    if (
      !source.live_root ||
      source.branch_id !== null ||
      source.revision !== null ||
      source.environment_run_id
    )
      throw new Error('Saved live environment is incomplete');
    return { ...base, mode: 'live_root', liveRoot: source.live_root };
  }
  if (
    source.branch_id === null ||
    source.revision === null ||
    source.live_root
  )
    throw new Error('Saved fixed environment is incomplete');
  const environmentRunId = source.environment_run_id ?? previousRunId;
  return {
    ...base,
    mode: source.mode,
    branchId: source.branch_id,
    revision: source.revision,
    ...(source.mode === 'materialized' && environmentRunId
      ? { environmentRunId }
      : {}),
  };
}
