import { countUiWork } from '../performance-observation';
import type { StreamingTextPart, StreamingToolCall, ToolExecutionProgress } from './thread-projection';
import { shareSnapshot } from './structural-sharing';

export interface ThreadStreamingSnapshot {
  progress: StreamingTextPart[];
  streamingTools: StreamingToolCall[];
  toolProgress: ToolExecutionProgress[];
  progressActivity: { runId: string; requestId?: string; activity?: 'text' | 'thinking' | 'retry' | 'provider' } | null;
}
const empty = (): ThreadStreamingSnapshot => ({ progress: [], streamingTools: [], toolProgress: [], progressActivity: null });

/** Disposable per-thread presentation. Ingestion is lossless; only React publications are coalesced. */
export class ThreadStreamingStore {
  private snapshot = empty();
  private pending = this.snapshot;
  private readonly listeners = new Set<() => void>();
  private cancelFrame?: () => void;
  getSnapshot = () => this.snapshot;
  getHasProgress = () => Boolean(this.snapshot.progress.length || this.snapshot.streamingTools.length);
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(patch: Partial<ThreadStreamingSnapshot>) {
    this.pending = { ...this.pending, ...patch };
    if (this.cancelFrame) return;
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(this.flush);
      this.cancelFrame = () => cancelAnimationFrame(frame);
    } else {
      const frame = setTimeout(this.flush, 16);
      this.cancelFrame = () => clearTimeout(frame);
    }
  }
  private flush = () => {
    this.cancelFrame = undefined;
    const next = shareSnapshot(this.snapshot, this.pending);
    this.pending = next;
    if (next === this.snapshot) return;
    this.snapshot = next;
    if (import.meta.env.DEV) countUiWork('stream.publish');
    for (const listener of this.listeners) listener();
  };
  publishProgress = (progress: StreamingTextPart[], progressActivity?: NonNullable<ThreadStreamingSnapshot['progressActivity']>) => {
    this.patch({ progress, progressActivity: progressActivity ?? null });
  };
  publishTools = (streamingTools: StreamingToolCall[]) => this.patch({ streamingTools });
  publishToolProgress = (toolProgress: ToolExecutionProgress[]) => this.patch({ toolProgress });
  reset() { this.cancelFrame?.(); this.cancelFrame = undefined; this.pending = empty(); this.flush(); }
}
