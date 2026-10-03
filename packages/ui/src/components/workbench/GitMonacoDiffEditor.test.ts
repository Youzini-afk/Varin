import { describe, expect, test } from 'vitest';

import { repositoryPathForGitDiff } from '@/lib/monaco/git-diff-resource';

describe('Git Monaco diff workspace identity', () => {
  test('keeps a nested repository file inside the outer workspace identity', () => {
    expect(repositoryPathForGitDiff('packages/app/src/main.ts', 'packages/app')).toBe('src/main.ts');
    expect(repositoryPathForGitDiff('src/main.ts', '')).toBe('src/main.ts');
    expect(repositoryPathForGitDiff('other/main.ts', 'packages/app')).toBeNull();
  });
});
