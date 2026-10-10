import type { CalendarOnceAcceptance, CalendarDefinition, CalendarMissedPolicy, CalendarOccurrence, CalendarTarget, ThinkingLevel } from '@varin/protocol';

/** External GUI/Markdown definition. Native execution facts are read separately from Catalog. */
export type ScheduledTaskStatus = 'idle' | 'running' | 'success' | 'error';
export interface ScheduledTaskSchedule {
  kind: 'daily' | 'weekly' | 'once' | 'cron';
  times?: string[]; time?: string; date?: string; weekdays?: number[]; cron?: string; timezone: string;
}
export interface ScheduledTaskExecution {
  prompt: string;
  /** Pi selections. Agent definitions select their actual model/source/Goal in target. */
  providerID?: string; modelID?: string; thinkingLevel?: ThinkingLevel; agent?: string; runAsGoal?: true; goalTokenBudget?: number;
}
export interface ScheduledTaskState {
  createdAt: number; updatedAt: number;
  /** Pi-owned state only. Never populated from a native Run or used for native admission. */
  lastRunAt?: number; lastStatus?: ScheduledTaskStatus; lastError?: string; lastDurationMs?: number;
  lastSessionId?: string; nextRunAt?: number;
}
export interface ScheduledTask {
  id: string; name: string; enabled: boolean;
  runtime?: 'pi' | 'agent';
  /** Required for an explicitly selected Agent definition. Existing work inherits its real owner. */
  target?: CalendarTarget;
  missedPolicy?: CalendarMissedPolicy;
  loopFile?: string; loopScope?: 'project' | 'user'; loopRevision?: string; loopError?: string; loopShadowed?: true;
  schedule: ScheduledTaskSchedule; execution: ScheduledTaskExecution; state: ScheduledTaskState;
  /** Live projection, never written back to project config or Markdown. */
  /** Managed owner-handoff provenance, never caller-writable execution status. */
  onceAcceptance?: CalendarOnceAcceptance;
  pendingCalendarHandoff?: { definitionId: string; generation: number };
  calendar?: { definition: CalendarDefinition; occurrences: CalendarOccurrence[] };
}
export interface ScheduledTaskLoopDocument { content: string; path: string; revision: string; scope: 'project' | 'user' }
export type ScheduledTaskRunReceipt = { runtime: 'pi'; sessionId: string; task: ScheduledTask | null }
  | { runtime: 'agent'; occurrence: CalendarOccurrence; task: ScheduledTask };
export interface ScheduledTasksAPI {
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
