import { describe, expect, it } from 'vitest';
import type { GitStatus } from '@varin/application-client';
import type { Thread, ThreadRun } from '@varin/protocol';
import type { HarnessThreadSnapshot } from './harnessThreadPresentation';
import {
  groupOverviewBlocks,
  parseOverviewPlan,
  summarizeGitDiff,
  summarizeOverviewThreads,
  summarizePendingThreadDiffs,
} from './harnessWorkOverviewPresentation';

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  id: 'thread-1',
  purpose: 'task',
  parent: { kind: 'session', id: 'session-1' },
  workspaceId: 'workspace-1',
  forkPoint: null,
  brief: 'Implement the change',
  preset: null,
  model: null,
  manifest: {
    workFocus: 'code',
    carryBlocks: true,
    concurrency: 12,
    draftBaselineId: null,
    scope: [],
    systemPromptFragment: null,
    tools: ['read'],
    worktree: 'isolated',
  },
  createdBy: 'agent',
  kind: 'implementation',
  worktree: { path: '/tmp/thread', base: 'base', materialized: true },
  lifecycle: 'active',
  attention: 'none',
  waitingFor: null,
  integration: 'none',
  diffStats: null,
  report: null,
  activeRunId: 'run-1',
  createdAt: '2026-09-26T00:00:00.000Z',
  updatedAt: '2026-09-26T00:00:00.000Z',
  eventSeq: 1,
  hidden: false,
  ...overrides,
});

const run = (overrides: Partial<ThreadRun> = {}): ThreadRun => ({
  id: 'run-1',
  threadId: 'thread-1',
  attempt: 1,
  runtimeId: 'pi',
  sessionId: 'child-1',
  sessionOwner: 'spawned-child',
  workerState: 'running',
  outcome: null,
  exitReason: null,
  tokens: { input: 0, output: 0, cacheRead: 0 },
  costUsd: null,
  steps: 2,
  lastToolCall: null,
  startedAt: '2026-09-26T00:00:00.000Z',
  lastActivityAt: '2026-09-26T00:00:01.000Z',
  endedAt: null,
  ...overrides,
});

const snapshot = (threadOverrides: Partial<Thread> = {}, runOverrides: Partial<ThreadRun> = {}): HarnessThreadSnapshot => ({
  thread: thread(threadOverrides),
  activeRun: run(runOverrides),
});

describe('work overview presentation', () => {
  it('parses the harness plan into product-level task states', () => {
    expect(parseOverviewPlan('- [X] Inspect\n- [ ] Review\n- [/] Implement\n- [/] Document\n- [!] Waiting on fixture')).toEqual({
      items: [
        { text: 'Inspect', status: 'completed' },
        { text: 'Review', status: 'pending' },
        { text: 'Implement', status: 'in_progress' },
        { text: 'Document', status: 'in_progress' },
        { text: 'Waiting on fixture', status: 'blocked' },
      ],
      total: 5,
      done: 1,
      blocked: 1,
    });
  });

  it('separates well-known blocks without exposing plan as generic memory', () => {
    const groups = groupOverviewBlocks([
      { label: 'plan', content: 'p', updatedBy: 'agent', updatedAt: 1 },
      { label: 'progress', content: 'working', updatedBy: 'memory-agent', updatedAt: 2 },
      { label: 'decisions', content: 'keep 7z', updatedBy: 'user', updatedAt: 3 },
      { label: 'notes', content: 'misc', updatedBy: 'agent', updatedAt: 4 },
    ]);
    expect(groups.plan?.content).toBe('p');
    expect(groups.progress?.content).toBe('working');
    expect(groups.decisions?.content).toBe('keep 7z');
    expect(groups.other.map((block) => block.label)).toEqual(['notes']);
  });

  it('projects running, attention and integration states into summary counts', () => {
    const entries = [
      snapshot(),
      snapshot({ id: 'thread-2', attention: 'user' }),
      snapshot(
        { id: 'thread-3', lifecycle: 'settled', integration: 'merge-ready' },
        { threadId: 'thread-3', workerState: 'exited', outcome: 'success', endedAt: '2026-09-26T00:02:00.000Z' },
      ),
      snapshot(
        { id: 'thread-4', lifecycle: 'settled', integration: 'merged' },
        { threadId: 'thread-4', workerState: 'exited', outcome: 'success', endedAt: '2026-09-26T00:02:00.000Z' },
      ),
    ];
    expect(summarizeOverviewThreads(entries)).toMatchObject({
      total: 4,
      active: 1,
      attention: 1,
      integrationPending: 1,
      completed: 1,
    });
  });

  it('counts only unmerged isolated or integration-pending thread diffs', () => {
    const entries = [
      snapshot({ diffStats: { files: 2, insertions: 10, deletions: 3 } }),
      snapshot({
        id: 'thread-2',
        manifest: { ...thread().manifest, worktree: 'shared' },
        diffStats: { files: 5, insertions: 50, deletions: 20 },
      }),
      snapshot({
        id: 'thread-3',
        integration: 'merged',
        diffStats: { files: 1, insertions: 1, deletions: 1 },
      }),
    ];
    expect(summarizePendingThreadDiffs(entries)).toEqual({ files: 2, insertions: 10, deletions: 3 });
  });

  it('aggregates real git file and line statistics', () => {
    const status: GitStatus = {
      current: 'main',
      tracking: 'origin/main',
      ahead: 0,
      behind: 0,
      isClean: false,
      files: [
        { path: 'a.ts', index: ' ', working_dir: 'M' },
        { path: 'b.ts', index: 'A', working_dir: ' ' },
      ],
      diffStats: {
        'a.ts': { insertions: 5, deletions: 2 },
        'b.ts': { insertions: 7, deletions: 0 },
      },
    };
    expect(summarizeGitDiff(status)).toEqual({ files: 2, insertions: 12, deletions: 2 });
  });
});
