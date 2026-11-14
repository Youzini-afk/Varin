import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TabConnector, CAPABILITIES } from '../extension/connector.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const calls = []; const events = []; let serial = 0;
  const tabs = new Map([[7, { id: 7, title: 'Signed in', url: 'https://example.test/inbox', status: 'complete' }],
    [8, { id: 8, title: 'Private unshared', url: 'https://private.test', status: 'complete' }]]);
  let intercept;
  const chrome = { tabs: {
    async get(id) { if (!tabs.has(id)) throw new Error('Tab not found'); return { ...tabs.get(id) }; },
    async update(id, change) { calls.push({ method: 'tabs.update', tabId: id, change }); },
    async remove(id) { calls.push({ method: 'tabs.remove', tabId: id }); tabs.delete(id); },
  }, debugger: {
    async attach(target) { calls.push({ method: 'attach', ...target }); },
    async detach(target) { calls.push({ method: 'detach', ...target }); },
    async sendCommand(target, method, params) {
      calls.push({ method, ...target, params });
      const intercepted = intercept?.(method, params); if (intercepted) return intercepted;
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, url: tabs.get(target.tabId)?.url }] };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0, scale: 1 } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', url: tabs.get(target.tabId).url }, childFrames: [{ frame: { id: 'child', url: 'https://different.test/' } }] } };
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ nodeId: 'a', backendDOMNodeId: 12, role: { value: 'button' }, name: { value: 'Send' } }] };
      if (method === 'DOM.getContentQuads') return { quads: [[0, 0, 20, 0, 20, 20, 0, 20]] };
      if (method === 'Page.captureScreenshot') return { data: 'cG5n' };
      return {};
    },
  } };
  const connector = new TabConnector({ chrome, browserId: 'install', instanceId: 'instance', emit: event => events.push(event), uuid: () => `uuid-${++serial}` });
  let sequence = 0;
  const execute = (id, method, ...args) => connector.execute({ id, sequence: ++sequence, method, args });
  return { connector, calls, events, tabs, execute, setIntercept: value => { intercept = value; } };
}

test('only explicit sharing reveals the real tab; remote attach/open is denied', async () => {
  const f = fixture();
  assert.deepEqual((await f.execute('list0', 'list')).value, []);
  const page = await f.connector.share(7);
  assert.match(page.pageId, /instance:tab:7:uuid-/);
  const list = (await f.execute('list1', 'list')).value;
  assert.deepEqual(list.map(value => value.title), ['Signed in']);
  assert.equal((await f.execute('open', 'open', { url: 'https://other.test' })).effect, 'none');
  assert.equal((await f.execute('other', 'activate', '8')).ok, false);
  assert.equal(f.calls.filter(call => call.tabId === 8).length, 0);
});

test('double share attaches once; detach never closes a user tab and old identity cannot be reused', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.connector.share(7), f.connector.share(7)]);
  assert.equal(a.pageId, b.pageId);
  assert.equal(f.calls.filter(call => call.method === 'attach').length, 1);
  await f.connector.unshare(a.pageId);
  assert.equal(f.tabs.has(7), true);
  assert.equal((await f.execute('old', 'act', a.pageId, { action: 'reload' })).effect, 'none');
  const c = await f.connector.share(7);
  assert.notEqual(c.pageId, a.pageId);
});

test('private/privileged browser pages never attach', async () => {
  const f = fixture();
  for (const state of [{ url: 'chrome://settings' }, { url: 'file:///private' }, { incognito: true }, { url: 'https://user:pass@example.test' }]) {
    f.tabs.set(7, { ...f.tabs.get(7), incognito: false, url: 'https://example.test', ...state });
    await assert.rejects(f.connector.share(7));
  }
  assert.equal(f.calls.some(call => call.method === 'attach'), false);
});

test('read reports unsupported child frames and stale navigation refs reject before input', async () => {
  const f = fixture(); const page = await f.connector.share(7);
  const read = await f.execute('read', 'read', { pageId: page.pageId });
  assert.equal(read.ok, true); assert.equal(read.value.frames[1].available, false);
  const ref = read.value.elements[0].ref;
  f.connector.onEvent({ tabId: 7 }, 'Page.navigatedWithinDocument', { frameId: 'frame' });
  const action = await f.execute('click', 'act', page.pageId, { action: 'click', ref });
  assert.equal(action.effect, 'none'); assert.match(action.error, /stale_reference/);
  assert.equal(f.calls.some(call => call.method === 'Input.dispatchMouseEvent'), false);
});

test('duplicate command IDs during and after input return original receipt without replay', async () => {
  const f = fixture(); const page = await f.connector.share(7); const gate = deferred();
  f.setIntercept(method => method === 'Page.navigate' ? gate.promise : undefined);
  const command = { id: 'send-once', sequence: 1, method: 'act', args: [page.pageId, { action: 'navigate', url: 'https://example.test/submit' }] };
  const first = f.connector.execute(command); const duplicate = f.connector.execute(command);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(call => call.method === 'Page.navigate').length, 1);
  gate.resolve({});
  assert.deepEqual(await first, await duplicate);
  await f.connector.execute(command);
  assert.equal(f.calls.filter(call => call.method === 'Page.navigate').length, 1);
});

test('debugger detach while navigation is in flight returns unknown and never falls back', async () => {
  const f = fixture(); const page = await f.connector.share(7); const gate = deferred();
  f.setIntercept(method => method === 'Page.navigate' ? gate.promise : undefined);
  const action = f.execute('nav', 'act', page.pageId, { action: 'navigate', url: 'https://example.test/submit' });
  await new Promise(resolve => setImmediate(resolve));
  f.connector.detached(7, 'canceled_by_user'); gate.resolve({});
  const receipt = await action;
  assert.equal(receipt.effect, 'unknown'); assert.equal(receipt.ok, false);
  assert.equal(f.events.at(-1).kind, 'closed');
  assert.equal((await f.execute('read-again', 'read', { pageId: page.pageId })).ok, false);
});

test('pause fences queued input; resume invalidates references', async () => {
  const f = fixture(); const page = await f.connector.share(7);
  const { value } = await f.execute('read', 'read', { pageId: page.pageId });
  assert.equal((await f.execute('takeover', 'pause', page.pageId, true)).value, true);
  const paused = await f.execute('paused', 'act', page.pageId, { action: 'reload' });
  assert.equal(paused.effect, 'none'); assert.match(paused.error, /takeover/);
  assert.equal((await f.execute('observe-paused', 'read', { pageId: page.pageId })).ok, true);
  assert.equal((await f.execute('resume', 'pause', page.pageId, false)).value, true);
  assert.equal((await f.execute('stale', 'act', page.pageId, { action: 'click', ref: value.elements[0].ref })).effect, 'none');
});

test('different shared tabs have separate lanes; input commands never target another tab', async () => {
  const f = fixture(); const a = await f.connector.share(7); const b = await f.connector.share(8);
  const read = await f.execute('read', 'read', { pageId: a.pageId });
  assert.equal((await f.execute('wrong-ref', 'act', b.pageId, { action: 'click', ref: read.value.elements[0].ref })).effect, 'none');
  const click = await f.execute('click', 'act', a.pageId, { action: 'click', ref: read.value.elements[0].ref });
  assert.equal(click.ok, true);
  assert.deepEqual(f.calls.filter(call => call.method === 'Input.dispatchMouseEvent').map(call => call.tabId), [7, 7]);
});

test('stop while attach is pending cleans up actual debugger and never restores scope', async () => {
  const f = fixture(); const gate = deferred();
  f.connector.chrome.debugger.attach = () => gate.promise;
  const share = f.connector.share(7);
  await new Promise(resolve => setImmediate(resolve));
  const stop = f.connector.stop(); gate.resolve({});
  await assert.rejects(share); await stop;
  assert.equal(f.connector.pages.size, 0);
  assert.equal(f.calls.some(call => call.method === 'detach'), true);
});

test('capability limits reject raw CDP, evaluate, open and file access', async () => {
  const f = fixture(); const page = await f.connector.share(7);
  for (const action of ['evaluate', 'upload', 'download', 'select', 'drag']) {
    assert.equal((await f.execute(action, 'act', page.pageId, { action, script: 'evil' })).effect, 'none');
    assert.equal(CAPABILITIES.includes(`act:${action}`), false);
  }
  assert.equal((await f.execute('cdp', 'command', page.pageId, 'Network.getAllCookies')).ok, false);
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.permissions, ['activeTab', 'debugger', 'storage']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal(manifest.host_permissions, undefined); assert.equal(manifest.externally_connectable, undefined);
});


test('settled receipt eviction cannot replay input and does not end a long session', async () => {
  const f = fixture(); const page = await f.connector.share(7);
  const command = { id: 'original', sequence: 1, method: 'act', args: [page.pageId, { action: 'reload' }] };
  assert.equal((await f.connector.execute(command)).ok, true);
  for (let sequence = 2; sequence < 100; sequence++) {
    assert.equal((await f.connector.execute({ id: `read-${sequence}`, sequence, method: 'list', args: [] })).ok, true);
  }
  assert.equal(f.connector.receipts.size, 32);
  assert.equal((await f.connector.execute(command)).effect, 'none');
  assert.equal(f.calls.filter(call => call.method === 'Page.reload').length, 1);
  assert.equal(f.connector.stopped, false);
});


test('navigation during node resolution is fenced before any input', async () => {
  const f = fixture(); const page = await f.connector.share(7);
  const read = await f.execute('read', 'read', { pageId: page.pageId });
  f.setIntercept(method => {
    if (method !== 'DOM.describeNode') return undefined;
    f.connector.onEvent({ tabId: 7 }, 'Page.frameNavigated', { frame: { id: 'new' } });
    return Promise.resolve({});
  });
  const result = await f.execute('click', 'act', page.pageId, { action: 'click', ref: read.value.elements[0].ref });
  assert.equal(result.effect, 'none');
  assert.equal(f.calls.some(call => call.method.startsWith('Input.') || call.method === 'DOM.scrollIntoViewIfNeeded'), false);
});
