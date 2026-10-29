import type { DirectorPresentation } from './directorPresentation';

/** Candidate management vocabulary. Project tool categories are intentionally
 * absent: they belong to the project/leader slot, not Varin's body controller. */
export function directorBodyAction(view: DirectorPresentation, side: 'left' | 'right' | null): string {
  if (view.health !== 'current') return 'director-supervise';
  if (view.interactionRoute !== 'bot-coordinator' && view.interactionRoute !== 'coordination-review') {
    if (view.body.verb === 'available') return 'idle-closed';
    // A direct Agent conversation is not delegated through Varin. Inspection
    // never produces a report/listen performance, and new runs do not hand off.
    if (view.body.verb === 'notify-attention' || view.body.verb === 'notify-result') return 'director-open-attention';
    return 'director-supervise';
  }
  if (view.body.verb === 'receive-work') return 'director-intake';
  if (view.body.verb === 'available') return 'idle-closed';
  if (view.body.verb === 'receive-result' || view.body.verb === 'present-attention') return 'director-gather-present';
  if (side && view.inspectedProjectKey !== null) return `director-listen-${side}`;
  // Unknown/reflowing dock direction cannot borrow the opposite-side gaze.
  return 'director-supervise';
}
