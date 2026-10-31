/**
 * How strongly she reacts to a result (docs/design/bot-ui.md §5.7.3). A base level comes from how
 * close the result is to you and how much it weighs; urgency, your typing, repetition and a small
 * energy budget only ever lower it. Members' own progress never reaches her body.
 *
 * 0 only at the member · 1 a glance · 2 a nod (concern when failed) · 3 presenting a card
 * (a serious face when failed) · 4 a restrained cheer.
 */
export type BotReactionKind = 'sub-dispatch' | 'sub-report' | 'lead-report' | 'leave' | 'gather' | 'resolved' | 'reply' | 'complete';
export type BotReactionLevel = 0 | 1 | 2 | 3 | 4;
export type BotReactionReason = 'large-success' | 'urgent' | 'typing' | 'merged' | 'energy' | 'floor' | 'glance-cooldown';
export interface BotReaction { level: BotReactionLevel; base: BotReactionLevel; reasons: BotReactionReason[] }
export interface BotReactionInput { kind: BotReactionKind; outcome: 'ok' | 'fail'; weight?: 'small' | 'large' }
export interface BotReactionContext {
  /** Seconds on a monotonic clock. */
  now: number;
  /** Something needs you or failed. */
  urgent: boolean;
  /** You are typing to her. */
  typing: boolean;
}

const BASE: Record<BotReactionKind, BotReactionLevel> = {
  'sub-dispatch': 0, 'sub-report': 0, 'lead-report': 1, leave: 1, gather: 2, resolved: 2, reply: 3, complete: 3,
};
/** What a level spends from the budget. */
const COST: Record<BotReactionLevel, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 3 };
/** What was said to you keeps at least a nod when only the budget runs short. */
const FLOOR: Partial<Record<BotReactionKind, BotReactionLevel>> = { reply: 2, complete: 2 };
export const REACTION_ENERGY = 4;
/** One unit comes back every 15 seconds. */
const RECOVERY_S = 15;
/** The same kind of result again within this gap joins the previous reaction. */
const MERGE_S = 1.2;
const GLANCE_COOLDOWN_S = 1.5;

export class BotReactionGrader {
  private energy = REACTION_ENERGY;
  private at: number | null = null;
  private lastGlance = -Infinity;
  private recent: { kind: BotReactionKind; at: number; level: BotReactionLevel }[] = [];

  get budget(): number { return this.energy; }

  grade(input: BotReactionInput, context: BotReactionContext): BotReaction {
    const now = context.now;
    if (this.at !== null) this.energy = Math.min(REACTION_ENERGY, this.energy + Math.max(0, now - this.at) / RECOVERY_S);
    this.at = now;
    const base = BASE[input.kind], reasons: BotReactionReason[] = [];
    let level: BotReactionLevel = base;
    if (input.kind === 'complete' && input.weight === 'large' && input.outcome === 'ok') { level = 4; reasons.push('large-success'); }
    if (context.urgent && input.kind !== 'resolved' && level > 0) { level = 0; reasons.push('urgent'); }
    if (context.typing && level > 1) { level = 1; reasons.push('typing'); }
    const previous = this.recent.find(entry => entry.kind === input.kind && now - entry.at < MERGE_S);
    if (previous && level <= previous.level) {
      previous.at = now;
      return { level: 0, base, reasons: [...reasons, 'merged'] };
    }
    const floor = FLOOR[input.kind] ?? 0;
    while (level >= 2 && level > floor && COST[level] > this.energy) { level = (level - 1) as BotReactionLevel; if (!reasons.includes('energy')) reasons.push('energy'); }
    if (level === floor && floor >= 2 && COST[level] > this.energy) reasons.push('floor');
    if (level === 1 && now - this.lastGlance < GLANCE_COOLDOWN_S) { level = 0; reasons.push('glance-cooldown'); }
    this.energy = Math.max(0, this.energy - COST[level]);
    if (level === 1) this.lastGlance = now;
    this.recent = [...this.recent.filter(entry => now - entry.at < 3), { kind: input.kind, at: now, level }];
    return { level, base, reasons };
  }
}
