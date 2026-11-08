import { getRuntimeExtraHeadersSync, refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, setLocalRuntimeAuthCredentialProvider, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@varin/application-client';
import { installRuntimeFetchBridge } from '@varin/application-client';
import { initializeRuntimeEndpoint, switchRuntimeEndpoint } from '@varin/application-client';
import { restoreDesktopRelayRuntime } from '@varin/ui/lib/desktopRelayRestore';
import { desktopLocalClientTokenGet } from '@varin/ui/lib/desktopHosts';
import { configureRuntimeUrlResolver } from '@varin/application-client';
import { registerRelayTransport } from '@varin/ui/lib/relay/register-transport';
import type { EmbeddedSessionRuntimeBootstrap } from '@varin/ui/components/layout/contextPanelEmbeddedChat';
import { createWebAPIs } from './api';

// Register the UI's relay tunnel implementation with the application-client
// transport layer. Must happen before any runtime endpoint switch.
registerRelayTransport();

const sameOrigin = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

declare global {
  interface Window {
    __VARIN_API_BASE_URL__?: string;
    __VARIN_CLIENT_TOKEN__?: string;
    __VARIN_RUNTIME_HEADERS__?: Record<string, string>;
    __VARIN_LOCAL_ORIGIN__?: string;
    __VARIN_RELAY_HOST_ID__?: string;
  }
}

export const readRuntimeBootstrapConfig = (): EmbeddedSessionRuntimeBootstrap => {
  const readString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

  return {
    apiBaseUrl: readString(window.__VARIN_API_BASE_URL__),
    clientToken: readString(window.__VARIN_CLIENT_TOKEN__),
    localOrigin: readString(window.__VARIN_LOCAL_ORIGIN__),
    runtimeHeaders: window.__VARIN_RUNTIME_HEADERS__,
    relayHostId: readString(window.__VARIN_RELAY_HOST_ID__),
  };
};

// Resolved once the desktop relay-host restore (if any) has picked a transport.
// Immediately-resolved everywhere else. See createConfiguredWebAPIs.
let desktopRelayRestoreReady: Promise<void> = Promise.resolve();
export const getDesktopRelayRestoreReady = (): Promise<void> => desktopRelayRestoreReady;

export const createConfiguredWebAPIs = (bootstrap?: EmbeddedSessionRuntimeBootstrap | null) => {
  const { apiBaseUrl, clientToken, localOrigin, runtimeHeaders, relayHostId, relay } = bootstrap ?? readRuntimeBootstrapConfig();

  const urls = configureRuntimeUrlResolver({
    apiBaseUrl: apiBaseUrl || undefined,
    realtimeBaseUrl: apiBaseUrl || undefined,
  });
  initializeRuntimeEndpoint({
    apiBaseUrl,
    runtimeKey: sameOrigin(apiBaseUrl, localOrigin) ? 'local' : null,
  });
  setRuntimeBearerToken(clientToken || null);
  setRuntimeExtraHeaders(runtimeHeaders || null);
  setLocalRuntimeAuthCredentialProvider(localOrigin || null, localOrigin ? async () => {
    const token = await desktopLocalClientTokenGet();
    return token ? { type: 'bearer', token } : null;
  } : null);
  if (relay) {
    switchRuntimeEndpoint({
      apiBaseUrl,
      clientToken: clientToken || null,
      requestHeaders: runtimeHeaders || null,
      runtimeKey: relayHostId ? `host:${relayHostId}` : null,
      relay,
    });
  }
  void refreshRuntimeUrlAuthToken(apiBaseUrl || undefined).catch(() => {});
  if (localOrigin && !sameOrigin(apiBaseUrl, localOrigin) && Object.keys(getRuntimeExtraHeadersSync()).length > 0) {
    void refreshLocalRuntimeUrlAuthToken(localOrigin).catch(() => {});
  }
  installRuntimeFetchBridge();
  // Desktop only: reconnect a relay-capable host now that the fetch bridge is
  // installed — either the host this window was opened for (injected id) or the
  // default host on relaunch. No-op elsewhere; resolves in milliseconds when no
  // relay host is involved. main.tsx holds the app render on this promise so
  // the user sees the splash instead of a transient auth screen against an
  // endpoint that is still being selected.
  desktopRelayRestoreReady = relay
    ? Promise.resolve()
    : Promise.race([
        restoreDesktopRelayRuntime(relayHostId || undefined).catch(() => {}),
        // Never hold the app hostage: a stuck probe/tunnel gives up to the UI.
        new Promise<void>((resolve) => { window.setTimeout(resolve, 10_000); }),
      ]);
  return createWebAPIs({ urls });
};
