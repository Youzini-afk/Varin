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
import { usePiSessionStore } from '@/stores/usePiSessionStore';
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
import { PiAppEffects } from '@/apps/PiAppEffects';
import { PiInteractionHost } from '@/components/pi-session/PiInteractionHost';
import { resetAppForRuntimeEndpointChange } from '@/apps/runtimeEndpointReset';
import { subscribeVarinEvents } from '@/lib/varinEvents';
import { invalidateSettingsCache, syncDesktopSettings } from '@/lib/persistence';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { markStartupTrace, startupTraceEnabled } from '@/lib/startupTrace';
import { useChatContentWidth } from '@/hooks/useChatContentWidth';
import { usePiCatalogBootstrap } from '@/hooks/usePiCatalogBootstrap';
import {
  openPiSessionFromNavigation,
  startPiSessionDraftFromNavigation,
} from '@/lib/pi-runtime/sessionNavigation';
import { toast } from '@/components/ui';
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
  const currentSessionId = usePiSessionStore((state) => state.currentSessionId);
  const bootstrapKeyRef = React.useRef<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retryGeneration, retry] = React.useReducer((value: number) => value + 1, 0);

  const expectedDirectory = normalizeEmbeddedSessionDirectory(embeddedSessionChat.directory);

  React.useEffect(() => {
    const bootstrapKey = `${expectedDirectory}\n${embeddedSessionChat.sessionId}`;
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
    void openPiSessionFromNavigation({
      directory: embeddedSessionChat.directory,
      sessionId: embeddedSessionChat.sessionId,
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
    embeddedSessionChat.directory,
    embeddedSessionChat.sessionId,
    expectedDirectory,
    retryGeneration,
  ]);

  const isSessionReady = isEmbeddedSessionChatReady({
    embeddedSessionChat,
    currentSessionId,
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
      <PiAppEffects backgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
      <PiInteractionHost />
      <ChatView readOnly={embeddedSessionChat.readOnly} autoOpenDraft={false} />
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

  const piCatalogLoaded = usePiSessionStore((state) => state.catalogLoaded);
  const piCatalogLoading = usePiSessionStore((state) => state.catalogLoading);
  const piRuntimeError = usePiSessionStore((state) => state.lastError);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const isSwitchingDirectory = useDirectoryStore((state) => state.isSwitchingDirectory);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(true);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
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
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
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

  const runtimeSnapshot = usePiCatalogBootstrap({
    isDesktopRuntime,
    piRuntime: apis.piRuntime,
    runtimeEndpointEpoch,
  });

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
            catalogError: piRuntimeError,
            catalogLoaded: piCatalogLoaded,
            catalogLoading: piCatalogLoading,
            runtimeStatus: runtimeSnapshot?.status ?? null,
          })
        : null,
    [isDesktopRuntime, piCatalogLoaded, piCatalogLoading, piRuntimeError, runtimeSnapshot?.status],
  );
  const runtimeReady = isDesktopRuntime
    ? desktopWorkspaceIsOperable(desktopWorkspaceView ?? 'loading', isSwitchingDirectory)
    : piCatalogLoaded;

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
      piCatalogLoaded ? t('splash.status.preparingWorkspace') : t('splash.status.connectingRuntime'),
    );
  }, [bootOutcomeKnown, isDesktopRuntime, piCatalogLoaded, runtimeReady, t]);

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
      const detail = (event as CustomEvent<{ sessionId?: string; directory?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId) return;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      void openPiSessionFromNavigation({ directory, sessionId }).catch((openError) => {
        toast.error('Failed to open Pi session', {
          description: openError instanceof Error ? openError.message : String(openError),
        });
      });
    };

    window.addEventListener('varin:open-session', handler as EventListener);
    return () => window.removeEventListener('varin:open-session', handler as EventListener);
  }, [embeddedSessionChat]);

  // Native tray/menu "new session" requests carry optional project and cwd
  // hints and open the Pi pending draft. Creation is deferred until first send.
  React.useEffect(() => {
    if (embeddedSessionChat || typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ directory?: string; projectId?: string }>).detail;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      const projectId = typeof detail?.projectId === 'string' && detail.projectId.trim().length > 0
        ? detail.projectId.trim()
        : null;
      void startPiSessionDraftFromNavigation({ directory, projectId }).catch((createError) => {
        toast.error('Failed to create Pi session', {
          description: createError instanceof Error ? createError.message : String(createError),
        });
      });
    };

    window.addEventListener('varin:open-draft-session', handler as EventListener);
    return () => window.removeEventListener('varin:open-draft-session', handler as EventListener);
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    (window as unknown as { __varinStartupDiagnostics?: unknown }).__varinStartupDiagnostics = {
      bootView,
      catalogError: piRuntimeError,
      catalogLoaded: piCatalogLoaded,
      isSwitchingDirectory,
      runtimeReady,
      runtimeSnapshot,
      workspaceView: desktopWorkspaceView,
    };
  }, [
    bootView,
    desktopWorkspaceView,
    isSwitchingDirectory,
    piCatalogLoaded,
    piRuntimeError,
    runtimeReady,
    runtimeSnapshot,
  ]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (isDesktopRuntime && !bootView) return;
    const bootSurfaceReady =
      bootView?.screen === 'chooser' || bootView?.screen === 'recovery';
    if (!runtimeReady && !bootSurfaceReady) return;
    if (isSwitchingDirectory && desktopWorkspaceView !== 'runtime-setup') return;
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

  useRouter({ enabled: !embeddedSessionChat && piCatalogLoaded });

  useMenuActions({ enabled: !embeddedSessionChat });

  useTraySync({ enabled: !embeddedSessionChat && piCatalogLoaded });

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

  const handlePiRuntimeAvailable = React.useCallback(async () => {
    try {
      await usePiSessionStore.getState().loadCatalog();
    } catch (catalogError) {
      console.warn('[Varin] failed to load the Pi session catalog after selecting a runtime:', catalogError);
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
          onRuntimeAvailable={handlePiRuntimeAvailable}
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

  if (isDesktopRuntime && (!bootView || bootView.screen === 'main') && desktopWorkspaceView === 'runtime-setup') {
    return renderDesktopOnboarding(
      <OnboardingScreen
        mode="local-setup"
        onRuntimeAvailable={handlePiRuntimeAvailable}
      />,
    );
  }

  if (
    (!embeddedSessionChat && !isDesktopRuntime && !piCatalogLoaded && piRuntimeError)
    || desktopWorkspaceView === 'catalog-recovery'
  ) {
    return (
      <ErrorBoundary>
        <RuntimeInitializationRecovery
          onRetry={() => { void usePiSessionStore.getState().loadCatalog(); }}
          isRetrying={piCatalogLoading}
        />
      </ErrorBoundary>
    );
  }

  const isBootShell = !piCatalogLoaded && !isDesktopRuntime;

  return (
    <ErrorBoundary>
      <RuntimeAPIProvider apis={apis}>
        <FireworksProvider>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className={isDesktopRuntime ? 'h-full text-foreground bg-transparent' : 'h-full text-foreground bg-background'}>
              {piCatalogLoaded && <PiAppEffects backgroundWorkEnabled={embeddedBackgroundWorkEnabled} />}
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
