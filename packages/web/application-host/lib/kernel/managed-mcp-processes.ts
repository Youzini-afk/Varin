/** Target MCP pipes under the original Source grant and native process receipts. */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { StdioTransport, StreamableHttpTransport, type McpTransport, type StdioTransportOptions } from '@varin/pi-host/mcp-authority';
import { KernelManagedProcess } from './process-service.js';
import type { KernelClient } from './kernel-client.js';
import { KernelClientError } from './kernel-error.js';
import type { ManagedSourceLocalScope } from '../harness/managed-remote-types.js';
import type { ManagedPipedProcessHandle, ManagedProcessOwner } from '../process/types.js';
import { ManagedProcessLaunchError, terminateManagedProcess } from '../process/types.js';
import { canonicalizePathIdentity, normalizePathIdentity } from '../workspace/path-safety.js';
import { createMcpProcessTransport } from './mcp-process-transport.js';

export function createManagedMcpProcesses(input: {
  kernel: KernelClient;
  scope: ManagedSourceLocalScope;
  readmit(signal: AbortSignal): Promise<void>;
  onError(error: Error): void;
}) {
  const { kernel, scope } = input;
  const controller = new AbortController();
  let external = false, stopped = false;
  const handles = new Set<KernelManagedProcess>();
  const unobserved = new Set<string>();
  const launches = new Set<Promise<ManagedPipedProcessHandle>>();
  const unsubscribe = kernel.subscribeExit(error => {
    controller.abort(); for (const handle of handles) handle.invalidate(error);
  });
  const launch = async (options: Readonly<StdioTransportOptions>, signal: AbortSignal): Promise<ManagedPipedProcessHandle> => {
    const selected = AbortSignal.any([signal, controller.signal]);
    selected.throwIfAborted(); await input.readmit(selected);
    const root = scope.physicalRoot;
    if (!root || scope.source.resource_owner.kind !== 'managed_host' || root.hostId !== scope.source.resource_owner.hostId)
      throw new Error('mcp_original_source_root_unavailable');
    const canonicalRoot = await canonicalizePathIdentity(root.canonicalRoot);
    if (normalizePathIdentity(canonicalRoot) !== normalizePathIdentity(root.canonicalRoot)) throw new Error('mcp_source_root_changed');
    const cwd = await canonicalizePathIdentity(options.cwd ?? canonicalRoot);
    const relative = path.relative(canonicalRoot, cwd).replaceAll('\\', '/');
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('mcp_source_cwd_outside_root');
    await input.readmit(selected); selected.throwIfAborted();
    const client = kernel.scoped(scope.grant);
    const processId = `mcp:${randomUUID()}`;
    const env: NodeJS.ProcessEnv = options.inheritEnv === false ? { ...options.env } : { ...process.env, ...options.env };
    // Do not cancel the response wait after native dispatch: a late accepted process must be retained.
    unobserved.add(processId);
    const initial = await client.processSpawn({ processId, workspaceId: scope.source.workspace_id, rootId: root.rootId,
      cwd: relative, command: options.command, args: [...(options.args ?? [])], mode: 'pipe', cols: 80, rows: 24,
      env: Object.entries(env).flatMap(([name, value]) => value === undefined || name === 'NODE_CHANNEL_FD' ? [] : [{ name, value }]),
    }).catch(error => {
      if (error instanceof KernelClientError && ['unauthorized', 'protocol-error'].includes(error.code)) unobserved.delete(processId);
      throw error;
    });
    if (initial.processId !== processId || initial.workspaceId !== scope.source.workspace_id || initial.kernelEpoch !== scope.resourceEpoch)
      throw new Error('mcp_native_process_identity_changed');
    const child = new KernelManagedProcess(client, { workspaceId: scope.source.workspace_id, processId, rootId: root.rootId }, initial,
      input.onError, () => { handles.delete(child); });
    handles.add(child); unobserved.delete(processId);
    try { await child.start(); }
    catch (error) { throw new ManagedProcessLaunchError(child, error); }
    if (selected.aborted) {
      try { await terminateManagedProcess(child, true); } catch (error) { throw new ManagedProcessLaunchError(child, error); }
      selected.throwIfAborted();
    }
    return child;
  };
  const spawn = (options: Readonly<StdioTransportOptions>, signal: AbortSignal) => {
    const work = launch(options, signal); launches.add(work);
    void work.finally(() => launches.delete(work)).catch(() => undefined); return work;
  };
  const stopOriginal = async (processId: string) => {
    type Receipt = { operationId: string; resourceEpoch: string; accepted: boolean; executorStopped: boolean;
      process: null | { processId: string; workspaceId: string; kernelEpoch: string; mode: string; writerActive: boolean; treeConfirmed?: boolean } };
    const address = { principalId: scope.principal.principalId, coordinatorHostId: scope.coordinatorHostId,
      authorityId: scope.authorityId, resourceEpoch: scope.resourceEpoch, operationId: processId };
    const observe = async (cancel: boolean) => {
      const receipt = await kernel.sourceRequest<Receipt>(cancel ? 'source.resource.cancel' : 'source.resource.observe', address);
      if (receipt.operationId !== processId || receipt.resourceEpoch !== scope.resourceEpoch
        || receipt.process && (receipt.process.processId !== processId || receipt.process.workspaceId !== scope.source.workspace_id
          || receipt.process.kernelEpoch !== scope.resourceEpoch || receipt.process.mode !== 'pipe')
        || receipt.executorStopped && (!receipt.accepted || !receipt.process || receipt.process.writerActive || receipt.process.treeConfirmed !== true))
        throw new Error('mcp_native_process_receipt_changed');
      return receipt;
    };
    // The original Source receipt is readable after grant revocation and Host/kernel reopening.
    // It never reacquires a process permit, starts another daemon or replays retained stdout.
    let receipt = await observe(true);
    if (!receipt.accepted) throw new Error('mcp_original_process_acceptance_unconfirmed');
    while (!receipt.executorStopped) {
      await new Promise<void>(resolve => setTimeout(resolve, 100)); receipt = await observe(false);
      if (!receipt.accepted) throw new Error('mcp_original_process_acceptance_unconfirmed');
    }
    unobserved.delete(processId);
  };

  return {
    adapt(transport: McpTransport): McpTransport {
      if (transport instanceof StreamableHttpTransport) { external = true; return transport; }
      if (!(transport instanceof StdioTransport)) throw new Error('mcp_source_transport_owner_unknown');
      controller.signal.throwIfAborted();
      const owner: ManagedProcessOwner<ManagedPipedProcessHandle> = { child: null };
      return createMcpProcessTransport(transport.options, spawn, owner);
    },
    async drain(): Promise<void> {
      controller.abort(); await Promise.allSettled([...launches]);
      const children = [...handles];
      const results = await Promise.allSettled([
        ...children.map(child => terminateManagedProcess(child, true).catch(() => stopOriginal(child.address.processId))),
        ...[...unobserved].map(stopOriginal),
      ]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      stopped = true;
      unsubscribe();
    },
    executorsStopped: () => stopped && !external,
  };
}
