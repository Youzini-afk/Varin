import { getRuntimeExtraHeadersSync, refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, setLocalRuntimeAuthCredentialProvider, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@varin/application-client';
import { installRuntimeFetchBridge } from '@varin/application-client';
import { getRuntimeKey, getRuntimeEndpointGeneration, runtimeFetch, initializeRuntimeEndpoint, switchRuntimeEndpoint } from '@varin/application-client';
import { setVerifiedRelayBootHost } from '@varin/ui/lib/desktopBoot';
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

  const relayHostId = readString(window.__VARIN_RELAY_HOST_ID__);
  return {
    apiBaseUrl: relayHostId ? '' : readString(window.__VARIN_API_BASE_URL__),
    clientToken: relayHostId ? '' : readString(window.__VARIN_CLIENT_TOKEN__),
    localOrigin: readString(window.__VARIN_LOCAL_ORIGIN__),
    runtimeHeaders: relayHostId ? undefined : window.__VARIN_RUNTIME_HEADERS__,
    relayHostId,
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
  const bundledWithoutHost = !apiBaseUrl && window.location.protocol === 'varin-ui:';
  if (!bundledWithoutHost && !relayHostId && !relay) void refreshRuntimeUrlAuthToken(apiBaseUrl || undefined).catch(() => {});
  if (localOrigin && !sameOrigin(apiBaseUrl, localOrigin) && Object.keys(getRuntimeExtraHeadersSync()).length > 0) {
    void refreshLocalRuntimeUrlAuthToken(localOrigin).catch(() => {});
  }
  installRuntimeFetchBridge();
  // The shell chose this window's profile. Looking up the default here would
  // redirect other windows (or an explicit direct URL) to an unrelated relay.
  setVerifiedRelayBootHost(null);
  if (!relayHostId || relay) {
    desktopRelayRestoreReady = Promise.resolve();
    return createWebAPIs({ urls });
  }
  const restore = async () => {
    await restoreDesktopRelayRuntime(relayHostId);
    if (getRuntimeKey() !== `host:${relayHostId}`) return null;
    const generation = getRuntimeEndpointGeneration();
    // Selecting the transport is not proof that the tunnel reached its Host.
    // Use the active pinned transport; never make an HTTP request to relay://.
    const response = await runtimeFetch('/auth/session', { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
    const authenticated = response.ok && (await response.json())?.authenticated === true;
    const stillSelected = () => getRuntimeEndpointGeneration() === generation && getRuntimeKey() === `host:${relayHostId}`;
    return authenticated && stillSelected() ? { id: relayHostId, stillSelected } : null;
  };
  desktopRelayRestoreReady = Promise.race([
    restore().catch(() => null),
    // A late result must not resurrect a timed-out/unavailable startup selection.
    new Promise<null>((resolve) => { window.setTimeout(() => resolve(null), 10_000); }),
  ]).then(setVerifiedRelayBootHost);
  return createWebAPIs({ urls });
};
