import { randomUUID } from 'node:crypto';
import type { GitStatusEvent } from "../environment-observations/runtime.js";
import { KERNEL_MAX_FRAME_BYTES } from '../kernel/protocol.generated.js';
import { projectGitStatusObservation } from "./git-status.js";

export interface GitStatusObserverOptions {
  resolveWorkspaceId(scope: string): Promise<string | null>;
  observe(event: GitStatusEvent): void;
  onError?(error: unknown): void;
}

/** Own the status sample before asynchronous Documents root resolution. */
export function createGitStatusObserver(options: GitStatusObserverOptions) {
  const work = new Set<Promise<void>>();
  const branches = new Map<string, string | null>();
  let bytes = 0, closed = false;
  let gaps: { count: number; firstSampleId: string; lastSampleId: string } | null = null;
  const discard = (sampleId: string, reason: string): void => {
    if (!gaps) options.onError?.(new Error(`Git status observation not captured: ${reason}`));
    gaps = { count: (gaps?.count ?? 0) + 1, firstSampleId: gaps?.firstSampleId ?? sampleId, lastSampleId: sampleId };
  };
  const observe = (scope: string, status: unknown): void => {
    const observation = projectGitStatusObservation(status);
    if (!observation) return;
    const branch = observation.branch ?? null;
    const branchChanged = branches.has(scope) && branches.get(scope) !== branch;
    branches.set(scope, branch);
    const sample = { sampleId: randomUUID(), observedAt: Date.now(), branchChanged, ...observation };
    const size = Buffer.byteLength(scope) + Buffer.byteLength(JSON.stringify(sample));
    // Match the environment producer's metadata/count allocation before awaiting
    // a root lookup; a slow Documents owner must not retain unlimited callbacks.
    if (closed || work.size >= 1024 || bytes + size > KERNEL_MAX_FRAME_BYTES / 4) {
      discard(sample.sampleId, closed ? 'producer closed' : 'pending sample budget exceeded'); return;
    }
    bytes += size;
    const task = Promise.resolve().then(() => options.resolveWorkspaceId(scope)).then(workspaceId => {
      if (workspaceId) options.observe({ workspaceId, ...sample });
    }).catch(error => {
      discard(sample.sampleId, 'workspace resolution failed'); options.onError?.(error);
    }).finally(() => { bytes -= size; work.delete(task); });
    work.add(task);
  };
  return Object.assign(observe, {
    close: async () => { closed = true; await Promise.all(work); return { gaps }; },
  });
}
