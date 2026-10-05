import { expect, test, vi } from 'vitest';
import {
  VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION,
  VARIN_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS,
} from '@varin/extension-builtins';
import { SurfaceExtensionRuntime } from '@varin/extension-surface';
import type { PackageDescriptor } from '@varin/protocol';

vi.doMock('@/hooks/useProviderLogo', () => ({
  preloadProviderLogos: () => undefined,
  useProviderLogo: () => ({ hasLogo: false, onError: () => undefined, src: null }),
}));

const { activateBuiltinPiIntegration } = await import('./builtin-pi-integrations');
const { pluginSettingsAdapterForPackage, pluginSettingsAdaptersFromSnapshot } = await import('./pi-integration-registry');

test('built-in activation skips contributions unsupported by the current Surface', async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: 'mobile' });
  await runtime.activate({
    owner: {
      desiredRevision: 1,
      entrypointId: 'main',
      extensionId: VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION.manifest.id,
      extensionVersion: VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION.manifest.version,
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: 'mobile-ide-filter-test',
    },
  }, activateBuiltinPiIntegration(VARIN_BUILTIN_IDE_WORKBENCH_EXTENSION, 'mobile'));

  expect(runtime.getSnapshot().actual[0]?.status).toBe('active');
  expect(runtime.getSnapshot().contributions).toEqual([]);
});

test('a Varin adapter contribution can be withdrawn without changing the Pi package', async () => {
  const definition = VARIN_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS.find((candidate) => (
    candidate.manifest.id.endsWith('.subagents')
  ));
  expect(definition).toBeDefined();
  if (!definition) return;
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const handle = await runtime.activate({
    owner: {
      desiredRevision: 1,
      entrypointId: 'main',
      extensionId: definition.manifest.id,
      extensionVersion: definition.manifest.version,
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: 'adapter-test',
    },
  }, activateBuiltinPiIntegration(definition));
  const piPackage: PackageDescriptor = {
    enabled: true,
    installed: true,
    name: 'pi-subagents',
    scope: 'global',
    source: 'npm:pi-subagents',
    structured: true,
  };

  const activeAdapters = pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot());
  expect(pluginSettingsAdapterForPackage(piPackage, activeAdapters)?.adapterId).toBe('subagents');
  await handle.deactivate(2, 2);
  expect(pluginSettingsAdapterForPackage(piPackage, pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot()))).toBe(null);
  expect(piPackage.enabled).toBe(true);
  expect(piPackage.installed).toBe(true);
});

test('maps the pi-lens package to its built-in settings adapter', async () => {
  const definition = VARIN_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS.find((candidate) => (
    candidate.manifest.id.endsWith('.pi-lens')
  ));
  expect(definition).toBeDefined();
  if (!definition) return;
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const handle = await runtime.activate({
    owner: {
      desiredRevision: 1,
      entrypointId: 'main',
      extensionId: definition.manifest.id,
      extensionVersion: definition.manifest.version,
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: 'pi-lens-adapter-test',
    },
  }, activateBuiltinPiIntegration(definition));
  const piPackage: PackageDescriptor = {
    enabled: true,
    installed: true,
    name: 'pi-lens',
    scope: 'global',
    source: 'npm:pi-lens',
    structured: true,
  };
  expect(pluginSettingsAdapterForPackage(
    piPackage,
    pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot()),
  )?.adapterId).toBe('pi-lens');
  await handle.deactivate(2, 2);
});

test('maps only @cortexkit/aft-pi to the AFT settings adapter', async () => {
  const definition = VARIN_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS.find((candidate) => (
    candidate.manifest.id.endsWith('.aft')
  ));
  expect(definition).toBeDefined();
  if (!definition) return;
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const handle = await runtime.activate({
    owner: {
      desiredRevision: 1,
      entrypointId: 'main',
      extensionId: definition.manifest.id,
      extensionVersion: definition.manifest.version,
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: 'aft-adapter-test',
    },
  }, activateBuiltinPiIntegration(definition));
  const aftPackage: PackageDescriptor = {
    enabled: true,
    installed: true,
    name: '@cortexkit/aft-pi',
    scope: 'global',
    source: 'npm:@cortexkit/aft-pi',
    structured: true,
  };
  const adapter = pluginSettingsAdapterForPackage(
    aftPackage,
    pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot()),
  );
  expect(adapter?.adapterId).toBe('aft');
  expect(adapter?.icon).toBe('tools');
  expect(adapter?.packageNames).toEqual(['@cortexkit/aft-pi']);
  expect(pluginSettingsAdapterForPackage(
    { ...aftPackage, name: '@cortexkit/aft', source: 'npm:@cortexkit/aft' },
    pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot()),
  )).toBeNull();
  await handle.deactivate(2, 2);
});

test('maps only pi-hermes-memory to the Hermes Memory settings adapter', async () => {
  const definition = VARIN_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS.find((candidate) => (
    candidate.manifest.id.endsWith('.hermes-memory')
  ));
  expect(definition).toBeDefined();
  if (!definition) return;
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const handle = await runtime.activate({
    owner: {
      desiredRevision: 1,
      entrypointId: 'main',
      extensionId: definition.manifest.id,
      extensionVersion: definition.manifest.version,
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: 'hermes-memory-adapter-test',
    },
  }, activateBuiltinPiIntegration(definition));
  const hermesPackage: PackageDescriptor = {
    enabled: true,
    installed: true,
    name: 'pi-hermes-memory',
    scope: 'global',
    source: 'npm:pi-hermes-memory',
    structured: true,
  };
  const adapters = pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot());
  const adapter = pluginSettingsAdapterForPackage(hermesPackage, adapters);
  expect(adapter?.adapterId).toBe('hermes-memory');
  expect(adapter?.icon).toBe('brain');
  expect(adapter?.packageNames).toEqual(['pi-hermes-memory']);
  expect(pluginSettingsAdapterForPackage(
    { ...hermesPackage, name: 'pi-memory', source: 'npm:pi-memory' },
    adapters,
  )).toBeNull();
  await handle.deactivate(2, 2);
});

test('maps only pi-rtk-optimizer to the RTK settings adapter', async () => {
  const definition = VARIN_BUILTIN_PLUGIN_ADAPTER_EXTENSIONS.find((candidate) => (
    candidate.manifest.id.endsWith('.rtk')
  ));
  expect(definition).toBeDefined();
  if (!definition) return;
  const runtime = new SurfaceExtensionRuntime({ surface: 'web' });
  const handle = await runtime.activate({
    owner: {
      desiredRevision: 1,
      entrypointId: 'main',
      extensionId: definition.manifest.id,
      extensionVersion: definition.manifest.version,
      generation: 1,
      hostId: '72694a4f-093a-4f79-8763-3ca9f06b7078',
      realmId: 'rtk-adapter-test',
    },
  }, activateBuiltinPiIntegration(definition));
  const rtkPackage: PackageDescriptor = {
    enabled: true,
    installed: true,
    name: 'pi-rtk-optimizer',
    scope: 'global',
    source: 'npm:pi-rtk-optimizer',
    structured: true,
  };
  const adapters = pluginSettingsAdaptersFromSnapshot(runtime.getSnapshot());
  const adapter = pluginSettingsAdapterForPackage(rtkPackage, adapters);
  expect(adapter?.adapterId).toBe('rtk');
  expect(adapter?.icon).toBe('terminal-box');
  expect(adapter?.packageNames).toEqual(['pi-rtk-optimizer']);
  expect(pluginSettingsAdapterForPackage(
    { ...rtkPackage, name: 'pi-rtk', source: 'npm:pi-rtk' },
    adapters,
  )).toBeNull();
  await handle.deactivate(2, 2);
});
