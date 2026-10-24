import { expect, it, vi } from 'vitest';
import { COMPUTER_TOOL_DECLARATIONS, RESEARCH_DISCOVERY_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { extendToolConfiguration, configuredToolAvailability, type ExtensionToolConfiguration } from './extension-tool-owner.js';
import { createResearchDiscoveryRuntime } from './research-discovery.js';
import type { AgentSettingsSnapshot } from '@varin/application-client';

it('composes independent capability availability and preserves explicit user selection', async () => {
  const snapshot: AgentSettingsSnapshot = { global: {}, project: {}, globalRevision: 'g', projectRevision: 'p', projectTrusted: false };
  const run = { runId: 'run', threadId: 'thread', source: null };
  const release = vi.fn();
  const previous: ExtensionToolConfiguration = Object.assign(() => 'original', {
    enabled: () => false, release, retain: () => release,
  });
  const discovery = createResearchDiscoveryRuntime({ settings: async () => snapshot, service: { handle: vi.fn() } as never });
  const search = await discovery.prepareConfiguration(run, [], previous);
  expect(search.enabled!(RESEARCH_DISCOVERY_TOOL_DECLARATIONS[0]!)).toBe(true);
  expect(search.enabled!(COMPUTER_TOOL_DECLARATIONS[0]!)).toBe(false);
  expect(search.release).toBe(release);
  expect(search.retain).toBe(previous.retain);
  expect(release).not.toHaveBeenCalled();
  const wrapper = extendToolConfiguration(search, descriptor => search(descriptor));
  expect(wrapper.enabled!(COMPUTER_TOOL_DECLARATIONS[0]!)).toBe(false);
  const configured = configuredToolAvailability({ ...snapshot, global: { harness: { tools: { research_search: false } } } }, wrapper);
  expect(configured.enabled!(RESEARCH_DISCOVERY_TOOL_DECLARATIONS[0]!)).toBe(false);
  expect(configured.retain).toBe(previous.retain);
});
