import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';

// Explicit opt-in: this creates only a temporary test profile, never a user's
// existing profile or debugging port. The fixture drives the production class
// through actual extension debugger APIs; it does not prove installation UX.
test('real Chromium extension reads, types, clicks and revokes a real tab', { skip: !process.env.VARIN_BROWSER_EXECUTABLE, timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-connector-chromium-'));
  const extension = join(directory, 'extension');
  await cp(new URL('../extension/', import.meta.url), extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json')));
  manifest.background.service_worker = 'fixture.mjs';
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(extension, 'fixture.mjs'), `import { TabConnector } from './connector.mjs';
    globalThis.events=[];
    globalThis.connector=new TabConnector({chrome,browserId:'fixture',instanceId:'actual-chromium',emit:e=>events.push(e)});
    chrome.debugger.onDetach.addListener((source,reason)=>connector.detached(source.tabId,reason));
    chrome.debugger.onEvent.addListener((source,method,params)=>connector.onEvent(source,method,params));
    chrome.tabs.onUpdated.addListener((id,change)=>connector.changed(id,change));
  `);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Real tab</title><h1>Fixture</h1><input aria-label="Message"><button onclick="document.title=\'Clicked\'">Submit fixture</button>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const require = createRequire(new URL('../../electron/package.json', import.meta.url));
  const { launch } = require('puppeteer-core');
  let browser;
  try {
    browser = await launch({ executablePath: process.env.VARIN_BROWSER_EXECUTABLE, headless: true, pipe: true,
      userDataDir: join(directory, 'profile'), env: { ...process.env, HOME: directory, XDG_CONFIG_HOME: directory, XDG_CACHE_HOME: directory },
      args: ['--no-sandbox', '--disable-dev-shm-usage', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const target = await browser.waitForTarget(value => value.type() === 'service_worker');
    const worker = await target.worker();
    const address = `http://127.0.0.1:${server.address().port}`;
    const result = await worker.evaluate(async url => {
      const tab = await chrome.tabs.create({ url });
      await new Promise(resolve => {
        const onUpdate = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpdate); resolve(); } };
        chrome.tabs.onUpdated.addListener(onUpdate);
        void chrome.tabs.get(tab.id).then(value => { if (value.status === 'complete') { chrome.tabs.onUpdated.removeListener(onUpdate); resolve(); } });
      });
      const page = await connector.share(tab.id);
      const first = await connector.execute({ id: 'read', sequence: 1, method: 'read', args: [{ pageId: page.pageId }] });
      const input = first.value.elements.find(value => value.role === 'textbox' && value.name === 'Message');
      const typed = await connector.execute({ id: 'type', sequence: 2, method: 'act', args: [page.pageId, { action: 'type', ref: input.ref, text: 'Varin fixture' }] });
      const afterType = await connector.execute({ id: 'read2', sequence: 3, method: 'read', args: [{ pageId: page.pageId }] });
      const button = afterType.value.elements.find(value => value.role === 'button' && value.name === 'Submit fixture');
      const clicked = await connector.execute({ id: 'click', sequence: 4, method: 'act', args: [page.pageId, { action: 'click', ref: button.ref }] });
      const duplicate = await connector.execute({ id: 'click', sequence: 4, method: 'act', args: [page.pageId, { action: 'click', ref: button.ref }] });
      const screenshot = await connector.execute({ id: 'screenshot', sequence: 5, method: 'read', args: [{ pageId: page.pageId, view: 'screenshot' }] });
      await chrome.debugger.detach({ tabId: tab.id });
      // onDetach is a browser event; yield before checking scope.
      await new Promise(resolve => setTimeout(resolve, 30));
      const rejected = await connector.execute({ id: 'late', sequence: 6, method: 'act', args: [page.pageId, { action: 'reload' }] });
      await chrome.tabs.remove(tab.id);
      return { page, first: first.ok, typed, afterType: afterType.value.elements, clicked, duplicate,
        screenshot: { ok: screenshot.ok, width: screenshot.value?.image?.width, height: screenshot.value?.image?.height, error: screenshot.error }, rejected, events };
    }, address);
    assert.equal(result.first, true);
    assert.equal(result.typed.ok, true, JSON.stringify(result.typed));
    assert.equal(result.afterType.some(value => value.value === 'Varin fixture'), true);
    assert.equal(result.clicked.ok, true, JSON.stringify(result.clicked));
    assert.deepEqual(result.clicked, result.duplicate);
    assert.equal(result.clicked.value.page.title, 'Clicked');
    assert.equal(result.screenshot.ok, true, JSON.stringify(result.screenshot));
    assert.ok(result.screenshot.width > 0 && result.screenshot.height > 0);
    assert.equal(result.rejected.effect, 'none');
    assert.equal(result.events.some(value => value.kind === 'closed'), true);
  } finally {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
