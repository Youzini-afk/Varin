import { describe, expect, test, vi } from 'vitest';
import { routeThreadWindow, threadMiniChatUrl, threadWindowKey } from './thread-window-target.js';
const identity = { threadId: 'thread:one', branchId: 'branch:two', directory: '/project' };
const a = { apiBaseUrl: 'https://a.test', relayHostId: '' };
const b = { apiBaseUrl: 'https://b.test', relayHostId: '' };
describe('native conversation window routing', () => {
  test('round-trips exact Thread and branch and separates branch/Host windows', () => {
    const url = new URL(threadMiniChatUrl('https://a.test/mini-chat.html', { mode: 'thread', ...identity }));
    expect(url.searchParams.get('threadId')).toBe(identity.threadId);
    expect(url.searchParams.get('branchId')).toBe(identity.branchId);
    expect(threadWindowKey(a, identity)).not.toBe(threadWindowKey(b, identity));
    expect(threadWindowKey(a, identity)).not.toBe(threadWindowKey(a, { ...identity, branchId: 'branch:other' }));
    expect(threadWindowKey(a, identity)).not.toBe(threadWindowKey({ ...a, relayHostId: 'other' }, identity));
  });
  test('notification from another Host is queued before switching, never broadcast to the current Host', async () => {
    const calls: string[] = []; const emit = vi.fn(); const queue = vi.fn(() => calls.push('queue'));
    await routeThreadWindow(identity, b, { current: () => 1, host: () => a, loading: () => false,
      activate: async host => { expect(host).toBe(b); calls.push('activate'); }, focus: vi.fn(), queue, emit });
    expect(calls).toEqual(['queue', 'activate']); expect(emit).not.toHaveBeenCalled(); expect(queue).toHaveBeenCalledWith(identity, b);
  });
  test('same-Host click preserves branch, and waits through a renderer reload', async () => {
    const emit = vi.fn(); const queue = vi.fn(); let loading = true;
    const owner = { current: () => 1, host: () => a, loading: () => loading, activate: vi.fn(), focus: vi.fn(), queue, emit };
    await routeThreadWindow(identity, a, owner); expect(queue).toHaveBeenCalledWith(identity, a); expect(emit).not.toHaveBeenCalled();
    loading = false; await routeThreadWindow(identity, a, owner); expect(emit).toHaveBeenCalledWith(1, identity, a); expect(owner.activate).not.toHaveBeenCalled();
  });
});
