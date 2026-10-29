import type { DirectorPresentation } from './directorPresentation';

/** Product mode alone is not authority to coordinate every project in the Host. */
export function directorBodyAction(view: DirectorPresentation, side: 'left' | 'right' | null): string {
  if (view.health !== 'current') return 'director-supervise';
  if (view.body.verb === 'available') return 'idle-closed';
  const coordinates = (route: DirectorPresentation['interactionRoute']) => route === 'bot-coordinator' || route === 'coordination-review';
  const productCoordinates = coordinates(view.interactionRoute);
  const subject = view.body.subject;
  const hasExternalSubject = !!subject && view.cards.some(card => card.identity.threadId === subject.threadId && card.identity.branchId === subject.branchId);
  const subjectCoordinates = productCoordinates && coordinates(view.body.subjectRoute) && hasExternalSubject;
  if (view.body.verb === 'notify-attention' || view.body.verb === 'notify-result') return 'director-open-attention';
  if (view.body.verb === 'receive-work') return subjectCoordinates ? 'director-intake' : 'director-supervise';
  if (view.body.verb === 'receive-result' || view.body.verb === 'present-attention') return subjectCoordinates ? 'director-gather-present' : 'director-open-attention';
  if (productCoordinates && coordinates(view.inspectionRoute) && side && view.inspectedProjectKey !== null) return `director-listen-${side}`;
  // Unknown ownership/direction cannot borrow another project's authority/gaze.
  return 'director-supervise';
}
