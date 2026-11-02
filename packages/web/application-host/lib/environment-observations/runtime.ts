import { randomUUID } from 'node:crypto';
import type { DocumentMutationObservation } from '../documents/authority.js';
import { KERNEL_MAX_FRAME_BYTES, type ContextObservationSource, type EnvironmentObservationCapture, type ContextObservationHostDiagnostics, type ContextObservationProducerGap } from '../kernel/protocol.generated.js';
import { createEnvironmentObservationCoordinator, observationSourceKey,
  type CaptureStatus, type ObservationCoordinatorOptions } from './coordinator.js';

export interface TerminalCommandEvent {
  workspaceId: string;
  sessionId: string;
  command: string;
  commandId: string;
  cwd?: string;
  endedAt: number;
  exitCode: number;
  integration?: 'osc-633';
  source: 'harness' | 'user';
  startedAt?: number;
}
export interface GitStatusEvent {
  sampleId: string;
  observedAt: number;
  branchChanged: boolean;
  workspaceId: string;
  branch?: string;
  changed?: number;
  note?: string;
}
export type ProducerGap = ContextObservationProducerGap;
export type EnvironmentObservationPreparation = ContextObservationHostDiagnostics;
interface ProducerWork { workspaceId: string; capture: EnvironmentObservationCapture; bytes: number;
  gitFingerprint?: string }

/** Lightweight owned producers. No Knowledge writer, filesystem watcher, LSP or PTY mirror. */
export function createEnvironmentObservationRuntime(options: ObservationCoordinatorOptions & { incarnation?: string }) {
  const coordinator = createEnvironmentObservationCoordinator(options);
  const incarnation = options.incarnation ?? randomUUID();
  const pending: ProducerWork[] = [];
  const producerGaps = new Map<string, ProducerGap>();
  const gitFingerprints = new Map<string, string>();
  // An outstanding source query can retain at most a quarter wire frame and
  // 1024 producer records. This pre-binding budget closes the otherwise unbounded
  // queue before coordinator.enqueue can reserve its per-source bytes.
  const maxBytes = options.budgets?.sourceBytes ?? KERNEL_MAX_FRAME_BYTES / 4;
  const maxCount = options.budgets?.sourceCaptures ?? 1024;
  let bytes = 0; let inFlight: ProducerWork[] = [];
  let running: Promise<void> | undefined, scheduled = false, closed = false;
  const recordGap = (workspaceId: string, captureId: string, reason: ProducerGap['reason']): CaptureStatus => {
    const current = producerGaps.get(workspaceId);
    producerGaps.set(workspaceId, { workspaceId, count: (current?.count ?? 0) + 1,
      firstCaptureId: current?.firstCaptureId ?? captureId, lastCaptureId: captureId, reason });
    return { captureId, state: 'gap', reason };
  };
  const dispatch = async (): Promise<void> => {
    const original = pending.splice(0); inFlight = original;
    let owners: ContextObservationSource[];
    try { owners = await coordinator.sources(); }
    catch (error) {
      for (const item of original) recordGap(item.workspaceId, item.capture.captureId, 'source_unavailable');
      options.onError?.(error); return;
    } finally {
      // Original bodies remain owned by this call until the source query settles.
      bytes -= original.reduce((sum, item) => sum + item.bytes, 0);
    }
    const activeKeys = new Set(owners.map(observationSourceKey));
    for (const key of gitFingerprints.keys()) if (!activeKeys.has(key)) gitFingerprints.delete(key);
    for (const item of original) {
      for (const owner of owners) {
        if (owner.source.execution_workspace_id !== item.workspaceId) continue;
        const capture = item.capture;
        if (item.gitFingerprint !== undefined && capture.event.kind === 'source') {
          const key = observationSourceKey(owner);
          const previous = gitFingerprints.get(key);
          if (previous === item.gitFingerprint && !capture.event.body.notifyAssistant) continue;
        }
        try {
          const admitted = coordinator.enqueue(owner, capture);
          if (item.gitFingerprint !== undefined && admitted.state !== 'gap') gitFingerprints.set(observationSourceKey(owner), item.gitFingerprint);
        } catch (error) {
          // The coordinator records the conflicting identity as a coverage gap
          // and retains its first body. One bad producer cannot erase this burst.
          options.onError?.(error);
        }
      }
    }
  };
  const start = (): void => {
    if (running || !pending.length) return;
    const task = dispatch().finally(() => { running = undefined; inFlight = []; if (pending.length) schedule(); });
    running = task;
    void task.catch(error => options.onError?.(error));
  };
  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => { scheduled = false; start(); });
  };
  const submit = (item: Omit<ProducerWork, 'bytes'>): CaptureStatus => {
    if (closed) return recordGap(item.workspaceId, item.capture.captureId, 'closed');
    const size = Buffer.byteLength(JSON.stringify(item.capture));
    if (pending.length + inFlight.length >= maxCount || bytes + size > maxBytes) return recordGap(item.workspaceId, item.capture.captureId, 'queue_budget');
    pending.push({ ...item, capture: structuredClone(item.capture), bytes: size }); bytes += size; schedule();
    return { captureId: item.capture.captureId, state: 'pending' };
  };
  return {
    observeDocumentMutation: (event: DocumentMutationObservation): CaptureStatus | null => {
      const agent = event.owner.kind === 'harness' || event.owner.kind.startsWith('harness-')
        || event.owner.kind.startsWith('agent-') || event.owner.kind === 'agent-runtime';
      if (agent) return null; // Native tools already own their history and changes.
      return submit({ workspaceId: event.workspaceId, capture: { captureId: `document:${event.changeId}`, event: {
        kind: 'edit', at: event.observedAt, source: ['web-route', 'workspace-edit', 'resource-editor', 'recovery'].includes(event.owner.kind) ? 'user' : 'external',
        body: { path: event.resourceId, kind: event.kind, owner: { kind: event.owner.kind, id: event.owner.id, ...(event.owner.generation === undefined ? {} : { generation: event.owner.generation }) }, changeId: event.changeId, ...(event.operationId === undefined ? {} : { operationId: event.operationId }) },
      } } });
    },
    observeTerminalCommand: async (event: TerminalCommandEvent): Promise<CaptureStatus | null> => {
      if (event.source !== 'user') return null;
      const captureId = `terminal:${incarnation}:${event.sessionId}:${event.commandId}`;
      return submit({ workspaceId: event.workspaceId, capture: {
        captureId,
        event: { kind: 'command', at: event.endedAt, source: 'user', body: { terminalId: event.sessionId,
          commandId: event.commandId, changeId: captureId, command: event.command, exitCode: event.exitCode,
          ...(event.cwd === undefined ? {} : { cwd: event.cwd }), ...(event.integration === undefined ? {} : { integration: event.integration }),
          ...(event.startedAt === undefined ? {} : { startedAt: event.startedAt }), endedAt: event.endedAt } },
      } });
    },
    observeGitStatus: (event: GitStatusEvent): CaptureStatus => submit({ workspaceId: event.workspaceId,
      gitFingerprint: JSON.stringify([event.branch ?? null, event.changed ?? null, event.note ?? null]),
      capture: { captureId: event.sampleId, event: { kind: 'source', at: event.observedAt, source: 'external',
        body: { type: 'git', changeId: event.sampleId, notifyAssistant: event.branchChanged, ...(event.branch === undefined ? {} : { branch: event.branch }),
          ...(event.changed === undefined ? {} : { changed: event.changed }), ...(event.note === undefined ? {} : { note: event.note }) } } },
    }),
    prepare: async (run: { id: string }, signal?: AbortSignal): Promise<EnvironmentObservationPreparation> => {
      const preparation = await coordinator.prepare(run, signal);
      const workspaces = new Set(preparation.sources.map(source => source.owner.source.execution_workspace_id));
      return { ...preparation,
        producerPending: [...pending, ...inFlight].filter(item => workspaces.has(item.workspaceId)).length,
        producerGaps: [...producerGaps.values()].filter(gap => workspaces.has(gap.workspaceId)).map(gap => ({ ...gap })) };
    },
    inspect: coordinator.inspect,
    wake: coordinator.wake,
    dispose: async () => {
      closed = true;
      while (pending.length || running) { start(); if (running) await running; }
      return { sources: await coordinator.close(), retiredGaps: coordinator.retiredGaps(), producerGaps: [...producerGaps.values()].map(gap => ({ ...gap })) };
    },
  };
}
export type EnvironmentObservationRuntime = ReturnType<typeof createEnvironmentObservationRuntime>;
