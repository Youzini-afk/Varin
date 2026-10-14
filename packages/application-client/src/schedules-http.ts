import type { ScheduledTask, ScheduledTasksAPI } from './schedules.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

export class ScheduleRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ScheduleRequestError'; }
}
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const decodeTask = (value: unknown): ScheduledTask => {
  const task = record(value), target = record(task?.target), schedule = record(task?.schedule), execution = record(task?.execution), state = record(task?.state);
  if (!task || task.runtime !== 'agent' || typeof task.id !== 'string' || !task.id || typeof task.name !== 'string' || typeof task.enabled !== 'boolean'
    || !target || !['new_work', 'existing_work'].includes(String(target.kind))
    || !schedule || !['once', 'daily', 'weekly', 'cron'].includes(String(schedule.kind)) || typeof schedule.timezone !== 'string' || !schedule.timezone
    || !execution || typeof execution.prompt !== 'string' || Object.keys(execution).some(key => key !== 'prompt')
    || !state || !Number.isSafeInteger(state.createdAt) || !Number.isSafeInteger(state.updatedAt)
    || Object.keys(state).some(key => key !== 'createdAt' && key !== 'updatedAt')) throw new Error('Invalid native scheduled task');
  return task as unknown as ScheduledTask;
};
/** The ordinary authenticated Host transport. No browser timer or calendar state authority. */
export function createScheduledTasksHttpAPI(): ScheduledTasksAPI {
  const segment = (value: string) => { if (!value.trim()) throw new Error('Schedule identity is required'); return encodeURIComponent(value); };
  const base = (project: string, task?: string) => `/api/projects/${segment(project)}/scheduled-tasks${task === undefined ? '' : `/${segment(task)}`}`;
  const request = async <T>(url: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
    const generation = getRuntimeEndpointGeneration();
    const response = await runtimeFetch(url, { method, ...(signal ? { signal } : {}), headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during schedule request');
    const result = await response.json();
    if (generation !== getRuntimeEndpointGeneration()) throw new Error('Application Host changed during schedule request');
    if (!response.ok) throw new ScheduleRequestError(response.status, typeof result?.error === 'string' ? result.error : 'Scheduled task request failed');
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid scheduled task response');
    return result as T;
  };
  const tasks = async (promise: Promise<{ tasks: unknown }>) => {
    const value = (await promise).tasks;
    if (!Array.isArray(value)) throw new Error('Invalid scheduled task list');
    return value.map(decodeTask);
  };
  return {
    async listSources(project, signal) {
      const value = await request<Awaited<ReturnType<ScheduledTasksAPI['listSources']>>>(`${base(project)}/sources`, 'GET', undefined, signal);
      if (!Array.isArray(value.targets) || !Array.isArray(value.unavailable)) throw new Error('Invalid scheduled task source list');
      return value;
    },
    async resolveSource(project, source, signal) {
      const value = await request<Awaited<ReturnType<ScheduledTasksAPI['resolveSource']>>>(`${base(project)}/sources/resolve`, 'POST', source, signal);
      if (!value.resourceOwner || typeof value.workspaceId !== 'string' || !value.workspaceId.trim() || typeof value.path !== 'string' || !value.path.trim()) throw new Error('Invalid scheduled task source registration');
      return value;
    },
    list: (project, signal) => tasks(request(base(project), 'GET', undefined, signal)),
    upsert: (project, task) => tasks(request(base(project), 'PUT', { task })),
    remove: (project, task) => tasks(request(base(project, task), 'DELETE')),
    async run(project, task, key) {
      if (!key.trim()) throw new Error('A stable run-now key is required');
      const value = await request<Awaited<ReturnType<ScheduledTasksAPI['run']>>>(`${base(project, task)}/run`, 'POST', { key });
      if (value.runtime === 'agent' && value.occurrence && typeof value.occurrence.id === 'string') return { ...value, task: decodeTask(value.task) };
      throw new Error('Invalid scheduled task run receipt');
    },
    async readLoop(project, task) { return (await request<{ document: Awaited<ReturnType<ScheduledTasksAPI['readLoop']>> }>(`${base(project, task)}/loop-file`, 'GET')).document; },
    updateLoop: (project, task, content, expectedRevision) => request(`${base(project, task)}/loop-file`, 'PUT', { content, expectedRevision }),
    async setLoopEnabled(project, task, enabled, expectedRevision) { return (await request<{ task: Awaited<ReturnType<ScheduledTasksAPI['setLoopEnabled']>> }>(`${base(project, task)}/loop-file`, 'PATCH', { enabled, expectedRevision })).task; },
    removeLoop: (project, task, expectedRevision) => tasks(request(`${base(project, task)}/loop-file`, 'DELETE', { expectedRevision })),
    controlOccurrence: (project, task, occurrenceId, expectedRevision, action) => request(`${base(project, task)}/occurrences/${segment(occurrenceId)}/control`, 'POST', { expectedRevision, action }),
    retryCalculation: (project, task, expectedRevision) => request(`${base(project, task)}/calculation/retry`, 'POST', { expectedRevision }),
  };
}
