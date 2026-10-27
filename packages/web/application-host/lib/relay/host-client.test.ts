// Integration test: fake relay (minimal Layer 1) + real host-client + a scripted
// client using the production browser handshake. Verifies the full handshake and a tunneled
// HTTP GET /health, and asserts only binary frames cross the relay post-handshake.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import type { RawData } from 'ws';

import { startRelayHost } from './host-client.js';
import { createClientHandshake } from './client-handshake.test-helper.js';
import {
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  importEcdhPrivateKey,
  RELAY_PROTOCOL_VERSION,
} from './e2ee.js';
import type { RelayFrameChannel } from './e2ee.js';
import type { RelayIdentity } from './identity.js';
import {
  TunnelFrameType,
  decodeTunnelFrame,
  encodeJsonPayload,
  encodeTunnelFrame,
} from './tunnel-codec.js';

interface FakeRelay {
  sendControlSync: () => boolean;
  state: {
    buffered: Map<string, Array<[RawData, boolean]>>;
    clients: Map<string, WebSocket>;
    control: WebSocket | null;
    hostData: Map<string, WebSocket>;
    relayFrames: Array<{ from: 'client' | 'host'; isBinary: boolean }>;
  };
  stop: () => Promise<void>;
  wsUrl: string;
}

interface LoopbackOrigin {
  port: number;
  stop: () => Promise<void>;
}

interface ScriptedResult {
  body: { ok: boolean; origin: string; relayConn: string | null };
  status: number | null;
}

const rawDataBytes = (data: RawData): Uint8Array => {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
};

// ---------------------------------------------------------------------------
// Fake relay: routes host-control <-> host-data <-> client by (serverId, connectionId).
// Forwards frames verbatim, never inspects them.
// ---------------------------------------------------------------------------
const startFakeRelay = (): Promise<FakeRelay> => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const state: FakeRelay['state'] = {
    control: null,
    hostData: new Map<string, WebSocket>(),
    clients: new Map<string, WebSocket>(),
    buffered: new Map<string, Array<[RawData, boolean]>>(),
    relayFrames: [],
  };

  const sendControlSync = (): boolean => {
    const control = state.control;
    if (!control || control.readyState !== WebSocket.OPEN) return false;
    control.send(JSON.stringify({ type: 'sync', connectionIds: [...state.clients.keys()] }));
    for (const id of state.clients.keys()) {
      control.send(JSON.stringify({ type: 'connected', connectionId: id }));
    }
    return true;
  };

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const role = url.searchParams.get('role');
    const connectionId = url.searchParams.get('connectionId');

    if (role === 'host-control') {
      state.control = ws;
      return;
    }

    if (role === 'host-data') {
      if (!connectionId) return;
      state.hostData.set(connectionId, ws);
      // Flush any client frames that arrived before this socket attached.
      const buffered = state.buffered.get(connectionId) || [];
      state.buffered.delete(connectionId);
      for (const [data, isBinary] of buffered) ws.send(data, { binary: isBinary });
      ws.on('message', (data, isBinary) => {
        state.relayFrames.push({ from: 'host', isBinary });
        const client = state.clients.get(connectionId);
        if (client && client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      ws.on('close', () => state.hostData.delete(connectionId));
      return;
    }

    if (role === 'client') {
      if (!connectionId) return;
      state.clients.set(connectionId, ws);
      ws.on('message', (data, isBinary) => {
        state.relayFrames.push({ from: 'client', isBinary });
        const host = state.hostData.get(connectionId);
        if (host && host.readyState === WebSocket.OPEN) {
          host.send(data, { binary: isBinary });
        } else {
          const queue = state.buffered.get(connectionId) || [];
          queue.push([data, isBinary]);
          state.buffered.set(connectionId, queue);
        }
      });
      ws.on('close', () => state.clients.delete(connectionId));
      if (state.control && state.control.readyState === WebSocket.OPEN) {
        state.control.send(JSON.stringify({ type: 'connected', connectionId }));
      }
    }
  });

  return new Promise<FakeRelay>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        wsUrl: `ws://127.0.0.1:${port}`,
        state,
        sendControlSync,
        stop: () => new Promise<void>((resolveStop) => {
          for (const socket of wss.clients) socket.terminate();
          wss.close();
          if (!server.listening) {
            resolveStop();
            return;
          }
          server.closeAllConnections?.();
          server.close(() => resolveStop());
        }),
      });
    });
  });
};

// A stub loopback origin serving /health.
const startLoopbackOrigin = (): Promise<LoopbackOrigin> =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        const expectedOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        if (req.headers.origin !== expectedOrigin) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid origin' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          service: 'stub',
          relayConn: req.headers['x-varin-relay-connection'] || null,
          origin: req.headers.origin,
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as AddressInfo).port,
      stop: () => new Promise<void>((done) => server.close(() => done())),
    }));
  });

// Build the host identity around a fresh keypair (ECDH enc key + ECDSA sign key).
const buildIdentity = async (): Promise<RelayIdentity> => {
  const enc = await generateEcdhKeyPair();
  const encPrivJwk = await globalThis.crypto.subtle.exportKey('jwk', enc.privateKey);
  const { privateKey: signPriv, publicKey: signPub } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signPubJwk = signPub.export({ format: 'jwk' });
  const canonical = JSON.stringify({ crv: signPubJwk.crv, kty: signPubJwk.kty, x: signPubJwk.x, y: signPubJwk.y });
  const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
  return {
    serverId,
    hostEncPubJwk: await exportPublicKeyJwk(enc.publicKey),
    hostEncPrivateKey: await importEcdhPrivateKey(encPrivJwk),
    signRelayAuth: (role: string, connectionId?: string | null) => {
      const ts = Date.now();
      const sig = crypto
        .sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), { key: signPriv, dsaEncoding: 'ieee-p1363' })
        .toString('base64url');
      return { ts, sig, pk: Buffer.from(canonical, 'utf8').toString('base64url') };
    },
  };
};

// The real browser handshake negotiates unbatched framing for this transport probe.
const runScriptedClient = async ({ relayUrl, serverId, hostEncPubJwk }: {
  hostEncPubJwk: RelayIdentity['hostEncPubJwk'];
  relayUrl: string;
  serverId: string;
}): Promise<ScriptedResult> => {
  const connectionId = 'conn-test-1';
  const url = new URL(`${relayUrl}/`);
  url.searchParams.set('v', String(RELAY_PROTOCOL_VERSION));
  url.searchParams.set('role', 'client');
  url.searchParams.set('serverId', serverId);
  url.searchParams.set('connectionId', connectionId);
  const handshake = await createClientHandshake(hostEncPubJwk, { batch: false });
  const ws = new WebSocket(url.toString());

  let channel: RelayFrameChannel | null = null;
  const responseChunks: Uint8Array[] = [];
  let responseStatus: number | null = null;
  let resolveDone: (value: ScriptedResult) => void = () => undefined;
  let rejectDone: (error: Error) => void = () => undefined;
  let settled = false;
  const done = new Promise<ScriptedResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const finish = (value: ScriptedResult): void => {
    if (settled) return;
    settled = true;
    resolveDone(value);
  };
  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    rejectDone(error instanceof Error ? error : new Error(String(error)));
  };

  ws.on('open', () => ws.send(handshake.helloText));
  ws.on('error', fail);
  ws.on('close', () => {
    if (!settled) fail(new Error('Scripted relay client closed before the tunneled response completed.'));
  });

  // Serialize message handling: an async ws handler runs per-message tasks
  // concurrently, letting StreamEnd overtake HttpBody and trip the decryptor's
  // strict counter ordering (the production tunnel client chains decrypts).
  let processing = Promise.resolve();
  const handleMessage = async (data: RawData, isBinary: boolean): Promise<void> => {
    if (!isBinary) {
      const action = await handshake.handleText(data.toString('utf8'));
      if (action.type === 'established') {
        channel = action.channel;
        // Send an HTTP GET /health over stream 1.
        const req = encodeTunnelFrame(TunnelFrameType.HttpRequest, 1, encodeJsonPayload({
          method: 'GET',
          path: '/health',
          query: '',
          headers: { accept: 'application/json' },
        }));
        ws.send(await channel.encryptor.encrypt(req), { binary: true });
        ws.send(await channel.encryptor.encrypt(encodeTunnelFrame(TunnelFrameType.StreamEnd, 1, new Uint8Array(0))), { binary: true });
      }
      return;
    }
    if (!channel) return;
    const plaintext = await channel.decryptor.decrypt(rawDataBytes(data));
    const frame = decodeTunnelFrame(plaintext);
    if (frame.frameType === TunnelFrameType.HttpResponse) {
      const parsed = JSON.parse(new TextDecoder().decode(frame.payload)) as { status?: number };
      responseStatus = typeof parsed.status === 'number' ? parsed.status : null;
    } else if (frame.frameType === TunnelFrameType.HttpBody) {
      responseChunks.push(frame.payload);
    } else if (frame.frameType === TunnelFrameType.StreamEnd) {
      const total = responseChunks.reduce((n, c) => n + c.length, 0);
      const body = new Uint8Array(total);
      let off = 0;
      for (const c of responseChunks) {
        body.set(c, off);
        off += c.length;
      }
      finish({ status: responseStatus, body: JSON.parse(new TextDecoder().decode(body)) as ScriptedResult['body'] });
      ws.close();
    }
  };
  ws.on('message', (data, isBinary) => {
    processing = processing.then(() => handleMessage(data, isBinary)).catch(fail);
  });

  return done;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
};

describe('relay host-client integration', () => {
  let relay: FakeRelay;
  let origin: LoopbackOrigin;
  let host: ReturnType<typeof startRelayHost> | null = null;

  beforeAll(async () => {
    relay = await startFakeRelay();
    origin = await startLoopbackOrigin();
  });

  afterAll(async () => {
    host?.stop();
    await relay?.stop();
    await origin?.stop();
  }, 45_000);

  it('tunnels an HTTP GET /health with only binary frames post-handshake', async () => {
    const identity = await buildIdentity();
    const runningHost = startRelayHost({
      relayUrl: `${relay.wsUrl}/`,
      identity,
      getLocalPort: () => origin.port,
      onStatus: () => {},
      logger: { info: () => {}, warn: () => {} },
    });
    host = runningHost;

    // A local WebSocket upgrade is not proof that the relay registered this
    // host. Keep the public state connecting until the relay sends its sync.
    const socketReady = await waitFor(() => relay.state.control?.readyState === WebSocket.OPEN);
    expect(socketReady).toBe(true);
    expect(runningHost.getStatus().state).toBe('connecting');
    expect(relay.sendControlSync()).toBe(true);
    const controlReady = await waitFor(() => runningHost.getStatus().state === 'connected');
    expect(controlReady).toBe(true);

    const result = await runScriptedClient({
      relayUrl: relay.wsUrl,
      serverId: identity.serverId,
      hostEncPubJwk: identity.hostEncPubJwk,
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.relayConn).toBe('conn-test-1');
    expect(result.body.origin).toBe(`http://127.0.0.1:${origin.port}`);

    // Every forwarded frame after the two plaintext handshake frames (client
    // hello, host ready) must be binary.
    const forwarded = relay.state.relayFrames;
    const plaintextForwarded = forwarded.filter((frame) => !frame.isBinary);
    expect(plaintextForwarded.length).toBe(2); // hello + ready only
    expect(forwarded.filter((frame) => frame.isBinary).length).toBeGreaterThan(0);
  }, 45_000);
});
