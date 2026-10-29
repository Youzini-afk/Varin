import type { DesktopCompanionScene } from '@varin/application-client';
/** Author vocabulary adapter. Unknown or merely preparatory drawings never invent activity. */
export function sceneCue(value?: string): DesktopCompanionScene['cue'] {
  if (!value) return 'transition';
  const v=value.toUpperCase();
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
  const action = { reading: 'reading', editing: 'editing', searching: 'browsing', dispatch: 'dispatch', question: 'query', permission: 'permission' };
  return drawnAction === action[kind];
}
