/**
 * Scheduled (calendar) task management over the harness (Stage W / D-307).
 *
 * These methods expose the same scheduled-task authority the GUI, CLI, and
 * Markdown `.agents/loops` files already use. A calendar task creates NEW work
 * — a fresh session on each fire — which is a different target type than a
 * follow-up, whose occurrence continues an existing session/thread.
 *
 * Scope: the caller's workspace resolves to one project; agents manage that
 * project's tasks. Loop-backed tasks stay file-owned — enable/disable and
 * document edits go through content revisions (CAS), and creating/renaming a
 * loop means writing its Markdown file.
 */

export type ScheduledTaskScheduleKind = "cron" | "daily" | "once" | "weekly";

export interface ScheduledTaskScheduleView {
  kind: ScheduledTaskScheduleKind;
  /** IANA timezone the schedule is interpreted in. */
  timezone: string;
  /** daily/weekly/once: "HH:mm" */
  time?: string;
  /** daily/weekly: several "HH:mm" fire times */
  times?: string[];
  /** weekly: zero-based weekdays (0 = Sunday) */
  weekdays?: number[];
  /** once: "yyyy-LL-dd" */
  date?: string;
  /** cron: cron expression in the schedule timezone */
  cron?: string;
}

export interface ScheduledTaskExecutionView {
  providerID: string;
  modelID: string;
  thinkingLevel?: string;
  agent?: string;
  prompt: string;
  runAsGoal?: true;
  goalTokenBudget?: number;
}

export type ScheduledTaskStatusValue = "error" | "idle" | "running" | "success";

export interface ScheduledTaskStateView {
  createdAt: number;
  updatedAt: number;
  lastStatus: ScheduledTaskStatusValue;
  lastRunAt?: number;
  lastDurationMs?: number;
  lastError?: string;
  /** Session identity of the most recent run — opens the real session record. */
  lastSessionId?: string;
  nextRunAt?: number;
}

export interface ScheduledTaskView {
  id: string;
  name: string;
  enabled: boolean;
  schedule: ScheduledTaskScheduleView;
  execution: ScheduledTaskExecutionView;
  state: ScheduledTaskStateView;
  /** Loop-backed tasks are owned by this Markdown file — edit via schedule.loop.*. */
  loopFile?: string;
  loopRevision?: string;
  loopScope?: "project" | "user";
  loopShadowed?: true;
  loopError?: string;
}

/** Editable fields for a JSON-owned task; loop metadata is never accepted. */
export interface ScheduledTaskUpsertInput {
  id?: string;
  name?: string;
  enabled?: boolean;
  schedule?: Partial<ScheduledTaskScheduleView>;
  execution?: Partial<Omit<ScheduledTaskExecutionView, "runAsGoal">> & { runAsGoal?: boolean };
}

/** No fields: the project is resolved from the caller's workspace. */
export type ScheduleListParams = Record<string, never>;

export interface ScheduleListResult {
  projectId: string;
  projectPath?: string;
  tasks: ScheduledTaskView[];
}

export interface ScheduleGetParams {
  taskId: string;
}

export interface ScheduleGetResult {
  task: ScheduledTaskView;
}

export interface ScheduleUpsertParams {
  task: ScheduledTaskUpsertInput;
}

export interface ScheduleUpsertResult {
  created: boolean;
  task: ScheduledTaskView;
  tasks: ScheduledTaskView[];
}

export interface ScheduleRemoveParams {
  taskId: string;
}

export interface ScheduleRemoveResult {
  tasks: ScheduledTaskView[];
}

export interface ScheduleRunParams {
  taskId: string;
}

export interface ScheduleRunResult {
  sessionId?: string;
  task: ScheduledTaskView;
}

export interface ScheduleSetEnabledParams {
  taskId: string;
  enabled: boolean;
  /** Loop tasks: CAS guard on the Markdown content revision. */
  expectedRevision?: string;
}

export interface ScheduleSetEnabledResult {
  task: ScheduledTaskView;
}

export interface ScheduleLoopDocument {
  content: string;
  revision: string;
  path: string;
  scope: "project" | "user";
}

export interface ScheduleLoopReadParams {
  taskId: string;
}

export interface ScheduleLoopReadResult {
  document: ScheduleLoopDocument;
}

export interface ScheduleLoopUpdateParams {
  taskId: string;
  content: string;
  /** Required CAS guard — the revision from schedule.loop.read. */
  expectedRevision: string;
}

export interface ScheduleLoopUpdateResult {
  document: ScheduleLoopDocument;
  task: ScheduledTaskView | null;
}

export interface ScheduleLoopRemoveParams {
  taskId: string;
  /** Optional CAS guard — refuse to delete if the file changed since read. */
  expectedRevision?: string;
}

export interface ScheduleLoopRemoveResult {
  tasks: ScheduledTaskView[];
}

export type ScheduleStatusParams = Record<string, never>;

export interface ScheduleStatusResult {
  hasEnabledScheduledTasks: boolean;
  hasRunningScheduledTasks: boolean;
  enabledScheduledTasksCount: number;
  runningScheduledTasksCount: number;
}
