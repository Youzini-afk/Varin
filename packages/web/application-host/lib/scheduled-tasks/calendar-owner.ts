import { createHash } from 'node:crypto';
import type { ScheduledTask } from '@varin/application-client';
import type { CalendarOnceAcceptance, CalendarDefinitionInput, CalendarOccurrence, CalendarPreparation, CalendarRule } from '@varin/protocol';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import { KernelClientError } from '../kernel/kernel-client.js';
import { calculateCalendarSlots } from './recurrence.js';

interface CalendarOwners {
  runtime: AgentRuntimeClient;
  projects(): Promise<Array<{ id: string; path: string }>>;
  hasPiWork(projectId: string, taskId: string): boolean;
  prepare(work: CalendarPreparation, projectPath: string, signal: AbortSignal): Promise<CalendarOccurrence>;
  onChanged(): void;
  onError(error: unknown): void;
}
const canonical = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const active = (occurrence: CalendarOccurrence) => !['completed', 'failed', 'cancelled'].includes(occurrence.state);
const ruleFor = (task: ScheduledTask): CalendarRule => {
  const schedule = task.schedule;
  if (schedule.kind === 'once') {
    if (!schedule.date || !schedule.time) throw new Error('Calendar once rule is incomplete');
    return { kind: 'once', date: schedule.date, time: schedule.time };
  }
  if (schedule.kind === 'cron') {
    if (!schedule.cron) throw new Error('Calendar cron rule is incomplete');
    return { kind: 'cron', expression: schedule.cron };
  }
  const times = schedule.times ?? (schedule.time ? [schedule.time] : []);
  return schedule.kind === 'daily' ? { kind: 'daily', times } : { kind: 'weekly', times, weekdays: schedule.weekdays ?? [] };
};
/** External asset projection and cancellable preparation only. Catalog owns all deadlines,
 * generations, accepted occurrences, delivery and real Run/Goal results. */
export class CalendarOwner {
  private epoch = new AbortController();
  private suspended = false;
  private stopped = false;
  private pumping = false;
  private dirty = false;
  private synchronizeAssets: (() => Promise<void>) | undefined;
  private readonly flights = new Map<string, { controller: AbortController; work: Promise<void>; recheck: boolean }>();
  private readonly removers: Array<() => void>;
  constructor(private readonly owners: CalendarOwners) {
    const runtime = owners.runtime;
    this.removers = [runtime.onExit(() => {
      this.suspended = true; this.epoch.abort();
      for (const flight of this.flights.values()) flight.controller.abort();
      this.flights.clear();
    }), runtime.onReady(() => {
      if (this.stopped) return;
      if (this.suspended) { this.epoch = new AbortController(); this.suspended = false; }
      void this.resynchronize();
    }), runtime.onEvent(event => {
      if (event.stream !== 'durable' || this.stopped || this.suspended) return;
      this.owners.onChanged();
      void this.recover();
    })];
  }
  async start(synchronizeAssets: () => Promise<void>): Promise<void> {
    this.synchronizeAssets = synchronizeAssets;
    await this.resynchronize();
  }
  private async resynchronize(): Promise<void> {
    if (!this.synchronizeAssets || this.stopped || this.suspended) return;
    try { await this.synchronizeAssets(); }
    catch (error) { if (!this.epoch.signal.aborted) this.owners.onError(error); }
    finally { await this.recover(); }
  }
  stop(): void {
    this.stopped = true; this.epoch.abort();
    for (const flight of this.flights.values()) flight.controller.abort();
    for (const remove of this.removers) remove();
  }
  /** Caller serializes the original successful asset read and this publication. */
  async sync(projectId: string, tasks: ScheduledTask[]): Promise<ScheduledTask[]> {
    const signal = this.epoch.signal; signal.throwIfAborted();
    const previous = await this.owners.runtime.calendar({ projectId }, signal);
    const definitions: CalendarDefinitionInput[] = tasks.filter(task => task.runtime === 'agent' && !task.loopShadowed).map(task => {
      if (!task.target) throw new Error('Calendar target is unavailable');
      const asset = { id: task.id, runtime: task.runtime, name: task.name, enabled: task.enabled, schedule: task.schedule,
        execution: task.execution, target: task.target, missedPolicy: task.missedPolicy, loopRevision: task.loopRevision };
      return { taskId: task.id, assetRevision: createHash('sha256').update(canonical(asset)).digest('hex'),
        assetKind: task.loopFile ? 'loop' : 'gui', name: task.name, enabled: task.enabled, onceAcceptance: task.onceAcceptance ?? null,
        activationHold: task.loopError ? 'asset_invalid' : this.owners.hasPiWork(projectId, task.id) ? 'previous_runtime_active' : null,
        timezone: task.schedule.timezone, rule: ruleFor(task), missedPolicy: task.missedPolicy ?? (task.schedule.kind === 'once' ? 'coalesce_once' : 'skip'),
        target: task.target, instruction: task.execution.prompt };
    });
    const project = await this.owners.runtime.syncCalendar({ projectId, expectedRevision: previous.revision || null, definitions }, signal);
    return Promise.all(tasks.map(async task => {
      if (task.runtime !== 'agent') return task;
      const definition = project.definitions.find(entry => entry.task_id === task.id && !entry.deleted);
      if (!definition) { if (task.loopShadowed) return task; throw new Error('Calendar definition projection is unavailable'); }
      return { ...task, calendar: { definition, occurrences: await this.owners.runtime.calendarOccurrences({ definitionId: definition.id }, signal) } };
    }));
  }
  async removeMissingProjects(projectIds: Set<string>): Promise<void> {
    for (const projectId of await this.owners.runtime.calendarProjects()) {
      if (!projectIds.has(projectId)) await this.sync(projectId, []);
    }
  }
  async captureOnceHandoff(projectId: string, task: ScheduledTask): Promise<NonNullable<ScheduledTask['pendingCalendarHandoff']>> {
    const definition = (await this.owners.runtime.calendar({ projectId })).definitions.find(value => value.task_id === task.id && !value.deleted);
    if (!definition || definition.rule.kind !== 'once' || task.schedule.kind !== 'once'
      || definition.rule.date !== task.schedule.date || definition.rule.time !== task.schedule.time || definition.timezone !== task.schedule.timezone) throw new Error('Calendar owner changed before handoff');
    return { definitionId: definition.id, generation: definition.generation };
  }
  async settleOnceHandoff(projectId: string, handoff: NonNullable<ScheduledTask['pendingCalendarHandoff']>): Promise<CalendarOnceAcceptance | null> {
    const definition = (await this.owners.runtime.calendar({ projectId })).definitions.find(value => value.id === handoff.definitionId);
    if (!definition?.deleted) throw new Error('Calendar owner must stop new acceptance before handoff');
    const original = (await this.owners.runtime.calendarOccurrences({ definitionId: definition.id })).find(value => value.generation === handoff.generation && value.reason.kind === 'scheduled');
    if (original?.reason.kind === 'scheduled') return { owner: 'agent', acceptanceId: original.id, scheduledAtMs: original.reason.at_ms, acceptedAtMs: original.observed_at_ms };
    return definition.once_acceptance;
  }
  async hasActiveWork(projectId: string, taskId: string): Promise<boolean> {
    const project = await this.owners.runtime.calendar({ projectId });
    for (const definition of project.definitions.filter(value => value.task_id === taskId)) {
      if ((await this.owners.runtime.calendarOccurrences({ definitionId: definition.id })).some(active)) return true;
    }
    return false;
  }
  async status(projectId?: string): Promise<{ enabled: number; running: number }> {
    let enabled = 0, running = 0;
    for (const id of projectId ? [projectId] : await this.owners.runtime.calendarProjects()) {
      for (const definition of (await this.owners.runtime.calendar({ projectId: id })).definitions) {
        const occurrences = await this.owners.runtime.calendarOccurrences({ definitionId: definition.id });
        const hasActive = occurrences.some(active);
        if (hasActive) running++;
        if (!definition.deleted && definition.enabled && (definition.rule.kind !== 'once' || definition.next_at_ms !== null || definition.calculation_pending || hasActive)) enabled++;
      }
    }
    return { enabled, running };
  }
  async run(projectId: string, taskId: string, key: string): Promise<CalendarOccurrence> {
    const definition = (await this.owners.runtime.calendar({ projectId })).definitions.find(value => value.task_id === taskId && !value.deleted);
    if (!definition) throw new Error('Calendar definition is unavailable');
    return this.owners.runtime.runCalendar({ definitionId: definition.id, expectedRevision: definition.revision, key });
  }
  async control(projectId: string, taskId: string, occurrenceId: string, expectedRevision: number, action: 'cancel' | 'retry') {
    const definition = (await this.owners.runtime.calendar({ projectId })).definitions.find(value => value.task_id === taskId);
    if (!definition || !(await this.owners.runtime.calendarOccurrences({ definitionId: definition.id })).some(value => value.id === occurrenceId)) throw new Error('Calendar occurrence does not belong to this task');
    return this.owners.runtime.controlCalendarOccurrence({ occurrenceId, expectedRevision, action });
  }
  async retryCalculation(projectId: string, taskId: string, expectedRevision: number) {
    const definition = (await this.owners.runtime.calendar({ projectId })).definitions.find(value => value.task_id === taskId && !value.deleted);
    if (!definition) throw new Error('Calendar definition is unavailable');
    return this.owners.runtime.retryCalendarCalculation({ definitionId: definition.id, expectedRevision });
  }
  /** Listeners are installed before discovery. Expensive work never blocks this short scan or
   * the existing child/process continuation consumer. The map only joins live preparations. */
  async recover(): Promise<void> {
    if (this.stopped || this.suspended) return;
    this.dirty = true; if (this.pumping) return;
    this.pumping = true; const epoch = this.epoch;
    try {
      while (this.dirty && !epoch.signal.aborted) {
        this.dirty = false;
        const pending = await this.owners.runtime.calendarPending(epoch.signal);
        const wanted = new Set<string>();
        for (const calculation of pending.calculations) {
          const key = `calculation:${calculation.definition_id}:${calculation.revision}:${calculation.owner_epoch}`;
          wanted.add(key);
          this.startFlight(key, epoch.signal, async signal => {
            let result: ReturnType<typeof calculateCalendarSlots> | null = null;
            let failureCode: string | null = null;
            try { result = calculateCalendarSlots(calculation); }
            catch { failureCode = 'calendar_rule_calculation_failed'; }
            signal.throwIfAborted();
            await this.owners.runtime.calculatedCalendar({ calculation, result, failureCode }, signal);
          });
        }
        for (const occurrence of pending.preparations) {
          const key = `preparation:${occurrence.id}:${occurrence.revision}`;
          wanted.add(key);
          this.startFlight(key, epoch.signal, async signal => {
            const work = await this.owners.runtime.prepareCalendar({ occurrenceId: occurrence.id }, signal);
            try {
              const project = (await this.owners.projects()).find(value => value.id === work.definition.project_id);
              if (!project) throw new Error('Calendar project is unavailable');
              signal.throwIfAborted(); await this.owners.prepare(work, project.path, signal);
            } catch (error) {
              if (signal.aborted) throw error;
              if (error instanceof KernelClientError && error.code === 'activation-held') return;
              await this.owners.runtime.failCalendarPreparation({ occurrenceId: work.occurrence.id, expectedRevision: work.occurrence.revision,
                ownerEpoch: work.owner_epoch, failureCode: 'calendar_preparation_unavailable' }, signal);
            }
          });
        }
        for (const [key, flight] of this.flights) if (!wanted.has(key)) flight.controller.abort();
      }
    } catch (error) { if (!epoch.signal.aborted) this.owners.onError(error); }
    finally {
      this.pumping = false;
      if (epoch !== this.epoch && this.dirty && !this.stopped && !this.suspended) void this.recover();
    }
  }
  private startFlight(key: string, epoch: AbortSignal, work: (signal: AbortSignal) => Promise<void>): void {
    const existing = this.flights.get(key);
    if (existing) { existing.recheck = true; return; }
    const controller = new AbortController(), signal = AbortSignal.any([epoch, controller.signal]);
    const flight = { controller, work: Promise.resolve(), recheck: false };
    this.flights.set(key, flight);
    flight.work = work(signal).catch(error => { if (!signal.aborted) this.owners.onError(error); })
       .finally(() => {
        if (this.flights.get(key) !== flight) return;
        this.flights.delete(key);
        if (flight.recheck && !this.stopped && !this.suspended) void this.recover();
      });
  }
}
