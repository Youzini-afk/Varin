import React from 'react';
import { toast } from '@/components/ui';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';
import { parseRoute, updateBrowserURL, hasRouteParams } from '@/lib/router';
import type { RouteState, AppRouteState } from '@/lib/router';
import type { MainTab } from '@/stores/useUIStore';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { isEmbeddedSessionChat } from '@/components/layout/contextPanelEmbeddedChat';
import { openThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';

/**
 * Hook that provides bidirectional URL routing for Varin.
 *
 * On mount:
 * - Parses URL parameters and applies them to app state
 * - Sets up subscriptions to sync state changes back to URL
 * - Listens for browser back/forward navigation
 *
 * Works in:
 * - Web: Full bidirectional sync
 * - Desktop: Full bidirectional sync
 * - Embedded session-chat iframe (`?panel=session-chat`): No URL updates.
 *   The iframe's session identity is fixed at mount (the parent builds the
 *   src with `threadId`); in-place subtask navigation must NOT rewrite the
 *   URL, otherwise the embedded Varin identity params get stripped and
 *   `isEmbeddedSessionChat()` starts returning false, breaking subsequent
 *   "Open subtask" clicks.
 */
export function useRouter(options: { enabled?: boolean } = {}): void {
  const enabled = options.enabled ?? true;
  // Captured once at mount: the iframe's embedded-ness never changes during
  // its lifetime (a parent src swap is a full reload).
  const isEmbeddedChat = React.useMemo(() => isEmbeddedSessionChat(), []);

  // Track initialization to avoid duplicate applies
  const initializedRef = React.useRef(false);
  const isApplyingRouteRef = React.useRef(false);
  const activeRouteAppliesRef = React.useRef(0);
  const latestRouteApplyRef = React.useRef(0);

  // Get store actions (stable references)
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const navigateToDiff = useUIStore((state) => state.navigateToDiff);

  /**
   * Apply a parsed route state to the application stores.
   */
  const applyRoute = React.useCallback(
    async (route: RouteState) => {
      if (!enabled) {
        return;
      }

      const applyId = ++latestRouteApplyRef.current;
      activeRouteAppliesRef.current += 1;
      isApplyingRouteRef.current = true;

      try {
        // 1. Apply session first (may trigger async operations)
        if (route.threadId) {
          const sessionState = useThreadStore.getState();
          if (route.threadId !== sessionState.selectedIdentity?.threadId || route.branchId !== sessionState.selectedIdentity?.branchId) {
            await openThreadFromNavigation({ directory: route.directory, threadId: route.threadId, ...(route.branchId ? { branchId: route.branchId } : {}) });
          }
        }

        // A newer back/forward action owns the remaining UI route state.
        if (applyId !== latestRouteApplyRef.current) return;

        // 2. Handle settings (takes precedence over tabs - it's a full-screen overlay)
        if (route.settingsPath) {
          setSettingsPage(resolveSettingsSlug(route.settingsPath));
          setSettingsDialogOpen(true);
          // Don't process tab when settings is open
          return;
        }

        // Close settings if URL has no settings section
        if (useUIStore.getState().isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }

        // 3. Apply tab
        if (route.tab) {
          setActiveMainTab(route.tab);
        }

        // 4. Apply diff file (only if going to diff tab)
        if (route.diffFile && (route.tab === 'diff' || !route.tab)) {
          navigateToDiff(route.diffFile);
        }
      } catch (error) {
        if (applyId === latestRouteApplyRef.current) toast.error(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        activeRouteAppliesRef.current = Math.max(0, activeRouteAppliesRef.current - 1);
        isApplyingRouteRef.current = activeRouteAppliesRef.current > 0;
      }
    },
    [enabled, setActiveMainTab, setSettingsDialogOpen, setSettingsPage, navigateToDiff]
  );

  /**
   * Get current app state for URL serialization.
   */
  const getCurrentAppState = React.useCallback((): AppRouteState => {
    const sessionState = useThreadStore.getState();
    const uiState = useUIStore.getState();

    return {
      threadId: sessionState.selectedIdentity?.threadId ?? null,
      branchId: sessionState.selectedIdentity?.branchId ?? null,
      tab: uiState.activeMainTab,
      isSettingsOpen: uiState.isSettingsDialogOpen,
      settingsPath: uiState.settingsPage,
      diffFile: uiState.pendingDiffFile,
    };
  }, []);

  /**
   * Sync current app state to URL.
   */
  const syncURLFromState = React.useCallback(
    (options: { replace?: boolean } = {}) => {
      if (!enabled || isEmbeddedChat || isApplyingRouteRef.current) {
        return;
      }

      const state = getCurrentAppState();
      updateBrowserURL(state, options);
    },
    [enabled, isEmbeddedChat, getCurrentAppState]
  );

  // Initialize: parse URL and apply route on mount
  React.useEffect(() => {
    if (initializedRef.current) {
      return;
    }

    if (!enabled) {
      return;
    }

    initializedRef.current = true;

    // Only process if URL has route params
    if (!hasRouteParams()) {
      // No route params - just set up sync (URL will update when user navigates)
      return;
    }

    const route = parseRoute();

    // Apply the initial route
    const initializeRoute = async () => {
      const applied = await applyRoute(route);
      if (applied === false) return;

      // After applying, update URL to normalized form (use replaceState).
      // Use the parsed route values instead of an immediate store snapshot so
      // deep links do not briefly normalize `?thread=...` back to `/` while
      // the session's directory/message bootstrap is still catching up.
      if (!isEmbeddedChat) {
        updateBrowserURL({
          ...getCurrentAppState(),
          threadId: route.threadId ?? useThreadStore.getState().selectedIdentity?.threadId ?? null,
          branchId: route.branchId ?? useThreadStore.getState().selectedIdentity?.branchId ?? null,
          tab: route.tab ?? useUIStore.getState().activeMainTab,
          settingsPath: route.settingsPath ?? useUIStore.getState().settingsPage,
          diffFile: route.diffFile ?? useUIStore.getState().pendingDiffFile,
        }, { replace: true, force: true });
      }
    };

    void initializeRoute();
  }, [applyRoute, enabled, getCurrentAppState, isEmbeddedChat]);

  // Subscribe to session changes
  React.useEffect(() => {
    if (!enabled || isEmbeddedChat) {
      return;
    }

    let prevSessionId = JSON.stringify(useThreadStore.getState().selectedIdentity);

    const unsubscribe = useThreadStore.subscribe((state) => {
      const threadId = JSON.stringify(state.selectedIdentity);

      // Skip if no change or if we're currently applying a route
      if (threadId === prevSessionId || isApplyingRouteRef.current) {
        return;
      }

      prevSessionId = threadId;
      syncURLFromState();
    });

    return unsubscribe;
  }, [enabled, isEmbeddedChat, syncURLFromState]);

  // Subscribe to UI store changes (tab, settings)
  React.useEffect(() => {
    if (!enabled || isEmbeddedChat) {
      return;
    }

    let prevTab: MainTab = useUIStore.getState().activeMainTab;
    let prevSettingsOpen: boolean = useUIStore.getState().isSettingsDialogOpen;
    let prevSettingsPath: string = useUIStore.getState().settingsPage;
    let prevDiffFile: string | null = useUIStore.getState().pendingDiffFile;

    const unsubscribe = useUIStore.subscribe((state) => {
      // Skip if we're currently applying a route
      if (isApplyingRouteRef.current) {
        return;
      }

      const tabChanged = state.activeMainTab !== prevTab;
      const settingsOpenChanged = state.isSettingsDialogOpen !== prevSettingsOpen;
      const settingsPathChanged = state.settingsPage !== prevSettingsPath;
      const diffFileChanged = state.pendingDiffFile !== prevDiffFile && state.activeMainTab === 'diff';

      // Update tracking vars
      prevTab = state.activeMainTab;
      prevSettingsOpen = state.isSettingsDialogOpen;
      prevSettingsPath = state.settingsPage;
      prevDiffFile = state.pendingDiffFile;

      // Only sync if something relevant changed
      if (tabChanged || settingsOpenChanged || settingsPathChanged || diffFileChanged) {
        syncURLFromState();
      }
    });

    return unsubscribe;
  }, [enabled, isEmbeddedChat, syncURLFromState]);

  // Listen for browser back/forward navigation
  React.useEffect(() => {
    if (typeof window === 'undefined' || !enabled || isEmbeddedChat) {
      return;
    }

    const handlePopState = () => {
      // Parse the new URL and apply it
      const route = parseRoute();

      // Check if this is a route with any params, or if we should restore defaults
      if (hasRouteParams()) {
        void applyRoute(route);
      } else {
        // URL has no route params - this might be a "back to home" navigation
        // Close settings if open, keep current session
        const uiState = useUIStore.getState();
        if (uiState.isSettingsDialogOpen) {
          setSettingsDialogOpen(false);
        }
        // Reset to chat tab if not already there
        if (uiState.activeMainTab !== 'chat') {
          setActiveMainTab('chat');
        }
      }
    };

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [applyRoute, enabled, isEmbeddedChat, setActiveMainTab, setSettingsDialogOpen]);
}
