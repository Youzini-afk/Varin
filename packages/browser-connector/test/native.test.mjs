import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { encodeNativeMessage, createNativeDecoder } from '../native/framing.mjs';
import { connectorEndpoint, ConnectorBridge } from '../native/bridge.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const hello = { type: 'hello', browserId: 'install', instanceId: 'epoch', label: 'Chrome', capabilities: ['list'] };
test('native framing handles split unicode/multiple frames and refuses oversized/truncated input', () => {
  const values = []; const decoder = createNativeDecoder(value => values.push(value));
  const bytes = Buffer.concat([encodeNativeMessage({ text: '中文' }), encodeNativeMessage({ second: true })]);
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  decoder.end(); assert.deepEqual(values, [{ text: '中文' }, { second: true }]);
  const partial = createNativeDecoder(() => {}); partial.push(bytes.subarray(0, 2)); assert.throws(() => partial.end(), /Truncated/);
  assert.throws(() => encodeNativeMessage({ text: 'large' }, 2), /exceeds/);
  const invalid = createNativeDecoder(() => {}, 2); assert.throws(() => invalid.push(bytes), /Invalid/);
});

test('host endpoint is fixed and redirects/plaintext credentials are never allowed', () => {
  assert.equal(connectorEndpoint('http://127.0.0.1:3902'), 'http://127.0.0.1:3902/api/browser-resources/connector/exchange');
  assert.equal(connectorEndpoint('https://example.test'), 'https://example.test/api/browser-resources/connector/exchange');
  for (const url of ['http://remote.test', 'https://u:p@example.test', 'https://example.test/?token=x', 'file:///tmp/a', 'https://example.test/path']) assert.throws(() => connectorEndpoint(url));
});

test('failed exchange stops instead of retrying commands or results', async () => {
  const messages = []; let fetches = 0;
  const bridge = new ConnectorBridge({ endpoint: 'https://host.test', clientToken: 'secret', send: value => messages.push(value), pollMs: 5,
    fetch: async (_url, options) => { fetches++; assert.equal(options.redirect, 'error'); throw new Error('connection lost after effect'); } });
  bridge.accept(hello); await tick();
  assert.equal(fetches, 1); assert.equal(bridge.stopped, true); assert.deepEqual(messages, [{ type: 'disconnected' }]);
  bridge.wake(); assert.equal(fetches, 1);
});

test('duplicate Host commands are delivered once, and result is sent immediately', async () => {
  const messages = []; const bodies = []; let turn = 0;
  const command = { id: 'same', sequence: 1, method: 'list', args: [] };
  const bridge = new ConnectorBridge({ endpoint: 'https://host.test', clientToken: 'secret', send: value => messages.push(value), pollMs: 100000,
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); turn++; return { ok: true, json: async () => ({ commands: turn <= 2 ? [command] : [] }) }; } });
  bridge.accept(hello); await tick();
  bridge.accept({ type: 'result', result: { id: 'same', ok: true, value: [] } }); await tick();
  assert.equal(messages.filter(value => value.type === 'command').length, 1);
  assert.deepEqual(bodies[1].results, [{ id: 'same', ok: true, value: [] }]);
  bridge.stop();
});

test('real native process uses the approved credential and original identity over HTTP', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-browser-connector-'));
  const extensionOrigin = `chrome-extension://${'a'.repeat(32)}/`;
  const requests = []; let sent = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, auth: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ commands: sent ? [] : [{ id: 'request-1', sequence: 1, method: 'list', args: [] }] })); sent = true;
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const credentials = join(directory, 'approved-client.json');
  await writeFile(credentials, JSON.stringify({ clientToken: 'varin_client_fixture_only' }), { mode: 0o600 });
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({ hostUrl: `http://127.0.0.1:${server.address().port}`, credentialFile: credentials, allowedOrigins: [extensionOrigin] }));
  const process = spawn(globalThis.process.execPath, [new URL('../native/main.mjs', import.meta.url).pathname, '--config', config, extensionOrigin], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; process.stderr.on('data', chunk => { stderr += chunk; });
  const received = [];
  const commandReceived = new Promise((resolve, reject) => {
    const decoder = createNativeDecoder(message => {
      received.push(message);
      if (message.type === 'command') {
        process.stdin.write(encodeNativeMessage({ type: 'result', result: { id: message.command.id, ok: true, value: [] } })); resolve();
      }
    });
    process.stdout.on('data', chunk => { try { decoder.push(chunk); } catch (error) { reject(error); } });
    process.once('exit', code => { if (!received.some(value => value.type === 'command')) reject(new Error(`native exit ${code}: ${stderr}`)); });
  });
  try {
    process.stdin.write(encodeNativeMessage(hello)); await commandReceived;
    while (!requests.some(value => value.body.results.length)) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(requests[0].path, '/api/browser-resources/connector/exchange');
    assert.equal(requests[0].auth, 'Bearer varin_client_fixture_only');
    assert.equal(requests[0].body.browserId, 'install'); assert.equal(requests[0].body.instanceId, 'epoch');
    assert.equal(stderr, '');
  } finally {
    process.stdin.end(); if (process.exitCode === null) await once(process, 'exit');
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});


test('intentional disconnect makes one terminal exchange and never executes returned commands', async () => {
  const messages = []; const bodies = []; let stops = 0;
  const bridge = new ConnectorBridge({ endpoint: 'https://host.test', clientToken: 'secret', send: value => messages.push(value), pollMs: 100000, onStop: () => { stops++; },
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ commands: [] }) }; } });
  bridge.accept(hello); await tick();
  bridge.accept({ type: 'goodbye' }); await tick();
  assert.equal(bodies.length, 2); assert.equal(bodies[1].disconnected, true);
  assert.equal(bodies[1].instanceId, 'epoch'); assert.equal(stops, 1);
  bridge.accept({ type: 'goodbye' }); await tick(); assert.equal(bodies.length, 2);
  assert.deepEqual(messages.map(message => message.type), ['connected', 'disconnected']);
});
