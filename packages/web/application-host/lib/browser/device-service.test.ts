import { afterEach, expect, test } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { consumeBrowserFrames } from '@varin/application-client';
import type { BrowserFrame, BrowserCatalog, BrowserPage } from '@varin/protocol';
import { NativeDevice } from './native-device.fixture.js';
import { createNativeShellBrowserOwner } from './native-shell-owner.js';
import { BrowserRegistry } from './registry.js';
import { registerBrowserRoutes, attachBrowserDevices } from './routes.js';
import { browserActor } from './remote-owner.js';
import { deferred } from './device-wire.js';
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
const eventually = async (check: () => boolean) => { for (let i = 0; i < 500 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2)); expect(check()).toBe(true); };
async function fixture(holdAdmission?: 'grant' | 'sockets') {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varin-browser-device-'));
  const native = new NativeDevice(directory), owner = createNativeShellBrowserOwner({ port: native, scratchDirectory: path.join(directory, 'transfers') });
  const hostId = randomUUID(), registry = new BrowserRegistry(hostId), app = express(); app.use(express.json());
  const admissionReached = deferred<void>(), admissionRelease = deferred<void>(), admissionPassed = deferred<void>();
  let held = false;
  const hold = async () => {
    if (held) return;
    held = true; admissionReached.resolve(); await admissionRelease.promise; admissionPassed.resolve();
  };
  if (holdAdmission === 'grant') app.use('/api/browsers/device-grants', (_request, response, next) => {
    const json = response.json.bind(response);
    response.json = value => {
      if (held) return json(value);
      // The real Host has already issued the grant. Delay only its response,
      // so withdrawal also covers an unknown HTTP effect, not just queued work.
      void hold().then(() => json(value)); return response;
    };
    next();
  });
  const authenticate = async (request: { headers: { authorization?: string | undefined } }) => request.headers.authorization === 'Bearer user-token' ? { type: 'session', token: 'trusted-user' }
    : request.headers.authorization === 'Bearer other-token' ? { type: 'session', token: 'other-user' } : request.headers.authorization === 'Bearer readonly-token'
      ? { type: 'client', clientId: 'reader', client: { id: 'reader', profile: 'readonly', capabilities: ['instance:read'] } } : null;
  const server = createServer(app);
  registerBrowserRoutes(app, { browsers: registry, requireAuth: (request, response, next) => { if (request.headers.authorization) next(); else response.sendStatus(401); }, authenticate });
  const transport = attachBrowserDevices({ server, browsers: registry, authenticate, originAllowed: async () => { if (holdAdmission === 'sockets') await hold(); return true; } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(async () => { admissionRelease.resolve(); native.pendingScript.resolve({ result: { type: 'string', value: 'test-cleanup' } }); transport.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await owner.dispose().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  const request = async (route: string, body?: unknown, token = 'user-token') => fetch(`${origin}/api/browsers${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Varin-Browser-Host': hostId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const connect = () => owner.invoke({ command: 'desktop_browser_device', windowLabel: 'main', args: { action: 'connect', expectedHostId: hostId, shareInteractiveProfile: true }, trustedTarget: { apiBaseUrl: origin, clientToken: 'user-token', requestHeaders: {} } });
  return { native, owner, hostId, registry, origin, request, connect, admissionReached: admissionReached.promise,
    releaseAdmission: async () => { admissionRelease.resolve(); await admissionPassed.promise; } };
}
test('explicit Browser grant registers the original device without page creation or Computer permission', async () => {
  const f = await fixture();
  expect((await (await f.request('')).json() as BrowserCatalog).devices).toEqual([]);
  expect((await f.request('', undefined, 'readonly-token')).status).toBe(403);
  await expect(f.owner.invoke({ command: 'desktop_browser_device', windowLabel: 'main', args: { action: 'connect', expectedHostId: f.hostId, shareInteractiveProfile: false }, trustedTarget: {} })).rejects.toThrow('explicit');
  expect(f.native.calls).toEqual([]);
  await f.connect();
  const catalog = await (await f.request('')).json() as BrowserCatalog;
  expect(catalog.devices).toMatchObject([{ browserId: f.owner.browserId, ownerGeneration: f.owner.ownerGeneration, state: 'connected', local: false }]);
  expect(catalog.defaultBrowserId).toBeNull(); expect(f.native.calls).toEqual([]);
  await f.request('/default', { browserId: f.owner.browserId });
  const opened = await (await f.request('/pages', { url: 'https://example.com' })).json() as BrowserPage;
  expect(opened.browserId).toBe(f.owner.browserId); expect((await f.owner.list())[0]?.pageId).toBe(opened.pageId);
  await expect(f.owner.present({ pageId: 'remote-page', viewId: 'view', url: 'https://wrong.example', bounds: { x: 0, y: 0, width: 1, height: 1 }, visible: true }, 'main')).rejects.toThrow('not a local page');
  expect(f.native.calls.filter(call => call.method === 'browser.create')).toHaveLength(1);
});
test('real compositor frames and IME input cross both WebSockets and HTTP while viewer detach preserves the page', async () => {
  const f = await fixture(); await f.connect(); await f.request('/default', { browserId: f.owner.browserId });
  const page = await (await f.request('/pages', { url: 'https://example.com' })).json() as BrowserPage, streamId = randomUUID();
  const abort = new AbortController();
  const response = await fetch(`${f.origin}/api/browsers/pages/${page.pageId}/frames?streamId=${streamId}`, { headers: { Authorization: 'Bearer user-token' }, signal: abort.signal });
  expect(response.headers.get('Content-Type')).toBe('application/x-varin-browser-frames');
  const frames: BrowserFrame[] = [];
  const consuming = consumeBrowserFrames(response.body!, value => frames.push(value), abort.signal).catch(() => {});
  const controlled = await (await f.request(`/pages/${page.pageId}/control`, { streamId, paused: true })).json() as BrowserPage;
  const jpeg = Buffer.from([255, 216, 255, 217]);
  f.native.cdp(page.pageId, 'Page.screencastFrame', { data: jpeg.toString('base64'), sessionId: 9, metadata: { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1 } });
  await eventually(() => frames.length === 1);
  expect(frames[0]?.bytes).toEqual(new Uint8Array(jpeg)); expect(frames[0]?.controlEpoch).toBe(controlled.controlEpoch);
  const base = { pageGeneration: page.generation, streamId, controlEpoch: controlled.controlEpoch, frameSequence: frames[0]!.sequence };
  expect((await f.request(`/pages/${page.pageId}/input`, { ...base, input: { type: 'composition', text: '你好', selectionStart: 2, selectionEnd: 2 } })).status).toBe(200);
  expect((await f.request(`/pages/${page.pageId}/input`, { ...base, input: { type: 'text', text: '你好' } })).status).toBe(200);
  expect(f.native.calls.filter(call => call.params.method === 'Input.imeSetComposition' && (call.params.params as { text?: string })?.text === '你好')).toHaveLength(1);
  expect(f.native.calls.find(call => call.params.method === 'Input.insertText')?.params.params).toEqual({ text: '你好' });
  expect(f.native.calls.find(call => call.params.method === 'Page.screencastFrameAck')?.params.params).toEqual({ sessionId: 9 });
  expect((await f.request(`/pages/${page.pageId}/input`, { ...base, controlEpoch: 'stale', input: { type: 'text', text: 'never' } })).status).toBe(409);
  // Clipboard tickets use the same authenticated viewer and control generation.
  const selection = await f.request(`/pages/${page.pageId}/clipboard`, { ...base, action: 'capture' });
  expect(selection.status).toBe(200); expect(await selection.json()).toBeNull();
  expect((await f.request(`/pages/${page.pageId}/clipboard`, { ...base, action: 'capture' }, 'other-token')).status).toBe(409);
  expect((await f.request(`/pages/${page.pageId}/clipboard`, { ...base, controlEpoch: 'stale', action: 'capture' })).status).toBe(409);
  expect((await f.request(`/pages/${page.pageId}/clipboard`, { ...base, action: 'cut', selectionId: 'invented' })).status).toBe(409);
  abort.abort(); await consuming;
  await eventually(() => f.native.calls.some(call => call.params.method === 'Page.stopScreencast'));
  expect((await f.owner.list())[0]).toMatchObject({ pageId: page.pageId, viewers: 0, agentPaused: true });
  expect(f.native.calls.some(call => call.method === 'browser.close')).toBe(false);
  expect(f.native.calls.filter(call => call.params.method === 'Emulation.setFocusEmulationEnabled').at(-1)?.params.params).toEqual({ enabled: false });
});
test('cancellation waits for the original script completion and revoked access cannot replay it', async () => {
  const f = await fixture(); await f.connect(); await f.request('/default', { browserId: f.owner.browserId });
  const actor = { kind: 'thread' as const, threadId: 'thread', runId: 'run', invocationId: 'invocation' }, browser = f.registry.forActor(actor);
  const page = await browser.open({ url: 'https://example.com' }, { threadId: 'thread' });
  const cancel = new AbortController();
  const execution = browser.act(page.pageId, { action: 'evaluate', script: 'pending-script' }, cancel.signal).catch(error => error);
  await eventually(() => f.native.scriptStarted); cancel.abort();
  const failed = await execution; expect(failed).toMatchObject({ effect: 'unknown', executorStopped: false });
  let stopped = false; void failed.completion.then(() => { stopped = true; });
  expect(stopped).toBe(false);
  f.native.pendingScript.resolve({ result: { type: 'string', value: 'actual-stop' } }); await failed.completion; expect(stopped).toBe(true);
  await browserActor.run({ kind: 'user', principalId: 'trusted-user' }, () => f.registry.revoke(f.owner.browserId));
  await expect(browser.act(page.pageId, { action: 'press', key: 'A' })).rejects.toThrow('unavailable');
  expect(f.native.calls.filter(call => call.params.method === 'Runtime.evaluate' && String((call.params.params as { expression?: string })?.expression).startsWith('pending-script'))).toHaveLength(1);
});

test('another authenticated client cannot forge a disconnected original owner generation', async () => {
  const f = await fixture(); await f.connect();
  const original = (await (await f.request('')).json() as BrowserCatalog).devices[0]!;
  const { RemoteBrowserOwner } = await import('./remote-owner.js');
  const page = await f.owner.open({ url: 'https://example.com' });
  const target = await browserActor.run({ kind: 'user', principalId: 'trusted-user' }, () => f.registry.owner(page.pageId));
  expect(target).toBeInstanceOf(RemoteBrowserOwner); (target as InstanceType<typeof RemoteBrowserOwner>).closeTransport();
  const challenge = await (await f.request('/device-challenges', { ...original, expectedHostId: f.hostId }, 'other-token')).json() as { challengeId: string; challenge: string };
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const forged = generateKeyPairSync('ed25519');
  const response = await f.request('/device-grants', { ...original, expectedHostId: f.hostId, shareInteractiveProfile: true, challengeId: challenge.challengeId,
    publicKey: forged.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signature: sign(null, Buffer.from(JSON.stringify([f.hostId, challenge.challenge])), forged.privateKey).toString('base64') }, 'other-token');
  expect(response.status).toBe(409); expect((await response.json() as { error: string }).error).toContain('identity proof');
  await f.connect(); expect((await (await f.request('')).json() as BrowserCatalog).devices[0]!.state).toBe('connected');
});

test('reconnect followed by local revocation cancels all old Host grants and recovers only actual stop', async () => {
  const f = await fixture(); await f.connect(); await f.request('/default', { browserId: f.owner.browserId });
  const browser = f.registry.forActor({ kind: 'thread', threadId: 'original-thread', runId: 'run', invocationId: 'call' });
  const page = await browser.open({ url: 'https://example.com' }, { threadId: 'original-thread' });
  const pending = browser.act(page.pageId, { action: 'evaluate', script: 'pending-script' }).catch(error => error);
  await eventually(() => f.native.scriptStarted);
  const remote = await browserActor.run({ kind: 'user', principalId: 'trusted-user' }, () => f.registry.owner(page.pageId));
  (remote as import('./remote-owner.js').RemoteBrowserOwner).closeTransport();
  const unknown = await pending; expect(unknown).toMatchObject({ effect: 'unknown', executorStopped: false });
  await eventually(() => f.registry.available() === false);
  for (let i = 0; i < 500; i++) { const status = await f.owner.invoke({ command: 'desktop_browser_device', windowLabel: 'main', args: { action: 'status' } }) as { connections: { state: string }[] }; if (status.connections[0]?.state === 'disconnected') break; await new Promise(resolve => setTimeout(resolve, 2)); }
  await f.connect();
  let revoked = false, stopped = false;
  void unknown.completion.then(() => { stopped = true; });
  const revoke = f.owner.invoke({ command: 'desktop_browser_device', windowLabel: 'main', args: { action: 'disconnect', expectedHostId: f.hostId } }).then(() => { revoked = true; });
  await eventually(() => f.native.calls.some(call => call.params.method === 'Runtime.terminateExecution'));
  expect(revoked).toBe(false); expect(stopped).toBe(false);
  await expect(f.connect()).rejects.toThrow('still being revoked');
  f.native.pendingScript.resolve({ result: { type: 'string', value: 'original-terminal' } });
  await revoke; await unknown.completion; expect(revoked).toBe(true); expect(stopped).toBe(true);
  expect(f.native.calls.filter(call => call.params.method === 'Runtime.evaluate' && String((call.params.params as { expression?: string })?.expression).startsWith('pending-script'))).toHaveLength(1);
});

test('identity challenges bind the authenticated principal, selected Host and single-use proof', async () => {
  const f = await fixture();
  const identity = { deviceId: randomUUID(), browserId: f.owner.browserId, ownerGeneration: f.owner.ownerGeneration, label: 'original' };
  expect((await f.request('/device-challenges', { ...identity, expectedHostId: 'another-host' })).status).toBe(409);
  const issue = async () => {
    const challenge = await (await f.request('/device-challenges', { ...identity, expectedHostId: f.hostId })).json() as { challengeId: string; challenge: string };
    return { ...identity, expectedHostId: f.hostId, shareInteractiveProfile: true, challengeId: challenge.challengeId, ...f.owner.proveIdentity(f.hostId, challenge.challenge) };
  };
  const stolen = await issue();
  expect((await f.request('/device-grants', stolen, 'other-token')).status).toBe(409);
  const valid = await issue();
  const response = await f.request('/device-grants', valid); expect(response.status).toBe(200);
  const grant = await response.json() as { controlToken: string; mediaToken: string };
  expect((await f.request('/device-grants', valid)).status).toBe(409);
  const { WebSocket } = await import('ws');
  const rejected = (lane: string, token: string, principal: string, hostId: string) => new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${f.origin.replace('http:', 'ws:')}/api/browsers/devices/${lane}`, { headers: { Authorization: `Bearer ${principal}`, 'X-Varin-Browser-Host': hostId, 'X-Varin-Browser-Grant': token } });
    socket.on('error', () => {});
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); socket.terminate(); });
    socket.once('open', () => { socket.terminate(); reject(new Error('An unauthorized Browser device socket was accepted')); });
  });
  expect(await rejected('control', grant.controlToken, 'other-token', f.hostId)).toBe(403);
  expect(await rejected('media', grant.mediaToken, 'other-token', f.hostId)).toBe(403);
  expect(await rejected('control', grant.controlToken, 'user-token', 'another-host')).toBe(403);
});

test('another valid Browser owner cannot forge recovery of an original disconnected executor', async () => {
  const f = await fixture();
  const { generateKeyPairSync, createHash, sign } = await import('node:crypto');
  const { WebSocket } = await import('ws');
  const { BrowserDeviceWire, deferred } = await import('./device-wire.js');
  const connect = async () => {
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'der' });
    const ownerGeneration = createHash('sha256').update(publicKey).digest('hex');
    const identity = { deviceId: randomUUID(), browserId: `varin:browser:${ownerGeneration}`, ownerGeneration, label: 'test-device', expectedHostId: f.hostId };
    const challenge = await (await f.request('/device-challenges', identity)).json() as { challengeId: string; challenge: string };
    const grant = await (await f.request('/device-grants', { ...identity, shareInteractiveProfile: true, challengeId: challenge.challengeId, publicKey: publicKey.toString('base64'),
      signature: sign(null, Buffer.from(JSON.stringify([f.hostId, challenge.challenge])), keys.privateKey).toString('base64') })).json() as { grantId: string; controlToken: string; mediaToken: string };
    const socket = (lane: string, token: string) => new WebSocket(`${f.origin.replace('http:', 'ws:')}/api/browsers/devices/${lane}`, { headers: { Authorization: 'Bearer user-token', 'X-Varin-Browser-Host': f.hostId, 'X-Varin-Browser-Grant': token } });
    const wire = new BrowserDeviceWire(socket('control', grant.controlToken), socket('media', grant.mediaToken));
    const ready = deferred<void>(), closed = deferred<void>(), calls: Record<string, unknown>[] = [];
    wire.onMessage = message => { if (message.kind === 'connected') ready.resolve(); else calls.push(message); };
    wire.onClose = () => closed.resolve();
    cleanup.push(async () => wire.close());
    await ready.promise; return { wire, closed, calls, grant, identity };
  };
  const original = await connect(); f.registry.select(original.identity.browserId);
  const pending = f.registry.forActor({ kind: 'thread', threadId: 'thread', runId: 'run', invocationId: 'call' }).open({ url: 'https://example.com' }, {}).catch(error => error);
  await eventually(() => original.calls.some(message => message.method === 'open'));
  const call = original.calls.find(message => message.method === 'open')!;
  original.wire.close();
  const unknown = await pending; expect(unknown).toMatchObject({ effect: 'unknown', executorStopped: false });
  let stopped = false; void unknown.completion.then(() => { stopped = true; });
  const attacker = await connect();
  await attacker.wire.send({ kind: 'recovered-stop', originalGrantId: original.grant.grantId, requestId: call.requestId, leaseId: call.leaseId, executorStopped: true });
  await attacker.closed.promise;
  expect(stopped).toBe(false);
});

test('remote revocation after reconnect also drains the original disconnected script', async () => {
  const f = await fixture(); await f.connect(); await f.request('/default', { browserId: f.owner.browserId });
  const browser = f.registry.forActor({ kind: 'thread', threadId: 'thread', runId: 'run', invocationId: 'call' });
  const page = await browser.open({ url: 'https://example.com' }, {});
  const pending = browser.act(page.pageId, { action: 'evaluate', script: 'pending-script' }).catch(error => error);
  await eventually(() => f.native.scriptStarted);
  const remote = await f.registry.owner(page.pageId);
  (remote as import('./remote-owner.js').RemoteBrowserOwner).closeTransport();
  const unknown = await pending;
  await f.connect();
  let revoked = false, stopped = false;
  void unknown.completion.then(() => { stopped = true; });
  const revoke = f.request(`/devices/${encodeURIComponent(f.owner.browserId)}/revoke`, {}).then(response => { expect(response.status).toBe(200); revoked = true; });
  await eventually(() => f.native.calls.some(call => call.params.method === 'Runtime.terminateExecution'));
  expect(revoked).toBe(false); expect(stopped).toBe(false);
  await expect(f.connect()).rejects.toThrow('still being revoked');
  f.native.pendingScript.resolve({ result: { type: 'string', value: 'original-terminal' } });
  await revoke; await unknown.completion;
  expect(stopped).toBe(true);
  expect(f.native.calls.filter(call => call.params.method === 'Runtime.evaluate' && String((call.params.params as { expression?: string })?.expression).startsWith('pending-script'))).toHaveLength(1);
});


for (const stage of ['grant', 'sockets'] as const) {
  for (const withdrawal of ['disconnect', 'dispose'] as const) {
    test(`${withdrawal} cancels an unfinished real ${stage} admission before it can publish`, async () => {
      const f = await fixture(stage);
      const connecting = f.connect().then(() => null, error => error as Error);
      await f.admissionReached;
      await expect(f.connect()).rejects.toThrow('already being authorized');
      if (withdrawal === 'dispose') await f.owner.dispose();
      else await f.owner.invoke({ command: 'desktop_browser_device', windowLabel: 'main', args: { action: 'disconnect', expectedHostId: f.hostId } });
      expect(await connecting).toBeInstanceOf(Error);
      await f.releaseAdmission();
      expect((await (await f.request('')).json() as BrowserCatalog).devices.every(device => device.state !== 'connected')).toBe(true);
      expect(f.native.calls).toEqual([]);
      if (withdrawal === 'dispose') await expect(f.connect()).rejects.toThrow('disposed');
      else {
        await f.connect();
        const catalog = await (await f.request('')).json() as BrowserCatalog;
        expect(catalog.devices).toMatchObject([{ browserId: f.owner.browserId, state: 'connected' }]);
        const original = catalog.devices[0]!.grantId;
        await f.connect();
        expect((await (await f.request('')).json() as BrowserCatalog).devices[0]!.grantId).toBe(original);
      }
    });
  }
}


test('withdrawing another Host does not cancel this original pending authorization', async () => {
  const f = await fixture('grant');
  const connecting = f.connect();
  await f.admissionReached;
  await f.owner.invoke({ command: 'desktop_browser_device', windowLabel: 'main', args: { action: 'disconnect', expectedHostId: randomUUID() } });
  await f.releaseAdmission(); await connecting;
  expect((await (await f.request('')).json() as BrowserCatalog).devices).toMatchObject([{ browserId: f.owner.browserId, state: 'connected' }]);
});
