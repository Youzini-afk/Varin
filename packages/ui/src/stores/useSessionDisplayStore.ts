import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createDeferredSafeJSONStorage } from './utils/safeStorage';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';

// 'by-worktree' is the persisted legacy value for the hierarchical session tree;
// 'flat' removes parent/child indentation while preserving project ownership.
type SessionGroupingMode = 'by-worktree' | 'flat';

export type ConversationTreeExpansion = {
  groups: Record<string, boolean>;
  sessions: Record<string, boolean>;
};
export const EMPTY_CONVERSATION_TREE: ConversationTreeExpansion = { groups: {}, sessions: {} };
export type OrganizationNavigationPreference = { view: 'classified' | 'recent'; expanded: Record<string, boolean>; focus: string | null };
export const EMPTY_ORGANIZATION_NAVIGATION: OrganizationNavigationPreference = { view: 'classified', expanded: {}, focus: null };

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
  /** Explicit choices only: project groups start open, child task trees start closed. */
  conversationTreeByHost: Record<string, ConversationTreeExpansion>;
  setConversationTreeExpansion: (host: string, changes: Partial<ConversationTreeExpansion>) => void;
  organizationNavigationByHost: Record<string, Record<string, OrganizationNavigationPreference>>;
  setOrganizationNavigation: (host: string, view: string, changes: Partial<OrganizationNavigationPreference>) => void;
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
      conversationTreeByHost: {},
      organizationNavigationByHost: {},
      setOrganizationNavigation: (host, view, changes) => set(state => {
        const views = state.organizationNavigationByHost[host] ?? {};
        const previous = views[view] ?? EMPTY_ORGANIZATION_NAVIGATION;
        return { organizationNavigationByHost: { ...state.organizationNavigationByHost, [host]: {
          ...views, [view]: { ...previous, ...changes, expanded: { ...previous.expanded, ...changes.expanded } },
        } } };
      }),
      setConversationTreeExpansion: (host, changes) => set(state => {
        const previous = state.conversationTreeByHost[host] ?? EMPTY_CONVERSATION_TREE;
        return { conversationTreeByHost: { ...state.conversationTreeByHost, [host]: {
          groups: { ...previous.groups, ...changes.groups },
          sessions: { ...previous.sessions, ...changes.sessions },
        } } };
      }),
    }),
    {
      name: 'varin.sessionDisplay.v1',
      storage: createDeferredSafeJSONStorage(),
    },
  ),
);

export type { ProjectSortOrder, SessionGroupingMode };
