import React from 'react';
import { ContextPanel } from '@/components/layout/ContextPanel';
import { ContextPanelRail } from '@/components/layout/ContextPanelRail';
import { ContextPanelGitNavigation } from '@/components/layout/ContextPanelGitNavigation';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore } from '@/stores/useGitStore';
import { normalizeContextPanelDirectoryKey, useUIStore, type MotionPreference } from '@/stores/useUIStore';

/**
 * Rail scene: the real context rail for one directory, with the panel state
 * and Git status set through their stores. `window.__rail` opens surfaces,
 * sets the change count and records the bar and the tooltip frame by frame.
 */

const DIRECTORY = '/workspace/lab';
const PROSE = '对话优先的阅读节奏：面板从导轨一侧滑出，会话画布同步让出位置，正文一次排到最终宽度，再随画布居中滑到新位置。'.repeat(12);
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

const setChanges = (count: number) => {
  const directories = new Map(useGitStore.getState().directories);
  const current = directories.get(DIRECTORY) ?? { isGitRepo: true, status: null, branches: null, log: null, identity: null, diffCache: new Map(), indexRevision: 0,
    lastRepoCheckAt: 0, lastStatusFetch: Date.now(), lastStatusChange: 0, lastLogFetch: 0, lastBranchesFetch: 0, lastIdentityFetch: 0, logMaxCount: 50,
    isLoadingStatus: false, isLoadingLog: false, isLoadingBranches: false, isLoadingIdentity: false };
  const files = Array.from({ length: count }, (_, index) => ({ path: `src/file-${index}.ts`, index: 'M', working_dir: ' ' }));
  directories.set(DIRECTORY, { ...current, status: { ...(current.status ?? {}), files } } as never);
  useGitStore.setState({ directories });
};

interface RailSample {
  t: number;
  bar: { top: number; opacity: number } | null;
  active: { mode: string; top: number } | null;
  tooltip: { top: number; text: string } | null;
  badge: { scale: string; opacity: number; text: string } | null;
  /** The main column and the panel beside it. */
  main: number;
  panel: number;
  edges: { mainLeft: number; mainRight: number; panelLeft: number; gap: number };
  column: { left: number; width: number } | null;
  content: { left: number; opacity: number } | null;
}

const geometry = (): Pick<RailSample, 'edges' | 'column' | 'content'> => {
  const main = document.querySelector<HTMLElement>('[data-lab-main]')!.getBoundingClientRect();
  const aside = document.querySelector<HTMLElement>('[data-context-panel]')!;
  const panel = aside.getBoundingClientRect();
  const column = document.querySelector<HTMLElement>('[data-lab-main] .chat-message-column')?.getBoundingClientRect();
  const content = aside.querySelector<HTMLElement>(':scope > div:last-child');
  return {
    edges: { mainLeft: main.left, mainRight: main.right, panelLeft: panel.left, gap: Number.parseFloat(getComputedStyle(aside).marginLeft) || 0 },
    column: column ? { left: column.left, width: column.width } : null,
    content: content ? { left: content.getBoundingClientRect().left, opacity: Number(getComputedStyle(content).opacity) } : null,
  };
};

export function RailLab() {
  const [gitMode, setGitMode] = React.useState<'git' | 'pr'>('git');
  const gitModeRef = React.useRef(setGitMode);
  React.useState(() => {
    useDirectoryStore.setState({ currentDirectory: DIRECTORY } as never);
    setChanges(0);
  });

  React.useEffect(() => {
    let recording: RailSample[] | null = null;
    let frame = 0;
    const sample = () => {
      const nav = document.querySelector<HTMLElement>('#context-panel-rail');
      if (recording && nav) {
        const bar = nav.querySelector<HTMLElement>('.rail-indicator');
        const active = nav.querySelector<HTMLElement>('[data-rail-surface][aria-pressed="true"]');
        const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
        const badge = nav.querySelector<HTMLElement>('.rail-badge');
        recording.push({
          t: performance.now(),
          bar: bar ? { top: bar.getBoundingClientRect().top, opacity: Number(getComputedStyle(bar).opacity) } : null,
          active: active ? { mode: active.getAttribute('data-rail-surface')!, top: active.getBoundingClientRect().top } : null,
          tooltip: popup ? { top: popup.getBoundingClientRect().top, text: popup.textContent ?? '' } : null,
          badge: badge ? { scale: getComputedStyle(badge).scale, opacity: Number(getComputedStyle(badge).opacity), text: badge.querySelector('.swap-text-current')?.textContent ?? '' } : null,
          main: document.querySelector('[data-lab-main]')?.getBoundingClientRect().width ?? 0,
          panel: document.querySelector('[data-context-panel]')?.getBoundingClientRect().width ?? 0,
          ...geometry(),
        });
      }
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    const key = normalizeContextPanelDirectoryKey(DIRECTORY);
    const lab = {
      setMotion(preference: MotionPreference) { useUIStore.getState().setMotionPreference(preference); },
      record() { recording = []; },
      stopRecording() { const result = recording ?? []; recording = null; return result; },
      /** Open a surface by mode, as a rail click does. */
      open(mode: string) {
        const state = useUIStore.getState();
        const panel = state.contextPanelByDirectory[key];
        const active = panel?.tabs.find(tab => tab.id === panel.activeTabId);
        if (panel?.isOpen && active?.mode === mode) return;
        state.openContextSurface(key, mode as Parameters<typeof state.openContextSurface>[1]);
      },
      close() { useUIStore.getState().closeContextPanel(key); },
      changes(count: number) { setChanges(count); },
      modes() { return [...document.querySelectorAll('[data-rail-surface]')].map(node => node.getAttribute('data-rail-surface')); },
      gitTab(mode: 'git' | 'pr') { gitModeRef.current(mode); },
      /** The Git tabs' underline and the pressed tab, relative to the row. */
      underline() {
        const row = document.querySelector<HTMLElement>('[data-lab-git-tabs] nav');
        const line = row?.querySelector<HTMLElement>('.tab-underline');
        const tab = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
        if (!row || !line || !tab) return null;
        const base = row.getBoundingClientRect().left;
        return { left: line.getBoundingClientRect().left - base, width: line.getBoundingClientRect().width, tab: tab.getBoundingClientRect().left - base, tabWidth: tab.getBoundingClientRect().width };
      },
    };
    (window as unknown as { __rail: typeof lab }).__rail = lab;
    return () => cancelAnimationFrame(frame);
  }, []);

  // As MainLayout: the main column beside the panel, the rail outside the row.
  return <RuntimeAPIContext.Provider value={inertApis}>
    <div className="flex h-full bg-background text-foreground">
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* As MainLayout: the content is an absolute layer in the canvas, with a centred chat column. */}
        <main className="agent-conversation-canvas relative min-w-0 flex-1 overflow-hidden bg-background" data-lab-main>
          <div className="absolute inset-0 overflow-y-auto py-6">
            <div className="chat-message-column">
              {/* The Git panel's view tabs on their own, without a Git Host. */}
              <header className="mb-4 flex h-10 w-80 items-stretch border-b border-border" data-lab-git-tabs>
                <ContextPanelGitNavigation mode={gitMode} panelDirectory={DIRECTORY} repositoryDirectory={null} onReturnToChanges={() => undefined} />
              </header>
              <p className="max-w-none text-sm leading-7">{PROSE}</p>
            </div>
          </div>
        </main>
        <ContextPanel />
      </div>
      <div className="h-full w-11 border-l border-border"><ContextPanelRail /></div>
    </div>
  </RuntimeAPIContext.Provider>;
}
