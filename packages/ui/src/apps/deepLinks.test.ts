import { describe, expect, test } from 'vitest';
import { buildDeepLink, parseDeepLink } from './deepLinks';
describe('native external conversation links', () => {
  test('retains Host, Thread, and branch through encoded identifiers', () => {
    const intent = { type: 'thread' as const, threadId: 'thread:/a b', branchId: 'branch:review', hostKey: JSON.stringify(['https://a.test', 'server:a']), directory: '/home/a b' };
    expect(parseDeepLink(buildDeepLink(intent))).toEqual(intent);
  });
  test('never turns legacy or incomplete targets into native identities', () => {
    expect(parseDeepLink('varin://session/old-pi-id')).toBeNull();
    expect(parseDeepLink('varin://thread/thread:a?branch=branch:b')).toBeNull();
    expect(parseDeepLink('varin://thread/thread:a?host=host:a')).toBeNull();
  });
});
