import type { DirectorPresentation } from './directorPresentation';

/** Product mode alone is not authority to coordinate every project in the Host. */
export function directorBodyAction(view: DirectorPresentation, side: 'left' | 'right' | null, notificationAvailable = false, expressionAvailable: (action: 'query' | 'completion' | 'failure' | 'unknown-effect-check') => boolean = () => false): string {
  // Art capability only; existing accepted bundles retain their local-response fallback.
  let notification = notificationAvailable ? 'director-notify-attention' : 'director-open-attention';
  if (notificationAvailable) {
    // A scoped live request/result selects expression, never creates a global outcome.
    const result = view.body.edge?.kind === 'receive-result' ? view.body.edge.outcome : null;
    const attentionKind = view.body.attentionItem?.kind;
    const resultNotice = !attentionKind && (view.body.verb === 'notify-result' || view.body.verb === 'receive-result');
    const expression = attentionKind === 'question' ? 'query'
      : attentionKind === 'effect_unknown' ? 'unknown-effect-check'
      : attentionKind && ['run_failed', 'preparation_failed', 'mcp_error'].includes(attentionKind) ? 'failure'
      : resultNotice && result === 'completed' ? 'completion'
      : resultNotice && result === 'failed' ? 'failure' : null;
    if (expression && expressionAvailable(expression)) notification = expression;
  }
  if (view.health !== 'current') return 'director-supervise';
  if (view.body.verb === 'available') return 'idle-closed';
  const coordinates = (route: DirectorPresentation['interactionRoute']) => route === 'bot-coordinator' || route === 'coordination-review';
  const productCoordinates = coordinates(view.interactionRoute);
  const subject = view.body.subject;
  const hasExternalSubject = !!subject && view.cards.some(card => card.identity.threadId === subject.threadId && card.identity.branchId === subject.branchId);
  const subjectCoordinates = productCoordinates && coordinates(view.body.subjectRoute) && hasExternalSubject;
  if (view.body.verb === 'notify-attention' || view.body.verb === 'notify-result') return notification;
  if (view.body.verb === 'receive-work') return subjectCoordinates ? 'director-intake' : 'director-supervise';
  if (view.body.verb === 'receive-result' || view.body.verb === 'present-attention') return subjectCoordinates ? 'director-gather-present' : notification;
  if (productCoordinates && coordinates(view.inspectionRoute) && side && view.inspectedProjectKey !== null) return `director-listen-${side}`;
  // Unknown ownership/direction cannot borrow another project's authority/gaze.
  return 'director-supervise';
}
