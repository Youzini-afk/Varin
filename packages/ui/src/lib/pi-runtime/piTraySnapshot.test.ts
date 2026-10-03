import { describe, expect, test } from 'vitest';
import type { SessionSnapshot, SessionSummary } from '@varin/protocol';
import type { ProjectEntry } from '@varin/application-client';
import { projectPiTraySessions } from './piTraySnapshot';

const summary = (
  id: string,
  options: Partial<SessionSummary> = {},
): SessionSummary => ({
  allMessagesText: '',
  createdAt: '2026-08-02T00:00:00.000Z',
  cwd: `D:/work/${id}`,
  firstMessage: `First message for ${id}`,
  id,
  messageCount: 1,
  persisted: true,
  sessionFile: `D:/sessions/${id}.jsonl`,
  updatedAt: '2026-08-02T00:00:00.000Z',
  ...options,
});

const snapshot = (
  sessionId: string,
  options: Partial<SessionSnapshot> = {},
): SessionSnapshot => ({
  activeTools: [],
  busy: false,
  cwd: `D:/work/${sessionId}`,
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: 'all',
  queuedMessages: [],
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId,
  steering: [],
  steeringMode: 'all',
  thinkingLevel: 'off',
  ...options,
});

describe('Pi tray session projection', () => {
  test('rolls child activity into its root and keeps honest unsupported fields', () => {
    const sessions = [
      summary('root', { cwd: 'D:/work/repo', name: 'Root' }),
      summary('child', { cwd: 'D:/work/repo', parentId: 'root' }),
    ];
    const projects: ProjectEntry[] = [{ id: 'repo', label: 'My Repo', path: 'D:/work/repo' }];
    const result = projectPiTraySessions(sessions, {
      child: { snapshot: snapshot('child', { busy: true, cwd: 'D:/work/repo' }) },
    }, projects);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      branch: '',
      directory: 'D:/work/repo',
      hasError: false,
      id: 'root',
      status: 'busy',
      subtitle: 'My Repo',
      title: 'Root',
      unseen: 0,
    });
  });

  test('reports retry state and excludes archived sessions', () => {
    const result = projectPiTraySessions([
      summary('retry'),
      summary('archived', { archivedAt: '2026-08-02T01:00:00.000Z' }),
    ], {
      retry: { snapshot: snapshot('retry', { busy: true, retryAttempt: 2 }) },
    }, []);

    expect(result.map((entry) => [entry.id, entry.status])).toEqual([['retry', 'retry']]);
  });

  test('does not impose an arbitrary session limit', () => {
    const sessions = Array.from({ length: 27 }, (_, index) => summary(`session-${index}`, {
      updatedAt: `2026-08-02T00:${String(index).padStart(2, '0')}:00.000Z`,
    }));
    expect(projectPiTraySessions(sessions, {}, [])).toHaveLength(27);
  });

  test('keeps orphaned and cyclic session metadata visible', () => {
    const orphan = projectPiTraySessions([
      summary('orphan', { parentId: 'missing' }),
    ], {}, []);
    expect(orphan.map((entry) => entry.id)).toEqual(['orphan']);

    const cyclic = projectPiTraySessions([
      summary('one', { parentId: 'two' }),
      summary('two', { parentId: 'one' }),
    ], {}, []);
    expect(cyclic.map((entry) => entry.id).sort()).toEqual(['one', 'two']);
  });
});
