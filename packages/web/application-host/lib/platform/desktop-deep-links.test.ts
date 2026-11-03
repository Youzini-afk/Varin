import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSettingsFileStore } from '@varin/settings-store';
import { createDesktopPlatformOwner } from './desktop-platform.js';
import { parseDesktopDeepLink, parseConnectPairingDeepLinkPayload } from './desktop-deep-links.js';
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const link = (overrides: Record<string, unknown> = {}) => `varin://connect?v=2&p=${Buffer.from(JSON.stringify({ v: 2, pairingId: 'fixture-pair', secret: 'synthetic-pairing-secret', label: 'Trusted fixture', fingerprint: 'fixture-fingerprint', candidates: [{ type: 'lan', url: 'https://first.test', priority: 2 }, { type: 'tunnel', url: 'https://second.test', priority: 3 }], ...overrides })).toString('base64url')}`;
async function fixture(confirm: () => Promise<boolean>, fetch: (url: string, init: RequestInit) => Promise<Response>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varin-links-')); directories.push(directory);
  const settings = createSettingsFileStore({ filePath: path.join(directory, 'settings.json') });
  const request = vi.fn(async (method: string) => { expect(method).toBe('platform.confirmDeepLink'); return confirm(); });
  const owner = createDesktopPlatformOwner({ settings, fetch, appVersion: 'fixture', getLocalOrigin: () => null, nativePort: { request, subscribe: () => () => {} } });
  const receive = (url: string) => owner.invoke({ command: 'native_deep_link', args: { url } });
  return { owner, settings, request, receive };
}
it('requires explicit native consent before networking or persisting externally supplied pairing authority', async () => {
  const fetch = vi.fn(); const target = await fixture(async () => false, fetch);
  expect(await target.receive(link())).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  expect(target.settings.readSync().desktopHosts).toBeUndefined();
  expect(JSON.stringify(target.request.mock.calls)).not.toContain('synthetic-pairing-secret');
  expect(target.request).toHaveBeenCalledOnce();
  for (const invalid of ['varin://connect?v=1&token=bad', link({ expiresAt: '2000-01-01' }), link({ candidates: [{ type: 'lan', url: 'file:///etc/passwd' }] }), link({ candidates: [{ type: 'lan', url: 'https://secret@example.test' }] })]) expect(await target.receive(invalid)).toBeNull();
  expect(target.request).toHaveBeenCalledOnce(); await target.owner.dispose();
});
it('redeems only a confirmed reachable candidate and atomically retains existing host identity/default and concurrent changes', async () => {
  let approve!: (value: boolean) => void;
  const approval = new Promise<boolean>(resolve => { approve = resolve; });
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === 'https://first.test/health') throw new Error('fixture offline');
    if (url === 'https://second.test/health') return Response.json({ status: 'ok' });
    expect(url).toBe('https://second.test/api/client-auth/pairing/redeem');
    expect(JSON.parse(String(init.body))).toMatchObject({ pairingId: 'fixture-pair', secret: 'synthetic-pairing-secret', clientKind: 'desktop', appVersion: 'fixture' });
    return Response.json({ clientToken: 'synthetic-client-token' });
  });
  const target = await fixture(() => approval, fetch);
  const pending = target.receive(link()); await Promise.resolve(); expect(fetch).not.toHaveBeenCalled();
  await target.settings.update(root => { root.desktopHosts = [{ id: 'existing', url: 'https://second.test/', label: 'Previous' }, { id: 'concurrent', url: 'https://concurrent.test', label: 'Keep' }]; root.desktopDefaultHostId = 'concurrent'; });
  approve(true); expect(await pending).toEqual({ type: 'host', hostId: 'existing' });
  const root = target.settings.readSync(); expect(root.desktopHosts).toHaveLength(2); expect(root.desktopDefaultHostId).toBe('concurrent'); expect(root.desktopInitialHostChoiceCompleted).toBe(true);
  expect(root.desktopHosts).toContainEqual(expect.objectContaining({ id: 'existing', clientToken: 'synthetic-client-token' }));
  expect(await target.receive('varin://thread/thread%3A1?branch=branch%3A2&host=existing&dir=%2Fwork')).toEqual({ type: 'thread', threadId: 'thread:1', branchId: 'branch:2', hostId: 'existing', directory: '/work' });
  expect(await target.receive('varin://host/not-saved')).toBeNull(); expect(await target.receive('varin://host/local')).toEqual({ type: 'host', hostId: 'local' });
  await target.owner.dispose();
});
it('does not resurrect pairing after its coordinator has stopped while confirmation was pending', async () => {
  let approve!: (value: boolean) => void; const fetch = vi.fn();
  const target = await fixture(() => new Promise(resolve => { approve = resolve; }), fetch);
  const pending = target.receive(link()); await Promise.resolve(); await target.owner.dispose(); approve(true);
  expect(await pending).toBeNull(); expect(fetch).not.toHaveBeenCalled(); expect(target.settings.readSync().desktopHosts).toBeUndefined();
});
it('preserves the original desktop link vocabulary without admitting credentials, invalid escapes or retired session identities', () => {
  expect(parseDesktopDeepLink('Varin://HOST/saved')).toMatchObject({ type: 'host', value: 'saved' });
  expect(parseDesktopDeepLink('varin://secret@host/saved')).toBeNull(); expect(parseDesktopDeepLink('varin://thread/%XX')).toBeNull();
  expect(parseConnectPairingDeepLinkPayload(link())).toMatchObject({ pairingId: 'fixture-pair' });
});
