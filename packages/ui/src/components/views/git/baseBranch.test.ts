import { describe, expect, test } from 'vitest';
import { deriveBaseBranch, hasResolvableBaseBranch } from './baseBranch';

describe('deriveBaseBranch', () => {
  test('uses the repository default and never compares a branch with itself', () => {
    expect(deriveBaseBranch({
      remoteNames: new Set(['origin']),
      localBranches: ['next', 'react'],
      rootBranchHint: 'next',
      defaultBranch: 'origin/react',
      headBranch: 'next',
    })).toBe('react');
  });

  test('keeps a worktree origin ahead of the repository default', () => {
    expect(deriveBaseBranch({
      remoteNames: new Set(['upstream']),
      localBranches: ['feature', 'trunk'],
      worktreeCreatedFromBranch: 'feature',
      defaultBranch: 'upstream/trunk',
    })).toBe('feature');
  });
});

describe('hasResolvableBaseBranch', () => {
  test('matches the full branch path after the remote name', () => {
    expect(hasResolvableBaseBranch({
      baseBranch: 'release/2.0',
      localBranches: ['next'],
      remoteBranches: ['upstream/release/2.0'],
    })).toBe(true);
    expect(hasResolvableBaseBranch({
      baseBranch: 'main',
      localBranches: ['next'],
      remoteBranches: ['origin/feature/main'],
    })).toBe(false);
  });
});
