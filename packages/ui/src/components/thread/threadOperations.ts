import type { ThreadSnapshot } from '@varin/application-client';

export function canCancelOperation(operation: ThreadSnapshot['operations'][number], waitingOn?: string | null): boolean {
  const subscription = operation.mcp_resource_subscription;
  if (subscription) return subscription.availability !== 'closed' || !subscription.localReleased;
  const task = operation.host_job?.mcpTask;
  return task ? !operation.cancel_requested && (task.task.status === 'working' || task.task.status === 'input_required')
    : operation.phase !== 'terminal' && (operation.executor !== 'ask_user' || waitingOn === operation.waiting_on);
}
