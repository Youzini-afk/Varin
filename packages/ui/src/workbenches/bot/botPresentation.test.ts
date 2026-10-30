import { describe, expect, it } from 'vitest';
import type { BotSummary, BotWorkItem } from '@varin/application-client';
import type { BotActivityEvent, BotActivityPage, Run } from '@varin/protocol';
import { threadSummary } from '@/test/threadFixtures';
import { buildTimeline, figureState, groupByDay, needsOf, runStatus, sessionViews, stateLine, workViews, type BotFigureFacts } from './botPresentation';
import { withEarlierPage, withNewestPage } from './useBotFacts';

const facts = (patch: Partial<BotFigureFacts> = {}): BotFigureFacts => ({ offline: false, activity: 'awake', inactive: false, needs: 0, result: false, thinking: false, working: 0, listening: false, ...patch });
const run = (patch: Partial<Run>): Run => ({ id: 'run', thread_id: 't', branch_id: 'b', state: 'executing', waiting_on: null, revision: 1, epoch: 1, configuration: null, cancel_requested: false, ...patch });
const bot: BotSummary = { id: 'a', name: 'Varin', entry: { runtime: 'agent', threadId: 'entry', branchId: 'main' }, archived: false, homeDir: '/a', coordinatorHostId: 'h', instructions: null, model: null, createdAt: '', updatedAt: '' };

describe('Bot presentation', () => {
  it('takes the figure state in the documented priority order', () => {
    const everything = facts({ offline: true, activity: 'waking', needs: 1, result: true, thinking: true, working: 2, listening: true });
    expect(figureState(everything)).toBe('offline');
    expect(figureState({ ...everything, offline: false })).toBe('waking');
    expect(figureState({ ...everything, offline: false, activity: 'asleep' })).toBe('sleeping');
    expect(figureState({ ...everything, offline: false, activity: 'awake' })).toBe('waiting');
    expect(figureState(facts({ result: true, thinking: true, working: 1 }))).toBe('result');
    expect(figureState(facts({ thinking: true, working: 1, listening: true }))).toBe('thinking');
    expect(figureState(facts({ working: 1, listening: true }))).toBe('working');
    expect(figureState(facts({ listening: true }))).toBe('listening');
    expect(figureState(facts())).toBe('idle');
  });

  it('keeps a requested stop apart from a stopped run, and waits for the user apart from other waits', () => {
    expect(runStatus(run({ cancel_requested: true }))).toBe('stopping');
    expect(runStatus(run({ state: 'cancelled', cancel_requested: true }))).toBeNull();
    expect(runStatus(run({ state: 'waiting', waiting_on: 'permission:write' }))).toBe('waiting-permission');
    expect(runStatus(run({ state: 'waiting', waiting_on: 'question:ask' }))).toBe('waiting-question');
    expect(runStatus(run({ state: 'waiting', waiting_on: 'child:other' }))).toBe('running');
    expect(runStatus(run({ state: 'runnable' }))).toBe('queued');
  });

  it('reports a session’s own wait and its delegated waits as needing the user', () => {
    const waiting = run({ id: 'r1', thread_id: 'child', branch_id: 'cb', state: 'waiting', waiting_on: 'question:q' });
    const item: BotWorkItem = { runtime: 'agent', identity: { runtime: 'agent', threadId: 'child', branchId: 'cb' }, purpose: 'work', activeRun: waiting, sessionThreadId: 'entry',
      thread: threadSummary('child', { title: 'Writer', main_branch_id: 'cb', branches: [{ branch_id: 'cb', head: null, active_run_id: 'r1', latest_run: waiting }] }) };
    const work = workViews([item], [], null);
    const sessions = sessionViews([{ identity: bot.entry, primary: true, thread: threadSummary('entry', { main_branch_id: 'main', branches: [{ branch_id: 'main', head: null, active_run_id: null, latest_run: null }] }) }], [], work);
    expect(sessions[0]!.waiting).toBe(true);
    const needs = needsOf(bot, sessions, work);
    expect(needs).toEqual([expect.objectContaining({ name: 'Writer', kind: 'question', session: false })]);
    expect(stateLine(bot, 'waiting', { needs, working: [], resultName: null })).toEqual(expect.objectContaining({ key: 'bot.state.waitingQuestion', params: { name: 'Writer' }, tone: 'warn' }));
  });

  describe('timeline', () => {
    const session = { sessionThreadId: 'trip', sessionBranchId: 'tb' };
    const participants = [{ threadId: 'writer', name: 'Writer', agentId: 'w', avatar: null }];
    const events: BotActivityEvent[] = [
      { ...session, cursor: 9, atMs: 9000, kind: 'quiet', runId: 'r9', inputs: [
        { origin: 'message', threadId: 'writer', branchId: 'wb', change: null },
        { origin: 'work_event', threadId: 'writer', branchId: 'wb', change: 'user_input' },
      ] },
      { ...session, cursor: 7, atMs: 7000, kind: 'schedule', occurrenceId: 'o', definitionId: 'd', name: 'Morning brief', state: 'failed' },
      { ...session, cursor: 5, atMs: 5000, kind: 'report', operationId: 'op1', executionId: 'e1', threadId: 'writer', branchId: 'wb', outcome: 'succeeded' },
      { ...session, cursor: 4, atMs: 4000, kind: 'change', change: 'workspace_change', threadId: 'writer', branchId: 'wb' },
      // Recorded before the runtime kept wall times: it stays in place and shows no time.
      { ...session, cursor: 2, atMs: null, kind: 'dispatch', operationId: 'op1', executionId: 'e1', threadId: 'writer', branchId: 'wb', task: 'Draft the notes', preset: null },
    ];
    const memory = [
      { id: 7, content: 'Pin versions before upgrading', trigger: '', createdAt: 6000, revision: '1', sourceKind: null },
      { id: 3, content: 'Prefers short notes', trigger: '', createdAt: 1000, revision: '1', sourceKind: null },
    ];

    it('names each fact, keeps the activity order and merges memory by time', () => {
      const timeline = buildTimeline({ events, participants, before: null }, memory);
      expect(timeline.map(event => event.kind)).toEqual(['quiet', 'schedule', 'memory', 'report', 'you', 'dispatch', 'memory']);
      expect(timeline[0]).toEqual(expect.objectContaining({ kind: 'quiet', inputs: [
        { kind: 'report', name: 'Writer', target: { runtime: 'agent', threadId: 'writer', branchId: 'wb' } },
        { kind: 'change', name: 'Writer', target: { runtime: 'agent', threadId: 'writer', branchId: 'wb' } },
      ] }));
      expect(timeline[3]).toEqual(expect.objectContaining({ name: 'Writer', session: { runtime: 'agent', threadId: 'trip', branchId: 'tb' } }));
      expect(timeline[4]).toEqual(expect.objectContaining({ kind: 'you', change: 'workspace_change' }));
      expect(groupByDay(timeline).flatMap(group => group.events)).toHaveLength(timeline.length);
    });

    it('holds back memory older than the loaded window until the earlier pages arrive', () => {
      const window = buildTimeline({ events: events.slice(0, 3), participants, before: 5 }, memory);
      expect(window.map(event => event.kind)).toEqual(['quiet', 'schedule', 'memory', 'report']);
      // A window without any recorded time cannot place memory at all.
      expect(buildTimeline({ events: events.slice(4), participants, before: 2 }, memory).map(event => event.kind)).toEqual(['dispatch']);
    });

    it('keeps an untimed leading fact in a group of its own and later ones with the day above them', () => {
      const untimed = { id: 'a', atMs: null };
      const today = new Date(2026, 9, 30, 10).getTime();
      expect(groupByDay([untimed, { id: 'b', atMs: today }, { id: 'c', atMs: null }]).map(group => [group.day, group.events.map(event => event.id)]))
        .toEqual([[null, ['a']], [new Date(2026, 9, 30).getTime(), ['b', 'c']]]);
    });

    it('extends the loaded pages only when the fresh page reaches them', () => {
      const page = (cursors: number[], before: number | null): BotActivityPage => ({ botId: 'a', eventCursor: 20, participants, before,
        events: cursors.map(cursor => ({ ...session, cursor, atMs: cursor, kind: 'change', change: 'user_input', threadId: 'writer', branchId: 'wb' })) });
      const loaded = withEarlierPage({ events: page([6, 5], 5).events, participants, before: 5 }, page([4, 3], 3));
      expect(loaded.events.map(event => event.cursor)).toEqual([6, 5, 4, 3]);
      expect(loaded.before).toBe(3);
      const touching = withNewestPage(loaded, page([8, 7, 6], 6));
      expect(touching.events.map(event => event.cursor)).toEqual([8, 7, 6, 5, 4, 3]);
      expect(touching.before).toBe(3);
      // More new facts than one page: the gap below it is unknown, so only the fresh page stays.
      const gap = withNewestPage(loaded, page([12, 11], 11));
      expect(gap.events.map(event => event.cursor)).toEqual([12, 11]);
      expect(gap.before).toBe(11);
    });
  });
});
