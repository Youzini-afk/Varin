import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSettingsFileStore } from '@varin/settings-store';
import { createDesktopConnections, getOrCreateDesktopInstallId, isKnownLocalDesktopUrl, type DesktopConnectionFetch } from './desktop-connections.js';
import { createDesktopPlatformOwner } from './desktop-platform.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const compatible = { status: 'ok', compatibility: { capabilities: ['api.runtime-url.v1'], apiVersion: 1, minClientApiVersion: 1 } };
const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), init);
function owner(fetch: DesktopConnectionFetch, local = false) {
  return createDesktopConnections({ fetch, getInstallId: async () => 'original-install', deviceMetadata: () => ({ devicePlatform: 'linux', appVersion: '0.9.37' }), isLocalRuntimeUrl: () => local });
}
it('checks unauthenticated health identity before any token or gateway header', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const service = owner(async (url, init) => { calls.push({ url, init }); return json({ serverId: 'different-machine' }); });
  expect(await service.probeHostWithTimeout('https://selected.test/', 50, 'private-token', { 'X-Gateway': 'private-gateway' }, 'original-machine')).toMatchObject({ status: 'wrong-service' });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://selected.test/health');
  expect([...new Headers(calls[0]!.init.headers)]).toEqual([['accept', 'application/json']]);
});
it('preserves old health compatibility, header screening, runtime capability and session gates', async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const service = owner(async (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) });
    return url.endsWith('/health') ? json({ status: 'ok' }) : url.endsWith('/api/version') ? json(compatible) : json({ ok: true });
  });
  expect(await service.probeHostWithTimeout('https://selected.test/base', 50, ' valid-token ', { Authorization: 'injected', 'X-Gateway': 'gateway', 'bad:name': 'rejected', 'X-Bad': 'bad\r\nheader' }, 'known')).toMatchObject({ status: 'ok' });
  expect(calls.map(call => call.url)).toEqual(['https://selected.test/base/health', 'https://selected.test/base/api/version', 'https://selected.test/base/auth/session']);
  expect(calls[1]!.headers.get('authorization')).toBe('Bearer valid-token');
  expect(calls[1]!.headers.get('x-gateway')).toBe('gateway');expect(calls[1]!.headers.has('x-bad')).toBe(false);
  for (const [payload, status] of [[{}, 'wrong-service'], [{ ...compatible, compatibility: { capabilities: [] } }, 'incompatible'], [{ ...compatible, compatibility: { ...compatible.compatibility, minClientApiVersion: 2 } }, 'update-recommended']] as const) {
    expect(await owner(async () => json(payload)).probeHostWithTimeout('https://selected.test', 50)).toMatchObject({ status });
  }
  expect(await owner(async url => url.endsWith('/api/version') ? json(compatible) : json({}, { status: 401 })).probeHostWithTimeout('https://selected.test', 50)).toMatchObject({ status: 'auth' });
});
it('keeps stable desktop identity and legacy session-cookie to client-token fallback', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const service = owner(async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/auth/session') ? json({}, { headers: [['set-cookie', 'session=legacy; HttpOnly; Path=/'], ['set-cookie', 'unrelated=value; Path=/']] }) : json({ token: ' final-token ' });
  });
  expect(await service.loginRemoteAndIssueClientToken({ url: 'https://selected.test/base', password: 'private-password', requestHeaders: { 'X-Gateway': 'gateway' }, trustDevice: true })).toEqual({ ok: true, token: 'final-token' });
  const login = JSON.parse(String(calls[0]!.init.body));const mint = JSON.parse(String(calls[1]!.init.body));
  expect(login).toMatchObject({ password: 'private-password', trustDevice: true, issueClientToken: true, clientKind: 'desktop', dedupeKey: 'desktop:original-install' });
  expect(mint).toMatchObject({ label: 'Varin Desktop', clientKind: 'desktop', dedupeKey: login.dedupeKey });expect(mint).not.toHaveProperty('password');
  expect(new Headers(calls[1]!.init.headers).get('cookie')).toBe('session=legacy; unrelated=value');
  expect(calls.map(call => call.url)).toEqual(['https://selected.test/auth/session', 'https://selected.test/api/client-auth/clients']);
});
it('never forwards passwords, bearer tokens or custom headers to a redirected origin', async () => {
  const calls: string[] = [];
  const service = owner(async url => { calls.push(url); return new Response(null, { status: 307, headers: { location: 'https://attacker.test/collect' } }); });
  await expect(service.loginRemoteAndIssueClientToken({ url: 'https://selected.test', password: 'private-password', requestHeaders: { 'X-Gateway': 'private-gateway' }, trustDevice: false })).rejects.toThrow('outside the selected Host');
  expect(await service.probeHostWithTimeout('https://selected.test', 50, 'private-token', { 'X-Gateway': 'private-gateway' })).toMatchObject({ status: 'unreachable' });
  expect(calls).toEqual(['https://selected.test/auth/session', 'https://selected.test/api/version']);
});
it('follows bounded same-origin redirects without changing the stable login identity', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const service = owner(async (url, init) => { calls.push({ url, init }); return calls.length === 1 ? new Response(null, { status: 307, headers: { location: '/auth/new-session' } }) : json({ clientToken: 'direct-token' }); }, true);
  expect(await service.loginRemoteAndIssueClientToken({ url: 'http://127.0.0.1:57123', password: 'password', requestHeaders: {}, trustDevice: false })).toEqual({ ok: true, token: 'direct-token' });
  expect(calls[1]!.init.body).toBe(calls[0]!.init.body);expect(calls[1]!.init.redirect).toBe('manual');
  expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ clientKind: 'desktop-local', dedupeKey: 'desktop-local' });
});
it('uses the existing transactional install identity and ignores renderer local-origin claims', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-desktop-connections-')); roots.push(root);
  const settings = createSettingsFileStore({ filePath: path.join(root, 'settings.json') });
  const ids = await Promise.all(Array.from({ length: 8 }, () => getOrCreateDesktopInstallId(settings)));
  expect(new Set(ids).size).toBe(1);expect(ids[0]).toBe(settings.readSync().desktopInstallId);
  let body: unknown;
  const platform = createDesktopPlatformOwner({ settings, getLocalOrigin: () => null, appVersion: '0.9.37', fetch: async (_url, init) => { body = JSON.parse(String(init.body));return json({ clientToken: 'token' }); } });
  await platform.invoke({ command: 'desktop_remote_password_login', args: { url: 'http://127.0.0.1:57123', password: 'private', localOrigin: 'http://127.0.0.1:57123' } });
  expect(body).toMatchObject({ clientKind: 'desktop', dedupeKey: `desktop:${ids[0]}` });
  expect(isKnownLocalDesktopUrl('http://localhost:57123', 'http://127.0.0.1:57123')).toBe(true);
  expect(isKnownLocalDesktopUrl('http://127.0.0.1:57124', 'http://127.0.0.1:57123')).toBe(false);
  await expect(platform.invoke({ command: 'arbitrary' })).rejects.toThrow('Unknown');
});
it('cancels unused native response bodies before returning an HTTP failure', async () => {
  let cancelled = false;
  const service = owner(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 403 }));
  expect(await service.probeHostWithTimeout('https://selected.test', 50)).toMatchObject({ status: 'auth' });expect(cancelled).toBe(true);
});
