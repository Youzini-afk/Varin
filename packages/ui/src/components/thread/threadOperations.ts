import type { ThreadSnapshot } from '@varin/application-client';

export interface QuestionScope { run: ThreadSnapshot['activeRun'] | undefined; launch: ThreadSnapshot['launch'] | undefined }

/** Presentation of the original native question. This never grants permission or starts a Run. */
export function canRespondToQuestion(operation: ThreadSnapshot['operations'][number], { run, launch }: QuestionScope): boolean {
  if (!run || operation.executor !== 'ask_user' || operation.run_id !== run.id
    || operation.phase !== 'waiting' || operation.cancel_requested || run.cancel_requested
    || ['completed', 'failed', 'cancelled'].includes(run.state)) return false;
  if (run.state === 'waiting' && run.waiting_on === operation.waiting_on) return true;
  const acceptance = operation.call_completion;
  return launch?.run_id === run.id && launch.selection.driver.kind === 'extension'
    && operation.handed_off && acceptance?.kind === 'job_accepted'
    && acceptance.operation_id === operation.id && acceptance.phase === 'awaiting_user'
    && acceptance.effect === 'none' && acceptance.lifetime === 'thread';
}

export function canCancelOperation(operation: ThreadSnapshot['operations'][number], waitingOn?: string | null, questionScope?: QuestionScope): boolean {
  if (operation.executor === 'ask_user' && questionScope) return canRespondToQuestion(operation, questionScope);
  const subscription = operation.mcp_resource_subscription;
  if (subscription) return subscription.availability !== 'closed' || !subscription.localReleased;
  const task = operation.host_job?.mcpTask;
  return task ? !operation.cancel_requested && (task.task.status === 'working' || task.task.status === 'input_required')
    : operation.phase !== 'terminal' && (operation.executor !== 'ask_user' || waitingOn === operation.waiting_on);
}
