import { describe, expect, test } from 'vitest';
import type { SessionSummary } from '@varin/protocol';
import {
  buildPiSessionForest,
  collectPiSessionSelectionSubtreeIds,
  collectPiSessionSubtreeIds,
  countPiSessionSubtreeValues,
  comparePiSessions,
  flattenPiSessionForest,
  filterPiSessionForest,
  groupPiSessionForestByWorkspace,
  piSessionTitle,
  resolvePiSessionWorkspaceProject,
  sortPiSessionWorkspaceProjects,
} from './sessionPresentation';

const session = (
  id: string,
  options: Partial<SessionSummary> = {},
): SessionSummary => ({
  allMessagesText: '',
  createdAt: '2026-08-01T00:00:00.000Z',
  cwd: 'D:/work',
  firstMessage: '',
  id,
  messageCount: 0,
  persisted: true,
  sessionFile: `D:/sessions/${id}.jsonl`,
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...options,
});

describe('Pi session presentation', () => {
  test('uses the explicit name, then the first non-empty prompt, without clipping it', () => {
    expect(piSessionTitle(session('named', { name: '  Release plan  ' }), 'Untitled')).toBe('Release plan');
    expect(piSessionTitle(session('prompt', {
      firstMessage: '\n  Build every requested adapter without a display-length cap  \nsecond line',
    }), 'Untitled')).toBe('Build every requested adapter without a display-length cap');
    expect(piSessionTitle(session('empty'), 'Untitled')).toBe('Untitled');
  });

  test('orders pinned sessions first and otherwise keeps the complete lifecycle order', () => {
    const olderPinned = session('older-pinned', { updatedAt: '2026-08-01T00:00:00.000Z' });
    const newer = session('newer', { updatedAt: '2026-08-02T00:00:00.000Z' });
    const sessions = [newer, olderPinned].sort((left, right) => (
      comparePiSessions(left, right, (candidate) => candidate.id === olderPinned.id)
    ));
    expect(sessions.map((candidate) => candidate.id)).toEqual(['older-pinned', 'newer']);
  });

  test('builds every parent and child without a depth or count limit', () => {
    const sessions: SessionSummary[] = [];
    for (let index = 0; index < 24; index += 1) {
      sessions.push(session(`session-${index}`, {
        parentId: index === 0 ? undefined : `session-${index - 1}`,
        updatedAt: `2026-08-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      }));
    }
    const forest = buildPiSessionForest(sessions);
    let node = forest[0];
    const ids: string[] = [];
    while (node) {
      ids.push(node.session.id);
      node = node.children[0];
    }
    expect(ids).toHaveLength(24);
    expect(ids.at(-1)).toBe('session-23');
  });

  test('keeps orphaned and cyclic sessions reachable as roots', () => {
    const forest = buildPiSessionForest([
      session('orphan', { parentId: 'missing' }),
      session('cycle-a', { parentId: 'cycle-b' }),
      session('cycle-b', { parentId: 'cycle-a' }),
    ]);
    expect(new Set(forest.map((node) => node.session.id))).toEqual(new Set([
      'orphan',
      'cycle-a',
      'cycle-b',
    ]));
  });

  test('collects an unlimited same-lifecycle subtree and terminates on cycles', () => {
    const summaries = [
      session('root'),
      session('child-a', { parentId: 'root' }),
      session('child-b', { parentId: 'root' }),
      session('grandchild', { parentId: 'child-a' }),
      session('archived-child', { archivedAt: '2026-08-02T00:00:00.000Z', parentId: 'root' }),
      session('cycle-a', { parentId: 'cycle-b' }),
      session('cycle-b', { parentId: 'cycle-a' }),
    ];
    expect(collectPiSessionSubtreeIds(summaries, 'root')).toEqual([
      'root',
      'child-a',
      'grandchild',
      'child-b',
    ]);
    expect(collectPiSessionSubtreeIds(summaries, 'cycle-a')).toEqual(['cycle-a', 'cycle-b']);
  });

  test('rolls up pending interactions only while child rows are hidden', () => {
    const root = buildPiSessionForest([
      session('parent'),
      session('child', { parentId: 'parent' }),
      session('grandchild', { parentId: 'child' }),
    ])[0]!;
    const counts = { parent: 1, child: 2, grandchild: 1 };

    expect(countPiSessionSubtreeValues(root, counts, false)).toBe(1);
    expect(countPiSessionSubtreeValues(root, counts, true)).toBe(4);
  });

  test('searches full session text and preserves matching ancestors', () => {
    const forest = buildPiSessionForest([
      session('parent', { name: 'Parent' }),
      session('child', {
        allMessagesText: 'A deeply nested recovery detail',
        parentId: 'parent',
      }),
    ]);
    const filtered = filterPiSessionForest(forest, 'recovery detail', 'Untitled');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.session.id).toBe('parent');
    expect(filtered[0]?.children[0]?.session.id).toBe('child');
  });

  test('keeps explicit workspace and unbound ownership separate from runtime cwd', () => {
    const projects = [
      { id: 'repo', label: 'Repo', path: 'D:/work/repo' },
      { id: 'nested', label: 'Nested', path: 'D:/work/repo/packages/nested' },
    ];
    const forest = buildPiSessionForest([
      session('bound-worktree', {
        cwd: 'D:/worktrees/feature',
        workspace: { id: 'repo', kind: 'workspace' },
      }),
      session('unbound-inside-repo', {
        cwd: 'D:/work/repo',
        workspace: { kind: 'unbound' },
      }),
      session('native-nested', { cwd: 'D:/work/repo/packages/nested/src' }),
      session('missing-workspace', {
        cwd: 'D:/elsewhere',
        workspace: { id: 'removed', kind: 'workspace' },
      }),
    ]);

    const groups = groupPiSessionForestByWorkspace(forest, projects);
    expect(groups.map((group) => group.id)).toEqual(['workspace:repo', 'workspace:nested', 'recent']);
    expect(groups[0]?.forest.map((node) => node.session.id)).toEqual(['bound-worktree']);
    expect(groups[1]?.forest.map((node) => node.session.id)).toEqual(['native-nested']);
    expect(new Set(groups[2]?.forest.map((node) => node.session.id))).toEqual(new Set([
      'unbound-inside-repo',
      'missing-workspace',
    ]));
  });

  test('matches legacy sessions through nested worktree paths on Windows', () => {
    const projects = [{
      id: 'repo',
      path: 'D:/work/repo',
      worktrees: [{ path: 'D:/worktrees/feature' }],
    }];
    expect(resolvePiSessionWorkspaceProject(
      session('worktree-child', { cwd: 'd:\\WORKTREES\\FEATURE\\packages\\ui' }),
      projects,
    )?.id).toBe('repo');
  });

  test('can keep empty projects visible for a unified workspace session list', () => {
    const projects = [
      { id: 'first', label: 'First', path: 'D:/work/first' },
      { id: 'second', label: 'Second', path: 'D:/work/second' },
    ];

    const groups = groupPiSessionForestByWorkspace([], projects, undefined, {
      includeEmptyProjects: true,
    });

    expect(groups.map((group) => group.id)).toEqual(['workspace:first', 'workspace:second']);
    expect(groups.every((group) => group.forest.length === 0)).toBe(true);
  });

  test('sorts projects by label, date added, and recent activity', () => {
    const projects = [
      { id: 'manual-first', label: 'Zeta', path: 'D:/z', addedAt: 10, lastOpenedAt: 100 },
      { id: 'manual-second', label: 'Alpha', path: 'D:/a', addedAt: 30, lastOpenedAt: 10 },
      { id: 'manual-third', label: 'Beta', path: 'D:/b', addedAt: 20, lastOpenedAt: 200 },
    ];
    expect(sortPiSessionWorkspaceProjects(projects, 'manual').map((project) => project.id))
      .toEqual(['manual-first', 'manual-second', 'manual-third']);
    expect(sortPiSessionWorkspaceProjects(projects, 'a-z').map((project) => project.id))
      .toEqual(['manual-second', 'manual-third', 'manual-first']);
    expect(sortPiSessionWorkspaceProjects(projects, 'z-a').map((project) => project.id))
      .toEqual(['manual-first', 'manual-third', 'manual-second']);
    expect(sortPiSessionWorkspaceProjects(projects, 'date-added').map((project) => project.id))
      .toEqual(['manual-second', 'manual-third', 'manual-first']);
    expect(sortPiSessionWorkspaceProjects(projects, 'recent').map((project) => project.id))
      .toEqual(['manual-third', 'manual-first', 'manual-second']);
  });

  test('keeps recent/unbound last and can hide it without projecting project sessions', () => {
    const projects = [{ id: 'repo', label: 'Repo', path: 'D:/work/repo' }];
    const forest = buildPiSessionForest([
      session('recent', { workspace: { kind: 'unbound' } }),
      session('project', { workspace: { id: 'repo', kind: 'workspace' } }),
    ]);
    const groups = groupPiSessionForestByWorkspace(forest, projects);
    expect(groups.map((group) => group.id)).toEqual(['workspace:repo', 'recent']);
    expect(groups.at(-1)?.forest.map((node) => node.session.id)).toEqual(['recent']);
    expect(groupPiSessionForestByWorkspace(forest, projects, undefined, {
      showRecentSection: false,
    }).map((group) => group.id)).toEqual(['workspace:repo']);

    const boundChild = buildPiSessionForest([
      session('unbound-parent', { workspace: { kind: 'unbound' } }),
      session('bound-child', { parentId: 'unbound-parent', workspace: { id: 'repo', kind: 'workspace' } }),
    ]);
    expect(groupPiSessionForestByWorkspace(boundChild, projects, undefined, {
      showRecentSection: false,
    })[0]?.forest.map((node) => node.session.id)).toEqual(['bound-child']);
  });

  test('flattens parent and child sessions without losing either row', () => {
    const forest = buildPiSessionForest([
      session('parent', { updatedAt: '2026-08-01T00:00:01.000Z' }),
      session('child', { parentId: 'parent', updatedAt: '2026-08-01T00:00:02.000Z' }),
    ]);
    const flat = flattenPiSessionForest(forest);
    expect(flat.map((node) => node.session.id)).toEqual(['child', 'parent']);
    expect(flat.every((node) => node.children.length === 0)).toBe(true);
  });

  test('deduplicates descendants selected together with their parent', () => {
    const summaries = [
      session('parent'),
      session('child', { parentId: 'parent' }),
      session('sibling'),
    ];
    expect(collectPiSessionSelectionSubtreeIds(
      summaries,
      new Set(['parent', 'child', 'sibling']),
    )).toEqual(['parent', 'child', 'sibling']);
  });

  test('detaches children whose workspace differs from their parent', () => {
    const projects = [{ id: 'repo', label: 'Repo', path: 'D:/work/repo' }];
    const forest = buildPiSessionForest([
      session('parent', {
        cwd: 'D:/work/repo',
        workspace: { id: 'repo', kind: 'workspace' },
      }),
      session('general-child', {
        cwd: 'D:/home',
        parentId: 'parent',
        workspace: { kind: 'unbound' },
      }),
    ]);

    const groups = groupPiSessionForestByWorkspace(forest, projects);
    expect(groups[0]?.forest[0]?.session.id).toBe('parent');
    expect(groups[0]?.forest[0]?.children).toEqual([]);
    expect(groups[1]?.id).toBe('recent');
    expect(groups[1]?.forest[0]?.session.id).toBe('general-child');
  });
});
