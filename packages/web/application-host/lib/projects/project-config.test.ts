import { describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { createProjectConfigRuntime, normalizeCalendarTarget } from './project-config.js';
import type { ScheduledTask } from './project-config.js';

const nativeTarget = { kind: 'new_work', model: { providerId: 'provider', modelId: 'model' }, sourceMode: 'fixed_branch', goal: null } as const;

const requireTask = (task: ScheduledTask | undefined): ScheduledTask => {
  if (!task) throw new Error('Expected a scheduled task');
  return task;
};

const createRuntime = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-scheduled-project-config-'));
  const runtime = createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: tempRoot,
    createTaskID: () => 'task-fixed-id',
  });
  return {
    runtime,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
};

describe('project-config runtime', () => {
  it('creates and persists a scheduled task', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const result = await runtime.upsertScheduledTask('project-test', {
        name: 'Nightly digest',
        enabled: true,
        target: nativeTarget,
        schedule: {
          kind: 'daily',
          time: '09:30',
          timezone: 'UTC',
        },
        execution: {
          prompt: 'Summarize repository changes',
        },
      });

      expect(result.created).toBe(true);
      expect(result.task.id).toBe('task-fixed-id');
      const reloaded = await runtime.listScheduledTasks('project-test');
      expect(reloaded).toHaveLength(1);
      expect(requireTask(reloaded[0]).name).toBe('Nightly digest');
      expect(requireTask(reloaded[0]).schedule.timezone).toBe('UTC');
      expect(requireTask(reloaded[0]).schedule.times).toEqual(['09:30']);
    } finally {
      await cleanup();
    }
  });

  it('preserves long task definitions without silent truncation', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const name = 'n'.repeat(500);
      const prompt = 'p'.repeat(25_000);
      const result = await runtime.upsertScheduledTask('project-test', {
        name,
        enabled: true,
        runtime: 'agent',
        target: nativeTarget,
        schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
        execution: { prompt },
      });
      expect(result.task.name).toBe(name);
      expect(result.task.execution.prompt).toBe(prompt);
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid cron expressions', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await expect(runtime.upsertScheduledTask('project-test', {
        name: 'Invalid cron task',
        enabled: true,
        runtime: 'agent',
        target: nativeTarget,
        schedule: {
          kind: 'cron',
          cron: 'invalid cron',
          timezone: 'UTC',
        },
        execution: {
          prompt: 'Run checks',
        },
      })).rejects.toThrow('schedule.cron is invalid');
    } finally {
      await cleanup();
    }
  });

  it('preserves unknown project config keys when writing scheduled tasks', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const projectID = 'path_preserve';
      const filePath = path.join(runtime.resolveProjectConfigPath(projectID));
      await writeFile(
        filePath,
        JSON.stringify({
          projectNotes: 'hello notes',
          projectTodos: [{ id: 't1', text: 'buy milk', completed: false, createdAt: 1 }],
          projectActions: [{ id: 'a1', name: 'Run', command: 'bun run dev' }],
          projectActionsPrimaryId: 'a1',
          'setup-worktree': ['bun install'],
          projectPlanFiles: [{ id: 'p1', path: '/tmp/plans/p1.md', createdAt: 2 }],
          projectPath: '/tmp/demo',
        }, null, 2),
        'utf8',
      );

      await runtime.upsertScheduledTask(projectID, {
        name: 'nightly',
        enabled: true,
        runtime: 'agent',
        target: nativeTarget,
        schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
        execution: { prompt: 'run' },
      });

      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      expect(raw.projectNotes).toBe('hello notes');
      expect(raw.projectTodos).toEqual([{ id: 't1', text: 'buy milk', completed: false, createdAt: 1 }]);
      expect(raw.projectActions).toHaveLength(1);
      expect(raw.projectActionsPrimaryId).toBe('a1');
      expect(raw['setup-worktree']).toEqual(['bun install']);
      expect(raw.projectPlanFiles).toEqual([{ id: 'p1', path: '/tmp/plans/p1.md', createdAt: 2 }]);
      expect(raw.projectPath).toBe('/tmp/demo');
      expect(raw.scheduledTasks).toHaveLength(1);
      expect(raw.version).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('preserves scheduled task state timestamps when listing tasks', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const projectID = 'timestamp_preserve';
      const filePath = path.join(runtime.resolveProjectConfigPath(projectID));
      await writeFile(
        filePath,
        JSON.stringify({
          scheduledTasks: [{
            id: 'task-existing',
            name: 'nightly',
            enabled: true,
            runtime: 'agent',
            target: nativeTarget,
            schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
            execution: { prompt: 'run' },
            state: { createdAt: 10, updatedAt: 20 },
          }],
        }, null, 2),
        'utf8',
      );

      const first = await runtime.listScheduledTasks(projectID);
      const second = await runtime.listScheduledTasks(projectID);

      expect(requireTask(first[0]).state.createdAt).toBe(10);
      expect(requireTask(first[0]).state.updatedAt).toBe(20);
      expect(requireTask(second[0]).state.updatedAt).toBe(20);
    } finally {
      await cleanup();
    }
  });

  it('accepts one-time schedule with date and time', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const result = await runtime.upsertScheduledTask('project-test', {
        name: 'One-time review',
        enabled: true,
        runtime: 'agent',
        target: nativeTarget,
        schedule: {
          kind: 'once',
          date: '2026-04-20',
          time: '13:45',
          timezone: 'Europe/Kyiv',
        },
        execution: {
          prompt: 'Create a release summary',
        },
      });

      expect(result.task.schedule.kind).toBe('once');
      expect(result.task.schedule.date).toBe('2026-04-20');
      expect(result.task.schedule.time).toBe('13:45');
      expect(result.task.schedule.timezone).toBe('Europe/Kyiv');
    } finally {
      await cleanup();
    }
  });

  it('merges defined fields for an existing JSON task before validation', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const created = await runtime.upsertScheduledTask('project-test', {
        name: 'Original',
        enabled: false,
        runtime: 'agent',
        target: nativeTarget,
        schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
        execution: {
          prompt: 'original prompt',
        },
      });
      const patched = await runtime.upsertScheduledTask('project-test', {
        id: created.task.id,
        name: 'Renamed',
        schedule: { timezone: 'Asia/Shanghai' },
        execution: { prompt: 'updated prompt' },
      });

      expect(patched.created).toBe(false);
      expect(patched.task).toMatchObject({
        id: created.task.id,
        name: 'Renamed',
        enabled: false,
        runtime: 'agent',
        target: nativeTarget,
        schedule: { kind: 'daily', times: ['09:00'], timezone: 'Asia/Shanghai' },
        execution: {
          prompt: 'updated prompt',
        },
      });
      expect(patched.task.state.createdAt).toBe(created.task.state.createdAt);
      await expect(runtime.upsertScheduledTask('project-test', {
        id: created.task.id,
        runtime: 'agent',
        target: nativeTarget,
        schedule: [],
      })).rejects.toThrow(/schedule must be an object/i);
    } finally {
      await cleanup();
    }
  });

  it('rejects loop ownership metadata on the JSON upsert path', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await expect(runtime.upsertScheduledTask('project-test', {
        name: 'not-a-loop',
        enabled: true,
        runtime: 'agent',
        target: nativeTarget,
        schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
        execution: { prompt: 'run' },
        loopFile: '/repo/.agents/loops/injected.md',
      })).rejects.toThrow(/loop metadata/i);
    } finally {
      await cleanup();
    }
  });

  it('keeps JSON tasks separate and reconciles loops by file identity', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await runtime.upsertScheduledTask('project-test', {
        name: 'digest',
        enabled: true,
        runtime: 'agent',
        target: nativeTarget,
        schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
        execution: { prompt: 'json prompt' },
      });
      const loops = [{
        definition: {
          name: 'digest',
          enabled: true,
          runtime: 'agent',
          target: nativeTarget,
          schedule: { kind: 'cron', cron: '0 10 * * *', timezone: 'UTC' },
          execution: { prompt: 'loop prompt' },
        },
        filePath: '/repo/.agents/loops/digest.md',
        revision: 'rev-1',
        scope: 'project',
      }];
      const first = await runtime.reconcileLoopTasks('project-test', loops);
      expect(first).toHaveLength(2);
      expect(first.find((task) => !task.loopFile)?.execution.prompt).toBe('json prompt');
      const loopTask = requireTask(first.find((task) => task.loopFile));
      expect(loopTask.execution.prompt).toBe('loop prompt');

      const renamed = await runtime.reconcileLoopTasks('project-test', [{
        ...loops[0]!,
        definition: { ...loops[0]!.definition, name: 'renamed' },
        revision: 'rev-2',
      }]);
      expect(renamed).toHaveLength(2);
      expect(renamed.find((task) => task.loopFile)?.id).toBe(loopTask.id);
      expect(renamed.find((task) => task.loopFile)?.name).toBe('renamed');
    } finally {
      await cleanup();
    }
  });

  it('removes orphan duplicate projections owned by the same loop file', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const definition = {
        name: 'digest',
        enabled: true,
        runtime: 'agent',
        target: nativeTarget,
        schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
        execution: { prompt: 'run' },
      };
      const filePath = '/repo/.agents/loops/digest.md';
      const first = await runtime.reconcileLoopTasks('project-test', [{
        definition,
        filePath,
        revision: 'rev-1',
        scope: 'project',
      }]);
      const original = requireTask(first[0]);

      const configPath = runtime.resolveProjectConfigPath('project-test');
      const raw = JSON.parse(await readFile(configPath, 'utf8'));
      raw.scheduledTasks.push({ ...original, id: 'orphan-duplicate' });
      await writeFile(configPath, JSON.stringify(raw, null, 2), 'utf8');
      const reconciled = await runtime.reconcileLoopTasks('project-test', [{
        definition,
        filePath,
        revision: 'rev-2',
        scope: 'project',
      }]);

      expect(reconciled).toHaveLength(1);
      expect(requireTask(reconciled[0]).id).toBe(original.id);
      expect(requireTask(reconciled[0]).loopRevision).toBe('rev-2');
    } finally {
      await cleanup();
    }
  });

  it('keeps the last good loop projection while its file is malformed', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const valid = [{
        definition: {
          name: 'digest',
          enabled: true,
          runtime: 'agent',
          target: nativeTarget,
          schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
          execution: { prompt: 'run' },
        },
        filePath: '/repo/.agents/loops/digest.md',
        revision: 'rev-1',
        scope: 'project',
      }];
      const first = await runtime.reconcileLoopTasks('project-test', valid);
      const malformed = await runtime.reconcileLoopTasks('project-test', [{
        definition: null,
        error: 'Invalid YAML',
        filePath: valid[0]!.filePath,
        name: 'digest',
        revision: 'rev-bad',
        scope: 'project',
      }]);
      expect(malformed).toHaveLength(1);
      expect(requireTask(malformed[0]).id).toBe(requireTask(first[0]).id);
      expect(requireTask(malformed[0]).enabled).toBe(true);
      expect(requireTask(malformed[0]).loopError).toBe('Invalid YAML');
    } finally {
      await cleanup();
    }
  });

  it('disables a lower loop when a higher-precedence file with the same name appears', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const definition = {
        name: 'digest',
        enabled: true,
        runtime: 'agent',
        target: nativeTarget,
        schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
        execution: { prompt: 'run' },
      };
      await runtime.reconcileLoopTasks('project-test', [{
        definition,
        filePath: '/home/user/.agents/loops/digest.md',
        revision: 'user-rev',
        scope: 'user',
      }]);
      const tasks = await runtime.reconcileLoopTasks('project-test', [
        {
          definition,
          filePath: '/repo/.agents/loops/digest.md',
          revision: 'project-rev',
          scope: 'project',
        },
        {
          definition,
          filePath: '/home/user/.agents/loops/digest.md',
          revision: 'user-rev',
          scope: 'user',
        },
      ]);
      expect(tasks).toHaveLength(2);
      expect(tasks.find((task) => task.loopScope === 'project')).toMatchObject({ enabled: true });
      expect(tasks.find((task) => task.loopScope === 'user')).toMatchObject({ enabled: true, loopShadowed: true });
    } finally {
      await cleanup();
    }
  });
});

describe('Agent calendar source assets', () => {
  const newWork = { kind: 'new_work', model: { providerId: 'provider', modelId: 'model' }, sourceMode: 'fixed_branch', goal: null };

  it('normalizes only an omitted external source to the owning project and persists explicit registration identity', async () => {
    expect(normalizeCalendarTarget(newWork)).toEqual({ ...newWork, source: { kind: 'project' } });
    const { runtime, cleanup } = await createRuntime();
    try {
      const source = { kind: 'workspace', resourceOwner: { kind: 'managed_host', hostId: 'host-original', connectionId: 'connection-original', endpointIdentity: 'endpoint-original' }, workspaceId: 'registered:opaque-source' };
      await runtime.upsertScheduledTask('project-test', { name: 'Remote calendar', runtime: 'agent', enabled: false,
        schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, execution: { prompt: 'Review saved source' }, target: { ...newWork, source } });
      const saved = requireTask((await runtime.listScheduledTasks('project-test'))[0]);
      expect(saved.target).toEqual({ ...newWork, source });
      const raw = JSON.parse(await readFile(runtime.resolveProjectConfigPath('project-test'), 'utf8'));
      expect(raw.scheduledTasks[0].target.source).toEqual(source);
      delete raw.scheduledTasks[0].target.source;
      await writeFile(runtime.resolveProjectConfigPath('project-test'), JSON.stringify(raw));
      expect(requireTask((await runtime.listScheduledTasks('project-test'))[0]).target).toEqual({ ...newWork, source: { kind: 'project' } });
    } finally { await cleanup(); }
  });

  it('rejects malformed, credential-bearing, path-only and existing-work source overrides', () => {
    for (const source of [null, {}, { kind: 'project', workspaceId: 'extra' },
      { kind: 'workspace', path: '/not-a-registration', resourceOwner: { kind: 'local' } },
      { kind: 'workspace', workspaceId: ' ', resourceOwner: { kind: 'local' } },
      { kind: 'workspace', workspaceId: 'registered', resourceOwner: { kind: 'local', token: 'not-allowed' } },
      { kind: 'workspace', workspaceId: 'registered', resourceOwner: { kind: 'managed_host', hostId: 'host', connectionId: 'connection' } },
      { kind: 'workspace', workspaceId: 'registered', resourceOwner: { kind: 'managed_host', hostId: 'host', connectionId: 'connection', endpointIdentity: 'endpoint', token: 'not-allowed' } },
    ]) expect(() => normalizeCalendarTarget({ ...newWork, source })).toThrow('source');
    expect(() => normalizeCalendarTarget({ kind: 'existing_work', threadId: 'thread', branchId: 'branch', source: { kind: 'project' } })).toThrow('inherits');
    expect(normalizeCalendarTarget({ ...newWork, source: { kind: 'workspace', workspaceId: 'registered', resourceOwner: { kind: 'local' } } })).toMatchObject({ source: { kind: 'workspace', workspaceId: 'registered', resourceOwner: { kind: 'local' } } });
  });
});

describe('native calendar asset integrity', () => {
  const definition = {
    runtime: 'agent', name: 'review', enabled: true, target: nativeTarget,
    schedule: { kind: 'once', date: '2026-11-01', time: '01:30', timezone: 'America/New_York' },
    execution: { prompt: '  Keep the original instruction bytes.\n' },
  };
  const persisted = { ...definition, id: 'saved', state: { createdAt: 10, updatedAt: 20 } };

  it.each([
    ['absent runtime', { ...persisted, runtime: undefined }],
    ['Pi runtime', { ...persisted, runtime: 'pi' }],
    ['Pi loop projection', { ...persisted, runtime: 'pi', loopFile: '/repo/legacy.md' }],
    ['unknown runtime', { ...persisted, runtime: 'other' }],
    ['null runtime', { ...persisted, runtime: null }],
    ['missing target', { ...persisted, target: undefined }],
    ['old execution', { ...persisted, execution: { prompt: 'run', providerID: 'provider', modelID: 'model' } }],
    ['old execution state', { ...persisted, state: { createdAt: 10, updatedAt: 20, lastStatus: 'idle' } }],
    ['owner handoff', { ...persisted, pendingCalendarHandoff: { definitionId: 'previous', generation: 1 } }],
    ['once receipt', { ...persisted, onceAcceptance: { owner: 'pi', acceptanceId: 'previous', scheduledAtMs: 10, acceptedAtMs: 10 } }],
    ['missing id', { ...persisted, id: undefined }],
    ['missing state', { ...persisted, state: undefined }],
    ['missing timezone', { ...persisted, schedule: { kind: 'daily', times: ['09:00'] } }],
  ])('rejects %s without rewriting or deleting the original project asset', async (_name, task) => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const configPath = runtime.resolveProjectConfigPath('project-test');
      const original = JSON.stringify({ version: 1, scheduledTasks: [task], projectNotes: 'keep me' }, null, 3);
      await writeFile(configPath, original);
      for (const operation of [
        () => runtime.listScheduledTasks('project-test'),
        () => runtime.upsertScheduledTask('project-test', { ...definition, id: 'new' }),
        () => runtime.deleteScheduledTask('project-test', 'saved'),
        () => runtime.reconcileLoopTasks('project-test', []),
      ]) {
        await expect(operation()).rejects.toThrow();
        expect(await readFile(configPath, 'utf8')).toBe(original);
      }
    } finally { await cleanup(); }
  });

  it.each(['{', 'null', '[]', '{"scheduledTasks":null}', '{"scheduledTasks":{}}', '{"scheduledTasks":[null]}', '{"version":2,"scheduledTasks":[]}'])('never treats malformed project data as an empty calendar: %s', async content => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const configPath = runtime.resolveProjectConfigPath('project-test');
      await writeFile(configPath, content);
      await expect(runtime.listScheduledTasks('project-test')).rejects.toThrow();
      await expect(runtime.reconcileLoopTasks('project-test', [])).rejects.toThrow();
      expect(await readFile(configPath, 'utf8')).toBe(content);
    } finally { await cleanup(); }
  });

  it('preserves native once metadata and prompt bytes without persisting execution facts', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const created = await runtime.upsertScheduledTask('project-test', definition);
      expect(created.task.runtime).toBe('agent');
      expect(created.task.missedPolicy).toBe('coalesce_once');
      expect(created.task.schedule).toEqual(definition.schedule);
      expect(created.task.execution).toEqual(definition.execution);
      expect(Object.keys(created.task.state).sort()).toEqual(['createdAt', 'updatedAt']);
      const reread = await runtime.listScheduledTasks('project-test');
      expect(reread).toEqual([created.task]);
    } finally { await cleanup(); }
  });

  it.each([undefined, null, {}, [null], [{}]])('rejects malformed discovery instead of erasing saved loops: %s', async discovery => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await runtime.reconcileLoopTasks('project-test', [{ definition, filePath: '/repo/review.md', revision: 'first', scope: 'project' }]);
      const configPath = runtime.resolveProjectConfigPath('project-test');
      const original = await readFile(configPath, 'utf8');
      await expect(runtime.reconcileLoopTasks('project-test', discovery)).rejects.toThrow();
      expect(await readFile(configPath, 'utf8')).toBe(original);
    } finally { await cleanup(); }
  });

  it('reports a newly discovered unsupported loop without rewriting other project assets', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await runtime.upsertScheduledTask('project-test', definition);
      const configPath = runtime.resolveProjectConfigPath('project-test');
      const original = await readFile(configPath, 'utf8');
      for (const loop of [
        { definition: { ...definition, runtime: 'pi' }, filePath: '/repo/legacy.md' },
        { definition: null, filePath: '/repo/malformed.md', error: 'Invalid YAML' },
      ]) {
        await expect(runtime.reconcileLoopTasks('project-test', [loop])).rejects.toThrow('Invalid loop');
        expect(await readFile(configPath, 'utf8')).toBe(original);
      }
    } finally { await cleanup(); }
  });

  it.each([
    { ...definition, runtime: undefined },
    { ...definition, runtime: 'pi' },
    { ...definition, target: undefined },
    { ...definition, execution: { prompt: 'replacement', modelID: 'legacy' } },
  ])('holds a previous native projection when supplied an invalid replacement', async replacement => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const loop = { definition, filePath: '/repo/review.md', revision: 'first', scope: 'project' };
      const first = requireTask((await runtime.reconcileLoopTasks('project-test', [loop]))[0]);
      const next = requireTask((await runtime.reconcileLoopTasks('project-test', [{ ...loop, definition: replacement, revision: 'invalid' }]))[0]);
      expect(next).toMatchObject({ id: first.id, runtime: 'agent', target: first.target, execution: first.execution, schedule: first.schedule, state: first.state, loopRevision: 'invalid' });
      expect(next.loopError).toBeTruthy();
      expect(await runtime.listScheduledTasks('project-test')).toEqual([next]);
    } finally { await cleanup(); }
  });
});
