import { expect, test, vi } from 'vitest';
import { parseVarinExtensionDiscoveryDocument } from '@varin/extension-contract';
import type { PluginDiscoverySnapshot } from '@varin/application-client';
import { directPluginInstallInput, installedPluginListing, routePluginInstallIntent } from './plugin-center-selection';
const entries = parseVarinExtensionDiscoveryDocument({ schemaVersion: 1, entries: [{ id: 'example.mail', displayName: 'Catalog mail', description: 'Curated description',
  source: { kind: 'npm', specifier: '@example/mail', display: '@example/mail' } }] }).entries;
const snapshot: PluginDiscoverySnapshot = { hostId: 'host', sources: [], entries: entries.map(entry => ({ key: 'mail', entry, installed: true, catalogs: ['official'] })) };
test('a matching installed website link navigates to management without preparing code', async () => {
  const link = `varin://extensions/install?source=${encodeURIComponent(JSON.stringify({ ...entries[0].source, specifier: '@example/mail@latest' }))}&extensionId=example.mail`;
  const parsed = directPluginInstallInput(link, 'npm');
  const manage = vi.fn(), preview = vi.fn();
  await routePluginInstallIntent(parsed.intent!, { resolveInstalled: async () => ({ hostId: 'host', extensionId: 'example.mail' }), isCurrent: () => true, manage, preview });
  expect(manage).toHaveBeenCalledWith('example.mail'); expect(preview).not.toHaveBeenCalled();
  expect(parsed.source.specifier).toBe('@example/mail@latest');
});
test('a same-ID link from another publisher still requires its own preview', async () => {
  const manage = vi.fn(), preview = vi.fn();
  const source = { kind: 'npm' as const, specifier: '@other/mail', display: '@other/mail' };
  await routePluginInstallIntent({ source, extensionId: 'example.mail' }, { resolveInstalled: async () => ({ hostId: 'host' }), isCurrent: () => true, manage, preview });
  expect(manage).not.toHaveBeenCalled(); expect(preview).toHaveBeenCalledWith(source, 'example.mail');
});
test('installed metadata requires the Host source match and falls back when the catalog is absent', () => {
  expect(installedPluginListing(snapshot, 'example.mail')?.displayName).toBe('Catalog mail');
  expect(installedPluginListing({ ...snapshot, entries: snapshot.entries.map(listing => ({ ...listing, installed: false })) }, 'example.mail')).toBeUndefined();
  expect(installedPluginListing(null, 'example.mail')).toBeUndefined();
  expect(installedPluginListing(snapshot, 'other.mail')).toBeUndefined();
});
test('pasted install links are parsed before the selected source type, and malformed links never become npm input', () => {
  const link = `varin://extensions/install?source=${encodeURIComponent(JSON.stringify(entries[0].source))}&extensionId=example.mail`;
  expect(directPluginInstallInput(link, 'git').intent?.extensionId).toBe('example.mail');
  expect(directPluginInstallInput('@example/mail', 'npm').intent).toBeUndefined();
  expect(() => directPluginInstallInput('varin://extensions/install?source=broken', 'npm')).toThrow('Invalid plugin install link');
});
test('late navigation results after a Host switch do not manage or preview on the new Host', async () => {
  const manage = vi.fn(), preview = vi.fn();
  await routePluginInstallIntent({ source: entries[0].source }, { resolveInstalled: async () => ({ hostId: 'old-host', extensionId: 'example.mail' }), isCurrent: () => false, manage, preview });
  expect(manage).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
});

test('a delisted plugin still opens installed management without reading any discovery directory', async () => {
  const manage = vi.fn(), preview = vi.fn();
  const resolveInstalled = vi.fn().mockResolvedValue({ hostId: 'host', extensionId: 'example.mail' });
  await routePluginInstallIntent({ source: entries[0].source, extensionId: 'example.mail' }, { resolveInstalled, isCurrent: () => true, manage, preview });
  expect(resolveInstalled).toHaveBeenCalledWith(entries[0].source, 'example.mail');
  expect(manage).toHaveBeenCalledWith('example.mail'); expect(preview).not.toHaveBeenCalled();
});

test('a failed authoritative installed lookup never falls through to downloading a preview', async () => {
  const manage = vi.fn(), preview = vi.fn();
  await expect(routePluginInstallIntent({ source: entries[0].source }, {
    resolveInstalled: async () => { throw new Error('Catalog unavailable'); }, isCurrent: () => true, manage, preview,
  })).rejects.toThrow('Catalog unavailable');
  expect(manage).not.toHaveBeenCalled(); expect(preview).not.toHaveBeenCalled();
});
