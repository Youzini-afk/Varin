import { describe, expect, test } from 'vitest';
import { resolvePiEffectiveDirectory } from './useEffectiveDirectory';

describe('resolvePiEffectiveDirectory', () => {
  test('prefers the live Pi snapshot cwd over catalog and global directories', () => {
    expect(resolvePiEffectiveDirectory(' C:/worktree ', 'C:/catalog', 'C:/fallback')).toBe('C:/worktree');
  });

  test('falls back through the Pi summary to the global directory', () => {
    expect(resolvePiEffectiveDirectory(undefined, ' C:/catalog ', 'C:/fallback')).toBe('C:/catalog');
    expect(resolvePiEffectiveDirectory(undefined, undefined, ' C:/fallback ')).toBe('C:/fallback');
  });
});
