import type { DesktopCompanionScene } from '@varin/application-client';
/** Author vocabulary adapter. Unknown or merely preparatory drawings never invent activity. */
export function sceneCue(value?: string, drawnAction?: string): DesktopCompanionScene['cue'] {
  if (!value) return 'transition';
  const v=value.toUpperCase();
  if (drawnAction?.startsWith('director-')) {
    if (['ATTEND_LEAD','LISTEN'].includes(v)) return drawnAction.endsWith('-left') ? 'listen-left' : drawnAction.endsWith('-right') ? 'listen-right' : 'transition';
    if (v === 'RECEIVE_PROJECT') return 'management-receive';
    if (v === 'HANDOFF_LEAD') return 'management-delegate';
    if (v === 'GATHER_OUT') return 'gather-out';
    if (v === 'GATHER_IN') return 'gather-in';
    if (v === 'ADDRESS_USER') return 'address-user';
    if (v === 'PRESENT') return 'management-present';
    if (v === 'RELEASE') return 'management-release';
    return 'transition';
  }
  if (v === 'ORGANIZE_ALIGN') return 'organize-align';
  if (v === 'ORGANIZE_SELECT') return 'organize-select';
  if (v === 'VERIFY_SCAN') return 'verify-scan';
  if (v === 'VERIFY_COMPARE') return 'verify-compare';
  if (v === 'EXPLAIN') return 'type';
  if (v === 'PAGE_TURN') return 'page-turn';
  if (v === 'READ_SETTLE') return 'read';
  if (v.startsWith('REVISE') && !v.includes('PREPARE')) return 'revise';
  if (['TYPE_BURST','TYPE_ALTERNATE'].includes(v)) return 'type';
  if (v === 'REVIEW') return 'review';
  if (v === 'FAN_OUT' || v === 'PAGE_PRESENT') return 'present';
  if (v.startsWith('SCAN_SIDE_A')) return 'scan-left';
  if (v.startsWith('SCAN_SIDE_B') || v === 'GAZE_A') return 'scan-right';
  if (v === 'SELECT') return 'select';
  if (v === 'SPLIT') return 'split';
  // Dispatch A points toward viewer-right; its letter is not a direction.
  if (v === 'DISPATCH_A') return 'dispatch-right';
  if (v === 'DISPATCH_B') return 'dispatch-left';
  if (v.includes('GAZE_B')) return 'scan-left';
  if (v.startsWith('WATCH')) return 'watch';
  if (v === 'ASK') return 'ask';
  if (v === 'OFFER') return 'offer';
  if (['ATTEND','UNRESOLVED'].includes(v)) return 'attend';
  if (['ANSWER_RECEIVED','ALLOW_RECEIVED'].includes(v)) return 'acknowledge';
  return 'transition';
}

export function cueMatchesScene(kind: DesktopCompanionScene['kind'], drawnAction: string | undefined): boolean {
  if (!kind) return false;
  if (kind === 'portfolio') return !!drawnAction?.startsWith('director-');
  if (kind === 'status') return false; // Status admission is factual, not a performed operation.
  if (kind === 'editing' && drawnAction === 'output') return true;
  const action = { reading: 'reading', editing: 'editing', searching: 'browsing', dispatch: 'dispatch', question: 'query', permission: 'permission', organize: 'organizing', verify: 'checking' };
  return drawnAction === action[kind];
}

/** A logical target cannot lend another subject's last successful drawing its cue. */
export function directorCueMatchesPresentation(drawn: { action?: string; cue: DesktopCompanionScene['cue']; context?: string | null } | undefined, context: string | null | undefined, side: 'left' | 'right' | null): boolean {
  return !!drawn && drawn.context === context && !!drawn.action?.startsWith('director-')
    && (!drawn.cue.startsWith('listen-') || drawn.cue === `listen-${side}`)
    && ['listen-left','listen-right','gather-out','gather-in','address-user','management-present','management-release','management-receive','management-delegate'].includes(drawn.cue);
}
