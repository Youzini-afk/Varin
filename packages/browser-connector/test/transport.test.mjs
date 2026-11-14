import test from 'node:test';
import assert from 'node:assert/strict';
import { connectorEndpoint, ConnectorBridge } from '../extension/transport.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const hello = { type: 'hello', browserId: 'install', instanceId: 'epoch', label: 'Chrome', capabilities: ['list'] };

test('host endpoint preserves mounted services and LAN addresses without URL credentials', () => {
  assert.equal(connectorEndpoint('http://127.0.0.1:3902'), 'http://127.0.0.1:3902/api/browser-resources/connector/exchange');
  assert.equal(connectorEndpoint('http://remote.test/service'), 'http://remote.test/service/api/browser-resources/connector/exchange');
  for (const url of ['https://u:p@example.test', 'https://example.test/?token=x', 'file:///tmp/a']) assert.throws(() => connectorEndpoint(url));
});
test('failed exchange stops instead of retrying commands or results', async () => {
  const messages = []; let fetches = 0;
  const bridge = new ConnectorBridge({ endpoint: 'https://host.test', clientToken: 'secret', send: value => messages.push(value),
    fetch: async (_url, options) => { fetches++; assert.equal(options.redirect, 'error'); throw new Error('connection lost after effect'); } });
  bridge.accept(hello); await tick();
  assert.equal(fetches, 1); assert.equal(bridge.stopped, true); assert.deepEqual(messages, [{ type: 'disconnected' }]);
  bridge.wake(); assert.equal(fetches, 1);
});
test('duplicate commands are delivered once, and results are sent immediately', async () => {
  const messages = [], bodies = []; let turn = 0;
  const command = { id: 'same', sequence: 1, method: 'list', args: [] };
  const bridge = new ConnectorBridge({ endpoint: 'https://host.test', clientToken: 'secret', send: value => messages.push(value), pollMs: 100000,
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ commands: ++turn <= 2 ? [command] : [] }) }; } });
  bridge.accept(hello); await tick();
  bridge.accept({ type: 'result', result: { id: 'same', ok: true, value: [] } }); await tick();
  assert.equal(messages.filter(value => value.type === 'command').length, 1);
  assert.deepEqual(bodies[1].results, [{ id: 'same', ok: true, value: [] }]); bridge.stop();
});
test('intentional disconnect makes one terminal exchange and never executes returned commands', async () => {
  const messages = [], bodies = []; let stops = 0;
  const bridge = new ConnectorBridge({ endpoint: 'https://host.test', clientToken: 'secret', send: value => messages.push(value), pollMs: 100000, onStop: () => { stops++; },
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ commands: [] }) }; } });
  bridge.accept(hello); await tick(); await bridge.closeGracefully();
  assert.equal(bodies.length, 2); assert.equal(bodies[1].disconnected, true); assert.equal(bodies[1].instanceId, 'epoch'); assert.equal(stops, 1);
  await bridge.closeGracefully(); assert.equal(bodies.length, 2);
  assert.deepEqual(messages.map(message => message.type), ['connected', 'disconnected']);
});
