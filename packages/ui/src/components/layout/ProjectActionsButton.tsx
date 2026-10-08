import React from 'react';
import { getRuntimeKey } from '@varin/application-client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import {
  getProjectActionsState,
  type VarinProjectAction,
  type VarinProjectRef as ProjectRef,
} from '@/lib/project-config';
import {
  normalizeProjectActionDirectory,
  PROJECT_ACTIONS_UPDATED_EVENT,
  PROJECT_ACTION_ICON_MAP,
  resolveProjectActionDesktopForwardUrl,
  toProjectActionRunKey,
} from '@/lib/projectActions';
import { detectDevServerCommand, readPackageJsonScripts } from '@/lib/detectDevServer';
import { waitForTerminalExit } from '@/lib/projectActionTerminal';

type UrlWatchEntry = {
  lastSeenChunkId: number | null;
  openedUrl: boolean;
  tail: string;
  openInPreview: boolean;
};

interface ProjectActionsButtonProps {
  projectRef: ProjectRef | null;
  directory: string;
  className?: string;
  compact?: boolean;
  allowMobile?: boolean;
  contextMenu?: { trigger: React.ReactElement; leading?: React.ReactNode; children: React.ReactNode };
  menuTrigger?: React.ReactElement;
  previewOnly?: boolean;
}

const ANSI_ESCAPE_PREFIX = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE_PREFIX}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const URL_GLOBAL_PATTERN = /https?:\/\/[^\s<>'"`]+/gi;
const AUTO_DISCOVER_ACTION_ID = '__varin_auto_discover_preview__';
const AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS = 15_000;
// The project menu and preview pane can both launch the same action.
const startingRunKeys = new Set<string>();

const stripControlChars = (value: string): string => {
  let next = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isControl = (code >= 0 && code <= 8)
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127;
    if (!isControl) {
      next += value[index];
    }
  }
  return next;
};

const normalizeManualOpenUrl = (value: string | undefined): string | null => {
  const raw = (value || '').trim();
  if (!raw) {
    return null;
  }

  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const extractBestUrl = (value: string): string | null => {
  const cleaned = value.replace(ANSI_ESCAPE_PATTERN, '');
  const matches = cleaned.match(URL_GLOBAL_PATTERN);
  if (!matches || matches.length === 0) {
    return null;
  }

  const normalized = matches
    .map((entry) => entry.replace(/[),.;]+$/, ''))
    .filter(Boolean);

  if (normalized.length === 0) {
    return null;
  }

  const portCandidates: Array<{ raw: string; parsed: URL }> = [];
  for (const candidate of normalized) {
    try {
      const parsed = new URL(candidate);
      if (parsed.port && parsed.port.length > 0) {
        portCandidates.push({ raw: candidate, parsed });
      }
    } catch {
      // noop
    }
  }

  if (portCandidates.length > 0) {
    const scoreCandidate = (entry: { raw: string; parsed: URL }): number => {
      const { parsed } = entry;
      const host = parsed.hostname.toLowerCase();
      const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
      const normalizedPath = parsed.pathname || '/';
      const pathSegments = normalizedPath.split('/').filter(Boolean).length;
      const hasRootPath = normalizedPath === '/' || normalizedPath === '';
      const hasQueryOrHash = Boolean(parsed.search || parsed.hash);

      let score = 0;
      if (isLocalHost) score += 50;
      if (hasRootPath) score += 30;
      score -= Math.min(pathSegments * 5, 20);
      if (hasQueryOrHash) score -= 10;
      return score;
    };

    portCandidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    return portCandidates[0]?.parsed.origin ?? portCandidates[0]?.raw ?? null;
  }

  return normalized[0] ?? null;
};

export const ProjectActionsButton = ({
  projectRef,
  directory,
  className,
  compact = false,
  allowMobile = false,
  contextMenu,
  menuTrigger,
  previewOnly = false,
}: ProjectActionsButtonProps) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { terminal } = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const isDesktopShellApp = React.useMemo(() => isDesktopShell(), []);
  const desktopSshInstances = useDesktopSshStore((state) => state.instances);
  const loadDesktopSsh = useDesktopSshStore((state) => state.load);

  const terminalShell = useUIStore((state) => state.terminalShell);
  const terminalLoginShell = useUIStore((state) => state.terminalLoginShells.includes(state.terminalShell));
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsProjectsSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);
  const openContextPreview = useUIStore((state) => state.openContextPreview);

  const ensureDirectory = useTerminalStore((state) => state.ensureDirectory);
  const setTabLabel = useTerminalStore((state) => state.setTabLabel);
  const setTabIconKey = useTerminalStore((state) => state.setTabIconKey);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const setConnecting = useTerminalStore((state) => state.setConnecting);
  const setTabSessionId = useTerminalStore((state) => state.setTabSessionId);
  const setTabPreviewUrl = useTerminalStore((state) => state.setTabPreviewUrl);
  const projectActionRuns = useTerminalStore((state) => state.projectActionRuns);
  const setProjectActionRun = useTerminalStore((state) => state.setProjectActionRun);
  const updateProjectActionRunStatus = useTerminalStore((state) => state.updateProjectActionRunStatus);
  const removeProjectActionRun = useTerminalStore((state) => state.removeProjectActionRun);

  const [actions, setActions] = React.useState<VarinProjectAction[]>([]);
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [menuActivated, setMenuActivated] = React.useState(!contextMenu && !menuTrigger);
  const tabByKeyRef = React.useRef<Record<string, string>>({});
  const urlWatchByRunKeyRef = React.useRef<Record<string, UrlWatchEntry>>({});
  const streamCleanupByRunKeyRef = React.useRef<Record<string, () => void>>({});
  const previewWaitTimeoutByRunKeyRef = React.useRef<Record<string, number>>({});
  const loadRequestIdRef = React.useRef(0);

  const projectId = projectRef?.id ?? null;
  const projectPath = projectRef?.path ?? '';

  const stableProjectRef = React.useMemo(() => {
    if (!projectId) {
      return null;
    }
    return { id: projectId, path: projectPath };
  }, [projectId, projectPath]);

  React.useEffect(() => {
    if (!isDesktopShellApp || !menuActivated) {
      return;
    }
    void loadDesktopSsh().catch(() => undefined);
  }, [isDesktopShellApp, loadDesktopSsh, menuActivated]);

  const openExternal = React.useCallback(async (url: string) => {
    await openExternalUrl(url);
  }, []);

  const loadActions = React.useCallback(async () => {
    if (!stableProjectRef) {
      return;
    }

    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;

    setIsLoading(true);
    try {
      const state = await getProjectActionsState(stableProjectRef);
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      const filtered = state.actions;
      setActions(filtered);
      setSelectedActionId((current) => {
        if (current === AUTO_DISCOVER_ACTION_ID) {
          return current;
        }
        if (current && filtered.some((entry) => entry.id === current)) {
          return current;
        }
        return null;
      });
    } catch {
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      // Keep last known actions while next project loads or transient fetch fails.
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [stableProjectRef]);

  const normalizedDirectory = React.useMemo(() => {
    return normalizeProjectActionDirectory(directory || stableProjectRef?.path || '');
  }, [directory, stableProjectRef?.path]);

  const selectedAction = React.useMemo(() => {
    if (!selectedActionId) {
      return null;
    }
    return actions.find((entry) => entry.id === selectedActionId) ?? null;
  }, [actions, selectedActionId]);

  const autoDiscoverAction = React.useMemo<VarinProjectAction>(() => ({
    id: AUTO_DISCOVER_ACTION_ID,
    name: t('contextPanel.preview.startPreview'),
    command: '',
    icon: 'play',
    autoOpenUrl: true,
  }), [t]);

  const canUseAutoDiscover = !isMobile;
  const displayActions = React.useMemo(
    () => canUseAutoDiscover ? [autoDiscoverAction, ...actions] : actions,
    [actions, autoDiscoverAction, canUseAutoDiscover]
  );

  React.useEffect(() => {
    if (!menuActivated) return;
    void loadActions();
  }, [loadActions, menuActivated]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handler = (event: Event) => {
      if (!menuActivated) return;
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!projectId) {
        return;
      }
      if (detail?.projectId && detail.projectId !== projectId) {
        return;
      }
      void loadActions();
    };

    window.addEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    };
  }, [loadActions, menuActivated, projectId]);

  React.useEffect(() => {
    if (!selectedActionId) {
      return;
    }
    if (selectedActionId === AUTO_DISCOVER_ACTION_ID && canUseAutoDiscover) {
      return;
    }
    if (!actions.some((entry) => entry.id === selectedActionId)) {
      setSelectedActionId(null);
    }
  }, [actions, canUseAutoDiscover, selectedActionId]);

  React.useEffect(() => {
    if (!menuActivated) return;
    const monitorRuns = () => {
      const terminalStore = useTerminalStore.getState();
      const terminalSessions = terminalStore.sessions;
      const currentRuns = terminalStore.projectActionRuns;
      for (const [runKey, entry] of Object.entries(currentRuns)) {
        if (entry.directory !== normalizedDirectory) continue;
        const directoryState = terminalSessions.get(entry.directory);
        const tab = directoryState?.tabs.find((item) => item.id === entry.tabId);
        if (!tab || tab.terminalSessionId !== entry.sessionId) {
          removeProjectActionRun(runKey);
          continue;
        }

        const watch = urlWatchByRunKeyRef.current[runKey] ?? { lastSeenChunkId: null, openedUrl: tab.previewAutoOpened, tail: '', openInPreview: entry.actionId === AUTO_DISCOVER_ACTION_ID };
        urlWatchByRunKeyRef.current[runKey] = watch;
        const action = displayActions.find((item) => item.id === entry.actionId);
        const bufferChunks = terminalStore.getBuffer(entry.directory, entry.tabId).chunks;
        if (!action || bufferChunks.length === 0 || tab.previewAutoOpened) continue;

        const nextChunks = bufferChunks.filter((chunk) => watch.lastSeenChunkId === null || chunk.id > watch.lastSeenChunkId);
        if (nextChunks.length === 0) continue;

        const combined = nextChunks.map((chunk) => chunk.data).join('');
        const textForScan = `${watch.tail}${combined}`;
        const maybeUrl = !watch.openedUrl && action.autoOpenUrl === true ? extractBestUrl(textForScan) : null;
        const lastChunkId = nextChunks[nextChunks.length - 1]?.id ?? watch.lastSeenChunkId;

        watch.lastSeenChunkId = lastChunkId;
        watch.tail = textForScan.slice(-512);

        if (maybeUrl) {
          watch.openedUrl = true;
          if (watch.openInPreview) {
            const run = currentRuns[runKey];
            if (run) {
              setTabPreviewUrl(run.directory, run.tabId, maybeUrl, { locked: false, autoOpened: true });
              if (run.status === 'waiting-for-preview') updateProjectActionRunStatus(runKey, 'running');
              window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
              delete previewWaitTimeoutByRunKeyRef.current[runKey];
              openContextPreview(run.directory, maybeUrl);
            }
          } else {
            setTabPreviewUrl(entry.directory, entry.tabId, maybeUrl, { locked: false, autoOpened: true });
            void openExternal(maybeUrl);
            toast.success(t('projectActions.toast.openedUrlFromOutput'));
          }
        }
        urlWatchByRunKeyRef.current[runKey] = watch;
      }

      for (const runKey of Object.keys(urlWatchByRunKeyRef.current)) {
        if (!currentRuns[runKey]) {
          delete urlWatchByRunKeyRef.current[runKey];
          window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
          delete previewWaitTimeoutByRunKeyRef.current[runKey];
        }
      }
    };

    monitorRuns();
    return useTerminalStore.subscribe((state, previousState) => {
      if (state.sessions !== previousState.sessions || state.buffers !== previousState.buffers) monitorRuns();
    });
  }, [displayActions, menuActivated, normalizedDirectory, openContextPreview, openExternal, projectActionRuns, removeProjectActionRun, setTabPreviewUrl, t, updateProjectActionRunStatus]);

  const getOrCreateActionTab = React.useCallback(async (action: VarinProjectAction, options: { revealTerminal?: boolean } = {}) => {
    if (!normalizedDirectory) {
      throw new Error(t('projectActions.error.noActiveDirectory'));
    }

    const key = toProjectActionRunKey(normalizedDirectory, action.id);
    ensureDirectory(normalizedDirectory);

    const currentStore = useTerminalStore.getState();
    const existingDirectoryState = currentStore.getDirectoryState(normalizedDirectory);

    let tabId = tabByKeyRef.current[key] || null;
    const hasTab = tabId
      ? Boolean(existingDirectoryState?.tabs.some((entry) => entry.id === tabId))
      : false;

    if (!tabId || !hasTab) {
      tabId = currentStore.createTab(normalizedDirectory);
      tabByKeyRef.current[key] = tabId;
    }

    setTabLabel(normalizedDirectory, tabId, `Action: ${action.name}`);
    setTabIconKey(normalizedDirectory, tabId, action.icon || 'play');
    setActiveTab(normalizedDirectory, tabId);
    if (options.revealTerminal !== false) {
      useUIStore.getState().openContextPanelTab(normalizedDirectory, { mode: 'terminal' });
    }

    const stateAfterTab = useTerminalStore.getState().getDirectoryState(normalizedDirectory);
    const tab = stateAfterTab?.tabs.find((entry) => entry.id === tabId);
    return {
      key,
      tabId,
      sessionId: tab?.terminalSessionId ?? null,
    };
  }, [
    ensureDirectory,
    normalizedDirectory,
    setActiveTab,
    setTabIconKey,
    setTabLabel,
    t,
  ]);

  const runAction = React.useCallback(async (action: VarinProjectAction) => {
    if (!allowMobile && isMobile) {
      return;
    }

    if (!normalizedDirectory) {
      toast.error(t('projectActions.error.noActiveDirectoryForAction'));
      return;
    }

    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const existingRun = projectActionRuns[runKey];
    if (existingRun && existingRun.status === 'running') {
      return;
    }
    const startingKey = JSON.stringify([getRuntimeKey(), runKey]);
    if (startingRunKeys.has(startingKey)) return;
    startingRunKeys.add(startingKey);

    try {
      const discovered = action.id === AUTO_DISCOVER_ACTION_ID
        ? await (async (): Promise<VarinProjectAction> => {
          const [actionsState, scripts] = await Promise.all([
            getProjectActionsState({ id: stableProjectRef?.id ?? '', path: normalizedDirectory }),
            readPackageJsonScripts(normalizedDirectory),
          ]);
          const devServer = await detectDevServerCommand(normalizedDirectory, actionsState.actions, scripts);
          if (!devServer) {
            throw new Error(t('contextPanel.preview.noDevServer'));
          }
          return {
            id: AUTO_DISCOVER_ACTION_ID,
            name: t('contextPanel.preview.startPreview'),
            command: devServer.command,
            icon: 'play',
            autoOpenUrl: true,
            openUrl: devServer.previewUrlHint || '',
          };
        })()
        : action;

      const hasCustomOpenUrl = discovered.autoOpenUrl === true && (discovered.openUrl || '').trim().length > 0;
      const revealTerminal = !hasCustomOpenUrl && action.id !== AUTO_DISCOVER_ACTION_ID;
      const { key, tabId, sessionId } = await getOrCreateActionTab(discovered, { revealTerminal });
      // Clear a prior run before output can arrive; never erase a URL discovered by sendInput.
      setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: false, autoOpened: false });
      let activeSessionId = sessionId;

      if (!activeSessionId) {
        setConnecting(normalizedDirectory, tabId, true);
        try {
          const created = await terminal.createSession({
            cwd: normalizedDirectory,
            sessionId: tabId,
            shell: terminalShell,
            loginShell: terminalLoginShell,
            themeMode: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
            terminalBackground: currentTheme.colors.surface.background,
            terminalForeground: currentTheme.colors.syntax.base.foreground,
          });
          activeSessionId = created.sessionId;
          setTabSessionId(normalizedDirectory, tabId, activeSessionId);
        } finally {
          setConnecting(normalizedDirectory, tabId, false);
        }
      }

      if (!activeSessionId) {
        throw new Error(t('projectActions.error.failedToCreateTerminalSession'));
      }

      streamCleanupByRunKeyRef.current[key]?.();
      setConnecting(normalizedDirectory, tabId, true);
      const subscription = terminal.connect(
          activeSessionId,
          { onEvent: (event) => {
            if (event.type === 'snapshot') {
              useTerminalStore.getState().replaceBuffer(normalizedDirectory, tabId, event.data ?? '', event.sequence ?? 0);
              useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false);
            }
            if (event.type === 'data' && typeof event.data === 'string' && event.data.length > 0) {
              useTerminalStore.getState().appendToBuffer(normalizedDirectory, tabId, event.data, event.sequence, event.replayData);
            }
            if (event.type === 'exit') {
              useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tabId, 'exited');
              useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false);
              useTerminalStore.getState().removeProjectActionRun(key);
              delete urlWatchByRunKeyRef.current[key];
              streamCleanupByRunKeyRef.current[key]?.();
              delete streamCleanupByRunKeyRef.current[key];
              window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[key]);
              delete previewWaitTimeoutByRunKeyRef.current[key];
            }
          }, onError: (_error, fatal) => {
            useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false);
            if (fatal) {
              useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tabId, 'exited');
              useTerminalStore.getState().setTabSessionId(normalizedDirectory, tabId, null);
              useTerminalStore.getState().removeProjectActionRun(key);
            }
          } },
        );
      streamCleanupByRunKeyRef.current[key] = subscription.close;

      const hasDesktopForwardSelection = discovered.autoOpenUrl === true
        && isDesktopShellApp
        && (discovered.desktopOpenSshForward || '').trim().length > 0;
      const manualOpenUrl = discovered.autoOpenUrl ? normalizeManualOpenUrl(discovered.openUrl) : null;
      const desktopForwardUrl = discovered.autoOpenUrl && isDesktopShellApp
        ? resolveProjectActionDesktopForwardUrl(discovered.desktopOpenSshForward, desktopSshInstances)
        : null;

      setProjectActionRun({
        key,
        directory: normalizedDirectory,
        actionId: discovered.id,
        tabId,
        sessionId: activeSessionId,
        status: discovered.id === AUTO_DISCOVER_ACTION_ID && !manualOpenUrl ? 'waiting-for-preview' : 'running',
      });
      window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[key]);
      delete previewWaitTimeoutByRunKeyRef.current[key];
      if (discovered.id === AUTO_DISCOVER_ACTION_ID && !manualOpenUrl) {
        previewWaitTimeoutByRunKeyRef.current[key] = window.setTimeout(() => {
          const store = useTerminalStore.getState();
          const run = store.projectActionRuns[key];
          store.updateProjectActionRunStatus(key, 'running');
          if (run) {
            store.setActiveTab(run.directory, run.tabId);
            useUIStore.getState().openContextPanelTab(run.directory, { mode: 'terminal' });
          }
          delete previewWaitTimeoutByRunKeyRef.current[key];
        }, AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS);
      }

      urlWatchByRunKeyRef.current[key] = {
        lastSeenChunkId: null,
        openedUrl: Boolean(desktopForwardUrl) || Boolean(manualOpenUrl) || hasCustomOpenUrl,
        tail: '',
        openInPreview: discovered.id === AUTO_DISCOVER_ACTION_ID,
      };

      const normalizedCommand = stripControlChars(discovered.command.trim().replace(/\r\n|\r/g, '\n'));
      await terminal.sendInput(activeSessionId, `${normalizedCommand}\r`);

      if (desktopForwardUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: true });
        void openExternal(desktopForwardUrl);
        toast.success(t('projectActions.toast.openedForwardedUrl'));
      } else if (manualOpenUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, manualOpenUrl, { locked: true, autoOpened: true });
        openContextPreview(normalizedDirectory, manualOpenUrl);
        toast.success(t('projectActions.toast.openedActionUrl'));
      } else if (hasCustomOpenUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: true });
        toast.error(t('projectActions.error.invalidCustomUrlFormat'));
      } else if (hasDesktopForwardSelection) {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: true });
        toast.error(t('projectActions.error.selectedDesktopSshForwardUnavailable'));
      }

    } catch (error) {
      removeProjectActionRun(runKey);
      delete urlWatchByRunKeyRef.current[runKey];
      streamCleanupByRunKeyRef.current[runKey]?.();
      delete streamCleanupByRunKeyRef.current[runKey];
      window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
      delete previewWaitTimeoutByRunKeyRef.current[runKey];
      toast.error(error instanceof Error ? error.message : t('projectActions.error.failedToRunAction'));
    } finally {
      startingRunKeys.delete(startingKey);
    }
  }, [
    currentTheme.colors.surface.background,
    currentTheme.colors.syntax.base.foreground,
    currentTheme.metadata.variant,
    desktopSshInstances,
    getOrCreateActionTab,
    allowMobile,
    isMobile,
    isDesktopShellApp,
    normalizedDirectory,
    terminalLoginShell,
    terminalShell,
    openExternal,
    openContextPreview,
    projectActionRuns,
    removeProjectActionRun,
    setConnecting,
    setProjectActionRun,
    setTabPreviewUrl,
    setTabSessionId,
    stableProjectRef?.id,
    t,
    terminal,
  ]);

  const stopAction = React.useCallback(async (action: VarinProjectAction) => {
    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const activeRun = projectActionRuns[runKey];
    if (!activeRun) {
      return;
    }

    updateProjectActionRunStatus(runKey, 'stopping');

    const exitPromise = waitForTerminalExit(terminal, activeRun.sessionId, 1000);

    try {
      await terminal.sendInput(activeRun.sessionId, '\x03');
    } catch {
      // noop
    }

    const exitObserved = await exitPromise;

    const afterTab = useTerminalStore.getState().getDirectoryState(activeRun.directory)?.tabs
      .find((entry) => entry.id === activeRun.tabId);

    const sessionStillSame = afterTab?.terminalSessionId === activeRun.sessionId;

    if (sessionStillSame && !exitObserved) {
      if (typeof terminal.forceKill === 'function') {
        try {
          await terminal.forceKill({ sessionId: activeRun.sessionId });
        } catch {
          // noop
        }
      } else {
        try {
          await terminal.close(activeRun.sessionId);
        } catch {
          // noop
        }
      }
      setTabSessionId(activeRun.directory, activeRun.tabId, null);
    }

    removeProjectActionRun(runKey);
    delete urlWatchByRunKeyRef.current[runKey];
    streamCleanupByRunKeyRef.current[runKey]?.();
    delete streamCleanupByRunKeyRef.current[runKey];
    window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
    delete previewWaitTimeoutByRunKeyRef.current[runKey];
  }, [normalizedDirectory, projectActionRuns, removeProjectActionRun, setTabSessionId, terminal, updateProjectActionRunStatus]);

  const handlePrimaryClick = React.useCallback(() => {
    const action = selectedAction ?? displayActions[0];
    if (!action) {
      return;
    }
    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const runningEntry = projectActionRuns[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  }, [displayActions, normalizedDirectory, runAction, projectActionRuns, selectedAction, stopAction]);

  const handleSelectAction = React.useCallback((action: VarinProjectAction, toggleStopIfRunning = false) => {
    setSelectedActionId(action.id);

    if (!toggleStopIfRunning) {
      void runAction(action);
      return;
    }

    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const runningEntry = projectActionRuns[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  }, [normalizedDirectory, runAction, projectActionRuns, stopAction]);

  const openProjectActionsSettings = React.useCallback(() => {
    if (!stableProjectRef?.id) {
      return;
    }
    setSettingsProjectsSelectedId(stableProjectRef.id);
    setSettingsPage('projects');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage, setSettingsProjectsSelectedId, stableProjectRef?.id]);

  const previewAction = previewOnly ? autoDiscoverAction : selectedAction ?? displayActions[0] ?? null;
  const previewRun = previewAction ? projectActionRuns[toProjectActionRunKey(normalizedDirectory, previewAction.id)] : null;
  const selectedRunPreviewUrl = useTerminalStore((state) => {
    if (!previewRun) return null;
    return state.sessions.get(previewRun.directory)?.tabs.find((tab) => tab.id === previewRun.tabId)?.previewUrl ?? null;
  });

  if ((!allowMobile && isMobile) || !stableProjectRef || !normalizedDirectory) {
    return null;
  }

  const resolvedSelected = previewAction ?? ((contextMenu || menuTrigger) ? autoDiscoverAction : null);
  if (!resolvedSelected) {
    return null;
  }

  const selectedIconKey = (resolvedSelected.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;
  const selectedIconName = resolvedSelected.id === AUTO_DISCOVER_ACTION_ID
    ? 'play'
    : PROJECT_ACTION_ICON_MAP[selectedIconKey] || 'play';
  const selectedRunKey = toProjectActionRunKey(normalizedDirectory, resolvedSelected.id);
  const selectedRunning = projectActionRuns[selectedRunKey];
  const isStoppingSelected = selectedRunning?.status === 'stopping';
  const isWaitingForSelectedPreview = selectedRunning?.status === 'waiting-for-preview';
  const showSelectedPreviewButton = Boolean(selectedRunning && selectedRunPreviewUrl);
  const handleOpenSelectedPreview = () => {
    if (!selectedRunning || !selectedRunPreviewUrl) {
      return;
    }
    openContextPreview(selectedRunning.directory, selectedRunPreviewUrl);
  };
  const isAutoDiscoverSelected = resolvedSelected.id === AUTO_DISCOVER_ACTION_ID;

  const MenuItem = contextMenu ? ContextMenuItem : DropdownMenuItem;
  const MenuSeparator = contextMenu ? ContextMenuSeparator : DropdownMenuSeparator;
  const menuItems = (
    <>
      {displayActions.map((entry) => {
        const run = projectActionRuns[toProjectActionRunKey(normalizedDirectory, entry.id)];
        const waiting = run?.status === 'stopping' || run?.status === 'waiting-for-preview';
        const iconName = entry.id === AUTO_DISCOVER_ACTION_ID ? 'play' : PROJECT_ACTION_ICON_MAP[(entry.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP] || 'play';
        return (
          <MenuItem key={entry.id} disabled={isLoading || run?.status === 'stopping'} onClick={() => handleSelectAction(entry, true)}>
            <Icon name={waiting ? 'loader-4' : run ? 'stop' : iconName} className={cn('mr-2 size-4 shrink-0', waiting && 'animate-spin')} />
            <span className="truncate">{run ? t('projectActions.actions.stopNamedAria', { name: entry.id === AUTO_DISCOVER_ACTION_ID ? t('contextPanel.preview.title') : entry.name }) : entry.name}</span>
          </MenuItem>
        );
      })}
      <MenuSeparator />
      <MenuItem onClick={openProjectActionsSettings}>
        <Icon name="add" className="mr-2 size-4" />
        {t('projectActions.actions.addNewAction')}
      </MenuItem>
    </>
  );

  if (contextMenu) {
    return (
      <ContextMenu onOpenChange={(open) => { if (open) setMenuActivated(true); }}>
        <ContextMenuTrigger render={contextMenu.trigger} />
        <ContextMenuContent className="min-w-52 max-h-[70vh] overflow-y-auto">
          {contextMenu.leading ? <>{contextMenu.leading}<ContextMenuSeparator /></> : null}
          {menuItems}
          <ContextMenuSeparator />
          {contextMenu.children}
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  if (menuTrigger) {
    return (
      <DropdownMenu onOpenChange={(open) => { if (open) setMenuActivated(true); }}>
        <DropdownMenuTrigger asChild>{menuTrigger}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52 max-h-[70vh] overflow-y-auto">
          {menuItems}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (previewOnly) {
    return (
      <button
        type="button"
        disabled={isLoading || isStoppingSelected || isWaitingForSelectedPreview}
        onClick={() => handleSelectAction(autoDiscoverAction, true)}
        className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 typography-ui-label text-primary-foreground disabled:opacity-50"
      >
        <Icon name={isWaitingForSelectedPreview || isStoppingSelected ? 'loader-4' : selectedRunning ? 'stop' : 'play'} className={cn('size-4', (isWaitingForSelectedPreview || isStoppingSelected) && 'animate-spin')} />
        {isWaitingForSelectedPreview ? t('contextPanel.preview.starting') : selectedRunning ? t('projectActions.actions.stopNamedAria', { name: t('contextPanel.preview.title') }) : t('contextPanel.preview.startPreview')}
      </button>
    );
  }

  if (compact) {
    return (
      <div className="inline-flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={isLoading || isStoppingSelected}
              className={cn(
                'app-region-no-drag inline-flex h-9 w-9 items-center justify-center rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] p-2',
                'typography-ui-label font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                'disabled:cursor-not-allowed',
                className
              )}
              onClick={handlePrimaryClick}
              aria-label={selectedRunning
                ? t('projectActions.actions.stopNamedAria', { name: resolvedSelected.name })
                : t('projectActions.actions.runNamedAria', { name: resolvedSelected.name })}
            >
              {isStoppingSelected || isWaitingForSelectedPreview
                ? <Icon name="loader-4" className="h-5 w-5 animate-spin text-[var(--status-warning)]" />
                : selectedRunning
                  ? <Icon name="stop" className="h-5 w-5 text-[var(--status-warning)]" />
                  : <Icon name={selectedIconName} className="h-5 w-5" />}
            </button>
          </TooltipTrigger>
          {isAutoDiscoverSelected ? (
            <TooltipContent sideOffset={6}>{t('contextPanel.preview.startPreview')}</TooltipContent>
          ) : null}
        </Tooltip>
        {showSelectedPreviewButton ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="app-region-no-drag -ml-1 inline-flex h-9 w-7 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={t('projectActions.actions.openPreview')}
                onClick={handleOpenSelectedPreview}
              >
                <Icon name="global" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('projectActions.actions.openPreview')}</TooltipContent>
          </Tooltip>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="app-region-no-drag -ml-1 inline-flex h-9 w-5 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t('projectActions.actions.chooseActionAria')}
            >
              <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 max-h-[70vh] overflow-y-auto">
            {menuItems}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'app-region-no-drag inline-flex shrink-0 items-center self-center rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px]',
        'bg-[var(--surface-elevated)] overflow-hidden',
        'border border-border/60',
        compact ? 'h-9' : 'h-7',
        className
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handlePrimaryClick}
            disabled={isLoading || isStoppingSelected}
            className={cn(
              'inline-flex h-full items-center justify-center typography-ui-label font-medium text-foreground hover:bg-interactive-hover',
              compact ? 'w-9 px-0' : 'px-2.5',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed'
            )}
            aria-label={selectedRunning
              ? t('projectActions.actions.stopNamedAria', { name: resolvedSelected.name })
              : t('projectActions.actions.runNamedAria', { name: resolvedSelected.name })}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
              {isStoppingSelected || isWaitingForSelectedPreview
                ? <Icon name="loader-4" className="h-4 w-4 animate-spin text-[var(--status-warning)]" />
                : selectedRunning
                  ? <Icon name="stop" className="h-4 w-4 text-[var(--status-warning)]" />
                  : <Icon name={selectedIconName} className="h-4 w-4" />}
            </span>
          </button>
        </TooltipTrigger>
        {isAutoDiscoverSelected ? (
          <TooltipContent sideOffset={6}>{t('contextPanel.preview.startPreview')}</TooltipContent>
        ) : null}
      </Tooltip>

      {showSelectedPreviewButton ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleOpenSelectedPreview}
              className={cn(
                compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
                'border-l border-[var(--interactive-border)] text-foreground',
                'hover:bg-interactive-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
              aria-label={t('projectActions.actions.openPreview')}
            >
              <Icon name="global" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{t('projectActions.actions.openPreview')}</TooltipContent>
        </Tooltip>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
              'border-l border-[var(--interactive-border)] text-muted-foreground',
              'hover:bg-interactive-hover hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
            )}
            aria-label={t('projectActions.actions.chooseActionAria')}
          >
            <Icon name="arrow-down-s" className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52 max-h-[70vh] overflow-y-auto">
          {menuItems}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
