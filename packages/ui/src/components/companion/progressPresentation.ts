import type { StreamingTextPart } from '@/lib/agent-runtime/thread-projection';
import type { CompanionIntent, ObservationHealth } from './presentation';

export interface CompanionProgress {
  runId: string;
  requestId?: string;
  kind: 'output' | 'thinking' | 'retry';
  /** A visual activity lease, or the actual provider retry time; never a completion clock. */
  until: number;
  attempt?: number;
  /** Only actual provider text events get a serial; cached cumulative snapshots do not. */
  textEvent?: number;
}

/** Keeps only lengths/type/identity, never model text or reasoning. */
export class CompanionProgressFacts {
  private runId: string | undefined;
  private requestId: string | undefined;
  private lengths = new Map<string, number>();
  private retryKey: string | undefined;
  private active: CompanionProgress | null = null;
  private serial = 0;
  reset(): null { this.runId = undefined; this.requestId = undefined; this.lengths.clear(); this.retryKey = undefined; this.active = null; return null; }
  observe(parts: StreamingTextPart[], context: { runId: string; requestId?: string; activity?: 'text' | 'thinking' | 'retry' | 'provider' } | undefined, now: number): CompanionProgress | null {
    if (!context || !parts.length) return this.reset();
    const initial = this.runId !== context.runId || this.requestId !== context.requestId;
    if (initial) { this.reset(); this.runId = context.runId; this.requestId = context.requestId; }
    const nextLengths = new Map<string, number>();
    let activity: 'output' | 'thinking' | undefined;
    let retry: Extract<StreamingTextPart, { type: 'retry' }> | undefined;
    for (const [index, part] of parts.entries()) {
      if (part.type === 'retry') { retry = part; continue; }
      const key = `${part.type}:${part.id ?? index}`;
      const length = part.type === 'text' ? part.text.length : part.thinking.length;
      const old = this.lengths.get(key) ?? 0;
      // First observation establishes a baseline, including after reconnect.
      if ((!initial || context.activity === 'text' || context.activity === 'thinking') && length > old && (part.type === 'text' || activity !== 'output')) activity = part.type === 'text' ? 'output' : 'thinking';
      nextLengths.set(key, length);
    }
    this.lengths = nextLengths;
    // The projection can identify a newly admitted delta even when this is the
    // first callback; a cached refresh carries no activity marker.
    if (context.activity === 'text') activity = 'output';
    else if (context.activity === 'thinking') activity = 'thinking';
    else if (context.activity === 'retry' || context.activity === 'provider') activity = undefined;
    if (context.activity === 'provider' && this.active?.kind === 'retry') this.active = null;
    const key = retry ? `${retry.attempt}:${retry.retryAt}` : undefined;
    const freshRetry = key !== undefined && key !== this.retryKey;
    this.retryKey = key;
    if (activity) this.active = { runId: context.runId, ...(context.requestId ? { requestId: context.requestId } : {}), kind: activity, until: now + 1400, ...(context.activity === 'text' ? { textEvent: ++this.serial } : {}) };
    // Validate the provider's timestamp; do not invent an arbitrary timeout ceiling.
    else if ((context.activity === 'retry' || freshRetry && context.activity !== 'provider') && retry && Number.isSafeInteger(retry.retryAt) && Number.isFinite(new Date(retry.retryAt).getTime()) && retry.retryAt > now && Number.isSafeInteger(retry.attempt) && retry.attempt >= 0) {
      this.active = { runId: context.runId, ...(context.requestId ? { requestId: context.requestId } : {}), kind: 'retry', until: retry.retryAt, attempt: retry.attempt };
    }
    if (this.active && this.active.until <= now) this.active = null;
    return this.active;
  }
}

/** More specific live provider facts cannot override tools, questions, cancellation or health. */
export function withCompanionProgress(intent: CompanionIntent, progress: CompanionProgress | null, health: ObservationHealth, run: { id: string; state: string } | null | undefined, now: number): CompanionIntent {
  if (!progress || health !== 'current' || run?.id !== progress.runId || progress.until <= now) return intent;
  if (!['C04', 'W04'].includes(intent.state ?? '') || !['generating', 'waiting'].includes(run.state)) return intent;
  if (progress.kind === 'retry') return { state: 'W05', reason: 'The current provider request has an observed retry delay' };
  if (run.state !== 'generating') return intent;
  return { state: progress.kind === 'output' ? 'C05' : 'C04', reason: progress.kind === 'output' ? 'New text activity in the current provider request' : 'New reasoning activity in the current provider request' };
}
