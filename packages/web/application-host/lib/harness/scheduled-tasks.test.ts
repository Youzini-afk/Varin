import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHarnessRouter } from './router.js';
import { createHarnessServiceHost, deriveHarnessCapabilities } from './service-host.js';
import { registerHarnessServices } from './harness-services.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createScheduledTasksRuntime } from '../scheduled-tasks/runtime.js';
import { createScheduledTaskService } from '../scheduled-tasks/service.js';
import type { HarnessActorContext, HarnessServiceMap } from '@varin/protocol';

type ScheduleMethod = keyof HarnessServiceMap & `schedule.${string}`;

/**
 * Agent-facing calendar task management (D-307 W-C): schedule.* methods must
 * reach the same scheduled-task service the GUI routes use, scoped to the
 * project the caller's workspace resolves to.
 */
describe('harness scheduled task services', () => {
  const tempRoots: string[] = [];
  const runtimes: Array<ReturnType<typeof createScheduledTasksRuntime>> = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) runtime.stop();
    for (const root of tempRoots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const fixture = async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-harness-schedule-'));
    tempRoots.push(tempRoot);
    const projectPath = path.join(tempRoot, 'project');
    const secondProjectPath = path.join(tempRoot, 'project-2');
    await Promise.all([mkdir(projectPath, { recursive: true }), mkdir(secondProjectPath, { recursive: true })]);

    const projectConfigRuntime = createProjectConfigRuntime({
      fsPromises: await import('node:fs/promises'),
      path,
      projectsDirPath: path.join(tempRoot, 'projects'),
      createTaskID: (() => {
        let counter = 0;
        return () => `task-${(counter += 1)}`;
      })(),
    });
    const runSessions: string[] = [];
    const scheduledTasksRuntime = createScheduledTasksRuntime({
      projectConfigRuntime,
      listProjects: async () => [
        { id: 'project-1', path: projectPath },
        { id: 'project-2', path: secondProjectPath },
      ],
      executeTask: async () => {
        const sessionID = `sess-${(runSessions.length + 1)}`;
        runSessions.push(sessionID);
        return { sessionID };
      },
      logger: { info: () => {}, warn: () => {} },
    });
    runtimes.push(scheduledTasksRuntime);
    const scheduledTaskService = createScheduledTaskService({
      projectConfigRuntime,
      scheduledTasksRuntime,
      readSettingsFromDisk: async () => ({ projects: [
        { id: 'project-1', path: projectPath },
        { id: 'project-2', path: secondProjectPath },
      ] }),
      sanitizeProjects: (value) => (Array.isArray(value) ? value as Array<{ id: string; path: string }> : undefined),
    });

    const host = createHarnessServiceHost({
      search: async () => ({ status: 'empty', generation: undefined }),
      resolveWorkspaceRoot: async (workspaceId) => workspaceId === 'ws-1' ? projectPath : null,
      scheduledTaskService,
    });
    const router = createHarnessRouter({
      resolveActor: async (identity) => ({
        authorityInstanceId: identity.authorityInstanceId,
        sessionId: identity.sessionId,
        workerId: identity.workerId,
        workerGeneration: identity.workerGeneration,
        workspaceId: identity.sessionId === 'session-2' ? 'ws-unknown' : 'ws-1',
        grantedCapabilities: deriveHarnessCapabilities(['scheduled_task'], { threadRuntime: false, scheduledTasks: true }),
      }),
      respond: async (_sessionId, _requestId, result) => { lastResponse = result; },
    });
    let lastResponse: unknown;
    registerHarnessServices(router, host);

    const actor: HarnessActorContext = {
      authorityInstanceId: 'host',
      sessionId: 'session-1',
      workerId: 'worker-1',
      workerGeneration: 1,
      workspaceId: 'ws-1',
      grantedCapabilities: ['read.schedule', 'control.schedule'],
    };

    const request = async <M extends ScheduleMethod>(
      method: M,
      params: HarnessServiceMap[M]['params'],
      actorOverride?: HarnessActorContext,
    ) => {
      lastResponse = undefined;
      await router.processEvent({
        kind: 'host',
        actor: actorOverride ?? actor,
        envelope: {
          kind: 'event',
          event: 'harness.request',
          data: { requestId: crypto.randomUUID(), method, params },
        },
      });
      return lastResponse as
        | { ok: true; result: HarnessServiceMap[M]['result'] }
        | { ok: false; error: { code: string; message: string } };
    };

    return { projectConfigRuntime, projectPath, request, runSessions, scheduledTaskService, scheduledTasksRuntime };
  };

  it('lists, creates, runs, enables, and removes tasks for the caller project', async () => {
    const { request, runSessions } = await fixture();

    const empty = await request('schedule.list', {});
    expect(empty).toMatchObject({ ok: true, result: { projectId: 'project-1', tasks: [] } });

    const created = await request('schedule.upsert', {
      task: {
        name: 'Nightly digest',
        enabled: true,
        schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' },
        execution: { prompt: 'Summarize', providerID: 'openai', modelID: 'gpt-4.1' },
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(created.result.created).toBe(true);
    const taskId = created.result.task.id;

    const patched = await request('schedule.upsert', { task: { id: taskId, name: 'Renamed digest' } });
    expect(patched).toMatchObject({
      ok: true,
      result: {
        created: false,
        task: {
          name: 'Renamed digest',
          schedule: { kind: 'daily', times: ['09:30'], timezone: 'UTC' },
          execution: { prompt: 'Summarize', providerID: 'openai', modelID: 'gpt-4.1' },
        },
      },
    });

    const got = await request('schedule.get', { taskId });
    expect(got).toMatchObject({ ok: true, result: { task: { id: taskId, name: 'Renamed digest' } } });

    const disabled = await request('schedule.setEnabled', { taskId, enabled: false });
    expect(disabled).toMatchObject({ ok: true, result: { task: { enabled: false } } });

    // Disabled suppresses calendar firing; an explicit run remains available.
    const manualWhileDisabled = await request('schedule.run', { taskId });
    expect(manualWhileDisabled).toMatchObject({
      ok: true,
      result: { sessionId: 'sess-1', task: { enabled: false, state: { lastStatus: 'success' } } },
    });

    await request('schedule.setEnabled', { taskId, enabled: true });
    const ran = await request('schedule.run', { taskId });
    if (!ran.ok) throw new Error(ran.error.message);
    expect(ran.result.runtime).toBe('pi');
    if (ran.result.runtime !== 'pi') throw new Error('Expected original Pi execution');
    expect(ran.result.sessionId).toBe('sess-2');
    expect(ran.result.task.state.lastStatus).toBe('success');
    expect(ran.result.task.state.lastSessionId).toBe('sess-2');
    expect(runSessions).toEqual(['sess-1', 'sess-2']);

    const status = await request('schedule.status', {});
    expect(status).toMatchObject({ ok: true, result: { enabledScheduledTasksCount: 1 } });

    const removed = await request('schedule.remove', { taskId });
    expect(removed).toMatchObject({ ok: true, result: { tasks: [] } });

    const after = await request('schedule.get', { taskId });
    expect(after).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('reads and writes loop documents with CAS, keeping Markdown the owner', async () => {
    const { projectPath, request } = await fixture();
    const loopsDir = path.join(projectPath, '.agents', 'loops');
    await mkdir(loopsDir, { recursive: true });
    const loopContent = [
      '---',
      'name: daily-review',
      'schedule: "0 9 * * *"',
      'enabled: false',
      'model: openai/gpt-4.1',
      'timezone: UTC',
      '---',
      'Review the day’s changes.',
      '',
    ].join('\n');
    await writeFile(path.join(loopsDir, 'daily-review.md'), loopContent, 'utf8');

    const listed = await request('schedule.list', {});
    if (!listed.ok) throw new Error(listed.error.message);
    const loopTask = listed.result.tasks.find((task) => task.name === 'daily-review');
    if (!loopTask?.loopFile) throw new Error('loop task missing');

    const doc = await request('schedule.loop.read', { taskId: loopTask.id });
    if (!doc.ok) throw new Error(doc.error.message);
    expect(doc.result.document.content).toBe(loopContent);
    expect(doc.result.document.scope).toBe('project');

    // A loop-owned task cannot be hijacked through the JSON upsert path.
    const hijack = await request('schedule.upsert', {
      task: { id: loopTask.id, name: 'hijacked' },
    });
    expect(hijack).toMatchObject({ ok: false, error: { code: 'invalid-params' } });

    const enabledContent = loopContent.replace('enabled: false', 'enabled: true');
    const updated = await request('schedule.loop.update', {
      taskId: loopTask.id,
      content: enabledContent,
      expectedRevision: doc.result.document.revision,
    });
    if (!updated.ok) throw new Error(updated.error.message);
    expect(updated.result.task?.enabled).toBe(true);

    // A stale revision is a conflict, not a silent overwrite.
    const stale = await request('schedule.loop.update', {
      taskId: loopTask.id,
      content: loopContent,
      expectedRevision: doc.result.document.revision,
    });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('stale revision accepted');
    expect(stale.error.message).toMatch(/changed|conflict|revision/i);

    // Loop tasks delete through their Markdown file — the JSON remove path
    // refuses, and loop.remove drops the file plus its task projection.
    const jsonRemove = await request('schedule.remove', { taskId: loopTask.id });
    expect(jsonRemove.ok).toBe(false);
    const removed = await request('schedule.loop.remove', {
      taskId: loopTask.id,
      expectedRevision: updated.result.document.revision,
    });
    if (!removed.ok) throw new Error(removed.error.message);
    expect(removed.result.tasks.some((task) => task.id === loopTask.id)).toBe(false);
    const gone = await request('schedule.get', { taskId: loopTask.id });
    expect(gone.ok).toBe(false);
  });

  it('rejects callers whose workspace does not resolve to a project', async () => {
    const { request } = await fixture();
    const foreign: HarnessActorContext = {
      authorityInstanceId: 'host',
      sessionId: 'session-2',
      workerId: 'worker-2',
      workerGeneration: 1,
      workspaceId: 'ws-unknown',
      grantedCapabilities: ['read.schedule', 'control.schedule'],
    };
    const listed = await request('schedule.list', {}, foreign);
    expect(listed).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('scopes schedule.status to the caller project while retaining global UI status', async () => {
    const { projectConfigRuntime, request, scheduledTaskService, scheduledTasksRuntime } = await fixture();
    await projectConfigRuntime.upsertScheduledTask('project-2', {
      name: 'Other project',
      enabled: true,
      schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
      execution: { prompt: 'other', providerID: 'openai', modelID: 'gpt-4.1' },
    });
    await scheduledTasksRuntime.syncProject('project-2');

    const callerStatus = await request('schedule.status', {});
    expect(callerStatus).toMatchObject({ ok: true, result: { enabledScheduledTasksCount: 0 } });
    await scheduledTasksRuntime.syncProject('project-1');
    expect(await scheduledTaskService.globalStatus()).toMatchObject({ enabledScheduledTasksCount: 1 });
  });
});
