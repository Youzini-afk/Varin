import React from 'react';
import { InteractiveUiPanel } from '@/components/interactive-ui/InteractiveUiCard';
import { ContextBrowserView } from '@/components/workbench/ContextBrowserView';
import { BrowserMaterialAction } from '@/components/workbench/MaterialViewActions';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { TerminalView } from '@/components/views/TerminalView';
import { ProjectContextPanel } from './RightSidebarTabs';
import { WorkspaceRecoveryPanel } from './WorkspaceRecoveryPanel';
import { SidebarFilesTree } from './SidebarFilesTree';
import { ContextPanelGitNavigation } from './ContextPanelGitNavigation';
import { useMainColumnGlide } from './railMotion';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useUIStore, type ContextPanelMode, type PendingDiffScope } from '@/stores/useUIStore';
import { useThreadStore, threadComposerKey } from '@/stores/useThreadStore';
import type { ThreadIdentity, ThreadSummary } from '@varin/application-client';
import { contextPanelGitDirectoryScopeKey, useContextPanelGitDirectoryStore } from '@/stores/useContextPanelGitDirectoryStore';
import { ContextPanelContent } from './ContextSidebarTab';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync, getRuntimeApiBaseUrl, getRuntimeKey } from '@varin/application-client';
import { getActiveRelayDescriptor } from '@/lib/relay/runtime-tunnel';
import { Icon } from "@/components/icon/Icon";
import {
  EMBEDDED_RUNTIME_BOOTSTRAP_REQUEST,
  EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE,
  getActiveEmbeddedSessionChatTab,
  getOrCreateEmbeddedSessionChatURL,
  type EmbeddedSessionChatURLCacheEntry,
  type EmbeddedSessionRuntimeBootstrap,
} from './contextPanelEmbeddedChat';
import { availableContextSurfaces, getContextRailMode, getContextSurfaceWidthFraction } from '@/lib/surfaces/registry';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { isTerminalEventTarget } from '@/lib/terminalFocus';

// The context panel itself is part of the desktop shell. Keep its optional
// surfaces outside that eager graph; each remains mounted only while its tab
// exists, preserving the existing state behavior.
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then((module) => ({ default: module.DiffView })));
const ContextResourceEditor = lazyWithChunkRecovery(() => import('@/components/workbench/ContextResourceEditor').then((module) => ({ default: module.ContextResourceEditor })));
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then((module) => ({ default: module.GitView })));
const GitDirectorySelector = lazyWithChunkRecovery(() => import('@/components/views/git/GitDirectorySelector').then((module) => ({ default: module.GitDirectorySelector })));
const PullRequestView = lazyWithChunkRecovery(() => import('@/components/views/PullRequestView').then((module) => ({ default: module.PullRequestView })));
const PlanView = lazyWithChunkRecovery(() => import('@/components/views/PlanView').then((module) => ({ default: module.PlanView })));
const ComputerWorkSurface = lazyWithChunkRecovery(() => import('@/components/sections/computers/ComputerWorkSurface').then((module) => ({ default: module.ComputerWorkSurface })));
const ThreadFamilyPanel = lazyWithChunkRecovery(() => import('./ThreadFamilyPanel').then(module => ({ default: module.ThreadFamilyPanel })));
const MaterialReaderPanel = lazyWithChunkRecovery(() => import('./MaterialReaderPanel').then(module => ({ default: module.MaterialReaderPanel })));

const CONTEXT_PANEL_MIN_WIDTH = 1;
const CONTEXT_PANEL_MAX_WIDTH = 1400;
const CONTEXT_PANEL_DEFAULT_WIDTH = 600;
const RESIZE_FOLLOW_INTERVAL_MS = 100;
const CONTEXT_TAB_LABEL_MAX_CHARS = 24;
type TranslateFn = ReturnType<typeof useI18n>['t'];
const EMPTY_SESSION_TITLE_MAP = new Map<string, string>();

const normalizeDirectoryKey = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');

  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

const clampWidth = (width: number): number => {
  if (!Number.isFinite(width)) {
    return CONTEXT_PANEL_DEFAULT_WIDTH;
  }

  return Math.min(CONTEXT_PANEL_MAX_WIDTH, Math.max(CONTEXT_PANEL_MIN_WIDTH, Math.round(width)));
};

const getAvailablePanelWidth = (panel: HTMLElement | null): number | null => {
  const parentWidth = panel?.parentElement?.clientWidth;
  if (!parentWidth || parentWidth <= 0) {
    return null;
  }

  return parentWidth;
};

const getRelativePathLabel = (filePath: string | null, directory: string): string => {
  if (!filePath) {
    return '';
  }
  const normalizedFile = filePath.replace(/\\/g, '/');
  const normalizedDir = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedDir && normalizedFile.startsWith(normalizedDir + '/')) {
    return normalizedFile.slice(normalizedDir.length + 1);
  }
  return normalizedFile;
};

const getModeLabel = (
  mode: ContextPanelMode,
  t: TranslateFn
): string => {
  if (mode === 'chat') return t('contextPanel.mode.chat');
  if (mode === 'threads') return t('collaboration.title');
  if (mode === 'file') return t('contextPanel.mode.files');
  if (mode === 'diff') return t('contextPanel.mode.diff');
  if (mode === 'plan') return t('contextPanel.mode.plan');
  if (mode === 'ui') return t('ui.content.title');
  if (mode === 'material') return t('chat.tools.materials');
  if (mode === 'browser') return t('contextPanel.mode.browser');
  if (mode === 'git') return t('layout.rightSidebar.git');
  if (mode === 'pr') return t('contextPanel.mode.pr');
  if (mode === 'notes') return t('contextRail.surface.notes');
  if (mode === 'terminal') return t('layout.mainTab.terminal');
  if (mode === 'computer') return t('contextPanel.mode.computer');
  if (mode === 'recovery') return t('contextPanel.mode.recovery');
  return t('contextPanel.mode.context');
};

const getFileNameFromPath = (path: string | null): string | null => {
  if (!path) {
    return null;
  }

  const normalized = path.replace(/\\/g, '/').trim();
  if (!normalized) {
    return null;
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) {
    return normalized;
  }

  return segments[segments.length - 1] || null;
};

const getTabLabel = (
  tab: { thread?: ThreadIdentity; mode: ContextPanelMode; label: string | null; targetPath: string | null; dedupeKey?: string; sessionTitleFallback?: string | null; stagedDiff?: boolean },
  sessionTitleById: ReadonlyMap<string, string>,
  t: TranslateFn
): string => {
  if (tab.mode === 'chat') {
    const sessionID = tab.thread?.threadId ?? null;
    if (sessionID) {
      const sessionTitle = sessionTitleById.get(sessionID)?.trim();
      if (sessionTitle) {
        return sessionTitle;
      }
    }

    const sessionTitleFallback = tab.sessionTitleFallback?.trim();
    if (sessionTitleFallback) {
      return sessionTitleFallback;
    }

    return t('contextPanel.mode.chat');
  }

  if (tab.label) {
    return tab.label;
  }

  if (tab.mode === 'file') {
    return getFileNameFromPath(tab.targetPath) || t('contextPanel.mode.files');
  }

  if (tab.mode === 'diff') {
    return t('contextPanel.mode.diff');
  }

  return getModeLabel(tab.mode, t);
};

const getTabIcon = (tab: { thread?: ThreadIdentity; mode: ContextPanelMode; targetPath: string | null }): React.ReactNode | undefined => {
  if (tab.mode === 'material') return <Icon name="book-2" className="h-3.5 w-3.5" />;
  if (tab.mode === 'threads') return <Icon name="chat-1" className="h-3.5 w-3.5" />;
  if (tab.mode === 'file') {
    return tab.targetPath
      ? <FileTypeIcon filePath={tab.targetPath} className="h-3.5 w-3.5" />
      : undefined;
  }

  if (tab.mode === 'diff') {
    return <Icon name="arrow-left-right" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'git') {
    return <Icon name="git-branch" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'pr') {
    return <Icon name="git-pull-request" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'notes') {
    return <Icon name="sticky-note" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'terminal') {
    return <Icon name="terminal-box" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'plan') {
    return <Icon name="file-text" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'context') {
    return <Icon name="donut-chart-fill" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'recovery') {
    return <Icon name="history" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'chat') {
    return <Icon name="chat-4" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'browser') {
    return <Icon name="global" className="h-3.5 w-3.5" />;
  }

  if (tab.mode === 'computer') {
    return <Icon name="computer" className="h-3.5 w-3.5" />;
  }

  return undefined;
};

const EDITOR_TREE_MIN_WIDTH = 200;
const EDITOR_TREE_MAX_WIDTH = 480;

// The editor surface's file-tree column: docked on the right, resizable from
// its left edge, and animated open/closed like the app sidebars.
const EditorTreeColumn: React.FC<{ visible: boolean }> = ({ visible }) => {
  const { t } = useI18n();
  const width = useUIStore((state) => state.contextEditorTreeWidth);
  const setWidth = useUIStore((state) => state.setContextEditorTreeWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const liveWidthRef = React.useRef<number | null>(null);
  const pointerIDRef = React.useRef<number | null>(null);
  const columnRef = React.useRef<HTMLDivElement | null>(null);

  const clampTreeWidth = React.useCallback((value: number) => {
    return Math.min(EDITOR_TREE_MAX_WIDTH, Math.max(EDITOR_TREE_MIN_WIDTH, Math.round(value)));
  }, []);

  const applyLiveTreeWidth = React.useCallback((nextWidth: number) => {
    const column = columnRef.current;
    if (!column) {
      return;
    }
    column.style.width = `${nextWidth}px`;
    column.style.setProperty('--varin-editor-tree-width', `${nextWidth}px`);
  }, []);

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!visible) {
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    pointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    liveWidthRef.current = width;
    event.preventDefault();
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!isResizing || pointerIDRef.current !== event.pointerId) {
      return;
    }
    const delta = startXRef.current - event.clientX;
    const nextWidth = clampTreeWidth(startWidthRef.current + delta);
    if (liveWidthRef.current === nextWidth) {
      return;
    }
    liveWidthRef.current = nextWidth;
    applyLiveTreeWidth(nextWidth);
  };

  const handlePointerEnd = (event: React.PointerEvent) => {
    if (pointerIDRef.current !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    const finalWidth = clampTreeWidth(liveWidthRef.current ?? width);
    pointerIDRef.current = null;
    liveWidthRef.current = null;
    setIsResizing(false);
    setWidth(finalWidth);
  };

  const appliedWidth = visible ? width : 0;

  return (
    <div
      ref={columnRef}
      className={cn(
        'relative h-full flex-shrink-0 overflow-hidden border-l border-border bg-background will-change-[width] motion-reduce:transition-none',
        !visible && 'border-l-0',
      )}
      style={{
        width: `${isResizing ? (liveWidthRef.current ?? appliedWidth) : appliedWidth}px`,
        ['--varin-editor-tree-width' as string]: `${isResizing ? (liveWidthRef.current ?? width) : width}px`,
        overflowX: 'clip',
        transitionProperty: isResizing ? 'none' : 'width',
        transitionDuration: 'var(--motion-dur-glide)',
        transitionTimingFunction: 'var(--motion-ease-glide)',
      }}
      aria-hidden={!visible}
    >
      {visible && (
        <div
          className={cn(
            'absolute left-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        className={cn(
          'relative z-10 h-full shrink-0 transition-opacity motion-reduce:transition-none',
          isResizing && 'pointer-events-none',
          !visible && 'pointer-events-none select-none opacity-0'
        )}
        style={{ width: 'var(--varin-editor-tree-width)' }}
        aria-hidden={!visible}
      >
        <SidebarFilesTree />
      </div>
    </div>
  );
};

const buildSessionTitleMap = (sessions: ThreadSummary[], sessionIDs: readonly string[]): Map<string, string> => {
  if (sessionIDs.length === 0) return EMPTY_SESSION_TITLE_MAP;
  const wanted = new Set(sessionIDs);
  const next = new Map<string, string>();
  for (const session of sessions) {
    if (!wanted.has(session.thread_id)) continue;
    const title = session.title.trim();
    if (title) next.set(session.thread_id, title);
  }
  return next.size === 0 ? EMPTY_SESSION_TITLE_MAP : next;
};

const useSessionTitleMap = (sessionIDs: readonly string[]): ReadonlyMap<string, string> => {
  const summaries = useThreadStore(state => state.threads);
  return React.useMemo(
    () => buildSessionTitleMap(summaries, sessionIDs),
    [sessionIDs, summaries],
  );
};

const truncateTabLabel = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3)}...`;
};

export const ContextPanel: React.FC = () => {
  const { t } = useI18n();
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(() => normalizeDirectoryKey(effectiveDirectory), [effectiveDirectory]);
  const currentSessionId = useThreadStore(state => state.selectedIdentity);
  const gitSessionDirectory = effectiveDirectory || null;
  const gitDirectoryScopeKey = React.useMemo(() => {
    return contextPanelGitDirectoryScopeKey(currentSessionId ? threadComposerKey(useThreadStore.getState().hostKey, currentSessionId) : null, gitSessionDirectory);
  }, [currentSessionId, gitSessionDirectory]);
  const selectedGitDirectory = useContextPanelGitDirectoryStore((state) => (
    gitDirectoryScopeKey ? state.directories[gitDirectoryScopeKey] ?? null : null
  ));
  const setRightSidebarGitDirectory = useContextPanelGitDirectoryStore((state) => state.setDirectory);

  const gitDirectory = selectedGitDirectory || gitSessionDirectory;
  const handleGitDirectoryChange = React.useCallback((directory: string) => {
    if (!gitDirectoryScopeKey) return;
    const normalized = directory.trim();
    const nextDirectory = normalized
      && normalizeDirectoryKey(normalized) !== normalizeDirectoryKey(gitSessionDirectory ?? '')
      ? normalized
      : null;
    setRightSidebarGitDirectory(gitDirectoryScopeKey, nextDirectory);
    useUIStore.getState().openContextPanelTab(directoryKey, { mode: 'git' });
  }, [directoryKey, gitDirectoryScopeKey, gitSessionDirectory, setRightSidebarGitDirectory]);
  const handleFollowSessionGitDirectory = React.useCallback(() => {
    if (gitDirectoryScopeKey) setRightSidebarGitDirectory(gitDirectoryScopeKey, null);
    useUIStore.getState().openContextPanelTab(directoryKey, { mode: 'git' });
  }, [directoryKey, gitDirectoryScopeKey, setRightSidebarGitDirectory]);

  const panelState = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const closeContextPanelTab = useUIStore((state) => state.closeContextPanelTab);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const toggleContextPanelExpanded = useUIStore((state) => state.toggleContextPanelExpanded);
  const setContextPanelWidth = useUIStore((state) => state.setContextPanelWidth);
  const setActiveContextPanelTab = useUIStore((state) => state.setActiveContextPanelTab);
  const reorderContextPanelTabs = useUIStore((state) => state.reorderContextPanelTabs);
  const contextEditorTreeVisible = useUIStore((state) => state.contextEditorTreeVisible);
  const toggleContextEditorTree = useUIStore((state) => state.toggleContextEditorTree);
  const { themeMode, setThemeMode, lightThemeId, darkThemeId, currentTheme } = useThemeSystem();

  const tabs = React.useMemo(() => panelState?.tabs ?? [], [panelState?.tabs]);
  const contextRailOrder = useUIStore(state => state.contextRailOrder);
  const planModeEnabled = useFeatureFlagsStore(state => state.planModeEnabled);
  const surfaces = React.useMemo(() => availableContextSurfaces(contextRailOrder, tabs, planModeEnabled), [contextRailOrder, tabs, planModeEnabled]);
  const activeTab = tabs.find((tab) => tab.id === panelState?.activeTabId) ?? tabs[tabs.length - 1] ?? null;
  const gitPageMode = activeTab?.mode === 'git' || activeTab?.mode === 'pr' || activeTab?.mode === 'diff'
    ? activeTab.mode : null;
  const activeGitDirectory = activeTab?.mode === 'git' ? gitDirectory : activeTab?.targetDirectory ?? gitDirectory;
  const isOpen = Boolean(panelState?.isOpen && activeTab);
  const isExpanded = Boolean(isOpen && panelState?.expanded);
  const [availablePanelAreaWidth, setAvailablePanelAreaWidth] = React.useState<number | null>(null);
  const activeModeForWidth = activeTab?.mode ?? null;
  const manualWidth = activeModeForWidth ? panelState?.widthByMode?.[activeModeForWidth] : undefined;
  const widthFraction = activeModeForWidth ? getContextSurfaceWidthFraction(activeModeForWidth) : 0.5;
  const widthFallbackBase = availablePanelAreaWidth
    ?? (typeof window !== 'undefined' ? window.innerWidth : CONTEXT_PANEL_DEFAULT_WIDTH * 2);
  const preferredWidth = clampWidth(manualWidth ?? Math.round(widthFraction * widthFallbackBase));
  // A default fits the remaining work area; a user resize remains their choice.
  const width = manualWidth === undefined && availablePanelAreaWidth !== null
    ? Math.min(preferredWidth, Math.round(availablePanelAreaWidth * 0.48))
    : preferredWidth;
  const chatSessionIDs = React.useMemo(() => {
    const ids: string[] = [];
    for (const tab of tabs) {
      if (tab.mode !== 'chat') continue;
      const sessionID = tab.thread?.threadId ?? null;
      if (sessionID && !ids.includes(sessionID)) ids.push(sessionID);
    }
    return ids;
  }, [tabs]);
  const sessionTitleById = useSessionTitleMap(chatSessionIDs);

  const [isResizing, setIsResizing] = React.useState(false);
  const startXRef = React.useRef(0);
  const startWidthRef = React.useRef(width);
  const resizingWidthRef = React.useRef<number | null>(null);
  const activeResizePointerIDRef = React.useRef<number | null>(null);
  const panelRef = React.useRef<HTMLElement | null>(null);
  useMainColumnGlide(panelRef, isOpen, !isExpanded && !panelState?.expanded && !isResizing, width);
  const chatFrameRefs = React.useRef<Map<string, HTMLIFrameElement>>(new Map());
  const chatFrameSrcByTabIDRef = React.useRef<Map<string, EmbeddedSessionChatURLCacheEntry>>(new Map());
  const wasOpenRef = React.useRef(false);

  // Tracks the panel area width so fraction-based surface defaults stay
  // proportional as the window resizes; manual widths remain fixed px.
  React.useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === 'undefined') {
      return;
    }

    const update = () => setAvailablePanelAreaWidth(parent.dataset.layoutTargetWidth === undefined
      ? parent.clientWidth || null : Number(parent.dataset.layoutTargetWidth));
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    parent.addEventListener('varin:layout-target', update);
    update();

    return () => { observer.disconnect(); parent.removeEventListener('varin:layout-target', update); };
  }, []);

  React.useEffect(() => {
    if (!isOpen || wasOpenRef.current) {
      wasOpenRef.current = isOpen;
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });

    wasOpenRef.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen]);

  // Deferred resize: reflowing the chat column and the active surface (xterm,
  // editor, embedded chat iframes) on every drag frame is unavoidably janky,
  // so during the drag only a ghost guide line follows the pointer and the
  // real width is applied once on release (riding the width transition).
  const resizeAvailableWidthRef = React.useRef<number | null>(null);
  // The panel content follows the guide line lazily: the real width is
  // re-applied at most every RESIZE_FOLLOW_INTERVAL_MS and the standing
  // 200ms width transition smooths each resize step.
  const resizeFollowTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyFollowWidth = React.useCallback(() => {
    resizeFollowTimerRef.current = null;
    const panel = panelRef.current;
    const next = resizingWidthRef.current;
    if (!panel || next === null) {
      return;
    }
    panel.style.setProperty('--varin-context-panel-width', `${next}px`);
  }, []);

  React.useEffect(() => () => {
    if (resizeFollowTimerRef.current !== null) {
      clearTimeout(resizeFollowTimerRef.current);
    }
  }, []);

  const clampWidthForDrag = React.useCallback((nextWidth: number) => {
    const clamped = clampWidth(nextWidth);
    const available = resizeAvailableWidthRef.current;
    return available === null ? clamped : Math.min(clamped, Math.max(1, available));
  }, []);

  const handleResizeStart = React.useCallback((event: React.PointerEvent) => {
    if (!isOpen || isExpanded || !directoryKey) {
      return;
    }

    activeResizePointerIDRef.current = event.pointerId;
    setIsResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = width;
    resizingWidthRef.current = width;
    // Measure once per drag; no layout reads happen during pointermove.
    resizeAvailableWidthRef.current = getAvailablePanelWidth(panelRef.current);
    document.documentElement.style.cursor = 'col-resize';
    event.preventDefault();
  }, [directoryKey, isExpanded, isOpen, width]);

  const finishResize = React.useCallback(() => {
    // Apply the final width once, letting the regular 200ms width transition
    // carry the panel to the release position.
    const finalWidth = clampWidthForDrag(resizingWidthRef.current ?? width);
    resizingWidthRef.current = null;
    resizeAvailableWidthRef.current = null;
    if (resizeFollowTimerRef.current !== null) {
      clearTimeout(resizeFollowTimerRef.current);
      resizeFollowTimerRef.current = null;
    }
    document.documentElement.style.cursor = '';
    if (directoryKey && activeModeForWidth) {
      setContextPanelWidth(directoryKey, activeModeForWidth, finalWidth);
    }
    setIsResizing(false);
    activeResizePointerIDRef.current = null;
  }, [activeModeForWidth, clampWidthForDrag, directoryKey, setContextPanelWidth, width]);

  // Window-level drag listeners: tracking the pointer via the 3px handle and
  // pointer capture is unreliable (capture can fail over iframes and a missed
  // pointerup leaves the drag stuck), so while resizing the whole window
  // tracks the pointer and any release/cancel/blur ends the drag.
  React.useEffect(() => {
    if (!isResizing) {
      return;
    }

    const handleMove = (event: PointerEvent) => {
      if (activeResizePointerIDRef.current !== event.pointerId) {
        return;
      }
      const delta = startXRef.current - event.clientX;
      const nextWidth = clampWidthForDrag(startWidthRef.current + delta);
      if (resizingWidthRef.current === nextWidth) {
        return;
      }
      resizingWidthRef.current = nextWidth;
      if (resizeFollowTimerRef.current === null) {
        resizeFollowTimerRef.current = setTimeout(applyFollowWidth, RESIZE_FOLLOW_INTERVAL_MS);
      }
    };

    const handleUp = (event: PointerEvent) => {
      if (activeResizePointerIDRef.current !== event.pointerId) {
        return;
      }
      finishResize();
    };

    const handleWindowBlur = () => {
      finishResize();
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [applyFollowWidth, clampWidthForDrag, finishResize, isResizing]);

  React.useEffect(() => {
    if (!isResizing) {
      resizingWidthRef.current = null;
      document.documentElement.style.cursor = '';
    }
  }, [isResizing]);

  const handleClose = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    closeContextPanel(directoryKey);
  }, [closeContextPanel, directoryKey]);

  const handleToggleExpanded = React.useCallback(() => {
    if (!directoryKey) {
      return;
    }
    toggleContextPanelExpanded(directoryKey);
  }, [directoryKey, toggleContextPanelExpanded]);

  const handlePanelKeyDownCapture = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') {
      return;
    }

    if (isTerminalEventTarget(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleClose();
  }, [handleClose]);

  const chatTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'chat'),
    [tabs],
  );
  const activeChatTabID = isOpen && activeTab?.mode === 'chat' ? activeTab.id : null;
  const activeChatSessionID = isOpen && activeTab?.mode === 'chat'
    ? activeTab.thread ?? null
    : null;
  const activeChatTab = getActiveEmbeddedSessionChatTab(chatTabs, activeChatTabID);

  const getEmbeddedChatSrc = React.useCallback((tabID: string, sessionID: ThreadIdentity, readOnly: boolean): string => {
    return getOrCreateEmbeddedSessionChatURL(chatFrameSrcByTabIDRef.current, tabID, sessionID, directoryKey || null, readOnly, {
      mode: themeMode,
      lightThemeId,
      darkThemeId,
      currentTheme,
    });
  }, [currentTheme, darkThemeId, directoryKey, lightThemeId, themeMode]);

  const activeChatSrc = activeChatTab && activeChatSessionID
    ? getEmbeddedChatSrc(activeChatTab.id, activeChatSessionID, activeChatTab.readOnly)
    : null;

  React.useEffect(() => {
    const liveTabIDs = new Set(tabs.map((tab) => tab.id));
    for (const tabID of chatFrameSrcByTabIDRef.current.keys()) {
      if (!liveTabIDs.has(tabID)) {
        chatFrameSrcByTabIDRef.current.delete(tabID);
      }
    }
  }, [tabs]);

  const handleDiffScopeChange = React.useCallback((nextScope: PendingDiffScope) => {
    if (!directoryKey || activeTab?.mode !== 'diff') {
      return;
    }

    openContextPanelTab(directoryKey, {
      mode: 'diff',
      targetPath: activeTab.targetPath,
      targetDirectory: activeTab.targetDirectory,
      stagedDiff: nextScope === 'staged',
      diffScope: nextScope,
    });
  }, [activeTab, directoryKey, openContextPanelTab]);

  const postThemeSyncToEmbeddedChat = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const payload = {
      themeMode,
      lightThemeId,
      darkThemeId,
      currentTheme,
    };

    for (const frame of chatFrameRefs.current.values()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) {
        continue;
      }

      frameWindow.postMessage(
        {
          type: 'varin:theme-sync',
          payload,
        },
        window.location.origin,
      );
    }
  }, [currentTheme, darkThemeId, lightThemeId, themeMode]);

  const postEmbeddedVisibilityToChats = React.useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }

    for (const [tabID, frame] of chatFrameRefs.current.entries()) {
      const frameWindow = frame.contentWindow;
      if (!frameWindow) {
        continue;
      }

      const payload = { visible: activeChatTabID === tabID };
      frameWindow.postMessage(
        {
          type: 'varin:embedded-visibility',
          payload,
        },
        window.location.origin,
      );
    }
  }, [activeChatTabID]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const isKnownChatFrame = Array.from(chatFrameRefs.current.values())
        .some((frame) => frame.contentWindow === event.source);
      if (!isKnownChatFrame) {
        return;
      }

      const data = event.data as { type?: unknown; requestId?: unknown };
      if (data?.type === EMBEDDED_RUNTIME_BOOTSTRAP_REQUEST) {
        if (typeof data.requestId !== 'string' || !data.requestId) return;
        const runtimeKey = getRuntimeKey();
        const payload: EmbeddedSessionRuntimeBootstrap = {
          apiBaseUrl: getRuntimeApiBaseUrl(),
          clientToken: getRuntimeBearerTokenSync(),
          localOrigin: typeof window.__VARIN_LOCAL_ORIGIN__ === 'string'
            ? window.__VARIN_LOCAL_ORIGIN__
            : '',
          runtimeHeaders: getRuntimeExtraHeadersSync(),
          relayHostId: runtimeKey.startsWith('host:') ? runtimeKey.slice('host:'.length) : '',
          relay: getActiveRelayDescriptor() ?? undefined,
        };
        (event.source as WindowProxy | null)?.postMessage({
          type: EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE,
          requestId: data.requestId,
          payload,
        }, event.origin);
        return;
      }
      if (data?.type === 'varin:theme-sync-request') {
        postThemeSyncToEmbeddedChat();
        return;
      }
      if (data?.type !== 'varin:cycle-theme-request') {
        return;
      }

      const modes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
      const currentIndex = modes.indexOf(themeMode);
      const nextIndex = (currentIndex + 1) % modes.length;
      setThemeMode(modes[nextIndex]);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [postThemeSyncToEmbeddedChat, setThemeMode, themeMode]);

  React.useLayoutEffect(() => {
    const hasAnyChatTab = tabs.some((tab) => tab.mode === 'chat');
    if (!hasAnyChatTab) {
      return;
    }

    postThemeSyncToEmbeddedChat();
    postEmbeddedVisibilityToChats();
  }, [darkThemeId, lightThemeId, postEmbeddedVisibilityToChats, postThemeSyncToEmbeddedChat, tabs, themeMode]);

  // The rail switches between surfaces (modes); the in-panel strip only lists
  // instances of the active multi-instance surface (open files, split chats,
  // interactive content).
  const isMultiInstanceMode = activeTab?.mode === 'file' || activeTab?.mode === 'chat' || activeTab?.mode === 'ui';
  const activeModeTabs = React.useMemo(
    () => (activeTab ? tabs.filter((tab) => tab.mode === activeTab.mode) : []),
    [activeTab, tabs],
  );

  const tabItems = React.useMemo(() => activeModeTabs.map((tab) => {
    const rawLabel = getTabLabel(tab, sessionTitleById, t);
    const label = truncateTabLabel(rawLabel, CONTEXT_TAB_LABEL_MAX_CHARS);
    const tabPathLabel = getRelativePathLabel(tab.targetPath, effectiveDirectory);
    return {
      id: tab.id,
      label,
      icon: getTabIcon(tab),
      title: tabPathLabel ? `${rawLabel}: ${tabPathLabel}` : rawLabel,
      closeLabel: t('contextPanel.tab.closeTabAria', { label }),
    };
  }), [activeModeTabs, effectiveDirectory, sessionTitleById, t]);

  const activeNonChatContent = activeTab?.mode === 'context'
        ? <ContextPanelContent active={isOpen} />
        : activeTab?.mode === 'threads'
            ? <ThreadFamilyPanel active={isOpen} identity={activeTab.thread} member={activeTab.member} navigationKey={activeTab.touchedAt} />
        : activeTab?.mode === 'ui' && activeTab.targetPath
            ? <InteractiveUiPanel sessionKey={activeTab.targetPath} identity={activeTab.thread} contentRef={activeTab.contentRef} directory={directoryKey} onReturn={() => closeContextPanelTab(directoryKey, activeTab.id)} />
        : activeTab?.mode === 'material' && activeTab.targetPath && activeTab.thread
            ? isOpen && <MaterialReaderPanel key={activeTab.id} identity={activeTab.thread} snapshotId={activeTab.targetPath} line={activeTab.materialLine} title={activeTab.label || t('chat.tools.materials')} readOnly={activeTab.readOnly} onClose={() => closeContextPanelTab(directoryKey, activeTab.id)} />
        : activeTab?.mode === 'recovery'
            ? <WorkspaceRecoveryPanel />
        : activeTab?.mode === 'git'
            ? (
              <GitView
                isActive={isOpen}
                directoryOverride={gitDirectory}
                onViewDiff={(path, staged) => openContextPanelTab(directoryKey, {
                  mode: 'diff', targetDirectory: gitDirectory, targetPath: path,
                  stagedDiff: staged, diffScope: staged ? 'staged' : 'working',
                })}
                onViewPullRequest={() => openContextPanelTab(directoryKey, { mode: 'pr', targetDirectory: gitDirectory })}
              />
            )
            : activeTab?.mode === 'pr'
                ? <PullRequestView isActive={isOpen} directoryOverride={activeGitDirectory} navigationDirectory={directoryKey} />
            : activeTab?.mode === 'notes'
                ? <ProjectContextPanel />
        : activeTab?.mode === 'computer'
            ? <ComputerWorkSurface directory={effectiveDirectory} tabID={activeTab.id} />
        : activeTab?.mode === 'plan'
            ? <PlanView targetPath={activeTab.targetPath} />
            : null;

  const browserTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'browser'),
    [tabs],
  );
  const diffTabs = React.useMemo(
    () => tabs.filter((tab) => tab.mode === 'diff'),
    [tabs],
  );
  const hasTerminalTab = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'terminal'),
    [tabs],
  );
  const hasFileTabs = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file'),
    [tabs],
  );
  const hasOpenEditorFile = React.useMemo(
    () => tabs.some((tab) => tab.mode === 'file' && tab.targetPath),
    [tabs],
  );

  const isFileTabActive = activeTab?.mode === 'file';

  const header = (
    <header className="flex h-10 items-stretch border-b border-border">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={t('workbench.material.switchResource')} title={t('workbench.material.switchResource')}
            className="workbench-icon-button flex shrink-0 items-center gap-1 rounded-md px-2 text-muted-foreground hover:bg-interactive-hover hover:text-foreground">
            <Icon name="stack" className="size-3.5" /><Icon name="arrow-down-s" className="size-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-48">
          {surfaces.map(surface => <DropdownMenuItem key={surface.id} className="gap-2"
            onSelect={() => useUIStore.getState().openContextSurface(directoryKey, surface.mode)}>
            <Icon name={surface.icon} className="size-3.5 shrink-0" /><span className="flex-1">{t(surface.labelKey)}</span>
            {activeTab && getContextRailMode(activeTab.mode) === surface.mode ? <Icon name="check" className="size-3.5" /> : null}
          </DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      {isMultiInstanceMode ? (
        <SortableTabsStrip
          items={tabItems}
          activeId={activeTab?.id ?? null}
          onSelect={(tabID) => {
            if (!directoryKey) {
              return;
            }
            setActiveContextPanelTab(directoryKey, tabID);
          }}
          onClose={(tabID) => {
            if (!directoryKey) {
              return;
            }
            closeContextPanelTab(directoryKey, tabID);
          }}
          onReorder={(activeTabID, overTabID) => {
            if (!directoryKey) {
              return;
            }
            reorderContextPanelTabs(directoryKey, activeTabID, overTabID);
          }}
          layoutMode="scrollable"
          variant="default"
        />
      ) : gitPageMode ? (
        <ContextPanelGitNavigation
          mode={gitPageMode}
          panelDirectory={directoryKey}
          repositoryDirectory={activeGitDirectory}
          onReturnToChanges={handleGitDirectoryChange}
        />
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3">
          {activeTab ? getTabIcon(activeTab) : null}
          <span className="truncate typography-ui-label text-foreground">
            {activeTab ? getModeLabel(activeTab.mode, t) : null}
          </span>
        </div>
      )}
      <div className="flex items-center gap-1 px-1.5">
        {activeTab?.mode === 'browser' ? <BrowserMaterialAction workspaceRoot={directoryKey} tabId={activeTab.id} url={activeTab.targetPath ?? ''} /> : null}
        {isFileTabActive ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleContextEditorTree}
            className="h-7 w-7 p-0"
            title={t('contextRail.editorTree.toggle')}
            aria-label={t('contextRail.editorTree.toggle')}
            aria-pressed={contextEditorTreeVisible}
          >
            <Icon name="layout-right" className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleToggleExpanded}
          className="h-7 w-7 p-0"
          title={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
          aria-label={isExpanded ? t('contextPanel.actions.collapsePanel') : t('contextPanel.actions.expandPanel')}
        >
          {isExpanded ? <Icon name="fullscreen-exit" className="h-3.5 w-3.5" /> : <Icon name="fullscreen" className="h-3.5 w-3.5" />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClose}
          className="h-7 w-7 p-0"
          title={t('contextPanel.actions.closePanel')}
          aria-label={t('contextPanel.actions.closePanel')}
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );

  // width/min/max stay interpolable across open/close (no instant min/max
  // jumps) so the glide width transition matches the sidebars.
  const panelStyle: React.CSSProperties = !isOpen
    ? {
        ['--varin-context-panel-width' as string]: `${width}px`,
        width: 0,
        maxWidth: '100%',
        overflowX: 'clip',
      }
    : isExpanded
      ? {
          // px, not '100%': px↔% width changes do not interpolate, which
          // would make the expand/collapse width snap instead of animating.
          ['--varin-context-panel-width' as string]: availablePanelAreaWidth !== null ? `${availablePanelAreaWidth}px` : '100%',
          width: availablePanelAreaWidth !== null ? `${availablePanelAreaWidth}px` : '100%',
          maxWidth: '100%',
        }
      : {
          width: 'min(var(--varin-context-panel-width), 100%)',
          maxWidth: '100%',
          overflowX: 'clip',
          ['--varin-context-panel-width' as string]: `${width}px`,
        };

  return (
    <aside
      ref={panelRef}
      data-context-panel="true"
      data-open={isOpen}
      data-expanded={isExpanded}
      data-resizing={isResizing}
      tabIndex={-1}
      inert={!isOpen || undefined}
      className={cn(
        'workbench-resource-canvas flex min-h-0 flex-col overflow-hidden bg-background',
        // Right-anchored while expanded: `inset-0` would teleport the left
        // edge instantly (position does not transition), so only the width
        // animates and the panel grows leftwards from its docked position.
        isExpanded
          ? 'absolute inset-y-0 right-0 z-20 min-w-0'
          : 'relative h-full flex-shrink-0',
        !isOpen && 'pointer-events-none',
        // Width rides glide; workbench.css owns the properties, duration and curve.
        'will-change-[width] motion-reduce:transition-none',
      )}
      onKeyDownCapture={handlePanelKeyDownCapture}
      style={panelStyle}
    >
      {/* Painted divider instead of border-l: a real border eats 1px of the
          content box only while collapsed, shifting the header controls by
          1px between the collapsed and expanded states. */}
      {isOpen && !isExpanded && (
        <div aria-hidden="true" className="absolute left-0 top-0 z-40 h-full w-px bg-border" />
      )}
      {!isExpanded && (
        <div
          className={cn(
            'absolute left-0 top-0 z-50 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={handleResizeStart}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div
        className={cn(
          // Width animates in sync with the panel (surface switches, resize
          // release); during the drag itself nothing resizes — only the ghost
          // guide line moves. Opening and closing move it with the panel's
          // leading edge (workbench.css).
          'relative z-10 flex h-full min-h-0 shrink-0 flex-col motion-reduce:transition-none',
          !isOpen && 'pointer-events-none select-none'
        )}
        // px in the expanded state too: px↔% width changes cannot interpolate,
        // so the header controls would snap instead of riding the animation.
        style={{
          width: isExpanded
            ? (availablePanelAreaWidth !== null ? `${availablePanelAreaWidth}px` : '100%')
            : 'var(--varin-context-panel-width)',
        }}
        aria-hidden={!isOpen}
      >
      {header}
      {gitPageMode ? (
        <React.Suspense fallback={null}>
          <GitDirectorySelector
            directory={activeGitDirectory}
            sessionDirectory={gitSessionDirectory}
            isFollowingSessionDirectory={normalizeDirectoryKey(activeGitDirectory ?? '') === normalizeDirectoryKey(gitSessionDirectory ?? '')}
            onDirectoryChange={handleGitDirectoryChange}
            onFollowSessionDirectory={handleFollowSessionGitDirectory}
          />
        </React.Suspense>
      ) : null}
      {/* Keep the header and frame's width motion. Heavy content takes the
          destination width once and is revealed by the moving frame. */}
      <div className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}
        style={{ width: isExpanded
          ? (availablePanelAreaWidth !== null ? `${availablePanelAreaWidth}px` : '100%')
          : 'var(--varin-context-panel-width)' }}>
        {hasFileTabs ? (
          <div className={cn('absolute inset-0 flex', isFileTabActive ? 'flex' : 'hidden')}>
            <div className="h-full min-w-0 flex-1">
              {hasOpenEditorFile ? (
                <React.Suspense fallback={null}>
                  {activeTab?.targetPath && directoryKey ? (
                    <ContextResourceEditor
                      filePath={activeTab.targetPath}
                      viewId={activeTab.id}
                      editorViewId={activeTab.editorViewId}
                      workspaceRoot={activeTab.targetDirectory ?? directoryKey}
                    />
                  ) : null}
                </React.Suspense>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                  <Icon name="file-code" className="h-12 w-12 text-muted-foreground/50" />
                  <div className="typography-ui-header text-foreground">{t('contextPanel.editorEmpty.title')}</div>
                  <div className="max-w-sm typography-micro text-muted-foreground">{t('contextPanel.editorEmpty.description')}</div>
                </div>
              )}
            </div>
            <EditorTreeColumn visible={contextEditorTreeVisible} />
          </div>
        ) : null}
        {activeChatTab && activeChatSessionID && activeChatSrc ? (
          <iframe
            key={activeChatTab.id}
            ref={(node) => {
              if (!node) {
                chatFrameRefs.current.delete(activeChatTab.id);
                return;
              }
              chatFrameRefs.current.set(activeChatTab.id, node);
            }}
            src={activeChatSrc}
            title={t('contextPanel.iframe.sessionChatTitle', { sessionID: activeChatSessionID.threadId })}
            className="absolute inset-0 h-full w-full border-0 bg-background"
            onLoad={() => {
              postThemeSyncToEmbeddedChat();
              postEmbeddedVisibilityToChats();
            }}
          />
        ) : null}
        {browserTabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'absolute inset-0',
              activeTab?.id !== tab.id && 'hidden'
            )}
          >
            <ContextBrowserView initialUrl={tab.targetPath ?? ''} directory={directoryKey} tabID={tab.id} editorViewId={tab.editorViewId} />
          </div>
        ))}
        {diffTabs.map((tab) => (
          <div
            key={tab.id}
            className={cn(
              'absolute inset-0',
              activeTab?.id !== tab.id && 'hidden'
            )}
          >
            <React.Suspense fallback={null}>
              <DiffView
                directoryOverride={tab.targetDirectory ?? gitDirectory}
                navigationDirectory={directoryKey}
                hideStackedFileSidebar
                stackedDefaultCollapsedAll
                pinSelectedFileHeaderToTopOnNavigate
                showOpenInEditorAction
                diffScope={tab.diffScope ?? (tab.stagedDiff ? 'staged' : 'working')}
                onDiffScopeChange={handleDiffScopeChange}
                targetFilePath={tab.targetPath}
                flushContent
                visible={isOpen && activeTab?.id === tab.id}
              />
            </React.Suspense>
          </div>
        ))}
        {hasTerminalTab ? (
          <div className={cn('absolute inset-0', activeTab?.mode === 'terminal' ? 'block' : 'hidden')}>
            <TerminalView visible={isOpen && activeTab?.mode === 'terminal'} />
          </div>
        ) : null}
        {activeTab?.mode !== 'chat' && !isFileTabActive && activeTab?.mode !== 'browser' && activeTab?.mode !== 'diff' && activeTab?.mode !== 'terminal' ? (
          // A new view arrives instead of appearing; the same view keeps its node.
          <div key={activeTab?.mode ?? 'none'} className="panel-view-enter h-full min-h-0">
            <React.Suspense fallback={null}>{activeNonChatContent}</React.Suspense>
          </div>
        ) : null}
      </div>
      </div>
    </aside>
  );
};
