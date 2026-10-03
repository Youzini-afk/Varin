import { describe, expect, test } from 'vitest';
import { parseRoute } from './parseRoute';

describe('parseRoute', () => {
  test('parses a Pi session and one-time directory hint', () => {
    const route = parseRoute(new URLSearchParams({
      directory: ' D:/work ',
      session: ' session-a ',
      tab: 'diff',
    }));
    expect(route.sessionId).toBe('session-a');
    expect(route.directory).toBe('D:/work');
    expect(route.tab).toBe('diff');
  });

  test('ignores empty session and directory values', () => {
    const route = parseRoute(new URLSearchParams('session=%20&directory=%20'));
    expect(route.sessionId).toBeNull();
    expect(route.directory).toBeNull();
  });
});
