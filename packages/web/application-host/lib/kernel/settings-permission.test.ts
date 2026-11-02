import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ApplicationExtensionRuntime, HostServiceBinding, HostInvocationScope } from '@varin/extension-host';
import { SETTINGS_TOOL_DECLARATIONS } from '@varin/extension-builtins';
import { AgentSettingsService } from '../models/settings.js';
import { createSettingsService } from '../harness/settings-service.js';
import { createSettingsPermissionSubjects } from '../harness/settings-authority.js';
import { retainExtensionTool } from './extension-tool-owner.js';
import { createSettingsToolOwner } from './settings-tool-owner.js';
import { createPermissionPersistence } from './permission-persistence.js';
import { permissionService } from './permission-service.js';
import type { KernelClient } from './kernel-client.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { HostToolCall } from './protocol.generated.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(args: (revision: string) => Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'varin-settings-approval-')); roots.push(root);
  const settings = new AgentSettingsService(root, () => false);
  const service = createSettingsService({ agentSettings: () => settings, resolveWorkspaceRoot: async () => null,
    readAppSettings: async () => ({}), persistAppSettings: async () => { throw new Error('unexpected app write'); } });
  const handler = createSettingsToolOwner({ service, runtime: { run: async () => ({ thread_id: 'thread', branch_id: 'branch' }) } as unknown as AgentRuntimeClient });
  const provider = { providerId: 'settings-provider', extensionId: 'varin.builtin.runtime-contracts', extensionVersion: '1.0.0', entrypointId: 'host', instanceKey: 'settings', generation: 1 };
  const executionOwner = { kind: 'kernel' as const };
  let opened!: { permissionId: string; call: HostToolCall; scope: unknown };
  let onOpen!: () => void;
  const waiting = new Promise<void>(resolve => { onOpen = resolve; });
  let decided = false;
  // Management-query port only: the actual Host permission/service/owner chain runs below.
  // Rust Operation persistence and replay remain covered by permission-review.native.test.ts.
  const kernel = { subscribeExit: () => () => {}, agentRuntimeRequest: async (method: string, input: typeof opened) => {
    if (method === 'runtime.permission.open') { opened = structuredClone(input); onOpen(); return {}; }
    if (method === 'runtime.permission.decide') { decided = true; return { phase: 'running' }; }
    if (method === 'runtime.permission.consume') return {};
    if (method === 'runtime.operation.inspect') return { id: call.operationId, run_id: call.runId, phase: decided ? 'running' : 'waiting', cancel_requested: false,
      execution_owner: executionOwner, intent: { origin: call.origin, call: { call_id: call.callId, name: call.name, schema_version: call.schemaVersion, arguments: call.arguments } },
      result: { kind: 'control', value: { permission: { id: opened.permissionId, decision: null } } } };
    if (method === 'runtime.run.inspect') return { id: call.runId, thread_id: 'thread', cancel_requested: false };
    if (method === 'runtime.launch.inspect') return { run_id: call.runId, selection: { source: null } };
    throw new Error(`unexpected query ${method}`);
  } } as unknown as KernelClient;
  const descriptor = SETTINGS_TOOL_DECLARATIONS.find(value => value.tool?.name === 'settings_update')!;
  const selected = { providerId: provider.providerId, providerKey: 'settings-key', descriptor, composition: {}, release() {},
    pin: () => ({ revocationSignal: new AbortController().signal, assertAvailable() {}, release() {},
      invoke: async (_method: string, values: unknown[], signal: AbortSignal, invocation: HostInvocationScope) => handler('update', values[0] as never, { owner: provider, signal, invocation }) }) } as unknown as HostServiceBinding;
  const runtime = { services: { getSnapshot: () => ({ providers: [provider] }) }, supervisor: { getRetainedArtifactIdentity: () => 'artifact' } } as unknown as ApplicationExtensionRuntime;
  const lease = await retainExtensionTool({ runtime, kernel,
    currentPolicy: async () => { const harness = await settings.harness(); return { mode: harness.permissions?.mode ?? 'normal', rules: harness.permissions?.rules ?? [] }; },
    permissionSubjects: createSettingsPermissionSubjects({ models: () => { throw new Error('not a model action'); } }),
  }, selected);
  permissionService(kernel).setPersistence(createPermissionPersistence(settings, async () => undefined));
  const initial = await settings.read();
  const call: HostToolCall = { runId: 'run', operationId: 'request:tool:call', origin: { kind: 'model_step', request_id: 'request' }, callId: 'call',
    name: 'settings_update', schemaVersion: lease.binding.tool.version, arguments: args(initial.revision) as HostToolCall['arguments'] };
  const signal = new AbortController().signal;
  return { settings, lease, call, signal, initial, executionOwner, waiting, getOpened: () => opened,
    decide: () => permissionService(kernel).decide(call.operationId, opened.permissionId, 'allow_always') };
}
it('persists scoped approval and applies the original CAS write through the same invocation without mutating its arguments', async () => {
  const f = await fixture(expectedRevision => ({ id: 'harness.permissions.mode', expectedRevision, set: { 'harness.permissions.mode': 'bypass' } }));
  try {
    const original = structuredClone(f.call);
    const authorization = f.lease.lease.authorize(f.call, f.signal);
    await f.waiting;
    expect(f.getOpened().scope).toMatchObject({ persistent: { scope: 'targets', targets: [{ authority: 'settings:permissions' }] } });
    await f.decide(); await authorization;
    expect((await f.settings.read()).revision).not.toBe(f.initial.revision);
    const receipt = await f.lease.lease.execute(f.call, f.signal, f.executionOwner);
    expect(receipt).toMatchObject({ completion: { outcome: 'succeeded', effect: 'confirmed' } });
    expect((await f.settings.harness()).permissions?.mode).toBe('bypass');
    expect(f.call).toEqual(original); expect(f.getOpened().call).toEqual(original);
    expect((await f.settings.harness()).permissions?.rules).toMatchObject([{ authority: 'settings:permissions', match: { param: 'settingsTarget', pattern: '^global:harness\\.permissions\\.mode:harness\\.permissions\\.mode$' } }]);
  } finally { f.lease.lease.release(); }
});
it('does not rebase across an unrelated writer after the permission commit', async () => {
  const f = await fixture(expectedRevision => ({ id: 'harness.permissions.mode', expectedRevision, set: { 'harness.permissions.mode': 'bypass' } }));
  try {
    const authorization = f.lease.lease.authorize(f.call, f.signal); await f.waiting; await f.decide(); await authorization;
    const saved = await f.settings.read();
    await f.settings.update({ scope: 'global', expectedRevision: saved.revision, set: { titleUpdateInterval: 99 }, remove: [] });
    expect(await f.lease.lease.execute(f.call, f.signal, f.executionOwner)).toMatchObject({ completion: { outcome: 'failed', effect: 'none' } });
    expect((await f.settings.harness()).permissions?.mode ?? 'normal').toBe('normal');
  } finally { f.lease.lease.release(); }
});
