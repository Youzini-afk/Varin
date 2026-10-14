import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CalendarDefinition, CalendarOccurrence, CalendarPreparation, CalendarProject, CalendarSyncParams, CalendarPending, AgentRuntimeStreamEvent } from '@varin/protocol';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { KernelClientError } from '../kernel/kernel-error.js';
import { KERNEL_PROTOCOL_VERSION } from '../kernel/protocol.generated.js';
import { CalendarOwner } from './calendar-owner.js';
import { createScheduledTasksRuntime } from './runtime.js';
import { createScheduledTaskService, readScheduledProjects } from './service.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';

const target: CalendarDefinition['target'] = { kind: 'new_work', source: { kind: 'project' }, model: { providerId: 'fixture', modelId: 'model' }, sourceMode: 'fixed_branch', goal: null };
const definition: CalendarDefinition = { id: 'calendar:original', project_id: 'project', task_id: 'task', asset_revision: 'asset', asset_kind: 'gui', revision: 1, generation: 1,
  name: 'Original calendar', enabled: true, deleted: false, timezone: 'UTC', rule: { kind: 'once', date: '2020-01-01', time: '09:00' }, missed_policy: 'coalesce_once', target,
  synchronized: true, once_acceptance: null, activation_hold: null, next_at_ms: null, calculation_pending: false, calculation_failure: null };
const occurrence: CalendarOccurrence = { id: 'occurrence:original', definition_id: definition.id, generation: 1, revision: 1, reason: { kind: 'manual', key: 'stable-click' },
  observed_at_ms: 10, thread_id: 'thread:original', branch_id: 'branch:original', input_id: null, run_id: null, execution_id: null, goal_id: null, state: 'preparing', hold_reason: null, failure_code: null };

it('the asset service preserves native acceptance keys and separates Catalog facts from external assets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-calendar-assets-'));
  const config = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: path.join(root, 'config'), createTaskID: () => 'task' });
  let project: CalendarProject = { project_id: 'project', revision: 0, definitions: [] };
  const client = {
    onExit: () => () => {}, onReady: () => () => {}, onEvent: () => () => {}, calendarProjects: async () => [],
    calendar: async () => structuredClone(project), calendarOccurrences: async () => [], calendarPending: async () => ({ calculations: [], preparations: [] }),
    syncCalendar: vi.fn(async (input: CalendarSyncParams) => { project = { ...project, revision: 1, definitions: [...input.definitions.map(value => ({ ...definition, task_id: value.taskId, asset_revision: value.assetRevision, activation_hold: value.activationHold, once_acceptance: value.onceAcceptance, rule: value.rule, enabled: value.enabled, target: value.target })), ...project.definitions.filter(value => !input.definitions.some(input => input.taskId === value.task_id)).map(value => ({ ...value, deleted: true }))] }; return project; }),
    runCalendar: vi.fn(async () => occurrence),
  };
  const runtime = createScheduledTasksRuntime({ projectConfigRuntime: config, listProjects: async () => [{ id: 'project', path: root }] });
  const owner = new CalendarOwner({ runtime: client as unknown as AgentRuntimeClient, projects: async () => [{ id: 'project', path: root }],
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
    const saved = (await config.listScheduledTasks('project'))[0]!;
    expect(saved.state).not.toHaveProperty('lastSessionId'); expect(saved).not.toHaveProperty('calendar');
    expect(saved.execution).toEqual({ prompt: '原文' });
    const originalConfig = await fs.readFile(config.resolveProjectConfigPath('project'), 'utf8');
    await expect(service.upsert('project', { id: 'task', runtime: 'pi', execution: { prompt: 'Legacy selection' } })).rejects.toThrow();
    expect(await fs.readFile(config.resolveProjectConfigPath('project'), 'utf8')).toBe(originalConfig);
    const loops = path.join(root, '.agents', 'loops'); await fs.mkdir(loops, { recursive: true });
    const file = path.join(loops, 'calendar.md');
    const native = `---\nname: Loop calendar\nruntime: agent\nenabled: false\nschedule: '0 9 * * *'\ntimezone: UTC\ntarget: ${JSON.stringify(target)}\n---\nOriginal instruction\n`;
    await fs.writeFile(file, native);
    const original = (await service.list('project')).find(task => task.loopFile === file)!;
    expect(original.runtime).toBe('agent');
    await fs.writeFile(file, `---\nname: Loop calendar\nenabled: false\nschedule: '0 9 * * *'\ntimezone: UTC\nmodel: fixture/model\n---\nPi instruction\n`);
    const held = (await service.list('project')).find(task => task.id === original.id)!;
    expect(held.runtime).toBe('agent'); expect(held.calendar?.definition.activation_hold).toBe('asset_invalid');
    expect(await fs.readFile(file, 'utf8')).toContain('Pi instruction');
    await fs.writeFile(file, native); await service.list('project');
    await fs.writeFile(file, '---\nname: Loop calendar\nruntime: agent\n---\nIncomplete edit');
    expect((await service.list('project')).find(task => task.id === original.id)?.calendar?.definition.activation_hold).toBe('asset_invalid');
    const before = client.syncCalendar.mock.calls.length;
    await fs.writeFile(config.resolveProjectConfigPath('project'), JSON.stringify({ scheduledTasks: [{ broken: true }] }));
    await expect(service.list('project')).rejects.toThrow();
    expect(client.syncCalendar).toHaveBeenCalledTimes(before);
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
  const owner = new CalendarOwner({ runtime: client as unknown as AgentRuntimeClient, projects: async () => [{ id: 'project', path: '/fixture' }], prepare, onChanged() {}, onError: error => errors.push(error) });
  try {
    await owner.recover(); await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(client.calculatedCalendar).toHaveBeenCalledOnce();
    event({ v: KERNEL_PROTOCOL_VERSION, kind: 'runtime-event', stream: 'durable', kernelEpoch: 'original', cursor: 2 });
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

it('cancels preparation observation on removal or shutdown without claiming original work failed', async () => {
  let release!: () => void;
  let observedSignal!: AbortSignal;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const pending: CalendarPending = { calculations: [], preparations: [occurrence] };
  const client = { onExit: () => () => {}, onReady: () => () => {}, onEvent: () => () => {},
    calendarPending: async () => structuredClone(pending),
    prepareCalendar: async (): Promise<CalendarPreparation> => ({ occurrence, definition, instruction: 'Original body', owner_epoch: 1 }),
    failCalendarPreparation: vi.fn(),
  };
  const errors: unknown[] = [];
  const prepare = vi.fn(async (_work: CalendarPreparation, _path: string, signal: AbortSignal) => {
    observedSignal = signal;
    await barrier;
    signal.throwIfAborted();
    return occurrence;
  });
  const owner = new CalendarOwner({ runtime: client as unknown as AgentRuntimeClient, projects: async () => [{ id: 'project', path: '/fixture' }], prepare,
    onChanged() {}, onError: error => errors.push(error) });
  try {
    await owner.recover(); await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    pending.preparations = [];
    await owner.recover();
    expect(observedSignal.aborted).toBe(true);
    owner.stop(); release();
    await new Promise(resolve => setImmediate(resolve));
    expect(client.failCalendarPreparation).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    await owner.recover(); expect(prepare).toHaveBeenCalledOnce();
  } finally { release(); owner.stop(); }
});

it('retains active work from deleted definitions and validates occurrence ownership before control', async () => {
  const cancelled = { ...occurrence, id: 'cancelled-original', state: 'cancelled' as const };
  const client = { onExit: () => () => {}, onReady: () => () => {}, onEvent: () => () => {},
    calendarProjects: async () => ['project'], calendar: async () => ({ definitions: [{ ...definition, deleted: true }] }),
    calendarOccurrences: async () => [occurrence, cancelled], controlCalendarOccurrence: vi.fn(async () => cancelled),
  };
  const owner = new CalendarOwner({ runtime: client as unknown as AgentRuntimeClient, projects: async () => [], prepare: async () => occurrence, onChanged() {}, onError() {} });
  try {
    expect(await owner.status()).toEqual({ enabled: 0, running: 1 });
    await expect(owner.control('project', 'task', 'foreign-occurrence', 2, 'cancel')).rejects.toThrow('does not belong');
    expect(client.controlCalendarOccurrence).not.toHaveBeenCalled();
    await owner.control('project', 'task', occurrence.id, occurrence.revision, 'cancel');
    expect(client.controlCalendarOccurrence).toHaveBeenCalledExactlyOnceWith({ occurrenceId: occurrence.id, expectedRevision: occurrence.revision, action: 'cancel' });
  } finally { owner.stop(); }
});
