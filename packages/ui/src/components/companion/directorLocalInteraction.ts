import type { CompanionEndpoints, CompanionFrame, CompanionPackage } from './sequencePackage';
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
  responseAvailable?: (action: string) => boolean;
}): 'tap-response' | 'hover-response' | 'director-open-attention' | 'open-hover-response' | 'tap-repeat-response' | null {
  if (!input.current || !input.visible || input.interacting || input.blockedUI || input.finiteHandover) return null;
  if (input.responsePlaying) return null; // Never restart the current response on every input.
  const response = input.event === 'tap-repeat' ? input.idle && input.playfulAvailable && (input.closed ? input.closedPlayfulAvailable : input.safeOpenEndpoint) ? 'tap-repeat-response' : null
    : input.event === 'hover' && !input.closed && input.safeOpenEndpoint && input.openHoverAvailable ? 'open-hover-response'
    : input.event === 'tap' ? input.closed ? 'tap-response' : 'director-open-attention'
    : input.closed ? 'hover-response' : 'director-open-attention';
  if (!response || !input.responseAvailable || input.responseAvailable(response)) return response;
  // Missing closed-specific art may honestly open for attention, but only via
  // the existing authored route gate. Never invent a repeat or direct pose jump.
  return input.closed && input.event !== 'tap-repeat' && input.responseAvailable('director-open-attention') ? 'director-open-attention' : null;
}

/** Explicit current pixels decide closed posture, including asleep/recovery art.
 * Legacy interpretation is confined to its original geometry, never a v5 alias. */
export function companionClosedDrawing(asset: CompanionPackage | undefined, frame: CompanionFrame | undefined, endpoints: CompanionEndpoints | null): boolean {
  if (!asset || !frame) return false;
  if (endpoints) return asset.geometryReference === endpoints.geometryReference && !!frame.sha256 && endpoints.closedSourceSha256.includes(frame.sha256);
  return asset.geometryReference === 'varin-upright-v2' && (asset.entryPose === 'upright-v2:closed' && asset.exitPose === 'upright-v2:closed' || ['rest-sleep', 'relax-idle'].includes(asset.action ?? ''));
}
export function companionClosedSequence(asset: CompanionPackage, endpoints: CompanionEndpoints | null): boolean {
  return endpoints ? asset.frames.length > 0 && asset.frames.every(frame => companionClosedDrawing(asset, frame, endpoints))
    : asset.geometryReference === 'varin-upright-v2' && asset.entryPose === 'upright-v2:closed' && asset.exitPose === 'upright-v2:closed';
}
export function companionSafeOpenDrawing(asset: CompanionPackage | undefined, frame: CompanionFrame | undefined, endpoints: CompanionEndpoints | null): boolean {
  if (!asset || !frame?.exitTo?.length || companionClosedDrawing(asset, frame, endpoints)) return false;
  if (endpoints) return asset.geometryReference === endpoints.geometryReference && (frame.pauseSafe === true || frame.pose === endpoints.open.pose && frame.sha256 === endpoints.open.sourceSha256);
  return asset.geometryReference === 'varin-upright-v2' && (frame.pauseSafe === true || frame.pose === 'upright-v2:open-user') && asset.entryPose !== 'upright-v2:closed';
}
