import type { BotActivity, BotMemoryItem, BotPresence, BotSession, BotSummary, BotWorkItem, ThreadIdentity } from '@varin/application-client';
import type { BotActivityEvent, BotActivityInput, CalendarOccurrenceState, MessageParticipant, Outcome, Run, RunState, ThreadSummary } from '@varin/protocol';
import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';

/**
 * Pure projections for the Bot workbench (docs/design/bot-ui.md §5). Every value is derived from
 * Host facts already in the UI: the Bot record, its sessions and work, the live Thread catalog,
 * the Host's presence projection, the Bot's activity pages and memory. Nothing here is stored.
 */

export type BotFigureState = 'offline' | 'sleeping' | 'waking' | 'waiting' | 'result' | 'thinking' | 'working' | 'listening' | 'idle';

/** What a piece of active work is doing. Stopping keeps "asked to stop" apart from "stopped". */
export type BotWorkStatus = 'waiting-permission' | 'waiting-question' | 'running' | 'preparing' | 'queued' | 'paused' | 'stopping';

const ACTIVE_RUN_STATES: readonly RunState[] = ['accepted', 'preparing', 'runnable', 'generating', 'executing', 'waiting'];
export const isActiveRun = (run: Run | null | undefined): run is Run => Boolean(run && ACTIVE_RUN_STATES.includes(run.state));

export function runStatus(run: Run | null | undefined): BotWorkStatus | null {
  if (!isActiveRun(run)) return null;
  if (run.cancel_requested) return 'stopping';
  if (run.state === 'waiting') {
    const on = run.waiting_on ?? '';
    if (on.startsWith('permission:')) return 'waiting-permission';
    if (on.startsWith('question:')) return 'waiting-question';
    if (on.startsWith('policy-pause:')) return 'paused';
    return 'running';
  }
  if (run.state === 'preparing') return 'preparing';
  if (run.state === 'accepted' || run.state === 'runnable') return 'queued';
  return 'running';
}
export const isWaitingStatus = (status: BotWorkStatus | null): status is 'waiting-permission' | 'waiting-question' => status === 'waiting-permission' || status === 'waiting-question';

/** The branch's current Run from the live catalog; the work list's copy only when the catalog lacks the Thread. */
export function liveRun(thread: ThreadSummary | undefined, branchId: string, fallback: Run | null): Run | null {
  const branch = thread?.branches.find(candidate => candidate.branch_id === branchId);
  if (!branch) return fallback;
  const run = branch.latest_run;
  return run && (branch.active_run_id === run.id || isActiveRun(run)) ? run : null;
}

export interface BotWorkView {
  key: string;
  identity: ThreadIdentity;
  /** The executor's name; the task title when no participant name is known. */
  name: string;
  task: string;
  avatar: string | null;
  /** The Bot conversation the work reports back to; null when the Host could not attribute it. */
  sessionThreadId: string | null;
  /** The session handed this work over directly, so it leads that task; its own helpers do not. */
  lead: boolean;
  status: BotWorkStatus | null;
  updatedAtMs: number;
}

export const workKey = (identity: ThreadIdentity): string => `${identity.threadId}\u0000${identity.branchId}`;

/**
 * The loaded part of a Bot's activity, newest first, with names for the threads it mentions.
 * `before` is the cursor of the next older page; null once the start is loaded.
 */
export interface BotActivityView {
  events: readonly BotActivityEvent[];
  participants: readonly MessageParticipant[];
  before: number | null;
}

/** Delegated work of one Bot with its live state. Followed and session items are not delegated work. */
export function workViews(items: readonly BotWorkItem[], threads: readonly ThreadSummary[], activity: BotActivityView | null): BotWorkView[] {
  const participants = new Map((activity?.participants ?? []).map(participant => [participant.threadId, participant] as const));
  // Events are newest first, so the first dispatch seen is the latest task for that work.
  const tasks = new Map<string, string>();
  for (const event of activity?.events ?? []) {
    if (event.kind !== 'dispatch') continue;
    const key = workKey({ runtime: 'agent', threadId: event.threadId, branchId: event.branchId });
    if (!tasks.has(key)) tasks.set(key, event.task);
  }
  return items.filter(item => item.purpose === 'work').map(item => {
    const thread = threads.find(candidate => candidate.thread_id === item.identity.threadId) ?? item.thread;
    const participant = participants.get(item.identity.threadId);
    const key = workKey(item.identity);
    return {
      key,
      identity: item.identity,
      name: participant?.name || thread.title || item.identity.threadId,
      task: tasks.get(key) ?? '',
      avatar: participant?.avatar ?? thread.avatar ?? null,
      sessionThreadId: item.sessionThreadId ?? null,
      lead: !!item.sessionThreadId && thread.parent_thread_id === item.sessionThreadId,
      status: runStatus(liveRun(thread, item.identity.branchId, item.activeRun)),
      updatedAtMs: thread.updated_at_ms,
    };
  });
}

/** One Bot conversation as the sidebar and panel show it. */
export interface BotSessionView {
  identity: ThreadIdentity;
  thread: ThreadSummary;
  primary: boolean;
  /** Branches other than the main one, oldest first. */
  branches: ThreadIdentity[];
  running: boolean;
  /** Its own Run or work it dispatched waits for the user. */
  waiting: boolean;
  unread: boolean;
}

export function sessionViews(sessions: readonly BotSession[], threads: readonly ThreadSummary[], work: readonly BotWorkView[]): BotSessionView[] {
  return sessions.map(session => {
    const thread = threads.find(candidate => candidate.thread_id === session.identity.threadId) ?? session.thread;
    const runs = thread.branches.map(branch => runStatus(liveRun(thread, branch.branch_id, null)));
    const delegated = work.filter(item => item.sessionThreadId === thread.thread_id);
    return {
      identity: session.identity,
      thread,
      primary: session.primary,
      branches: thread.branches.filter(branch => branch.branch_id !== thread.main_branch_id)
        .map(branch => ({ runtime: 'agent' as const, threadId: thread.thread_id, branchId: branch.branch_id })),
      running: runs.some(status => status !== null && !isWaitingStatus(status)),
      waiting: runs.some(isWaitingStatus) || delegated.some(item => isWaitingStatus(item.status)),
      unread: thread.unread,
    };
  });
}

export interface BotNeed {
  key: string;
  identity: ThreadIdentity;
  name: string;
  avatar: string | null;
  lead: boolean;
  kind: 'permission' | 'question';
  /** True for the Bot's own conversation, which is handled in Bot mode rather than the workbench. */
  session: boolean;
}

export function needsOf(bot: BotSummary, sessions: readonly BotSessionView[], work: readonly BotWorkView[]): BotNeed[] {
  const needs: BotNeed[] = [];
  for (const session of sessions) {
    for (const branch of session.thread.branches) {
      const status = runStatus(liveRun(session.thread, branch.branch_id, null));
      if (!isWaitingStatus(status)) continue;
      const identity = { runtime: 'agent' as const, threadId: session.thread.thread_id, branchId: branch.branch_id };
      needs.push({ key: workKey(identity), identity, name: bot.name, avatar: null, lead: false, kind: status === 'waiting-permission' ? 'permission' : 'question', session: true });
    }
  }
  for (const item of work) {
    if (!isWaitingStatus(item.status)) continue;
    needs.push({ key: item.key, identity: item.identity, name: item.name, avatar: item.avatar, lead: item.lead, kind: item.status === 'waiting-permission' ? 'permission' : 'question', session: false });
  }
  return needs;
}

/** The Host's presence projection in the shape the panel lists needs. A delegated need leads
 * its task when the Thread directory shows a session of this Bot handed it over directly. */
export const presenceNeeds = (presence: BotPresence, threads: readonly ThreadSummary[] = []): BotNeed[] => {
  const byId = new Map(threads.map(thread => [thread.thread_id, thread]));
  return presence.needs.map(need => {
    const parent = need.session ? undefined : byId.get(byId.get(need.identity.threadId)?.parent_thread_id ?? '');
    return { ...need, key: workKey(need.identity), lead: parent?.bot_id === presence.botId && !parent.parent_thread_id };
  });
};

export interface BotFigureFacts {
  offline: boolean;
  activity: BotActivity['state'] | undefined;
  inactive: boolean;
  needs: number;
  result: boolean;
  thinking: boolean;
  working: number;
  listening: boolean;
}

/** §5.7, highest priority first. */
export function figureState(facts: BotFigureFacts): BotFigureState {
  if (facts.offline) return 'offline';
  if (facts.activity === 'waking') return 'waking';
  if ((facts.activity && facts.activity !== 'awake') || facts.inactive) return 'sleeping';
  if (facts.needs > 0) return 'waiting';
  if (facts.result) return 'result';
  if (facts.thinking) return 'thinking';
  if (facts.working > 0) return 'working';
  if (facts.listening) return 'listening';
  return 'idle';
}

export interface BotStateLine {
  key: I18nKey;
  params?: Record<string, string | number>;
  tone: 'warn' | 'none';
  /** The line ends with a wake control. */
  wake?: boolean;
  /** Worth announcing to assistive technology (§9). */
  announce?: boolean;
}

/** A neutral statement of the real state. It never speaks as the model. */
export function stateLine(bot: BotSummary, state: BotFigureState, details: { needs: readonly BotNeed[]; working: readonly { name: string }[]; resultName: string | null }): BotStateLine {
  switch (state) {
    case 'offline': return { key: 'bot.state.offline', tone: 'none', announce: true };
    case 'waking': return { key: 'bot.state.waking', tone: 'none' };
    case 'sleeping': {
      if (bot.deletion) return { key: bot.deletion.error ? 'settings.bots.deleteFailed' : 'settings.bots.deleting', tone: bot.deletion.error ? 'warn' : 'none' };
      if (bot.archived) return { key: 'bot.state.archived', tone: 'none' };
      const activity = bot.activity?.state;
      if (activity === 'sleeping') return { key: 'bot.state.goingToSleep', tone: 'none' };
      if (activity === 'sleep-failed') return { key: 'bot.state.sleepFailed', tone: 'warn' };
      if (activity === 'wake-failed') return { key: 'bot.state.wakeFailed', tone: 'warn', wake: true };
      return { key: 'bot.state.sleeping', tone: 'none', wake: true };
    }
    case 'waiting': {
      const [first] = details.needs;
      if (details.needs.length > 1 || !first) return { key: 'bot.state.waitingMany', params: { count: details.needs.length }, tone: 'warn', announce: true };
      return { key: first.kind === 'permission' ? 'bot.state.waitingPermission' : 'bot.state.waitingQuestion', params: { name: first.name }, tone: 'warn', announce: true };
    }
    case 'result': return { key: 'bot.state.result', params: { name: details.resultName ?? bot.name }, tone: 'none', announce: true };
    case 'thinking': return { key: 'bot.state.thinking', tone: 'none' };
    case 'working': {
      const [first] = details.working;
      return details.working.length === 1 && first
        ? { key: 'bot.state.workingOne', params: { name: first.name }, tone: 'none' }
        : { key: 'bot.state.workingMany', params: { count: details.working.length }, tone: 'none' };
    }
    case 'listening': return { key: 'bot.state.listening', tone: 'none' };
    default: return { key: 'bot.state.idle', tone: 'none' };
  }
}

const STATE_ICON: Partial<Record<I18nKey, IconName>> = {
  'bot.state.offline': 'cloud-off',
  'bot.state.waking': 'loader-4',
  'bot.state.goingToSleep': 'moon',
  'bot.state.sleeping': 'moon',
  'bot.state.sleepFailed': 'error-warning',
  'bot.state.wakeFailed': 'error-warning',
  'bot.state.archived': 'archive',
  'settings.bots.deleting': 'delete-bin',
  'settings.bots.deleteFailed': 'error-warning',
  'bot.state.waitingPermission': 'shield-check',
  'bot.state.waitingQuestion': 'question',
  'bot.state.waitingMany': 'notification-3',
  'bot.state.result': 'check',
  'bot.state.thinking': 'sparkling',
  'bot.state.workingOne': 'pulse',
  'bot.state.workingMany': 'pulse',
  'bot.state.listening': 'chat-3',
};
/** The small mark before the state line; it turns only while something is in transition. */
export const stateIcon = (line: BotStateLine): { icon: IconName; spin: boolean } =>
  ({ icon: STATE_ICON[line.key] ?? 'emotion-happy', spin: line.key === 'bot.state.waking' });

/** The pale word beside a Bot in the sidebar; empty when there is nothing to say. */
export function shortState(state: BotFigureState): { key: I18nKey; tone: 'warn' | 'none' } | null {
  if (state === 'sleeping') return { key: 'bot.short.sleeping', tone: 'none' };
  if (state === 'offline') return { key: 'bot.short.offline', tone: 'none' };
  if (state === 'waiting') return { key: 'bot.short.waiting', tone: 'warn' };
  if (state === 'working' || state === 'thinking') return { key: 'bot.short.working', tone: 'none' };
  return null;
}

/** What a quiet round consumed, as the timeline names it. */
export interface BotQuietInput { kind: 'report' | 'change' | 'schedule' | 'other'; name: string | null; target: ThreadIdentity | null }

export type BotTimelineEvent = {
  id: string;
  /** Null for facts the runtime recorded before it kept their wall time. */
  atMs: number | null;
  /** The Bot conversation the event belongs to. */
  sessionThreadId: string | null;
} & (
  | { kind: 'dispatch'; name: string; task: string; target: ThreadIdentity }
  | { kind: 'report'; name: string; outcome: Outcome; source: ThreadIdentity; session: ThreadIdentity }
  | { kind: 'you'; name: string; change: 'user_input' | 'workspace_change' | 'history_changed'; target: ThreadIdentity }
  | { kind: 'quiet'; session: ThreadIdentity; inputs: BotQuietInput[] }
  | { kind: 'schedule'; name: string; state: CalendarOccurrenceState; session: ThreadIdentity }
  | { kind: 'memory'; content: string; memoryId: number }
);

const quietInput = (input: BotActivityInput, nameOf: (threadId: string) => string): BotQuietInput => {
  const target = input.threadId && input.branchId ? { runtime: 'agent' as const, threadId: input.threadId, branchId: input.branchId } : null;
  const name = input.threadId ? nameOf(input.threadId) : null;
  if (input.origin === 'message' || (input.origin === 'work_event' && (input.change === 'run_report' || input.change === 'external_report'))) return { kind: 'report', name, target };
  if (input.origin === 'work_event' && (input.change === 'user_input' || input.change === 'workspace_change' || input.change === 'history_changed')) return { kind: 'change', name, target };
  if (input.origin === 'calendar') return { kind: 'schedule', name: null, target: null };
  return { kind: 'other', name, target };
};

/**
 * The work as it happened: what was handed out, what came back, what the user changed in the work,
 * rounds that ended without disturbing the user, schedules and what was remembered. Activity keeps
 * its original order. Memory has no event cursor: while older pages remain, only memory newer than
 * the oldest loaded fact with a time belongs here, and the rest arrives with the earlier pages.
 */
export function buildTimeline(activity: BotActivityView | null, memory: readonly BotMemoryItem[] | null): BotTimelineEvent[] {
  const names = new Map((activity?.participants ?? []).map(participant => [participant.threadId, participant.name]));
  const nameOf = (threadId: string) => names.get(threadId) || threadId;
  const identity = (threadId: string, branchId: string): ThreadIdentity => ({ runtime: 'agent', threadId, branchId });
  const facts = (activity?.events ?? []).map((event): BotTimelineEvent => {
    const base = { id: `${event.kind}:${event.cursor}`, atMs: event.atMs, sessionThreadId: event.sessionThreadId };
    const session = identity(event.sessionThreadId, event.sessionBranchId);
    switch (event.kind) {
      case 'dispatch': return { ...base, kind: 'dispatch', name: nameOf(event.threadId), task: event.task, target: identity(event.threadId, event.branchId) };
      case 'report': return { ...base, kind: 'report', name: nameOf(event.threadId), outcome: event.outcome, source: identity(event.threadId, event.branchId), session };
      case 'change': return { ...base, kind: 'you', name: nameOf(event.threadId), change: event.change, target: identity(event.threadId, event.branchId) };
      case 'quiet': return { ...base, kind: 'quiet', session, inputs: event.inputs.map(input => quietInput(input, nameOf)) };
      case 'schedule': return { ...base, kind: 'schedule', name: event.name, state: event.state, session };
    }
  });
  const known = facts.flatMap(event => event.atMs === null ? [] : [event.atMs]);
  const floor = activity?.before == null ? -Infinity : known.length ? Math.min(...known) : Infinity;
  const remembered = (memory ?? []).filter(item => !item.inactive && item.createdAt >= floor).sort((a, b) => b.createdAt - a.createdAt)
    .map((item): BotTimelineEvent => ({ id: `memory:${item.id}`, atMs: item.createdAt, sessionThreadId: null, kind: 'memory', content: item.content, memoryId: item.id }));
  const timeline: BotTimelineEvent[] = [];
  let next = 0;
  for (const event of facts) {
    if (event.atMs !== null) while (next < remembered.length && remembered[next]!.atMs! > event.atMs) timeline.push(remembered[next++]!);
    timeline.push(event);
  }
  return [...timeline, ...remembered.slice(next)];
}

/** The latest report that came back to any of the Bot's conversations. */
export function latestReport(timeline: readonly BotTimelineEvent[]): Extract<BotTimelineEvent, { kind: 'report' }> | null {
  return timeline.find((event): event is Extract<BotTimelineEvent, { kind: 'report' }> => event.kind === 'report') ?? null;
}

const startOfDay = (ms: number) => { const date = new Date(ms); date.setHours(0, 0, 0, 0); return date.getTime(); };
/**
 * Groups events by local day, newest first, keeping their order inside each day. An event without
 * a recorded time stays where it happened, in the day above it; a leading one gets a group of its own.
 */
export function groupByDay<T extends { atMs: number | null }>(events: readonly T[]): Array<{ day: number | null; events: T[] }> {
  const groups: Array<{ day: number | null; events: T[] }> = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (event.atMs === null) {
      if (last) last.events.push(event); else groups.push({ day: null, events: [event] });
      continue;
    }
    const day = startOfDay(event.atMs);
    if (last?.day === day) last.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups;
}
export function dayLabel(day: number, now: number, locale: string): { key: 'bot.activity.today' | 'bot.activity.yesterday' } | { text: string } {
  const today = startOfDay(now);
  if (day === today) return { key: 'bot.activity.today' };
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return { key: 'bot.activity.yesterday' };
  return { text: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', weekday: 'short' }).format(day) };
}
export const clockTime = (ms: number, locale: string): string => new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(ms);
/** Today shows the time; later days add the date. */
export function scheduleWhen(atMs: number, locale: string, now = Date.now()): string {
  const time = clockTime(atMs, locale);
  return startOfDay(atMs) === startOfDay(now) ? time : `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(atMs)} ${time}`;
}

/** Words for where a memory came from; an unrecognised kind is shown as the Host wrote it. */
const MEMORY_SOURCE: Record<string, I18nKey> = {
  'agent-memory': 'bot.memory.source.agent',
  'memory-organizer': 'bot.memory.source.organizer',
  'user-correction': 'bot.memory.source.correction',
  'user-extracted': 'bot.memory.source.saved',
};
export const memorySourceLabel = (kind: string | null, t: (key: I18nKey) => string): string =>
  kind === null ? t('bot.memory.direct') : MEMORY_SOURCE[kind] ? t(MEMORY_SOURCE[kind]) : kind;

/** Splits a translated sentence around the name so the name can be set in bold (§5.4). */
export const NAME_MARK = '\u0000';
export function splitNamed(text: string): { before: string; after: string } | null {
  const index = text.indexOf(NAME_MARK);
  return index < 0 ? null : { before: text.slice(0, index), after: text.slice(index + NAME_MARK.length) };
}
