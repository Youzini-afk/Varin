import { printTunnelWarning } from '../cloudflare-tunnel.js';
import { createTunnelService } from '../tunnels/index.js';
import { createTunnelRoutesRuntime } from '../tunnels/routes.js';
import type { TunnelRoutesDependencies } from '../tunnels/routes.js';
import type { Express } from 'express';

export const createTunnelWiringRuntime = (
  dependencies: Omit<TunnelRoutesDependencies, 'getActivePort' | 'tunnelService'>,
) => {
  const {
    crypto,
    URL,
    tunnelProviderRegistry,
    tunnelAuthController,
    readSettingsFromDisk,
    readManagedRemoteTunnelConfigFromDisk,
    normalizeTunnelProvider,
    normalizeTunnelMode,
    normalizeOptionalPath,
    normalizeManagedRemoteTunnelHostname,
    normalizeTunnelBootstrapTtlMs,
    normalizeTunnelSessionTtlMs,
    isSupportedTunnelMode,
    upsertManagedRemoteTunnelToken,
    resolveManagedRemoteTunnelToken,
    TUNNEL_MODE_QUICK,
    TUNNEL_MODE_MANAGED_LOCAL,
    TUNNEL_MODE_MANAGED_REMOTE,
    TUNNEL_PROVIDER_CLOUDFLARE,
    TunnelServiceError,
    getActiveTunnelController,
    setActiveTunnelController,
    getRuntimeManagedRemoteTunnelHostname,
    setRuntimeManagedRemoteTunnelHostname,
    getRuntimeManagedRemoteTunnelToken,
    setRuntimeManagedRemoteTunnelToken,
  } = dependencies;

  const initialize = (app: Express, initialPort: number, reserveStart?: () => () => void) => {
    let activePort = initialPort;

    const tunnelService = createTunnelService({
      registry: tunnelProviderRegistry,
      getController: getActiveTunnelController,
      setController: setActiveTunnelController,
      getActivePort: () => activePort,
      reserveStart,
      onQuickTunnelWarning: () => {
        printTunnelWarning();
      },
    });

    const tunnelRoutesRuntime = createTunnelRoutesRuntime({
      crypto,
      URL,
      tunnelService,
      tunnelProviderRegistry,
      tunnelAuthController,
      readSettingsFromDisk,
      readManagedRemoteTunnelConfigFromDisk,
      normalizeTunnelProvider,
      normalizeTunnelMode,
      normalizeOptionalPath,
      normalizeManagedRemoteTunnelHostname,
      normalizeTunnelBootstrapTtlMs,
      normalizeTunnelSessionTtlMs,
      isSupportedTunnelMode,
      upsertManagedRemoteTunnelToken,
      resolveManagedRemoteTunnelToken,
      TUNNEL_MODE_QUICK,
      TUNNEL_MODE_MANAGED_LOCAL,
      TUNNEL_MODE_MANAGED_REMOTE,
      TUNNEL_PROVIDER_CLOUDFLARE,
      TunnelServiceError,
      getActivePort: () => activePort,
      getRuntimeManagedRemoteTunnelHostname,
      setRuntimeManagedRemoteTunnelHostname,
      getRuntimeManagedRemoteTunnelToken,
      setRuntimeManagedRemoteTunnelToken,
      getActiveTunnelController,
      setActiveTunnelController,
    });

    tunnelRoutesRuntime.registerRoutes(app);

    return {
      tunnelService,
      startTunnelWithNormalizedRequest: (...args: Parameters<typeof tunnelRoutesRuntime.startTunnelWithNormalizedRequest>) => (
        tunnelRoutesRuntime.startTunnelWithNormalizedRequest(...args)
      ),
      getActivePort: () => activePort,
      setActivePort: (value: number) => {
        activePort = value;
      },
    };
  };

  return {
    initialize,
  };
};
