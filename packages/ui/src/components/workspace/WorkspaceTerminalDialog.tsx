import React from 'react';
import {
  RiCloseLine,
  RiFullscreenExitLine,
  RiFullscreenLine,
  RiStopCircleLine,
  RiTerminalLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TerminalViewport, type TerminalController } from '@/components/terminal/TerminalViewport';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useI18n } from '@/lib/i18n';
import { CODE_FONT_OPTION_MAP, DEFAULT_MONO_FONT } from '@/lib/fontOptions';
import { convertThemeToXterm } from '@/lib/terminalTheme';
import { cn } from '@/lib/utils';
import type { TerminalStreamEvent } from '@varin/application-client';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { EMPTY_TERMINAL_BUFFER, useTerminalStore } from '@/stores/useTerminalStore';
import { useUIStore } from '@/stores/useUIStore';
import { useWorkspaceStore } from '@/stores/useWorkspaceStore';
import { TerminalView } from '@/components/views/TerminalView';

const WorkspaceShellTerminalDialog: React.FC = () => {
  const { t } = useI18n();
  const { terminal } = useRuntimeAPIs();
  const { currentTheme } = useThemeSystem();
  const { monoFont } = useFontPreferences();
  const terminalFontSize = useUIStore((state) => state.terminalFontSize);
  const dialog = useWorkspaceStore((state) => state.terminalDialog);
  const closeTerminalDialog = useWorkspaceStore((state) => state.closeTerminal);
  const ensureDirectory = useTerminalStore((state) => state.ensureDirectory);
  const setTabSessionId = useTerminalStore((state) => state.setTabSessionId);
  const setTabLifecycle = useTerminalStore((state) => state.setTabLifecycle);
  const setConnecting = useTerminalStore((state) => state.setConnecting);
  const replaceBuffer = useTerminalStore((state) => state.replaceBuffer);
  const appendToBuffer = useTerminalStore((state) => state.appendToBuffer);
  const sessions = useTerminalStore((state) => state.sessions);

  const terminalState = sessions.get(dialog.directoryKey);
  const activeTabId = terminalState?.activeTabId ?? terminalState?.tabs[0]?.id ?? null;
  const activeTab = activeTabId
    ? terminalState?.tabs.find((tab) => tab.id === activeTabId) ?? terminalState?.tabs[0]
    : terminalState?.tabs[0];
  const terminalSessionId = activeTab?.terminalSessionId ?? null;
  const chunks = useTerminalStore((state) => (
    activeTabId
      ? state.getBuffer(dialog.directoryKey, activeTabId).chunks
      : EMPTY_TERMINAL_BUFFER.chunks
  ));
  const isConnecting = activeTab?.isConnecting ?? false;
  const lifecycle = activeTab?.lifecycle ?? 'idle';

  const [isMaximized, setIsMaximized] = React.useState(false);
  const [connectionError, setConnectionError] = React.useState<string | null>(null);
  const controllerRef = React.useRef<TerminalController | null>(null);
  const streamCleanupRef = React.useRef<(() => void) | null>(null);
  const activeTerminalIdRef = React.useRef<string | null>(null);
  const lastSizeRef = React.useRef<{ cols: number; rows: number } | null>(null);

  const terminalMessages = React.useMemo(() => ({
    createFailed: t('workspace.terminal.error.createFailed'),
    connectionFailed: t('workspace.terminal.error.connectionFailed'),
    processExited: t('workspace.terminal.status.processExited'),
    sendFailed: t('workspace.terminal.error.sendFailed'),
  }), [t]);
  const terminalMessagesRef = React.useRef(terminalMessages);

  React.useEffect(() => {
    terminalMessagesRef.current = terminalMessages;
  }, [terminalMessages]);

  const xtermTheme = React.useMemo(() => convertThemeToXterm(currentTheme), [currentTheme]);
  const resolvedFontStack = React.useMemo(() => {
    if (typeof window !== 'undefined') {
      const root = window.getComputedStyle(document.documentElement);
      const cssStack = root.getPropertyValue('--font-family-mono');
      if (cssStack && cssStack.trim()) {
        return cssStack.trim();
      }
    }
    const fallbackDefinition = CODE_FONT_OPTION_MAP[monoFont] ?? CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT];
    return fallbackDefinition.stack;
  }, [monoFont]);

  React.useEffect(() => {
    if (!dialog.open) {
      return;
    }
    ensureDirectory(dialog.directoryKey);
  }, [dialog.directoryKey, dialog.open, ensureDirectory]);

  React.useEffect(() => {
    if (!dialog.open || !activeTabId || dialog.workspacePath === null) {
      return;
    }

    let cancelled = false;
    const directoryKey = dialog.directoryKey;
    const workspacePath = dialog.workspacePath;

    const ensureSession = async () => {
      const currentTab = useTerminalStore.getState().getActiveTab(directoryKey);
      if (currentTab?.terminalSessionId || currentTab?.lifecycle === 'exited') {
        return;
      }

      setConnectionError(null);
      setConnecting(directoryKey, activeTabId, true);
      try {
        const size = lastSizeRef.current;
        const session = await terminal.createSession({
          workspacePath,
          cols: size?.cols,
          rows: size?.rows,
        });
        if (cancelled) {
          await terminal.close(session.sessionId).catch(() => {});
          return;
        }
        setTabSessionId(directoryKey, activeTabId, session.sessionId);
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        setConnectionError(message || terminalMessages.createFailed);
        setConnecting(directoryKey, activeTabId, false);
        setTabLifecycle(directoryKey, activeTabId, 'exited');
      }
    };

    void ensureSession();
    return () => {
      cancelled = true;
    };
  }, [
    activeTabId,
    dialog.directoryKey,
    dialog.open,
    dialog.workspacePath,
    setConnecting,
    setTabLifecycle,
    setTabSessionId,
    terminalMessages.createFailed,
    terminal,
  ]);

  const disconnectStream = React.useCallback(() => {
    streamCleanupRef.current?.();
    streamCleanupRef.current = null;
    activeTerminalIdRef.current = null;
  }, []);

  const startStream = React.useCallback((directoryKey: string, tabId: string, sessionId: string) => {
    if (activeTerminalIdRef.current === sessionId) {
      return;
    }

    disconnectStream();
    activeTerminalIdRef.current = sessionId;

    const subscription = terminal.connect(
      sessionId,
      {
        onEvent: (event: TerminalStreamEvent) => {
          if (activeTerminalIdRef.current !== sessionId) {
            return;
          }

          switch (event.type) {
            case 'snapshot':
              setConnectionError(null);
              setConnecting(directoryKey, tabId, false);
              replaceBuffer(directoryKey, tabId, event.data ?? '', event.sequence ?? 0);
              if (event.status === 'exited') {
                setTabLifecycle(directoryKey, tabId, 'exited');
              }
              requestAnimationFrame(() => controllerRef.current?.focus());
              break;
            case 'data':
              if (event.data) {
                appendToBuffer(directoryKey, tabId, event.data, event.sequence, event.replayData);
              }
              break;
            case 'exit':
              setTabLifecycle(directoryKey, tabId, 'exited');
              setTabSessionId(directoryKey, tabId, null);
              setConnecting(directoryKey, tabId, false);
              appendToBuffer(directoryKey, tabId, `\r\n[${terminalMessagesRef.current.processExited}]\r\n`);
              disconnectStream();
              break;
            case 'reconnecting':
              setConnectionError(null);
              break;
          }
        },
        onError: (error, fatal) => {
          if (activeTerminalIdRef.current !== sessionId) {
            return;
          }

          if (!fatal) {
            return;
          }
          setConnectionError(error.message || terminalMessagesRef.current.connectionFailed);
          setConnecting(directoryKey, tabId, false);
          setTabLifecycle(directoryKey, tabId, 'exited');
          setTabSessionId(directoryKey, tabId, null);
          disconnectStream();
        },
      },
    );
    streamCleanupRef.current = () => {
      subscription.close();
      if (activeTerminalIdRef.current === sessionId) {
        activeTerminalIdRef.current = null;
      }
    };
  }, [
    appendToBuffer,
    disconnectStream,
    replaceBuffer,
    setConnecting,
    setTabLifecycle,
    setTabSessionId,
    terminal,
  ]);

  React.useEffect(() => {
    if (!dialog.open || !activeTabId || !terminalSessionId) {
      disconnectStream();
      return;
    }

    startStream(dialog.directoryKey, activeTabId, terminalSessionId);
  }, [activeTabId, dialog.directoryKey, dialog.open, disconnectStream, startStream, terminalSessionId]);

  React.useEffect(() => () => disconnectStream(), [disconnectStream]);

  React.useEffect(() => {
    if (!dialog.open) {
      return;
    }
    const rafId = requestAnimationFrame(() => {
      controllerRef.current?.fit();
      controllerRef.current?.focus();
    });
    const timeoutId = window.setTimeout(() => controllerRef.current?.fit(), 180);
    return () => {
      cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [dialog.open, isMaximized, terminalSessionId]);

  const handleInput = React.useCallback((input: string) => {
    if (!terminalSessionId) {
      return;
    }
    void terminal.sendInput(terminalSessionId, input).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setConnectionError(message || terminalMessagesRef.current.sendFailed);
    });
  }, [terminal, terminalSessionId]);

  const handleResize = React.useCallback((cols: number, rows: number) => {
    lastSizeRef.current = { cols, rows };
    if (!terminalSessionId) {
      return;
    }
    void terminal.resize({ sessionId: terminalSessionId, cols, rows }).catch(() => {});
  }, [terminal, terminalSessionId]);

  const handleStop = React.useCallback(async () => {
    if (!activeTabId || !terminalSessionId || !terminal.forceKill) {
      return;
    }
    await terminal.forceKill({ sessionId: terminalSessionId }).catch(() => {});
    setTabLifecycle(dialog.directoryKey, activeTabId, 'exited');
    setTabSessionId(dialog.directoryKey, activeTabId, null);
    setConnecting(dialog.directoryKey, activeTabId, false);
  }, [activeTabId, dialog.directoryKey, setConnecting, setTabLifecycle, setTabSessionId, terminal, terminalSessionId]);

  const handleRestart = React.useCallback(() => {
    if (!activeTabId) {
      return;
    }
    replaceBuffer(dialog.directoryKey, activeTabId, '', 0);
    setTabLifecycle(dialog.directoryKey, activeTabId, 'idle');
    setTabSessionId(dialog.directoryKey, activeTabId, null);
  }, [activeTabId, dialog.directoryKey, replaceBuffer, setTabLifecycle, setTabSessionId]);

  return (
    <Dialog open={dialog.open} onOpenChange={(open: boolean) => {
      if (!open) {
        closeTerminalDialog();
      }
    }}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          'gap-0 overflow-hidden p-0',
          isMaximized ? 'h-[calc(100vh-24px)] max-w-[calc(100vw-24px)]' : 'h-[72vh] max-w-5xl',
        )}
      >
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b border-border/60 px-3 py-2 text-left">
          <DialogTitle className="flex min-w-0 items-center gap-2 typography-ui-label">
            <RiTerminalLine className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{dialog.title}</span>
          </DialogTitle>
          <div className="flex shrink-0 items-center gap-1">
            {lifecycle === 'exited' ? (
              <Button type="button" size="xs" variant="outline" onClick={handleRestart}>
                {t('workspace.terminal.actions.restart')}
              </Button>
            ) : null}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={handleStop}
              disabled={!terminalSessionId}
              title={t('workspace.terminal.actions.stop')}
            >
              <RiStopCircleLine className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => setIsMaximized((value) => !value)}
              title={isMaximized ? t('workspace.terminal.actions.restore') : t('workspace.terminal.actions.maximize')}
            >
              {isMaximized ? <RiFullscreenExitLine className="h-4 w-4" /> : <RiFullscreenLine className="h-4 w-4" />}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={closeTerminalDialog}
              title={t('workspace.terminal.actions.hide')}
            >
              <RiCloseLine className="h-4 w-4" />
            </Button>
          </div>
        </DialogHeader>
        <div className="relative min-h-0 flex-1 overflow-hidden" style={{ backgroundColor: xtermTheme.background }}>
          <div className="h-full w-full box-border px-3 pb-3 pt-3">
            <TerminalViewport
              key={`${dialog.directoryKey}:${terminalSessionId ?? 'pending'}`}
              ref={(controller) => {
                controllerRef.current = controller;
              }}
              sessionKey={`${dialog.directoryKey}:${terminalSessionId ?? 'pending'}`}
              chunks={chunks}
              onInput={handleInput}
              onResize={handleResize}
              theme={xtermTheme}
              fontFamily={resolvedFontStack}
              fontSize={terminalFontSize}
              autoFocus
            />
          </div>
          {(isConnecting || connectionError) ? (
            <div className={cn(
              'absolute inset-x-0 bottom-0 px-3 py-2 typography-micro',
              connectionError
                ? 'bg-[var(--status-error-background)] text-[var(--status-error-foreground)]'
                : 'bg-[var(--surface-elevated)] text-muted-foreground',
            )}>
              {connectionError || t('workspace.terminal.status.connecting')}
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export const WorkspaceTerminalDialog: React.FC = () => {
  const dialog = useWorkspaceStore(state => state.terminalDialog);
  const close = useWorkspaceStore(state => state.closeTerminal);
  if (dialog.workspacePath !== null) return <WorkspaceShellTerminalDialog />;
  return <Dialog open={dialog.open} onOpenChange={(open: boolean) => { if (!open) close(); }}>
    <DialogContent className="flex h-[72vh] max-w-5xl flex-col gap-0 overflow-hidden p-0">
      <DialogHeader className="shrink-0 border-b border-border/60 px-3 py-2 text-left">
        <DialogTitle className="truncate pr-8 typography-ui-label">{dialog.title}</DialogTitle>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-hidden">
        <TerminalView visible={dialog.open} directoryOverride={dialog.directoryKey} attachedOnly onClose={close} />
      </div>
    </DialogContent>
  </Dialog>;
};
