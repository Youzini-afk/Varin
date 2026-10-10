import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CalendarDefinition, CalendarOccurrence, CalendarPreparation, CalendarProject, CalendarSyncParams, CalendarPending, AgentRuntimeStreamEvent } from '@varin/protocol';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { KernelClientError } from '../kernel/kernel-client.js';
import { CalendarOwner } from './calendar-owner.js';
import { createScheduledTasksRuntime } from './runtime.js';
import { createScheduledTaskService, readScheduledProjects } from './service.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';

const target: CalendarDefinition['target'] = { kind: 'new_work', model: { providerId: 'fixture', modelId: 'model' }, sourceMode: 'fixed_branch', goal: null };
const definition: CalendarDefinition = { id: 'calendar:original', project_id: 'project', task_id: 'task', asset_revision: 'asset', asset_kind: 'gui', revision: 1, generation: 1,
  name: 'Original calendar', enabled: true, deleted: false, timezone: 'UTC', rule: { kind: 'once', date: '2020-01-01', time: '09:00' }, missed_policy: 'coalesce_once', target,
  synchronized: true, once_acceptance: null, activation_hold: null, next_at_ms: null, calculation_pending: false, calculation_failure: null };
const occurrence: CalendarOccurrence = { id: 'occurrence:original', definition_id: definition.id, generation: 1, revision: 1, reason: { kind: 'manual', key: 'stable-click' },
  observed_at_ms: 10, thread_id: 'thread:original', branch_id: 'branch:original', input_id: null, run_id: null, execution_id: null, goal_id: null, state: 'preparing', hold_reason: null, failure_code: null };

it('original asset service routes Agent tasks to native acceptance, keeps stable manual keys and never starts a Pi timer or copies native status', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-calendar-assets-'));
  const config = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: path.join(root, 'config'), createTaskID: () => 'task' });
  const pi = vi.fn(async () => ({ sessionID: 'must-not-start' }));
  let project: CalendarProject = { project_id: 'project', revision: 0, definitions: [] };
  const client = {
    onExit: () => () => {}, onReady: () => () => {}, onEvent: () => () => {}, calendarProjects: async () => [],
    calendar: async () => structuredClone(project), calendarOccurrences: async () => [], calendarPending: async () => ({ calculations: [], preparations: [] }),
    syncCalendar: vi.fn(async (input: CalendarSyncParams) => { project = { ...project, revision: 1, definitions: [...input.definitions.map(value => ({ ...definition, task_id: value.taskId, asset_revision: value.assetRevision, activation_hold: value.activationHold, once_acceptance: value.onceAcceptance, rule: value.rule, enabled: value.enabled, target: value.target })), ...project.definitions.filter(value => !input.definitions.some(input => input.taskId === value.task_id)).map(value => ({ ...value, deleted: true }))] }; return project; }),
    runCalendar: vi.fn(async () => occurrence),
  };
  const runtime = createScheduledTasksRuntime({ projectConfigRuntime: config, listProjects: async () => [{ id: 'project', path: root }], executeTask: pi });
  const owner = new CalendarOwner({ runtime: client as unknown as AgentRuntimeClient, projects: async () => [{ id: 'project', path: root }], hasPiWork: runtime.hasPiWork,
    prepare: async () => { throw new Error('No pending preparation supplied'); }, onChanged() {}, onError(error) { throw error; } });
  runtime.setCalendarOwner(owner);
  const service = createScheduledTaskService({ projectConfigRuntime: config, scheduledTasksRuntime: runtime, readSettingsFromDisk: async () => ({ projects: [{ id: 'project', path: root }] }), sanitizeProjects: value => value as Array<{ id: string; path: string }> });
  try {
    await service.upsert('project', { id: 'task', runtime: 'agent', name: 'Original calendar', enabled: true, execution: { prompt: '原文' }, target,
      schedule: { kind: 'once', date: '2020-01-01', time: '09:00', timezone: 'UTC' } });
    await runtime.start();
    await service.setEnabled('project', 'task', false);
    for (let attempt = 0; attempt < 2; attempt++) expect(await service.run('project', 'task', 'stable-click')).toMatchObject({ runtime: 'agent', occurrence: { id: occurrence.id } });
    expect(client.runCalendar.mock.calls).toEqual(Array(2).fill([{ definitionId: definition.id, expectedRevision: 1, key: 'stable-click' }]));
    expect(pi).not.toHaveBeenCalled();
    await config.updateScheduledTaskState('project', 'task', { lastSessionId: 'wrong-owner', lastStatus: 'success' });
    const saved = (await config.listScheduledTasks('project'))[0]!;
    expect(saved.state).not.toHaveProperty('lastSessionId'); expect(saved).not.toHaveProperty('calendar');
    expect(saved.execution).toEqual({ prompt: '原文' });
    const changed = await service.upsert('project', { id: 'task', runtime: 'pi', execution: { prompt: 'Pi selection', providerID: 'fixture', modelID: 'model' } });
    expect(changed.task.runtime).toBe('pi'); expect(changed.task).not.toHaveProperty('target');
    expect(client.syncCalendar.mock.lastCall![0].definitions).toEqual([]);
    await service.upsert('project', { id: 'task', runtime: 'agent', execution: { prompt: 'Native selection' }, target });
    const loops = path.join(root, '.agents', 'loops'); await fs.mkdir(loops, { recursive: true });
    const file = path.join(loops, 'calendar.md');
    const native = `---\nname: Loop calendar\nruntime: agent\nenabled: false\nschedule: '0 9 * * *'\ntimezone: UTC\ntarget: ${JSON.stringify(target)}\n---\nOriginal instruction\n`;
    await fs.writeFile(file, native);
    const original = (await service.list('project')).find(task => task.loopFile === file)!;
    expect(original.runtime).toBe('agent');
    await fs.writeFile(file, `---\nname: Loop calendar\nenabled: false\nschedule: '0 9 * * *'\ntimezone: UTC\nmodel: fixture/model\n---\nPi instruction\n`);
    const piLoop = (await service.list('project')).find(task => task.id === original.id)!;
    expect(piLoop.runtime).not.toBe('agent'); expect(piLoop).not.toHaveProperty('target');
    await fs.writeFile(file, native); await service.list('project');
    await fs.writeFile(file, '---\nname: Loop calendar\nruntime: agent\n---\nIncomplete edit');
    expect((await service.list('project')).find(task => task.id === original.id)?.calendar?.definition.activation_hold).toBe('asset_invalid');
    const before = client.syncCalendar.mock.calls.length;
    await fs.writeFile(config.resolveProjectConfigPath('project'), JSON.stringify({ scheduledTasks: [{ broken: true }] }));
    await expect(service.list('project')).rejects.toThrow();
    expect(client.syncCalendar).toHaveBeenCalledTimes(before);
    expect(pi).not.toHaveBeenCalled();
  } finally { runtime.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

it('calculation proceeds beside a held cold preparation, and a resume while its first attempt drains is not lost', async () => {
  let event = (_value: AgentRuntimeStreamEvent) => {};
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const pending: CalendarPending = { calculations: [{ definition_id: definition.id, generation: 1, revision: 1, owner_epoch: 1, timezone: 'UTC', rule: definition.rule, after_ms: 20, now_ms: 20 }], preparations: [occurrence] };
  const work: CalendarPreparation = { occurrence, definition, instruction: 'Original body', owner_epoch: 1 };
  const fail = vi.fn();
  const client = { onExit: () => () => {}, onReady: () => () => {}, onEvent: (listener: typeof event) => { event = listener; return () => {}; },
    calendarPending: async () => structuredClone(pending), prepareCalendar: async () => work,
    calculatedCalendar: vi.fn(async () => { pending.calculations = []; return definition; }), failCalendarPreparation: fail };
  const prepare = vi.fn(async () => {
    if (prepare.mock.calls.length === 1) { await barrier; throw new KernelClientError({ code: 'activation-held', message: 'Paused at final admission', retryable: true }); }
    pending.preparations = []; return { ...occurrence, state: 'delivered' as const, run_id: 'original-run' };
  });
  const errors: unknown[] = [];
  const owner = new CalendarOwner({ runtime: client as unknown as AgentRuntimeClient, projects: async () => [{ id: 'project', path: '/fixture' }], hasPiWork: () => false, prepare, onChanged() {}, onError: error => errors.push(error) });
  try {
    await owner.recover(); await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(client.calculatedCalendar).toHaveBeenCalledOnce();
    event({ v: 1, kind: 'runtime-event', stream: 'durable', kernelEpoch: 'original', cursor: 2 });
    await owner.recover(); release();
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(fail).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  } finally { release(); owner.stop(); }
});

it('an incomplete project settings read cannot be an empty authoritative calendar scan', async () => {
  await expect(readScheduledProjects(async () => ({ projects: { broken: true } }), () => [])).rejects.toThrow('invalid');
  await expect(readScheduledProjects(async () => ({ projects: [{ id: 'project' }] }), () => [])).rejects.toThrow('completely');
  expect(await readScheduledProjects(async () => ({ projects: [] }), () => [])).toEqual([]);
});

it('once owner handoffs retain accepted work in both directions, including acceptance between capture and native tombstone', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-calendar-handoff-'));
  const config = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: path.join(root, 'config') });
  let project: CalendarProject = { project_id: 'project', revision: 0, definitions: [] };
  const accepted: CalendarOccurrence[] = [];
  let acceptDuringDelete = false;
  const client = { onExit: () => () => {}, onReady: () => () => {}, onEvent: () => () => {}, calendarProjects: async () => [],
    calendar: async () => structuredClone(project), calendarPending: async () => ({ calculations: [], preparations: [] }),
    calendarOccurrences: async ({ definitionId }: { definitionId: string }) => accepted.filter(value => value.definition_id === definitionId),
    syncCalendar: vi.fn(async (input: CalendarSyncParams) => {
      const removed = project.definitions.filter(value => !input.definitions.some(input => input.taskId === value.task_id));
      if (acceptDuringDelete) {
        const departing = removed.find(value => value.task_id === 'native-once' && !value.deleted);
        if (departing) { accepted.push({ ...occurrence, id: 'late-original-slot', definition_id: departing.id, generation: departing.generation, state: 'cancelled',
          reason: { kind: 'scheduled', at_ms: Date.parse('2020-01-01T09:00:00Z') }, observed_at_ms: Date.now() }); acceptDuringDelete = false; }
      }
      project = { ...project, revision: project.revision + 1, definitions: [...input.definitions.map(value => ({ ...definition, id: `calendar:${value.taskId}`, task_id: value.taskId,
        enabled: value.enabled, activation_hold: value.activationHold, once_acceptance: value.onceAcceptance, rule: value.rule, target: value.target })), ...removed.map(value => ({ ...value, deleted: true }))] };
      return structuredClone(project);
    }) };
  let finishReplacement = () => {};
  let finishPi!: () => void; const barrier = new Promise<void>(resolve => { finishPi = resolve; });
  const pi = vi.fn(async () => { await barrier; return { sessionID: 'actual-pi-session' }; });
  const runtime = createScheduledTasksRuntime({ projectConfigRuntime: config, listProjects: async () => [{ id: 'project', path: root }], executeTask: pi, logger: { info() {}, warn() {} } });
  const errors: unknown[] = [];
  const owner = new CalendarOwner({ runtime: client as unknown as AgentRuntimeClient, projects: async () => [{ id: 'project', path: root }], hasPiWork: runtime.hasPiWork,
    prepare: async () => { throw new Error('No native preparation in this port fixture'); }, onChanged() {}, onError: error => errors.push(error) });
  runtime.setCalendarOwner(owner);
  const service = createScheduledTaskService({ projectConfigRuntime: config, scheduledTasksRuntime: runtime, readSettingsFromDisk: async () => ({ projects: [{ id: 'project', path: root }] }), sanitizeProjects: value => value as Array<{ id: string; path: string }> });
  const schedule = { kind: 'once' as const, date: '2020-01-01', time: '09:00', timezone: 'UTC' };
  try {
    await service.upsert('project', { id: 'pi-once', name: 'Original Pi once', enabled: true, schedule, execution: { prompt: 'Same intention', providerID: 'fixture', modelID: 'model' } });
    await runtime.start(); await vi.waitFor(() => expect(pi).toHaveBeenCalledOnce());
    const originalAccepted = (await config.listScheduledTasks('project'))[0]!.state.lastRunAt;
    await service.upsert('project', { id: 'pi-once', runtime: 'agent', execution: { prompt: 'Same intention' }, target });
    expect(project.definitions[0]).toMatchObject({ activation_hold: 'previous_runtime_active', once_acceptance: { owner: 'pi', acceptedAtMs: originalAccepted } });
    finishPi(); await vi.waitFor(() => expect(runtime.hasPiWork('project', 'pi-once')).toBe(false));
    await service.list('project');
    expect(project.definitions[0]).toMatchObject({ activation_hold: null, once_acceptance: { owner: 'pi', acceptedAtMs: originalAccepted } });
    expect((await config.listScheduledTasks('project'))[0]?.state).not.toHaveProperty('lastStatus');
    // The old Pi runner cannot cross a file-owner change even after reserving its live key.
    const stalePi = { ...(await config.listScheduledTasks('project'))[0]!, runtime: 'pi' as const };
    expect((await config.updateScheduledTaskState('project', 'pi-once', { lastRunAt: Date.now() }, { kind: 'admit', task: stalePi, scheduled: true })).task).toBeNull();
    await service.upsert('project', { id: 'native-once', name: 'Original Agent once', runtime: 'agent', enabled: true, schedule, execution: { prompt: 'Native original' }, target });
    acceptDuringDelete = true;
    await service.upsert('project', { id: 'native-once', runtime: 'pi', execution: { prompt: 'Native original', providerID: 'fixture', modelID: 'model' } });
    const transferred = (await config.listScheduledTasks('project')).find(value => value.id === 'native-once')!;
    expect(transferred.onceAcceptance).toMatchObject({ owner: 'agent', acceptanceId: 'late-original-slot' });
    expect(transferred).not.toHaveProperty('pendingCalendarHandoff');
    await service.list('project'); expect(pi).toHaveBeenCalledOnce();
    await service.upsert('project', { id: 'native-once', runtime: 'agent', execution: { prompt: 'Native original' }, target });
    expect(project.definitions.find(value => value.task_id === 'native-once')).toMatchObject({ once_acceptance: { owner: 'agent', acceptanceId: 'late-original-slot' } });
    await service.upsert('project', { id: 'native-once', execution: { prompt: 'Explicitly different once intention' } });
    expect(project.definitions.find(value => value.task_id === 'native-once')?.once_acceptance).toBeNull();
    const late = new Promise<void>(resolve => { finishReplacement = resolve; });
    pi.mockImplementationOnce(async () => { await late; return { sessionID: 'old-pi-intent' }; });
    await service.upsert('project', { id: 'replace-running', name: 'Original once', enabled: true, schedule, execution: { prompt: 'Old intention', providerID: 'fixture', modelID: 'model' } });
    await vi.waitFor(() => expect(pi).toHaveBeenCalledTimes(2));
    await service.upsert('project', { id: 'replace-running', runtime: 'agent', target, execution: { prompt: 'New future intention' }, schedule: { ...schedule, date: '2027-01-01', time: '12:00' } });
    finishReplacement(); await vi.waitFor(() => expect(runtime.hasPiWork('project', 'replace-running')).toBe(false));
    const replacement = (await service.list('project')).find(value => value.id === 'replace-running')!;
    expect(replacement).toMatchObject({ runtime: 'agent', enabled: true, schedule: { date: '2027-01-01', time: '12:00' }, execution: { prompt: 'New future intention' } });
    expect(replacement).not.toHaveProperty('onceAcceptance'); expect(replacement.state).not.toHaveProperty('lastStatus');
    expect(errors).toEqual([]);
  } finally { finishReplacement(); finishPi(); runtime.stop(); await fs.rm(root, { recursive: true, force: true }); }
});
