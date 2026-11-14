import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { parseConnectionLink, redeemConnection } from '../extension/pairing.mjs';
import { extensionI18n } from './localization.mjs';

const originalChrome = globalThis.chrome;
globalThis.chrome = { i18n: extensionI18n() };
after(() => { globalThis.chrome = originalChrome; });

test('device pairing uses the selected original mounted Host and saves only the redeemed credential', async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    requests.push({ path: request.url, body: JSON.parse(Buffer.concat(chunks)) });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ clientToken: 'varin_client_existing_owner', server: { label: 'My Varin' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const hostUrl = `http://127.0.0.1:${server.address().port}/varin/`;
  const payload = { v: 2, pairingId: 'original-pairing', secret: 'one-time-secret', label: 'Varin', candidates: [{ type: 'lan', url: hostUrl }] };
  const link = `varin://connect?v=2&p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  try {
    const parsed = parseConnectionLink(link);
    await assert.rejects(redeemConnection(parsed, 'https://another-host.test'), /device link is invalid/);
    assert.equal(requests.length, 0);
    const connection = await redeemConnection(parsed, hostUrl);
    assert.deepEqual(connection, { hostUrl, clientToken: 'varin_client_existing_owner', label: 'My Varin' });
    assert.equal(requests[0].path, '/varin/api/client-auth/pairing/redeem');
    assert.equal(requests[0].body.pairingId, 'original-pairing'); assert.equal(requests[0].body.secret, 'one-time-secret');
    assert.equal(requests[0].body.clientKind, 'desktop');
    assert.equal('secret' in connection, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('existing device links can be reused without issuing another token, and relay-only links report the missing transport', async () => {
  const existing = parseConnectionLink('varin://connect?v=1&server=https%3A%2F%2Fhost.test&token=varin_client_approved');
  const connection = await redeemConnection(existing, 'https://host.test', () => { throw new Error('Must not mint a replacement credential'); });
  assert.equal(connection.clientToken, 'varin_client_approved');
  const relay = { v: 2, pairingId: 'pair', secret: 'secret', candidates: [{ type: 'relay', relayUrl: 'wss://relay.test' }] };
  assert.throws(() => parseConnectionLink(`varin://connect?v=2&p=${Buffer.from(JSON.stringify(relay)).toString('base64url')}`), /only offers a relay/);
});

test('the real extension background pairs, shares and exchanges commands without a native helper', { timeout: 10000 }, async () => {
  const requests = []; let delivered = false, onMessage, complete;
  const received = new Promise(resolve => { complete = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); requests.push({ url: request.url, auth: request.headers.authorization, body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url.endsWith('/pairing/redeem')) { response.end(JSON.stringify({ clientToken: 'varin_client_browser', server: { label: 'Varin' } })); return; }
    const commands = !delivered && !body.disconnected ? [{ id: 'list-original', sequence: 1, method: 'list', args: [] }] : [];
    delivered = true; response.end(JSON.stringify({ commands }));
    if (body.results?.length) complete(body.results[0]);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const hostUrl = `http://127.0.0.1:${server.address().port}`;
  const storage = {}, event = () => ({ addListener() {} });
  const previous = globalThis.chrome;
  globalThis.chrome = {
    i18n: extensionI18n('zh_CN'),
    storage: { local: { setAccessLevel: async () => {}, get: async () => ({ ...storage }), set: async values => Object.assign(storage, values), remove: async key => { delete storage[key]; } } },
    runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, sendMessage: async () => {}, onMessage: { addListener: listener => { onMessage = listener; } } },
    tabs: { query: async () => [{ id: 7 }], get: async () => ({ id: 7, title: 'Signed in', url: 'https://signed-in.test', status: 'complete' }), onRemoved: event(), onUpdated: event() },
    debugger: { attach: async () => {}, detach: async () => {}, onDetach: event(), onEvent: event(),
      sendCommand: async (_target, method) => method === 'Page.getNavigationHistory' ? { entries: [{ title: 'Signed in', url: 'https://signed-in.test' }], currentIndex: 0 } : {} },
  };
  const send = message => new Promise((resolve, reject) => onMessage(message, { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' }, value => value.ok ? resolve(value) : reject(new Error(value.error))));
  try {
    await import(`../extension/background.mjs?test=${Date.now()}`);
    assert.equal(onMessage({ action: 'share' }, { id: 'another-extension' }, () => {}), false);
    const payload = { v: 2, pairingId: 'pair', secret: 'one-use', candidates: [{ type: 'lan', url: hostUrl }] };
    const paired = await send({ action: 'pair', hostUrl, link: `varin://connect?v=2&p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}` });
    assert.equal(paired.status, '已配对 · Varin');
    await send({ action: 'share' });
    const result = await received;
    assert.equal(result.id, 'list-original'); assert.equal(result.ok, true); assert.equal(result.value[0].url, 'https://signed-in.test');
    assert.equal(requests.find(item => item.url.endsWith('/connector/exchange')).auth, 'Bearer varin_client_browser');
    const state = await send({ action: 'state' }); assert.equal('clientToken' in state.connection, false);
    assert.equal(state.status, '在线');
    await send({ action: 'disconnect' });
    assert.equal(requests.at(-1).body.disconnected, true);
  } finally {
    await send({ action: 'disconnect' }).catch(() => {}); globalThis.chrome = previous;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
