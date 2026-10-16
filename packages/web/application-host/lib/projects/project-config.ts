import { THINKING_LEVELS as thinkingLevels } from '@varin/protocol';
import crypto from 'node:crypto';
import { DateTime, IANAZone } from 'luxon';
import { CronExpressionParser } from 'cron-parser';
import type fsPromisesModule from 'node:fs/promises';
import type pathModule from 'node:path';

const PROJECT_CONFIG_VERSION = 1;
const THINKING_LEVELS = new Set<string>(thinkingLevels);

import type { ScheduledTask, ScheduledTaskExecution, ScheduledTaskSchedule, ScheduledTaskState } from '@varin/application-client';
import type { CalendarSource, CalendarTarget, SourceResourceOwner } from '@varin/protocol';
export type { ScheduledTask, ScheduledTaskExecution, ScheduledTaskSchedule, ScheduledTaskState } from '@varin/application-client';

interface NormalizedLoopInput {
  definition: Record<string, unknown> | null;
  effectiveName: string | null;
  error: string | null;
  filePath: string;
  revision: string | null;
  scope: 'project' | 'user' | undefined;
}

interface ProjectConfig extends Record<string, unknown> {
  scheduledTasks: ScheduledTask[];
  version: number;
}

interface ProjectConfigRuntimeOptions {
  createTaskID?: () => string;
  fsPromises: typeof fsPromisesModule;
  path: typeof pathModule;
  projectsDirPath: string;
}

interface NormalizeTaskOptions {
  allowCreate: boolean;
  createId: () => string;
  existingTask: ScheduledTask | null;
  now: number;
  refreshUpdatedAt?: boolean;
  persisted?: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const LOOP_METADATA_FIELDS = [
  'loopFile',
  'loopScope',
  'loopRevision',
  'loopError',
  'loopShadowed',
] as const;

const mergeDefinedRecord = (
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
};

const errorCode = (error: unknown): string | null => {
  const record = asRecord(error);
  return typeof record?.code === 'string' ? record.code : null;
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeTimeValue = (value: unknown): string | null => {
  const time = asNonEmptyString(value);
  if (!time) {
    return null;
  }
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
    return null;
  }
  return time;
};

const normalizeDateValue = (value: unknown): string | null => {
  const date = asNonEmptyString(value);
  if (!date) {
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  const parsed = DateTime.fromISO(date, { zone: 'UTC' });
  if (!parsed.isValid || parsed.toFormat('yyyy-LL-dd') !== date) {
    return null;
  }
  return date;
};

const normalizeWeekdays = (value: unknown): number[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const unique = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry)) {
      return null;
    }
    if (entry < 0 || entry > 6) {
      return null;
    }
    unique.add(entry);
  }

  if (unique.size === 0) {
    return null;
  }

  return Array.from(unique).sort((a, b) => a - b);
};

const resolveScheduleTimes = (value: Record<string, unknown>, existingSchedule?: ScheduledTaskSchedule): string[] | null => {
  const times: string[] = [];

  if (Array.isArray(value?.times)) {
    for (const item of value.times) {
      const normalized = normalizeTimeValue(item);
      if (!normalized) {
        throw new Error('schedule.times must contain HH:mm values');
      }
      times.push(normalized);
    }
  }

  const singleTime = normalizeTimeValue(value?.time);
  if (singleTime) {
    times.push(singleTime);
  }

  if (times.length === 0 && Array.isArray(existingSchedule?.times)) {
    for (const item of existingSchedule.times) {
      const normalized = normalizeTimeValue(item);
      if (normalized) {
        times.push(normalized);
      }
    }
  }

  const uniqueSorted = Array.from(new Set(times)).sort((a, b) => a.localeCompare(b));
  if (uniqueSorted.length === 0) {
    return null;
  }
  return uniqueSorted;
};

const resolveDefaultTimezone = (): string => {
  const resolved = DateTime.local().zoneName;
  if (resolved && IANAZone.isValidZone(resolved)) {
    return resolved;
  }
  return 'UTC';
};

const normalizeTimezone = (value: unknown, fallback = resolveDefaultTimezone()): string | null => {
  const timezone = asNonEmptyString(value);
  if (!timezone) {
    return fallback;
  }
  return IANAZone.isValidZone(timezone) ? timezone : null;
};

const validateCronExpression = (expression: string, timezone: string): boolean => {
  try {
    const iterator = CronExpressionParser.parse(expression, {
      tz: timezone,
      currentDate: new Date(),
    });
    iterator.next();
    return true;
  } catch {
    return false;
  }
};

const normalizeSchedule = (value: unknown, existingSchedule?: ScheduledTaskSchedule): ScheduledTaskSchedule => {
  const source = asRecord(value);
  if (!source) {
    throw new Error('schedule is required');
  }

  const kind = asNonEmptyString(source.kind);
  if (kind !== 'daily' && kind !== 'weekly' && kind !== 'once' && kind !== 'cron') {
    throw new Error('schedule.kind must be daily, weekly, once, or cron');
  }

  const fallbackTimezone = existingSchedule?.timezone || resolveDefaultTimezone();
  const timezone = normalizeTimezone(source.timezone, fallbackTimezone);
  if (!timezone) {
    throw new Error('schedule.timezone must be a valid IANA timezone');
  }

  if (kind === 'daily') {
    const times = resolveScheduleTimes(source, existingSchedule);
    if (!times) {
      throw new Error('schedule.times must include at least one HH:mm value for daily schedule');
    }
    return { kind, times, timezone };
  }

  if (kind === 'weekly') {
    const times = resolveScheduleTimes(source, existingSchedule);
    if (!times) {
      throw new Error('schedule.times must include at least one HH:mm value for weekly schedule');
    }
    const weekdays = normalizeWeekdays(source.weekdays);
    if (!weekdays) {
      throw new Error('schedule.weekdays must include values from 0 to 6 for weekly schedule');
    }
    return { kind, times, weekdays, timezone };
  }

  if (kind === 'once') {
    const date = normalizeDateValue(source.date);
    if (!date) {
      throw new Error('schedule.date must be YYYY-MM-DD for once schedule');
    }

    const time = normalizeTimeValue(source.time);
    if (!time) {
      throw new Error('schedule.time must be HH:mm for once schedule');
    }

    return { kind, date, time, timezone };
  }

  const cron = asNonEmptyString(source.cron) || '';
  if (!cron) {
    throw new Error('schedule.cron is required for cron schedule');
  }

  if (!validateCronExpression(cron, timezone)) {
    throw new Error('schedule.cron is invalid');
  }

  return { kind, cron, timezone };
};

/** External assets without an explicit source retain their project-owned source intent. */
const normalizeCalendarSource = (value: unknown): CalendarSource => {
  if (value === undefined) return { kind: 'project' };
  const source = asRecord(value);
  if (source?.kind === 'project' && Object.keys(source).length === 1) return { kind: 'project' };
  if (source?.kind !== 'workspace' || Object.keys(source).some(key => !['kind', 'resourceOwner', 'workspaceId'].includes(key))
    || !asNonEmptyString(source.workspaceId)) throw new Error('task.target.source is invalid');
  const owner = asRecord(source.resourceOwner);
  let resourceOwner: SourceResourceOwner;
  if (owner?.kind === 'local' && Object.keys(owner).length === 1) resourceOwner = { kind: 'local' };
  else if (owner?.kind === 'managed_host' && Object.keys(owner).length === 4
    && ['hostId', 'connectionId', 'endpointIdentity'].every(key => asNonEmptyString(owner[key]))) {
    resourceOwner = { kind: 'managed_host', hostId: owner.hostId as string,
      connectionId: owner.connectionId as string, endpointIdentity: owner.endpointIdentity as string };
  } else throw new Error('task.target.source.resourceOwner is invalid');
  // Identity is opaque. Never replace a missing registration with a local path or normalize owner IDs.
  return { kind: 'workspace', resourceOwner, workspaceId: source.workspaceId as string };
};

/** Validate only declared selections. Host admission resolves real models, source and credentials. */
export const normalizeCalendarTarget = (value: unknown): CalendarTarget => {
  const target = asRecord(value);
  if (!target) throw new Error('task.target is required for runtime agent');
  if (target.kind === 'existing_work') {
    if (Object.keys(target).some(key => !['kind', 'threadId', 'branchId'].includes(key))) throw new Error('Existing work inherits its current model, source and Goal');
    const threadId = asNonEmptyString(target.threadId), branchId = asNonEmptyString(target.branchId);
    if (!threadId || !branchId) throw new Error('Existing work requires threadId and branchId');
    return { kind: 'existing_work', threadId, branchId };
  }
  if (target.kind !== 'new_work' || Object.keys(target).some(key => !['kind', 'model', 'source', 'sourceMode', 'goal'].includes(key))) throw new Error('task.target is invalid');
  if (!['fixed_branch', 'materialized', 'live_root'].includes(String(target.sourceMode))) throw new Error('task.target.sourceMode is required');
  const model = asRecord(target.model);
  const providerId = asNonEmptyString(model?.providerId), modelId = asNonEmptyString(model?.modelId);
  if (!model || !providerId || !modelId || Object.keys(model).some(key => !['providerId', 'modelId', 'thinkingLevel', 'temperature'].includes(key))) throw new Error('task.target.model requires a registered providerId and modelId');
  if (model.thinkingLevel !== undefined && !THINKING_LEVELS.has(String(model.thinkingLevel))) throw new Error('task.target.model.thinkingLevel is invalid');
  if (model.temperature !== undefined && (typeof model.temperature !== 'number' || !Number.isFinite(model.temperature) || model.temperature < 0)) throw new Error('task.target.model.temperature is invalid');
  let goal: Extract<CalendarTarget, { kind: 'new_work' }>['goal'] = null;
  if (target.goal !== null) {
    const requested = asRecord(target.goal);
    if (!requested || Object.keys(requested).some(key => key !== 'budget')) throw new Error('task.target.goal must be null or an explicit budget selection');
    if (requested.budget === null) goal = { budget: null };
    else {
      const budget = asRecord(requested.budget);
      if (!budget || Object.keys(budget).some(key => key !== 'maxOutputTokens') || typeof budget.maxOutputTokens !== 'number' || !Number.isSafeInteger(budget.maxOutputTokens) || budget.maxOutputTokens < 0) throw new Error('task.target.goal budget must be a non-negative token count');
      goal = { budget: { maxOutputTokens: budget.maxOutputTokens } };
    }
  }
  return { kind: 'new_work', source: normalizeCalendarSource(target.source), sourceMode: target.sourceMode as Extract<CalendarTarget, { kind: 'new_work' }>['sourceMode'], goal,
    model: { providerId, modelId, ...(typeof model.thinkingLevel === 'string' ? { thinkingLevel: model.thinkingLevel } : {}), ...(typeof model.temperature === 'number' ? { temperature: model.temperature } : {}) } };
};

const normalizeExecution = (value: unknown): ScheduledTaskExecution => {
  const source = asRecord(value);
  if (!source || !asNonEmptyString(source.prompt)) throw new Error('execution.prompt is required');
  if (Object.keys(source).some(key => key !== 'prompt')) {
    throw new Error('Unsupported execution fields; select model, source and Goal in target');
  }
  return { prompt: source.prompt as string };
};

const readTaskState = (value: unknown): ScheduledTaskState => {
  const source = asRecord(value);
  if (!source || !Number.isSafeInteger(source.createdAt) || Number(source.createdAt) < 0
    || !Number.isSafeInteger(source.updatedAt) || Number(source.updatedAt) < 0) {
    throw new Error('task.state requires createdAt and updatedAt timestamps');
  }
  if (Object.keys(source).some(key => key !== 'createdAt' && key !== 'updatedAt')) {
    throw new Error('Unsupported scheduled task state; execution facts belong to Calendar');
  }
  return { createdAt: Number(source.createdAt), updatedAt: Number(source.updatedAt) };
};

const normalizeTaskForStorage = (value: unknown, options: NormalizeTaskOptions): ScheduledTask => {
  const {
    now,
    createId,
    existingTask,
    allowCreate,
    refreshUpdatedAt = true,
    persisted = false,
  } = options;

  const source = asRecord(value);
  if (!source) {
    throw new Error('task is required');
  }

  // Missing runtime was the Pi format. Only a fresh GUI request may select the
  // native default; disk assets are never imported or reinterpreted implicitly.
  const runtime = source.runtime === undefined && !persisted && !existingTask ? 'agent' : source.runtime;
  if (runtime !== 'agent') throw new Error('Unsupported scheduled task runtime; expected runtime "agent"');
  if ('onceAcceptance' in source || 'pendingCalendarHandoff' in source) {
    throw new Error('Unsupported scheduled task owner-handoff fields');
  }
  const incomingId = asNonEmptyString(source.id);
  if (persisted && !incomingId) throw new Error('task.id is required');
  const existingId = asNonEmptyString(existingTask?.id);

  if (existingTask) {
    if (incomingId && incomingId !== existingId) {
      throw new Error('task.id is immutable');
    }
  }

  if (!existingTask && incomingId && !allowCreate) {
    throw new Error('task.id does not exist');
  }

  const id = existingId || incomingId || createId();
  const name = asNonEmptyString(source.name) || '';
  if (!name) {
    throw new Error('task.name is required');
  }

  if (source.enabled !== undefined && typeof source.enabled !== 'boolean'
    || persisted && source.enabled === undefined) throw new Error('task.enabled must be a boolean');
  const enabled = typeof source.enabled === 'boolean'
    ? source.enabled
    : (existingTask?.enabled ?? true);

  if (persisted && !asNonEmptyString(asRecord(source.schedule)?.timezone)) {
    throw new Error('schedule.timezone is required');
  }
  const schedule = normalizeSchedule(source.schedule, existingTask?.schedule);
  const target = normalizeCalendarTarget(source.target);
  if (source.missedPolicy !== undefined && source.missedPolicy !== 'skip' && source.missedPolicy !== 'coalesce_once') {
    throw new Error('task.missedPolicy is invalid');
  }
  const execution = normalizeExecution(source.execution);

  const nowMs = Math.max(0, Math.round(now));
  const baseState = existingTask?.state ?? (persisted ? readTaskState(source.state) : { createdAt: nowMs, updatedAt: nowMs });
  const state = { ...baseState, updatedAt: refreshUpdatedAt ? nowMs : baseState.updatedAt };

  const loopFile = asNonEmptyString(source.loopFile) ?? asNonEmptyString(existingTask?.loopFile);
  const loopScope = source.loopScope === 'project' || source.loopScope === 'user'
    ? source.loopScope
    : (existingTask?.loopScope === 'project' || existingTask?.loopScope === 'user' ? existingTask.loopScope : undefined);
  const loopRevision = asNonEmptyString(source.loopRevision) ?? asNonEmptyString(existingTask?.loopRevision);
  const loopError = asNonEmptyString(source.loopError);
  const loopShadowed = source.loopShadowed === true;

  return {
    id,
    name,
    enabled,
    schedule,
    execution,
    state,
    runtime,
    target,
    missedPolicy: source.missedPolicy === 'skip' ? 'skip' : source.missedPolicy === 'coalesce_once' ? 'coalesce_once' : schedule.kind === 'once' ? 'coalesce_once' : 'skip',
    ...(loopFile ? { loopFile } : {}),
    ...(loopScope ? { loopScope } : {}),
    ...(loopRevision ? { loopRevision } : {}),
    ...(loopError ? { loopError } : {}),
    ...(loopShadowed ? { loopShadowed: true } : {}),
  };
};

export const createProjectConfigRuntime = (deps: ProjectConfigRuntimeOptions) => {
  const {
    fsPromises,
    path,
    projectsDirPath,
    createTaskID,
  } = deps;

  const taskIDFactory = typeof createTaskID === 'function'
    ? createTaskID
    : (() => {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
      return `task_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    });

  const writeLocks = new Map<string, Promise<void>>();

  const sanitizeProjectID = (projectID: unknown): string => {
    const value = asNonEmptyString(projectID);
    if (!value) {
      throw new Error('projectId is required');
    }
    if (!/^[a-zA-Z0-9._:-]+$/.test(value)) {
      throw new Error('projectId contains unsupported characters');
    }
    return value;
  };

  const resolveProjectConfigPath = (projectID: unknown): string => {
    const safeProjectID = sanitizeProjectID(projectID);
    return path.join(projectsDirPath, `${safeProjectID}.json`);
  };

  const readRawProjectConfigFromDisk = async (projectID: unknown): Promise<Record<string, unknown>> => {
    const filePath = resolveProjectConfigPath(projectID);
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8');
      const config = asRecord(JSON.parse(raw) as unknown);
      if (!config) throw new Error('Project configuration must be an object');
      return config;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return {};
      }
      throw error;
    }
  };

  const readProjectConfigFromDisk = async (projectID: unknown): Promise<ProjectConfig> => {
    const parsed = await readRawProjectConfigFromDisk(projectID);
    if (parsed.version !== undefined && parsed.version !== PROJECT_CONFIG_VERSION) throw new Error('Unsupported project configuration version');
    if (parsed.scheduledTasks !== undefined && !Array.isArray(parsed.scheduledTasks)) throw new Error('Project scheduledTasks must be an array');
    const tasksRaw = Array.isArray(parsed.scheduledTasks) ? parsed.scheduledTasks : [];
    const now = Date.now();
    const scheduledTasks: ScheduledTask[] = [];
    for (const task of tasksRaw) {
      const normalized = normalizeTaskForStorage(task, {
        now,
        createId: taskIDFactory,
        existingTask: null,
        allowCreate: true,
        refreshUpdatedAt: false,
        persisted: true,
      });
      scheduledTasks.push(normalized);
    }
    return {
      version: PROJECT_CONFIG_VERSION,
      scheduledTasks,
    };
  };

  const writeProjectConfigToDisk = async (projectID: unknown, config: ProjectConfig): Promise<void> => {
    const filePath = resolveProjectConfigPath(projectID);
    const parentDirectory = path.dirname(filePath);
    const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const existing = await readRawProjectConfigFromDisk(projectID);
    const merged = {
      ...existing,
      version: PROJECT_CONFIG_VERSION,
      scheduledTasks: config.scheduledTasks,
    };

    await fsPromises.mkdir(parentDirectory, { recursive: true });
    await fsPromises.writeFile(temporaryPath, JSON.stringify(merged, null, 2), 'utf8');
    await fsPromises.rename(temporaryPath, filePath);
  };

  const withProjectWriteLock = async <Result>(projectID: unknown, mutate: () => Promise<Result>): Promise<Result> => {
    const key = sanitizeProjectID(projectID);
    const previous = writeLocks.get(key) || Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.finally(() => next);
    writeLocks.set(key, chained);

    await previous;
    try {
      return await mutate();
    } finally {
      release();
      const current = writeLocks.get(key);
      if (current === chained) {
        writeLocks.delete(key);
      }
    }
  };

  const listScheduledTasks = async (projectID: unknown): Promise<ScheduledTask[]> => {
    const config = await readProjectConfigFromDisk(projectID);
    return config.scheduledTasks;
  };

  const upsertScheduledTask = async (projectID: unknown, taskInput: unknown) => {
    return withProjectWriteLock(projectID, async () => {
      const now = Date.now();
      const current = await readProjectConfigFromDisk(projectID);
      const input = asRecord(taskInput);
      if (!input) throw new Error('task is required');
      for (const field of LOOP_METADATA_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(input, field)) {
          throw new Error('Loop metadata is managed by Varin');
        }
      }

      const incomingID = asNonEmptyString(input.id);
      const existingIndex = incomingID
        ? current.scheduledTasks.findIndex((task) => task.id === incomingID)
        : -1;
      const existingTask = existingIndex >= 0 ? current.scheduledTasks[existingIndex] ?? null : null;

      if (existingTask?.loopFile) {
        throw new Error('Loop tasks must be edited through their Markdown file');
      }

      const schedulePatch = input.schedule === undefined ? null : asRecord(input.schedule);
      if (input.schedule !== undefined && !schedulePatch) {
        throw new Error('schedule must be an object');
      }
      const executionPatch = input.execution === undefined ? null : asRecord(input.execution);
      if (input.execution !== undefined && !executionPatch) {
        throw new Error('execution must be an object');
      }

      // The public upsert contract is a partial patch for an existing JSON-owned
      // task. Merge only defined fields before normalization so validation sees
      // the complete candidate, while creation metadata remains Host-owned.
      const candidate = existingTask
        ? {
            ...mergeDefinedRecord(existingTask as unknown as Record<string, unknown>, input),
            schedule: input.schedule === undefined
              ? existingTask.schedule
              : mergeDefinedRecord(
                  existingTask.schedule as unknown as Record<string, unknown>,
                  schedulePatch ?? {},
                ),
            execution: input.execution === undefined
              ? existingTask.execution
              : mergeDefinedRecord(
                  existingTask.execution as unknown as Record<string, unknown>,
                  executionPatch ?? {},
                ),
            state: existingTask.state,
          }
        : input;

      const normalizedTask = normalizeTaskForStorage(candidate, {
        now,
        createId: taskIDFactory,
        existingTask,
        allowCreate: true,
      });

      const nextTasks = current.scheduledTasks.slice();
      const created = !existingTask;
      if (existingIndex >= 0) {
        nextTasks[existingIndex] = normalizedTask;
      } else {
        nextTasks.push(normalizedTask);
      }

      const nextConfig = {
        version: PROJECT_CONFIG_VERSION,
        scheduledTasks: nextTasks,
      };
      await writeProjectConfigToDisk(projectID, nextConfig);

      return {
        task: normalizedTask,
        tasks: nextTasks,
        created,
      };
    });
  };

  const deleteScheduledTask = async (projectID: unknown, taskID: unknown) => {
    return withProjectWriteLock(projectID, async () => {
      const normalizedTaskID = asNonEmptyString(taskID);
      if (!normalizedTaskID) {
        throw new Error('taskId is required');
      }

      const current = await readProjectConfigFromDisk(projectID);
      const nextTasks = current.scheduledTasks.filter((task) => task.id !== normalizedTaskID);
      const deleted = nextTasks.length !== current.scheduledTasks.length;

      if (deleted) {
        await writeProjectConfigToDisk(projectID, {
          version: PROJECT_CONFIG_VERSION,
          scheduledTasks: nextTasks,
        });
      }

      return {
        deleted,
        tasks: nextTasks,
      };
    });
  };

  const reconcileLoopTasks = async (projectID: unknown, loopsInput: unknown): Promise<ScheduledTask[]> => {
    return withProjectWriteLock(projectID, async () => {
      const current = await readProjectConfigFromDisk(projectID);
      if (!Array.isArray(loopsInput)) throw new Error('Loop discovery must be an array');
      const loops = loopsInput;
      const existingLoopTaskByPath = new Map(
        current.scheduledTasks
          .filter((task) => task.loopFile)
          .map((task) => [task.loopFile, task]),
      );
      const now = Date.now();
      const discoveredByPath = new Map<string, NormalizedLoopInput>();
      const selectedPathByName = new Map<string, string>();

      // Discovery is already ordered from highest to lowest precedence:
      // nearest project ancestor, then farther project ancestors, then user.
      // A malformed higher-precedence file still shadows a lower one by using
      // its last-good persisted name, so an edit error cannot start two loops.
      for (const rawLoop of loops) {
        const loop = asRecord(rawLoop);
        if (!loop) throw new Error('Loop discovery entry must be an object');
        let definition = asRecord(loop.definition);
        let error = asNonEmptyString(loop.error);
        const filePath = asNonEmptyString(loop.filePath);
        if (!filePath) throw new Error('Loop discovery entry requires filePath');
        if (discoveredByPath.has(filePath)) continue;
        const existing = existingLoopTaskByPath.get(filePath);
        const declaredName = asNonEmptyString(definition?.name);
        if (definition && !error) {
          try {
            if (definition.runtime !== 'agent') throw new Error('Unsupported loop runtime; expected explicit runtime "agent"');
            normalizeTaskForStorage({ ...definition, id: existing?.id ?? 'loop-validation' }, {
              now, createId: taskIDFactory, existingTask: existing ?? null, allowCreate: true, refreshUpdatedAt: false,
            });
          } catch (failure) {
            error = failure instanceof Error ? failure.message : 'Invalid loop definition';
          }
        }
        if (error || !definition) {
          definition = null;
          error ||= 'Invalid loop definition';
          if (!existing) throw new Error(`Invalid loop ${filePath}: ${error}`);
        }
        const effectiveName = declaredName
          || asNonEmptyString(loop.name)
          || asNonEmptyString(existing?.name);
        const scope = loop.scope === 'project' || loop.scope === 'user' ? loop.scope : undefined;
        const normalized: NormalizedLoopInput = {
          definition,
          effectiveName,
          error,
          filePath,
          revision: asNonEmptyString(loop.revision),
          ...(scope ? { scope } : { scope: undefined }),
        };
        discoveredByPath.set(filePath, normalized);
        if (effectiveName && !selectedPathByName.has(effectiveName)) {
          selectedPathByName.set(effectiveName, filePath);
        }
      }

      const nextTasks: ScheduledTask[] = [];
      const consumedPaths = new Set<string>();
      const existingIDs = new Set(current.scheduledTasks.map((task) => task.id));

      for (const task of current.scheduledTasks) {
        if (!task.loopFile) {
          nextTasks.push(task);
          continue;
        }

        const loop = discoveredByPath.get(task.loopFile);
        if (!loop) {
          // Only a genuinely removed file removes its runtime projection.
          continue;
        }

        // A loop file owns exactly one runtime projection. Older versions
        // could leave a duplicate row behind after a frontmatter rename; keep
        // the first persisted task (and therefore its runtime history) and
        // unschedule every later orphan for the same authoritative file.
        if (consumedPaths.has(task.loopFile)) continue;
        consumedPaths.add(task.loopFile);

        const selectedName = loop.effectiveName || task.name;
        const shadowed = Boolean(
          selectedName
          && selectedPathByName.get(selectedName) !== task.loopFile
        );
        if (!loop.definition || shadowed) {
          nextTasks.push(normalizeTaskForStorage({
            ...task,
            loopError: loop.error || undefined,
            loopFile: task.loopFile,
            loopRevision: loop.revision || task.loopRevision,
            loopScope: loop.scope || task.loopScope,
            loopShadowed: shadowed,
          }, {
            now,
            createId: taskIDFactory,
            existingTask: task,
            allowCreate: false,
            refreshUpdatedAt: false,
          }));
          continue;
        }

        nextTasks.push(normalizeTaskForStorage({
          ...task,
          ...loop.definition,
          runtime: loop.definition.runtime,
          target: loop.definition.target,
          missedPolicy: loop.definition.missedPolicy,
          execution: loop.definition.execution,
          loopError: undefined,
          loopFile: task.loopFile,
          loopRevision: loop.revision,
          loopScope: loop.scope,
          loopShadowed: false,
        }, {
          now,
          createId: taskIDFactory,
          existingTask: task,
          allowCreate: false,
          refreshUpdatedAt: false,
        }));
      }

      for (let index = 0; index < nextTasks.length; index += 1) {
        const task = nextTasks[index];
        if (!task) continue;
        if (!task.loopFile || task.loopShadowed || !task.name) continue;
        const selectedPath = selectedPathByName.get(task.name);
        if (!selectedPath || selectedPath === task.loopFile) continue;
        nextTasks[index] = normalizeTaskForStorage({
          ...task,
          loopShadowed: true,
        }, {
          now,
          createId: taskIDFactory,
          existingTask: task,
          allowCreate: false,
          refreshUpdatedAt: false,
        });
      }

      for (const loop of discoveredByPath.values()) {
        if (consumedPaths.has(loop.filePath) || !loop.definition) continue;
        const shadowed = !loop.effectiveName || selectedPathByName.get(loop.effectiveName) !== loop.filePath;
        if (shadowed) continue;

        let id = `loop:${crypto.createHash('sha256').update(path.resolve(loop.filePath), 'utf8').digest('hex')}`;
        if (existingIDs.has(id)) id = taskIDFactory();
        existingIDs.add(id);
        nextTasks.push(normalizeTaskForStorage({
          ...loop.definition,
          id,
          loopFile: loop.filePath,
          loopRevision: loop.revision,
          loopScope: loop.scope,
        }, {
          now,
          createId: taskIDFactory,
          existingTask: null,
          allowCreate: true,
          refreshUpdatedAt: false,
        }));
      }

      if (JSON.stringify(nextTasks) !== JSON.stringify(current.scheduledTasks)) {
        if (nextTasks.length === 0 && current.scheduledTasks.every((task) => task.loopFile)) {
          const raw = await readRawProjectConfigFromDisk(projectID);
          const hasOtherState = Object.keys(raw).some((key) => key !== 'version' && key !== 'scheduledTasks');
          if (!hasOtherState) {
            await fsPromises.unlink(resolveProjectConfigPath(projectID)).catch((error) => {
              if (errorCode(error) !== 'ENOENT') throw error;
            });
            return nextTasks;
          }
        }
        await writeProjectConfigToDisk(projectID, {
          version: PROJECT_CONFIG_VERSION,
          scheduledTasks: nextTasks,
        });
      }
      return nextTasks;
    });
  };

  return {
    listScheduledTasks,
    upsertScheduledTask,
    deleteScheduledTask,
    reconcileLoopTasks,
    resolveProjectConfigPath,
  };
};
