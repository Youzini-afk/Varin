import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSettingsFileStore } from '@varin/settings-store';
import type { BrowserOwner } from '@varin/protocol';
import { BrowserResources } from './browser-resources.js';
import { createBrowserSettings } from './browser-settings.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'varin-browser-settings-')); directories.push(directory);
  const store = createSettingsFileStore({ filePath: join(directory, 'settings.json') });
  await store.update(() => ({ themeId: 'kept' }));
  const resources = new BrowserResources();
  const owner = createBrowserSettings({ resources, read: store.read, update: store.update });
  resources.setPreferences(owner.preferred);
  return { store, resources, owner };
}
function register(resources: BrowserResources, id: string) {
  resources.register({ browserId: id, resource: async () => ({ state: 'online', instanceId: `instance:${id}`, capabilities: ['tabs'] }),
    subscribe: () => () => undefined, releaseThread: async () => undefined } as unknown as BrowserOwner, id, 'Device');
}
const chosen = (_owner: BrowserOwner, binding: { browserId: string }) => Promise.resolve(binding.browserId);

it('persists multiple connections through the original settings owner, checks revisions and preserves unrelated fields', async () => {
  const { store, resources, owner } = await fixture();
  const before = await owner.read();
  const connections = [{ id: 'cdp:one', label: 'First browser', endpoint: 'http://127.0.0.1:9222' },
    { id: 'cdp:two', label: 'Second browser', endpoint: 'wss://browser.example/cdp' }];
  const saved = await owner.save(before.revision, { connections, defaultBrowserId: 'cdp:two' });
  expect(resources.has('cdp:one')).toBe(true); expect(resources.has('cdp:two')).toBe(true);
  expect((await store.read()).themeId).toBe('kept');
  await expect(owner.save(before.revision, { connections: [], defaultBrowserId: null })).rejects.toThrow('changed');
  const restarted = createBrowserSettings({ resources: new BrowserResources(), read: store.read, update: store.update });
  expect(await restarted.read()).toEqual(saved);
  await owner.save(saved.revision, { connections: [connections[0]], defaultBrowserId: null });
  expect(resources.has('cdp:two')).toBe(false);
  await resources.dispose();
});

it('uses the configured default, persists task choices, and keeps explicit page calls on their original resource', async () => {
  const { store, resources, owner } = await fixture();
  register(resources, 'first'); register(resources, 'second');
  const before = await owner.read(); await owner.save(before.revision, { connections: [], defaultBrowserId: 'first' });
  expect(await resources.use({}, { threadId: 'task' }, chosen)).toBe('first');
  await owner.selectTask('task', 'second');
  expect(await resources.use({}, { threadId: 'task' }, chosen)).toBe('second');
  expect(await resources.use({ browserId: 'first', instanceId: 'instance:first', pageId: 'original-page' }, { threadId: 'task' }, chosen)).toBe('first');
  expect(await resources.use({}, { threadId: 'task' }, chosen)).toBe('second');
  const restarted = new BrowserResources(); register(restarted, 'first'); register(restarted, 'second');
  const settings = createBrowserSettings({ resources: restarted, read: store.read, update: store.update }); restarted.setPreferences(settings.preferred);
  expect(await restarted.use({}, { threadId: 'task' }, chosen)).toBe('second');
  await settings.selectTask('task', null);
  expect(await restarted.use({}, { threadId: 'task' }, chosen)).toBe('first');
});

it('does not replace a selected missing browser with another available browser', async () => {
  const { resources, owner } = await fixture(); register(resources, 'first'); register(resources, 'second');
  await owner.selectTask('task', 'second');
  await resources.use({}, { threadId: 'task' }, chosen); await resources.unregister('second');
  await expect(resources.use({}, { threadId: 'task' }, chosen)).rejects.toThrow('not found');
  expect((await resources.list({ threadId: 'other' })).every(resource => !resource.preferred)).toBe(true);
});
