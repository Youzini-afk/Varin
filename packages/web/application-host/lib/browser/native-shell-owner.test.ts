import { NativeDevice } from './native-device.fixture.js';
import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeShellBrowserOwner } from './native-shell-owner.js';
import type { NativeBrowserOwner } from './native-owner.js';
const eventually = async (check: () => boolean) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 1)); expect(check()).toBe(true); };
const resources: Array<{ directory: string; owner: NativeBrowserOwner }> = [];
afterEach(async () => { for (const { owner, directory } of resources.splice(0)) { await owner.dispose().catch(() => {}); await rm(directory, { recursive: true, force: true }); } });

/** Only native device IO is simulated. The owner, Puppeteer Page, CDP transport,
 * download staging and screenshot integrity checks are production code. */

async function setup() { const directory = await mkdtemp(path.join(os.tmpdir(), 'varin-native-browser-')); const device = new NativeDevice(directory); const owner = createNativeShellBrowserOwner({ port: device, scratchDirectory: directory }); resources.push({ directory, owner }); return { device, owner, directory }; }

test('lazy owner uses real Puppeteer navigation and remounts the same page without reloading', async () => {
  const { device, owner } = await setup(); expect(device.calls).toEqual([]);
  const opened = await owner.open({ url: 'https://example.com' }, { threadId: 'thread-a' }); expect(opened.url).toBe('https://example.com/');
  expect(device.calls.filter(call => call.method === 'browser.create')).toHaveLength(1);
  const navigations = device.calls.filter(call => call.params.method === 'Page.navigate').length;
  await owner.invoke({ command: 'desktop_browser_present', windowLabel: 'main', args: { pageId: opened.pageId, viewId: 'view', url: 'https://do-not-reload.example', bounds: { x: 0, y: 0, width: 500, height: 400 }, visible: true } });
  await owner.detach(opened.pageId, 'view', 'main');
  await owner.present({ pageId: opened.pageId, viewId: 'mini-view', url: 'about:blank', bounds: { x: 0, y: 0, width: 300, height: 200 }, visible: true }, 'mini');
  expect(device.calls.filter(call => call.params.method === 'Page.navigate')).toHaveLength(navigations);
  await owner.releaseThread('thread-a'); expect(await owner.list()).toHaveLength(1); expect(device.calls.some(call => call.method === 'browser.close')).toBe(false);
  await expect(owner.invoke({ command: 'desktop_browser_action', windowLabel: 'main', args: { pageId: opened.pageId, action: { action: 'invented' } } })).rejects.toThrow('Invalid');
});

test('screenshots verify native bytes and stale observations reject coordinate input before dispatch', async () => {
  const { device, owner, directory } = await setup(); const opened = await owner.open({ url: 'https://example.com' }, {});
  const observation = await owner.read({ pageId: opened.pageId, view: 'screenshot' }); expect(observation.image?.width).toBe(1); expect(observation.image?.base64).toBeTruthy();
  await expect(readFile(path.join(directory, 'capture.png'))).rejects.toThrow();
  device.emit({ kind: 'input', pageId: opened.pageId });
  await expect(owner.act(opened.pageId, { action: 'click', point: { x: 0, y: 0 }, observationId: observation.observationId })).rejects.toMatchObject({ effect: 'none' });
  expect(device.calls.some(call => call.params.method === 'Input.dispatchMouseEvent')).toBe(false);
  const fresh = await owner.read({ pageId: opened.pageId, view: 'screenshot' }); await owner.act(opened.pageId, { action: 'click', point: { x: 0, y: 0 }, observationId: fresh.observationId });
  expect(device.calls.some(call => call.params.method === 'Input.dispatchMouseEvent')).toBe(true);
  device.badCapture = true; await expect(owner.read({ pageId: opened.pageId, view: 'screenshot' })).rejects.toThrow('integrity mismatch'); await expect(readFile(path.join(directory, 'capture.png'))).rejects.toThrow();
});

test('cancelled pending script retains its real completion and blocks subsequent input', async () => {
  const { device, owner } = await setup(); const opened = await owner.open({ url: 'https://example.com' }, {}); const cancellation = new AbortController();
  const execution = owner.act(opened.pageId, { action: 'evaluate', script: 'pending-script' }, cancellation.signal).catch(error => error);
  await eventually(() => device.scriptStarted); cancellation.abort(new Error('cancel requested'));
  expect(await execution).toMatchObject({ effect: 'unknown', executorStopped: false }); expect((await owner.list())[0]?.scriptPending).toBe(true);
  let nextFinished = false; const next = owner.act(opened.pageId, { action: 'press', key: 'A' }).then(() => { nextFinished = true; });
  await new Promise(resolve => setTimeout(resolve, 5)); expect(nextFinished).toBe(false);
  device.pendingScript.resolve({ result: { type: 'string', value: 'original-completion' } }); await next;
  expect((await owner.list())[0]?.scriptPending).toBeUndefined(); expect(device.calls.filter(call => call.params.method === 'Runtime.terminateExecution')).toHaveLength(1);
});

test('queued cancellation stays undispatched and pipe loss never certifies executor stop', async () => {
  const { device, owner } = await setup(); const opened = await owner.open({ url: 'https://example.com' }, {});
  const original = owner.act(opened.pageId, { action: 'evaluate', script: 'pending-script' }).catch(error => error); await eventually(() => device.scriptStarted);
  const cancellation = new AbortController(); const queued = owner.act(opened.pageId, { action: 'press', key: 'A' }, cancellation.signal).catch(error => error); cancellation.abort();
  expect(await queued).toMatchObject({ effect: 'none', executorStopped: true }); expect(device.calls.some(call => call.params.method === 'Input.dispatchKeyEvent')).toBe(false);
  for (const listener of device.listeners) listener('browser.native.disconnected', null);
  expect(await original).toMatchObject({ effect: 'unknown', executorStopped: false }); await expect(owner.act(opened.pageId, { action: 'press', key: 'B' })).rejects.toThrow('disconnected');
});

test('downloads use original private staging, enforce page identity and release real bytes', async () => {
  const { device, owner } = await setup(); const opened = await owner.open({ url: 'https://example.com' }, {});
  device.emit({ kind: 'download-start', pageId: opened.pageId, downloadId: 'native-download', name: '../report.txt', url: 'https://example.com/report', receivedBytes: 0, totalBytes: 14, state: 'progressing' });
  const download = (await owner.downloads(opened.pageId))[0]!; expect(download.name).toBe('report.txt');
  await owner.act(opened.pageId, { action: 'wait', condition: 'download', downloadId: download.downloadId, timeoutMs: 1000 });
  await expect(owner.readDownload('another-page', download.downloadId)).rejects.toThrow('does not belong');
  expect(Buffer.from((await owner.readDownload(opened.pageId, download.downloadId)).bytes).toString()).toBe('download bytes');
  const file = String(device.calls.find(call => call.method === 'browser.download.save')!.params.filePath); await owner.releaseDownload(opened.pageId, download.downloadId);
  await expect(readFile(file)).rejects.toThrow(); expect(await owner.downloads(opened.pageId)).toEqual([]);
});

test('web rendering selects a distinct native request context and closes only its transient page', async () => {
  const { device, owner } = await setup();
  const interactive = await owner.open({ url: 'https://example.com' }, {});
  const rendered = await owner.invoke({ command: 'desktop_web_render', args: { url: 'https://public.example', timeoutMs: 3000 } });
  expect(rendered).toMatchObject({ html: '<html><body>isolated</body></html>', timedOut: false });
  const created = device.calls.filter(call => call.method === 'browser.create');
  expect(created.map(call => call.params.requestContext)).toEqual(['interactive', 'web-render']);
  expect(device.calls.filter(call => call.method === 'browser.close').map(call => call.params.pageId)).toEqual([created[1]!.params.pageId]);
  expect((await owner.list()).map(page => page.pageId)).toEqual([interactive.pageId]);
});

test('release and page close retain the file until the actual native download terminal event', async () => {
  const {device,owner}=await setup(); device.holdDownload=true;
  const opened=await owner.open({url:'https://example.com'});
  device.emit({kind:'download-start',pageId:opened.pageId,downloadId:'held',name:'report.txt',url:'https://example.com/report',receivedBytes:0,totalBytes:14,state:'progressing'});
  await eventually(()=>device.calls.some(call=>call.method==='browser.download.save'));
  const file=String(device.calls.find(call=>call.method==='browser.download.save')!.params.filePath);
  let closed=false;const closing=owner.close(opened.pageId).then(()=>{closed=true;});
  await eventually(()=>device.calls.some(call=>call.method==='browser.download.cancel'));
  expect(closed).toBe(false);expect(device.calls.some(call=>call.method==='browser.close')).toBe(false);
  expect((await readFile(file)).toString()).toBe('download bytes');
  device.emit({kind:'download-progress',downloadId:'held',state:'interrupted',receivedBytes:14});
  await new Promise(resolve=>setImmediate(resolve));expect(closed).toBe(false);
  device.emit({kind:'download-progress',downloadId:'held',state:'cancelled',receivedBytes:14,terminal:true});
  await closing;expect(closed).toBe(true);await expect(readFile(file)).rejects.toThrow();
  expect(device.calls.findIndex(call=>call.method==='browser.download.cancel')).toBeLessThan(device.calls.findIndex(call=>call.method==='browser.close'));
});
test('losing the private pipe rejects download release without deleting unconfirmed staging', async () => {
  const {device,owner}=await setup();device.holdDownload=true;
  const opened=await owner.open({url:'https://example.com'});
  device.emit({kind:'download-start',pageId:opened.pageId,downloadId:'lost',name:'report.txt',url:'https://example.com/report',receivedBytes:0,state:'progressing'});
  await eventually(()=>device.calls.some(call=>call.method==='browser.download.save'));
  const file=String(device.calls.find(call=>call.method==='browser.download.save')!.params.filePath);
  const download=(await owner.downloads(opened.pageId))[0]!;
  const releasing=owner.releaseDownload(opened.pageId,download.downloadId);
  await eventually(()=>device.calls.some(call=>call.method==='browser.download.cancel'));
  for(const listener of device.listeners)listener('browser.native.disconnected',null);
  await expect(releasing).rejects.toThrow('termination is unknown');
  expect((await readFile(file)).toString()).toBe('download bytes');expect(await owner.downloads(opened.pageId)).toHaveLength(1);
});
