import type { ThreadAttentionSnapshot } from '@varin/application-client';

/** Same predicate for live Host and explicit fixture facts; never borrow the other source's idle state. */
export function companionLocalIdle(snapshot: ThreadAttentionSnapshot | null | undefined, health: string): boolean {
  return health === 'current' && snapshot?.coverage.native === 'complete'
    && snapshot.counts.actionRequired === 0 && snapshot.counts.unknownEffects === 0
    && !snapshot.items.some(item => item.kind === 'cancelling' || item.kind === 'preparation_failed')
    && snapshot.branches.every(branch => !branch.hasUnsettledWork
      && (branch.currentRun ? ['completed','failed','cancelled'].includes(branch.currentRun.state) : !branch.activeRunId));
}

/** Local attention is presentation only: it never acknowledges a project request
 * or consumes a management edge. Finite handovers retain their authored contact. */
export function directorLocalResponse(input: {
  event: 'tap' | 'tap-repeat' | 'hover'; current: boolean; visible: boolean; interacting: boolean;
  blockedUI: boolean; finiteHandover: boolean; closed: boolean;
  /** Optional accepted-art capabilities; absence preserves existing safe responses. */
  idle?: boolean; responsePlaying?: boolean; safeOpenEndpoint?: boolean;
  playfulAvailable?: boolean; closedPlayfulAvailable?: boolean; openHoverAvailable?: boolean;
}): 'tap-response' | 'hover-response' | 'director-open-attention' | 'open-hover-response' | 'tap-repeat-response' | null {
  if (!input.current || !input.visible || input.interacting || input.blockedUI || input.finiteHandover) return null;
  if (input.responsePlaying) return null; // Never restart the current response on every input.
  if (input.event === 'tap-repeat') return input.idle && input.playfulAvailable && (input.closed ? input.closedPlayfulAvailable : input.safeOpenEndpoint) ? 'tap-repeat-response' : null;
  if (input.event === 'hover' && !input.closed && input.safeOpenEndpoint && input.openHoverAvailable) return 'open-hover-response';
  if (input.event === 'tap') return input.closed ? 'tap-response' : 'director-open-attention';
  return input.closed ? 'hover-response' : 'director-open-attention';
}
