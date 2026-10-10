import type { CalendarOwner } from './calendar-owner.js';
import { DateTime } from 'luxon';
import { computeNextRunAt, computeOnceDueAt, isMissedRecurringSlot } from './recurrence.js';
export { computeNextRunAt, isMissedRecurringSlot } from './recurrence.js';
import { watch } from 'node:fs';
import { dirname as pathDirname } from 'node:path';
import { discoverLoops, loopDirectoriesFor } from './loops.js';
import type { ScheduledTask } from '../projects/project-config.js';
import type { createProjectConfigRuntime } from '../projects/project-config.js';

const DEFAULT_GLOBAL_CONCURRENCY = 4;
const DEFAULT_PROJECT_CONCURRENCY = 2;
const JITTER_MAX_MS = 2_000;
const TASK_TITLE_MAX_LENGTH = 120;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

type RunReason = 'manual' | 'scheduled';

interface QueuedTaskRun {
  projectID: string;
  reason: RunReason;
  resolve?: ((result: ScheduledTaskRunResult) => void) | undefined;
  taskID: string;
}

interface ScheduledProject {
  id: string;
  path: string;
}

interface TaskRunEvent {
  projectID: string;
  ranAt: number;
  sessionID?: string;
  status: 'error' | 'running' | 'success';
  taskID: string;
}

interface ExecutorInput {
  onSessionCreated?: (sessionId: string) => void;
  projectID: string;
  projectPath: string;
  reason: RunReason;
  startedAt: number;
  task: ScheduledTask;
  title: string;
}

type TaskExecutor = (input: ExecutorInput) => Promise<{ sessionID: string }>;

interface ScheduledTasksRuntimeDependencies {
  emitTaskRunEvent?: (event: TaskRunEvent) => void;
  executeTask?: TaskExecutor;
  listProjects: () => Promise<ScheduledProject[]>;
  logger?: Pick<Console, 'info' | 'warn'>;
  maxGlobalConcurrency?: number;
  maxProjectConcurrency?: number;
  projectConfigRuntime: ReturnType<typeof createProjectConfigRuntime>;
}

export interface ScheduledTaskRunResult {
  error?: string | undefined;
  ok: boolean;
  queued?: boolean;
  running?: boolean;
  sessionID?: string | undefined;
  skipped?: boolean;
  status?: 'error' | 'success';
  task?: ScheduledTask | null | undefined;
}

const buildTaskKey = (projectID: string, taskID: string): string => `${projectID}:${taskID}`;

const safeErrorMessage = (error: unknown, maxLength = 2_000): string => {
  const raw = error instanceof Error
    ? (error.message || String(error))
    : String(error ?? 'Unknown error');
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'Unknown error';
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

export const formatScheduledSessionTitle = (task: {
  name?: string;
  schedule?: { timezone?: string };
}, nowMs = Date.now()): string => {
  const timezone = typeof task?.schedule?.timezone === 'string' && task.schedule.timezone.trim().length > 0
    ? task.schedule.timezone.trim()
    : DateTime.local().zoneName;
  const stamp = DateTime.fromMillis(nowMs, { zone: timezone }).toFormat('yyyy-LL-dd HH:mm');
  const taskName = typeof task?.name === 'string' && task.name.trim().length > 0
    ? task.name.trim()
    : 'Scheduled task';
  const suffix = ` ${stamp}`;
  const maxTaskNameLength = Math.max(1, TASK_TITLE_MAX_LENGTH - suffix.length);
  const trimmedName = taskName.length > maxTaskNameLength
    ? taskName.slice(0, maxTaskNameLength)
    : taskName;
  return `${trimmedName}${suffix}`;
};

export const createScheduledTasksRuntime = (deps: ScheduledTasksRuntimeDependencies) => {
  const {
    projectConfigRuntime,
    listProjects,
    emitTaskRunEvent,
    executeTask: initialExecuteTask,
    logger = console,
    maxGlobalConcurrency = DEFAULT_GLOBAL_CONCURRENCY,
    maxProjectConcurrency = DEFAULT_PROJECT_CONCURRENCY,
  } = deps;

  let executeTask = initialExecuteTask;
  let calendarOwner: CalendarOwner | undefined;
  const projectSyncs = new Map<string, Promise<ScheduledTask[]>>();
  let started = false;
  let lifecycleGeneration = 0;
  const tasksByProject = new Map<string, Map<string, ScheduledTask>>();
  const projectPathByID = new Map<string, string>();
  const timersByTaskKey = new Map<string, ReturnType<typeof setTimeout>>();
  const queuedTaskKeys = new Set<string>();
  const runningTaskKeys = new Set<string>();
  const runningCountByProject = new Map<string, number>();
  let runningGlobalCount = 0;
  const queue: QueuedTaskRun[] = [];

  const clearTimerForKey = (taskKey: string): void => {
    const timer = timersByTaskKey.get(taskKey);
    if (timer) {
      clearTimeout(timer);
      timersByTaskKey.delete(taskKey);
    }
  };

  const clearProjectTimers = (projectID: string): void => {
    const tasks = tasksByProject.get(projectID);
    if (!tasks) {
      return;
    }
    for (const task of tasks.values()) {
      clearTimerForKey(buildTaskKey(projectID, task.id));
    }
  };

  const setProjectTasks = (projectID: string, tasks: ScheduledTask[]): void => {
    clearProjectTimers(projectID);
    const taskMap = new Map<string, ScheduledTask>();
    for (const task of tasks) {
      taskMap.set(task.id, task);
    }
    tasksByProject.set(projectID, taskMap);
  };

  const scheduleTask = (projectID: string, taskID: string, nextRunAt: number): void => {
    if (!started) return;
    const scheduledGeneration = lifecycleGeneration;
    const taskKey = buildTaskKey(projectID, taskID);
    clearTimerForKey(taskKey);

    if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) {
      return;
    }

    const delayBase = Math.max(0, Math.round(nextRunAt - Date.now()));
    const jitter = Math.floor(Math.random() * (JITTER_MAX_MS + 1));
    const delay = delayBase + jitter;
    const boundedDelay = Math.min(delay, MAX_TIMER_DELAY_MS);

    const timer = setTimeout(async () => {
      if (!started || scheduledGeneration !== lifecycleGeneration) return;
      if (delay > MAX_TIMER_DELAY_MS) {
        scheduleTask(projectID, taskID, nextRunAt);
        return;
      }

      clearTimerForKey(taskKey);
      const taskMap = tasksByProject.get(projectID);
      const task = taskMap?.get(taskID);
      if (!task || task.runtime === 'agent' || !task.enabled) {
        return;
      }
      // A timer belongs to one persisted schedule slot. If a resync replaced
      // that slot, let the current slot's timer own the run. If the event loop
      // woke after the following valid occurrence, skip that stale occurrence
      // and compute forward. A late callback before that next occurrence still
      // owns this slot and runs once.
      if (task.state.nextRunAt !== nextRunAt) {
        if (typeof task.state.nextRunAt === 'number' && Number.isFinite(task.state.nextRunAt)) {
          scheduleTask(projectID, taskID, task.state.nextRunAt);
        }
        return;
      }
      if (isMissedRecurringSlot(task, nextRunAt, Date.now())) {
        try {
          await syncTaskSchedule(projectID, task);
        } catch (error) {
          logger.warn?.('[ScheduledTasks] failed to advance a missed recurring slot:', error);
        }
        return;
      }
      queueTaskRun(projectID, taskID, 'scheduled');
      pumpQueue();
    }, boundedDelay);

    timersByTaskKey.set(taskKey, timer);
  };

  const updateInMemoryTask = (projectID: string, nextTask: ScheduledTask | null): void => {
    if (!nextTask) {
      return;
    }
    const taskMap = tasksByProject.get(projectID);
    if (!taskMap) {
      return;
    }
    taskMap.set(nextTask.id, nextTask);
  };

  const syncTaskSchedule = async (projectID: string, task: ScheduledTask | null): Promise<ScheduledTask | null> => {
    if (!task) {
      return task;
    }
    if (task.runtime === 'agent') return task;
    const nextRunAt = task.schedule.kind === 'once' && task.onceAcceptance ? null : computeNextRunAt(task, Date.now());
    const statePatch = {
      nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
      updatedAt: Date.now(),
    };
    const result = await projectConfigRuntime.updateScheduledTaskState(projectID, task.id, statePatch);
    if (result.task) {
      updateInMemoryTask(projectID, result.task);
      if (started && result.task.enabled && typeof result.task.state.nextRunAt === 'number' && Number.isFinite(result.task.state.nextRunAt)) {
        scheduleTask(projectID, result.task.id, result.task.state.nextRunAt);
      }
      return result.task;
    }
    return task;
  };

  const ensureProjectPath = async (projectID: string): Promise<string | null> => {
    if (projectPathByID.has(projectID)) {
      return projectPathByID.get(projectID) || null;
    }

    try {
      const projects = await listProjects();
      const project = projects.find((item) => item?.id === projectID && item?.path);
      if (project?.path) {
        projectPathByID.set(projectID, project.path);
        return project.path;
      }
    } catch {
      // Missing project metadata makes the task temporarily unrunnable.
    }

    return null;
  };

  const synchronizeProject = async (projectID: string): Promise<ScheduledTask[]> => {
    let complete = true;
    const projectPath = await ensureProjectPath(projectID);

    let tasks = await projectConfigRuntime.listScheduledTasks(projectID);
    if (projectPath && typeof projectConfigRuntime.reconcileLoopTasks === 'function') {
      try {
        tasks = await projectConfigRuntime.reconcileLoopTasks(projectID, await discoverLoops(projectPath, { logger }));
      } catch (error) {
        // A discovery failure must not make existing scheduled tasks disappear
        // or prevent the task list from opening. Keep the last persisted state
        // and retry on the next sync.
        complete = false;
        logger.warn?.('[ScheduledTasks] failed to reconcile Markdown loops:', error);
      }
    }
    if (calendarOwner) {
      if (!complete) throw new Error('Calendar asset discovery failed; existing definitions were retained');
      tasks = await calendarOwner.sync(projectID, tasks);
      const settled = await projectConfigRuntime.settleCalendarHandoffs(projectID);
      tasks = tasks.map(task => {
        if (task.runtime === 'agent') return task;
        const current = settled.find(value => value.id === task.id);
        return current ?? task;
      });
    }
    const activeTasks = tasks.filter((task) => task.loopShadowed !== true);
    setProjectTasks(projectID, activeTasks);

    for (const task of activeTasks) {
      const nextTask = await syncTaskSchedule(projectID, task);
      if (nextTask) updateInMemoryTask(projectID, nextTask);
    }

    // Reconcile what this process cannot be running: a persisted `running`
    // status whose run never settled means the previous host died mid-run —
    // the worker went with it, so the task is interrupted, not still running.
    // And a one-time task whose only fire time passed while the host was down
    // catches up once here; recurring kinds skip missed slots and keep the
    // freshly computed nextRunAt.
    const nowMs = Date.now();
    for (const task of Array.from(tasksByProject.get(projectID)?.values() || [])) {
      if (task.runtime === 'agent') continue;
      const taskKey = buildTaskKey(projectID, task.id);
      const inFlight = runningTaskKeys.has(taskKey) || queuedTaskKeys.has(taskKey);
      if (task.state?.lastStatus === 'running' && !inFlight) {
        try {
          const result = await projectConfigRuntime.updateScheduledTaskState(projectID, task.id, {
            lastStatus: 'error',
            lastError: 'run interrupted — the host stopped before the session reached a terminal state',
            updatedAt: Date.now(),
          });
          if (result.task) updateInMemoryTask(projectID, result.task);
        } catch (error) {
          logger.warn?.('[ScheduledTasks] failed to reconcile interrupted run:', error);
        }
      }
      if (started && task.enabled && !inFlight && task.schedule?.kind === 'once' && !task.onceAcceptance && !task.pendingCalendarHandoff) {
        const dueAt = computeOnceDueAt(task.schedule, task.schedule.timezone);
        const lastRunAt = task.state?.lastRunAt;
        if (dueAt !== null && dueAt <= nowMs && (lastRunAt === undefined || lastRunAt < dueAt)) {
          queueTaskRun(projectID, task.id, 'scheduled');
        }
      }
    }
    pumpQueue();

    await refreshLoopWatchers();
    return Array.from(tasksByProject.get(projectID)?.values() || []);
  };

  const syncProject = (projectID: string): Promise<ScheduledTask[]> => {
    const previous = projectSyncs.get(projectID) ?? Promise.resolve([]);
    const work = previous.catch(() => []).then(() => synchronizeProject(projectID));
    projectSyncs.set(projectID, work);
    void work.finally(() => { if (projectSyncs.get(projectID) === work) projectSyncs.delete(projectID); }).catch(() => undefined);
    return work;
  };

  const syncAllProjects = async (): Promise<void> => {
    const projects = await listProjects();
    const activeProjectIDs = new Set<string>();
    projectPathByID.clear();
    for (const project of projects) {
      if (!project?.id || !project?.path) {
        continue;
      }
      activeProjectIDs.add(project.id);
      projectPathByID.set(project.id, project.path);
    }

    for (const existingProjectID of Array.from(tasksByProject.keys())) {
      if (!activeProjectIDs.has(existingProjectID)) {
        clearProjectTimers(existingProjectID);
        tasksByProject.delete(existingProjectID);
      }
    }

    const errors: unknown[] = [];
    try { await calendarOwner?.removeMissingProjects(activeProjectIDs); } catch (error) { errors.push(error); }
    for (const projectID of activeProjectIDs) {
      try { await syncProject(projectID); } catch (error) { errors.push(error); }
    }
    await refreshLoopWatchers();
    if (errors.length) throw new AggregateError(errors, 'Some calendar project assets require attention');
  };

  // Markdown loop files are an authority surface: edits must reach the
  // scheduler without someone opening the task list. Watch each discovered
  // loops directory (project ancestors + user scope) and resync debounced.
  const loopWatchers = new Map<string, ReturnType<typeof watch>>();
  let loopResyncTimer: ReturnType<typeof setTimeout> | undefined;

  const onLoopDirectoryEvent = (): void => {
    if (!started) return;
    if (loopResyncTimer) clearTimeout(loopResyncTimer);
    loopResyncTimer = setTimeout(() => {
      loopResyncTimer = undefined;
      void syncAllProjects().catch((error) => {
        logger.warn?.('[ScheduledTasks] Markdown loop resync failed:', error);
      });
    }, 250);
  };

  const refreshLoopWatchers = async (): Promise<void> => {
    if (!started) return;
    const wanted = new Set<string>();
    for (const projectPath of projectPathByID.values()) {
      for (const entry of await loopDirectoriesFor(projectPath)) {
        wanted.add(entry.directory);
        // Watching the .agents parent also catches the loops directory being
        // created for the first time. Watching its parent catches the first
        // creation of .agents itself; both missing directories cannot otherwise
        // produce an fs.watch event.
        const agentsDirectory = pathDirname(entry.directory);
        wanted.add(agentsDirectory);
        wanted.add(pathDirname(agentsDirectory));
      }
    }
    for (const [directory, watcher] of loopWatchers) {
      if (!wanted.has(directory)) {
        watcher.close();
        loopWatchers.delete(directory);
      }
    }
    for (const directory of wanted) {
      if (loopWatchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, onLoopDirectoryEvent);
        watcher.on('error', () => {
          watcher.close();
          loopWatchers.delete(directory);
        });
        loopWatchers.set(directory, watcher);
      } catch {
        // Directory does not exist yet; a later sync retries.
      }
    }
  };

  const queueTaskRun = (
    projectID: string,
    taskID: string,
    reason: RunReason,
    resolve?: (result: ScheduledTaskRunResult) => void,
  ): boolean => {
    const taskKey = buildTaskKey(projectID, taskID);
    if (queuedTaskKeys.has(taskKey) || runningTaskKeys.has(taskKey)) {
      return false;
    }
    queuedTaskKeys.add(taskKey);
    queue.push({ projectID, taskID, reason, ...(resolve ? { resolve } : {}) });
    return true;
  };

  const canRunTask = (projectID: string): boolean => {
    if (runningGlobalCount >= maxGlobalConcurrency) {
      return false;
    }
    const projectRunning = runningCountByProject.get(projectID) || 0;
    return projectRunning < maxProjectConcurrency;
  };

  const executeScheduledTask = async (projectID: string, task: ScheduledTask, reason: RunReason, acceptedAtMs: number) => {
    const startedAt = Date.now();
    const title = formatScheduledSessionTitle(task, startedAt);
    const projectPath = projectPathByID.get(projectID);
    if (!projectPath) {
      throw new Error('project path is unavailable');
    }

    if (typeof executeTask !== 'function') {
      throw new Error('Pi scheduled task executor is unavailable');
    }

    const result = await executeTask({
      projectID,
      projectPath,
      reason,
      startedAt,
      task,
      title,
      onSessionCreated: (sessionID: string) => {
        // Persist the session identity as soon as it exists — an interrupted
        // run keeps a traceable session pointer instead of losing it.
        void projectConfigRuntime.updateScheduledTaskState(projectID, task.id, {
          lastSessionId: sessionID,
          updatedAt: Date.now(),
        }, { kind: 'settle', task, acceptedAtMs }).then((patchResult) => {
          if (patchResult.task) updateInMemoryTask(projectID, patchResult.task);
        }).catch((error) => {
          logger.warn?.('[ScheduledTasks] failed to persist run session id:', error);
        });
        try {
          emitTaskRunEvent?.({
            projectID,
            taskID: task.id,
            ranAt: startedAt,
            status: 'running',
            sessionID,
          });
        } catch {
          // Event delivery must not fail the scheduled execution itself.
        }
      },
    });
    const sessionID = result?.sessionID;
    if (!sessionID) throw new Error('Pi scheduled task executor did not return a session ID');

    const finishedAt = Date.now();
    return {
      sessionID,
      durationMs: Math.max(0, finishedAt - startedAt),
      reason,
      startedAt,
      finishedAt,
    };
  };

  const runTask = async (projectID: string, taskID: string, reason: RunReason): Promise<ScheduledTaskRunResult> => {
    const taskMap = tasksByProject.get(projectID);
    const task = taskMap?.get(taskID);
    if (!task || task.runtime === 'agent' || (reason === 'scheduled' && !task.enabled)) {
      return { ok: false, skipped: true };
    }

    const taskKey = buildTaskKey(projectID, taskID);
    if (runningTaskKeys.has(taskKey)) {
      return { ok: false, running: true };
    }

    runningTaskKeys.add(taskKey);
    const runGeneration = lifecycleGeneration;
    runningGlobalCount += 1;
    runningCountByProject.set(projectID, (runningCountByProject.get(projectID) || 0) + 1);

    try {
      // Reserve the original Pi owner before awaiting a native query. A concurrent asset
      // switch then keeps the new calendar generation held until this owner truly settles.
      if (calendarOwner && await calendarOwner.hasActiveWork(projectID, taskID)) return { ok: false, running: true, error: 'An earlier Agent occurrence is still active' };
      if (tasksByProject.get(projectID)?.get(taskID)?.runtime === 'agent') return { ok: false, skipped: true };
      const runStartedAt = Date.now();
      const admission = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, {
        lastRunAt: runStartedAt,
        lastStatus: 'running',
        lastError: undefined,
        updatedAt: runStartedAt,
      }, { kind: 'admit', task, scheduled: reason === 'scheduled' });
      if (!admission.task) return { ok: false, skipped: true };
      updateInMemoryTask(projectID, admission.task);

      let status: 'error' | 'success' = 'success';
      let sessionID: string | undefined;
      let durationMs = 0;
      let errorMessage: string | undefined;

      try {
        // The executor observes the real Pi session/Goal terminal state. Releasing
        // the scheduler slot on an arbitrary wall-clock watchdog would permit a
        // second run while the first session is still doing legitimate work.
        const result = await executeScheduledTask(projectID, admission.task, reason, runStartedAt);
        sessionID = result.sessionID;
        durationMs = result.durationMs;
        status = 'success';
        logger.info?.(
          '[ScheduledTasks] run completed',
          { projectID, taskID, status, reason, sessionID, durationMs }
        );
      } catch (error) {
        status = 'error';
        if (error && typeof error === 'object' && 'sessionID' in error && typeof error.sessionID === 'string') sessionID = error.sessionID;
        errorMessage = safeErrorMessage(error);
        logger.warn?.('[ScheduledTasks] run failed', {
          projectID,
          taskID,
          reason,
          status,
          error: errorMessage,
        });
      }

      const finishedAt = Date.now();
      if (!durationMs) {
        durationMs = Math.max(0, finishedAt - runStartedAt);
      }
      const consumeOnce = task.schedule.kind === 'once' && reason === 'scheduled';
      const latestTask = tasksByProject.get(projectID)?.get(taskID) || task;
      const nextRunAt = computeNextRunAt(consumeOnce ? { ...task, enabled: false } : latestTask, finishedAt);

      const statePatch = {
        lastStatus: status,
        lastDurationMs: durationMs,
        lastError: status === 'error' ? errorMessage : undefined,
        lastSessionId: sessionID,
        nextRunAt: Number.isFinite(nextRunAt) ? nextRunAt : undefined,
        updatedAt: finishedAt,
      };

      // A late Pi completion can settle only its own original accepted asset intent.
      // Owner/definition changes remain untouched, including their enablement.
      const stateResult = await projectConfigRuntime.updateScheduledTaskState(projectID, taskID, statePatch,
        { kind: 'settle', task, acceptedAtMs: runStartedAt, consumeOnce });
      if (stateResult.task) {
        updateInMemoryTask(projectID, stateResult.task);
        if (
          started
          && runGeneration === lifecycleGeneration
          && stateResult.task.enabled
          && typeof stateResult.task.state.nextRunAt === 'number'
          && Number.isFinite(stateResult.task.state.nextRunAt)
        ) {
          scheduleTask(projectID, taskID, stateResult.task.state.nextRunAt);
        }
      }

      try {
        emitTaskRunEvent?.({
          projectID,
          taskID,
          ranAt: finishedAt,
          status,
          ...(sessionID ? { sessionID } : {}),
        });
      } catch {
        // Event delivery must not alter the persisted run result.
      }

      return {
        ok: status === 'success',
        status,
        sessionID,
        task: stateResult.task || null,
        error: errorMessage,
      };
    } finally {
      // Persistence/event failures must not permanently consume scheduler
      // admission after the underlying execution has ended or failed to start.
      runningTaskKeys.delete(taskKey);
      runningGlobalCount = Math.max(0, runningGlobalCount - 1);
      const nextProjectCount = Math.max(0, (runningCountByProject.get(projectID) || 1) - 1);
      if (nextProjectCount === 0) {
        runningCountByProject.delete(projectID);
      } else {
        runningCountByProject.set(projectID, nextProjectCount);
      }
      if (calendarOwner && started) void syncProject(projectID).catch(error => logger.warn?.('[ScheduledTasks] owner transition sync failed:', error));
    }
  };

  const pumpQueue = (): void => {
    let consumed = false;
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (!item) continue;
      if (!started && item.reason === 'scheduled') continue;
      if (!canRunTask(item.projectID)) {
        continue;
      }

      queue.splice(index, 1);
      index -= 1;

      const taskKey = buildTaskKey(item.projectID, item.taskID);
      queuedTaskKeys.delete(taskKey);
      consumed = true;

      void runTask(item.projectID, item.taskID, item.reason)
        .then((result) => item.resolve?.(result))
        .catch((error) => item.resolve?.({ ok: false, status: 'error', error: safeErrorMessage(error) }))
        .finally(() => {
          pumpQueue();
        });
    }

    if (!consumed && queue.length > 0) {
      return;
    }
  };

  const runNow = async (projectID: string, taskID: string): Promise<ScheduledTaskRunResult> => {
    const taskKey = buildTaskKey(projectID, taskID);
    if (runningTaskKeys.has(taskKey)) {
      return {
        ok: false,
        running: true,
        error: 'task is already running',
      };
    }
    if (queuedTaskKeys.has(taskKey)) {
      return {
        ok: false,
        queued: true,
        error: 'task is already queued',
      };
    }

    const task = tasksByProject.get(projectID)?.get(taskID);
    if (!task) return { ok: false, skipped: true };

    return new Promise<ScheduledTaskRunResult>((resolve) => {
      if (!queueTaskRun(projectID, taskID, 'manual', resolve)) {
        resolve({ ok: false, queued: true, error: 'task is already queued' });
        return;
      }
      pumpQueue();
    });
  };

  const start = async (): Promise<void> => {
    if (started) {
      return;
    }
    lifecycleGeneration += 1;
    started = true;
    try {
      if (calendarOwner) await calendarOwner.start(syncAllProjects);
      else await syncAllProjects();
    } catch (error) {
      stop();
      throw error;
    }
  };

  const stop = (): void => {
    if (!started) {
      return;
    }
    lifecycleGeneration += 1;
    started = false;
    calendarOwner?.stop();
    for (const timer of timersByTaskKey.values()) {
      clearTimeout(timer);
    }
    timersByTaskKey.clear();
    for (const watcher of loopWatchers.values()) {
      watcher.close();
    }
    loopWatchers.clear();
    if (loopResyncTimer) {
      clearTimeout(loopResyncTimer);
      loopResyncTimer = undefined;
    }
    for (const item of queue) {
      item.resolve?.({ ok: false, skipped: true, error: 'scheduled task runtime stopped before the run started' });
    }
    queuedTaskKeys.clear();
    queue.length = 0;
  };

  const getStatus = async () => {
    let enabledCount = 0;
    for (const taskMap of tasksByProject.values()) {
      for (const task of taskMap.values()) {
        if (task?.enabled && task.runtime !== 'agent') {
          enabledCount += 1;
        }
      }
    }

    const native = await calendarOwner?.status();
    enabledCount += native?.enabled ?? 0;
    const runningCount = runningTaskKeys.size + (native?.running ?? 0);
    return {
      hasEnabledScheduledTasks: enabledCount > 0,
      hasRunningScheduledTasks: runningCount > 0,
      enabledScheduledTasksCount: enabledCount,
      runningScheduledTasksCount: runningCount,
    };
  };

  const getProjectStatus = async (projectID: string) => {
    let enabledCount = 0;
    const tasks = tasksByProject.get(projectID);
    for (const task of tasks?.values() ?? []) {
      if (task.enabled && task.runtime !== 'agent') enabledCount += 1;
    }
    const native = await calendarOwner?.status(projectID);
    enabledCount += native?.enabled ?? 0;
    const runningCount = (runningCountByProject.get(projectID) ?? 0) + (native?.running ?? 0);
    return {
      hasEnabledScheduledTasks: enabledCount > 0,
      hasRunningScheduledTasks: runningCount > 0,
      enabledScheduledTasksCount: enabledCount,
      runningScheduledTasksCount: runningCount,
    };
  };

  const setExecutor = (nextExecutor: TaskExecutor): void => {
    executeTask = nextExecutor;
  };

  return {
    start,
    stop,
    syncAllProjects,
    syncProject,
    runNow,
    setExecutor,
    setCalendarOwner(owner: CalendarOwner) { if (calendarOwner) throw new Error('Calendar owner already installed'); calendarOwner = owner;
      projectConfigRuntime.setCalendarHandoffReader({ capture: (project, task) => owner.captureOnceHandoff(project, task), settle: (project, handoff) => owner.settleOnceHandoff(project, handoff) }); },
    calendarOwner: () => calendarOwner,
    hasPiWork: (projectID: string, taskID: string) => runningTaskKeys.has(buildTaskKey(projectID, taskID)),
    getStatus,
    getProjectStatus,
  };
};
