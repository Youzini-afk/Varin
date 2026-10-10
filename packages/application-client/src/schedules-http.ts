import type { ScheduledTasksAPI } from './schedules.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';

export class ScheduleRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ScheduleRequestError'; }
}
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
    return value as Awaited<ReturnType<ScheduledTasksAPI['list']>>;
  };
  return {
    list: (project, signal) => tasks(request(base(project), 'GET', undefined, signal)),
    upsert: (project, task) => tasks(request(base(project), 'PUT', { task })),
    remove: (project, task) => tasks(request(base(project, task), 'DELETE')),
    async run(project, task, key) {
      if (!key.trim()) throw new Error('A stable run-now key is required');
      const value = await request<Awaited<ReturnType<ScheduledTasksAPI['run']>>>(`${base(project, task)}/run`, 'POST', { key });
      if (value.runtime === 'pi' && typeof value.sessionId === 'string' && value.sessionId) return value;
      if (value.runtime === 'agent' && value.occurrence && typeof value.occurrence.id === 'string') return value;
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
