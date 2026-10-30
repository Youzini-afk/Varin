import { describe, expect, it } from 'vitest';
import type { BotSummary, BotWorkItem } from '@varin/application-client';
import type { MessageFeedPage, Run } from '@varin/protocol';
import { threadSummary } from '@/test/threadFixtures';
import { buildTimeline, figureState, needsOf, runStatus, sessionViews, stateLine, workViews, type BotFigureFacts } from './botPresentation';

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
    const work = workViews([item], [], []);
    const sessions = sessionViews([{ identity: bot.entry, primary: true, thread: threadSummary('entry', { main_branch_id: 'main', branches: [{ branch_id: 'main', head: null, active_run_id: null, latest_run: null }] }) }], [], work);
    expect(sessions[0]!.waiting).toBe(true);
    const needs = needsOf(bot, sessions, work);
    expect(needs).toEqual([expect.objectContaining({ name: 'Writer', kind: 'question', session: false })]);
    expect(stateLine(bot, 'waiting', { needs, working: [], resultName: null })).toEqual(expect.objectContaining({ key: 'bot.state.waitingQuestion', params: { name: 'Writer' }, tone: 'warn' }));
  });

  it('returns reports to the conversation that dispatched them and records the user’s workbench messages', () => {
    const page = (sessionThreadId: string, patch: Partial<MessageFeedPage>): { sessionThreadId: string; page: MessageFeedPage } => ({ sessionThreadId, page: {
      rootThreadId: sessionThreadId, messages: [], participants: [{ threadId: 'writer', name: 'Writer', agentId: 'w', avatar: null }], before: null, after: null, eventCursor: 0, ...patch,
    } });
    const dispatch = { operationId: 'op1', executionId: 'e1', senderThreadId: 'trip', senderBranchId: 'tb', targetThreadId: 'writer', targetBranchId: 'wb', acceptedCursor: 1, acceptedAtMs: 1000, task: 'Draft the notes' };
    const report = { operationId: 'op1', executionId: 'e1', senderThreadId: 'writer', senderBranchId: 'wb', targetThreadId: 'trip', targetBranchId: 'tb', acceptedCursor: 3, acceptedAtMs: 3000, outcome: 'succeeded' as const, text: 'done' };
    const userMessage = { messageId: 'm1', senderThreadId: 'writer', senderBranchId: 'wb', targetThreadId: 'writer', targetBranchId: 'wb', actor: { kind: 'user' as const }, kind: 'request' as never,
      replyTo: null, acceptedCursor: 2, acceptedAtMs: 2000, state: 'delivered' as const, activation: null as never, replyWait: null, deliveredRunId: null, deliveredCursor: null, text: 'Use the short version' };
    const timeline = buildTimeline([
      page('trip', { dispatches: [dispatch], reports: [report], messages: [userMessage] }),
      // The same report seen from another conversation's family does not belong to it.
      page('everyday', { reports: [report] }),
    ], [{ id: 7, content: 'Pin versions before upgrading', trigger: '', createdAt: 500, revision: '1', sourceKind: null }]);
    expect(timeline.map(event => [event.kind, event.sessionThreadId])).toEqual([['report', 'trip'], ['you', 'trip'], ['dispatch', 'trip'], ['memory', null]]);
    expect(timeline[0]).toEqual(expect.objectContaining({ name: 'Writer', session: { runtime: 'agent', threadId: 'trip', branchId: 'tb' } }));
  });
});
