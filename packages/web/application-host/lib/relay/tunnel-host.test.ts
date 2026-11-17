import { describe, expect, test } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createTunnelHost } from './tunnel-host.js';
import {
  decodeTunnelFrame,
  encodeJsonPayload,
  encodeTunnelFrame,
  TunnelFrameType,
} from './tunnel-codec.js';
import type { TunnelFrame } from './tunnel-codec.js';

interface LoopbackServer {
  port: number;
  requests: Array<{ body: string; method: string | undefined }>;
  stop: () => Promise<void>;
}

const startLoopback = (): Promise<LoopbackServer> => new Promise((resolve) => {
  const requests: LoopbackServer['requests'] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ body: Buffer.concat(chunks).toString('utf8'), method: request.method });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  server.listen(0, '127.0.0.1', () => resolve({
    port: (server.address() as AddressInfo).port,
    requests,
    stop: () => new Promise<void>((done) => server.close(() => done())),
  }));
});

const waitFor = async (predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
};

const requestHead = (overrides: Record<string, unknown> = {}) => encodeTunnelFrame(
  TunnelFrameType.HttpRequest,
  1,
  encodeJsonPayload({
    headers: { 'content-type': 'application/json' },
    method: 'POST',
    path: '/api/submit',
    query: '',
    ...overrides,
  }),
);

const createHarness = async (overrides: Partial<Parameters<typeof createTunnelHost>[0]> = {}) => {
  const loopback = await startLoopback();
  const sentFrames: TunnelFrame[] = [];
  const host = createTunnelHost({
    connectionId: 'varin-test',
    getBufferedAmount: () => 0,
    getLocalPort: () => loopback.port,
    sendFrame: async (frame) => { sentFrames.push(decodeTunnelFrame(frame)); },
    ...overrides,
  });
  return { host, loopback, sentFrames };
};

const firstRequest = (loopback: LoopbackServer) => {
  const request = loopback.requests[0];
  if (!request) throw new Error('Expected loopback request');
  return request;
};

describe('relay request body integrity', () => {
  test('streams up to the receive window and resumes with credit without blocking another request', async () => {
    const { host, loopback, sentFrames } = await createHarness();
    try {
      await host.handleFrame(requestHead({ method: 'GET', responseWindow: 4 }));
      expect(await waitFor(() => sentFrames.some(frame => frame.frameType === TunnelFrameType.HttpBody))).toBe(true);
      expect(sentFrames.filter(frame => frame.frameType === TunnelFrameType.HttpBody).map(frame => Buffer.from(frame.payload).toString())).toEqual(['{"ok']);
      const other = encodeTunnelFrame(TunnelFrameType.HttpRequest, 3, encodeJsonPayload({ method: 'GET', path: '/api/submit', query: '', headers: {} }));
      await host.handleFrame(other);
      expect(await waitFor(() => sentFrames.some(frame => frame.streamId === 3 && frame.frameType === TunnelFrameType.StreamEnd))).toBe(true);
      await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpCredit, 1, encodeJsonPayload(100)));
      expect(await waitFor(() => sentFrames.some(frame => frame.streamId === 1 && frame.frameType === TunnelFrameType.StreamEnd))).toBe(true);
      expect(Buffer.concat(sentFrames.filter(frame => frame.streamId === 1 && frame.frameType === TunnelFrameType.HttpBody).map(frame => Buffer.from(frame.payload))).toString()).toBe('{"ok":true}');
    } finally { host.close(); await loopback.stop(); }
  });
  test('forwards buffered frames only after the complete body arrives', async () => {
    const { host, loopback } = await createHarness();
    await host.handleFrame(requestHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('alpha')));
    expect(loopback.requests).toHaveLength(0);
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('beta')));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));
    expect(await waitFor(() => loopback.requests.length === 1)).toBe(true);
    expect(firstRequest(loopback).body).toBe('alphabeta');
    await loopback.stop();
  });

  test('rejects a declared body when all body frames were lost', async () => {
    const { host, loopback, sentFrames } = await createHarness();
    await host.handleFrame(requestHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));
    expect(await waitFor(() => sentFrames.some((frame) => frame.frameType === TunnelFrameType.StreamAbort))).toBe(true);
    expect(loopback.requests).toHaveLength(0);
    await loopback.stop();
  });

  test('accepts a body represented by an explicit empty frame', async () => {
    const { host, loopback } = await createHarness();
    await host.handleFrame(requestHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array(0)));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));
    expect(await waitFor(() => loopback.requests.length === 1)).toBe(true);
    expect(firstRequest(loopback).body).toBe('');
    await loopback.stop();
  });

  test('releases a stalled buffered body at the delivery deadline', async () => {
    const { host, loopback, sentFrames } = await createHarness({ bodyDeliveryTimeoutMs: 50 });
    await host.handleFrame(requestHead({ hasBody: true }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new TextEncoder().encode('partial')));
    expect(await waitFor(() => sentFrames.some((frame) => frame.frameType === TunnelFrameType.StreamAbort))).toBe(true);
    expect(loopback.requests).toHaveLength(0);
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0)));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sentFrames.filter((frame) => frame.frameType === TunnelFrameType.StreamAbort)).toHaveLength(1);
    await loopback.stop();
  });
});
