import type { NativeLiveSourceResolver } from './native-live-source.js';
import type { NativeThreadSource } from '@varin/application-client';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { KernelClient } from './kernel-client.js';
import type { NativeRuntimeClient } from './native-runtime-client.js';
import type { NativeRunStartReceipt } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './native-credential-owner.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';

/** Explicit Host-selected source. Live identity is revalidated through Documents before binding. */
export type NativeSourceLaunch = Omit<NativeThreadSource, 'mode' | 'branchId' | 'revision' | 'liveRoot' | 'tools'> & {
  runId: string;
  tools: readonly NativeThreadSource['tools'][number][];
} & (
  | { mode: 'fixed_branch' | 'materialized'; branchId: string; revision: number; environmentRunId?: string; liveRoot?: never }
  | { mode: 'live_root'; liveRoot: import('./protocol.generated.js').NativeLiveRoot; branchId?: never; revision?: never; environmentRunId?: never }
);

/** Uses the existing Storage authority for source reads, materialization and process containment.
 * Only an explicitly selected live_root uses the original workspace; fixed revisions never fall back to disk.
 */
export async function startNativeRunFromSource(
  kernel: KernelClient,
  runtime: NativeRuntimeClient,
  selection: NativeSourceLaunch,
  options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal; resolveLiveSource?: NativeLiveSourceResolver } = {},
): Promise<NativeRunStartReceipt> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (![selection.runId, selection.workspaceId, selection.executionWorkspaceId].every(value => typeof value === 'string' && value.length > 0)) throw new Error('Native launch requires complete source identity');
  if (selection.mode === 'live_root') {
    if (!options.resolveLiveSource) throw new Error('Live source requires its Documents resource owner');
    if (!selection.liveRoot || ![selection.liveRoot.hostId, selection.liveRoot.rootId, selection.liveRoot.canonicalRoot].every(value => typeof value === 'string' && value.length > 0)
      || selection.branchId !== undefined || selection.revision !== undefined || selection.environmentRunId !== undefined) throw new Error('Native live source identity is incomplete');
    await options.resolveLiveSource(selection, signal);
  } else if ((selection.mode !== 'fixed_branch' && selection.mode !== 'materialized')
    || typeof selection.branchId !== 'string' || !selection.branchId || !Number.isSafeInteger(selection.revision) || selection.revision < 0) {
    throw new Error('Native fixed source requires a complete branch revision');
  }
  const tools = [...new Set(selection.tools)];
  if (tools.some(tool => !['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'process_inspect', 'process_read', 'process_spawn', 'language_definition', 'language_references', 'language_diagnostics', 'code_retrieval'].includes(tool))) throw new Error('Native source launch selected an unavailable tool');
  if (selection.mode !== 'live_root' && tools.some(tool => tool.startsWith('language_'))) throw new Error('Language tools require live_root; fixed dependency closure is unavailable');
  if (selection.mode !== 'live_root' && tools.includes('code_retrieval')) throw new Error('Code retrieval requires live_root; fixed retrieval inputs are unavailable');
  if (selection.mode === 'fixed_branch' && tools.some(tool => ['process_spawn', 'file_write', 'file_edit'].includes(tool))) throw new Error('Mutating tools require an explicitly selected physical source');
  const run = await runtime.run(selection.runId, signal);
  if (['completed', 'failed', 'cancelled'].includes(run.state) || run.cancel_requested) throw new Error('Native Run is closed to launch');
  const saved = await runtime.launch(run.id, signal);
  if (saved) {
    const source = saved.selection.source;
    if (!source || source.workspace_id !== selection.workspaceId || source.execution_workspace_id !== selection.executionWorkspaceId
      || source.branch_id !== (selection.branchId ?? null) || source.revision !== (selection.revision ?? null)
      || source.mode !== selection.mode
      || source.live_root?.hostId !== selection.liveRoot?.hostId || source.live_root?.canonicalRoot !== selection.liveRoot?.canonicalRoot || source.live_root?.rootId !== selection.liveRoot?.rootId
      || (source.environment_run_id ?? undefined) !== selection.environmentRunId) throw new Error('Native rebind cannot change its durable source selection');
    const selectedNames = tools.map(tool => `native_${tool}`).sort();
    if (JSON.stringify(selectedNames) !== JSON.stringify(saved.selection.tools.filter(tool => !['native_ask_user', 'native_dispatch', 'native_child_status', 'native_wait_child', 'native_child_report', 'native_wait_process', 'native_memory'].includes(tool.name) && !saved.selection.mcp_binding?.tools.some(mcp => mcp.name === tool.name)).map(tool => tool.name).sort())) throw new Error('Native rebind cannot change its durable tools');
  }
  const credentialScope = options.credentialOwner ? await options.credentialOwner.scope() : undefined;
  if (!saved) await runtime.selectLaunch({ runId: run.id,
    source: { mode: selection.mode, liveRoot: selection.liveRoot ?? null, workspaceId: selection.workspaceId,
      executionWorkspaceId: selection.executionWorkspaceId, branchId: selection.branchId ?? null, revision: selection.revision ?? null,
      ...(selection.environmentRunId ? { environmentRunId: selection.environmentRunId } : {}) },
    enabledTools: tools, ...(credentialScope ? { credentialScope } : {}),
  }, signal);
  // Do not use old grants from the durable selection. Each Host lifetime issues its own permit.
  const grant = await kernel.issueGrant({
    grantId: `native-source:${randomUUID()}`,
    owningWorkspace: selection.workspaceId,
    executionWorkspace: selection.executionWorkspaceId,
    threadId: run.thread_id,
    runId: run.id,
    capabilities: ['storage.read', 'storage.write', ...(tools.some(tool => tool.startsWith('process_')) ? ['process'] : [])],
    pathScopes: [''],
  }, signal);
  runtime.retainSourceGrant(run.id, grant.grantId);
  const actor = kernel.scoped(grant);
  try {
    let rootId: string | undefined;
    let executionCwd: string | undefined;
    const source = selection.mode === 'live_root' ? undefined : await actor.readBranch({ branchId: selection.branchId, revision: selection.revision, includeEntries: false }, signal);
    if (source && (source.workspaceId !== selection.workspaceId || source.branchId !== selection.branchId
      || source.view !== 'revision' || source.revision !== selection.revision)) throw new Error('Native launch source returned a different fixed revision');
    if (selection.mode === 'live_root') {
      // Fresh authority is mandatory even when the durable root identity is unchanged.
      const registered = await actor.fileRootRegister({ workspaceId: selection.workspaceId,
        executionWorkspaceId: selection.executionWorkspaceId, canonicalRoot: selection.liveRoot.canonicalRoot }, signal);
      signal?.throwIfAborted();
      if (registered.rootId !== selection.liveRoot.rootId || registered.canonicalRoot !== selection.liveRoot.canonicalRoot) throw new Error('Native live source root changed');
      rootId = selection.liveRoot.rootId;
      executionCwd = selection.liveRoot.canonicalRoot;
    }
    if (selection.mode === 'materialized') {
      const handshake = kernel.handshake ?? await kernel.start();
      const storageRoot = await canonicalizePathIdentity(handshake.storageRoot);
      const key = createHash('sha256').update(JSON.stringify([selection.workspaceId, selection.environmentRunId ?? run.id])).digest('hex');
      const relativeTarget = `managed/native-runs/${key}`;
      const targetPath = path.resolve(storageRoot, relativeTarget);
      if (!selection.environmentRunId) {
      const container = await actor.fileRootRegister({ workspaceId: selection.workspaceId, executionWorkspaceId: selection.executionWorkspaceId, canonicalRoot: storageRoot }, signal);
      if (typeof container.rootId !== 'string') throw new Error('Native materialization root registration failed');
      const result = await actor.fileMaterialize({
        operationId: `native-source-materialize:${key}`,
        workspaceId: selection.workspaceId,
        rootId: container.rootId,
        path: relativeTarget,
        sourceRoot: source!.root,
      }, signal);
      if (result.status !== 'materialized') throw new Error('Native source materialization requires reconciliation');
      }
      const canonicalRoot = await canonicalizePathIdentity(targetPath);
      if (!isPathWithinRoot(canonicalRoot, path.join(storageRoot, 'managed', 'native-runs'))) throw new Error('Native materialization escaped its managed directory');
      const registered = await actor.fileRootRegister({ workspaceId: selection.workspaceId, executionWorkspaceId: selection.executionWorkspaceId, canonicalRoot }, signal);
      if (typeof registered.rootId !== 'string') throw new Error('Native execution root registration failed');
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
    await runtime.reconcileRun(run.id, toolBinding, signal);
    await runtime.prepareMcp(run.id, selection, executionCwd, signal);
    return options.credentialOwner
      ? await runtime.startRunWithCredentialOwner(run.id, options.credentialOwner, signal, toolBinding)
      : await runtime.startRun(run.id, signal, toolBinding);
  } catch (error) {
    // Revocation is a control request, not a claim that an already accepted effect stopped.
    await runtime.releaseSourceGrant(run.id, grant.grantId).catch(() => undefined);
    throw error;
  }
}
