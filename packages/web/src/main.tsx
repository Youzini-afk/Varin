import { createConfiguredWebAPIs, getDesktopRelayRestoreReady } from './runtimeConfig';
import { registerSW } from 'virtual:pwa-register';

import type { RuntimeAPIs } from '@varin/application-client';
import { getStoredMobileLayoutPreference } from '@varin/ui/lib/mobileLayoutPreference';
import { getBootstrapMessages, readStoredLocaleForBootstrap } from '@varin/ui/lib/i18n/bootstrap';
import { setInitialSplashStatus } from '@varin/ui/lib/splash';
import type { HostedSurface } from '@varin/ui/lib/runtimeSurface';
import {
  isEmbeddedSessionChat,
  requestEmbeddedSessionRuntimeBootstrap,
} from '@varin/ui/components/layout/contextPanelEmbeddedChat';
import '@varin/ui/styles/application';
import '@varin/ui/styles/fonts';

import { detectHostedSurface } from './hostedSurface';

declare global {
  interface Window {
    __VARIN_RUNTIME_APIS__?: RuntimeAPIs;
    __VARIN_SURFACE__?: HostedSurface;
  }
}

const isCoarsePointer = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }

  return window.matchMedia('(pointer: coarse)').matches;
};

const hostedSurface = detectHostedSurface({
  search: window.location.search,
  desktopShell: window.__VARIN_ELECTRON__?.runtime === 'electron',
  innerWidth: window.innerWidth || 0,
  screenWidth: window.screen?.width || window.innerWidth || 0,
  maxTouchPoints: navigator.maxTouchPoints || 0,
  isCoarsePointer: isCoarsePointer(),
  mobileLayoutPreference: getStoredMobileLayoutPreference(),
});
window.__VARIN_SURFACE__ = hostedSurface;

type PrerenderingDocument = Document & {
  prerendering?: boolean;
};

const canUseServiceWorker = (): boolean => {
  if (!('serviceWorker' in navigator)) return false;
  if (!window.isSecureContext) return false;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return false;

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    return false;
  }

  return true;
};

const runWhenDocumentCanRegisterServiceWorker = (task: () => void): void => {
  let completed = false;
  const run = () => {
    if (completed) return;
    if (canUseServiceWorker()) {
      completed = true;
      task();
    }
  };

  const afterLoad = () => {
    setTimeout(run, 0);
  };

  if (document.readyState === 'complete') {
    afterLoad();
  } else {
    window.addEventListener('load', afterLoad, { once: true });
  }

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    document.addEventListener('visibilitychange', run, { once: true });
  }
};

const registerPwaServiceWorker = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    try {
      registerSW({
        onRegisterError(error: unknown) {
          console.warn('[PWA] service worker registration skipped:', error);
        },
      });
    } catch (error) {
      console.warn('[PWA] service worker registration skipped:', error);
    }
  });
};

const unregisterDevelopmentServiceWorkers = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
  });
};

const start = async (): Promise<void> => {
  const embeddedBootstrap = isEmbeddedSessionChat()
    ? await requestEmbeddedSessionRuntimeBootstrap()
    : null;
  window.__VARIN_RUNTIME_APIS__ = createConfiguredWebAPIs(embeddedBootstrap);

  if (hostedSurface === 'mobile') {
    const { registerWorkbenchShells } = await import('@varin/ui/workbenches/register-shells');
    await registerWorkbenchShells('mobile');
    const { renderMobileApp } = await import('@varin/ui/apps/renderMobileApp');
    renderMobileApp(window.__VARIN_RUNTIME_APIS__);
    void import('@varin/ui/lib/extensions/managed-runtime').then(({ startSurfaceExtensions }) => (
      startSurfaceExtensions()
    )).catch((error) => {
      console.error('[Varin Extensions] Managed Surface startup failed:', error);
    });
    return;
  }

  // Parse and compile the UI while the desktop relay transport is being
  // restored. Rendering still waits for the selected transport, so the auth
  // gate never probes a transient endpoint, but network/JS work no longer runs
  // serially behind a direct-address probe or relay handshake.
  const [, { renderApplication }] = await Promise.all([getDesktopRelayRestoreReady(), import('@varin/ui/main')]);
  renderApplication(window.__VARIN_RUNTIME_APIS__);
};

void start().catch(error => {
  console.error('[Varin] Application startup failed:', error);
  const messages = getBootstrapMessages(readStoredLocaleForBootstrap());
  setInitialSplashStatus(`${messages.startupFailed} ${error instanceof Error ? error.message : String(error)}`);
});

if (import.meta.hot) {
  import.meta.hot.on('varin:theme-updated', (theme: unknown) => {
    window.dispatchEvent(new CustomEvent('varin:theme-hmr', { detail: theme }));
  });
}

if (import.meta.env.PROD) {
  registerPwaServiceWorker();
} else {
  unregisterDevelopmentServiceWorkers();
}
