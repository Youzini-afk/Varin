import React from 'react';
import type { ThreadSummary } from '@varin/protocol';
import { ConversationSidebar } from '@/components/conversation/ConversationSidebar';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore, type MotionPreference } from '@/stores/useUIStore';

/**
 * Sidebar scene: the real conversation sidebar fed through its stores, with
 * two projects and a recent group. `window.__sidebar` selects, pins, adds,
 * removes and marks rows, and records row positions frame by frame.
 */

let clock = 1_000;
const summary = (id: string, title: string, project: string | null, parent: string | null = null): ThreadSummary => {
  clock += 1;
  return {
    thread_id: id, main_branch_id: `${id}-main`, title, revision: 1, created_at_ms: clock, updated_at_ms: clock,
    pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false,
    bot_id: null, parent_thread_id: parent, observer_project_ids: [project],
    branches: [{ branch_id: `${id}-main`, head: null, active_run_id: null, latest_run: null }],
  };
};

const seed = (): ThreadSummary[] => [
  summary('auth-1', '登录流程重构', 'p-auth'),
  summary('auth-2', '刷新令牌丢失', 'p-auth'),
  summary('auth-3', '会话恢复测试', 'p-auth'),
  summary('auth-4', '权限中间件', 'p-auth'),
  summary('ui-1', '侧栏动效', 'p-ui'),
  summary('ui-2', '设置窗口分页', 'p-ui'),
  summary('ui-3', '主题墨晕', 'p-ui'),
  summary('misc-1', '随手记录', null),
  summary('misc-2', '读一篇论文', null),
];

// Stable per path, as real API objects are: effects that depend on one must not re-run each render.
const inert = (): unknown => {
  const children = new Map<PropertyKey, unknown>();
  return new Proxy(() => Promise.resolve(undefined), {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (!children.has(key)) children.set(key, inert());
      return children.get(key);
    },
  });
};
const inertApis = inert() as React.ContextType<typeof RuntimeAPIContext>;

interface RowSample { id: string; top: number; opacity: number }
interface SidebarSample {
  t: number;
  rows: RowSample[];
  ghosts: number;
  selection: { top: number; height: number } | null;
  current: { id: string; top: number; background: string } | null;
  hover: { top: number; opacity: number } | null;
}

const patch = (id: string, change: (thread: ThreadSummary) => ThreadSummary) => useThreadStore.setState(state => ({
  threads: state.threads.map(thread => (thread.thread_id === id ? change(thread) : thread)),
}));

export function SidebarLab() {
  React.useState(() => {
    useProjectsStore.setState({ projects: [
      { id: 'p-auth', path: '/workspace/auth', label: 'auth' },
      { id: 'p-ui', path: '/workspace/ui', label: 'ui' },
    ] as unknown as ReturnType<typeof useProjectsStore.getState>['projects'] });
    useSessionDisplayStore.setState({ sessionGroupingMode: 'by-worktree', showRecentSection: true, projectsSectionCollapsed: false });
    useThreadStore.setState({
      threads: seed(), selectedIdentity: { threadId: 'auth-1', branchId: 'auth-1-main' }, catalogLoaded: true, catalogLoading: false, catalogError: null,
      updateThread: async (id: string, change: Partial<ThreadSummary>) => { patch(id, thread => ({ ...thread, ...change })); },
      deleteThread: async (id: string) => { useThreadStore.setState(state => ({ threads: state.threads.filter(thread => thread.thread_id !== id) })); },
      loadCatalog: async () => {},
    } as unknown as Partial<ReturnType<typeof useThreadStore.getState>>);
  });

  React.useEffect(() => {
    let recording: SidebarSample[] | null = null;
    let frame = 0;
    const list = () => document.querySelector<HTMLElement>('[data-sidebar-hover]');
    const sample = () => {
      const root = list();
      if (recording && root) {
        const rows = [...root.querySelectorAll<HTMLElement>('[data-sidebar-row]')].filter(row => !row.closest('[data-flip-ghost]'));
        const selection = root.querySelector<HTMLElement>('.sidebar-selection');
        const current = rows.find(row => row.hasAttribute('data-current'));
        const hover = root.querySelector<HTMLElement>('.sidebar-hover');
        recording.push({
          t: performance.now(),
          rows: rows.map(row => ({ id: row.getAttribute('data-sidebar-row')!, top: row.getBoundingClientRect().top, opacity: Number(getComputedStyle(row.parentElement!).opacity) })),
          ghosts: root.querySelectorAll('[data-flip-ghost]').length,
          selection: selection ? { top: selection.getBoundingClientRect().top, height: selection.getBoundingClientRect().height } : null,
          current: current ? { id: current.getAttribute('data-sidebar-row')!, top: current.getBoundingClientRect().top, background: getComputedStyle(current).backgroundColor } : null,
          hover: hover ? { top: hover.getBoundingClientRect().top, opacity: Number(getComputedStyle(hover).opacity) } : null,
        });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const lab = {
      setMotion(preference: MotionPreference) { useUIStore.getState().setMotionPreference(preference); },
      record() { recording = []; },
      stopRecording() { const result = recording ?? []; recording = null; return result; },
      select(id: string | null) { useThreadStore.setState({ selectedIdentity: id ? { threadId: id, branchId: `${id}-main` } : null } as never); },
      pin(id: string, pinned = true) { patch(id, thread => ({ ...thread, pinned })); },
      busy(id: string, busy = true) { patch(id, thread => ({ ...thread, branches: thread.branches.map(branch => ({ ...branch, active_run_id: busy ? 'run' : null })) })); },
      unread(id: string, unread = true) { patch(id, thread => ({ ...thread, unread })); },
      remove(id: string) { useThreadStore.setState(state => ({ threads: state.threads.filter(thread => thread.thread_id !== id) })); },
      add(id: string, title: string, project: string | null) { useThreadStore.setState(state => ({ threads: [...state.threads, summary(id, title, project)] })); },
    };
    (window as unknown as { __sidebar: typeof lab }).__sidebar = lab;
    return () => cancelAnimationFrame(frame);
  }, []);

  // The lab owns no Host: every runtime API resolves to nothing.
  return <RuntimeAPIContext.Provider value={inertApis}>
    <div className="flex h-full bg-background text-foreground">
      <aside className="flex h-full w-[280px] shrink-0 flex-col border-r border-border bg-sidebar">
        <ConversationSidebar />
      </aside>
      <main className="flex-1" />
    </div>
  </RuntimeAPIContext.Provider>;
}
