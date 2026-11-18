import { describe, expect, test, vi } from 'vitest';
import { desktopHostProbe, desktopHostsGet, desktopHostsSet, importDesktopHostPairing, redactSensitiveUrl, resolveDesktopHostUrl } from './desktopHosts';

import { buildPairingConnectionPayload, encodePairingConnectionPayload } from './connectionPayload';
const relay = vi.hoisted(() => ({ create: vi.fn(), fetch: vi.fn(), close: vi.fn() }));
vi.mock('./relay/tunnel-client', () => ({ createRelayTunnelClient: relay.create }));

const withDesktopBridge = async <T>(handler: (cmd: string, args: Record<string, unknown>) => unknown | Promise<unknown>, run: () => Promise<T>): Promise<T> => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __VARIN_DESKTOP__: {
        invoke: handler,
      },
    },
  });
  try {
    return await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

describe('resolveDesktopHostUrl', () => {
  test('keeps regular host URLs unchanged', () => {
    expect(resolveDesktopHostUrl('https://example.com/app?x=1')).toEqual({
      persistedUrl: 'https://example.com/app?x=1',
      redeemUrl: null,
      kind: 'normal-host',
    });
  });

  test('detects tunnel connect links and stores only origin', () => {
    expect(resolveDesktopHostUrl('https://example.trycloudflare.com/connect?t=secret-token')).toEqual({
      persistedUrl: 'https://example.trycloudflare.com',
      redeemUrl: 'https://example.trycloudflare.com/connect?t=secret-token',
      kind: 'tunnel-connect-link',
    });
  });

  test('detects tunnel connect links with trailing slash', () => {
    expect(resolveDesktopHostUrl('https://example.trycloudflare.com/connect/?t=secret-token#section')).toEqual({
      persistedUrl: 'https://example.trycloudflare.com',
      redeemUrl: 'https://example.trycloudflare.com/connect/?t=secret-token',
      kind: 'tunnel-connect-link',
    });
  });

  test('redacts tunnel tokens from labels', () => {
    expect(redactSensitiveUrl('https://example.trycloudflare.com/connect?t=secret-token')).toBe(
      'https://example.trycloudflare.com/connect?t=%5BREDACTED%5D',
    );
  });
});

describe('importDesktopHostPairing', () => {
  test.each(['direct', 'relay'] as const)('redeems once on the available %s transport and retains both legs without the pairing secret', async available => {
    const pinned = { relayUrl: 'wss://relay.invalid/', serverId: 'paired-server', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } };
    const direct = 'https://host.invalid';
    const link = encodePairingConnectionPayload(buildPairingConnectionPayload({
      pairingId: 'pair', secret: 'one-time-secret', label: 'Cloud', candidates: [
        { type: 'relay', ...pinned, grant: 'one-time-grant' }, { type: 'lan', url: direct },
      ],
    }));
    const accept = () => Response.json({ clientToken: 'issued-token' });
    const http = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      if (available === 'relay') throw new Error('LAN unavailable');
      return accept();
    });
    relay.create.mockClear().mockReturnValue({ fetch: relay.fetch, close: relay.close });
    relay.fetch.mockClear().mockImplementation(async () => accept());
    relay.close.mockClear();
    try {
      await withDesktopBridge(async cmd => { expect(cmd).toBe('desktop_install_id_get'); return 'install-id'; }, async () => {
        const existing = { id: 'cloud', label: 'Old', url: 'relay://paired-server', relay: pinned };
        const imported = await importDesktopHostPairing(link, [existing]);
        expect(imported).toEqual({ hostId: 'cloud', hosts: [{ ...existing, label: 'Cloud', url: direct, apiUrl: direct, clientToken: 'issued-token' }] });
        expect(http).toHaveBeenCalledTimes(1);
        expect(http.mock.calls[0][0]).toBe(direct + '/api/client-auth/pairing/redeem');
        expect(JSON.parse(String(http.mock.calls[0][1]?.body))).toMatchObject({ secret: 'one-time-secret', dedupeKey: 'desktop:install-id' });
        expect(relay.fetch).toHaveBeenCalledTimes(available === 'direct' ? 0 : 1);
        if (available === 'relay') {
          expect(relay.create).toHaveBeenCalledWith({ ...pinned, grant: 'one-time-grant' });
          expect(relay.fetch).toHaveBeenCalledWith('/api/client-auth/pairing/redeem', http.mock.calls[0][1]);
          expect(relay.close).toHaveBeenCalledOnce();
        }
        expect(JSON.stringify(imported)).not.toMatch(/one-time/);
      });
    } finally { http.mockRestore(); }
  });
  test('rejects malformed pairing links before changing hosts', async () => {
    await expect(importDesktopHostPairing('not-a-connect-link', [])).rejects.toThrow('invalid-connect-link');
  });
});

describe('desktop host runtime headers', () => {
  test('parses persisted request headers from desktop config', async () => {
    await withDesktopBridge(async (cmd) => {
      expect(cmd).toBe('desktop_hosts_get');
      return {
        hosts: [{
          id: 'remote-1',
          label: 'Remote',
          url: 'https://remote.example',
          requestHeaders: {
            ' CF-Access-Client-Id ': ' client-id ',
            Authorization: 'Bearer should-not-be-read',
            'Bad:Name': 'bad',
          },
        }],
        defaultHostId: 'remote-1',
        initialHostChoiceCompleted: true,
      };
    }, async () => {
      const config = await desktopHostsGet();
      expect(config.hosts[0]?.requestHeaders).toEqual({
        'CF-Access-Client-Id': 'client-id',
      });
    });
  });

  test('passes request headers through host save and probe IPC calls', async () => {
    const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
    await withDesktopBridge(async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'desktop_host_probe') return { status: 'ok', latencyMs: 7 };
      return null;
    }, async () => {
      const requestHeaders = { 'CF-Access-Client-Id': 'client-id' };
      await desktopHostsSet({
        hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', requestHeaders }],
        defaultHostId: 'remote-1',
      });
      const probe = await desktopHostProbe('https://remote.example', { requestHeaders });
      expect(probe).toEqual({ status: 'ok', latencyMs: 7 });
    });

    expect(calls[0]).toEqual({
      cmd: 'desktop_hosts_set',
      args: {
        input: {
          hosts: [{ id: 'remote-1', label: 'Remote', url: 'https://remote.example', requestHeaders: { 'CF-Access-Client-Id': 'client-id' } }],
          defaultHostId: 'remote-1',
          initialHostChoiceCompleted: undefined,
        },
      },
    });
    expect(calls[1]).toEqual({
      cmd: 'desktop_host_probe',
      args: {
        url: 'https://remote.example',
        requestHeaders: { 'CF-Access-Client-Id': 'client-id' },
      },
    });
  });
});
