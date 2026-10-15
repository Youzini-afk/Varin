import { describe, expect, test } from 'vitest';
import { parseRoute } from './parseRoute';

describe('parseRoute', () => {
  test('parses a native Thread and one-time directory hint', () => {
    const route = parseRoute(new URLSearchParams({
      directory: ' D:/work ',
      thread: ' session-a ',
      branch: 'branch:review',
      tab: 'diff',
    }));
    expect(route.threadId).toBe('session-a');
    expect(route.branchId).toBe('branch:review');
    expect(route.directory).toBe('D:/work');
    expect(route.tab).toBe('diff');
  });

  test('ignores empty session and directory values', () => {
    const route = parseRoute(new URLSearchParams('thread=%20&directory=%20'));
    expect(route.threadId).toBeNull();
    expect(route.directory).toBeNull();
  });
});
