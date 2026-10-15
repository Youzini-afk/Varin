import { useThreadStore } from '@/stores/useThreadStore';
import { buildDeepLink } from './deepLinks';

export interface MobileWidgetThread {
  threadId: string;
  branchId: string;
  title: string;
  unread: boolean;
  url: string;
}
export interface MobileWidgetSnapshot {
  hostKey: string;
  attentionCount: number;
  recentThreads: MobileWidgetThread[];
}
/** A read-only native Catalog projection. Widgets never manufacture a session identity. */
export const buildMobileWidgetSnapshot = (): MobileWidgetSnapshot => {
  const { threads, hostKey } = useThreadStore.getState();
  const visible = threads.filter(thread => !thread.bot_id && !thread.archived && thread.deleted_at_ms === null)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at_ms - a.updated_at_ms);
  return { hostKey, attentionCount: visible.filter(thread => thread.unread).length, recentThreads: visible.slice(0, 6).map(thread => ({
    threadId: thread.thread_id, branchId: thread.main_branch_id, title: thread.title, unread: thread.unread,
    url: buildDeepLink({ type: 'thread', threadId: thread.thread_id, branchId: thread.main_branch_id, hostKey }),
  })) };
};
export const installMobileWidgetSnapshotBridge = (): void => {
  if (typeof window === 'undefined') return;
  (window as typeof window & { __VARIN_WIDGET_SNAPSHOT__?: () => string | null }).__VARIN_WIDGET_SNAPSHOT__ = () => {
    try { return JSON.stringify(buildMobileWidgetSnapshot()); } catch { return null; }
  };
};
