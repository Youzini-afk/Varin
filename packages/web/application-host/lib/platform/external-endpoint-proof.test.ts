import { once } from 'node:events';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { createEndpointProof, inspectPublicEndpoint, verifyPublicEndpoint } from './external-endpoint-proof.js';
import { createPublicIngress } from './public-ingress.js';

it('checks the configured entrance through private or split-horizon DNS', async () => {
  const challenge = createEndpointProof().issue();
  const transport = vi.fn(async () => challenge.expected);
  expect(await verifyPublicEndpoint({
    origin: 'https://public.example.test', challenge, signal: new AbortController().signal,
    resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '::1', family: 6 }], transport,
  })).toBe(true);
  expect(transport).toHaveBeenCalledTimes(2);
});

it('pins resolved addresses, keeps configured authority, and requires independent proof rather than ticket reflection', async () => {
  const challenge = createEndpointProof().issue();
  const resolve = vi.fn(async () => [{ address: '1.1.1.1', family: 4 }]);
  const transport = vi.fn(async (url: URL, pinned: { address: string }) => {
    expect(url.origin).toBe('https://public.example.test:8443');
    expect(url.pathname).toBe(challenge.path);
    expect(pinned.address).toBe('1.1.1.1');
    return challenge.expected;
  });
  expect(await verifyPublicEndpoint({ origin: 'https://public.example.test:8443', challenge, signal: new AbortController().signal, resolve, transport })).toBe(true);
  expect(resolve).toHaveBeenCalledExactlyOnceWith('public.example.test');
  expect(await verifyPublicEndpoint({
    origin: 'https://public.example.test:8443', challenge, signal: new AbortController().signal, resolve,
    transport: async url => url.pathname.split('/').at(-1) ?? null,
  })).toBe(false);
});

it('does not dispatch a request after a cancelled DNS lookup resolves', async () => {
  const challenge = createEndpointProof().issue();
  const abort = new AbortController();
  let finishDns: ((value: { family: number; address: string }[]) => void) | undefined;
  const transport = vi.fn(async () => challenge.expected);
  const pending = verifyPublicEndpoint({
    origin: 'https://public.example.test', challenge, signal: abort.signal,
    resolve: () => new Promise(resolve => { finishDns = resolve; }), transport,
  });
  abort.abort();
  expect(await pending).toBe(false);
  finishDns?.([{ address: '1.1.1.1', family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  expect(transport).not.toHaveBeenCalled();
});

it('serves a GET proof once on the enabled guarded entry, without passing it to application routes', async () => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  const ingress = createPublicIngress({
    origin: 'https://public.example.test', port,
    onRequest: vi.fn((_req, res) => { res.end('application'); }),
    onUpgrade: (_req, socket) => { socket.destroy(); },
  });
  const read = (path: string, method = 'GET') => new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port, path, method, headers: { Host: 'public.example.test' } }, res => {
      res.setEncoding('utf8');
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ ...(res.statusCode ? { status: res.statusCode } : {}), body }));
    });
    call.on('error', reject);
    call.end();
  });
  try {
    await ingress.listen();
    const challenge = ingress.issueEndpointProof();
    expect((await read(challenge.path)).status).toBe(503);
    ingress.setEnabled(true);
    expect((await read(challenge.path, 'HEAD')).status).toBe(404);
    expect(await read(challenge.path)).toEqual({ status: 200, body: challenge.expected });
    expect(await read(challenge.path)).toEqual({ status: 404, body: '' });
  } finally { await ingress.close(); }
});

it('reports safe DNS, TLS, and wrong-entrance reasons without raw provider text', async () => {
  const challenge = createEndpointProof().issue();
  const input = { origin: 'https://public.example.test', challenge,
    signal: new AbortController().signal, resolve: async () => [{ address: '1.1.1.1', family: 4 }] };
  expect(await inspectPublicEndpoint({ ...input, resolve: async () => { throw new Error('private resolver error'); } })).toBe('dns');
  expect(await inspectPublicEndpoint({
    ...input, transport: async () => { throw Object.assign(new Error('private certificate details'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }); },
  })).toBe('tls');
  expect(await inspectPublicEndpoint({ ...input, transport: async () => null })).toBe('different_endpoint');
});
