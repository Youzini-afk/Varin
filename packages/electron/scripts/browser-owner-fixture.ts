import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ElectronBrowserOwner } from '../browser-owner.js';

const output = process.argv[2]!;
const root = process.argv[3] ?? mkdtempSync(path.join(os.tmpdir(), 'varin-browser-owner-test-'));
app.setPath('userData', path.join(root, 'profile'));
app.on('window-all-closed', () => {});
const server = createServer((request, response) => {
  if (request.url === '/download') {
    response.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="report.csv"' });
    response.end('month,value\nOctober,42\n'); return;
  }
  if (request.url === '/frame') { response.end('<button onclick="this.textContent=\'Frame clicked\'">Frame action</button>'); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>Browser owner fixture</title><style>body{min-height:2000px}</style>
    <button id="button" onclick="window.nativeClick=event.isTrusted;this.textContent='Done'">Run action</button>
    <input aria-label="Title"><select aria-label="Region"><option value="a">A</option><option value="b">B</option></select>
    <input type="checkbox" aria-label="Flag"><input type="file" aria-label="Attachment" onchange="window.selectedFile=this.files[0].name">
    <a href="/download">Download report</a><button onclick="alert('Page dialog')">Dialog</button>
    <div id="shadow"></div><iframe src="/frame"></iframe>
    <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button onclick="this.textContent=\\'Shadow clicked\\'">Shadow action</button>';</script>`);
});
async function run() {
  await app.whenReady();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/`;
  const owner = new ElectronBrowserOwner({ scratchDirectory: path.join(root, 'transfers'), partition: 'varin-browser-owner-test' });
  let window: BrowserWindow | undefined;
  const result: Record<string, unknown> = {};
  const mark = (stage: string) => { result.stage = stage; writeFileSync(output, JSON.stringify(result)); };
  try {
    mark('opening');
    const page = await owner.open({ url }, { threadId: 'fixture' });
    mark('reading');
    assert.equal(page.url, url);
    const find = async (name: string) => {
      const state = await owner.read({ pageId: page.pageId, view: 'find', query: name });
      const element = state.elements?.find(item => item.name === name); assert(element?.ref, `Missing element: ${name}`); return element.ref;
    };
    const click = await find('Run action');
    mark('native-input');
    await owner.act(page.pageId, { action: 'click', ref: click });
    mark('typing');
    const clicked = (await owner.act(page.pageId, { action: 'evaluate', script: '({trusted:window.nativeClick,text:document.querySelector("button").textContent,viewport:[innerWidth,innerHeight],rect:document.querySelector("button").getBoundingClientRect().toJSON(),focus:document.hasFocus()})' })).value;
    result.clicked = clicked; mark('click-result');
    assert.equal((clicked as { trusted?: boolean }).trusted, true, JSON.stringify(clicked));
    const input = await find('Title');
    await owner.act(page.pageId, { action: 'type', ref: input, text: 'first' });
    await owner.act(page.pageId, { action: 'type', ref: input, text: '替换内容', replace: true });
    assert.equal((await owner.act(page.pageId, { action: 'evaluate', script: 'document.querySelector("input").value' })).value, '替换内容');
    await owner.act(page.pageId, { action: 'select', ref: await find('Region'), values: ['b'] });
    await owner.act(page.pageId, { action: 'check', ref: await find('Flag'), checked: true });
    mark('shadow-and-frames');
    await owner.act(page.pageId, { action: 'click', ref: await find('Shadow action') });
    await owner.act(page.pageId, { action: 'click', ref: await find('Frame action') });
    assert((await owner.read({ pageId: page.pageId, view: 'find', query: 'Frame clicked' })).elements?.length);
    result.nativeInputAndFrames = true;
    mark('presentation');

    window = new BrowserWindow({ show: false });
    await owner.present({ pageId: page.pageId, viewId: 'first', url, visible: true, bounds: { x: 0, y: 0, width: 900, height: 700 } }, window);
    owner.detach(page.pageId, 'first', window);
    assert.equal((await owner.act(page.pageId, { action: 'evaluate', script: 'document.querySelector("input").value' })).value, '替换内容');
    await owner.present({ pageId: page.pageId, viewId: 'second', url, visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } }, window);
    owner.takeControl(page.pageId, true);
    await assert.rejects(owner.act(page.pageId, { action: 'click', ref: click }), { effect: 'none' });
    owner.takeControl(page.pageId, false);
    result.pageReuseAndControl = true;
    mark('dialog');
    owner.subscribe(event => { if (event.kind === 'dialog') mark('dialog-event'); });
    const dialogButton = await find('Dialog'); mark('dialog-click');
    await owner.act(page.pageId, { action: 'click', ref: dialogButton });
    mark('dialog-open');
    assert.equal((await owner.list())[0]?.dialog?.message, 'Page dialog');
    await owner.act(page.pageId, { action: 'dialog', accept: true });
    mark('screenshot');
    const image = await owner.read({ pageId: page.pageId, view: 'screenshot' }); assert(image.image?.base64);
    mark('coordinate-check');
    owner.layout(page.pageId, 'second', window, { x: 0, y: 0, width: 700, height: 500 }, true);
    await assert.rejects(owner.act(page.pageId, { action: 'click', point: { x: 3, y: 3 }, observationId: image.observationId }), /observation_stale/);
    result.dialogAndCoordinateIdentity = true;
    mark('files');
    const downloaded = new Promise<string>(resolve => { const stop = owner.subscribe(event => {
      if (event.kind === 'download' && event.download.state === 'completed') { stop(); resolve(event.download.downloadId); }
    }); });
    await owner.act(page.pageId, { action: 'click', ref: await find('Download report') });
    const downloadId = await downloaded;
    const bytes = await owner.readDownload(page.pageId, downloadId); assert.equal(Buffer.from(bytes.bytes).toString(), 'month,value\nOctober,42\n');
    await owner.upload(page.pageId, await find('Attachment'), [{ name: bytes.name, bytes: bytes.bytes }]);
    assert.equal((await owner.act(page.pageId, { action: 'evaluate', script: 'window.selectedFile' })).value, 'report.csv');
    await owner.releaseDownload(page.pageId, downloadId); assert.equal((await owner.downloads(page.pageId)).length, 0);
    result.downloadUpload = true;

    mark('cancellation');
    const waiting = new AbortController(), queued = new AbortController();
    const activeWait = owner.act(page.pageId, { action: 'wait', condition: 'url', url: 'https://never.invalid/' }, waiting.signal);
    const queuedCall = owner.act(page.pageId, { action: 'type', text: 'must not type' }, queued.signal);
    queued.abort(); await assert.rejects(queuedCall, { effect: 'none' });
    waiting.abort(); await assert.rejects(activeWait, { effect: 'none' });
    mark('cancel-running-script');
    const script = new AbortController();
    const running = owner.act(page.pageId, { action: 'evaluate', script: 'while(true) {}' }, script.signal);
    const cancelScript = setTimeout(() => script.abort(), 100);
    await assert.rejects(running, { effect: 'unknown' }); clearTimeout(cancelScript);
    mark('cancel-pending-promise');
    const pending = new AbortController();
    const promise = owner.act(page.pageId, { action: 'evaluate', script: 'new Promise(() => {})' }, pending.signal);
    const cancelPromise = setTimeout(() => pending.abort(), 100);
    const pendingError = await promise.catch(error => error);
    assert.equal(pendingError.effect, 'unknown'); assert.equal(pendingError.executorStopped, false); clearTimeout(cancelPromise);
    assert.equal((await owner.list())[0]?.scriptPending, true);
    await owner.act(page.pageId, { action: 'navigate', url: url + '?revision=2' }, undefined, true); await pendingError.completion;
    assert.equal((await owner.list())[0]?.scriptPending, undefined);
    owner.takeControl(page.pageId, false);
    result.cancellation = true;
    await assert.rejects(owner.act(page.pageId, { action: 'click', ref: click }), /ref_stale/);
    await owner.close(page.pageId); assert.equal((await owner.list()).length, 0);
    result.navigationAndCleanup = true;
    writeFileSync(output, JSON.stringify(result));
  } finally {
    await owner.dispose(); window?.destroy(); server.close();
  }
}
void run().then(() => app.exit(0), error => { writeFileSync(output, JSON.stringify({ root, error: String(error.stack ?? error) })); app.exit(1); });
