import type { CalendarDefinition, CalendarMissedPolicy, CalendarOccurrence, CalendarTarget, SourceResourceOwner } from '@varin/protocol';
import type { ThreadResolvedSource, ThreadSourceTargets } from './threads.js';

/** External GUI/Markdown definition. Native execution facts are read separately from Catalog. */
export interface ScheduledTaskSchedule {
  kind: 'daily' | 'weekly' | 'once' | 'cron';
  times?: string[]; time?: string; date?: string; weekdays?: number[]; cron?: string; timezone: string;
}
export interface ScheduledTaskExecution { prompt: string }
export interface ScheduledTaskState { createdAt: number; updatedAt: number }
export interface ScheduledTask {
  id: string; name: string; enabled: boolean;
  runtime: 'agent';
  /** The native execution target. Existing work inherits its real owner. */
  target: CalendarTarget;
  missedPolicy?: CalendarMissedPolicy;
  loopFile?: string; loopScope?: 'project' | 'user'; loopRevision?: string; loopError?: string; loopShadowed?: true;
  schedule: ScheduledTaskSchedule; execution: ScheduledTaskExecution; state: ScheduledTaskState;
  /** Live projection, never written back to project config or Markdown. */
  calendar?: { definition: CalendarDefinition; occurrences: CalendarOccurrence[] };
}
export interface ScheduledTaskLoopDocument { content: string; path: string; revision: string; scope: 'project' | 'user' }
export interface ScheduledTaskRunReceipt { runtime: 'agent'; occurrence: CalendarOccurrence; task: ScheduledTask }
export interface ScheduledTasksAPI {
  /** Project-scoped discovery and registration reuse the Host source authority without creating work. */
  listSources(projectId: string, signal?: AbortSignal): Promise<ThreadSourceTargets>;
  resolveSource(projectId: string, request: { resourceOwner: SourceResourceOwner; path: string }, signal?: AbortSignal): Promise<ThreadResolvedSource>;
  list(projectId: string, signal?: AbortSignal): Promise<ScheduledTask[]>;
  upsert(projectId: string, task: Partial<ScheduledTask>): Promise<ScheduledTask[]>;
  remove(projectId: string, taskId: string): Promise<ScheduledTask[]>;
  run(projectId: string, taskId: string, key: string): Promise<ScheduledTaskRunReceipt>;
  readLoop(projectId: string, taskId: string): Promise<ScheduledTaskLoopDocument>;
  updateLoop(projectId: string, taskId: string, content: string, expectedRevision: string): Promise<{ document: ScheduledTaskLoopDocument; task: ScheduledTask | null }>;
  setLoopEnabled(projectId: string, taskId: string, enabled: boolean, expectedRevision: string): Promise<ScheduledTask | null>;
  removeLoop(projectId: string, taskId: string, expectedRevision: string): Promise<ScheduledTask[]>;
  controlOccurrence(projectId: string, taskId: string, occurrenceId: string, expectedRevision: number, action: 'cancel' | 'retry'): Promise<CalendarOccurrence>;
  retryCalculation(projectId: string, taskId: string, expectedRevision: number): Promise<CalendarDefinition>;
}
