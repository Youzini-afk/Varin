/** Call-scoped ordinary service adapter into the existing project/Markdown asset owner. */
import { createHash } from 'node:crypto';
import { parseVarinToolJson, type JsonValue } from '@varin/extension-contract';
import type { HostCapabilityHandler } from '@varin/extension-host';
import { ScheduledTaskError, type createScheduledTaskService } from '../scheduled-tasks/service.js';
import { runToolDomainEffect } from './tool-invocation.js';
export const SCHEDULE_CAPABILITY = 'tasks.schedules';
export function createScheduleToolOwner(options: {
  service: ReturnType<typeof createScheduledTaskService>;
  workspaceRoot(workspaceId: string): Promise<string>;
}): HostCapabilityHandler {
  return async (method, params, context) => {
    if (method !== 'manage' || !params || typeof params !== 'object' || Array.isArray(params) || typeof params.action !== 'string') throw new Error('Invalid scheduled task invocation');
    return runToolDomainEffect(context, { domain: SCHEDULE_CAPABILITY, toolName: 'scheduled_task', arguments: params }, async authority => {
      let enteredMutation = false;
      try {
        if (!authority.source) throw new Error('Scheduled tasks require the caller’s admitted project source');
        const projectId = await options.service.resolveProjectID({ directory: await options.workspaceRoot(authority.source.workspace_id) });
        context.signal.throwIfAborted();
        const taskId = () => { if (typeof params.taskId !== 'string' || !params.taskId.trim()) throw new Error('taskId is required'); return params.taskId; };
        let result: unknown;
        switch (params.action) {
          case 'list': result = { tasks: await options.service.list(projectId) }; break;
          case 'get': { const id = taskId(); const task = (await options.service.list(projectId)).find(value => value.id === id); if (!task) throw new Error('Task not found'); result = { task }; break; }
          case 'status': result = await options.service.status(projectId); break;
          case 'read_loop': result = { document: await options.service.readLoopDocument(projectId, taskId()) }; break;
          case 'upsert': {
            if (!params.task || typeof params.task !== 'object' || Array.isArray(params.task)) throw new Error('task is required');
            const task = { ...params.task, id: typeof params.task.id === 'string' ? params.task.id : `task:${createHash('sha256').update(authority.operationId).digest('hex')}` };
            enteredMutation = true; result = await options.service.upsert(projectId, task); break;
          }
          case 'remove': { const id = taskId(); enteredMutation = true; result = { tasks: await options.service.remove(projectId, id) }; break; }
          case 'run': { const id = taskId(); enteredMutation = true; result = await options.service.run(projectId, id, authority.operationId); break; }
          case 'set_enabled': { const id = taskId(); if (typeof params.enabled !== 'boolean') throw new Error('enabled must be a boolean'); enteredMutation = true; result = { task: await options.service.setEnabled(projectId, id, params.enabled, params.expectedRevision) }; break; }
          case 'write_loop': { const id = taskId(); if (typeof params.content !== 'string' || typeof params.expectedRevision !== 'string') throw new Error('content and expectedRevision are required'); enteredMutation = true; result = await options.service.updateLoopDocument(projectId, id, { content: params.content, expectedRevision: params.expectedRevision }); break; }
          case 'remove_loop': { const id = taskId(); if (typeof params.expectedRevision !== 'string') throw new Error('expectedRevision is required'); enteredMutation = true; result = { tasks: await options.service.removeLoopFile(projectId, id, params.expectedRevision) }; break; }
          case 'cancel_occurrence': case 'retry_occurrence': { const id = taskId(); enteredMutation = true; result = await options.service.controlOccurrence(projectId, id, params.occurrenceId, params.occurrenceRevision, params.action === 'cancel_occurrence' ? 'cancel' : 'retry'); break; }
          case 'retry_calculation': { const id = taskId(); enteredMutation = true; result = await options.service.retryCalculation(projectId, id, params.definitionRevision); break; }
          default: throw new Error('Unknown scheduled task action');
        }
        return { executor_stopped: true, completion: { kind: 'result', outcome: 'succeeded', effect: enteredMutation ? 'confirmed' : 'none', content: parseVarinToolJson(result as JsonValue) } };
      } catch (error) {
        // The asset owner is awaited to its actual return. An uncertain write is neither
        // silently replayed nor called no-effect because its reader/callback was cancelled.
        const uncertain = enteredMutation && !(error instanceof ScheduledTaskError && [400, 404, 409].includes(error.statusCode));
        return { executor_stopped: true, completion: { kind: 'result', outcome: uncertain ? 'indeterminate' : 'failed', effect: uncertain ? 'unknown' : 'none',
          content: { status: uncertain ? 'needs_attention' : 'rejected', error: error instanceof Error ? error.message : 'Scheduled task request failed' } } };
      }
    });
  };
}
