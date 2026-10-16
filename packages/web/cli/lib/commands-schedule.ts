import { THINKING_LEVELS } from '@varin/protocol';
import { TunnelCliError, EXIT_CODE } from './cli-errors.js';
import path from 'node:path';
import { resolveTargetPort } from './cli-api-target.js';
import { parseGoalTokenBudget } from './cli-goal.js';
import { commandKey, requestVarinApi } from './cli-runtime.js';
import {
  intro as clackIntro,
  outro as clackOutro,
  isJsonMode,
  isQuietMode,
  printJson,
  logStatus,
} from '../cli-output.js';
import { recordOf, type CliOptions } from './cli-types.js';

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const assertRequired = (value: unknown, flagName: string): string => {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    throw new TunnelCliError(`Missing required ${flagName}.`, EXIT_CODE.USAGE_ERROR);
  }
  return normalized;
};

const parseModel = (value: unknown): { modelId: string; providerId: string } => {
  const model = assertRequired(value, '--model');
  const slash = model.indexOf('/');
  if (slash <= 0 || slash === model.length - 1) {
    throw new TunnelCliError('--model must be in provider/model format.', EXIT_CODE.USAGE_ERROR);
  }
  return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
};

const parseThinkingLevel = (value: unknown): string | null => {
  const level = asNonEmptyString(value);
  if (!level) return null;
  if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
    throw new TunnelCliError('--thinking must be one of: off, minimal, low, medium, high, xhigh, max.', EXIT_CODE.USAGE_ERROR);
  }
  return level;
};

const parseWeekdays = (value: unknown): number[] => {
  const weekdays = assertRequired(value, '--weekly')
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10));
  if (weekdays.some((entry) => !Number.isInteger(entry) || entry < 0 || entry > 6)) {
    throw new TunnelCliError('--weekly must contain weekdays from 0 to 6.', EXIT_CODE.USAGE_ERROR);
  }
  return Array.from(new Set(weekdays)).sort((left, right) => left - right);
};

const buildSchedule = (input: CliOptions): Record<string, unknown> => {
  const daily = asNonEmptyString(input.daily);
  const weekly = asNonEmptyString(input.weekly);
  const once = asNonEmptyString(input.once);
  const cron = asNonEmptyString(input.cron);
  if ([daily, weekly, once, cron].filter(Boolean).length !== 1) {
    throw new TunnelCliError('Provide exactly one of --daily, --weekly, --once, or --cron.', EXIT_CODE.USAGE_ERROR);
  }
  const timezone = asNonEmptyString(input.timezone);
  if (daily) return { kind: 'daily', times: [daily], ...(timezone ? { timezone } : {}) };
  if (weekly) {
    const time = assertRequired(input.time, '--time');
    return { kind: 'weekly', weekdays: parseWeekdays(weekly), times: [time], ...(timezone ? { timezone } : {}) };
  }
  if (once) {
    const time = assertRequired(input.time, '--time');
    return { kind: 'once', date: once, time, ...(timezone ? { timezone } : {}) };
  }
  return { kind: 'cron', cron, ...(timezone ? { timezone } : {}) };
};

const buildScheduledTask = (input: CliOptions): Record<string, unknown> => {
  const budget = parseGoalTokenBudget(input);
  const thinkingLevel = parseThinkingLevel(input.thinking);
  const sourceMode = input.sourceMode ?? 'fixed_branch';
  if (!['fixed_branch', 'materialized', 'live_root'].includes(sourceMode)) throw new TunnelCliError('Invalid --source-mode.', EXIT_CODE.USAGE_ERROR);
  const existing = Boolean(input.thread || input.branch);
  if (existing && (input.model || input.thinking || input.sourceMode || input.goal)) throw new TunnelCliError('Existing work inherits its model, source, and goal; omit new-work options.', EXIT_CODE.USAGE_ERROR);
  return {
    runtime: 'agent',
    ...(input.task ? { id: input.task } : {}),
    name: assertRequired(input.name, '--name'),
    enabled: input.disabled !== true,
    schedule: buildSchedule(input),
    execution: { prompt: assertRequired(input.prompt, '--prompt') },
    target: existing
      ? { kind: 'existing_work', threadId: assertRequired(input.thread, '--thread'), branchId: assertRequired(input.branch, '--branch') }
      : { kind: 'new_work', model: { ...parseModel(input.model), ...(thinkingLevel ? { thinkingLevel } : {}) },
        source: { kind: 'project' }, sourceMode,
        goal: input.goal ? { budget: budget === undefined ? null : { maxOutputTokens: budget } } : null },
  };
};

const resolveProjectID = async (port: number, target: {
  directory?: string;
  projectId?: string;
}, options: CliOptions): Promise<string> => {
  const requestedProjectID = asNonEmptyString(target.projectId);
  if (requestedProjectID) return requestedProjectID;
  const directory = asNonEmptyString(target.directory);
  if (!directory) throw new TunnelCliError('Missing required --project or --dir.', EXIT_CODE.USAGE_ERROR);
  const settings = await requestVarinApi(port, '/api/config/settings', options);
  const resolved = path.resolve(directory);
  const project = (Array.isArray(settings?.projects) ? settings.projects : [])
    .map(recordOf)
    .find((entry) => typeof entry.path === 'string' && path.resolve(entry.path) === resolved);
  if (typeof project?.id !== 'string' || !project.id) throw new TunnelCliError(`No Varin project found for ${resolved}.`, EXIT_CODE.USAGE_ERROR);
  return project.id;
};

const formatGoal = (target: unknown): string => {
  const value = recordOf(recordOf(target).goal);
  if (!recordOf(target).goal) return 'goal:no';
  return typeof recordOf(value.budget).maxOutputTokens === 'number'
    ? `goal:yes budget:${recordOf(value.budget).maxOutputTokens}`
    : 'goal:yes';
};

const formatSchedule = (schedule: unknown): string => {
  const value = recordOf(schedule);
  if (value.kind === 'daily') return `daily ${Array.isArray(value.times) ? value.times.join(',') : ''}`.trim();
  if (value.kind === 'weekly') return `weekly days:${Array.isArray(value.weekdays) ? value.weekdays.join(',') : ''} time:${Array.isArray(value.times) ? value.times.join(',') : ''}`;
  if (value.kind === 'once') return `once ${String(value.date || '')} ${String(value.time || '')}`.trim();
  if (value.kind === 'cron') return `cron ${String(value.cron || '')}`.trim();
  return typeof value.kind === 'string' ? value.kind : 'unknown';
};

const outputTasks = (options: CliOptions, tasks: unknown): void => {
  const normalizedTasks = Array.isArray(tasks) ? tasks.map(recordOf) : [];
  if (isJsonMode(options)) {
    printJson({ tasks: normalizedTasks });
    return;
  }
  if (isQuietMode(options)) {
    for (const task of normalizedTasks) {
      const lastStatus = recordOf(task.state).lastStatus;
      process.stdout.write(`${String(task.id ?? '')} enabled:${task.enabled === false ? 'no' : 'yes'} ${formatGoal(task.target)} status:${typeof lastStatus === 'string' ? lastStatus : 'idle'} ${formatSchedule(task.schedule)} ${String(task.name ?? '')}\n`);
    }
    return;
  }

  clackIntro('Scheduled Tasks');
  if (normalizedTasks.length === 0) {
    logStatus('info', 'No scheduled tasks found');
    clackOutro('0 tasks');
    return;
  }
  for (const task of normalizedTasks) {
    const status = task.enabled === false ? 'warning' : 'success';
    const lastStatus = recordOf(task.state).lastStatus;
    const detail = `id: ${String(task.id ?? '')}; ${formatGoal(task.target)}; status: ${typeof lastStatus === 'string' ? lastStatus : 'idle'}; ${formatSchedule(task.schedule)}`;
    logStatus(status, String(task.name || task.id || 'unnamed task'), detail);
  }
  clackOutro(`${normalizedTasks.length} task(s)`);
};

async function scheduleCommand(options: CliOptions = {}, action = 'help'): Promise<void> {
  if (action === 'help') {
    process.stdout.write(`Varin Schedule Commands\n\nUSAGE:\n  varin schedule status [OPTIONS]\n  varin schedule list (--project <projectId> | --dir <path>) [OPTIONS]\n  varin schedule create (--project <projectId> | --dir <path>) --name <name> --prompt <prompt> --model <provider/model> (--daily <HH:mm> | --weekly <0,1,2> --time <HH:mm> | --once <YYYY-MM-DD> --time <HH:mm> | --cron <expr>) [OPTIONS]\n  varin schedule run (--project <projectId> | --dir <path>) --task <taskId> [OPTIONS]\n  varin schedule delete (--project <projectId> | --dir <path>) --task <taskId> [OPTIONS]\n  varin schedule enable (--project <projectId> | --dir <path>) --task <taskId> [OPTIONS]\n  varin schedule disable (--project <projectId> | --dir <path>) --task <taskId> [OPTIONS]\n\nOPTIONS:\n  --project <projectId>   Project id from varin projects\n  --dir <path>            Resolve project by directory\n  -p, --port <port>       Varin server port\n  --timezone <zone>       IANA timezone for created tasks\n  --thread <id> --branch <id> Target existing native work instead of --model\n  --source-mode <mode>    fixed_branch (default), materialized, or live_root\n  --thinking <level>      Model thinking level\n  --goal                  Treat the scheduled run as an end-to-end goal\n  --goal-token-budget <n> Goal token budget (1000-100000000; requires --goal)\n  --disabled              Create task disabled\n  --json                  Output machine-readable JSON\n  -q, --quiet             Print concise output\n`);
    return;
  }

  const port = await resolveTargetPort(options);
  const projectId = asNonEmptyString(options.project);
  const directory = asNonEmptyString(options.directory);
  const target = {
    ...(projectId ? { projectId } : {}),
    ...(directory ? { directory } : {}),
  };

  if (action === 'status') {
    const body = await requestVarinApi(port, '/api/varin/scheduled-tasks/status', options);
    if (isJsonMode(options)) {
      printJson(body || {});
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`enabled:${body?.enabledScheduledTasksCount ?? 0} running:${body?.runningScheduledTasksCount ?? 0}\n`);
      return;
    }
    clackIntro('Scheduled Task Status');
    logStatus(body?.hasEnabledScheduledTasks ? 'success' : 'info', `enabled: ${body?.enabledScheduledTasksCount ?? 0}`);
    logStatus(body?.hasRunningScheduledTasks ? 'success' : 'info', `running: ${body?.runningScheduledTasksCount ?? 0}`);
    clackOutro('status loaded');
    return;
  }

  if (action === 'list') {
    const projectID = await resolveProjectID(port, target, options);
    const body = await requestVarinApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, options);
    outputTasks(options, body?.tasks);
    return;
  }

  if (action === 'create') {
    const projectID = await resolveProjectID(port, target, options);
    const body = await requestVarinApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, {
      ...options,
      method: 'PUT',
      body: JSON.stringify({ task: buildScheduledTask(options) }),
    });
    if (isJsonMode(options)) {
      printJson({ task: body?.task, created: body?.created === true });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${String(recordOf(body.task).id ?? '')}\n`);
      return;
    }
    clackIntro('Scheduled Task Created');
    const createdTask = recordOf(body.task);
    logStatus('success', String(createdTask.name || options.name || 'scheduled task'), `id: ${String(createdTask.id || 'unknown')}; ${formatGoal(createdTask.target)}; ${formatSchedule(createdTask.schedule)}`);
    clackOutro('created');
    return;
  }

  if (action === 'run') {
    const taskID = assertRequired(options.task, '--task');
    const projectID = await resolveProjectID(port, target, options);
    const key = commandKey(options);
    const body = await requestVarinApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks/${encodeURIComponent(taskID)}/run`, {
      ...options,
      method: 'POST',
      body: JSON.stringify({ key }),
    });
    if (isJsonMode(options)) {
      printJson({ ...body, key });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${JSON.stringify({ key, occurrence: body.occurrence })}\n`);
      return;
    }
    clackIntro('Scheduled Task Run');
    logStatus('success', String(recordOf(body.task).name || taskID), `occurrence: ${String(recordOf(body.occurrence).id || 'unknown')}; request: ${key}`);
    clackOutro('started');
    return;
  }

  if (action === 'delete') {
    const taskID = assertRequired(options.task, '--task');
    const projectID = await resolveProjectID(port, target, options);
    const body = await requestVarinApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks/${encodeURIComponent(taskID)}`, {
      ...options,
      method: 'DELETE',
    });
    if (isJsonMode(options)) {
      printJson({ deleted: true, tasks: body?.tasks || [] });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`deleted ${taskID}\n`);
      return;
    }
    clackIntro('Scheduled Task Deleted');
    logStatus('success', `deleted ${taskID}`);
    clackOutro('deleted');
    return;
  }

  if (action === 'enable' || action === 'disable') {
    const taskID = assertRequired(options.task, '--task');
    const enabled = action === 'enable';
    const projectID = await resolveProjectID(port, target, options);
    const current = await requestVarinApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, options);
    const existing = (Array.isArray(current.tasks) ? current.tasks : []).map(recordOf).find((entry) => entry.id === taskID);
    if (!existing) throw new TunnelCliError(`Scheduled task not found: ${taskID}`, EXIT_CODE.USAGE_ERROR);
    const update = await requestVarinApi(port, `/api/projects/${encodeURIComponent(projectID)}/scheduled-tasks`, {
      ...options,
      method: 'PUT',
      body: JSON.stringify({ task: { ...existing, enabled } }),
    });
    if (isJsonMode(options)) {
      printJson({ task: update.task, enabled });
      return;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${taskID} enabled:${enabled ? 'yes' : 'no'}\n`);
      return;
    }
    clackIntro(enabled ? 'Scheduled Task Enabled' : 'Scheduled Task Disabled');
    logStatus('success', String(recordOf(update.task).name || taskID), `enabled: ${enabled ? 'yes' : 'no'}`);
    clackOutro(enabled ? 'enabled' : 'disabled');
    return;
  }

  throw new TunnelCliError(`Unknown schedule command '${action}'.`, EXIT_CODE.USAGE_ERROR);
}

export { scheduleCommand, formatGoal };
