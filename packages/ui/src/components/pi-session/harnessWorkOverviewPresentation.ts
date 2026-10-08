import type { GitStatus } from '@varin/application-client';
import { parseTodoPlan, type TodoItem } from '@varin/protocol';
import type { HarnessThreadSnapshot, HarnessThreadState } from './harnessThreadPresentation';
import { projectHarnessThreadState } from './harnessThreadPresentation';
import type { HarnessSessionBlock } from './harnessBlockPresentation';

export interface OverviewPlanSummary {
  items: TodoItem[];
  total: number;
  done: number;
  blocked: number;
}

export interface OverviewBlockGroups {
  plan: HarnessSessionBlock | null;
  progress: HarnessSessionBlock | null;
  decisions: HarnessSessionBlock | null;
  other: HarnessSessionBlock[];
}

export interface OverviewThreadSummary {
  total: number;
  active: number;
  attention: number;
  completed: number;
  integrationPending: number;
  failed: number;
  cancelled: number;
}

export interface OverviewDiffSummary {
  files: number;
  insertions: number;
  deletions: number;
}

const ACTIVE_STATES = new Set<HarnessThreadState>(['queued', 'starting', 'running']);
const ATTENTION_STATES = new Set<HarnessThreadState>(['waiting', 'stalled', 'looping', 'conflict', 'failed', 'interrupted']);
const COMPLETED_STATES = new Set<HarnessThreadState>(['completed', 'merged', 'archived']);
const INTEGRATION_PENDING_STATES = new Set<HarnessThreadState>(['dirty', 'merge-ready']);

export const parseOverviewPlan = (content: string): OverviewPlanSummary => {
  const items = parseTodoPlan(content);
  const done = items.filter((item) => item.status === 'completed').length;
  const blocked = items.filter((item) => item.status === 'blocked').length;
  return {
    items,
    total: items.length,
    done,
    blocked,
  };
};

export const groupOverviewBlocks = (blocks: readonly HarnessSessionBlock[]): OverviewBlockGroups => {
  let plan: HarnessSessionBlock | null = null;
  let progress: HarnessSessionBlock | null = null;
  let decisions: HarnessSessionBlock | null = null;
  const other: HarnessSessionBlock[] = [];
  for (const block of blocks) {
    if (block.label === 'plan') plan = block;
    else if (block.label === 'progress') progress = block;
    else if (block.label === 'decisions') decisions = block;
    else other.push(block);
  }
  return { plan, progress, decisions, other };
};

export const summarizeOverviewThreads = (threads: readonly HarnessThreadSnapshot[]): OverviewThreadSummary => {
  let active = 0;
  let attention = 0;
  let completed = 0;
  let integrationPending = 0;
  let failed = 0;
  let cancelled = 0;
  for (const thread of threads) {
    const state = projectHarnessThreadState(thread);
    if (ACTIVE_STATES.has(state)) active += 1;
    if (ATTENTION_STATES.has(state)) attention += 1;
    if (COMPLETED_STATES.has(state)) completed += 1;
    if (INTEGRATION_PENDING_STATES.has(state)) integrationPending += 1;
    if (state === 'failed' || state === 'interrupted') failed += 1;
    if (state === 'cancelled') cancelled += 1;
  }
  return { total: threads.length, active, attention, completed, integrationPending, failed, cancelled };
};

export const summarizePendingThreadDiffs = (threads: readonly HarnessThreadSnapshot[]): OverviewDiffSummary => {
  const result: OverviewDiffSummary = { files: 0, insertions: 0, deletions: 0 };
  for (const entry of threads) {
    const stats = entry.thread.diffStats;
    if (!stats || stats.files <= 0) continue;
    const state = projectHarnessThreadState(entry);
    const isolated = entry.thread.manifest.worktree === 'isolated';
    const pendingIntegration = state === 'dirty' || state === 'merge-ready' || state === 'conflict';
    if (!isolated && !pendingIntegration) continue;
    if (entry.thread.integration === 'merged') continue;
    result.files += stats.files;
    result.insertions += stats.insertions;
    result.deletions += stats.deletions;
  }
  return result;
};

export const summarizeGitDiff = (status: GitStatus | null): OverviewDiffSummary => {
  if (!status) return { files: 0, insertions: 0, deletions: 0 };
  let insertions = 0;
  let deletions = 0;
  for (const value of Object.values(status.diffStats ?? {})) {
    insertions += value.insertions;
    deletions += value.deletions;
  }
  return { files: status.files.length, insertions, deletions };
};
