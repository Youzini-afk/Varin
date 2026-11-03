import { expect, it } from 'vitest';
import http from 'node:http';
import { createServerStartupRuntime } from './server-startup-runtime.js';

it('retries a busy desktop port on the same initialized server without duplicating listeners', async () => {
  const occupied = http.createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const server = http.createServer((_req, res) => res.end('original-owner'));
  const listeningBaseline = server.listenerCount('listening');
  let publications = 0;
  const runtime = createServerStartupRuntime({
    server, process: { ...process, send: () => { publications++; return true; } } as NodeJS.Process,
    crypto: { randomUUID: () => 'unchanged' },
    TUNNEL_MODE_MANAGED_LOCAL: 'local', TUNNEL_MODE_MANAGED_REMOTE: 'remote', TUNNEL_MODE_QUICK: 'quick',
    getSignalsAttached: () => false, setSignalsAttached: () => {}, gracefulShutdown: async () => {},
    normalizeTunnelBootstrapTtlMs: () => null, readSettingsFromDisk: async () => ({}),
    tunnelAuthController: { issueBootstrapToken: () => ({ token: '' }), setActiveTunnel: () => {} },
    startTunnelWithNormalizedRequest: async () => ({ mode: '', publicUrl: '' }),
  });
  try {
    const result = await runtime.startListeningAndMaybeTunnel({ port: address.port, fallbackPorts: [0], bindHost: '127.0.0.1' });
    expect(result.activePort).not.toBe(address.port);
    expect(await (await fetch(`http://127.0.0.1:${result.activePort}`)).text()).toBe('original-owner');
    expect(publications).toBe(1);
    expect(server.listenerCount('listening')).toBe(listeningBaseline);
    expect(server.listenerCount('error')).toBe(0);
  } finally {
    server.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => occupied.close(() => resolve()))]);
  }
});
