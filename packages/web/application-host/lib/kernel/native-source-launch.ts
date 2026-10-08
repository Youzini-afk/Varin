import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { KernelClient } from './kernel-client.js';
import type { NativeRuntimeClient } from './native-runtime-client.js';
import type { NativeRunStartReceipt } from './protocol.generated.js';
import type { ExistingHostCredentialOwner } from './native-credential-owner.js';
import { canonicalizePathIdentity, isPathWithinRoot } from '../workspace/path-safety.js';

/** Selected by the trusted Host from an existing immutable WorkingState publication. */
export interface NativeSourceLaunch {
  runId: string;
  workspaceId: string;
  executionWorkspaceId: string;
  branchId: string;
  revision: number;
  environmentRunId?: string;
  mode: 'fixed_branch' | 'materialized';
  tools: readonly ('file_read' | 'file_write' | 'file_edit' | 'process_inspect' | 'process_read' | 'process_spawn')[];
}

/** Uses the existing Storage authority for source reads, materialization and process containment.
 * A Run never borrows the workspace's current directory as a substitute for its selected revision.
 */
export async function startNativeRunFromSource(
  kernel: KernelClient,
  runtime: NativeRuntimeClient,
  selection: NativeSourceLaunch,
  options: { credentialOwner?: ExistingHostCredentialOwner; signal?: AbortSignal } = {},
): Promise<NativeRunStartReceipt> {
  const signal = options.signal;
  signal?.throwIfAborted();
  if (![selection.runId, selection.workspaceId, selection.executionWorkspaceId, selection.branchId].every(value => typeof value === 'string' && value.length > 0)
    || !Number.isSafeInteger(selection.revision) || selection.revision < 0) throw new Error('Native launch requires a complete fixed source identity');
  if (selection.mode !== 'fixed_branch' && selection.mode !== 'materialized') throw new Error('Native source mode is unavailable');
  const tools = [...new Set(selection.tools)];
  if (tools.some(tool => !['file_read', 'file_write', 'file_edit', 'process_inspect', 'process_read', 'process_spawn'].includes(tool))) throw new Error('Native source launch selected an unavailable tool');
  if (selection.mode === 'fixed_branch' && tools.some(tool => ['process_spawn', 'file_write', 'file_edit'].includes(tool))) throw new Error('Mutating tools require the selected source to be materialized');
  const run = await runtime.run(selection.runId, signal);
  if (['completed', 'failed', 'cancelled'].includes(run.state) || run.cancel_requested) throw new Error('Native Run is closed to launch');
  const saved = await runtime.launch(run.id, signal);
  if (saved) {
    const source = saved.selection.source;
    if (!source || source.workspace_id !== selection.workspaceId || source.execution_workspace_id !== selection.executionWorkspaceId
      || source.branch_id !== selection.branchId || source.revision !== selection.revision
      || source.materialized !== (selection.mode === 'materialized')
      || (source.environment_run_id ?? undefined) !== selection.environmentRunId) throw new Error('Native rebind cannot change its durable source selection');
    const selectedNames = tools.map(tool => `native_${tool}`).sort();
    if (JSON.stringify(selectedNames) !== JSON.stringify(saved.selection.tools.map(tool => tool.name).sort())) throw new Error('Native rebind cannot change its durable tools');
  }
  const credentialScope = options.credentialOwner ? await options.credentialOwner.scope() : undefined;
  await runtime.selectLaunch({ runId: run.id,
    source: { materialized: selection.mode === 'materialized', workspaceId: selection.workspaceId,
      executionWorkspaceId: selection.executionWorkspaceId, branchId: selection.branchId, revision: selection.revision,
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
  const actor = kernel.scoped(grant);
  try {
    const source = await actor.readBranch({ branchId: selection.branchId, revision: selection.revision, includeEntries: false }, signal);
    if (source.workspaceId !== selection.workspaceId || source.branchId !== selection.branchId
      || source.view !== 'revision' || source.revision !== selection.revision) throw new Error('Native launch source returned a different fixed revision');
    let rootId: string | undefined;
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
        sourceRoot: source.root,
      }, signal);
      if (result.status !== 'materialized') throw new Error('Native source materialization requires reconciliation');
      }
      const canonicalRoot = await canonicalizePathIdentity(targetPath);
      if (!isPathWithinRoot(canonicalRoot, path.join(storageRoot, 'managed', 'native-runs'))) throw new Error('Native materialization escaped its managed directory');
      const registered = await actor.fileRootRegister({ workspaceId: selection.workspaceId, executionWorkspaceId: selection.executionWorkspaceId, canonicalRoot }, signal);
      if (typeof registered.rootId !== 'string') throw new Error('Native execution root registration failed');
      rootId = registered.rootId;
    }
    const fixed = { branchId: selection.branchId, revision: selection.revision };
    const toolBinding = {
      grantId: grant.grantId, runId: run.id, threadId: run.thread_id,
      workspaceId: selection.workspaceId, executionWorkspaceId: selection.executionWorkspaceId,
      enabledTools: tools, sourceMode: selection.mode,
      ...(selection.environmentRunId ? { environmentRunId: selection.environmentRunId } : {}),
      ...(selection.mode === 'fixed_branch' ? { fileSource: fixed } : { rootId, materializedSource: fixed }),
    };
    return options.credentialOwner
      ? await runtime.startRunWithCredentialOwner(run.id, options.credentialOwner, signal, toolBinding)
      : await runtime.startRun(run.id, signal, toolBinding);
  } catch (error) {
    // Revocation is a control request, not a claim that an already accepted effect stopped.
    await kernel.revokeGrant(grant.grantId).catch(() => undefined);
    throw error;
  }
}
