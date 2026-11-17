/**
 * Explicit opt-in, no downloads, no system installation, no public listeners.
 * Prepare the official Linux amd64 v0.65.0 archive in a separate directory,
 * verify its SHA-256 against both the release API digest and checksum asset:
 * https://github.com/fatedier/frp/releases/tag/v0.65.0
 * archive: 52ced8c5fdf772f48a9909da4c10c7568c061861946ac9af7a86eeaf14b7e6d5
 * Then, from packages/web (requires OpenSSL on PATH):
 * VARIN_FRP_TEST_BIN_DIR=/absolute/path/frp_0.65.0_linux_amd64 \
 *   bun run test application-host/lib/tunnels/providers/frp.integration.test.ts
 *
 * This proves the real adapter/process/guarded-listener contract, not deployment,
 * public DNS, certificate provisioning, pairing, or a full application session.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest, type RequestOptions } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import express from 'express';
import { WebSocket, WebSocketServer, type ClientOptions } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicIngress, getExternalIngress } from '../../platform/public-ingress.js';
import { createTunnelAuth } from '../../platform/tunnel-auth.js';
import { startFrpTunnel, type FrpTunnelConfiguration, type FrpTunnelController } from './frp.js';

const binaryDirectory = process.env.VARIN_FRP_TEST_BIN_DIR;
const loopback = '127.0.0.1';
const hashes = {
  frpc: 'a89129b922f91f1327853a46da65136c52ad421c85315299d333ec06da3f3bbb',
  frps: '02b50823f330d0486f334d6aa9e448c4d0a26f553a691d167aae8358baab89ee',
};

async function vacantPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, loopback);
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

/** Every real child has an independent kill/close owner, even on assertion failure. */
function ownChild(child: ChildProcess) {
  const closed = once(child, 'close');
  void closed.catch(() => undefined);
  return {
    child,
    closed,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return bounded(closed, 'child pipes close');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1_000);
      try { await bounded(closed, 'child termination'); } finally { clearTimeout(timer); }
    },
  };
}

describe.skipIf(!binaryDirectory)('official FRP v0.65.0 loopback conformance', () => {
  let directory: string;
  let configuration: FrpTunnelConfiguration;
  let ca: Buffer;
  let token: string;
  let host: string;
  let origin: string;
  let frontPort: number;
  let ingress: ReturnType<typeof createPublicIngress> | undefined;
  let edge: ReturnType<typeof createHttpsServer> | undefined;
  let frps: ReturnType<typeof ownChild> | undefined;
  let wss: WebSocketServer | undefined;
  const children: ReturnType<typeof ownChild>[] = [];
  const controllers: FrpTunnelController[] = [];
  const sockets = new Set<Duplex>();
  const clients = new Set<WebSocket>();
  let releaseSse: (() => void) | undefined;
  let secondSseSent = false;

  function trackSocket(socket: Duplex) {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    return socket;
  }

  function metadata(request: IncomingMessage) {
    return {
      host: request.headers.host, origin: request.headers.origin,
      scope: createTunnelAuth().classifyRequestScope(request),
      guarded: getExternalIngress(request)?.origin,
      forwardedHost: request.headers['x-forwarded-host'] ?? null,
      forwardedFor: request.headers['x-forwarded-for'] ?? null,
      relayConnection: request.headers['x-varin-relay-connection'] ?? null,
      protocol: request.headers['x-forwarded-proto'],
    };
  }

  beforeAll(async () => {
    expect(process.platform).toBe('linux');
    expect(process.arch).toBe('x64');
    expect(path.isAbsolute(binaryDirectory!)).toBe(true);
    for (const name of ['frpc', 'frps'] as const) {
      const binary = path.join(binaryDirectory!, name);
      expect(createHash('sha256').update(await fs.readFile(binary)).digest('hex')).toBe(hashes[name]);
      expect(execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5_000 }).trim()).toBe('0.65.0');
    }
    directory = await fs.mkdtemp(path.join(tmpdir(), 'varin-frp-integration-'));
    await fs.chmod(directory, 0o700);
    const openssl = (args: string[]) => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe', timeout: 10_000 });
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem',
      '-days', '1', '-subj', '/CN=Varin ephemeral fixture CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/CN=frps.fixture.test']);
    await fs.writeFile(path.join(directory, 'server.ext'), [
      'subjectAltName=DNS:frps.fixture.test,DNS:varin.fixture.test',
      'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
    ].join('\n'), { mode: 0o600 });
    openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'server.pem', '-days', '1', '-extfile', 'server.ext']);
    for (const name of ['ca.key', 'server.key']) await fs.chmod(path.join(directory, name), 0o600);
    ca = await fs.readFile(path.join(directory, 'ca.pem'));
    const controlPort = await vacantPort();
    const remotePort = await vacantPort();
    const backendPort = await vacantPort();
    frontPort = await vacantPort();
    expect(new Set([controlPort, remotePort, backendPort, frontPort]).size).toBe(4);
    host = `varin.fixture.test:${frontPort}`;
    origin = `https://${host}`;
    token = randomBytes(32).toString('hex');
    const serverConfig = path.join(directory, 'frps.json');
    await fs.writeFile(serverConfig, JSON.stringify({
      bindAddr: loopback, proxyBindAddr: loopback, bindPort: controlPort,
      allowPorts: [{ single: remotePort }],
      auth: { method: 'token', token },
      transport: { tls: { force: true, certFile: path.join(directory, 'server.pem'), keyFile: path.join(directory, 'server.key') } },
      log: { to: 'console', level: 'info', disablePrintColor: true },
    }), { mode: 0o600 });
    const server = spawn(path.join(binaryDirectory!, 'frps'), ['-c', serverConfig], { cwd: directory, env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
    frps = ownChild(server);
    children.push(frps);
    await bounded(new Promise<void>((resolve, reject) => {
      let output = '';
      server.stdout!.on('data', (part: Buffer) => {
        output = (output + part.toString()).slice(-4_096);
        if (output.includes('frps started successfully')) resolve();
      });
      server.once('error', reject);
      server.once('close', () => reject(new Error('frps exited before readiness')));
    }), 'frps readiness');
    configuration = {
      executablePath: path.join(binaryDirectory!, 'frpc'),
      server: { address: loopback, port: controlPort, tls: { caFile: path.join(directory, 'ca.pem'), serverName: 'frps.fixture.test' } },
      proxy: { name: 'varin-conformance', remotePort }, tokenEnv: 'VARIN_FRP_TOKEN_TEST', publicOrigin: origin,
      backend: { originUrl: `http://${loopback}:${backendPort}` },
    };

    const app = express();
    app.set('trust proxy', true);
    app.get('/events', (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      response.write('data: first\n\n');
      releaseSse = () => { secondSseSent = true; response.end('data: second\n\n'); };
    });
    app.use((request, response) => response.json(metadata(request)));
    wss = new WebSocketServer({ noServer: true });
    ingress = createPublicIngress({
      origin, host: loopback, port: backendPort, onRequest: app,
      onUpgrade(request, socket, head) {
        wss!.handleUpgrade(request, socket, head, websocket => {
          websocket.send(JSON.stringify(metadata(request)));
          websocket.on('message', data => websocket.send(data.toString()));
        });
      },
    });
    await ingress.listen();

    // Minimal HTTPS reverse proxy: preserve Host and Origin, and stream both
    // response bodies and real WebSocket bytes without buffering/reinterpreting.
    edge = createHttpsServer({ ca, cert: await fs.readFile(path.join(directory, 'server.pem')), key: await fs.readFile(path.join(directory, 'server.key')) }, (request, response) => {
      const upstream = httpRequest({ hostname: loopback, port: remotePort, method: request.method, path: request.url, headers: request.headers, agent: false }, reply => {
        response.writeHead(reply.statusCode!, reply.headers);
        reply.pipe(response);
      });
      upstream.once('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      response.once('close', () => upstream.destroy());
      request.pipe(upstream);
    });
    edge.on('connection', trackSocket);
    edge.on('upgrade', (request, socket, head) => {
      const upstream = trackSocket(connect(remotePort, loopback));
      upstream.once('connect', () => {
        const headers = request.rawHeaders.reduce<string[]>((lines, entry, index, all) => {
          if (index % 2 === 0) lines.push(`${entry}: ${all[index + 1]}`);
          return lines;
        }, []);
        upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(socket); socket.pipe(upstream);
      });
      upstream.once('error', () => socket.destroy());
      socket.once('error', () => upstream.destroy());
      socket.once('close', () => upstream.destroy());
    });
    edge.listen(frontPort, loopback);
    await once(edge, 'listening');
  });

  afterAll(async () => {
    for (const client of clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    // Force process release even if the adapter's stop path regresses.
    await Promise.all(children.map(child => child.stop()));
    await Promise.all(controllers.map(controller => bounded(controller.stop(), 'adapter cleanup')));
    await ingress?.close();
    wss?.close();
    if (edge?.listening) await new Promise<void>((resolve, reject) => edge!.close(error => error ? reject(error) : resolve()));
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  });

  function start(input = configuration, credential = token) {
    let child: ReturnType<typeof ownChild> | undefined;
    let privateDirectory: string | undefined;
    const starting = startFrpTunnel(input, {
      env: { VARIN_FRP_TOKEN_TEST: credential }, tempDirectory: directory, startupTimeoutMs: 5_000, shutdownGraceMs: 1_000,
      spawnProcess(command, args, options) {
        privateDirectory = options.cwd;
        child = ownChild(spawn(command, args, options));
        children.push(child);
        return child.child;
      },
    }).then(controller => { controllers.push(controller); return controller; });
    return { starting, get child() { return child!; }, get privateDirectory() { return privateDirectory!; } };
  }

  function request(options: RequestOptions = {}) {
    return bounded(new Promise<IncomingMessage>((resolve, reject) => {
      const req = httpsRequest({ hostname: loopback, port: frontPort, servername: 'varin.fixture.test', ca, agent: false,
        ...options, headers: { Host: host, ...options.headers } }, resolve);
      req.setTimeout(4_000, () => req.destroy(new Error('HTTPS fixture request timed out')));
      req.once('error', reject); req.end();
    }), 'HTTPS response');
  }

  async function body(response: IncomingMessage) {
    let text = '';
    for await (const chunk of response) text += String(chunk);
    return text;
  }

  async function status(options: RequestOptions) {
    const response = await request(options);
    await body(response);
    return response.statusCode;
  }

  function websocket(headers: Record<string, string> = {}) {
    const options: ClientOptions & TlsConnectionOptions = {
      ca, servername: 'varin.fixture.test', headers: { Host: host, Origin: origin, ...headers }, handshakeTimeout: 4_000,
    };
    const client = new WebSocket(`wss://${loopback}:${frontPort}/socket`, options);
    clients.add(client);
    return client;
  }

  it('fails closed for the real server certificate with a wrong SAN and for a rejected token', async () => {
    // Native FRP may report only "session shutdown" when its TCP multiplexer
    // loses the failed TLS handshake. Never infer a TLS diagnosis from that
    // generic evidence; either classification must fail closed without retry.
    for (const [input, credential, code] of [
      [{ ...configuration, server: { ...configuration.server, tls: { ...configuration.server.tls, serverName: 'wrong.fixture.test' } } }, token, /^(tls_failed|startup_failed)$/],
      [configuration, `${token}-wrong`, /^authentication_failed$/],
    ] as const) {
      const attempt = start(input, credential);
      await expect(attempt.starting).rejects.toMatchObject({ code: expect.stringMatching(code), retryable: false });
      await bounded(attempt.child.closed, 'rejected frpc closure');
      await expect(fs.stat(attempt.privateDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('classifies a real occupied server mapping as a non-retryable publish rejection', async () => {
    const occupied = createServer();
    occupied.listen(configuration.proxy.remotePort, loopback);
    await once(occupied, 'listening');
    try {
      const attempt = start();
      await expect(attempt.starting).rejects.toMatchObject({ code: 'publish_rejected', retryable: false });
      await bounded(attempt.child.closed, 'rejected mapping child closure');
      await expect(fs.stat(attempt.privateDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
    }
  });

  it('preserves HTTP/SSE/WebSocket semantics, fences trust, and actually releases the published child on stop', async () => {
    const attempt = start();
    const controller = await attempt.starting;
    expect(controller.getState()).toBe('published');
    expect(controller.endpointVerification).toBe('unverified');
    expect(await status({})).toBe(503);
    ingress!.setEnabled(true);
    const spoof = { Origin: origin, 'X-Forwarded-Host': 'localhost', 'X-Forwarded-For': loopback, 'X-Forwarded-Proto': 'http', 'X-Varin-Relay-Connection': 'fixture-spoof' };
    const response = await request({ method: 'POST', headers: spoof });
    expect(response.statusCode).toBe(200);
    const expected = { host, origin, scope: 'tunnel', guarded: origin, forwardedHost: null, forwardedFor: null, relayConnection: null, protocol: 'https' };
    expect(JSON.parse(await body(response))).toEqual(expected);
    expect(await status({})).toBe(200);
    expect(await status({ headers: { Host: 'localhost' } })).toBe(421);
    expect(await status({ method: 'POST' })).toBe(403);
    expect(await status({ headers: { Origin: 'https://foreign.fixture.test' } })).toBe(403);

    const stream = await request({ path: '/events' });
    expect(stream.headers['content-type']).toBe('text/event-stream');
    const [first] = await bounded(once(stream, 'data'), 'first SSE event');
    expect(String(first)).toBe('data: first\n\n');
    expect(secondSseSent).toBe(false);
    const rest = body(stream);
    releaseSse!();
    expect(await bounded(rest, 'second SSE event')).toBe('data: second\n\n');

    const denied = websocket({ Origin: 'https://foreign.fixture.test' });
    const deniedResponse = new Promise<number | undefined>((resolve, reject) => {
      denied.once('unexpected-response', (_req, reply) => { resolve(reply.statusCode); reply.resume(); denied.terminate(); });
      denied.once('error', reject);
    });
    expect(await bounded(deniedResponse, 'foreign WebSocket rejection')).toBe(403);
    const client = websocket(spoof);
    const initial = bounded(once(client, 'message'), 'WebSocket admission metadata');
    await bounded(once(client, 'open'), 'WebSocket open');
    expect(JSON.parse(String((await initial)[0]))).toEqual(expected);
    const echo = bounded(once(client, 'message'), 'WebSocket echo');
    client.send('real-frp-websocket');
    expect(String((await echo)[0])).toBe('real-frp-websocket');

    const closed = bounded(once(client, 'close'), 'WebSocket closure after frpc stop');
    await bounded(controller.stop(), 'adapter stop');
    await closed;
    expect(controller.getState()).toBe('stopped');
    await bounded(attempt.child.closed, 'published frpc closure');
    await expect(fs.stat(attempt.privateDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await status({})).toBe(502);
    await controller.stop();
  });

  it('reports actual control-connection loss once and closes frpc without internal recovery', async () => {
    const attempt = start();
    const controller = await attempt.starting;
    const failures: string[] = [];
    const disconnected = new Promise<void>(resolve => controller.onDisconnect(error => {
      failures.push(error.code);
      expect(error.retryable).toBe(true);
      resolve();
    }));
    await frps!.stop();
    await bounded(disconnected, 'control disconnect event');
    await bounded(attempt.child.closed, 'disconnected frpc closure');
    await controller.stop();
    expect(failures).toEqual(['connection_lost']);
    expect(controller.getState()).toBe('stopped');
    await expect(fs.stat(attempt.privateDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
