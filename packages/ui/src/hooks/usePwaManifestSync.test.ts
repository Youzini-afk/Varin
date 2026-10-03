import { describe, expect, test } from 'vitest';
import type { SessionSummary } from '@varin/protocol';
import { buildPiRecentShortcuts } from './usePwaManifestSync';

const summary = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  allMessagesText: '',
  createdAt: '2026-08-01T00:00:00.000Z',
  cwd: `C:/repo/${id}`,
  firstMessage: '',
  id,
  messageCount: 1,
  persisted: true,
  sessionFile: `${id}.jsonl`,
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...patch,
});

describe('buildPiRecentShortcuts', () => {
  test('puts the current Pi session first and uses native names', () => {
    expect(buildPiRecentShortcuts([
      summary('older', { name: 'Older' }),
      summary('current', { name: ' Current   Pi session ' }),
    ], 'current')).toEqual([
      { sessionId: 'current', title: 'Current Pi session' },
      { sessionId: 'older', title: 'Older' },
    ]);
  });

  test('falls back to the first message and excludes archived sessions', () => {
    expect(buildPiRecentShortcuts([
      summary('active', { firstMessage: ' First\nmessage ' }),
      summary('archived', { archivedAt: '2026-08-02T00:00:00.000Z', name: 'Archived' }),
    ], null)).toEqual([{ sessionId: 'active', title: 'First message' }]);
  });
});
