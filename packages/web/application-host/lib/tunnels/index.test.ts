import { describe, expect, it } from 'vitest';

import { createTunnelService } from './index.js';
import {
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_MODE_QUICK,
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_NGROK,
  TunnelServiceError,
  type TunnelController,
  type TunnelProvider,
  type TunnelProviderId,
} from './types.js';

const createProvider = ({
  provider,
  start,
  stop = (controller) => controller.stop?.(),
  resolvePublicUrl = (controller) => controller?.getPublicUrl?.() ?? null,
}: {
  provider: TunnelProviderId;
  resolvePublicUrl?: TunnelProvider['resolvePublicUrl'] | undefined;
  start: TunnelProvider['start'];
  stop?: TunnelProvider['stop'] | undefined;
}): TunnelProvider => ({
  id: provider,
  capabilities: {
    provider,
    modes: [{ key: TUNNEL_MODE_QUICK, intent: TUNNEL_INTENT_EPHEMERAL_PUBLIC }],
  },
  checkAvailability: async () => ({ available: true }),
  start,
  stop,
  resolvePublicUrl,
});

const createRegistry = (providers: Partial<Record<TunnelProviderId, TunnelProvider>>) => ({
  get: (providerId: unknown) => typeof providerId === 'string'
    ? providers[providerId as TunnelProviderId] ?? null
    : null,
});

describe('createTunnelService', () => {
  it('uses the Host-supplied backend context rather than start options', async () => {
    let controller: TunnelController | null = null;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async (_request, context) => {
        expect(context.activePort).toBe(3903);
        expect(context.originUrl).toBe('http://127.0.0.1:3903');
        return { mode: TUNNEL_MODE_QUICK, getPublicUrl: () => 'https://example.test', getEndpointVerification: () => 'unverified' };
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
      getStartContext: async () => ({ activePort: 3903, originUrl: 'http://127.0.0.1:3903' }),
    });
    const started = await service.start({}, { activePort: 3000, originUrl: 'http://127.0.0.1:3000' });
    expect(started.endpointVerification).toBe('unverified');
    expect(service.getEndpointVerification()).toBe('unverified');
    service.stop();
    expect(service.getEndpointVerification()).toBeNull();
  });

  it('preserves the legacy loopback backend when no public listener owner is injected', async () => {
    let controller: TunnelController | null = null;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async (_request, context) => {
        expect(context).toMatchObject({ activePort: 3000, originUrl: 'http://127.0.0.1:3000' });
        return { mode: TUNNEL_MODE_QUICK, getPublicUrl: () => 'https://example.test' };
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });
    expect((await service.start({})).endpointVerification).toBeNull();
  });

  it('does not resurrect an option origin when the Host context omits it', async () => {
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async (_request, context) => {
        expect(context.originUrl).toBeUndefined();
        throw new Error('No guarded backend is available');
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_CLOUDFLARE]: provider }),
      getController: () => null, setController: () => undefined,
      getActivePort: () => 3000, getStartContext: () => ({ activePort: null }),
    });
    await expect(service.start({}, { originUrl: 'http://127.0.0.1:3000' })).rejects.toThrow('No guarded backend is available');
  });

  it('rejects an explicit unknown provider without touching the active controller', async () => {
    const controller: TunnelController = { provider: TUNNEL_PROVIDER_CLOUDFLARE, getPublicUrl: () => 'https://existing.test' };
    const service = createTunnelService({
      registry: createRegistry({}), getController: () => controller,
      setController: () => { throw new Error('must not replace controller'); }, getActivePort: () => 3000,
    });
    await expect(service.start({ provider: 'typo' })).rejects.toThrow('Unsupported tunnel provider');
  });

  it('returns provider startup errors to route callers', async () => {
    let controller: TunnelController | null = null;
    const provider = createProvider({
      provider: TUNNEL_PROVIDER_NGROK,
      start: async () => {
        throw new Error('ngrok authtoken is not configured');
      },
    });
    const service = createTunnelService({
      registry: createRegistry({ [TUNNEL_PROVIDER_NGROK]: provider }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    try {
      await service.start({ provider: TUNNEL_PROVIDER_NGROK, mode: TUNNEL_MODE_QUICK });
      throw new Error('Expected service.start to fail');
    } catch (error) {
      if (!(error instanceof TunnelServiceError)) throw error;
      expect(error.name).toBe('TunnelServiceError');
      expect(error.code).toBe('startup_failed');
      expect(error.message).toBe('ngrok authtoken is not configured');
    }
  });

  it('replaces an active quick tunnel when the provider changes', async () => {
    let stopped = false;
    let ngrokStarted = false;
    const initialController: TunnelController = {
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      mode: TUNNEL_MODE_QUICK,
      stop: () => { stopped = true; },
      getPublicUrl: () => 'https://cloudflare.example',
    };
    let controller: TunnelController | null = initialController;
    const cloudflareProvider = createProvider({
      provider: TUNNEL_PROVIDER_CLOUDFLARE,
      start: async () => initialController,
    });
    const ngrokProvider = createProvider({
      provider: TUNNEL_PROVIDER_NGROK,
      resolvePublicUrl: (candidate) => candidate?.provider === TUNNEL_PROVIDER_NGROK ? candidate.getPublicUrl?.() ?? null : null,
      start: async () => {
        ngrokStarted = true;
        return {
          mode: TUNNEL_MODE_QUICK,
          getPublicUrl: () => 'https://demo.ngrok-free.app',
        };
      },
    });
    const service = createTunnelService({
      registry: createRegistry({
        [TUNNEL_PROVIDER_CLOUDFLARE]: cloudflareProvider,
        [TUNNEL_PROVIDER_NGROK]: ngrokProvider,
      }),
      getController: () => controller,
      setController: (next) => { controller = next; },
      getActivePort: () => 3000,
    });

    const result = await service.start({ provider: TUNNEL_PROVIDER_NGROK, mode: TUNNEL_MODE_QUICK });

    expect(stopped).toBe(true);
    expect(ngrokStarted).toBe(true);
    expect(result.provider).toBe(TUNNEL_PROVIDER_NGROK);
    expect(result.publicUrl).toBe('https://demo.ngrok-free.app');
  });
});
