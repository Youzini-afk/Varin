import {
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TunnelServiceError,
  normalizeTunnelStartRequest,
  validateTunnelStartRequest,
  type TunnelAvailability,
  type TunnelController,
  type TunnelMode,
  type TunnelProviderId,
  type TunnelStartContext,
  type TunnelStartRequest,
} from './types.js';
import { getTunnelDependencyInstallInfo } from './install-help.js';
import type { TunnelProviderRegistry } from './registry.js';

export interface TunnelServiceDependencies {
  getActivePort(): number | null;
  getController(): TunnelController | null;
  // Supplied only by Host wiring, never copied from an HTTP request body.
  getStartContext?(request: TunnelStartRequest): TunnelStartContext | Promise<TunnelStartContext>;
  onQuickTunnelWarning?: (() => void) | undefined;
  reserveStart?: (() => () => void) | undefined;
  registry: Pick<TunnelProviderRegistry, 'get'>;
  setController(controller: TunnelController | null): void;
}

export function createTunnelService({
  registry,
  getController,
  setController,
  getActivePort,
  getStartContext,
  onQuickTunnelWarning,
  reserveStart,
}: TunnelServiceDependencies) {
  if (!registry) {
    throw new Error('Tunnel service requires a provider registry');
  }

  const resolveActiveMode = (): TunnelMode | null => {
    const controller = getController();
    if (!controller || typeof controller.mode !== 'string') {
      return null;
    }
    return controller.mode as TunnelMode;
  };

  const resolveActiveProvider = (): TunnelProviderId | null => {
    const controller = getController();
    if (!controller || typeof controller.provider !== 'string') {
      return null;
    }
    return controller.provider as TunnelProviderId;
  };

  const stop = (): boolean => {
    const controller = getController();
    if (!controller) {
      return false;
    }

    const providerId = typeof controller.provider === 'string' ? controller.provider : '';
    const provider = providerId ? registry.get(providerId) : null;
    if (provider?.stop) {
      provider.stop(controller);
    } else {
      controller.stop?.();
    }
    setController(null);
    return true;
  };

  const checkAvailability = async (providerId: unknown): Promise<TunnelAvailability> => {
    const provider = registry.get(providerId);
    if (!provider) {
      throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${providerId}`);
    }
    const result = await provider.checkAvailability();
    return result;
  };

  // Mutex to prevent concurrent tunnel starts from orphaning child processes.
  let startLock: Promise<void> = Promise.resolve();

  const start = async (rawRequest: Record<string, unknown>, options: Record<string, unknown> = {}) => {
    const releaseReservation = reserveStart?.();
    let releaseLock: () => void = () => undefined;
    const lockPromise = new Promise<void>((resolve) => { releaseLock = resolve; });
    const previousLock = startLock;
    startLock = lockPromise;

    await previousLock;

    try {
      const request = normalizeTunnelStartRequest(rawRequest);
      const provider = registry.get(request.provider);

      if (!provider) {
        throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${request.provider}`);
      }

      validateTunnelStartRequest(request, provider.capabilities);

      // Resolve through the current owner. A provider must not interpret a
      // different provider's controller when deciding whether to replace it.
      let publicUrl = getPublicUrl();
      const activeMode = resolveActiveMode();
      const activeProvider = resolveActiveProvider();

      if (publicUrl && (activeMode !== request.mode || activeProvider !== request.provider)) {
        stop();
        publicUrl = null;
      }

      if (!publicUrl) {
        const availability = await provider.checkAvailability();
        if (!availability?.available) {
          const missingDependencyMessage = typeof availability?.message === 'string' && availability.message.trim().length > 0
            ? availability.message
            : (request.provider === TUNNEL_PROVIDER_CLOUDFLARE
              ? getTunnelDependencyInstallInfo(TUNNEL_PROVIDER_CLOUDFLARE).message
              : `Required dependency for provider '${request.provider}' is missing`);
          throw new TunnelServiceError('missing_dependency', missingDependencyMessage);
        }

        const observedPort = getActivePort();
        const activePort = typeof observedPort === 'number' && Number.isFinite(observedPort) ? observedPort : null;
        const originUrl = activePort !== null ? `http://127.0.0.1:${activePort}` : undefined;

        let controller: TunnelController;
        try {
          const context = getStartContext
            ? { ...options, originUrl: undefined, ...await getStartContext(request) }
            : { activePort, originUrl, ...options };
          controller = await provider.start(request, context);
        } catch (error) {
          if (error instanceof TunnelServiceError) {
            throw error;
          }
          const message = error instanceof Error && error.message.trim().length > 0
            ? error.message
            : 'Failed to start tunnel';
          throw new TunnelServiceError('startup_failed', message);
        }
        controller.provider = request.provider;
        setController(controller);

        publicUrl = provider.resolvePublicUrl(controller);
        if (!publicUrl) {
          stop();
          throw new TunnelServiceError('startup_failed', 'Tunnel started but no public URL was assigned');
        }

        if (request.mode === TUNNEL_MODE_QUICK) {
          onQuickTunnelWarning?.();
        }
      }

      return {
        publicUrl,
        request,
        activeMode: request.mode,
        provider: request.provider,
        providerMetadata: provider.getMetadata?.(getController()) ?? null,
        endpointVerification: getController()?.getEndpointVerification?.() ?? null,
      };
    } finally {
      releaseLock();
      releaseReservation?.();
    }
  };

  const getPublicUrl = (): string | null => {
    const controller = getController();
    if (!controller) {
      return null;
    }
    const provider = registry.get(controller.provider);
    if (!provider) {
      return controller.getPublicUrl?.() ?? null;
    }
    return provider.resolvePublicUrl(controller);
  };

  const getProviderMetadata = (): unknown => {
    const controller = getController();
    if (!controller) {
      return null;
    }
    const provider = registry.get(controller.provider);
    return provider?.getMetadata?.(controller) ?? null;
  };

  return {
    start,
    stop,
    checkAvailability,
    getPublicUrl,
    getProviderMetadata,
    getEndpointVerification: () => getController()?.getEndpointVerification?.() ?? null,
    resolveActiveMode,
    resolveActiveProvider,
  };
}
