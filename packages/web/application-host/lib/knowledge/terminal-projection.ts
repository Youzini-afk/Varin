import { KERNEL_MAX_FRAME_BYTES, type ContextObservationGap } from '../kernel/protocol.generated.js';
import type { CaptureStatus } from '../environment-observations/coordinator.js';
import type { TerminalCommandRecord } from '../terminal/session-api.js';
import type { TerminalCommandEvent } from '../environment-observations/runtime.js';

export type TerminalCommandProjectionResult = CaptureStatus | null;
export interface TerminalCommandProjectorDeps {
  inspectCwd?(terminalId: string): string | undefined;
  /** Queue one workspace capture; the observation coordinator owns source fanout. */
  observe(event: TerminalCommandEvent): CaptureStatus | null | Promise<CaptureStatus | null>;
  onError?(error: unknown): void;
  resolveWorkspaceId(scope: string): Promise<string | null>;
  budgets?: { bytes: number; commands: number };
}
export type TerminalCommandObservationRuntime = { observeTerminalCommand(event: TerminalCommandEvent): Promise<CaptureStatus | null> };
export const createTerminalCommandObserveAdapter = (runtime: TerminalCommandObservationRuntime): TerminalCommandProjectorDeps['observe'] =>
  event => runtime.observeTerminalCommand(event);

export function createTerminalCommandProjector(deps: TerminalCommandProjectorDeps) {
  // Root resolution precedes the runtime queue. Reserve here before the first
  // await so a blocked directory lookup cannot retain unbounded long commands.
  const budgets = deps.budgets ?? { bytes: KERNEL_MAX_FRAME_BYTES / 4, commands: 1024 };
  let bytes = 0, commands = 0, closed = false, failed = 0;
  let gapSummary: ContextObservationGap | null = null;
  const owned = new Set<Promise<TerminalCommandProjectionResult>>();
  const gap = (record: TerminalCommandRecord, reason: 'queue_budget' | 'closed'): CaptureStatus => {
    const captureId = `terminal:${record.terminalId}:${record.commandId}`;
    gapSummary = { count: (gapSummary?.count ?? 0) + 1, firstCaptureId: gapSummary?.firstCaptureId ?? captureId, lastCaptureId: captureId };
    deps.onError?.(Object.assign(new Error(reason === 'closed' ? 'Terminal observation intake is closed' : 'Terminal observation resolution queue budget exhausted'),
      { code: `observation_${reason}`, captureId }));
    return { captureId, state: 'gap', reason };
  };
  const projectOwned = async (record: TerminalCommandRecord): Promise<TerminalCommandProjectionResult> => {
    if (record.owner !== 'user') return null;
    const cwd = record.cwd ?? deps.inspectCwd?.(record.terminalId);
    if (!cwd) return null;
    const size = Buffer.byteLength(record.command) + Buffer.byteLength(cwd);
    if (commands >= budgets.commands || bytes + size > budgets.bytes) {
      return gap(record, 'queue_budget');
    }
    commands += 1; bytes += size;
    try {
      const workspaceId = await deps.resolveWorkspaceId(cwd);
      if (!workspaceId) return null;
      return await deps.observe({ workspaceId, sessionId: record.terminalId, command: record.command, commandId: record.commandId,
        exitCode: record.exitCode, source: 'user', integration: record.integration, endedAt: record.endedAt,
        ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }), cwd });
    } finally { commands -= 1; bytes -= size; }
  };
  const project = (record: TerminalCommandRecord): Promise<TerminalCommandProjectionResult> => {
    if (closed) return Promise.resolve(record.owner === 'user' ? gap(record, 'closed') : null);
    const task = projectOwned(record); owned.add(task);
    void task.then(() => {}, error => { failed += 1; deps.onError?.(error); }).finally(() => { owned.delete(task); });
    return task;
  };
  return { project,
    close: async (): Promise<{ gap: ContextObservationGap | null; failed: number }> => {
      closed = true;
      // Closing this intake freezes the wait set. Already owned root resolutions
      // still hand their captures to the live runtime before its own shutdown.
      await Promise.allSettled([...owned]);
      return { gap: gapSummary ? { ...gapSummary } : null, failed };
    },
  };
}
