import type { DirectorPresentation } from './directorPresentation';

type DirectorExpression = 'query' | 'permission' | 'completion' | 'failure' | 'unknown-effect-check' | 'director-inspect' | 'work-active' | 'bot-dispatch' | 'bot-prepare' | 'bot-think' | 'external-wait' | 'disconnected';

/** Product mode alone is not authority to coordinate every project in the Host. */
export function directorBodyAction(view: DirectorPresentation, _side: 'left' | 'right' | null, notificationAvailable = false, expressionAvailable: (action: DirectorExpression) => boolean = () => false): string {
  if (view.health !== 'current') return expressionAvailable('disconnected') ? 'disconnected' : 'director-supervise';
  const notification = notificationAvailable ? 'director-notify-attention' : 'director-open-attention';
  const attentionKind = view.body.attentionItem?.kind;
  // Pending requests always win over result/inspection gestures in either product mode.
  // These expressions present facts; neither animation nor local input resolves them.
  if (attentionKind || view.body.verb === 'notify-attention' || view.body.verb === 'present-attention') {
    const expression = attentionKind === 'question' ? 'query'
      : attentionKind === 'permission' ? 'permission'
      : attentionKind === 'effect_unknown' ? 'unknown-effect-check'
      : attentionKind && ['run_failed', 'preparation_failed', 'mcp_error'].includes(attentionKind) ? 'failure' : null;
    return expression && expressionAvailable(expression) ? expression : notification;
  }
  if (view.body.verb === 'available') return 'idle-closed';
  const coordinates = (route: DirectorPresentation['interactionRoute']) => route === 'bot-coordinator' || route === 'coordination-review';
  const productCoordinates = coordinates(view.interactionRoute);
  const subject = view.body.subject;
  const hasExternalSubject = !!subject && view.cards.some(card => card.identity.threadId === subject.threadId && card.identity.branchId === subject.branchId);
  const subjectCoordinates = productCoordinates && coordinates(view.body.subjectRoute) && hasExternalSubject;
  // The Bot's own session replied publicly: gather the work and present it to the user.
  if (view.body.verb === 'present-reply') return productCoordinates && coordinates(view.body.subjectRoute) ? 'director-gather-present' : 'director-supervise';
  if (view.body.verb === 'receive-work') return subjectCoordinates || productCoordinates && !!view.body.edge?.rootProfileRevision ? 'director-intake' : 'director-supervise';
  if (view.body.verb === 'dispatch-work') return subjectCoordinates && expressionAvailable('bot-dispatch') ? 'bot-dispatch' : 'director-supervise';
  if (view.body.verb === 'receive-report') return subjectCoordinates && expressionAvailable('director-inspect') ? 'director-inspect' : 'director-supervise';
  // An exact executor receipt is not evidence that the whole task or other executors stopped.
  if (view.body.verb === 'executor-stopped') return view.body.workActive && expressionAvailable('work-active') ? 'work-active' : 'director-supervise';
  if (view.body.verb === 'receive-result' || view.body.verb === 'notify-result') {
    const result = view.body.edge?.kind === 'receive-result' ? view.body.edge.outcome : null;
    if (result === 'completed' && subjectCoordinates) return 'director-gather-present';
    const expression = result === 'completed' ? 'completion' : result === 'failed' ? 'failure' : null;
    return expression && expressionAvailable(expression) ? expression : notification;
  }
  const activity = view.body.activity;
  if (activity && (['waiting','retry','queued'].includes(activity.kind) || productCoordinates)) {
    const action = activity.kind === 'preparing' ? 'bot-prepare' : activity.kind === 'thinking' ? 'bot-think' : 'external-wait';
    if (expressionAvailable(action)) return action;
  }
  if (view.body.workActive && expressionAvailable('work-active')) return 'work-active';
  // Inspection is attention to an actual project, not a report receipt or a layout direction.
  // Old left/right artwork cannot masquerade as a forward, non-spatial sentence.
  if (productCoordinates && coordinates(view.inspectionRoute) && view.inspectedProjectKey !== null
    && expressionAvailable('director-inspect')) return 'director-inspect';
  // Unknown ownership/direction cannot borrow another project's authority/gaze.
  return 'director-supervise';
}

/** A stop receipt ends only after the recovered observation frame was really painted. */
export function directorStopRecoveryReady(edgeKind: string | undefined, drawn: { action?: string; context: string | null | undefined; pauseSafe?: boolean } | null, context: string): boolean {
  return edgeKind === 'executor-stopped' && !!drawn && drawn.context === context
    && drawn.action === 'director-supervise' && drawn.pauseSafe === true;
}
