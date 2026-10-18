import { expect, it, vi } from 'vitest';
import { COMPUTER_TOOL_DECLARATIONS, RESEARCH_DECISION_TOOL_DECLARATIONS, RESEARCH_DISCOVERY_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { extendToolConfiguration, configuredToolAvailability, type ExtensionToolConfiguration } from './extension-tool-owner.js';
import { createResearchDecisionRuntime } from './research-decision.js';
import { createResearchDiscoveryRuntime } from './research-discovery.js';
import type { AgentSettingsSnapshot } from '@varin/application-client';

it('composes availability across owners and hides decision tools without a ready model', async () => {
  const snapshot: AgentSettingsSnapshot = { global: {}, project: {}, globalRevision: 'g', projectRevision: 'p', projectTrusted: false };
  const run = { runId: 'run', threadId: 'thread', source: null };
  const release = vi.fn();
  const previous: ExtensionToolConfiguration = Object.assign(() => 'original', {
    enabled: () => false, release, retain: () => release,
  });
  const discovery = createResearchDiscoveryRuntime({ settings: async () => snapshot, service: { handle: vi.fn() } as never });
  const search = await discovery.prepareConfiguration(run, [], previous);
  const captureDecision = vi.fn(async () => ({ status: 'unconfigured' as const, message: 'No selected model' }));
  const decision = createResearchDecisionRuntime({ settings: async () => snapshot, inference: { captureDecision }, materials: {} as never });
  const absent = await decision.prepareConfiguration(run, [], search);
  expect(absent.enabled!(RESEARCH_DECISION_TOOL_DECLARATIONS[0]!)).toBe(false);
  expect(absent.enabled!(RESEARCH_DISCOVERY_TOOL_DECLARATIONS[0]!)).toBe(true);
  expect(absent.enabled!(COMPUTER_TOOL_DECLARATIONS[0]!)).toBe(false);
  expect(absent.release).toBe(release);
  expect(absent.retain).toBe(previous.retain);
  expect(captureDecision).toHaveBeenCalledTimes(2);

  const releaseModel = vi.fn();
  const ready = createResearchDecisionRuntime({ settings: async () => snapshot, materials: {} as never,
    inference: { captureDecision: async () => ({ status: 'ready', lease: { release: releaseModel } }) } as never });
  const available = await ready.prepareConfiguration(run, [], absent);
  expect(available.enabled!(RESEARCH_DECISION_TOOL_DECLARATIONS[0]!)).toBe(true);
  expect(releaseModel).toHaveBeenCalledTimes(2);
  expect(release).not.toHaveBeenCalled();
  const wrapper = extendToolConfiguration(available, descriptor => available(descriptor));
  expect(wrapper.enabled!(COMPUTER_TOOL_DECLARATIONS[0]!)).toBe(false);
  const configured = configuredToolAvailability({ ...snapshot, global: { harness: { tools: { research_search: false } } } }, wrapper);
  expect(configured.enabled!(RESEARCH_DISCOVERY_TOOL_DECLARATIONS[0]!)).toBe(false);
  expect(configured.enabled!(RESEARCH_DECISION_TOOL_DECLARATIONS[0]!)).toBe(true);
  expect(configured.retain).toBe(previous.retain);
});
