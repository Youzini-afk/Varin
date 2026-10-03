import { describe, expect, test } from 'vitest';
import type { SessionSummary } from '@varin/protocol';
import { collectPiWorktreeSessions } from './worktreeSessions';

const summary = (id: string, cwd: string, parentId?: string): SessionSummary => ({
  allMessagesText: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  cwd,
  firstMessage: id,
  id,
  messageCount: 0,
  ...(parentId ? { parentId } : {}),
  persisted: true,
  sessionFile: `${id}.jsonl`,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('Pi worktree session ownership', () => {
  test('collects exact-cwd sessions and every descendant without prefix matches', () => {
    const sessions = [
      summary('root', 'C:\\repo\\feature'),
      summary('child', 'C:\\repo\\other', 'root'),
      summary('grandchild', 'C:\\repo\\other', 'child'),
      summary('nested-folder', 'C:\\repo\\feature\\nested'),
      summary('other', 'C:\\repo\\feature-2'),
    ];
    expect(collectPiWorktreeSessions(sessions, 'c:/repo/feature/').map((entry) => entry.id))
      .toEqual(['root', 'child', 'grandchild']);
  });

  test('does not loop when corrupt parent metadata contains a cycle', () => {
    const sessions = [
      summary('root', '/repo/worktree', 'child'),
      summary('child', '/repo/elsewhere', 'root'),
    ];
    expect(collectPiWorktreeSessions(sessions, '/repo/worktree').map((entry) => entry.id))
      .toEqual(['root', 'child']);
  });
});
