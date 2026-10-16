import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';

// 'by-worktree' is the persisted legacy value for the hierarchical session tree;
// 'flat' removes parent/child indentation while preserving project ownership.
type SessionGroupingMode = 'by-worktree' | 'flat';

type SessionDisplayStore = {
  sessionGroupingMode: SessionGroupingMode;
  setSessionGroupingMode: (mode: SessionGroupingMode) => void;
  /** Project/recent zone headers stick to the top while their zone scrolls. */
  stickyZoneHeaders: boolean;
  toggleStickyZoneHeaders: () => void;
  showRecentSection: boolean;
  projectsSectionCollapsed: boolean;
  setProjectsSectionCollapsed: (collapsed: boolean) => void;
  projectSortOrder: ProjectSortOrder;
  setShowRecentSection: (show: boolean) => void;
  toggleRecentSection: () => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
};

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      sessionGroupingMode: 'by-worktree',
      setSessionGroupingMode: (mode) => set({ sessionGroupingMode: mode }),
      stickyZoneHeaders: true,
      toggleStickyZoneHeaders: () => set((state) => ({ stickyZoneHeaders: !state.stickyZoneHeaders })),
      showRecentSection: true,
      projectsSectionCollapsed: false,
      setProjectsSectionCollapsed: (collapsed) => set({ projectsSectionCollapsed: collapsed }),
      projectSortOrder: 'manual',
      setShowRecentSection: (show) => set({ showRecentSection: show }),
      toggleRecentSection: () => set((state) => ({ showRecentSection: !state.showRecentSection })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
    }),
    {
      name: 'varin.sessionDisplay.v1',
      storage: createDeferredSafeJSONStorage(),
    },
  ),
);

export type { ProjectSortOrder, SessionGroupingMode };
