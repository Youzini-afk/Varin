import type { CompanionAttentionView } from './attentionCoordinator';
import type { CompanionIntent } from './presentation';

// A visual settling budget, never an execution timeout or a business-state delay.
export const ORDINARY_VISUAL_SETTLE_MS = 240;
const ordinary = (state: string | null) => state === null || state === 'C04' || state === 'C05' || /^T0[1-8]$/.test(state ?? '');
const neutral: CompanionIntent = { state: null, reason: 'Observing changing activity in the focused task' };

/** Latest-only performance selection. The caller must keep raw facts and alerts immediate. */
export class CompanionVisualStabilizer {
  private scope: string | null = null;
  private latest: CompanionIntent | null = null;
  private displayed: CompanionIntent | null = null;
  private candidateAt = 0;
  private settling = false;

  observe(scope: string, intent: CompanionIntent, now: number): CompanionIntent {
    if (scope !== this.scope || !this.latest) {
      this.scope = scope;
      this.latest = this.displayed = intent;
      this.settling = false;
      return intent;
    }
    const changed = intent.state !== this.latest.state;
    const wasOrdinary = ordinary(this.latest.state);
    this.latest = intent;
    if (!ordinary(intent.state) || !wasOrdinary) {
      // Permissions, questions, error/unknown, cancellation, completion and idle never wait.
      this.settling = false;
      return this.displayed = intent;
    }
    if (changed) {
      this.candidateAt = now;
      this.settling = intent.state !== null;
      // Never retain an active reading/writing icon after its supporting fact ended.
      this.displayed = neutral;
    }
    if (this.settling && now - this.candidateAt >= ORDINARY_VISUAL_SETTLE_MS) {
      this.settling = false;
      this.displayed = intent;
    }
    if (!this.settling && this.displayed?.state === intent.state) this.displayed = intent;
    return this.displayed ?? intent;
  }

  remaining(now: number): number | null {
    return this.settling ? Math.max(0, ORDINARY_VISUAL_SETTLE_MS - (now - this.candidateAt)) : null;
  }
}

/** Quiet only for a known-current empty Host; missing/stale facts are not empty. */
export function showCompanionAttentionSummary(attention: CompanionAttentionView, focused: boolean): boolean {
  const snapshot = attention.snapshot;
  return focused || attention.health !== 'current' || !snapshot
    || snapshot.coverage.native !== 'complete' || snapshot.branches.length > 0 || snapshot.items.length > 0
    || snapshot.teamExecutions.length > 0 || snapshot.counts.actionRequired !== 0
    || snapshot.counts.affectedBranches !== 0 || snapshot.counts.unknownEffects !== 0;
}
