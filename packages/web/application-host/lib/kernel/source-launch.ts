import type { LiveSourceResolver } from './live-source.js';
import type { ThreadSource } from '@varin/application-client';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { LaunchIntent, RunStartReceipt } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';

/** Explicit Host-selected source. Live identity is revalidated through Documents before binding. */
export type SourceLaunch = Omit<ThreadSource, 'mode' | 'branchId' | 'revision' | 'liveRoot' | 'tools'> & {
  runId: string;
  tools: readonly ThreadSource['tools'][number][];
} & (
  | { mode: 'fixed_branch' | 'materialized'; branchId: string; revision: number; environmentRunId?: string; liveRoot?: never }
  | { mode: 'live_root'; liveRoot: import('./protocol.generated.js').LiveRoot; branchId?: never; revision?: never; environmentRunId?: never }
);

/** Project only source-owned declarations from the same frozen launch directory. */
const sourceToolNames = new Set(['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'process_inspect',
  'process_read', 'process_spawn', 'process_write', 'process_resize', 'language_definition', 'language_references', 'language_diagnostics', 'code_retrieval']);
export function sourceToolSchemas(selection: LaunchIntent['selection']) {
  const external = new Set([
    ...(selection.mcp_binding?.tools.map(tool => tool.name) ?? []),
    ...selection.extension_bindings.map(binding => binding.tool.name),
  ]);
  return selection.tools.filter(tool => !external.has(tool.name) && sourceToolNames.has(tool.name));
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
  if (selection.mode === 'live_root') {
    if (!options.resolveLiveSource) throw new Error('Live source requires its Documents resource owner');
    if (!selection.liveRoot || ![selection.liveRoot.hostId, selection.liveRoot.rootId, selection.liveRoot.canonicalRoot].every(value => typeof value === 'string' && value.length > 0)
      || selection.branchId !== undefined || selection.revision !== undefined || selection.environmentRunId !== undefined) throw new Error('Live source identity is incomplete');
    await options.resolveLiveSource(selection, signal);
  } else if ((selection.mode !== 'fixed_branch' && selection.mode !== 'materialized')
    || typeof selection.branchId !== 'string' || !selection.branchId || !Number.isSafeInteger(selection.revision) || selection.revision < 0) {
    throw new Error('Fixed source requires a complete branch revision');
  }
  const tools = [...new Set(selection.tools)];
  if (tools.some(tool => !sourceToolNames.has(tool))) throw new Error('Source launch selected an unavailable tool');
  if (selection.mode !== 'live_root' && tools.some(tool => tool.startsWith('language_'))) throw new Error('Language tools require live_root; fixed dependency closure is unavailable');
  if (selection.mode !== 'live_root' && tools.includes('code_retrieval')) throw new Error('Code retrieval requires live_root; fixed retrieval inputs are unavailable');
  if (selection.mode === 'fixed_branch' && tools.some(tool => ['process_spawn', 'process_write', 'process_resize', 'file_write', 'file_edit'].includes(tool))) throw new Error('Mutating tools require an explicitly selected physical source');
  const run = await runtime.run(selection.runId, signal);
  if (['completed', 'failed', 'cancelled'].includes(run.state) || run.cancel_requested) throw new Error('Run is closed to launch');
  const saved = await runtime.launch(run.id, signal);
  if (saved) {
    const source = saved.selection.source;
    if (!source || source.workspace_id !== selection.workspaceId || source.execution_workspace_id !== selection.executionWorkspaceId
      || source.branch_id !== (selection.branchId ?? null) || source.revision !== (selection.revision ?? null)
      || source.mode !== selection.mode
      || source.live_root?.hostId !== selection.liveRoot?.hostId || source.live_root?.canonicalRoot !== selection.liveRoot?.canonicalRoot || source.live_root?.rootId !== selection.liveRoot?.rootId
      || (source.environment_run_id ?? undefined) !== selection.environmentRunId) throw new Error('Rebind cannot change its durable source selection');
    const selectedNames = [...tools].sort();
    if (JSON.stringify(selectedNames) !== JSON.stringify(sourceToolSchemas(saved.selection).map(tool => tool.name).sort())) throw new Error('Rebind cannot change its durable tools');
  }
  const credentialScope = options.credentialOwner ? await options.credentialOwner.scope() : undefined;
  if (!saved) await runtime.selectLaunch({ runId: run.id,
    source: { mode: selection.mode, liveRoot: selection.liveRoot ?? null, workspaceId: selection.workspaceId,
      executionWorkspaceId: selection.executionWorkspaceId, branchId: selection.branchId ?? null, revision: selection.revision ?? null,
      ...(selection.environmentRunId ? { environmentRunId: selection.environmentRunId } : {}) },
    enabledTools: tools, ...(credentialScope ? { credentialScope } : {}),
  }, signal);
  const authority = await admitRunSourceAuthority(kernel, runtime, selection, { ...options, allowMaterialization: true });
  try {
    await runtime.reconcileRun(run.id, authority.toolBinding, signal);
    await runtime.prepareMcp(run.id, selection, authority.canonicalRoot, signal);
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
  options: { signal?: AbortSignal; resolveLiveSource?: LiveSourceResolver; allowMaterialization?: boolean; purpose?: 'source' | 'integration' | 'result'; operationId?: string } = {},
) {
  const signal = options.signal;
  signal?.throwIfAborted();
  const run = await runtime.run(selection.runId, signal);
  const saved = await runtime.launch(run.id, signal);
  const sourceSelection = saved?.selection.source;
  if (!sourceSelection || sourceSelection.workspace_id !== selection.workspaceId
    || sourceSelection.execution_workspace_id !== selection.executionWorkspaceId
    || sourceSelection.mode !== selection.mode
    || sourceSelection.branch_id !== (selection.branchId ?? null)
    || sourceSelection.revision !== (selection.revision ?? null)
    || (sourceSelection.environment_run_id ?? undefined) !== selection.environmentRunId
    || sourceSelection.live_root?.hostId !== selection.liveRoot?.hostId
    || sourceSelection.live_root?.rootId !== selection.liveRoot?.rootId
    || sourceSelection.live_root?.canonicalRoot !== selection.liveRoot?.canonicalRoot) throw new Error('Source authority must match the original durable Run source');
  const tools = [...new Set(selection.tools)];
  if (JSON.stringify([...tools].sort()) !== JSON.stringify(sourceToolSchemas(saved.selection).map(tool => tool.name).sort())) throw new Error('Source authority cannot change the admitted tools');
  if (selection.mode === 'live_root') {
    if (!options.resolveLiveSource) throw new Error('Live source requires its Documents resource owner');
    await options.resolveLiveSource(selection, signal);
  }
  const resultOnly = options.purpose === 'result';
  if (resultOnly) {
    const child = await runtime.childForThread(run.thread_id, signal);
    if (!child || child.receipt?.run_id !== run.id || child.source.kind !== 'ready'
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
  // Do not use old grants from the durable selection. Each Host lifetime issues its own permit.
  const grant = await kernel.issueGrant({
    grantId: `source:${randomUUID()}`,
    owningWorkspace: selection.workspaceId,
    executionWorkspace: selection.executionWorkspaceId,
    threadId: run.thread_id,
    runId: run.id,
    capabilities: ['storage.read', 'storage.write', ...(integration ? ['recovery'] : []), ...(tools.some(tool => tool.startsWith('process_')) ? ['process'] : [])],
    pathScopes: [''],
  }, signal);

  runtime.retainSourceGrant(run.id, grant.grantId);
  const actor = kernel.scoped(grant);
  try {
    let rootId: string | undefined;
    let executionCwd: string | undefined;
    const source = selection.mode === 'live_root' ? undefined : await actor.readBranch({ branchId: selection.branchId, revision: selection.revision, includeEntries: false }, signal);
    if (source && (source.workspaceId !== selection.workspaceId || source.branchId !== selection.branchId
      || source.view !== 'revision' || source.revision !== selection.revision)) throw new Error('Launch source returned a different fixed revision');
    if (!resultOnly && selection.mode === 'live_root') {
      // Fresh authority is mandatory even when the durable root identity is unchanged.
      const registered = await actor.fileRootRegister({ workspaceId: selection.workspaceId,
        executionWorkspaceId: selection.executionWorkspaceId, canonicalRoot: selection.liveRoot.canonicalRoot }, signal);
      signal?.throwIfAborted();
      if (registered.rootId !== selection.liveRoot.rootId || registered.canonicalRoot !== selection.liveRoot.canonicalRoot) throw new Error('Live source root changed');
      rootId = selection.liveRoot.rootId;
      executionCwd = selection.liveRoot.canonicalRoot;
    }
    if (!resultOnly && selection.mode === 'materialized') {
      const handshake = kernel.handshake ?? await kernel.start();
      const storageRoot = await canonicalizePathIdentity(handshake.storageRoot);
      const key = createHash('sha256').update(JSON.stringify([selection.workspaceId, selection.environmentRunId ?? run.id])).digest('hex');
      const relativeTarget = `managed/runs/${key}`;
      const targetPath = path.resolve(storageRoot, relativeTarget);
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
      const canonicalRoot = await canonicalizePathIdentity(targetPath);
      if (!isPathWithinRoot(canonicalRoot, path.join(storageRoot, 'managed', 'runs'))) throw new Error('Materialization escaped its managed directory');
      const registered = await actor.fileRootRegister({ workspaceId: selection.workspaceId, executionWorkspaceId: selection.executionWorkspaceId, canonicalRoot }, signal);
      if (typeof registered.rootId !== 'string') throw new Error('Execution root registration failed');
      rootId = registered.rootId;
      executionCwd = canonicalRoot;
    }
    const fixed = { branchId: selection.branchId, revision: selection.revision };
    const toolBinding = {
      grantId: grant.grantId, runId: run.id, threadId: run.thread_id,
      workspaceId: selection.workspaceId, executionWorkspaceId: selection.executionWorkspaceId,
      enabledTools: tools, sourceMode: selection.mode,
      ...(selection.environmentRunId ? { environmentRunId: selection.environmentRunId } : {}),
      ...(selection.mode === 'fixed_branch' ? { fileSource: fixed }
        : selection.mode === 'materialized' ? { rootId, materializedSource: fixed } : { rootId, liveRoot: selection.liveRoot }),
    };
    return { grant, client: actor, rootId, canonicalRoot: executionCwd, toolBinding,
      release: () => runtime.releaseSourceGrant(run.id, grant.grantId) };
  } catch (error) {
    await runtime.releaseSourceGrant(run.id, grant.grantId).catch(() => undefined);
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
    runId,
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
