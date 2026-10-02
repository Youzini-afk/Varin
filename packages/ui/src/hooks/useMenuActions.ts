import React from 'react';
import { toast } from '@/components/ui';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { workspaceEvents } from '@/lib/workspaceEvents';
import {
  navigateRelativePiSession,
  startPiSessionDraftFromNavigation,
} from '@/lib/pi-runtime/sessionNavigation';
import { createPiWorktreeSession } from '@/lib/pi-runtime/worktreeSession';
import { addPiSelectionToChat } from '@/lib/pi-runtime/addSelectionToChat';
import { requestIdeSearch } from '@/lib/workbench/ide-search-events';

const getActiveElementSelectedText = (): string => {
  if (typeof document === 'undefined') {
    return '';
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLTextAreaElement) {
    return activeElement.value.slice(activeElement.selectionStart ?? 0, activeElement.selectionEnd ?? 0);
  }

  if (activeElement instanceof HTMLInputElement) {
    const type = activeElement.type?.toLowerCase() ?? 'text';
    if (['text', 'search', 'url', 'tel', 'password'].includes(type)) {
      return activeElement.value.slice(activeElement.selectionStart ?? 0, activeElement.selectionEnd ?? 0);
    }
  }

  if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
    return activeElement.ownerDocument.defaultView?.getSelection?.()?.toString() ?? '';
  }

  return '';
};

const copyCurrentSelectionFallback = async (): Promise<boolean> => {
  const selectionText = getActiveElementSelectedText() || window.getSelection()?.toString() || '';
  if (!selectionText.trim()) {
    return false;
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(selectionText);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback when Clipboard API is unavailable.
  }

  return document.execCommand('copy');
};

const MENU_ACTION_EVENT = 'varin:menu-action';
const CHECK_FOR_UPDATES_EVENT = 'varin:check-for-updates';

type DesktopBridgeGlobal = {
  listen?: (
    event: string,
    handler: (evt: { payload?: unknown }) => void
  ) => Promise<() => void>;
};

type MenuAction =
  | 'about'
  | 'settings'
  | 'command-palette'
  | 'quick-open'
  | 'new-session'
  | 'new-worktree-session'
  | 'change-workspace'
  | 'toggle-right-sidebar'
  | 'open-right-sidebar-git'
  | 'open-right-sidebar-files'
  | 'workspace-search'
  | 'toggle-terminal'
  | 'toggle-terminal-expanded'
  | 'copy'
  | 'add-selection-to-chat'
  | 'theme-light'
  | 'theme-dark'
  | 'theme-system'
  | 'toggle-sidebar'
  | 'go-back'
  | 'go-forward'
  | 'previous-session'
  | 'next-session'
  | 'previous-project'
  | 'next-project'
  | 'help-dialog'
  | 'show-diagnostics';

export const useMenuActions = (options: { enabled?: boolean } = {}) => {
  const enabled = options.enabled ?? true;
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const toggleHelpDialog = useUIStore((s) => s.toggleHelpDialog);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setAboutDialogOpen = useUIStore((s) => s.setAboutDialogOpen);
  const setVarinDiagnosticsDialogOpen = useUIStore((s) => s.setVarinDiagnosticsDialogOpen);
  const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
  const { setThemeMode } = useThemeSystem();
  const checkUpdatesInFlightRef = React.useRef(false);

  const handleCheckForUpdates = React.useCallback(() => {
    if (checkUpdatesInFlightRef.current) {
      return;
    }
    checkUpdatesInFlightRef.current = true;

    void checkForUpdates()
      .then(() => {
        const { available, error } = useUpdateStore.getState();
        if (error) {
          toast.error('Failed to check for updates', {
            description: error,
          });
          return;
        }

        if (!available) {
          toast.success('You are on the latest version');
        }
      })
      .finally(() => {
        checkUpdatesInFlightRef.current = false;
      });
  }, [checkForUpdates]);

  const handleChangeWorkspace = React.useCallback(() => {
    workspaceEvents.requestDirectoryDialog();
  }, []);

  const navigateSession = React.useCallback((direction: -1 | 1) => {
    void navigateRelativePiSession(direction).catch((error) => {
      toast.error('Failed to open Pi session', {
        description: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

  const navigateProject = React.useCallback((direction: -1 | 1) => {
    const { activeProjectId, projects, setActiveProject } = useProjectsStore.getState();
    if (projects.length === 0) return;

    const currentIndex = projects.findIndex((project) => project.id === activeProjectId);
    let nextIndex = direction > 0 ? 0 : projects.length - 1;
    if (currentIndex >= 0) {
      nextIndex = (currentIndex + direction + projects.length) % projects.length;
    }
    const nextProject = projects[nextIndex];
    if (!nextProject) return;

    void setActiveProject(nextProject.id);
  }, []);

  const handleAction = React.useCallback(
    (action: MenuAction) => {
      switch (action) {
        case 'about':
          setAboutDialogOpen(true);
          break;

        case 'settings':
          setSettingsDialogOpen(true);
          break;

        case 'command-palette':
          toggleCommandPalette();
          break;

        case 'quick-open':
          setCommandPaletteOpen(true);
          break;

        case 'new-session':
          void startPiSessionDraftFromNavigation().catch((error) => {
            toast.error('Failed to create Pi session', {
              description: error instanceof Error ? error.message : String(error),
            });
          });
          break;

        case 'new-worktree-session':
          void createPiWorktreeSession().catch((error) => {
            toast.error('Failed to create Pi worktree session', {
              description: error instanceof Error ? error.message : String(error),
            });
          });
          break;

        case 'change-workspace':
          handleChangeWorkspace();
          break;

        // Legacy right-sidebar menu items now target the context surfaces
        // that replaced the sidebar's tabs.
        case 'toggle-right-sidebar': {
          const directory = useDirectoryStore.getState().currentDirectory;
          if (!directory) break;
          const uiState = useUIStore.getState();
          const directoryKey = normalizeContextPanelDirectoryKey(directory);
          const panelState = uiState.contextPanelByDirectory[directoryKey];
          if (panelState?.isOpen) {
            uiState.closeContextPanel(directoryKey);
          } else if (panelState?.activeTabId) {
            uiState.setActiveContextPanelTab(directoryKey, panelState.activeTabId);
          } else {
            uiState.openContextSurface(directoryKey, 'git');
          }
          break;
        }

        case 'open-right-sidebar-git': {
          const directory = useDirectoryStore.getState().currentDirectory;
          if (!directory) break;
          useUIStore.getState().openContextSurface(normalizeContextPanelDirectoryKey(directory), 'git');
          break;
        }

        case 'open-right-sidebar-files': {
          const directory = useDirectoryStore.getState().currentDirectory;
          if (!directory) break;
          useUIStore.getState().openContextSurface(normalizeContextPanelDirectoryKey(directory), 'file');
          break;
        }

        case 'workspace-search': {
          if (requestIdeSearch({ mode: 'content' })) break;
          const directory = useDirectoryStore.getState().currentDirectory;
          if (directory) {
            useUIStore.getState().openContextSurface(normalizeContextPanelDirectoryKey(directory), 'file');
          }
          break;
        }

        case 'toggle-terminal': {
          const directory = useDirectoryStore.getState().currentDirectory;
          if (!directory) break;
          useUIStore.getState().openContextSurface(normalizeContextPanelDirectoryKey(directory), 'terminal');
          break;
        }

        case 'toggle-terminal-expanded': {
          const directory = useDirectoryStore.getState().currentDirectory;
          if (!directory) break;
          const key = normalizeContextPanelDirectoryKey(directory);
          const uiState = useUIStore.getState();
          const panel = uiState.contextPanelByDirectory[key];
          const activeMode = panel?.isOpen ? panel.tabs.find((tab) => tab.id === panel.activeTabId)?.mode : null;
          if (activeMode !== 'terminal') {
            uiState.openContextSurface(key, 'terminal');
          }
          uiState.toggleContextPanelExpanded(key);
          break;
        }

        case 'copy': {
          const copyEvent = new Event('varin:copy', { cancelable: true });
          const wasHandled = !window.dispatchEvent(copyEvent);
          if (!wasHandled) {
            void copyCurrentSelectionFallback();
          }
          break;
        }

        case 'add-selection-to-chat':
          void addPiSelectionToChat();
          break;

        case 'theme-light':
          setThemeMode('light');
          break;

        case 'theme-dark':
          setThemeMode('dark');
          break;

        case 'theme-system':
          setThemeMode('system');
          break;

        case 'toggle-sidebar':
          toggleSidebar();
          break;

        case 'go-back':
          useDirectoryStore.getState().goBack();
          break;

        case 'go-forward':
          useDirectoryStore.getState().goForward();
          break;

        case 'previous-session':
          navigateSession(-1);
          break;

        case 'next-session':
          navigateSession(1);
          break;

        case 'previous-project':
          navigateProject(-1);
          break;

        case 'next-project':
          navigateProject(1);
          break;

        case 'help-dialog':
          toggleHelpDialog();
          break;

        case 'show-diagnostics': {
          setVarinDiagnosticsDialogOpen(true);
          break;
        }
      }
    },
    [
      handleChangeWorkspace,
      navigateProject,
      navigateSession,
      setAboutDialogOpen,
      setCommandPaletteOpen,
      setVarinDiagnosticsDialogOpen,
      setSettingsDialogOpen,
      setThemeMode,
      toggleCommandPalette,
      toggleHelpDialog,
      toggleSidebar,
    ]
  );

  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const desktop = (window as unknown as { __VARIN_DESKTOP__?: DesktopBridgeGlobal }).__VARIN_DESKTOP__;
    if (typeof desktop?.listen === 'function') {
      // Electron emits both IPC and an injected DOM event for the same native
      // action. The IPC effect below owns desktop actions so they run once.
      return;
    }

    const handleMenuAction = (event: Event) => {
      const action = (event as CustomEvent<MenuAction>).detail;
      if (!action) return;
      handleAction(action);
    };

    const handleCheckForUpdatesEvent = () => {
      handleCheckForUpdates();
    };

    window.addEventListener(MENU_ACTION_EVENT, handleMenuAction);
    window.addEventListener(CHECK_FOR_UPDATES_EVENT, handleCheckForUpdatesEvent);
    return () => {
      window.removeEventListener(MENU_ACTION_EVENT, handleMenuAction);
      window.removeEventListener(CHECK_FOR_UPDATES_EVENT, handleCheckForUpdatesEvent);
    };
  }, [enabled, handleAction, handleCheckForUpdates]);

  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const desktop = (window as unknown as { __VARIN_DESKTOP__?: DesktopBridgeGlobal }).__VARIN_DESKTOP__;
    const listen = desktop?.listen;
    if (typeof listen !== 'function') return;

    let unlistenMenu: null | (() => void | Promise<void>) = null;
    let unlistenUpdate: null | (() => void | Promise<void>) = null;

    listen('varin:menu-action', (evt) => {
      const action = evt?.payload;
      if (typeof action !== 'string') return;
      handleAction(action as MenuAction);
    })
      .then((fn) => {
        unlistenMenu = fn;
      })
      .catch(() => {
        // ignore
      });

    listen('varin:check-for-updates', () => {
      handleCheckForUpdates();
    })
      .then((fn) => {
        unlistenUpdate = fn;
      })
      .catch(() => {
        // ignore
      });

    return () => {
      const cleanup = async () => {
        try {
          const a = unlistenMenu?.();
          if (a instanceof Promise) await a;
        } catch {
          // ignore
        }
        try {
          const b = unlistenUpdate?.();
          if (b instanceof Promise) await b;
        } catch {
          // ignore
        }
      };
      void cleanup();
    };
  }, [enabled, handleAction, handleCheckForUpdates]);
};
