import { describe, expect, it } from 'vitest';
import { createReverseProxyTunnelProvider } from './reverse-proxy.js';
import { normalizeTunnelStartRequest } from '../types.js';

const request = () => normalizeTunnelStartRequest({
  provider: 'reverse-proxy',
  reverseProxy: { publicOrigin: 'https://varin.example', backend: { port: 3903 } },
});

describe('reverse proxy provider', () => {
  it('uses only the Host listener owner and does not mistake a configured URL for verified HTTPS', async () => {
    const states: boolean[] = [];
    let opened = 0;
    let closed = 0;
    const provider = createReverseProxyTunnelProvider({
      openPublicIngress: async (configuration) => {
        opened += 1;
        expect(configuration).toEqual({ publicOrigin: 'https://varin.example', backend: { host: '127.0.0.1', port: 3903 } });
        return {
          originUrl: 'http://127.0.0.1:3903',
          setEnabled: (enabled) => { states.push(enabled); },
          close: async () => { closed += 1; },
        };
      },
    });
    const controller = await provider.start(request(), { activePort: 3000, originUrl: 'http://127.0.0.1:3000' });
    expect(opened).toBe(1);
    expect(provider.resolvePublicUrl(controller)).toBe('https://varin.example');
    expect(controller.getEndpointVerification?.()).toBe('unverified');
    expect(provider.getMetadata?.(controller)).toEqual({
      publicOrigin: 'https://varin.example', originUrl: 'http://127.0.0.1:3903', endpointVerification: 'unverified',
    });
    const stopped = provider.stop(controller);
    expect(states).toEqual([true, false]);
    expect(provider.resolvePublicUrl(controller)).toBeNull();
    await stopped;
    await provider.stop(controller);
    expect(closed).toBe(1);
  });

  it('closes an incorrectly bound listener without activating it or silently changing the port', async () => {
    const states: boolean[] = [];
    let closed = false;
    const provider = createReverseProxyTunnelProvider({
      openPublicIngress: async () => ({
        originUrl: 'http://127.0.0.1:3904',
        setEnabled: (enabled) => { states.push(enabled); },
        close: () => { closed = true; },
      }),
    });
    await expect(provider.start(request(), { activePort: 3000 })).rejects.toThrow('configured backend port');
    expect(states).toEqual([false]);
    expect(closed).toBe(true);
  });

  it('preserves an owner bind failure instead of returning the declared public URL', async () => {
    const provider = createReverseProxyTunnelProvider({
      openPublicIngress: async () => { throw new Error('EADDRINUSE'); },
    });
    await expect(provider.start(request(), { activePort: 3000 })).rejects.toThrow('EADDRINUSE');
    expect(provider.resolvePublicUrl(null)).toBeNull();
  });

  it('keeps ingress disabled even if close fails, and does not repeat the close operation', async () => {
    const states: boolean[] = [];
    let attempts = 0;
    const provider = createReverseProxyTunnelProvider({
      openPublicIngress: async () => ({
        originUrl: 'http://127.0.0.1:3903',
        setEnabled: (enabled) => { states.push(enabled); },
        close: async () => { attempts += 1; throw new Error('close failed'); },
      }),
    });
    const controller = await provider.start(request(), { activePort: 3000 });
    await expect(provider.stop(controller)).rejects.toThrow('close failed');
    await expect(provider.stop(controller)).rejects.toThrow('close failed');
    expect(states).toEqual([true, false]);
    expect(attempts).toBe(1);
    expect(provider.resolvePublicUrl(controller)).toBeNull();
  });

  it('does not resolve or stop another provider’s controller', async () => {
    let stopped = false;
    const provider = createReverseProxyTunnelProvider({ openPublicIngress: async () => { throw new Error('unused'); } });
    const other = { getPublicUrl: () => 'https://other.example', stop: () => { stopped = true; } };
    expect(provider.resolvePublicUrl(other)).toBeNull();
    expect(provider.getMetadata?.(other)).toBeNull();
    await provider.stop(other);
    expect(stopped).toBe(false);
  });
});
