import { describe, expect, it } from 'vitest';
import type { WorkspaceCombinedRecoveryPlan } from '@varin/extension-contract';
import { shouldOpenRecoveryDialog } from './piRecoveryPolicy';

const plan = (input: Partial<WorkspaceCombinedRecoveryPlan> = {}): WorkspaceCombinedRecoveryPlan => ({
  affectedPaths: ['note.txt'],
  changedBytes: 4,
  conflicts: [],
  coverage: 'ready',
  createdAt: '2026-08-30T00:00:00.000Z',
  entryId: 'user-1',
  expectedLeafId: 'leaf-2',
  id: 'operation-1',
  removedEntryIds: ['user-1'],
  revision: `sha256-${'a'.repeat(64)}`,
  conversation: { kind: 'pi', sessionId: 'session-1' },
  targetLeafId: 'leaf-1',
  uncoveredPaths: [],
  uncoveredReasons: [],
  workspaceId: 'workspace-1',
  ...input,
});

describe('Pi combined recovery policy', () => {
  it('runs a ready conflict-free combined rollback without opening a planner', () => {
    expect(shouldOpenRecoveryDialog('both', plan())).toBe(false);
  });

  it('opens only for explicit ask, real conflicts, or incomplete external coverage', () => {
    expect(shouldOpenRecoveryDialog('ask', plan())).toBe(true);
    expect(shouldOpenRecoveryDialog('both', plan({
      conflicts: [{ fingerprint: 'sha256-conflict-1', kind: 'content-changed', message: 'changed', path: 'note.txt' }],
    }))).toBe(true);
    expect(shouldOpenRecoveryDialog('both', plan({
      coverage: 'partial',
      uncoveredPaths: [{ path: 'shell.txt', source: 'shell' }],
    }))).toBe(true);
    expect(shouldOpenRecoveryDialog('both', plan({
      coverage: 'none',
      affectedPaths: [],
      uncoveredPaths: [{ path: 'shell.txt', source: 'shell' }],
    }))).toBe(true);
  });
});
