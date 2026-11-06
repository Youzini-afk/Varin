import { expect, test } from 'vitest';
import { SurfaceExtensionRuntime } from '@varin/extension-surface';
import type { VarinExtensionManifest, VarinExtensionStaticContribution } from '@varin/extension-contract';
import { settingsPageRegistrationsFromSnapshot } from '../settings/surface-registry';
import { pluginConfigurationPages } from './plugin-configuration';

const page = (slug: string, primary = false): VarinExtensionStaticContribution => ({
  id: `dev.example.configure.${slug}`, kind: 'settings-page', contractVersion: 1,
  supports: ['web'], data: { slug, title: slug, primary },
});
const manifest: VarinExtensionManifest = {
  schemaVersion: 1, id: 'dev.example.configure', version: '1.0.0', engines: { varin: '>=0.2.0' },
  contributions: [page('other'), page('main', true), { ...page('desktop'), supports: ['desktop'] }],
};
const context = { isWeb: true, isDesktop: false, isMobile: false, mcpInstalled: true };

test('configuration follows primary declaration and real registration lifecycle without enabling execution', async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const project = (enabled = true, currentManifest = manifest) => {
    const snapshot = runtime.getSnapshot();
    return pluginConfigurationPages(currentManifest, enabled, 'web', snapshot, settingsPageRegistrationsFromSnapshot(snapshot), context);
  };
  expect(project(false).map(page => [page.title, page.unavailable])).toEqual([
    ['main', 'disabled'], ['other', 'disabled'], ['desktop', 'surface'],
  ]);
  expect(project().map(page => page.unavailable)).toEqual(['lifecycle', 'lifecycle', 'surface']);
  const handle = await runtime.activate({ owner: {
    extensionId: manifest.id, extensionVersion: manifest.version, entrypointId: 'main', realmId: 'test',
    hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078', desiredRevision: 1, generation: 1,
  } }, scope => {
    for (const descriptor of manifest.contributions!.slice(0, 2)) scope.contribute(descriptor, { mount: () => undefined });
  });
  expect(project().map(page => page.slug)).toEqual(['main', 'other', undefined]);
  // Independent live settings remain available even if business execution is disabled.
  expect(project(false)[0]?.slug).toBe('main');
  await handle.deactivate(2, 2);
  expect(project()[0]).toMatchObject({ unavailable: 'lifecycle' });
  expect(project()[0]?.slug).toBeUndefined();
  expect(project(true, { ...manifest, contributions: [] })).toEqual([]);
});

test('a page not available in settings navigation is not a usable Configure destination', async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const descriptor = { ...page('limited'), data: { ...page('limited').data, titleKey: 'settings.page.general.title', group: 'general', kind: 'single', icon: null, order: 1 } };
  const handle = await runtime.activate({ owner: {
    extensionId: manifest.id, extensionVersion: manifest.version, entrypointId: 'main', realmId: 'test',
    hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078', desiredRevision: 1, generation: 1,
  } }, scope => scope.contribute(descriptor, { renderContent: () => null, isAvailable: () => false }));
  const snapshot = runtime.getSnapshot();
  expect(pluginConfigurationPages({ ...manifest, contributions: [descriptor] }, true, 'web', snapshot,
    settingsPageRegistrationsFromSnapshot(snapshot), context)[0]).toMatchObject({ unavailable: 'lifecycle' });
  await handle.deactivate(2, 2);
});


test('supported configuration entrance respects the declared entrypoint, not only the page supports', () => {
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const restricted: VarinExtensionManifest = {
    ...manifest,
    entrypoints: { surfaces: [{ id: 'desktop-settings', supports: ['desktop'], mode: 'managed', file: 'settings.js' }] },
    contributions: [{ ...page('account'), supports: ['web', 'desktop'], entrypoint: 'desktop-settings' }],
  };
  expect(pluginConfigurationPages(restricted, true, 'web', runtime.getSnapshot(), [], context)[0])
    .toMatchObject({ unavailable: 'surface', supports: ['desktop'] });
});
