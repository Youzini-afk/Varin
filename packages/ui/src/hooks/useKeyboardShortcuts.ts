import React from 'react';
import { isTerminalEventTarget } from '@/lib/terminalFocus';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { readEmbeddedThemeSearchParams } from '@/contexts/theme-embedded-bootstrap';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { focusChatInput } from '@/components/chat/composer/editor/dom';
import { hasOpenDropdown } from './keyboard-shortcut-dom';
import { toast } from '@/components/ui';
import { startThreadFromNavigation } from '@/lib/agent-runtime/threadNavigation';
import { createWorktreeThread } from '@/lib/agent-runtime/worktreeThread';
import { useThreadStore } from '@/stores/useThreadStore';
import { cancelSelectedThreadRun, cycleThreadModel } from '@/lib/agent-runtime/keyboardActions';
import { addSelectionToChat } from '@/lib/agent-runtime/addSelectionToChat';
import { requestIdeSearch } from '@/lib/workbench/ide-search-events';

const focusThreadTimeline = (): void => {
  const timeline = document.querySelector<HTMLElement>('[data-thread-conversation="true"]');
  timeline?.focus({ preventScroll: true });
  timeline?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

export const useKeyboardShortcuts = () => {
  const currentSessionId = useThreadStore(state => state.selectedIdentity?.threadId ?? null);
  const isWorking = useThreadStore(state => Boolean(state.threads.find(thread => thread.thread_id === state.selectedIdentity?.threadId)?.branches.find(branch => branch.branch_id === state.selectedIdentity?.branchId)?.active_run_id));
  const abortCurrentOperation = cancelSelectedThreadRun;
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const toggleHelpDialog = useUIStore((s) => s.toggleHelpDialog);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const currentShortcutDirectory = useDirectoryStore((s) => s.currentDirectory);

  // The terminal lives in the context panel; these mirror the rail behavior.
  const toggleTerminalSurface = React.useCallback(() => {
    if (!currentShortcutDirectory) return;
    useUIStore.getState().openContextSurface(normalizeContextPanelDirectoryKey(currentShortcutDirectory), 'terminal');
  }, [currentShortcutDirectory]);

  const toggleTerminalSurfaceExpanded = React.useCallback(() => {
    if (!currentShortcutDirectory) return;
    const key = normalizeContextPanelDirectoryKey(currentShortcutDirectory);
    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory[key];
    const activeMode = panel?.isOpen ? panel.tabs.find((tab) => tab.id === panel.activeTabId)?.mode : null;
    if (activeMode !== 'terminal') {
      state.openContextSurface(key, 'terminal');
    }
    state.toggleContextPanelExpanded(key);
  }, [currentShortcutDirectory]);
  const isMobile = useUIStore((s) => s.isMobile);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setModelSelectorOpen = useUIStore((s) => s.setModelSelectorOpen);
  const setPromptNavigatorPanelOpen = useUIStore((s) => s.setPromptNavigatorPanelOpen);
  const toggleExpandedInput = useUIStore((s) => s.toggleExpandedInput);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const { themeMode, setThemeMode } = useThemeSystem();
  const abortPrimedRef = React.useRef<{ expiresAt: number; sessionId: string } | null>(null);
  const abortPrimedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const themeModeRef = React.useRef(themeMode);

  React.useEffect(() => {
    themeModeRef.current = themeMode;
  }, [themeMode]);

  const resetAbortPriming = React.useCallback(() => {
    if (abortPrimedTimeoutRef.current) {
      clearTimeout(abortPrimedTimeoutRef.current);
      abortPrimedTimeoutRef.current = null;
    }
    abortPrimedRef.current = null;
  }, []);

  React.useEffect(() => {
    const combo = (actionId: string) => getEffectiveShortcutCombo(actionId, shortcutOverrides);
    const dropdownTargetSelector = [
      '[data-slot="dropdown-menu-content"]',
      '[data-slot="select-content"]',
      '[role="combobox"]',
      '[role="listbox"]',
      '[role="menu"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[data-radix-popper-content-wrapper]',
    ].join(',');

    const isDropdownEventTarget = (target: EventTarget | null) => {
      return target instanceof Element && Boolean(target.closest(dropdownTargetSelector));
    };

    const handleTerminalShortcutCapture = (e: KeyboardEvent) => {
      if (!isTerminalEventTarget(e.target)) {
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        toggleTerminalSurface();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal_expanded'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        toggleTerminalSurfaceExpanded();
        return;
      }
    };

    const handleEscapeKeyDownCapture = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;

      const target = e.target as Element | null;
      const isInsideDialog = Boolean(target?.closest('[role="dialog"]'));
      const isSettingsMounted = Boolean(document.querySelector('[data-settings-view="true"]'));
      const isInsideTerminal = isTerminalEventTarget(target);
      const hasDropdownInteraction = isDropdownEventTarget(target) || hasOpenDropdown();

      const {
        isSettingsDialogOpen,
        isCommandPaletteOpen,
        isHelpDialogOpen,
        isSessionSwitcherOpen,
        isAboutDialogOpen,
        isMultiRunLauncherOpen,
        isImagePreviewOpen,
        activeMainTab,
        isPromptNavigatorPanelOpen,
      } = useUIStore.getState();

      if (isInsideDialog || isInsideTerminal || hasDropdownInteraction) {
        resetAbortPriming();
        return;
      }

      if (isPromptNavigatorPanelOpen) {
        e.preventDefault();
        setPromptNavigatorPanelOpen(false);
        resetAbortPriming();
        return;
      }

      if (isSettingsDialogOpen) {
        e.preventDefault();
        setSettingsDialogOpen(false);
        resetAbortPriming();
        return;
      }

      if (isSettingsMounted) {
        resetAbortPriming();
        return;
      }

      const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen || isMultiRunLauncherOpen || isImagePreviewOpen;
      const isChatActive = activeMainTab === 'chat';

      if (hasOverlay || !isChatActive) {
        resetAbortPriming();
        return;
      }

      const sessionId = currentSessionId;
      if (!isWorking || !sessionId) {
        resetAbortPriming();
        return;
      }

      const now = Date.now();
      const primed = abortPrimedRef.current;

      if (primed?.sessionId === sessionId && now < primed.expiresAt) {
        e.preventDefault();
        resetAbortPriming();
        void abortCurrentOperation().catch((error) => {
          toast.error('Failed to stop run', {
            description: error instanceof Error ? error.message : String(error),
          });
        });
        return;
      }

      e.preventDefault();
      const expiresAt = now + 3000;
      abortPrimedRef.current = { expiresAt, sessionId };
      toast.message('Press Escape again to stop the current run');

      if (abortPrimedTimeoutRef.current) {
        clearTimeout(abortPrimedTimeoutRef.current);
      }

      const delay = Math.max(expiresAt - now, 0);
      abortPrimedTimeoutRef.current = setTimeout(() => {
        const current = abortPrimedRef.current;
        if (current?.sessionId === sessionId && Date.now() >= current.expiresAt) {
          resetAbortPriming();
        }
      }, delay || 0);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key === 'Escape' || isTerminalEventTarget(e.target)) {
        return;
      }

      if (eventMatchesShortcut(e, combo('open_command_palette'))) {
        e.preventDefault();
        toggleCommandPalette();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_timeline_dialog'))) {
        if (!currentSessionId) return;
        e.preventDefault();
        useUIStore.getState().setTimelineDialogOpen(true);
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_prompt_navigator'))) {
        const {
          activeMainTab,
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          isVarinDiagnosticsDialogOpen,
          isMultiRunLauncherOpen,
          isImagePreviewOpen,
        } = useUIStore.getState();

        if (activeMainTab !== 'chat') {
          return;
        }

        const hasOverlay = isSettingsDialogOpen
          || isCommandPaletteOpen
          || isHelpDialogOpen
          || isSessionSwitcherOpen
          || isAboutDialogOpen
          || isVarinDiagnosticsDialogOpen
          || isMultiRunLauncherOpen
          || isImagePreviewOpen;

        if (hasOverlay) {
          return;
        }

        e.preventDefault();
        focusThreadTimeline();
        return;
      }

      if (eventMatchesShortcut(e, combo('open_diagnostics'))) {
        e.preventDefault();
        useUIStore.getState().setVarinDiagnosticsDialogOpen(true);
        return;
      }

      if (eventMatchesShortcut(e, combo('open_help'))) {
        e.preventDefault();
        toggleHelpDialog();
        return;
      }

      const matchedNewSessionShortcut = eventMatchesShortcut(e, combo('new_chat'));
      const matchedWorktreeShortcut = eventMatchesShortcut(e, combo('new_chat_worktree'));

      if (matchedNewSessionShortcut || matchedWorktreeShortcut) {
        if (e.repeat) return;
        e.preventDefault();
        const creation = matchedWorktreeShortcut ? createWorktreeThread() : startThreadFromNavigation();
        void creation.catch((error) => {
          toast.error(
            matchedWorktreeShortcut
              ? 'Failed to create conversation'
              : 'Failed to create conversation',
            { description: error instanceof Error ? error.message : String(error) },
          );
        });
        return;
      }

      if (eventMatchesShortcut(e, combo('cycle_theme'))) {
        e.preventDefault();
        if (readEmbeddedThemeSearchParams() !== null && window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'varin:cycle-theme-request' }, window.location.origin);
          return;
        }
        const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
        const activeElement = document.activeElement as HTMLElement | null;
        const currentIndex = modes.indexOf(themeModeRef.current);
        const nextIndex = (currentIndex + 1) % modes.length;
        setThemeMode(modes[nextIndex]);
        requestAnimationFrame(() => {
          if (typeof document === 'undefined' || typeof window === 'undefined') {
            return;
          }
          if (!document.hasFocus()) {
            window.focus();
          }
          if (activeElement && document.contains(activeElement)) {
            activeElement.focus({ preventScroll: true });
          }
        });
        return;
      }

      if (eventMatchesShortcut(e, combo('open_settings'))) {
        e.preventDefault();
        const { isSettingsDialogOpen } = useUIStore.getState();
        setSettingsDialogOpen(!isSettingsDialogOpen);
        return;
      }

      if (eventMatchesShortcut(e, combo('add_selection_to_chat'))) {
        e.preventDefault();
        void addSelectionToChat();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_sidebar'))) {
        e.preventDefault();
        const { isMobile, isSessionSwitcherOpen } = useUIStore.getState();
        if (isMobile) {
          setSessionSwitcherOpen(!isSessionSwitcherOpen);
        } else {
          toggleSidebar();
        }
        return;
      }

      if (eventMatchesShortcut(e, combo('focus_input'))) {
        e.preventDefault();
        focusChatInput();
        return;
      }

      // Legacy right-sidebar shortcuts now target the context surfaces that
      // replaced the sidebar's tabs.
      if (eventMatchesShortcut(e, combo('toggle_right_sidebar'))) {
        const state = useUIStore.getState();
        if (state.isMobile || !currentDirectory) {
          return;
        }
        e.preventDefault();
        const directory = normalizeContextPanelDirectoryKey(currentDirectory);
        const panelState = state.contextPanelByDirectory[directory];
        if (panelState?.isOpen) {
          state.closeContextPanel(directory);
        } else if (panelState?.activeTabId) {
          state.setActiveContextPanelTab(directory, panelState.activeTabId);
        } else {
          state.openContextSurface(directory, 'git');
        }
        return;
      }

      if (eventMatchesShortcut(e, combo('open_right_sidebar_git'))) {
        const state = useUIStore.getState();
        if (state.isMobile || !currentDirectory) {
          return;
        }
        e.preventDefault();
        state.openContextSurface(normalizeContextPanelDirectoryKey(currentDirectory), 'git');
        return;
      }

      if (
        eventMatchesShortcut(e, combo('toggle_files'))
        || eventMatchesShortcut(e, combo('open_right_sidebar_files'))
      ) {
        const state = useUIStore.getState();
        if (state.isMobile) {
          return;
        }
        e.preventDefault();
        if (requestIdeSearch({ mode: 'content' })) return;
        if (!currentDirectory) return;
        state.openContextSurface(normalizeContextPanelDirectoryKey(currentDirectory), 'file');
        return;
      }

      if (eventMatchesShortcut(e, combo('open_diff_panel'))) {
        const state = useUIStore.getState();
        if (state.isMobile || !currentDirectory) {
          return;
        }
        e.preventDefault();
        state.openContextSurface(normalizeContextPanelDirectoryKey(currentDirectory), 'diff');
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleTerminalSurface();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_terminal_expanded'))) {
        const { isMobile } = useUIStore.getState();
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleTerminalSurfaceExpanded();
        return;
      }

      // Cmd/Ctrl+Shift+M: Open model selector (same conditions as double-ESC: chat tab, no overlays)
      if (eventMatchesShortcut(e, combo('open_model_selector'))) {
        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          activeMainTab,
          isModelSelectorOpen,
        } = useUIStore.getState();

        // Skip if settings open
        if (isSettingsDialogOpen) {
          return;
        }

        // Skip if any overlay open or not on chat tab
        const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
        const isChatActive = activeMainTab === 'chat';

        if (hasOverlay || !isChatActive) {
          return;
        }

        e.preventDefault();
        setModelSelectorOpen(!isModelSelectorOpen);
        return;
      }

      // Cmd/Ctrl+Shift+T: cycle the thinking levels supported by the active model.
      if (eventMatchesShortcut(e, combo('cycle_thinking_variant'))) {
        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          activeMainTab,
        } = useUIStore.getState();

        if (isSettingsDialogOpen) {
          return;
        }

        const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
        const isChatActive = activeMainTab === 'chat';

        if (hasOverlay || !isChatActive) {
          return;
        }

        e.preventDefault();
        void cycleThreadModel().catch(error => toast.error(String(error)));
        return;
      }

      // Ctrl+] / Ctrl+[: Cycle through starred models (same gating as Shift+M)
      if (
        eventMatchesShortcut(e, combo('cycle_favorite_model_forward')) ||
        eventMatchesShortcut(e, combo('cycle_favorite_model_backward'))
      ) {
        const {
          isSettingsDialogOpen,
          isCommandPaletteOpen,
          isHelpDialogOpen,
          isSessionSwitcherOpen,
          isAboutDialogOpen,
          activeMainTab,
          favoriteModels,
        } = useUIStore.getState();

        if (isSettingsDialogOpen) {
          return;
        }

        const hasOverlay = isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isAboutDialogOpen;
        const isChatActive = activeMainTab === 'chat';

        if (hasOverlay || !isChatActive || favoriteModels.length === 0) {
          return;
        }

        e.preventDefault();

        void cycleThreadModel(eventMatchesShortcut(e, combo('cycle_favorite_model_forward')) ? 1 : -1).catch(error => toast.error(String(error)));
        return;
      }

      if (eventMatchesShortcut(e, combo('expand_input'))) {
        if (isMobile) {
          return;
        }
        e.preventDefault();
        toggleExpandedInput();
        return;
      }

      if (eventMatchesShortcut(e, combo('toggle_dictation'))) {
        const { activeMainTab, isCommandPaletteOpen, isHelpDialogOpen, isSessionSwitcherOpen, isSettingsDialogOpen } = useUIStore.getState();
        if (activeMainTab !== 'chat' || isCommandPaletteOpen || isHelpDialogOpen || isSessionSwitcherOpen || isSettingsDialogOpen) {
          return;
        }
        e.preventDefault();
        // Dictation state lives inside the composer's isolated component;
        // toggle it via an event instead of subscribing this hot hook to it.
        window.dispatchEvent(new CustomEvent('varin:dictation-toggle'));
        return;
      }

    };

    window.addEventListener('keydown', handleTerminalShortcutCapture, true);
    window.addEventListener('keydown', handleEscapeKeyDownCapture, true);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleTerminalShortcutCapture, true);
      window.removeEventListener('keydown', handleEscapeKeyDownCapture, true);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    abortCurrentOperation,
    toggleCommandPalette,
    toggleHelpDialog,
    toggleSidebar,
    toggleTerminalSurface,
    toggleTerminalSurfaceExpanded,
    isMobile,
    setSessionSwitcherOpen,
    setSettingsDialogOpen,
    setModelSelectorOpen,
    setPromptNavigatorPanelOpen,
    toggleExpandedInput,
    setThemeMode,
    isWorking,
    resetAbortPriming,
    currentSessionId,
    currentDirectory,
    shortcutOverrides,
  ]);

  React.useEffect(() => {
    return () => {
      resetAbortPriming();
    };
  }, [resetAbortPriming]);
};
