import { describe, expect, test } from 'vitest';
import { threadSummary } from '@/test/threadFixtures';
import { buildThreadCleanupCandidates } from './useThreadAutoCleanup';
const now = Date.parse('2026-08-02T00:00:00Z');
const old = (id: string) => threadSummary(id, { updated_at_ms: Date.parse('2025-01-01T00:00:00Z') });
describe('native Thread retention', () => {
  test('protects current, recent, pinned, Bot, active, archived and deleted Threads', () => {
    expect(buildThreadCleanupCandidates({ currentSessionId: 'current', cutoffDays: 30, keepRecent: 1, now, sessions: [
      threadSummary('recent', { updated_at_ms: now }), old('current'), { ...old('pinned'), pinned: true }, { ...old('bot'), bot_id: 'bot' },
      { ...old('active'), branches: [{ branch_id: 'branch', active_run_id: 'run', head: null, latest_run: null }] },
      { ...old('archived'), archived: true }, { ...old('deleted'), deleted_at_ms: 1 }, old('eligible'),
    ] })).toEqual(['eligible']);
  });
  test('does not clean invalid timestamps or disabled retention', () => {
    expect(buildThreadCleanupCandidates({ currentSessionId: null, cutoffDays: 1, keepRecent: 0, now, sessions: [threadSummary('bad', { updated_at_ms: NaN })] })).toEqual([]);
    expect(buildThreadCleanupCandidates({ currentSessionId: null, cutoffDays: 0, keepRecent: 0, now, sessions: [old('old')] })).toEqual([]);
  });
});
