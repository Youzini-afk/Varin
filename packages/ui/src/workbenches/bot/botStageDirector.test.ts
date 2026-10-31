import { describe, expect, it } from 'vitest';
import type { ThreadAttentionBranch, ThreadAttentionDelegation, ThreadAttentionRun, ThreadAttentionSnapshot, ThreadAttentionTeamExecution } from '@varin/application-client';
import { BotStageDirector, type BotLiveRound } from './botStageDirector';

const key = (threadId: string) => JSON.stringify([threadId, 'main']);
const run = (id: string, state: ThreadAttentionRun['state'], patch: Partial<ThreadAttentionRun> = {}): ThreadAttentionRun =>
  ({ id, state, revision: 1, cancelRequested: false, visibleOutput: null, ...patch });
const branch = (threadId: string, patch: Partial<ThreadAttentionBranch> = {}): ThreadAttentionBranch => ({
  threadId, branchId: 'main', title: threadId, parentThreadId: null, archived: false, deleted: false, botId: 'bot', botSessionThreadId: 'chat',
  activeRunId: null, currentRun: null, latestRun: null, hasUnsettledWork: false, ...patch,
});
const delegation = (parent: string, child: string, patch: Partial<ThreadAttentionDelegation> = {}): ThreadAttentionDelegation => ({
  operationId: `op-${child}`, parentThreadId: parent, parentBranchId: 'main', parentRunId: `run-${parent}`, childThreadId: child, childBranchId: 'main',
  acceptedCursor: null, continuedCursor: null, continuedByThreadId: null, reportCursor: null, reportOutcome: null, ...patch,
});
const execution = (parent: string, child: string, patch: Partial<ThreadAttentionTeamExecution> = {}): ThreadAttentionTeamExecution => ({
  parentThreadId: parent, parentBranchId: 'main', parentRunId: `run-${parent}`, childOperationId: `op-${child}`, executionId: `ex-${child}`,
  childThreadId: child, childBranchId: 'main', state: 'running', childRunId: null, childRunState: null, activity: 'running', ...patch,
});
const snapshot = (eventCursor: number, patch: Partial<ThreadAttentionSnapshot> = {}): ThreadAttentionSnapshot => ({
  epoch: 1, eventCursor, coverage: { native: 'complete', external: 'unsupported', scope: 'host' }, branches: [], items: [], deliveredReports: [],
  teamExecutions: [], delegations: [], follows: [], counts: { actionRequired: 0, affectedBranches: 0, unknownEffects: 0 }, ...patch,
});
// Her conversation, a lead it handed work to, and the lead's own helper.
const chat = (current: ThreadAttentionRun | null = run('r1', 'executing'), latest: ThreadAttentionRun | null = current) =>
  branch('chat', { currentRun: current, latestRun: latest, activeRunId: current?.id ?? null });
const research = branch('research', { parentThreadId: 'chat' });
const notes = branch('notes', { parentThreadId: 'research' });
const observe = (director: BotStageDirector, value: ThreadAttentionSnapshot, live: BotLiveRound | null = null, now = 0) =>
  director.observe({ snapshot: value, botId: 'bot', live, preferThreadId: 'chat', now });

describe('Bot stage facts', () => {
  it('seats leads under her conversation with their helpers, and replays nothing on the first read', () => {
    const director = new BotStageDirector();
    const { view, events } = observe(director, snapshot(10, {
      branches: [chat(), research, notes, branch('other-bot', { botId: 'b2', botSessionThreadId: 'other-bot' })],
      delegations: [delegation('chat', 'research', { acceptedCursor: 5 }), delegation('research', 'notes', { acceptedCursor: 7 })],
      teamExecutions: [execution('chat', 'research'), execution('research', 'notes', { activity: 'waiting' })],
    }));
    expect(events).toEqual([]);
    expect(view.leads).toMatchObject([{ key: key('research'), sessionThreadId: 'chat', status: 'thinking', subs: [{ key: key('notes'), status: 'waiting' }] }]);
  });

  it('turns cursors inside the window into moments: dispatch, report, leave, taking in, completion', () => {
    const director = new BotStageDirector();
    observe(director, snapshot(4, { branches: [chat(), research, notes] }), null, 0);
    const accepted = [delegation('chat', 'research', { acceptedCursor: 5 }), delegation('research', 'notes', { acceptedCursor: 7 })];
    const working = [execution('chat', 'research'), execution('research', 'notes')];
    expect(observe(director, snapshot(8, { branches: [chat(), research, notes], delegations: accepted, teamExecutions: working })).events)
      .toEqual([{ kind: 'dispatch', lead: key('research') }, { kind: 'sub-dispatch', lead: key('research'), sub: key('notes') }]);
    const reported = [delegation('chat', 'research', { acceptedCursor: 5, reportCursor: 11, reportOutcome: 'succeeded' }), delegation('research', 'notes', { acceptedCursor: 7, reportCursor: 9, reportOutcome: 'succeeded' })];
    expect(observe(director, snapshot(12, { branches: [chat(), research, notes], delegations: reported, teamExecutions: [] })).events).toEqual([
      { kind: 'sub-report', lead: key('research'), sub: key('notes'), outcome: 'ok' },
      { kind: 'lead-report', lead: key('research'), outcome: 'ok' },
      { kind: 'leave', lead: key('research') },
    ]);
    const delivered = [{ parentThreadId: 'chat', parentBranchId: 'main', parentRunId: 'r1', receivingRunId: 'r1', childOperationId: 'op-research', executionId: 'ex-research', childThreadId: 'research', childBranchId: 'main', deliveredCursor: 13 }];
    expect(observe(director, snapshot(14, { branches: [chat(), research, notes], delegations: reported, deliveredReports: delivered })).events)
      .toEqual([{ kind: 'gather', count: 1, outcome: 'ok' }]);
    // The round ends with a reply and nobody is still working: complete, and large because a helper was involved.
    const done = chat(null, run('r1', 'completed', { visibleOutput: true }));
    expect(observe(director, snapshot(16, { branches: [done, research, notes], delegations: reported, deliveredReports: delivered })).events)
      .toEqual([{ kind: 'complete', weight: 'large', outcome: 'ok' }]);
  });

  it('calls a reply with members still working a reply, and a quiet round nothing', () => {
    const director = new BotStageDirector();
    const team = { delegations: [delegation('chat', 'research', { acceptedCursor: 2 })], teamExecutions: [execution('chat', 'research')] };
    observe(director, snapshot(4, { branches: [chat(), research], ...team }));
    expect(observe(director, snapshot(6, { branches: [chat(null, run('r1', 'completed', { visibleOutput: true })), research], ...team })).events).toEqual([{ kind: 'reply', outcome: 'ok' }]);
    observe(director, snapshot(8, { branches: [chat(run('r2', 'generating')), research], ...team }));
    expect(observe(director, snapshot(10, { branches: [chat(null, run('r2', 'completed', { visibleOutput: false })), research], ...team })).events).toEqual([]);
  });

  it('marks what needs you on the member and notices when you answered it', () => {
    const director = new BotStageDirector();
    const team = { delegations: [delegation('chat', 'research', { acceptedCursor: 2 })], teamExecutions: [execution('chat', 'research')] };
    observe(director, snapshot(4, { branches: [chat(), research], ...team }));
    const item = { key: 'need', threadId: 'research', branchId: 'main', runId: 'rr', revision: 5, kind: 'permission' as const, actionable: true };
    const asked = observe(director, snapshot(6, { branches: [chat(), research], ...team, items: [item] }));
    expect(asked.events).toEqual([{ kind: 'needs', member: key('research') }]);
    expect(asked.view.leads[0]?.status).toBe('needs');
    expect(observe(director, snapshot(8, { branches: [chat(), research], ...team })).events).toEqual([{ kind: 'resolved', member: key('research') }]);
  });

  it('takes her prop from the open conversation and only the coarse phase otherwise', () => {
    const director = new BotStageDirector();
    const branches = [chat(run('r1', 'executing'))];
    expect(observe(director, snapshot(2, { branches })).view.own).toMatchObject({ phase: 'tool', tool: 'other', subject: null });
    const live: BotLiveRound = { threadId: 'chat', branchId: 'main', runId: 'r1', text: null, tools: [{ name: 'file_read', subject: 'a.md', units: 1 }, { name: 'file_edit', subject: 'notes.md', units: 1 }] };
    expect(observe(director, snapshot(3, { branches }), live).view.own).toMatchObject({ phase: 'tool', tool: 'edit', subject: 'notes.md', count: 1 });
    const reading: BotLiveRound = { ...live, tools: [{ name: 'file_read', subject: 'a.md', units: 1 }, { name: 'file_read', subject: null, units: 2 }] };
    expect(observe(director, snapshot(4, { branches }), reading).view.own).toMatchObject({ tool: 'read', subject: null, count: 3 });
    const replying = [chat(run('r1', 'generating', { generation: { requestId: 'q', phase: 'output', revision: 4 } }))];
    expect(observe(director, snapshot(5, { branches: replying })).view.own).toMatchObject({ phase: 'replying' });
    // A phase whose durable event is newer than the read is not trusted yet.
    const early = [chat(run('r1', 'generating', { generation: { requestId: 'q', phase: 'output', revision: 9 } }))];
    expect(observe(director, snapshot(6, { branches: early })).view.own).toMatchObject({ phase: 'thinking' });
  });

  it('starts over without moments for another store epoch or another Bot', () => {
    const director = new BotStageDirector();
    observe(director, snapshot(4, { branches: [chat(), research] }));
    const accepted = { delegations: [delegation('chat', 'research', { acceptedCursor: 5 })], teamExecutions: [execution('chat', 'research')] };
    expect(observe(director, { ...snapshot(8, { branches: [chat(), research], ...accepted }), epoch: 2 }).events).toEqual([]);
    expect(director.observe({ snapshot: snapshot(9, { branches: [chat(), research], ...accepted }), botId: 'b2', live: null, preferThreadId: null, now: 0 }).view.leads).toEqual([]);
  });
});
