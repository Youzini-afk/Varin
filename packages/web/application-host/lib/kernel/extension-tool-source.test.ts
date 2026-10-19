import { expect, it, vi } from 'vitest';
import type { ApplicationExtensionRuntime, HostServiceBinding } from '@varin/extension-host';
import type { VarinExtensionServiceProvision, VarinExtensionServiceRoutingContext, VarinHostServiceComposition } from '@varin/extension-contract';
import { SCRIPT_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { createExtensionTools, type ExtensionToolLease, type ExtensionToolOwnerOptions } from './extension-tool-owner.js';
import type { KernelClient } from './kernel-client.js';
import type { LaunchSource } from './protocol.generated.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { createScriptRuntime } from './script-runtime.js';

// Original declaration/routing/preparation/retention consumer. The provider snapshots
// and pins are controlled; this fixture does not execute tools or issue source grants.
function fixture(warm: boolean, configuration: Pick<ExtensionToolOwnerOptions, 'prepareConfiguration'> = {}) {
  const descriptors: VarinExtensionServiceProvision[] = [undefined, 'source', 'physical', 'live'].map((dependency, index) => ({
    id: `example.source.${index}`, version: 1,
    tool: { name: `ordinary_${index}`, description: 'Source availability fixture', inputSchema: { type: 'object' },
      outputSchema: { type: 'object' }, operation: 'read', completion: 'result',
      ...(dependency ? { requirements: { source: dependency as 'source' | 'physical' | 'live', process: dependency === 'physical' } } : {}) },
  }));
  const extensionId = 'example.source';
  const composition: VarinHostServiceComposition = { schemaVersion: 1, root: 'source-composition', nodes: [{
    id: 'source-composition', extensionId, entrypointId: 'host', extensionVersion: '1.0.0',
    artifactIntegrity: 'fixture-artifact', activationConfiguration: null, grants: [], dependencies: [],
  }] };
  const providers = descriptors.map(descriptor => ({ providerId: descriptor.id, providerKey: `${extensionId}:host:${descriptor.id}@1`,
    extensionId, extensionVersion: '1.0.0', entrypointId: 'host', generation: 1, status: 'active' }));
  const live = warm ? [...providers] : [];
  const signal = new AbortController().signal;
  let pins = 0;
  const routing: VarinExtensionServiceRoutingContext[] = [];
  const bind = (id: string): HostServiceBinding => {
    const provider = providers.find(candidate => candidate.providerId === id)!;
    return { ...provider, composition, release() {}, descriptor: descriptors.find(descriptor => descriptor.id === id)!, pin() {
      pins++;
      return { assertAvailable() {}, release() { pins--; }, revocationSignal: signal, async invoke() { throw new Error('Preparation must not execute'); } };
    } } as unknown as HostServiceBinding;
  };
  const runtime = {
    async state() { return { revision: 1, catalog: { authoritative: true, extensions: [{ desired: { enabled: true }, integrity: 'fixture-artifact',
      manifest: { id: extensionId, entrypoints: { host: {} }, provides: { services: descriptors } } }] },
      routing: { authoritative: true, document: { schemaVersion: 1, revision: 0, rules: [], updatedAt: '2026-10-11T00:00:00Z' } },
      services: { providers: live, selections: {} } }; },
    services: { getSnapshot: () => ({ providers: live }), bind, bindPinned: bind },
    supervisor: { getRetainedArtifactIdentity: () => 'fixture-artifact', getRetainedComposition: () => composition },
    async resolveServiceCompositions(request: {serviceId:string; routing: VarinExtensionServiceRoutingContext}) {
      routing.push(structuredClone(request.routing));
      const provider = providers.find(candidate => candidate.providerId === request.serviceId)!;
      return {routingRevision:0,services:[{providerKey:provider.providerKey,
        descriptor:descriptors.find(descriptor=>descriptor.id===request.serviceId),composition}]};
    },
    async prepareService(request: { serviceId: string; routing: VarinExtensionServiceRoutingContext }) {
      routing.push(structuredClone(request.routing));
      const provider = providers.find(candidate => candidate.providerId === request.serviceId)!;
      if (!live.includes(provider)) live.push(provider);
      return bind(request.serviceId);
    },
    subscribe: () => () => {},
  } as unknown as ApplicationExtensionRuntime;
  return { prepare: createExtensionTools({ runtime, kernel: {} as KernelClient, currentPolicy: async () => ({ mode: 'normal', rules: [] }), ...configuration }), pins: () => pins, routing };
}
const source = (mode: LaunchSource['mode']): LaunchSource => ({ resource_owner: {kind:'local'}, mode, workspace_id: 'workspace', execution_workspace_id: 'execution',
  branch_id: mode === 'live_root' ? null : 'branch', revision: mode === 'live_root' ? null : 1, environment_run_id: null,
  live_root: mode === 'live_root' ? { hostId: 'host', rootId: 'root', canonicalRoot: '/fixture' } : null });

it('warm and cold/dynamic ordinary discovery project owning source dependencies without pinning unavailable tools', async () => {
  for (const warm of [true, false]) for (const selected of [null, source('fixed_branch'), source('materialized'), source('live_root')]) {
    const f = fixture(warm), leases: ExtensionToolLease[] = [];
    const expected = selected === null ? ['ordinary_0'] : selected.mode === 'fixed_branch' ? ['ordinary_0', 'ordinary_1']
      : selected.mode === 'materialized' ? ['ordinary_0', 'ordinary_1', 'ordinary_2'] : ['ordinary_0', 'ordinary_1', 'ordinary_2', 'ordinary_3'];
    const scope = await f.prepare({ runId: 'run', threadId: 'thread', branchId: 'history-branch', source: selected }, [], new AbortController().signal);
    leases.push(...scope.initial);
    try {
      expect(scope.initial.map(lease => lease.binding.tool.name).sort()).toEqual(expected);
      scope.start(async (_slot, lease) => { if (lease) leases.push(lease); });
      await vi.waitFor(() => expect(scope.inspect().filter(entry => entry.status === 'ready' || entry.status === 'unavailable')).toHaveLength(4));
      expect(scope.inspect().filter(entry => entry.status === 'ready').map(entry => entry.prepared!.tool.name).sort()).toEqual(expected);
      expect(f.pins()).toBe(expected.length);
      expect(f.routing.length).toBeGreaterThan(0);
      for (const context of f.routing) expect(context).toEqual({ threadId: 'thread', branchId: 'history-branch', sourceRunId: 'run' });
      for (const entry of scope.inspect().filter(entry => entry.status === 'unavailable')) expect(entry.error).toContain('extension_tool_source_unavailable');
      const physical = leases.find(lease => lease.binding.tool.name === 'ordinary_2');
      if (physical) await expect(f.prepare({ runId: 'explicit', threadId: 'thread', branchId: 'history-branch', source: null }, [physical.binding], new AbortController().signal)).rejects.toThrow('requires_physical');
    } finally { scope.close(); for (const lease of leases) lease.lease.release(); }
    expect(f.pins()).toBe(0);
  }
});

it('failed Node configuration is local to actual scripts and leaves unrelated source-less tools ready', async () => {
  const scripts = createScriptRuntime({ kernel: {} as KernelClient,
    runtime: { onEvent: () => () => {}, onReady: () => () => {} } as unknown as AgentRuntimeClient,
    resolveLiveSource: async () => { throw new Error('Preparation cannot resolve a source'); }, onError: error => { throw error; } });
  const original = Object.getOwnPropertyDescriptor(process, 'execPath')!;
  try {
    // Invalid only in this test process. No installed Node file is changed.
    Object.defineProperty(process, 'execPath', { ...original, value: '' });
    const resolver = await scripts.prepareConfiguration(() => 'ordinary-configuration', null);
    expect(() => resolver(SCRIPT_TOOL_DECLARATIONS[0]!)).toThrow();
    expect(() => resolver(SCRIPT_TOOL_DECLARATIONS[0]!, 'required-original-node')).toThrow();
    const f = fixture(true, { prepareConfiguration: async () => resolver });
    const scope = await f.prepare({ runId: 'unrelated', threadId: 'thread', branchId: 'history-branch', source: null }, [], new AbortController().signal);
    try {
      expect(scope.initial.map(lease => lease.binding.tool.name)).toEqual(['ordinary_0']);
      expect(scope.initial[0]!.binding.configurationIdentity).toBe('ordinary-configuration');
    } finally { scope.close(); for (const lease of scope.initial) lease.lease.release(); }
    expect(f.pins()).toBe(0);
  } finally { Object.defineProperty(process, 'execPath', original); await scripts.dispose(); }
});
