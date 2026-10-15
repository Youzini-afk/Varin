import { describe, expect, test } from 'vitest';
import { buildEmbeddedSessionChatURL, isEmbeddedSessionChatReady, readEmbeddedSessionChatConfigFromSearch, shouldConsumeSessionUrlParams } from './embeddedSessionChat';
const config = { threadId: 'thread:child', branchId: 'branch:review', directory: '/repo', readOnly: true };
describe('native embedded conversation identity', () => {
  test('round-trips exact branch and keeps credentials out of the URL', () => {
    const url = new URL(buildEmbeddedSessionChatURL({ ...config, basePath: '/app', origin: 'https://varin.test' }));
    expect(readEmbeddedSessionChatConfigFromSearch(url.search)).toEqual(config);
    expect(shouldConsumeSessionUrlParams(url.searchParams)).toBe(false);
    expect(url.searchParams.get('threadId')).toBe(config.threadId);
    expect(url.searchParams.get('branchId')).toBe(config.branchId);
  });
  test('rejects retired Pi links and incomplete native links', () => {
    expect(readEmbeddedSessionChatConfigFromSearch('?piPanel=session-chat&piSessionId=child')).toBeNull();
    expect(readEmbeddedSessionChatConfigFromSearch('?panel=session-chat&threadId=child')).toBeNull();
    expect(shouldConsumeSessionUrlParams(new URLSearchParams('?thread=thread%3Aa&branch=branch%3Ab'))).toBe(true);
  });
  test('requires the selected branch and navigation directory before rendering', () => {
    const currentIdentity = { runtime: 'agent' as const, threadId: config.threadId, branchId: config.branchId };
    expect(isEmbeddedSessionChatReady({ embeddedSessionChat: config, currentIdentity, currentDirectory: '/repo/' })).toBe(true);
    expect(isEmbeddedSessionChatReady({ embeddedSessionChat: config, currentIdentity: { ...currentIdentity, branchId: 'other' }, currentDirectory: '/repo' })).toBe(false);
    expect(isEmbeddedSessionChatReady({ embeddedSessionChat: config, currentIdentity, currentDirectory: '/other' })).toBe(false);
  });
});
