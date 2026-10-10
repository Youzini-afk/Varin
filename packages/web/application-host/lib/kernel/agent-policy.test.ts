import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { resolveVarinExtensionServiceRouting } from '@varin/extension-contract';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createAgentPolicy } from './agent-policy.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-policy-binding-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '0.9.25',
    brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  cleanups.push(async () => { await runtime.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await runtime.start();
  const install = async (version: number) => {
    const id = `review.policy-v${version}`;
    const folder = path.join(root, id); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
    await fs.writeFile(path.join(folder, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
      entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } }, provides: { services: [{ id: 'varin.agent.policy', version, multiple: true }] } }));
    await fs.writeFile(path.join(folder, 'host.cjs'), `module.exports={activate(context){context.services.provide({id:'varin.agent.policy',version:${version},multiple:true},{
      describe(){${version === 2 ? "return {identity:{name:'installed-v2',version:'1'},configuration:{}}" : "throw new Error('Obsolete describe must never run')"}},
      decide(){return {action:{kind:'complete'},state:null}}
    })}}`);
    await runtime.installOrStage({ expectedRevision: (await runtime.state()).catalog.revision, source: { kind: 'local', display: id, specifier: folder } });
    return `${id}:host:varin.agent.policy@${version}`;
  };
  const route = async (version: number, providerKey: string, scope: { projectId?: string; sessionId?: string }, allowFallback = false) =>
    runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
      rule: { serviceId: 'varin.agent.policy', version, providerKey, scope, allowFallback } });
  return { runtime, install, route, prepare: createAgentPolicy(runtime) };
}

it('absence, unselected old installation and another scope do not block the default policy', async () => {
  const f = await fixture();
  const scope = { sessionId: 'thread', projectId: 'current' };
  expect(await f.prepare(scope)).toBeUndefined();
  const old = await f.install(1);
  expect(await f.prepare(scope)).toBeUndefined();
  await f.route(1, old, { projectId: 'other' });
  expect(await f.prepare(scope)).toBeUndefined();
  await f.runtime.setEnabled('review.policy-v1', false, (await f.runtime.state()).catalog.revision);
  expect(await f.prepare(scope)).toBeUndefined();
  const installed = await f.install(2);
  const lease = await f.prepare(scope);
  expect(lease?.binding.identity.name).toBe(`${installed}:installed-v2`);
  lease?.release();
});

it.each([false, true])('an explicit unsupported policy cannot be replaced by the default loop or an installed-only v2 (fallback=%s)', async allowFallback => {
  const f = await fixture();
  const old = await f.install(1);
  await f.route(1, old, { projectId: 'current' }, allowFallback);
  await expect(f.prepare({ sessionId: 'thread', projectId: 'current' })).rejects.toThrow(/version 1 is unsupported/);
  await f.install(2);
  await expect(f.prepare({ sessionId: 'thread', projectId: 'current' })).rejects.toThrow(/version 1 is unsupported/);
  expect(f.runtime.services.getSnapshot().providers.some(provider => provider.extensionId === 'review.policy-v2')).toBe(false);
});

it('conflicting unsupported rules cannot disappear into optional-policy absence', async () => {
  const f = await fixture();
  await f.route(1, 'review.one:host:varin.agent.policy@1', { projectId: 'current', sessionId: 'thread' });
  // User and project context have the same precedence within a session-specific rule.
  await f.runtime.upsertServiceRoutingRule({ expectedRevision: (await f.runtime.routing.read()).document.revision,
    rule: { serviceId: 'varin.agent.policy', version: 1, providerKey: 'review.two:host:varin.agent.policy@1', scope: { userId: 'owner', sessionId: 'thread' }, allowFallback: false } });
  const scope = { sessionId: 'thread', projectId: 'current', userId: 'owner' };
  expect(resolveVarinExtensionServiceRouting({ candidates: [], document: (await f.runtime.routing.read()).document, serviceId: 'varin.agent.policy', version: 1, context: scope }).status).toBe('ambiguous');
  await expect(f.prepare(scope)).rejects.toThrow(/version 1 is unsupported/);
});

it('a real v2 selection remains usable alongside old routes and preserves its exact provider generation', async () => {
  const f = await fixture();
  const old = await f.install(1);
  await f.route(1, old, { projectId: 'current' });
  const selected = await f.install(2);
  await f.route(2, selected, { projectId: 'current' });
  const lease = await f.prepare({ sessionId: 'thread', projectId: 'current' });
  expect(lease?.binding.identity.name).toBe(`${selected}:installed-v2`);
  try {
    expect(await lease!.decide({ view: { run_id: 'run', state: 'runnable', history_count: 0, history_head_id: null, pending_tool_calls: 0, model_capabilities: [] }, event: { kind: 'started' }, state: null }, new AbortController().signal))
      .toEqual({ action: { kind: 'complete' }, state: null });
  } finally { lease?.release(); }
});


it('an explicit unsupported registry selection is rejected without invoking its obsolete describe method', async () => {
  const f = await fixture();
  const old = await f.install(1);
  await f.runtime.supervisor.activateExtension('review.policy-v1');
  const provider = f.runtime.services.getSnapshot().providers.find(provider => provider.providerKey === old)!;
  await f.runtime.setServiceSelection({ serviceId: 'varin.agent.policy', version: 1, providerId: provider.providerId });
  await expect(f.prepare({ sessionId: 'thread', projectId: 'current' })).rejects.toThrow(/version 1 is unsupported/);
  await f.install(2);
  await expect(f.prepare({ sessionId: 'thread', projectId: 'current' })).rejects.toThrow(/version 1 is unsupported/);
  expect(f.runtime.services.getSnapshot().providers.some(provider => provider.extensionId === 'review.policy-v2')).toBe(false);
});


it('a routing change between version-intent inspection and provider preparation fails before the implicit provider activates', async () => {
  const f = await fixture();
  await f.install(2);
  const read = f.runtime.routing.read.bind(f.runtime.routing);
  let entered!: () => void; let release!: () => void; let reads = 0;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const releaseGate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.routing.read = async () => {
    const snapshot = await read();
    if (++reads === 1) { entered(); await releaseGate; }
    return snapshot;
  };
  const pending = f.prepare({ sessionId: 'thread', projectId: 'current' });
  try {
    await enteredGate;
    await f.route(1, 'review.policy-v1:host:varin.agent.policy@1', { projectId: 'current' });
    release();
    await expect(pending).rejects.toThrow(/routing changed during preparation/);
    expect(f.runtime.services.getSnapshot().providers.some(provider => provider.extensionId === 'review.policy-v2')).toBe(false);
  } finally { release(); }
});


it('a registry selection arriving while v2 absence is being resolved cannot silently select the default loop', async () => {
  const f = await fixture();
  const old = await f.install(1);
  await f.runtime.supervisor.activateExtension('review.policy-v1');
  const provider = f.runtime.services.getSnapshot().providers.find(provider => provider.providerKey === old)!;
  const read = f.runtime.routing.read.bind(f.runtime.routing);
  let entered!: () => void; let release!: () => void; let reads = 0;
  const enteredGate = new Promise<void>(resolve => { entered = resolve; });
  const releaseGate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.routing.read = async () => {
    const snapshot = await read();
    if (++reads === 2) { entered(); await releaseGate; }
    return snapshot;
  };
  const pending = f.prepare({ sessionId: 'thread', projectId: 'current' });
  try {
    await enteredGate;
    await f.runtime.setServiceSelection({ serviceId: 'varin.agent.policy', version: 1, providerId: provider.providerId });
    release();
    await expect(pending).rejects.toThrow(/Policy selection changed during preparation/);
  } finally { release(); }
});
