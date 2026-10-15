/** Call-scoped ordinary service adapter into the existing project/Markdown asset owner. */
import { createHash } from 'node:crypto';
import { parseVarinToolJson, type JsonValue } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import { ScheduledTaskError, type ScheduledTaskService } from '../scheduled-tasks/service.js';
import { runToolDomainCall, type ToolInvocationAuthority } from './tool-invocation.js';
import type { ToolExecutionReceipt } from './tool-bridge.js';

export const SCHEDULE_CAPABILITY = 'tasks.schedules';
export interface ScheduleToolOwnerOptions {
  service: ScheduledTaskService;
  workspaceRoot(workspaceId: string): Promise<string>;
  manageManaged?(invocation: ToolInvocationAuthority, signal: AbortSignal): Promise<ToolExecutionReceipt>;
}
export type ScheduleManagementInput = { [key: string]: JsonValue; action: string };
export function scheduleManagementInput(value: unknown): ScheduleManagementInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).action !== 'string'
    || Object.keys(value).some(key => !['action', 'taskId', 'task', 'enabled', 'content', 'expectedRevision', 'occurrenceId', 'occurrenceRevision', 'definitionRevision'].includes(key))) {
    throw new Error('Invalid scheduled task invocation');
  }
  return parseVarinToolJson(value as JsonValue) as ScheduleManagementInput;
}
export function scheduleFailure(error: unknown, uncertain = false, executorStopped = true): ToolExecutionReceipt {
  return { executor_stopped: executorStopped, completion: { kind: 'result', outcome: uncertain ? 'indeterminate' : 'failed', effect: uncertain ? 'unknown' : 'none',
    content: { data: { status: uncertain ? 'needs_attention' : 'rejected', error: error instanceof Error ? error.message : 'Scheduled task request failed' }, parts: [] } } };
}
/** Both local and managed entry points call this one asset owner. Once entered, an
 * original mutation is awaited through cancellation before its receipt is returned. */
export async function executeProjectSchedule(service: ScheduledTaskService, projectId: string, operationId: string,
  params: ScheduleManagementInput, signal: AbortSignal): Promise<ToolExecutionReceipt> {
  let enteredMutation = false;
  try {
    signal.throwIfAborted();
    const taskId = () => { if (typeof params.taskId !== 'string' || !params.taskId.trim()) throw new Error('taskId is required'); return params.taskId; };
    let result: unknown;
    switch (params.action) {
      case 'list': result = { tasks: await service.list(projectId) }; break;
      case 'get': { const id = taskId(); const task = (await service.list(projectId)).find(value => value.id === id); if (!task) throw new ScheduledTaskError('Task not found', 404); result = { task }; break; }
      case 'status': result = await service.status(projectId); break;
      case 'read_loop': result = { document: await service.readLoopDocument(projectId, taskId()) }; break;
      case 'upsert': {
        if (!params.task || typeof params.task !== 'object' || Array.isArray(params.task)) throw new Error('task is required');
        const task = { ...params.task, id: typeof params.task.id === 'string' ? params.task.id : `task:${createHash('sha256').update(operationId).digest('hex')}` };
        enteredMutation = true; result = await service.upsert(projectId, task); break;
      }
      case 'remove': { const id = taskId(); enteredMutation = true; result = { tasks: await service.remove(projectId, id) }; break; }
      case 'run': { const id = taskId(); enteredMutation = true; result = await service.run(projectId, id, operationId); break; }
      case 'set_enabled': { const id = taskId(); if (typeof params.enabled !== 'boolean') throw new Error('enabled must be a boolean'); enteredMutation = true; result = { task: await service.setEnabled(projectId, id, params.enabled, params.expectedRevision) }; break; }
      case 'write_loop': { const id = taskId(); if (typeof params.content !== 'string' || typeof params.expectedRevision !== 'string') throw new Error('content and expectedRevision are required'); enteredMutation = true; result = await service.updateLoopDocument(projectId, id, { content: params.content, expectedRevision: params.expectedRevision }); break; }
      case 'remove_loop': { const id = taskId(); if (typeof params.expectedRevision !== 'string') throw new Error('expectedRevision is required'); enteredMutation = true; result = { tasks: await service.removeLoopFile(projectId, id, params.expectedRevision) }; break; }
      case 'cancel_occurrence': case 'retry_occurrence': { const id = taskId(); enteredMutation = true; result = await service.controlOccurrence(projectId, id, params.occurrenceId, params.occurrenceRevision, params.action === 'cancel_occurrence' ? 'cancel' : 'retry'); break; }
      case 'retry_calculation': { const id = taskId(); enteredMutation = true; result = await service.retryCalculation(projectId, id, params.definitionRevision); break; }
      default: throw new Error('Unknown scheduled task action');
    }
    return { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: enteredMutation ? 'confirmed' : 'none', content: { data: parseVarinToolJson(result as JsonValue), parts: [] } } };
  } catch (error) {
    // The asset owner is awaited to its actual return. An uncertain write is neither
    // silently replayed nor called no-effect because its reader/callback was cancelled.
    const uncertain = enteredMutation && !(error instanceof ScheduledTaskError && [400, 404, 409].includes(error.statusCode));
    return scheduleFailure(error, uncertain);
  }
}
export function createScheduleToolOwner(options: ScheduleToolOwnerOptions): HostCapabilityHandler {
  return async (method, params, context) => {
    if (method !== 'manage') throw new Error('Invalid scheduled task invocation');
    const input = scheduleManagementInput(params);
    return runToolDomainCall(context, { operation: 'effect', domain: SCHEDULE_CAPABILITY, toolName: 'scheduled_task', arguments: params }, async authority => {
      let remote = false;
      try {
        if (!authority.source) throw new Error('Scheduled tasks require the caller’s admitted project source');
        if (authority.source.resource_owner.kind === 'managed_host') {
          if (!options.manageManaged) throw new Error('The original managed project schedule owner is unavailable');
          remote = true;
          return await options.manageManaged(authority, context.signal);
        }
        const projectId = await options.service.resolveProjectID({ directory: await options.workspaceRoot(authority.source.workspace_id) });
        return executeProjectSchedule(options.service, projectId, authority.operationId, input, context.signal);
      } catch (error) { return scheduleFailure(error, remote, !remote); }
    });
  };
}
