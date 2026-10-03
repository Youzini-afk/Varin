import { describe, expect, test } from 'vitest';
import type { SessionSummary } from '@varin/protocol';
import { buildPiCleanupCandidates } from './usePiSessionAutoCleanup';

const summary = (id: string, updatedAt: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  allMessagesText: '',
  createdAt: updatedAt,
  cwd: `C:/repo/${id}`,
  firstMessage: id,
  id,
  messageCount: 1,
  persisted: true,
  sessionFile: `${id}.jsonl`,
  updatedAt,
  ...patch,
});

describe('buildPiCleanupCandidates', () => {
  test('protects the current session and the configured number of newest sessions', () => {
    const sessions = [
      summary('newest', '2026-08-01T00:00:00.000Z'),
      summary('current', '2026-07-01T00:00:00.000Z'),
      summary('old', '2026-01-01T00:00:00.000Z'),
      summary('older', '2025-01-01T00:00:00.000Z'),
    ];
    expect(buildPiCleanupCandidates({
      currentSessionId: 'current',
      cutoffDays: 30,
      keepRecent: 1,
      now: Date.parse('2026-08-02T00:00:00.000Z'),
      sessions,
    })).toEqual(['old', 'older']);
  });

  test('ignores archived and malformed timestamps', () => {
    expect(buildPiCleanupCandidates({
      currentSessionId: null,
      cutoffDays: 1,
      keepRecent: 0,
      now: Date.parse('2026-08-02T00:00:00.000Z'),
      sessions: [
        summary('archived', '2025-01-01T00:00:00.000Z', { archivedAt: '2026-01-01T00:00:00.000Z' }),
        summary('invalid', 'not-a-date'),
      ],
    })).toEqual([]);
  });
});
