import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { it } from 'vitest';
import {
  createPublicIngress,
  getExternalIngress,
  markExternalIngressClient,
  readExternalIngressEnvironment,
} from './public-ingress.js';

const origin = 'https://board.example.test';
const host = 'board.example.test';

async function vacantPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function call(port: number, opts: { method?: string; host?: string; origin?: string; extra?: Record<string, string> } = {}) {
  return new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const call = request({
      hostname: '127.0.0.1', port, path: '/', method: opts.method ?? 'GET',
      headers: { Host: opts.host ?? host, ...(opts.origin ? { Origin: opts.origin } : {}), ...opts.extra },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (part: string) => { body += part; });
      response.once('end', () => resolve({ ...(response.statusCode ? { status: response.statusCode } : {}), body }));
      response.once('error', reject);
    });
    call.once('error', reject);
    call.end();
  });
}

async function upgrade(port: number, senderOrigin: string, id: string) {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write([
    `GET /${id} HTTP/1.1`, `Host: ${host}`, `Origin: ${senderOrigin}`,
    'Connection: Upgrade', 'Upgrade: websocket', '', '',
  ].join('\r\n'));
  const [data] = await once(socket, 'data');
  return { socket, response: String(data) };
}

it('opts in only with an explicit HTTPS origin and fixed backend port', () => {
  assert.equal(readExternalIngressEnvironment({}), null);
  assert.throws(() => readExternalIngressEnvironment({ VARIN_EXTERNAL_ORIGIN: 'https://board.example.test' }));
  assert.throws(() => readExternalIngressEnvironment({
    VARIN_EXTERNAL_ORIGIN: 'https://board.example.test',
    VARIN_EXTERNAL_LISTEN_PORT: '8080garbage',
  }));
  assert.throws(() => readExternalIngressEnvironment({
    VARIN_EXTERNAL_ORIGIN: 'http://board.example.test',
    VARIN_EXTERNAL_LISTEN_PORT: '8080',
  }));
  assert.deepEqual(readExternalIngressEnvironment({
    VARIN_EXTERNAL_ORIGIN: origin,
    VARIN_EXTERNAL_LISTEN_PORT: '8080',
  }), { origin, host: '127.0.0.1', port: 8080 });
});

it('gates HTTP using its actual listener, not proxy metadata; stays fenced after disabling', async () => {
  const port = await vacantPort();
  let seen: IncomingMessage | undefined;
  const ingress = createPublicIngress({
    origin, port,
    onRequest(req, res) { seen = req; res.end('working'); },
    onUpgrade(_req, socket) { socket.destroy(); },
  });
  try {
    await ingress.listen();
    assert.equal((await call(port)).status, 503);
    ingress.setEnabled(true);
    assert.equal((await call(port, { host: 'localhost' })).status, 421);
    assert.equal((await call(port, { method: 'POST' })).status, 403);
    assert.equal((await call(port, { method: 'POST', origin: 'https://other.example.test' })).status, 403);
    assert.equal(seen, undefined);
    assert.equal((await call(port, { extra: {
      'X-Forwarded-Host': 'localhost', 'X-Forwarded-Proto': 'http', 'X-Forwarded-For': '127.0.0.1',
    } })).body, 'working');
    const admitted = seen as IncomingMessage | undefined;
    assert.ok(admitted);
    assert.equal(getExternalIngress(admitted)?.origin, origin);
    assert.equal(admitted.headers['x-forwarded-host'], undefined);
    assert.equal(admitted.headers['x-forwarded-for'], undefined);
    assert.equal(admitted.headers['x-forwarded-proto'], 'https');
    assert.equal(getExternalIngress({ headers: { host: 'board.example.test' } }), undefined);
    assert.equal((await call(port, { method: 'POST', origin })).status, 200);
    ingress.setEnabled(false);
    assert.equal((await call(port, { method: 'POST', origin })).status, 503);
  } finally { await ingress.close(); }
});

it('fences upgrades, then closes only the revoked device until the whole ingress is disabled', async () => {
  const port = await vacantPort();
  const ingress = createPublicIngress({
    origin, port,
    onRequest(_req, res) { res.end(); },
    onUpgrade(req, socket) {
      assert.equal(getExternalIngress(req)?.origin, origin);
      markExternalIngressClient(req, req.url!);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    },
  });
  try {
    await ingress.listen();
    const disabled = await upgrade(port, origin, 'first');
    assert.match(disabled.response, /503/);
    disabled.socket.destroy();
    ingress.setEnabled(true);
    const foreign = await upgrade(port, 'https://other.example.test', 'first');
    assert.match(foreign.response, /403/);
    foreign.socket.destroy();
    const a = await upgrade(port, origin, 'first'), b = await upgrade(port, origin, 'second');
    assert.match(a.response, /101/); assert.match(b.response, /101/);
    const aClosed = once(a.socket, 'close');
    ingress.revokeClient('/first');
    await aClosed;
    assert.equal(b.socket.destroyed, false);
    const bClosed = once(b.socket, 'close');
    ingress.setEnabled(false);
    await bClosed;
  } finally { await ingress.close(); }
});

it('keeps its local listener usable after a failed bind and supports an explicit retry', async () => {
  const occupied = createServer((_req, res) => res.end('original'));
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const port = (occupied.address() as AddressInfo).port;
  const release = () => new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
  const ingress = createPublicIngress({
    origin, port,
    onRequest(_req, res) { res.end('guarded'); },
    onUpgrade(_req, socket) { socket.destroy(); },
  });
  try {
    await assert.rejects(ingress.listen(), { code: 'EADDRINUSE' });
    assert.equal(ingress.enabled, false);
    assert.throws(() => ingress.setEnabled(true));
    assert.equal((await call(port)).body, 'original');
    await release();
    await ingress.listen();
    assert.equal((await call(port)).status, 503);
    ingress.setEnabled(true);
    assert.equal((await call(port)).body, 'guarded');
  } finally {
    await ingress.close();
    if (occupied.listening) await release();
  }
});

it('expires a device upgrade without disabling the listener', async () => {
  const port = await vacantPort();
  const ingress = createPublicIngress({
    origin, port,
    onRequest(_req, res) { res.end('working'); },
    onUpgrade(req, socket) {
      markExternalIngressClient(req, 'temporary-device', new Date(Date.now() + 120).toISOString());
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    },
  });
  try {
    await ingress.listen();
    ingress.setEnabled(true);
    const { socket, response } = await upgrade(port, origin, 'temporary');
    assert.match(response, /101/);
    await once(socket, 'close');
    assert.equal((await call(port)).body, 'working');
  } finally { await ingress.close(); }
});
