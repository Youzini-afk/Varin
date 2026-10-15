import React from 'react';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { useThreadStore } from '@/stores/useThreadStore';

/** Push presentation only; the Catalog remains the native work/attention authority. */
export const useTraySync = (options: { enabled?: boolean } = {}): void => {
  React.useEffect(() => {
    if (options.enabled === false || !canUseElectronDesktopIPC() || window.__VARIN_ELECTRON__?.trayEnabled === false) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const { threads } = useThreadStore.getState();
      const visible = threads.filter(thread => !thread.archived && !thread.deleted_at_ms);
      void invokeDesktop('desktop_tray_update', {
        instanceName: 'Varin', approvals: [], dockBadgeCount: visible.filter(thread => thread.unread).length,
        threads: visible.map(thread => {
          const branch = thread.branches.find(branch => branch.branch_id === thread.main_branch_id);
          return { threadId: thread.thread_id, branchId: thread.main_branch_id, title: thread.title,
            status: branch?.active_run_id ? 'busy' : 'idle', unseen: thread.unread ? 1 : 0 };
        }),
      });
    };
    const unsubscribe = useThreadStore.subscribe(() => { if (!timer) timer = setTimeout(flush, 200); });
    flush(); return () => { unsubscribe(); if (timer) clearTimeout(timer); };
  }, [options.enabled]);
};
