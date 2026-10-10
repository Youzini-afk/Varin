import crypto from 'node:crypto';
import fsPromisesDefault from 'node:fs/promises';
import osDefault from 'node:os';
import pathDefault from 'node:path';
import YAML from 'yaml';
import { CronExpressionParser } from 'cron-parser';
import { IANAZone } from 'luxon';
import { resolveWorktreeTopLevel } from '../git/service.js';
import { normalizeCalendarTarget, type ScheduledTaskExecution } from '../projects/project-config.js';
import type { CalendarTarget, CalendarMissedPolicy, ThinkingLevel } from '@varin/protocol';

const LOOP_DIRECTORY = 'loops';
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export interface LoopDefinition {
  runtime?: 'pi' | 'agent';
  target?: CalendarTarget;
  missedPolicy?: CalendarMissedPolicy;
  enabled: boolean;
  execution: ScheduledTaskExecution;
  name: string;
  schedule: { cron: string; kind: 'cron'; timezone?: string };
}

export interface ParsedLoopContent {
  definition: LoopDefinition | null;
  error: string | null;
  name: string | null;
}

export interface DiscoveredLoop extends ParsedLoopContent {
  filePath: string;
  revision: string;
  scope: 'project' | 'user';
}

type FsPromises = typeof fsPromisesDefault;
type PathModule = typeof pathDefault;

const loopFileLocks = new Map<string, Promise<void>>();

const loopFileLockKey = (filePath: string, path: PathModule): string => {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export const withLoopFileLock = async <Result>(
  filePath: string,
  operation: () => Promise<Result>,
  { path = pathDefault }: { path?: PathModule } = {},
): Promise<Result> => {
  const key = loopFileLockKey(filePath, path);
  const previous = loopFileLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chained = previous.finally(() => current);
  loopFileLocks.set(key, chained);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (loopFileLocks.get(key) === chained) loopFileLocks.delete(key);
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const errorCode = (error: unknown): string | null => {
  const record = asRecord(error);
  return typeof record?.code === 'string' ? record.code : null;
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const splitProviderModel = (value: unknown): { modelID: string; providerID: string } | null => {
  const raw = asNonEmptyString(value);
  const separator = raw?.indexOf('/') ?? -1;
  if (!raw || separator <= 0 || separator === raw.length - 1) return null;
  const providerID = raw.slice(0, separator).trim();
  const modelID = raw.slice(separator + 1).trim();
  return providerID && modelID ? { providerID, modelID } : null;
};

const bestEffortFrontmatterName = (raw: unknown): string | null => {
  const match = String(raw || '').match(/^\s*name\s*:\s*(.+?)\s*$/m);
  if (!match) return null;
  const value = match[1]?.trim() ?? '';
  if (!value || value === '|' || value === '>') return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return asNonEmptyString(value.slice(1, -1));
  }
  return asNonEmptyString(value.replace(/\s+#.*$/, ''));
};

type MarkdownParts =
  | { error: string; ok: false }
  | {
      bodyRaw: string;
      bom: string;
      eol: string;
      frontmatterRaw: string;
      ok: true;
      separator: string;
    };

const splitMarkdown = (content: unknown): MarkdownParts => {
  const raw = typeof content === 'string' ? content : '';
  const bom = raw.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const normalized = bom ? raw.slice(1) : raw;
  const match = normalized.match(/^---(\r?\n)([\s\S]*?)(\r?\n)---((?:\r?\n)?)([\s\S]*)$/);
  if (!match) {
    return { error: 'Loop file must start with YAML frontmatter', ok: false };
  }
  return {
    bom,
    bodyRaw: match[5] ?? '',
    eol: match[1] ?? '\n',
    frontmatterRaw: match[2] ?? '',
    separator: match[4] ?? '',
    ok: true,
  };
};

const parseFrontmatter = (raw: string) => {
  const document = YAML.parseDocument(raw, { keepSourceTokens: true });
  if (document.errors.length > 0) {
    throw document.errors[0];
  }
  const value = asRecord(document.toJS());
  if (!value) {
    throw new Error('Loop frontmatter must be a YAML object');
  }
  return { document, value };
};

export const parseLoopContent = (content: unknown): ParsedLoopContent => {
  const parts = splitMarkdown(content);
  if (!parts.ok) return { definition: null, error: parts.error, name: null };

  let frontmatter;
  try {
    frontmatter = parseFrontmatter(parts.frontmatterRaw).value;
  } catch (error) {
    return {
      definition: null,
      error: error instanceof Error ? error.message : 'Invalid YAML frontmatter',
      name: bestEffortFrontmatterName(parts.frontmatterRaw),
    };
  }

  const name = asNonEmptyString(frontmatter.name);
  if (!name) return { definition: null, error: 'Frontmatter "name" is required', name: null };

  const cron = asNonEmptyString(frontmatter.schedule);
  if (!cron) return { definition: null, error: 'Frontmatter "schedule" is required', name };

  const prompt = asNonEmptyString(parts.bodyRaw);
  if (!prompt) return { definition: null, error: 'The markdown body is required', name };

  if (frontmatter.runtime !== undefined && frontmatter.runtime !== 'pi' && frontmatter.runtime !== 'agent') return { definition: null, error: 'Frontmatter runtime is invalid', name };
  if (frontmatter.runtime === 'agent') {
    try {
      if (['model', 'thinking', 'agent', 'run_as_goal', 'goal_token_budget'].some(key => frontmatter[key] !== undefined)) throw new Error('Agent loops select model, source and Goal in target');
      if (frontmatter.enabled !== undefined && typeof frontmatter.enabled !== 'boolean') throw new Error('Frontmatter enabled must be a boolean');
      const timezone = asNonEmptyString(frontmatter.timezone);
      if (!timezone || !IANAZone.isValidZone(timezone)) throw new Error('Agent loops require an explicit IANA timezone');
      CronExpressionParser.parse(cron, { tz: timezone, currentDate: new Date() }).next();
      if (frontmatter.missed_policy !== undefined && frontmatter.missed_policy !== 'skip' && frontmatter.missed_policy !== 'coalesce_once') throw new Error('Frontmatter missed_policy is invalid');
      return { definition: { runtime: 'agent', target: normalizeCalendarTarget(frontmatter.target), name,
        enabled: frontmatter.enabled === true, execution: { prompt: parts.bodyRaw }, schedule: { kind: 'cron', cron, timezone },
        missedPolicy: frontmatter.missed_policy === 'coalesce_once' ? 'coalesce_once' : 'skip' }, error: null, name };
    } catch (error) { return { definition: null, error: error instanceof Error ? error.message : 'Invalid Agent loop', name }; }
  }

  const model = splitProviderModel(frontmatter.model);
  if (!model) {
    return { definition: null, error: 'Frontmatter "model" must be "provider/model"', name };
  }

  if (frontmatter.enabled !== undefined && typeof frontmatter.enabled !== 'boolean') {
    return { definition: null, error: 'Frontmatter "enabled" must be a boolean', name };
  }

  const timezone = frontmatter.timezone === undefined ? null : asNonEmptyString(frontmatter.timezone);
  if (frontmatter.timezone !== undefined && !timezone) {
    return { definition: null, error: 'Frontmatter "timezone" must be a non-empty string', name };
  }
  if (timezone && !IANAZone.isValidZone(timezone)) {
    return { definition: null, error: 'Frontmatter "timezone" must be a valid IANA timezone', name };
  }
  try {
    CronExpressionParser.parse(cron, { ...(timezone ? { tz: timezone } : {}), currentDate: new Date() }).next();
  } catch {
    return { definition: null, error: 'Frontmatter "schedule" must be a valid cron expression', name };
  }

  const agent = frontmatter.agent === undefined ? null : asNonEmptyString(frontmatter.agent);
  if (frontmatter.agent !== undefined && !agent) {
    return { definition: null, error: 'Frontmatter "agent" must be a non-empty string', name };
  }

  const thinking = frontmatter.thinking === undefined ? null : asNonEmptyString(frontmatter.thinking);
  if (thinking && !THINKING_LEVELS.has(thinking)) {
    return { definition: null, error: 'Frontmatter "thinking" is not supported by Pi', name };
  }
  if (frontmatter.thinking !== undefined && !thinking) {
    return { definition: null, error: 'Frontmatter "thinking" must be a non-empty string', name };
  }

  const runAsGoal = frontmatter.run_as_goal === true;
  if (frontmatter.run_as_goal !== undefined && typeof frontmatter.run_as_goal !== 'boolean') {
    return { definition: null, error: 'Frontmatter "run_as_goal" must be a boolean', name };
  }

  const goalTokenBudget = frontmatter.goal_token_budget;
  if (goalTokenBudget !== undefined) {
    if (!runAsGoal) {
      return { definition: null, error: 'Frontmatter "goal_token_budget" requires "run_as_goal: true"', name };
    }
    if (typeof goalTokenBudget !== 'number' || !Number.isSafeInteger(goalTokenBudget) || goalTokenBudget <= 0) {
      return { definition: null, error: 'Frontmatter "goal_token_budget" must be a positive integer', name };
    }
  }

  return {
    definition: {
      enabled: frontmatter.enabled === true,
      execution: {
        modelID: model.modelID,
        prompt,
        providerID: model.providerID,
        ...(agent ? { agent } : {}),
        ...(goalTokenBudget !== undefined ? { goalTokenBudget } : {}),
        ...(runAsGoal ? { runAsGoal: true } : {}),
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
      },
      name,
      schedule: {
        cron,
        kind: 'cron',
        ...(timezone ? { timezone } : {}),
      },
    },
    error: null,
    name,
  };
};

export const loopContentRevision = (content: unknown): string => (
  crypto.createHash('sha256').update(String(content ?? ''), 'utf8').digest('hex')
);

export const readLoopFile = async (filePath: string, { fsPromises = fsPromisesDefault }: {
  fsPromises?: Pick<FsPromises, 'readFile'>;
} = {}) => {
  const content = await fsPromises.readFile(filePath, 'utf8');
  return { content, revision: loopContentRevision(content) };
};

export class LoopRevisionConflictError extends Error {
  constructor() {
    super('Loop file changed since it was opened');
    this.name = 'LoopRevisionConflictError';
  }
}

const writeLoopFileUnlocked = async (
  filePath: string,
  content: string,
  { expectedRevision, fsPromises = fsPromisesDefault, path = pathDefault }: {
    expectedRevision?: string | undefined;
    fsPromises?: Pick<FsPromises, 'copyFile' | 'readFile' | 'rename' | 'unlink' | 'writeFile'>;
    path?: PathModule;
  } = {},
) => {
  const current = await readLoopFile(filePath, { fsPromises });
  if (expectedRevision && current.revision !== expectedRevision) {
    throw new LoopRevisionConflictError();
  }

  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  await fsPromises.writeFile(temporaryPath, content, 'utf8');
  try {
    const latest = await readLoopFile(filePath, { fsPromises });
    if (latest.revision !== current.revision) {
      throw new LoopRevisionConflictError();
    }
    try {
      await fsPromises.rename(temporaryPath, filePath);
    } catch (error) {
      const code = errorCode(error);
      const windowsReplaceFailure = process.platform === 'win32'
        && (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY' || code === 'EEXIST');
      if (!windowsReplaceFailure) throw error;
      // Windows may deny replacing an open file even after the revision check.
      // Copying the fully written temp file avoids truncating the target first.
      await fsPromises.copyFile(temporaryPath, filePath);
      await fsPromises.unlink(temporaryPath).catch(() => {});
    }
  } catch (error) {
    await fsPromises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
  return { content, path: path.resolve(filePath), revision: loopContentRevision(content) };
};

export const writeLoopFile = async (
  filePath: string,
  content: string,
  options: {
    expectedRevision?: string | undefined;
    fsPromises?: Pick<FsPromises, 'copyFile' | 'readFile' | 'rename' | 'unlink' | 'writeFile'>;
    path?: PathModule;
  } = {},
) => withLoopFileLock(
  filePath,
  () => writeLoopFileUnlocked(filePath, content, options),
  options.path ? { path: options.path } : {},
);

export const setLoopFileEnabled = async (
  filePath: string,
  enabled: unknown,
  { expectedRevision, fsPromises = fsPromisesDefault, path = pathDefault }: {
    expectedRevision?: string | undefined;
    fsPromises?: Pick<FsPromises, 'copyFile' | 'readFile' | 'rename' | 'unlink' | 'writeFile'>;
    path?: PathModule;
  } = {},
) => {
  return withLoopFileLock(filePath, async () => {
    const current = await readLoopFile(filePath, { fsPromises });
    const parsed = parseLoopContent(current.content);
    if (!parsed.definition) throw new Error(parsed.error || 'Loop file is invalid');

    const parts = splitMarkdown(current.content);
    if (!parts.ok) throw new Error(parts.error);
    const { document } = parseFrontmatter(parts.frontmatterRaw);
    document.set('enabled', Boolean(enabled));
    const nextFrontmatter = document.toString({ lineWidth: 0 }).replace(/\r?\n$/, '').replace(/\r?\n/g, parts.eol);
    const nextContent = `${parts.bom}---${parts.eol}${nextFrontmatter}${parts.eol}---${parts.separator}${parts.bodyRaw}`;
    return writeLoopFileUnlocked(filePath, nextContent, {
      expectedRevision: expectedRevision || current.revision,
      fsPromises,
      path,
    });
  }, { path });
};

export const deleteLoopFile = async (
  filePath: string,
  { expectedRevision, fsPromises = fsPromisesDefault, path = pathDefault }: {
    expectedRevision?: string | undefined;
    fsPromises?: Pick<FsPromises, 'readFile' | 'unlink'>;
    path?: PathModule;
  } = {},
): Promise<void> => withLoopFileLock(filePath, async () => {
  const current = await readLoopFile(filePath, { fsPromises });
  if (expectedRevision && current.revision !== expectedRevision) {
    throw new LoopRevisionConflictError();
  }
  await fsPromises.unlink(filePath);
}, { path });

const walkLoopFiles = async (directory: string, { fsPromises, path }: {
  fsPromises: Pick<FsPromises, 'readdir' | 'realpath'>;
  path: PathModule;
}): Promise<string[]> => {
  let entries;
  try {
    entries = await fsPromises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return [];
    throw error;
  }
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(files.map(async (filePath) => fsPromises.realpath(filePath).catch(() => path.resolve(filePath))));
};

const ancestorDirectories = (startDirectory: string, stopDirectory: string, path: PathModule): string[] => {
  const start = path.resolve(startDirectory);
  const stop = path.resolve(stopDirectory || startDirectory);
  const relative = path.relative(stop, start);
  const boundedStop = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ? stop : start;
  const result: string[] = [];
  let current = start;
  while (true) {
    result.push(current);
    if (current === boundedStop) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return result;
};

export const loopDirectoriesFor = async (
  projectPath: string | null | undefined,
  {
    fsPromises = fsPromisesDefault,
    homeDirectory = osDefault.homedir(),
    path = pathDefault,
    resolveWorktreeRoot = async (directory) => (await resolveWorktreeTopLevel(directory)).root,
  }: {
    fsPromises?: Pick<FsPromises, 'realpath'>;
    homeDirectory?: string;
    path?: PathModule;
    resolveWorktreeRoot?: (directory: string) => Promise<string>;
  } = {},
): Promise<Array<{ directory: string; scope: 'project' | 'user' }>> => {
  const directories: Array<{ directory: string; scope: 'project' | 'user' }> = [];
  if (projectPath) {
    const projectDirectory = await fsPromises.realpath(projectPath).catch(() => path.resolve(projectPath));
    const discoveredWorktreeRoot = await resolveWorktreeRoot(projectDirectory).catch(() => projectDirectory);
    const worktreeRootCandidate = discoveredWorktreeRoot || projectDirectory;
    const worktreeRoot = await fsPromises.realpath(worktreeRootCandidate)
      .catch(() => path.resolve(worktreeRootCandidate));
    for (const ancestor of ancestorDirectories(projectDirectory, worktreeRoot || projectDirectory, path)) {
      directories.push({ directory: path.join(ancestor, '.agents', LOOP_DIRECTORY), scope: 'project' });
    }
  }
  directories.push({ directory: path.join(homeDirectory, '.agents', LOOP_DIRECTORY), scope: 'user' });
  return directories;
};

export const discoverLoopFiles = async (
  projectPath: string | null | undefined,
  options: {
    fsPromises?: Pick<FsPromises, 'readdir' | 'realpath'>;
    homeDirectory?: string;
    path?: PathModule;
    resolveWorktreeRoot?: (directory: string) => Promise<string>;
  } = {},
): Promise<Array<{ filePath: string; scope: 'project' | 'user' }>> => {
  const fsPromises = options.fsPromises ?? fsPromisesDefault;
  const path = options.path ?? pathDefault;
  const files: Array<{ filePath: string; scope: 'project' | 'user' }> = [];
  for (const { directory, scope } of await loopDirectoriesFor(projectPath, options)) {
    for (const filePath of await walkLoopFiles(directory, { fsPromises, path })) {
      files.push({ filePath, scope });
    }
  }
  return files;
};

export const discoverLoops = async (projectPath: string | null | undefined, options: {
  fsPromises?: FsPromises;
  homeDirectory?: string;
  logger?: Pick<Console, 'warn'>;
  path?: PathModule;
  resolveWorktreeRoot?: (directory: string) => Promise<string>;
} = {}): Promise<DiscoveredLoop[]> => {
  const fsPromises = options.fsPromises || fsPromisesDefault;
  const logger = options.logger || console;
  const loops: DiscoveredLoop[] = [];
  for (const entry of await discoverLoopFiles(projectPath, options)) {
    let content;
    try {
      content = await fsPromises.readFile(entry.filePath, 'utf8');
    } catch (error) {
      logger.warn?.(`[ScheduledTasks] failed to read loop ${entry.filePath}:`, error);
      loops.push({ ...entry, definition: null, error: 'Failed to read loop file', name: null, revision: '' });
      continue;
    }
    const parsed = parseLoopContent(content);
    if (!parsed.definition) {
      logger.warn?.(`[ScheduledTasks] ignored invalid loop ${entry.filePath}: ${parsed.error}`);
    }
    loops.push({
      ...entry,
      definition: parsed.definition,
      error: parsed.error,
      name: parsed.name,
      revision: loopContentRevision(content),
    });
  }
  return loops;
};
