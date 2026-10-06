import React, { useEffect } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';

import { DiffIcon } from '@/components/icons/DiffIcon';
import { useUIStore, type ContextPanelMode, type MainTab } from '@/stores/useUIStore';
import { ContextPanelControls } from './ContextPanelControls';
import { usePiSessionStore } from '@/stores/usePiSessionStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { streamPerfCount } from '@/stores/utils/streamDebug';

import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { SessionTokenUsage } from '@/components/pi-session/SessionTokenUsage';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { useDeviceInfo, useTabletStandalonePwaRuntime } from '@/lib/device';
import { cn, hasModifier } from '@/lib/utils';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { McpIcon } from '@/components/icons/McpIcon';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';

import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { TitlebarLeftControls } from '@/components/layout/TitlebarLeftControls';
import { PiSessionSwitcherDropdown } from '@/components/pi-session/PiSessionSwitcherDropdown';
import { collectPiSessionSubtreeIds, piSessionTitle } from '@/components/pi-session/sessionPresentation';
import { invokeDesktop, isDesktopShell, startDesktopWindowDrag } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { shouldResetDesktopMainTabToChat } from '@/components/layout/mainTabGuards';
import { useShallow } from 'zustand/react/shallow';
import type { IconName } from "@/components/icon/icons";
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { buildExportFilename, downloadAsMarkdown, saveAsMarkdownDesktop } from '@/lib/pi-runtime/markdownExport';
import { formatPiSessionAsMarkdown } from '@/lib/pi-runtime/exportSession';
import { piSessionContextUsage } from '@/lib/pi-runtime/sessionStats';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { WorkbenchServices } from './WorkbenchServices';

const DESKTOP_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';
const MOBILE_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-9 w-9 items-center justify-center gap-2 p-2 rounded-md typography-ui-label font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:text-foreground hover:bg-interactive-hover transition-colors';

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const getActiveContextMode = (panelState: {
  isOpen: boolean;
  activeTabId: string | null;
  tabs: Array<{ id: string; mode: ContextPanelMode }>;
} | undefined): ContextPanelMode | null => {
  if (!panelState?.isOpen || !Array.isArray(panelState.tabs) || panelState.tabs.length === 0) {
    return null;
  }

  const activeTab = panelState.tabs.find((tab) => tab.id === panelState.activeTabId) ?? panelState.tabs[panelState.tabs.length - 1];
  return activeTab?.mode ?? null;
};

interface TabConfig {
  id: MainTab;
  label: string;
  icon: IconName | 'diff';
  badge?: number;
  showDot?: boolean;
}


interface HeaderProps {
  navigationTitle?: string;
  onToggleLeftDrawer?: () => void;
  onToggleRightDrawer?: () => void;
  leftDrawerOpen?: boolean;
  rightDrawerOpen?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  navigationTitle,
  onToggleLeftDrawer,
  onToggleRightDrawer,
  leftDrawerOpen,
  rightDrawerOpen,
}) => {
  streamPerfCount('ui.header.render');
  const { t } = useI18n();
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const openContextOverview = useUIStore((state) => state.openContextOverview);
  const openContextPlan = useUIStore((state) => state.openContextPlan);
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);


  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const currentSessionRecord = usePiSessionStore((state) => (
    state.currentSessionId === null ? undefined : state.records[state.currentSessionId]
  ));
  const currentSnapshot = currentSessionRecord?.snapshot;
  const currentStats = currentSessionRecord?.stats;
  const currentSessionSummary = usePiSessionStore((state) => (
    state.currentSessionId === null
      ? undefined
      : state.summaries.find((summary) => summary.id === state.currentSessionId)
  ));
  const piSessionSummaries = usePiSessionStore((state) => state.summaries);
  const archiveSession = usePiSessionStore((state) => state.archiveSession);
  const deleteSession = usePiSessionStore((state) => state.deleteSession);
  const refreshEntries = usePiSessionStore((state) => state.refreshEntries);
  const refreshStats = usePiSessionStore((state) => state.refreshStats);
  const renameSession = usePiSessionStore((state) => state.renameSession);
  const activeProject = useProjectsStore(useShallow((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    const project = state.projects.find((candidate) => candidate.id === state.activeProjectId);
    return project ? { id: project.id, path: project.path, label: project.label } : null;
  }));
  const activeProjectLabel = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }

    const trimmedLabel = activeProject.label?.trim();
    if (trimmedLabel) {
      return trimmedLabel;
    }

    const pathSegments = activeProject.path.split(/[\\/]/).filter(Boolean);
    return pathSegments[pathSegments.length - 1] ?? null;
  }, [activeProject]);

  const { isMobile } = useDeviceInfo();

  const headerRef = React.useRef<HTMLElement | null>(null);

  const [isDesktopApp, setIsDesktopApp] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return isDesktopShell();
  });
  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();
  const [isDesktopWindowFullscreen, setIsDesktopWindowFullscreen] = React.useState(false);

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);

  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const macosMajorVersion = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const injected = (window as unknown as { __VARIN_MACOS_MAJOR__?: unknown }).__VARIN_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) {
      return injected;
    }

    // Fallback: WebKit reports "Mac OS X 10_15_7" format where 10 is legacy prefix
    if (typeof navigator === 'undefined') {
      return null;
    }
    const match = (navigator.userAgent || '').match(/Mac OS X (\d+)[._](\d+)/);
    if (!match) {
      return null;
    }
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    if (Number.isNaN(first)) {
      return null;
    }
    return first === 10 ? second : first;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  const isCurrentSessionActive = Boolean(
    currentSnapshot?.busy
    || currentSnapshot?.isStreaming
    || currentSnapshot?.isCompacting
    || (currentSnapshot?.retryAttempt ?? 0) > 0,
  );
  const contextUsage = React.useMemo(
    () => piSessionContextUsage(currentStats, currentSnapshot),
    [currentSnapshot, currentStats],
  );

  useEffect(() => {
    if (!currentSessionId || isCurrentSessionActive) return;
    void refreshStats(currentSessionId).catch(() => undefined);
  }, [currentSessionId, currentSnapshot?.leafId, isCurrentSessionActive, refreshStats]);

  const isSessionSwitcherOpen = useUIStore((state) => state.isSessionSwitcherOpen);
  const [isMobileServicesOpen, setIsMobileServicesOpen] = React.useState(false);
  const [mobileServicesTab, setMobileServicesTab] = React.useState<'usage' | 'mcp'>('usage');
  const showDesktopHeaderContextUsage = activeMainTab === 'chat' && !!contextUsage && contextUsage.totalTokens > 0;
  const desktopHeaderDisplayPercentage = contextUsage && contextUsage.contextLimit > 0
    ? Math.min(999, (contextUsage.totalTokens / contextUsage.contextLimit) * 100)
    : 0;

  // The Pi snapshot is authoritative for the active session directory.
  const sessionDirectory = React.useMemo(() => {
    return normalize(currentSnapshot?.cwd || currentSessionSummary?.cwd || '');
  }, [currentSessionSummary?.cwd, currentSnapshot?.cwd]);

  const openDirectory = React.useMemo(() => {
    return sessionDirectory || normalize(activeProject?.path || '');
  }, [activeProject?.path, sessionDirectory]);
  const activeContextMode = useUIStore(React.useCallback((state) => {
    return openDirectory ? getActiveContextMode(state.contextPanelByDirectory[openDirectory]) : null;
  }, [openDirectory]));

  const currentBranchLabel = useGitBranchLabel(openDirectory || null);

  const currentSessionTitle = React.useMemo(() => {
    const untitled = t('sessions.sidebar.session.untitled');
    if (currentSessionSummary) return piSessionTitle(currentSessionSummary, untitled);
    if (!currentSessionId) {
      return activeProjectLabel ?? 'Varin';
    }
    return currentSnapshot?.name?.trim() || untitled;
  }, [activeProjectLabel, currentSessionId, currentSessionSummary, currentSnapshot?.name, t]);
  const [isRenamingHeaderSession, setIsRenamingHeaderSession] = React.useState(false);
  const [isHeaderSessionMenuOpen, setIsHeaderSessionMenuOpen] = React.useState(false);
  const pendingHeaderRenameRef = React.useRef(false);
  const [headerSessionTitleDraft, setHeaderSessionTitleDraft] = React.useState('');
  const [pendingHeaderRetentionAction, setPendingHeaderRetentionAction] = React.useState<'archive' | 'delete' | null>(null);
  const headerRenameFormRef = React.useRef<HTMLFormElement | null>(null);

  React.useEffect(() => {
    pendingHeaderRenameRef.current = false;
    setIsHeaderSessionMenuOpen(false);
    setIsRenamingHeaderSession(false);
    setHeaderSessionTitleDraft('');
    setPendingHeaderRetentionAction(null);
  }, [currentSessionId]);

  const beginHeaderSessionRename = React.useCallback(() => {
    if (!currentSessionId) return;
    setHeaderSessionTitleDraft(currentSessionTitle);
    setIsRenamingHeaderSession(true);
  }, [currentSessionId, currentSessionTitle]);

  const saveHeaderSessionRename = React.useCallback(async () => {
    if (!currentSessionId) return;
    const title = headerSessionTitleDraft.trim();
    try {
      if (title && title !== currentSessionTitle) {
        await renameSession(currentSessionId, title);
      }
      setIsRenamingHeaderSession(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [currentSessionId, currentSessionTitle, headerSessionTitleDraft, renameSession]);

  React.useEffect(() => {
    if (!isRenamingHeaderSession) return;
    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || !headerRenameFormRef.current?.contains(target)) {
        void saveHeaderSessionRename();
      }
    };
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [isRenamingHeaderSession, saveHeaderSessionRename]);

  const copyCurrentSessionId = React.useCallback(() => {
    if (!currentSessionId) return;
    void copyTextToClipboard(currentSessionId).then((result) => {
      toast[result.ok ? 'success' : 'error'](t(result.ok
        ? 'sessions.sidebar.session.copyId.success'
        : 'sessions.sidebar.session.copyId.error'));
    }).catch(() => toast.error(t('sessions.sidebar.session.copyId.error')));
  }, [currentSessionId, t]);

  const exportCurrentSession = React.useCallback(async () => {
    if (!currentSessionId) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }
    try {
      const result = await refreshEntries(currentSessionId, 'all');
      if (result.entries.length === 0) {
        toast.error(t('sessions.sidebar.session.export.nothingToExport'));
        return;
      }
      const markdown = formatPiSessionAsMarkdown(result.entries, {
        cwd: sessionDirectory,
        sessionId: currentSessionId,
        title: currentSessionTitle,
      });
      const filename = buildExportFilename(currentSessionTitle);
      const savedPath = await saveAsMarkdownDesktop(markdown, filename);
      if (!savedPath) downloadAsMarkdown(markdown, filename);
      toast.success(t('sessions.sidebar.session.export.success'));
    } catch {
      toast.error(t('sessions.sidebar.session.export.failedLoadHistory'));
    }
  }, [currentSessionId, currentSessionTitle, refreshEntries, sessionDirectory, t]);

  const currentSessionSubtreeIds = React.useMemo(() => {
    if (!currentSessionId) return [];
    const ids = collectPiSessionSubtreeIds(piSessionSummaries, currentSessionId);
    return ids.length > 0 ? ids : [currentSessionId];
  }, [currentSessionId, piSessionSummaries]);

  const headerRetentionDescription = React.useMemo(() => {
    const childCount = Math.max(0, currentSessionSubtreeIds.length - 1);
    if (pendingHeaderRetentionAction === 'archive') {
      if (childCount === 1) {
        return t('sessions.sidebar.dialogs.archiveSession.withOneSubtask', {
          count: childCount,
          sessionTitle: currentSessionTitle,
        });
      }
      if (childCount > 1) {
        return t('sessions.sidebar.dialogs.archiveSession.withManySubtasks', {
          count: childCount,
          sessionTitle: currentSessionTitle,
        });
      }
      return t('sessions.sidebar.dialogs.archiveSession.single', { sessionTitle: currentSessionTitle });
    }
    if (pendingHeaderRetentionAction === 'delete') {
      if (childCount === 1) {
        return t('sessions.sidebar.dialogs.deleteSession.withOneSubtask', {
          count: childCount,
          sessionTitle: currentSessionTitle,
        });
      }
      if (childCount > 1) {
        return t('sessions.sidebar.dialogs.deleteSession.withManySubtasks', {
          count: childCount,
          sessionTitle: currentSessionTitle,
        });
      }
      return t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: currentSessionTitle });
    }
    return '';
  }, [currentSessionSubtreeIds.length, currentSessionTitle, pendingHeaderRetentionAction, t]);

  const confirmHeaderRetentionAction = React.useCallback(async () => {
    if (!currentSessionId || !pendingHeaderRetentionAction) return;
    const ids = [...currentSessionSubtreeIds];
    const action = pendingHeaderRetentionAction;
    setPendingHeaderRetentionAction(null);
    const results = await Promise.allSettled(ids.map((sessionId) => (
      action === 'archive' ? archiveSession(sessionId) : deleteSession(sessionId)
    )));
    const failed = results.filter((result) => (
      result.status === 'rejected'
      || (action === 'delete' && result.status === 'fulfilled' && result.value !== true)
    ));
    if (failed.length > 0) {
      toast.error(t(action === 'archive'
        ? 'sessions.sidebar.session.archive.error'
        : 'sessions.sidebar.session.delete.error'));
      return;
    }
    toast.success(t(action === 'archive'
      ? 'sessions.sidebar.session.archive.success'
      : 'sessions.sidebar.session.delete.success'));
  }, [archiveSession, currentSessionId, currentSessionSubtreeIds, deleteSession, pendingHeaderRetentionAction, t]);

  // Full-page surfaces (Scheduled, Archive, Worktrees, Multi-run) replace the
  // chat area; while one is open the header shows the surface identity
  // instead of the session switcher.
  const isScheduledSurfaceOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const isArchiveSurfaceOpen = useUIStore((state) => state.isArchivePageOpen);
  const worktreesSurfaceProjectId = useUIStore((state) => state.worktreesPageProjectId);
  const isMultiRunSurfaceOpen = useUIStore((state) => state.isMultiRunLauncherOpen);
  const worktreesSurfaceProjectLabel = useProjectsStore((state) => {
    if (!worktreesSurfaceProjectId) return null;
    const project = state.projects.find((entry) => entry.id === worktreesSurfaceProjectId);
    return project?.label?.trim() || project?.path?.split('/').pop() || null;
  });
  const activeSurfaceHeader = React.useMemo<{ title: string; subtitle: string | null } | null>(() => {
    if (isScheduledSurfaceOpen) {
      return { title: t('tasksHub.title'), subtitle: null };
    }
    if (isArchiveSurfaceOpen) {
      return { title: t('sessions.archivePage.title'), subtitle: null };
    }
    if (worktreesSurfaceProjectId) {
      return {
        title: t('sessions.worktreesPage.title', { project: worktreesSurfaceProjectLabel ?? '' }),
        subtitle: null,
      };
    }
    if (isMultiRunSurfaceOpen) {
      return { title: t('sessions.sidebar.header.actions.newMultiRun'), subtitle: null };
    }
    return null;
  }, [isArchiveSurfaceOpen, isMultiRunSurfaceOpen, isScheduledSurfaceOpen, t, worktreesSurfaceProjectId, worktreesSurfaceProjectLabel]);


  const actionDirectory = React.useMemo(() => {
    return normalize(openDirectory || activeProject?.path || '');
  }, [activeProject?.path, openDirectory]);

  const activeProjectRef = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return { id: activeProject.id, path: activeProject.path };
  }, [activeProject]);

  const lastProjectActionsContextRef = React.useRef<{
    projectRef: { id: string; path: string };
    directory: string;
  } | null>(null);

  React.useEffect(() => {
    if (!activeProjectRef || !actionDirectory) {
      return;
    }
    lastProjectActionsContextRef.current = {
      projectRef: activeProjectRef,
      directory: actionDirectory,
    };
  }, [actionDirectory, activeProjectRef]);

  const projectActionsContext = React.useMemo(() => {
    if (activeProjectRef && actionDirectory) {
      return { projectRef: activeProjectRef, directory: actionDirectory };
    }
    return lastProjectActionsContextRef.current;
  }, [actionDirectory, activeProjectRef]);

  const blurActiveElement = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    if (!active) {
      return;
    }

    const tagName = active.tagName;
    const isInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';

    if (isInput || active.isContentEditable) {
      active.blur();
    }
  }, []);

  const handleOpenSessionSwitcher = React.useCallback(() => {
    if (isMobile) {
      blurActiveElement();
      setSessionSwitcherOpen(!isSessionSwitcherOpen);
      return;
    }
    toggleSidebar();
  }, [blurActiveElement, isMobile, isSessionSwitcherOpen, setSessionSwitcherOpen, toggleSidebar]);

  const handleOpenContextPanel = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = useUIStore.getState().contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'context') {
      closeContextPanel(directory);
      return;
    }

    openContextOverview(directory);
  }, [closeContextPanel, openContextOverview, openDirectory]);

  const isContextPanelActive = activeContextMode === 'context';


  const handleOpenContextPlan = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = useUIStore.getState().contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'plan') {
      closeContextPanel(directory);
      return;
    }

    openContextPlan(directory);
  }, [closeContextPanel, openContextPlan, openDirectory]);

  const desktopHeaderIconButtonClass = DESKTOP_HEADER_ICON_BUTTON_CLASS;
  const mobileHeaderIconButtonClass = MOBILE_HEADER_ICON_BUTTON_CLASS;
  const mobileActiveHeaderItem = React.useMemo(() => {
    if (isMobileServicesOpen) {
      return 'services';
    }
    if (leftDrawerOpen) {
      return 'sessions';
    }
    if (rightDrawerOpen) {
      return 'git';
    }
    return activeMainTab;
  }, [activeMainTab, isMobileServicesOpen, leftDrawerOpen, rightDrawerOpen]);

  const closeMobileHeaderPanels = React.useCallback(() => {
    setIsMobileServicesOpen(false);
    if (leftDrawerOpen && onToggleLeftDrawer) {
      onToggleLeftDrawer();
    }
    if (rightDrawerOpen && onToggleRightDrawer) {
      onToggleRightDrawer();
    }
    if (!onToggleLeftDrawer && isSessionSwitcherOpen) {
      setSessionSwitcherOpen(false);
    }
  }, [isSessionSwitcherOpen, leftDrawerOpen, onToggleLeftDrawer, onToggleRightDrawer, rightDrawerOpen, setSessionSwitcherOpen]);

  const handleMobileLeftDrawerToggle = React.useCallback(() => {
    if (!leftDrawerOpen) {
      setIsMobileServicesOpen(false);
    }
    onToggleLeftDrawer?.();
  }, [leftDrawerOpen, onToggleLeftDrawer]);

  const handleMobileRightDrawerToggle = React.useCallback(() => {
    if (!rightDrawerOpen) {
      setIsMobileServicesOpen(false);
    }
    onToggleRightDrawer?.();
  }, [onToggleRightDrawer, rightDrawerOpen]);

  // Left padding the header needs to clear the OS window controls (macOS
  // traffic lights / window-controls-overlay). When the sidebar is open this
  // space is owned by the sidebar's top strip instead, so the header drops back
  // to its normal content padding. The full value is published as
  // `--oc-titlebar-left-inset` so the sidebar strip can mirror it.
  const titlebarLeftInset = React.useMemo(() => {
    if (isDesktopApp && isMacPlatform && !isDesktopWindowFullscreen) {
      return '5.5rem';
    }
    if (isTabletStandalonePwa) {
      return 'max(calc(0.75rem + var(--oc-wco-left-inset, 0px)), 5.5rem)';
    }
    if (!isDesktopApp || usesFramelessChrome) {
      return 'calc(0.75rem + var(--oc-wco-left-inset, 0px))';
    }
    return '0.75rem';
  }, [isDesktopApp, isDesktopWindowFullscreen, isMacPlatform, isTabletStandalonePwa, usesFramelessChrome]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.style.setProperty('--oc-titlebar-left-inset', titlebarLeftInset);
  }, [titlebarLeftInset]);

  useEffect(() => {
    if (!isDesktopApp || !isMacPlatform) {
      setIsDesktopWindowFullscreen(false);
      return;
    }

    let disposed = false;

    const syncFullscreenState = async () => {
      try {
        const fullscreen = await invokeDesktop('desktop_is_window_fullscreen');
        if (!disposed) {
          setIsDesktopWindowFullscreen(fullscreen === true);
        }
      } catch {
        if (!disposed) {
          setIsDesktopWindowFullscreen(false);
        }
      }
    };

    const onResize = () => {
      void syncFullscreenState();
    };

    void syncFullscreenState();
    window.addEventListener('varin:window-resized', onResize);

    return () => {
      disposed = true;
      window.removeEventListener('varin:window-resized', onResize);
    };
  }, [isDesktopApp, isMacPlatform]);

  const macosHeaderSizeClass = React.useMemo(() => {
    if (!isDesktopApp || !isMacPlatform || macosMajorVersion === null) {
      return '';
    }
    if (macosMajorVersion >= 26) {
      return 'h-12';
    }
    if (macosMajorVersion <= 15) {
      return 'h-14';
    }
    return '';
  }, [isDesktopApp, isMacPlatform, macosMajorVersion]);

  const webWindowControlsOverlayStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (isDesktopApp && !usesFramelessChrome) {
      return undefined;
    }

    return {
      // Left inset is handled by the no-drag spacer (see renderDesktop); only
      // the right inset / titlebar height are owned by the window-controls overlay.
      paddingRight: 'calc(0.75rem + var(--oc-wco-right-inset, 0px))',
      minHeight: 'max(2.5rem, var(--oc-wco-titlebar-height, 0px))',
      height: 'max(2.5rem, var(--oc-wco-titlebar-height, 0px))',
    };
  }, [isDesktopApp, usesFramelessChrome]);

  const updateHeaderHeight = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const height = headerRef.current?.getBoundingClientRect().height;
    if (height) {
      document.documentElement.style.setProperty('--oc-header-height', `${height}px`);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    updateHeaderHeight();

    const node = headerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return () => { };
    }

    let rafId = 0;
    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateHeaderHeight();
      });
    };

    const observer = new ResizeObserver(scheduleUpdate);

    observer.observe(node);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
    };
  }, [updateHeaderHeight]);

  useEffect(() => {
    updateHeaderHeight();
  }, [updateHeaderHeight, isMobile, macosHeaderSizeClass]);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) {
      return;
    }
    if (target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);

  const tabs: TabConfig[] = React.useMemo(() => {
    if (isMobile) {
      const base: TabConfig[] = [
        { id: 'chat', label: t('layout.mainTab.chat'), icon: "chat-4" },
      ];

      base.push(
        { id: 'diff', label: t('layout.mainTab.diff'), icon: 'diff' },
        { id: 'files', label: t('layout.mainTab.files'), icon: "folder-6" },
        { id: 'terminal', label: t('layout.mainTab.terminal'), icon: "terminal-box" },
        { id: 'context', label: t('layout.mainTab.context'), icon: "file-list-2" },
        { id: 'diagram', label: t('layout.mainTab.diagram'), icon: 'file' },
      );

      return base;
    }

    // Desktop: no tabs in header
    return [];
  }, [isMobile, t]);

  useEffect(() => {
    if (shouldResetDesktopMainTabToChat(activeMainTab, isMobile)) {
      setActiveMainTab('chat');
    }
  }, [activeMainTab, isMobile, setActiveMainTab]);

  const mobileServicesTabItems = React.useMemo<SortableTabsStripItem[]>(() => {
    return [
      { id: 'usage', label: t('layout.services.usage'), icon: <Icon name="timer" className="h-3.5 w-3.5" /> },
      { id: 'mcp', label: 'MCP', icon: <McpIcon className="h-3.5 w-3.5" /> },
    ];
  }, [t]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasModifier(e) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= tabs.length) {
          e.preventDefault();
          if (isMobile) {
            blurActiveElement();
            closeMobileHeaderPanels();
          }
          setActiveMainTab(tabs[num - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [blurActiveElement, closeMobileHeaderPanels, isMobile, setActiveMainTab, tabs]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const toggleContextPlanCombo = getEffectiveShortcutCombo('toggle_context_plan', shortcutOverrides);
      if (eventMatchesShortcut(e, toggleContextPlanCombo)) {
        e.preventDefault();
        handleOpenContextPlan();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    shortcutOverrides,
    handleOpenContextPlan,
  ]);

  const renderTab = (tab: TabConfig) => {
    const isActive = activeMainTab === tab.id;
    const isDiffTab = tab.icon === 'diff';
    const tabIconName = isDiffTab ? null : (tab.icon as IconName);
    const isChatTab = tab.id === 'chat';

    const renderIcon = (iconSize: number) => {
      if (isDiffTab) {
        return <DiffIcon size={iconSize} />;
      }
      return tabIconName ? <Icon name={tabIconName} className={`h-${iconSize/4} w-${iconSize/4}`} /> : null;
    };

    const tabButton = (
      <button
        type="button"
        onClick={() => setActiveMainTab(tab.id)}
          className={cn(
            'relative flex h-8 items-center gap-2 px-3 rounded-lg typography-ui-label font-medium transition-colors',
            isActive
              ? 'app-region-no-drag bg-interactive-selection text-interactive-selection-foreground shadow-none'
              : 'app-region-no-drag text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            isChatTab && !isMobile && 'min-w-[100px] justify-center'
          )}
        aria-label={tab.label}
        aria-selected={isActive}
        role="tab"
      >
        {isMobile ? (
          renderIcon(20)
        ) : (
          <>
            {renderIcon(16)}
            <span className="header-tab-label">{tab.label}</span>
          </>
        )}

        {tab.badge !== undefined && tab.badge > 0 && (
          <span className="header-tab-badge typography-micro text-status-info font-medium">
            {tab.badge}
          </span>
        )}
      </button>
    );

    return <React.Fragment key={tab.id}>{tabButton}</React.Fragment>;
  };

  const projectNameMenu = projectActionsContext && activeProjectLabel ? (
    <ProjectActionsButton
      projectRef={projectActionsContext.projectRef}
      directory={projectActionsContext.directory}
      menuTrigger={(
        <button type="button" className="flex min-w-0 max-w-full items-center gap-1 rounded text-inherit hover:bg-interactive-hover" aria-label={`${activeProjectLabel}: ${t('projectActions.actions.chooseActionAria')}`}>
          <span className="truncate">{activeProjectLabel}</span>
          <Icon name="arrow-down-s" className="size-3 shrink-0 opacity-60" />
        </button>
      )}
    />
  ) : activeProjectLabel;

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-10 select-none items-center pr-3',
        macosHeaderSizeClass
      )}
      style={webWindowControlsOverlayStyle}
      role="tablist"
      aria-label={t('header.navigation.mainAria')}
    >
      <TitlebarLeftControls />
      <div className="flex min-w-0 flex-1 items-center">
        {activeSurfaceHeader ? (
          <div className="mr-3 flex min-w-0 flex-col items-start px-1 py-0.5 -my-0.5 text-left">
            <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
              {activeSurfaceHeader.title}
            </span>
            {activeSurfaceHeader.subtitle ? (
              <span className="truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75 max-w-full">
                {activeSurfaceHeader.subtitle}
              </span>
            ) : null}
          </div>
        ) : navigationTitle !== undefined ? (
          <span className="mr-3 truncate typography-ui-label text-foreground">{navigationTitle}</span>
        ) : (
          <div className="app-region-no-drag mr-3 flex min-w-0 max-w-full items-center gap-0.5 py-0.5 -my-0.5 text-left">
            {!isSidebarOpen ? (
              <PiSessionSwitcherDropdown align="start">
                <button
                  type="button"
                  className={desktopHeaderIconButtonClass}
                  aria-label={t('sessions.switcher.openAria')}
                >
                  <Icon name="history" className="h-[18px] w-[18px]" />
                </button>
              </PiSessionSwitcherDropdown>
            ) : null}
            <div className="flex min-w-0 flex-col justify-center px-1">
              {isRenamingHeaderSession ? (
                <form
                  ref={headerRenameFormRef}
                  className="flex w-full min-w-0 items-center gap-2 leading-tight"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveHeaderSessionRename();
                  }}
                >
                  <input
                    value={headerSessionTitleDraft}
                    onChange={(event) => setHeaderSessionTitleDraft(event.target.value)}
                    autoFocus
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Escape') {
                        setIsRenamingHeaderSession(false);
                      }
                    }}
                    placeholder={t('sessions.sidebar.session.menu.rename')}
                    className="min-w-0 flex-1 bg-transparent typography-ui-label text-[14px] font-normal leading-tight outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="submit"
                    aria-label={t('sessions.sidebar.session.rename.save')}
                    title={t('sessions.sidebar.session.rename.save')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="check" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsRenamingHeaderSession(false)}
                    aria-label={t('sessions.sidebar.session.rename.cancel')}
                    title={t('sessions.sidebar.session.rename.cancel')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </form>
              ) : currentSessionId ? (
                <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
                  {currentSessionTitle}
                </span>
              ) : (
                <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
                  {projectNameMenu ?? t('sessions.sidebar.grouping.generalChat')}
                </span>
              )}
              {(sessionDirectory || (currentSessionId && activeProjectLabel) || currentBranchLabel) ? (
                <span className="flex min-w-0 max-w-full items-center gap-1.5 truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">
                  {sessionDirectory ? <span className="truncate">{sessionDirectory}</span> : null}
                  {currentSessionId && activeProjectLabel ? <span className="min-w-0 truncate">{projectNameMenu}</span> : null}
                  {currentBranchLabel ? (
                    <span className="inline-flex min-w-0 items-center gap-0.5">
                      <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                      <span className="truncate">{currentBranchLabel}</span>
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className="flex h-[18px] shrink-0 items-center justify-center self-start">
              {currentSessionId && !isRenamingHeaderSession ? (
                <DropdownMenu
                  open={isHeaderSessionMenuOpen}
                  onOpenChange={setIsHeaderSessionMenuOpen}
                  onOpenChangeComplete={(open) => {
                    if (!open && pendingHeaderRenameRef.current) {
                      pendingHeaderRenameRef.current = false;
                      beginHeaderSessionRename();
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="xs" className="h-[18px] w-6 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" aria-label={t('header.sessionActions.openAria')}>
                      <Icon name="more" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[190px]">
                    <DropdownMenuItem onClick={() => { pendingHeaderRenameRef.current = true; }}><Icon name="pencil-ai" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.rename')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={copyCurrentSessionId}><Icon name="file-copy" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.copyId')}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void exportCurrentSession()}><Icon name="download" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.exportMarkdown')}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setPendingHeaderRetentionAction('archive')}><Icon name="inbox-archive" className="mr-2 size-4" />{t('sessions.sidebar.bulkActions.archive')}</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setPendingHeaderRetentionAction('delete')}><Icon name="delete-bin" className="mr-2 size-4" />{t('sessions.sidebar.bulkActions.delete')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        )}

        {tabs.length > 0 && (
          <div className="flex items-center gap-0.5">
            {tabs.map((tab) => renderTab(tab))}
          </div>
        )}

        <div className="flex-1" />

        <div className="flex shrink-0 items-center gap-1">
          {showDesktopHeaderContextUsage && contextUsage ? (
            <ContextUsageDisplay
              totalTokens={contextUsage.totalTokens}
              percentage={desktopHeaderDisplayPercentage}
              colorPercentage={contextUsage.percentage}
              contextLimit={contextUsage.contextLimit}
              outputLimit={contextUsage.outputLimit ?? 0}
              size="compact"
              hideIcon
              showPercentIcon
              onClick={handleOpenContextPanel}
              pressed={isContextPanelActive}
              className="mr-1.5"
              valueClassName="typography-ui-label font-medium leading-none text-foreground"
              percentIconClassName="h-4.5 w-4.5"
            />
          ) : null}
          <OpenInAppButton directory={actionDirectory} className="mr-1" />
          <WorkbenchServices />
          <ContextPanelControls />
          <WindowsWindowControls visible={usesFramelessChrome && windowControlsSide === 'right'} position="right" />
        </div>
      </div>
    </div>
  );

  const renderMobile = () => (
    <div className="app-region-drag relative flex items-center gap-2 px-3 py-2 select-none">
      <div className="flex items-center gap-2 shrink-0">
        {/* Use drawer toggle when onToggleLeftDrawer is provided, otherwise use legacy session switcher */}
        {onToggleLeftDrawer ? (
          <button
            type="button"
            onClick={handleMobileLeftDrawerToggle}
            className={cn(
              mobileHeaderIconButtonClass,
              mobileActiveHeaderItem === 'sessions' && 'bg-interactive-selection text-interactive-selection-foreground'
            )}
            aria-label={leftDrawerOpen ? t('header.actions.closeSessionsAria') : t('header.actions.openSessionsAria')}
          >
            <Icon name="layout-left" className="h-5 w-5" />
          </button>
        ) : isSessionSwitcherOpen ? (
          <button
            type="button"
            onClick={() => setSessionSwitcherOpen(false)}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label={t('header.actions.backAria')}
          >
            <Icon name="arrow-left-s" className="h-5 w-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleOpenSessionSwitcher}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label={t('header.actions.openSessionsAria')}
          >
            <Icon name="play-list-add" className="h-5 w-5" />
          </button>
        )}

        {!onToggleLeftDrawer && isSessionSwitcherOpen && (
          <span className="typography-ui-label font-semibold text-foreground">{t('header.sessions.title')}</span>
        )}
      </div>

      {(!isSessionSwitcherOpen || Boolean(onToggleLeftDrawer)) && (
        <>
          <div className="app-region-no-drag flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-hidden touch-pan-x overscroll-x-contain">
              <div className="flex w-max items-center gap-1 pr-1">
                <div
                  className="flex items-center gap-0.5 rounded-lg bg-[var(--surface-muted)]/50 p-0.5"
                  role="tablist"
                  aria-label={t('header.navigation.mainAria')}
                >
                  {tabs.map((tab) => {
                    const isActive = activeMainTab === tab.id;
                    const isDiffTab = tab.icon === 'diff';
                    const tabIconName = isDiffTab ? null : (tab.icon as IconName);
                    return (
                      <Tooltip key={tab.id}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => {
                              if (isMobile) {
                                blurActiveElement();
                                closeMobileHeaderPanels();
                              }
                              setActiveMainTab(tab.id);
                            }}
                            aria-label={tab.label}
                            aria-selected={isActive}
                            role="tab"
                            className={cn(
                              mobileHeaderIconButtonClass,
                              'relative rounded-lg',
                              mobileActiveHeaderItem === tab.id && 'bg-interactive-selection text-interactive-selection-foreground'
                            )}
                          >
                            {isDiffTab ? (
                              <DiffIcon className="h-5 w-5" />
                            ) : tabIconName ? (
                              <Icon name={tabIconName} className="h-5 w-5" />
                            ) : null}
                            {tab.badge !== undefined && tab.badge > 0 && (
                              <span className="absolute -top-1 -right-1 text-[10px] font-semibold text-primary">
                                {tab.badge}
                              </span>
                            )}
                            {tab.showDot && (
                              <span
                                className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary"
                                aria-label={t('header.changes.availableAria')}
                              />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{tab.label}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {projectActionsContext && (
              <ProjectActionsButton
                projectRef={projectActionsContext.projectRef}
                directory={projectActionsContext.directory}
                compact
                allowMobile
                className="h-9"
              />
            )}

            {/* Mobile Services Menu (Usage + MCP) */}
            <DropdownMenu
              open={isMobileServicesOpen}
              onOpenChange={(open) => {
                if (open) {
                  if (leftDrawerOpen && onToggleLeftDrawer) {
                    onToggleLeftDrawer();
                  }
                  if (rightDrawerOpen && onToggleRightDrawer) {
                    onToggleRightDrawer();
                  }
                }
                setIsMobileServicesOpen(open);
              }}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('header.services.viewAria')}
                      className={cn(
                        mobileHeaderIconButtonClass,
                        mobileActiveHeaderItem === 'services' && 'bg-interactive-selection text-interactive-selection-foreground'
                      )}
                    >
                      <Icon name="stack" className="h-5 w-5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('header.services.title')}</p>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                sideOffset={0}
                positionerClassName="!fixed !bottom-0 !left-0 !right-0 !top-[var(--oc-header-height,56px)] !transform-none"
                className="h-full w-screen max-h-none rounded-none border-0 p-0 pt-1 overflow-hidden"
              >
                <div className="flex h-full flex-col bg-[var(--surface-elevated)]">
                  <div className="sticky top-0 z-20 bg-[var(--surface-elevated)] px-2 py-px">
                    <div className="flex items-center justify-between gap-2 px-3 py-0">
                      <div className="h-10 min-w-0 flex-1">
                        <SortableTabsStrip
                          items={mobileServicesTabItems}
                          activeId={mobileServicesTab}
                          onSelect={(tabID) => {
                            const value = tabID as 'usage' | 'mcp';
                            setMobileServicesTab(value);
                          }}
                          layoutMode="fit"
                          variant="active-pill"
                          activePillInsetClassName="gap-0.5 px-px py-0"
                          activePillButtonClassName="h-8"
                          className="h-full"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setIsMobileServicesOpen(false)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover"
                        aria-label={t('header.services.closeAria')}
                      >
                        <Icon name="close" className="h-5 w-5" />
                      </button>
                    </div>
                  </div>

                  {mobileServicesTab === 'mcp' && (
                    <McpDropdownContent active={isMobileServicesOpen && mobileServicesTab === 'mcp'} />
                  )}

                  {mobileServicesTab === 'usage' && <div className="flex-1 overflow-y-auto pb-[calc(4rem+env(safe-area-inset-bottom))]"><SessionTokenUsage /></div>}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            {onToggleRightDrawer ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleMobileRightDrawerToggle}
                    className={cn(
                      mobileHeaderIconButtonClass,
                      'relative',
                      mobileActiveHeaderItem === 'git' && 'bg-interactive-selection text-interactive-selection-foreground'
                    )}
                    aria-label={rightDrawerOpen ? t('header.actions.closeGitSidebar') : t('header.actions.openGitSidebar')}
                  >
                    <Icon name="layout-right" className="h-5 w-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{rightDrawerOpen ? t('header.actions.closeGitSidebar') : t('header.actions.openGitSidebar')}</p>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </>
      )}
    </div>
  );

  const headerClassName = cn(
    'header-safe-area relative z-10 shrink-0 bg-background',
    // Mobile keeps a full-width divider. On desktop the divider lives on the chat
    // content wrapper instead, so it doesn't run between the header and the right
    // sidebar (they read as one continuous surface).
    isMobile && 'border-b border-border/50'
  );

  return (
    <>
      <header
        ref={headerRef}
        className={headerClassName}
        style={{ ['--padding-scale' as string]: '1' } as React.CSSProperties}
      >
        {isMobile ? renderMobile() : renderDesktop()}
      </header>
      <Dialog open={pendingHeaderRetentionAction !== null} onOpenChange={(open) => { if (!open) setPendingHeaderRetentionAction(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{pendingHeaderRetentionAction === 'delete'
              ? t('sessions.sidebar.dialogs.deleteSession.title')
              : t('sessions.sidebar.dialogs.archiveSession.title')}</DialogTitle>
            <DialogDescription>{headerRetentionDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingHeaderRetentionAction(null)}>
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmHeaderRetentionAction()}>
              {pendingHeaderRetentionAction === 'delete'
                ? t('sessions.sidebar.bulkActions.delete')
                : t('sessions.sidebar.bulkActions.archive')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
