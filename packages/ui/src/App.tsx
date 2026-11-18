import React from 'react';
import { ChatView } from '@/components/views/ChatView';
import {
  isEmbeddedSessionChatReady,
  normalizeEmbeddedSessionDirectory,
  readEmbeddedSessionChatConfig,
  type EmbeddedSessionChatConfig,
} from '@/lib/embeddedSessionChat';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useMenuActions } from '@/hooks/useMenuActions';
import { useTraySync } from '@/hooks/useTraySync';
import { useRouter } from '@/hooks/useRouter';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useWebNotificationStream } from '@/hooks/useWebNotificationStream';
import { usePwaInstallPrompt } from '@/hooks/usePwaInstallPrompt';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { isDesktopShell } from '@/lib/desktop';
import type { DesktopBootView } from '@/lib/desktopBoot';
import {
  desktopWorkspaceIsOperable,
  resolveDesktopWorkspaceView,
} from '@/lib/desktopWorkspaceView';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { WorkbenchTransitionOverlay } from '@/components/ui/WorkbenchTransitionOverlay';
import { dismissInitialSplash, setInitialSplashStatus } from '@/lib/splash';
import { AboutDialog } from '@/components/ui/AboutDialog';
import { SearchCredentialDialog } from '@/components/sections/harness/SearchCredentialDialog';
import { VarinDiagnosticsDialog } from '@/components/ui/VarinDiagnosticsDialog';
import { WorkspaceEditReviewDialog } from '@/components/workbench/WorkspaceEditReviewDialog';
import { AgentEditorCoordinator } from '@/components/workbench/AgentEditorCoordinator';
import { RunDebugCoordinator } from '@/components/workbench/RunDebugCoordinator';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { subscribeDefaultDirectoryToRuntimeChanges } from '@/lib/directoryPersistence';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import type { RuntimeAPIs } from '@varin/application-client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { applyMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { isMobileAppRuntime, useMobileAppViewport } from '@/lib/mobileAppRuntime';
import { ThreadAppEffects } from '@/apps/ThreadAppEffects';
import { usePluginInstallLinks } from '@/apps/pluginInstallNavigation';
import { resetAppForRuntimeEndpointChange } from '@/apps/runtimeEndpointReset';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { invalidateSettingsCache, syncDesktopSettings } from '@/lib/persistence';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { markStartupTrace, startupTraceEnabled } from '@/lib/startupTrace';
import { useChatContentWidth } from '@/hooks/useChatContentWidth';
import { useThreadCatalogBootstrap } from '@/hooks/useThreadCatalogBootstrap';
import {
  openThreadFromNavigation,
  startThreadFromNavigation,
} from '@/lib/agent-runtime/threadNavigation';
import { toast } from '@/components/ui';
import { isDesktopThreadNavigationTarget } from '@/lib/agent-runtime/desktopThreadNavigation';
import {
  WorkbenchProfileBridge,
} from '@/lib/extensions/workbench-registry';
import { WorkbenchShellHost } from '@/lib/extensions/workbench-shell-host';

const AboutDialogWrapper: React.FC = () => {
  const isAboutDialogOpen = useUIStore((s) => s.isAboutDialogOpen);
  const setAboutDialogOpen = useUIStore((s) => s.setAboutDialogOpen);
  const setVarinDiagnosticsDialogOpen = useUIStore((s) => s.setVarinDiagnosticsDialogOpen);
  return (
    <AboutDialog
      open={isAboutDialogOpen}
      onOpenChange={setAboutDialogOpen}
      onOpenDiagnostics={() => setVarinDiagnosticsDialogOpen(true)}
    />
  );
};

const RuntimeInitializationRecovery: React.FC<{
  onRetry: () => void;
  isRetrying: boolean;
}> = ({ onRetry, isRetrying }) => {
  const { t } = useI18n();

  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="typography-title text-foreground">{t('startup.initRecovery.title')}</h1>
          <p className="typography-body text-muted-foreground">{t('startup.initRecovery.description')}</p>
        </div>
        <Button type="button" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? t('startup.initRecovery.retrying') : t('startup.initRecovery.retry')}
        </Button>
      </div>
    </div>
  );
};

type AppProps = {
  bootView: Extract<DesktopBootView, { screen: 'main' }> | null;
  apis: RuntimeAPIs;
};

type EmbeddedVisibilityPayload = {
  visible?: unknown;
};

const EmbeddedSessionChatContent: React.FC<{
  embeddedSessionChat: EmbeddedSessionChatConfig;
  embeddedBackgroundWorkEnabled: boolean;
}> = ({ embeddedSessionChat, embeddedBackgroundWorkEnabled }) => {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentIdentity = useThreadStore((state) => state.selectedIdentity);
  const catalogLoaded = useThreadStore(state => state.catalogLoaded);
  const currentSessionId = currentIdentity?.threadId ?? null;
  const bootstrapKeyRef = React.useRef<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retryGeneration, retry] = React.useReducer((value: number) => value + 1, 0);

  const expectedDirectory = normalizeEmbeddedSessionDirectory(embeddedSessionChat.directory);

  React.useEffect(() => {
    if (!catalogLoaded) return;
    const bootstrapKey = `${expectedDirectory}\n${embeddedSessionChat.threadId}\n${embeddedSessionChat.branchId}`;
    // Skip if this session was already bootstrapped and a session is still
    // active — allows in-place navigation (e.g. "Open subtask") to change
    // currentSessionId without this effect forcing it back. Only re-bootstrap
    // when currentSessionId was cleared (store init, draft, delete/archive,
    // runtime-switch remount).
    if (bootstrapKeyRef.current === bootstrapKey && currentSessionId) {
      return;
    }

    let cancelled = false;
    setLoadError(null);
    void openThreadFromNavigation({
      directory: embeddedSessionChat.directory,
      threadId: embeddedSessionChat.threadId,
      branchId: embeddedSessionChat.branchId,
    }).then(() => {
      if (!cancelled) bootstrapKeyRef.current = bootstrapKey;
    }).catch((error) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
    });
    return () => {
      cancelled = true;
    };
  }, [
    currentSessionId,
    catalogLoaded,
    embeddedSessionChat.directory,
    embeddedSessionChat.threadId,
    embeddedSessionChat.branchId,
    expectedDirectory,
    retryGeneration,
  ]);

  const isSessionReady = isEmbeddedSessionChatReady({
    embeddedSessionChat,
    currentIdentity,
    currentDirectory,
  });

  if (!isSessionReady) {
    if (loadError) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center">
          <div className="max-w-md space-y-3">
            <p className="typography-body text-destructive">{loadError}</p>
            <Button type="button" variant="outline" onClick={retry}>Retry</Button>
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <>
      <ThreadAppEffects />
      <ChatView active={embeddedBackgroundWorkEnabled} readOnly={embeddedSessionChat.readOnly} autoOpenDraft={false} />
      <Toaster />
    </>
  );
};

function App({ apis, bootView }: AppProps) {
  const { t } = useI18n();

  React.useEffect(() => {
    markStartupTrace('App:mounted');
    if (startupTraceEnabled()) {
      console.info('[startup-trace] enabled. Run console.table(window.__VARIN_STARTUP_TRACE__) after startup.');
    }
  }, []);

  const catalogLoaded = useThreadStore((state) => state.catalogLoaded);
  const catalogLoading = useThreadStore((state) => state.catalogLoading);
  const catalogError = useThreadStore((state) => state.catalogError);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const isSwitchingDirectory = useDirectoryStore((state) => state.isSwitchingDirectory);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(true);
  const [workbenchReady, setWorkbenchReady] = React.useState(false);
  const chatContentWidth = useUIStore((state) => state.chatContentWidth);
  const mobileKeyboardMode = useUIStore((state) => state.mobileKeyboardMode);
  const isDesktopRuntime = React.useMemo(() => isDesktopShell(), []);
  const enableMobileAppViewport = React.useMemo(() => isMobileAppRuntime(), []);
  const appReadyDispatchedRef = React.useRef(false);
  const embeddedSessionChat = React.useMemo<EmbeddedSessionChatConfig | null>(() => readEmbeddedSessionChatConfig(), []);
  usePluginInstallLinks(!embeddedSessionChat);
  const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;

  React.useEffect(() => {
    applyMobileKeyboardMode(mobileKeyboardMode);
  }, [mobileKeyboardMode]);

  useMobileAppViewport(enableMobileAppViewport);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      resetAppForRuntimeEndpointChange(detail);
      appReadyDispatchedRef.current = false;
    });
  }, []);

  // Agent-originated settings writes (D-306): the Host broadcasts
  // varin:settings-changed after the owning authority persists; refresh the
  // shared document so UI state never sits on a stale copy.
  React.useEffect(() => {
    return subscribeVarinEvents((event) => {
      if (event.type !== 'settings-changed' || event.owner !== 'app') return;
      invalidateSettingsCache();
      void syncDesktopSettings();
    });
  }, []);

  useThreadCatalogBootstrap(apis.threads);

  useChatContentWidth(chatContentWidth);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => subscribeDefaultDirectoryToRuntimeChanges(apis), [apis]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, embeddedSessionChat, refreshGitHubAuthStatus]);

  useAppFontEffects();

  const desktopWorkspaceView = React.useMemo(
    () =>
      isDesktopRuntime
        ? resolveDesktopWorkspaceView({
            catalogError: catalogError,
            catalogLoaded: catalogLoaded,
            catalogLoading: catalogLoading,
          })
        : null,
    [isDesktopRuntime, catalogLoaded, catalogLoading, catalogError],
  );
  const runtimeReady = isDesktopRuntime
    ? desktopWorkspaceIsOperable(desktopWorkspaceView ?? 'loading', isSwitchingDirectory)
    : catalogLoaded;
  const needsWorkbench = !embeddedSessionChat
    && desktopWorkspaceView !== 'catalog-recovery'
    && !(!isDesktopRuntime && !catalogLoaded && catalogError);

  React.useEffect(() => {
    if (needsWorkbench && !workbenchReady) return;
    if (!runtimeReady && desktopWorkspaceView !== 'catalog-recovery' && (isDesktopRuntime || !catalogError)) return;

    // Held briefly so the mark's entrance is seen rather than skipped. A start fast enough to
    // dismiss instantly reads as a flicker, which looks worse than a moment of waiting.
    const timer = setTimeout(dismissInitialSplash, 150);

    return () => clearTimeout(timer);
  }, [desktopWorkspaceView, isDesktopRuntime, runtimeReady, catalogError, needsWorkbench, workbenchReady]);

  // The splash has no measurable progress, only a sequence of gates, so it names the gate it is
  // waiting on instead of inventing a percentage.
  React.useEffect(() => {
    if (runtimeReady && (!needsWorkbench || workbenchReady)) return;
    setInitialSplashStatus(
      catalogLoaded ? t('splash.status.preparingWorkspace') : t('splash.status.connectingRuntime'),
    );
  }, [catalogLoaded, runtimeReady, needsWorkbench, workbenchReady, t]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const applyVisibility = (payload?: EmbeddedVisibilityPayload) => {
      const nextVisible = payload?.visible === true;
      setIsEmbeddedVisible(nextVisible);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      const data = event.data as { type?: unknown; payload?: EmbeddedVisibilityPayload };
      if (data?.type !== 'varin:embedded-visibility') {
        return;
      }

      applyVisibility(data.payload);
    };

    const scopedWindow = window as unknown as {
      __varinSetEmbeddedVisibility?: (payload?: EmbeddedVisibilityPayload) => void;
    };

    scopedWindow.__varinSetEmbeddedVisibility = applyVisibility;
    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
      if (scopedWindow.__varinSetEmbeddedVisibility === applyVisibility) {
        delete scopedWindow.__varinSetEmbeddedVisibility;
      }
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (!embeddedSessionChat?.directory) {
      return;
    }

    if (currentDirectory === embeddedSessionChat.directory) {
      return;
    }

    setDirectory(embeddedSessionChat.directory, { showOverlay: false });
  }, [currentDirectory, embeddedSessionChat, setDirectory]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key !== 'ui-store') {
        return;
      }

      void useUIStore.persist.rehydrate();
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (embeddedSessionChat || typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; branchId?: string; directory?: string; apiBaseUrl?: string; relayHostId?: string }>).detail;
      const threadId = typeof detail?.threadId === 'string' ? detail.threadId.trim() : '';
      if (!threadId || !detail.branchId || !isDesktopThreadNavigationTarget(detail)) return;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      void openThreadFromNavigation({ directory, threadId, branchId: detail.branchId }).catch((openError) => {
        toast.error('Failed to open conversation', {
          description: openError instanceof Error ? openError.message : String(openError),
        });
      });
    };

    window.addEventListener('varin:open-thread', handler as EventListener);
    return () => window.removeEventListener('varin:open-thread', handler as EventListener);
  }, [embeddedSessionChat]);

  // Tray/menu requests open a local draft; its first send creates the Thread.
  React.useEffect(() => {
    if (embeddedSessionChat || typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ directory?: string; projectId?: string }>).detail;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      void startThreadFromNavigation({ directory }).catch((createError) => {
        toast.error('Failed to create conversation', {
          description: createError instanceof Error ? createError.message : String(createError),
        });
      });
    };

    window.addEventListener('varin:open-draft-thread', handler as EventListener);
    return () => window.removeEventListener('varin:open-draft-thread', handler as EventListener);
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    (window as unknown as { __varinStartupDiagnostics?: unknown }).__varinStartupDiagnostics = {
      bootView,
      catalogError: catalogError,
      catalogLoaded: catalogLoaded,
      isSwitchingDirectory,
      runtimeReady,
      workspaceView: desktopWorkspaceView,
    };
  }, [
    bootView,
    desktopWorkspaceView,
    isSwitchingDirectory,
    catalogLoaded,
    catalogError,
    runtimeReady,
  ]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!runtimeReady) return;
    if (needsWorkbench && !workbenchReady) return;
    if (isSwitchingDirectory) return;
    if (appReadyDispatchedRef.current) return;
    appReadyDispatchedRef.current = true;
    (window as unknown as { __varinAppReady?: boolean }).__varinAppReady = true;
    window.dispatchEvent(new Event('varin:app-ready'));
  }, [isSwitchingDirectory, runtimeReady, needsWorkbench, workbenchReady]);

  // Session attention now handled by notification-store via SSE events (session.idle/session.error)

  usePushVisibilityBeacon({ enabled: embeddedBackgroundWorkEnabled });
  useWebNotificationStream({ enabled: embeddedBackgroundWorkEnabled });
  usePwaInstallPrompt();

  useWindowTitle();

  useRouter({ enabled: !embeddedSessionChat && catalogLoaded });

  useMenuActions({ enabled: !embeddedSessionChat });

  useTraySync({ enabled: !embeddedSessionChat && catalogLoaded });

  if (embeddedSessionChat) {
    return (
      <ErrorBoundary onError={dismissInitialSplash}>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider>
            <div className="h-full text-foreground bg-background">
              <EmbeddedSessionChatContent
                embeddedSessionChat={embeddedSessionChat}
                embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled}
              />
              <SearchCredentialDialog />
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </ErrorBoundary>
    );
  }


  if (
    (!embeddedSessionChat && !isDesktopRuntime && !catalogLoaded && catalogError)
    || desktopWorkspaceView === 'catalog-recovery'
  ) {
    return (
      <ErrorBoundary onError={dismissInitialSplash}>
        <RuntimeInitializationRecovery
          onRetry={() => { void useThreadStore.getState().loadCatalog().catch(() => {}); }}
          isRetrying={catalogLoading}
        />
      </ErrorBoundary>
    );
  }

  const isBootShell = !catalogLoaded && !isDesktopRuntime;

  return (
    <ErrorBoundary onError={dismissInitialSplash}>
      <RuntimeAPIProvider apis={apis}>
        <FireworksProvider>
          <TooltipProvider>
            <div className={isDesktopRuntime ? 'h-full text-foreground bg-transparent' : 'h-full text-foreground bg-background'}>
              {catalogLoaded && <ThreadAppEffects />}
              <AgentEditorCoordinator />
              <RunDebugCoordinator />
              <WorkbenchProfileBridge />
              <WorkbenchShellHost onReadyChange={setWorkbenchReady} />
              <Toaster />
              <WorkspaceEditReviewDialog />
              <SearchCredentialDialog />
              {!isBootShell && (
                <>
                  <WorkbenchTransitionOverlay />
                  <AboutDialogWrapper />
                  <VarinDiagnosticsDialog />
                </>
              )}
            </div>
          </TooltipProvider>
        </FireworksProvider>
      </RuntimeAPIProvider>
    </ErrorBoundary>
  );
}

export default App;
