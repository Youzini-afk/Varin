/** Presentation pacing only. These windows never imply work completion, user presence, or eligibility. */
export const LOCAL_INTERACTION_TIMING = {
  hoverDwell: 700, hoverCooldown: 10_000,
  tapBurstGap: 900, repeatTapMinimum: 300,
  returnAfterHidden: 30_000, returnOpportunity: 5_000,
} as const;

/** Small event gate: no action queue, timers, project facts, or animation ownership. Use monotonic time. */
export class LocalInteractionTiming {
  private lastTap = -Infinity;
  private tapStart = 0;
  private tapCount = 0;
  private repeatUsed = false;
  private hoverStart: number | null = null;
  private hoverUsed = false;
  private hoverAllowedAt = 0;
  private hiddenAt: number | null = null;
  private returnUntil = -Infinity;

  tap(now: number, allowRepeat = true): 'tap-first' | 'tap-repeat' | null {
    if (now - this.lastTap > LOCAL_INTERACTION_TIMING.tapBurstGap || now < this.lastTap) {
      this.tapStart = now; this.tapCount = 0; this.repeatUsed = false;
    }
    this.lastTap = now; this.tapCount++;
    if (this.tapCount === 1) return 'tap-first';
    if (allowRepeat && !this.repeatUsed && this.tapCount >= 3 && now - this.tapStart >= LOCAL_INTERACTION_TIMING.repeatTapMinimum) {
      this.repeatUsed = true; return 'tap-repeat';
    }
    return null;
  }

  /** Call on actual hit changes and at the dwell deadline; never fabricate a proximity hit. */
  observeHover(hit: boolean, now: number): boolean {
    if (!hit) { this.hoverLeave(); return false; }
    this.hoverEnter(now); return this.hoverReady(now);
  }
  reset(reason: 'drag' | 'hidden' | 'scope'): void {
    this.interrupt();
    if (reason === 'scope') this.hiddenAt = null;
  }
  hoverEnter(now: number): void {
    if (this.hoverStart !== null) return;
    this.hoverStart = now; this.hoverUsed = false;
  }
  hoverLeave(): void { this.hoverStart = null; this.hoverUsed = false; }
  /** One owner timer may schedule this delay; recheck the actual alpha hit at its deadline. */
  hoverDelay(now: number): number | null {
    if (this.hoverStart === null || this.hoverUsed) return null;
    return Math.max(0, this.hoverStart + LOCAL_INTERACTION_TIMING.hoverDwell - now, this.hoverAllowedAt - now);
  }
  hoverReady(now: number): boolean {
    if (this.hoverStart === null || this.hoverUsed || now < this.hoverStart
      || now - this.hoverStart < LOCAL_INTERACTION_TIMING.hoverDwell || now < this.hoverAllowedAt) return false;
    this.hoverUsed = true; this.hoverAllowedAt = now + LOCAL_INTERACTION_TIMING.hoverCooldown;
    return true;
  }

  visibility(visible: boolean, now: number): void {
    if (!visible) {
      if (this.hiddenAt === null) this.hiddenAt = now;
      this.interrupt(); return;
    }
    if (this.hiddenAt !== null) {
      this.returnUntil = now - this.hiddenAt >= LOCAL_INTERACTION_TIMING.returnAfterHidden
        ? now + LOCAL_INTERACTION_TIMING.returnOpportunity : -Infinity;
      this.hiddenAt = null;
    }
  }
  /** Consume on actual local activity, even if caller cannot currently show a greeting. No delayed replay. */
  returnOnActivity(now: number): boolean {
    const eligible = this.hiddenAt === null && now <= this.returnUntil;
    this.returnUntil = -Infinity;
    return eligible;
  }
  /** Native lift, lost focus, menus or context changes discard transient intent, never defer it. */
  interrupt(): void {
    this.lastTap = -Infinity; this.tapCount = 0; this.repeatUsed = false;
    this.hoverLeave(); this.returnUntil = -Infinity;
  }
}
