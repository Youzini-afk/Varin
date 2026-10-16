import { describe, expect, it, vi } from 'vitest';
import { overlayDraftsOnBaseline, createBranchWithDraftBaseline } from './draft-baseline.js';
import type { RecoveryState, RegularFileState, WorkingBranchRoot, WorkingStateRootStore } from './types.js';

// This suite owns draft overlay and its consumers, not durable storage. Return
// opaque object receipts without booting the retired TS catalog/state machine.
const objectReceipts = () => {
  const bodies = new Map<string, Buffer>();
  const putObject = vi.fn(async (bytes: Buffer) => {
    const hash = `draft-${bodies.size}`;
    bodies.set(hash, Buffer.from(bytes));
    return { hash, byteLength: bytes.length };
  });
  const readContent = async (state: RecoveryState) => state.kind === 'regular-file'
    ? bodies.get(state.objectHash) ?? null : null;
  return { putObject, readContent };
};
const file = (hash: string): RegularFileState => ({ kind: 'regular-file', objectHash: hash, byteLength: 5 });

describe('draft baseline consumers', () => {
  it('overlays modified, added, and deleted drafts while retaining untouched state and executable mode', async () => {
    const objects = objectReceipts();
    const baseState: Record<string, RecoveryState> = {
      'main.ts': { ...file('old-main'), mode: 0o755 },
      'deleted.txt': file('old-deleted'),
      'untouched.txt': file('untouched'),
    };
    const result = await overlayDraftsOnBaseline({
      baseState,
      drafts: [
        { path: 'main.ts', content: 'modified content' },
        { path: 'deleted.txt', content: null },
        { path: 'brand-new.txt', content: 'new file content' },
      ],
      putObject: objects.putObject,
    });

    expect(result.modifiedPaths).toEqual(['main.ts']);
    expect(result.deletedPaths).toEqual(['deleted.txt']);
    expect(result.addedPaths).toEqual(['brand-new.txt']);
    expect(result.changedPaths).toEqual(['brand-new.txt', 'deleted.txt', 'main.ts']);
    expect(result.effectiveState['untouched.txt']).toEqual(baseState['untouched.txt']);
    expect(result.effectiveState['deleted.txt']).toEqual({ kind: 'missing' });
    expect(result.effectiveState['main.ts']).toMatchObject({ kind: 'regular-file', mode: 0o755 });
    expect((await objects.readContent(result.effectiveState['main.ts']!))?.toString()).toBe('modified content');
    expect((await objects.readContent(result.effectiveState['brand-new.txt']!))?.toString()).toBe('new file content');
    expect(baseState['deleted.txt']).toEqual(file('old-deleted'));
  });

  it('passes the overlaid bytes and original source identity to the branch authority', async () => {
    const objects = objectReceipts();
    const accepted = { branchId: 'branch-feature' } as WorkingBranchRoot;
    const createBranch = vi.fn<WorkingStateRootStore['createBranch']>().mockResolvedValue(accepted);
    const owner = { putObject: objects.putObject, createBranch } as unknown as WorkingStateRootStore;
    const result = await createBranchWithDraftBaseline(owner, 'workspace', 'branch-feature', {
      'main.ts': { ...file('old-main'), mode: 0o755 },
    }, { 'main.ts': 'const x = 42;', 'helper.ts': 'export const y = 100;' }, 'fixed-base', ['src']);

    expect(result).toBe(accepted);
    expect(createBranch).toHaveBeenCalledOnce();
    const [workspace, branch, states, base, draftPaths, scopes] = createBranch.mock.calls[0]!;
    expect({ workspace, branch, base, draftPaths, scopes }).toEqual({
      workspace: 'workspace', branch: 'branch-feature', base: 'fixed-base',
      draftPaths: ['helper.ts', 'main.ts'], scopes: ['src'],
    });
    expect(states['main.ts']).toMatchObject({ kind: 'regular-file', mode: 0o755 });
    expect((await objects.readContent(states['main.ts']!))?.toString()).toBe('const x = 42;');
    expect((await objects.readContent(states['helper.ts']!))?.toString()).toBe('export const y = 100;');
  });

  it('preserves nested draft bytes and replaces conflicting ancestor states', async () => {
    const objects = objectReceipts();
    const result = await overlayDraftsOnBaseline({
      baseState: {
        dir: { kind: 'directory' }, 'dir/old.txt': file('old-child'),
        'file-base': file('old-file'), stable: { kind: 'directory' },
      },
      drafts: [
        { path: 'newdir/new.ts', content: 'new nested draft\n' },
        { path: 'dir', content: 'directory replaced by file\n' },
        { path: 'file-base/child.ts', content: 'file replaced by directory\n' },
        { path: 'stable/new.ts', content: 'existing directory remains baseline\n' },
      ],
      putObject: objects.putObject,
    });
    expect(result.changedPaths).toEqual([
      'dir', 'dir/old.txt', 'file-base', 'file-base/child.ts', 'newdir', 'newdir/new.ts', 'stable/new.ts',
    ]);
    expect(result.effectiveState['dir/old.txt']).toEqual({ kind: 'missing' });
    expect(result.effectiveState['file-base']).toMatchObject({ kind: 'directory' });
    for (const [name, content] of [
      ['newdir/new.ts', 'new nested draft\n'],
      ['dir', 'directory replaced by file\n'],
      ['file-base/child.ts', 'file replaced by directory\n'],
      ['stable/new.ts', 'existing directory remains baseline\n'],
    ]) {
      expect((await objects.readContent(result.effectiveState[name!]!))?.toString()).toBe(content);
    }

  });

  it('rejects conflicting draft paths before writing any objects', async () => {
    const objects = objectReceipts();
    await expect(overlayDraftsOnBaseline({
      baseState: {}, drafts: [{ path: 'a', content: 'file\n' }, { path: 'a/b.ts', content: 'nested\n' }],
      putObject: objects.putObject,
    })).rejects.toThrow(/ancestor\/descendant conflict/);
    expect(objects.putObject).not.toHaveBeenCalled();
  });
});
