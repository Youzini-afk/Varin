import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from '@/stores/utils/safeStorage';

export type BotPanelTab = 'overview' | 'activity' | 'memory' | 'schedule';
export const BOT_PANEL_TABS: readonly BotPanelTab[] = ['overview', 'activity', 'memory', 'schedule'];

/** Right panel geometry (docs/design/bot-ui.md §5.9). */
export const BOT_PANEL_WIDTH = { initial: 360, min: 300, max: 560, collapse: 240, step: 16, overshoot: 0.3 } as const;

export const clampBotPanelWidth = (width: number): number => Math.min(BOT_PANEL_WIDTH.max, Math.max(BOT_PANEL_WIDTH.min, Math.round(width)));

/** Width while dragging: 1:1 inside the range, 30% of the excess beyond it. */
export const dampBotPanelWidth = (width: number): number => {
  if (width > BOT_PANEL_WIDTH.max) return BOT_PANEL_WIDTH.max + (width - BOT_PANEL_WIDTH.max) * BOT_PANEL_WIDTH.overshoot;
  if (width < BOT_PANEL_WIDTH.min) return BOT_PANEL_WIDTH.min - (BOT_PANEL_WIDTH.min - width) * BOT_PANEL_WIDTH.overshoot;
  return width;
};

/** What the user has looked at, per Bot, so a tab's dot clears once seen. */
export interface BotSeenMarks { needs?: string; activityAtMs?: number }

interface BotLayoutState {
  /** The Bot sidebar's own preference; the shell swaps it into the shared sidebar while Bot is shown. */
  sidebarOpen: boolean;
  /** The ordinary workbench's sidebar while Bot is shown, restored on leaving (kept across a restart in Bot). */
  ordinarySidebar: boolean | null;
  panelOpen: boolean;
  panelWidth: number;
  tab: BotPanelTab;
  activityScope: 'all' | 'session';
  memoryScope: 'current' | 'all';
  seen: Record<string, BotSeenMarks>;
  setSidebarOpen(open: boolean): void;
  setOrdinarySidebar(open: boolean | null): void;
  setPanelOpen(open: boolean): void;
  setPanelWidth(width: number): void;
  setTab(tab: BotPanelTab): void;
  setActivityScope(scope: 'all' | 'session'): void;
  setMemoryScope(scope: 'current' | 'all'): void;
  markSeen(botId: string, marks: BotSeenMarks): void;
}

/** Presentation preferences for the Bot workbench only. Bot identity and work stay Host-owned. */
export const useBotLayout = create<BotLayoutState>()(persist((set) => ({
  sidebarOpen: false,
  ordinarySidebar: null,
  panelOpen: true,
  panelWidth: BOT_PANEL_WIDTH.initial,
  tab: 'overview',
  activityScope: 'all',
  memoryScope: 'current',
  seen: {},
  setSidebarOpen: sidebarOpen => set({ sidebarOpen }),
  setOrdinarySidebar: ordinarySidebar => set({ ordinarySidebar }),
  setPanelOpen: panelOpen => set({ panelOpen }),
  setPanelWidth: width => set({ panelWidth: clampBotPanelWidth(width) }),
  setTab: tab => set({ tab }),
  setActivityScope: activityScope => set({ activityScope }),
  setMemoryScope: memoryScope => set({ memoryScope }),
  markSeen: (botId, marks) => set(state => {
    const current = state.seen[botId] ?? {};
    const next = { ...current, ...marks };
    if (next.needs === current.needs && next.activityAtMs === current.activityAtMs) return state;
    return { seen: { ...state.seen, [botId]: next } };
  }),
}), {
  name: 'varin.botLayout.v1',
  storage: createDeferredSafeJSONStorage(),
  partialize: ({ sidebarOpen, ordinarySidebar, panelOpen, panelWidth, tab, activityScope, memoryScope, seen }) => ({ sidebarOpen, ordinarySidebar, panelOpen, panelWidth, tab, activityScope, memoryScope, seen }),
}));
