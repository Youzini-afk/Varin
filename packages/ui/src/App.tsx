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
import { isDesktopLocalOriginActive, isDesktopShell, restartDesktopApp } from '@/lib/desktop';
import {
  getInjectedBootOutcome,
  getBootInjectionStatus,
  resolveDesktopBootView,
  canDismissInitialLoading,
  shouldRestartDesktopBootFlow,
  type BootInjectionStatus,
  type DesktopBootView,
} from '@/lib/desktopBoot';
import {
  desktopWorkspaceIsOperable,
  resolveDesktopWorkspaceView,
} from '@/lib/desktopWorkspaceView';
import type { RecoveryVariant } from '@/components/onboarding/DesktopConnectionRecovery';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { subscribeRuntimeEndpointChanged } from '@varin/application-client';
import { WorkbenchTransitionOverlay } from '@/components/ui/WorkbenchTransitionOverlay';
import { dismissInitialSplash, setInitialSplashStatus } from '@/lib/splash';
import { AboutDialog } from '@/components/ui/AboutDialog';
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
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useI18n } from '@/lib/i18n';
import { applyMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import { isMobileAppRuntime, useMobileAppViewport } from '@/lib/mobileAppRuntime';
import { ThreadAppEffects } from '@/apps/ThreadAppEffects';
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

// Lazy-loaded heavy views — loaded on demand to reduce initial bundle size.
const OnboardingScreen = lazyWithChunkRecovery(() =>
  import('@/components/onboarding/OnboardingScreen').then((m) => ({ default: m.OnboardingScreen })),
);

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

function App({ apis }: AppProps) {
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
  const chatContentWidth = useUIStore((state) => state.chatContentWidth);
  const mobileKeyboardMode = useUIStore((state) => state.mobileKeyboardMode);
  const isDesktopRuntime = React.useMemo(() => isDesktopShell(), []);
  const enableMobileAppViewport = React.useMemo(() => isMobileAppRuntime(), []);
  const [bootInjectionStatus, setBootInjectionStatus] = React.useState<BootInjectionStatus>(() => {
    return getBootInjectionStatus();
  });
  const [bootView, setBootView] = React.useState<DesktopBootView | null>(() => {
    const outcome = getInjectedBootOutcome();
    return outcome !== null
      ? resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome })
      : null;
  });
  const appReadyDispatchedRef = React.useRef(false);
  const embeddedSessionChat = React.useMemo<EmbeddedSessionChatConfig | null>(() => readEmbeddedSessionChatConfig(), []);
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

  const bootOutcomeKnown = bootInjectionStatus === 'valid';
  const bootViewIsMain = bootView?.screen === 'main';
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

  // Splash dismissal: use the authoritative loading gate from desktopBoot.
  // Desktop shells strictly require a valid boot outcome before dismissing.
  // Non-main outcomes (chooser/recovery) can dismiss without waiting for init.
  React.useEffect(() => {
    if (!canDismissInitialLoading({
      isDesktopShell: isDesktopRuntime,
      runtimeReady: runtimeReady || desktopWorkspaceView === 'catalog-recovery',
      bootOutcomeKnown,
      bootViewIsMain,
    })) {
      return;
    }

    // Held briefly so the mark's entrance is seen rather than skipped. A start fast enough to
    // dismiss instantly reads as a flicker, which looks worse than a moment of waiting.
    const timer = setTimeout(dismissInitialSplash, 150);

    return () => clearTimeout(timer);
  }, [bootOutcomeKnown, bootViewIsMain, desktopWorkspaceView, isDesktopRuntime, runtimeReady]);

  // Deterministic malformed handling: name the failure on the splash so the user sees something
  // specific, but do NOT dismiss it. Only a valid boot outcome dismisses.
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'malformed') {
      return;
    }
    setInitialSplashStatus(t('splash.status.desktopFailed'));
  }, [isDesktopRuntime, bootInjectionStatus, t]);

  // Non-desktop fallback: drop the splash after 5 seconds even if init stalls, so a hung runtime
  // cannot hold the page behind a cover indefinitely.
  React.useEffect(() => {
    if (isDesktopRuntime) {
      return;
    }

    const fallbackTimer = setTimeout(() => {
      if (!runtimeReady) dismissInitialSplash();
    }, 5000);

    return () => clearTimeout(fallbackTimer);
  }, [isDesktopRuntime, runtimeReady]);

  // The splash has no measurable progress, only a sequence of gates, so it names the gate it is
  // waiting on instead of inventing a percentage.
  React.useEffect(() => {
    if (runtimeReady) return;
    if (isDesktopRuntime && !bootOutcomeKnown) {
      setInitialSplashStatus(t('splash.status.startingDesktop'));
      return;
    }
    setInitialSplashStatus(
      catalogLoaded ? t('splash.status.preparingWorkspace') : t('splash.status.connectingRuntime'),
    );
  }, [bootOutcomeKnown, isDesktopRuntime, catalogLoaded, runtimeReady, t]);

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
    if (isDesktopRuntime && !bootView) return;
    const bootSurfaceReady =
      bootView?.screen === 'chooser' || bootView?.screen === 'recovery';
    if (!runtimeReady && !bootSurfaceReady) return;
    if (isSwitchingDirectory) return;
    if (appReadyDispatchedRef.current) return;
    appReadyDispatchedRef.current = true;
    (window as unknown as { __varinAppReady?: boolean }).__varinAppReady = true;
    window.dispatchEvent(new Event('varin:app-ready'));
  }, [bootView, desktopWorkspaceView, isDesktopRuntime, isSwitchingDirectory, runtimeReady]);

  // Session attention now handled by notification-store via SSE events (session.idle/session.error)

  usePushVisibilityBeacon({ enabled: embeddedBackgroundWorkEnabled });
  useWebNotificationStream({ enabled: embeddedBackgroundWorkEnabled });
  usePwaInstallPrompt();

  useWindowTitle();

  useRouter({ enabled: !embeddedSessionChat && catalogLoaded });

  useMenuActions({ enabled: !embeddedSessionChat });

  useTraySync({ enabled: !embeddedSessionChat && catalogLoaded });

  // Poll for the injected boot outcome until it becomes available (desktop only).
  // The Rust backend sets window.__VARIN_DESKTOP_BOOT_OUTCOME__ once the
  // sidecar reaches a stable state. We poll with exponential backoff to handle
  // potential race conditions during startup and config writes.
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'not-injected') {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const BASE_INTERVAL = 200;
    const MAX_INTERVAL = 2000;
    const MAX_ATTEMPTS = 50; // 10 seconds total (200ms * 50 with exponential backoff cap)

    const pollWithBackoff = () => {
      if (cancelled) return;

      attempts++;
      const status = getBootInjectionStatus();

      if (status !== 'not-injected') {
        cancelled = true;
        setBootInjectionStatus(status);

        if (status === 'valid') {
          const outcome = getInjectedBootOutcome();
          if (outcome) {
            setBootView(resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome }));
          }
        }
        // If status is 'malformed', we keep the splash visible with error text
        // handled by the separate useEffect below
        return;
      }

      // Exponential backoff with cap
      const nextInterval = Math.min(BASE_INTERVAL * Math.pow(1.1, attempts), MAX_INTERVAL);

      if (attempts >= MAX_ATTEMPTS) {
        // Max attempts reached: keep polling, but say so on the splash rather than leaving the user
        // in front of a cover with no explanation.
        setInitialSplashStatus(t('splash.status.desktopSlow'));
      }

      window.setTimeout(pollWithBackoff, nextInterval);
    };

    // Start polling
    window.setTimeout(pollWithBackoff, BASE_INTERVAL);

    return () => {
      cancelled = true;
    };
  }, [isDesktopRuntime, bootInjectionStatus, t]);

  const handleDesktopBootDismiss = React.useCallback(async () => {
    if (shouldRestartDesktopBootFlow({
      isDesktopShell: isDesktopShell(),
      isDesktopLocalOriginActive: isDesktopLocalOriginActive(),
    })) {
      await restartDesktopApp();
      return;
    }

    window.location.reload();
  }, []);

  const handleRuntimeAvailable = React.useCallback(async () => {
    try {
      await useThreadStore.getState().loadCatalog();
    } catch (catalogError) {
      console.warn('[Varin] failed to load the Thread catalog after connecting to a Host:', catalogError);
    }
    setBootView((current) => current?.screen === 'main' ? current : { screen: 'main' });
  }, []);

  const renderDesktopOnboarding = (screen: React.ReactNode) => (
    <ErrorBoundary>
      <RuntimeAPIProvider apis={apis}>
        <div className="h-full text-foreground bg-background">
          <React.Suspense fallback={<div className="h-full" />}>
            {screen}
          </React.Suspense>
        </div>
      </RuntimeAPIProvider>
    </ErrorBoundary>
  );

  // Map boot outcome kind to recovery variant
  const mapBootViewToRecoveryVariant = (view: DesktopBootView): RecoveryVariant | undefined => {
    if (view.screen === 'recovery') {
      return view.variant;
    }
    return undefined;
  };

  // Desktop boot view routing.
  // When the boot outcome resolves to a non-main screen (chooser, recovery),
  // render OnboardingScreen with appropriate mode/variant.
  if (isDesktopRuntime && bootView && bootView.screen !== 'main') {
    // First-launch chooser
    if (bootView.screen === 'chooser') {
      return renderDesktopOnboarding(
        <OnboardingScreen
          mode="first-launch"
          localAvailable={bootView.localAvailable !== false}
          onRuntimeAvailable={handleRuntimeAvailable}
        />,
      );
    }

    // Recovery screens
    const recoveryVariant = mapBootViewToRecoveryVariant(bootView);
    const hostUrl = bootView.screen === 'recovery' && 'url' in bootView ? bootView.url : undefined;

    return renderDesktopOnboarding(
      <OnboardingScreen
        mode="recovery"
        recoveryVariant={recoveryVariant}
        recoveryHostUrl={hostUrl}
        recoveryHostLabel={undefined}
        localAvailable={bootView.localAvailable !== false}
        onRuntimeAvailable={handleDesktopBootDismiss}
      />,
    );
  }

  if (embeddedSessionChat) {
    return (
      <ErrorBoundary>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full text-foreground bg-background">
              <EmbeddedSessionChatContent
                embeddedSessionChat={embeddedSessionChat}
                embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled}
              />
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
      <ErrorBoundary>
        <RuntimeInitializationRecovery
          onRetry={() => { void useThreadStore.getState().loadCatalog(); }}
          isRetrying={catalogLoading}
        />
      </ErrorBoundary>
    );
  }

  const isBootShell = !catalogLoaded && !isDesktopRuntime;

  return (
    <ErrorBoundary>
      <RuntimeAPIProvider apis={apis}>
        <FireworksProvider>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className={isDesktopRuntime ? 'h-full text-foreground bg-transparent' : 'h-full text-foreground bg-background'}>
              {catalogLoaded && <ThreadAppEffects />}
              <AgentEditorCoordinator />
              <RunDebugCoordinator />
              <WorkbenchProfileBridge />
              <WorkbenchShellHost />
              <Toaster />
              <WorkspaceEditReviewDialog />
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
