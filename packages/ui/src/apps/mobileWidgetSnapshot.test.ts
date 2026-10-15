import { afterEach, describe, expect, test } from 'vitest';
import type { ThreadSummary } from '@varin/protocol';
import { useThreadStore } from '@/stores/useThreadStore';
import { buildMobileWidgetSnapshot } from './mobileWidgetSnapshot';
import { parseDeepLink } from './deepLinks';
const previous = useThreadStore.getState();
afterEach(() => useThreadStore.setState(previous, true));
const thread = (id: string, values: Partial<ThreadSummary> = {}): ThreadSummary => ({
  thread_id: id, bot_id: null, branches: [], observer_project_ids: [], main_branch_id: `${id}:main`,
  title: id, revision: 1, created_at_ms: 1, updated_at_ms: 2, pinned: false, archived: false,
  deleted_at_ms: null, activity_cursor: 1, read_cursor: 0, unread: true, ...values,
});
describe('native mobile widget projection', () => {
  test('retains original branch and Host while excluding archived/deleted catalog entries', () => {
    const hostKey = JSON.stringify(['https://a.test', 'server:a']);
    useThreadStore.setState({ hostKey, threads: [thread('one'), thread('archived', { archived: true }), thread('deleted', { deleted_at_ms: 3 }), thread('pinned', { pinned: true, unread: false })] });
    const snapshot = buildMobileWidgetSnapshot();
    expect(snapshot.attentionCount).toBe(1); expect(snapshot.recentThreads.map(item => item.threadId)).toEqual(['pinned', 'one']);
    expect(parseDeepLink(snapshot.recentThreads[1].url)).toMatchObject({ type: 'thread', threadId: 'one', branchId: 'one:main', hostKey });
    useThreadStore.setState({ hostKey: 'other', threads: [] }); expect(buildMobileWidgetSnapshot()).toEqual({ hostKey: 'other', attentionCount: 0, recentThreads: [] });
  });
});
