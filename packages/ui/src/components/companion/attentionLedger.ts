import type { ThreadAttentionItem, ThreadAttentionSnapshot } from '@varin/application-client';

const categoryRank = (item: ThreadAttentionItem) => item.kind === 'effect_unknown' ? 0 : item.actionable ? 1 : 2;
/** Stable order and local 'viewed', never removal or authority to resolve a request. */
export class CompanionAttentionLedger {
  private epoch: number | null = null;
  private next = 0;
  private order = new Map<string, number>();
  private viewed = new Set<string>();
  reconcile(snapshot: ThreadAttentionSnapshot): ThreadAttentionItem[] {
    if (snapshot.epoch !== this.epoch) { this.epoch = snapshot.epoch; this.order.clear(); this.viewed.clear(); this.next = 0; }
    const current = new Map(snapshot.items.map(item => [item.key, item]));
    for (const key of this.order.keys()) if (!current.has(key)) { this.order.delete(key); this.viewed.delete(key); }
    for (const key of current.keys()) if (!this.order.has(key)) this.order.set(key, this.next++);
    return [...current.values()].sort((a, b) => categoryRank(a) - categoryRank(b)
      || this.order.get(a.key)! - this.order.get(b.key)! || a.key.localeCompare(b.key));
  }
  markViewed(key: string) { if (this.order.has(key)) this.viewed.add(key); }
  isViewed(key: string) { return this.viewed.has(key); }
}
