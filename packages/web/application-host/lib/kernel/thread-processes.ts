import { createHash } from 'node:crypto';
import type { ThreadProcessesAPI, ThreadProcessTerminal, ThreadSource } from '@varin/application-client';
import type { TerminalSessionApi } from '../terminal/session-api.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { KernelClient } from './kernel-client.js';
import type { LiveSourceResolver } from './live-source.js';
import { admitRunSourceAuthority, savedSourceLaunch, sourceToolSchemas } from './source-launch.js';
import { KernelManagedProcess, projectProcessTerminal } from './process-service.js';

/** A view of the original admitted job. The Catalog and process owner retain all execution facts. */
export function createThreadProcesses(options: {
  runtime: AgentRuntimeClient;
  kernel: KernelClient;
  terminal(): TerminalSessionApi | null;
  resolveLiveSource: LiveSourceResolver;
  onError(error: unknown): void;
}): ThreadProcessesAPI {
  const preparing = new Map<string, Promise<ThreadProcessTerminal>>();
  const open: ThreadProcessesAPI['openTerminal'] = async input => {
    const { runtime, kernel } = options;
    const operation = await runtime.operation(input.operationId);
    const run = await runtime.run(operation.run_id);
    if (input.runtime !== 'agent' || run.thread_id !== input.threadId || run.branch_id !== input.branchId
      || operation.executor !== 'process_spawn') throw new Error('Terminal must belong to this branch and original process operation');
    const launch = await runtime.launch(run.id);
    const source = launch?.selection.source;
    if (!source || source.mode === 'fixed_branch') throw new Error('Process has no physical source');
    const terminal = options.terminal();
    if (!terminal?.adoptTerminalSession) throw new Error('Terminal runtime is unavailable');
    const sessionId = `agent-process:${createHash('sha256').update(JSON.stringify([run.thread_id, run.branch_id, operation.id])).digest('hex')}`;
    const existing = terminal.inspectSession(sessionId);
    if (existing && existing.status !== 'error') {
      const identity = existing.processIdentity;
      if (existing.owner !== 'agent' || identity?.operationId !== operation.id || identity.runId !== run.id
        || identity.threadId !== run.thread_id || identity.branchId !== run.branch_id) throw new Error('Terminal identity conflict');
      return { sessionId, cwd: existing.cwd, operationId: operation.id, processId: identity.processId };
    }
    const selection = savedSourceLaunch(run.id, source, sourceToolSchemas(launch!.selection).map(tool => tool.name) as ThreadSource['tools']);
    const authority = await admitRunSourceAuthority(kernel, runtime, selection, { resolveLiveSource: options.resolveLiveSource });
    let child: KernelManagedProcess | undefined;
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    const release = () => {
      if (disposed) return;
      disposed = true; unsubscribe?.();
      void authority.release().catch(options.onError);
    };
    try {
      const access = await runtime.processAccess({ threadId: input.threadId, branchId: input.branchId,
        operationId: operation.id, toolBinding: authority.toolBinding });
      if (access.operationId !== operation.id || access.runId !== run.id || access.threadId !== input.threadId
        || access.branchId !== input.branchId || access.workspaceId !== source.workspace_id || access.rootId !== authority.rootId
        || access.process.processId !== operation.id || access.process.mode !== 'pty' || !authority.canonicalRoot) throw new Error('Original PTY process access is unavailable');
      child = new KernelManagedProcess(authority.client, { workspaceId: access.workspaceId, rootId: access.rootId, processId: access.process.processId },
        access.process, options.onError, release, { retainOutput: true,
          terminate: async () => { await runtime.cancelOperation(operation.id); } });
      const projection = child;
      unsubscribe = kernel.subscribeExit(error => projection.invalidate(error));
      const process = projectProcessTerminal(child);
      await child.start();
      await terminal.adoptTerminalSession({ sessionId, cwd: access.process.cwd, process,
        identity: { threadId: input.threadId, branchId: input.branchId, runId: run.id,
          operationId: operation.id, processId: access.process.processId, kernelEpoch: access.process.kernelEpoch } });
      return { sessionId, cwd: access.process.cwd, operationId: operation.id, processId: access.process.processId };
    } catch (error) {
      if (child) await child.detach().catch(options.onError);
      else release();
      throw error;
    }
  };
  return { openTerminal(input) {
    const key = JSON.stringify([input.threadId, input.branchId, input.operationId]);
    const existing = preparing.get(key);
    if (existing) return existing;
    const pending = open(input).finally(() => { if (preparing.get(key) === pending) preparing.delete(key); });
    preparing.set(key, pending);
    return pending;
  } };
}
