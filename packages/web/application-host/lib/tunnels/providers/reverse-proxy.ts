import {
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_MODE_REVERSE_PROXY,
  TUNNEL_PROVIDER_REVERSE_PROXY,
  TunnelServiceError,
  normalizeReverseProxyConfiguration,
  type ReverseProxyConfiguration,
  type TunnelController,
  type TunnelProvider,
} from '../types.js';

export interface ReverseProxyIngress {
  /** Actual bound backend, supplied by the Host's guarded public listener. */
  originUrl: string;
  setEnabled(enabled: boolean): void;
  close(): void | Promise<void>;
}

export interface ReverseProxyProviderDependencies {
  /** Opens an initially disabled, guarded listener, never the trusted local listener. */
  openPublicIngress(configuration: ReverseProxyConfiguration): Promise<ReverseProxyIngress>;
}

/**
 * An adapter for an independently managed HTTPS proxy. It does not install,
 * configure, or probe that proxy. The Host supplies the only listener owner.
 * Not registered by default until settings/auth/status wiring is complete.
 */
export function createReverseProxyTunnelProvider(dependencies: ReverseProxyProviderDependencies): TunnelProvider {
  const controllers = new WeakMap<TunnelController, { publicOrigin: string; originUrl: string }>();
  return {
    id: TUNNEL_PROVIDER_REVERSE_PROXY,
    capabilities: {
      provider: TUNNEL_PROVIDER_REVERSE_PROXY,
      defaults: { mode: TUNNEL_MODE_REVERSE_PROXY },
      modes: [{
        key: TUNNEL_MODE_REVERSE_PROXY,
        intent: TUNNEL_INTENT_PERSISTENT_PUBLIC,
        label: 'Existing reverse proxy',
        requires: ['reverseProxy'],
        supports: ['customDomain'],
        stability: 'experimental',
      }],
    },
    checkAvailability: async () => ({ available: true }),
    start: async (request) => {
      if (request.provider !== TUNNEL_PROVIDER_REVERSE_PROXY || request.mode !== TUNNEL_MODE_REVERSE_PROXY) {
        throw new TunnelServiceError('mode_unsupported', 'Reverse proxy requires its own provider and mode');
      }
      const configuration = normalizeReverseProxyConfiguration(request.reverseProxy);
      const ingress = await dependencies.openPublicIngress(configuration);
      try {
        const backend = new URL(ingress.originUrl);
        if (backend.protocol !== 'http:' || backend.username || backend.password
          || backend.pathname !== '/' || backend.search || backend.hash
          || Number(backend.port || 80) !== configuration.backend.port) {
          throw new TunnelServiceError('startup_failed', 'Guarded listener did not bind the configured backend port');
        }
        ingress.setEnabled(true);
      } catch (error) {
        try { ingress.setEnabled(false); } finally { await ingress.close(); }
        throw error;
      }

      let stopped = false;
      let closing: Promise<void> | undefined;
      const controller: TunnelController = {
        provider: TUNNEL_PROVIDER_REVERSE_PROXY,
        mode: TUNNEL_MODE_REVERSE_PROXY,
        getPublicUrl: () => stopped ? null : configuration.publicOrigin,
        // Binding locally says nothing about DNS, TLS, or the external proxy.
        getEndpointVerification: () => 'unverified',
        stop: () => {
          if (closing) return closing;
          stopped = true;
          // Disable before returning, including when asynchronous close fails.
          try {
            ingress.setEnabled(false);
          } finally {
            closing = Promise.resolve().then(() => ingress.close());
          }
          return closing;
        },
      };
      controllers.set(controller, { publicOrigin: configuration.publicOrigin, originUrl: ingress.originUrl });
      return controller;
    },
    stop: (controller) => controllers.has(controller) ? controller.stop?.() : undefined,
    resolvePublicUrl: (controller) => controller && controllers.has(controller) ? controller.getPublicUrl?.() ?? null : null,
    getMetadata: (controller) => {
      const configuration = controller ? controllers.get(controller) : undefined;
      return configuration ? { ...configuration, endpointVerification: 'unverified' } : null;
    },
  };
}
