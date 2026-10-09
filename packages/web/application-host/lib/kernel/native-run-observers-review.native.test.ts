import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createKernelClient } from './kernel-client.js';
import { NativeRuntimeClient } from './native-runtime-client.js';
import { NativeRunObservers } from './native-run-observers.js';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH!;
const buildVersion = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const poll = (fn: () => unknown) => expect.poll(fn, { timeout: 10_000 });
const serviceId = 'varin.run.activity';
const key = (id = 'example.run-activity') => `${id}:host:${serviceId}@1`;
const subscription = (thread = 'thread', id = 'example.run-activity') => JSON.stringify([`${serviceId}@1`, key(id), thread, '']);
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-observer-review-'));
  let child!: ChildProcessWithoutNullStreams;
  const kernel = createKernelClient({ hostId: 'observer-review', storageRoot: path.join(root, 'kernel'), buildVersion, kernelPath, allowCargoDevRunner: false,
    spawnProcess: ((...args: Parameters<typeof spawn>) => { child = spawn(...args) as ChildProcessWithoutNullStreams; return child; }) as typeof spawn });
  const runtime = new NativeRuntimeClient(kernel);
  const extensions = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: buildVersion, brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await extensions.start();
  const errors: unknown[] = []; let observers: NativeRunObservers | undefined;
  cleanups.push(async () => { observers?.stop(); await extensions.stop(); await kernel.close(); await fs.rm(root, { recursive: true, force: true }); });
  const start = () => { observers = new NativeRunObservers(runtime, extensions, (_thread, error) => errors.push(error)); return observers; };
  async function install(id = 'example.run-activity', code?: string) {
    const dir = path.join(root, id); await fs.mkdir(dir, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(repository, 'examples/extensions/run-activity/varin.extension.json'), 'utf8')); manifest.id = id;
    await fs.writeFile(path.join(dir, 'varin.extension.json'), JSON.stringify(manifest));
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
    if (code) await fs.writeFile(path.join(dir, 'host.ts'), code);
    await build({ entryPoints: [code ? path.join(dir, 'host.ts') : path.join(repository, 'examples/extensions/run-activity/host.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'host.cjs'), alias: { '@varin/extension-sdk': path.join(repository, 'packages/extension-sdk/dist/index.js') } });
    await extensions.installOrStage({ expectedRevision: (await extensions.state()).catalog.revision, source: { kind: 'local', display: id, specifier: dir } });
  }
  async function route(thread = 'thread', id = 'example.run-activity') {
    await extensions.upsertServiceRoutingRule({ expectedRevision: (await extensions.routing.read()).document.revision, rule: { serviceId, version: 1, providerKey: key(id), scope: { sessionId: thread }, allowFallback: false } });
  }
  async function submit(thread = 'thread') { await runtime.createThread(thread, `${thread}-branch`); return runtime.submit({ key: `input-${thread}`, threadId: thread, branchId: `${thread}-branch`, expectedHead: null, input: { text: 'private content must not reach observer' }, configuration: {} }); }
  const invoke = (method: string, args: any[] = [], thread = 'thread') => extensions.invokeService({ serviceId, version: 1, method, args, routing: { sessionId: thread } });
  return { root, runtime, kernel, extensions, errors, start, install, route, submit, invoke,
    async crash() { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } };
}
const gated = (ack = 'd') => `import { defineHostExtension } from '@varin/extension-sdk';
export default defineHostExtension({migrate: ({data}) => data, activate(c) { let pending = []; let seen = []; c.services.provide({id:'varin.run.activity',version:1,multiple:true}, {
observe: async ([d]) => { seen.push(d); await new Promise(resolve => pending.push(resolve)); const a = ${ack}; return {subscriptionId:a.subscriptionId,deliveryId:a.deliveryId,cursor:a.fact.cursor}; },
seen: () => seen, release: () => {pending.splice(0).forEach(f=>f()); return null;}
}); }});`;
it('installed but unselected observer reads no runtime and starts no broker', async () => {
  const f = await fixture(); await f.install();
  const status = vi.spyOn(f.runtime, 'status'), threads = vi.spyOn(f.runtime, 'threads'), prepare = vi.spyOn(f.extensions, 'prepareService');
  f.start(); await new Promise(resolve => setTimeout(resolve, 50));
  expect(status).not.toHaveBeenCalled(); expect(threads).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(f.extensions.supervisor.activeExtensions()).toEqual([]);
});
it('actual example projects committed native facts and exact acknowledgements survive kernel restart', async () => {
  const f = await fixture(); await f.install(); await f.install('example.unused', gated()); await f.route(); const receipt = await f.submit(); const observer = f.start();
  await poll(() => f.invoke('getSnapshot', [subscription()])).toMatchObject({ projection: { [receipt.run_id]: { state: 'accepted' } } });
  await poll(() => f.runtime.observerEvents(subscription(), 'thread', 64)).toEqual([]);
  expect(f.extensions.supervisor.activeExtensions()).not.toContain('example.unused');
  await f.runtime.cancelRun(receipt.run_id);
  await poll(() => f.invoke('getSnapshot', [subscription()])).toMatchObject({ projection: { [receipt.run_id]: { state: 'cancelled' } } });
  await poll(() => f.runtime.observerEvents(subscription(), 'thread', 64)).toEqual([]);
  await f.crash(); await f.runtime.status();
  await f.route('after-restart'); const next = await f.submit('after-restart');
  await poll(() => f.invoke('getSnapshot', [subscription('after-restart')], 'after-restart')).toMatchObject({ projection: { [next.run_id]: { state: 'accepted' } } });
  observer.stop();
});
it('native cursor authority rejects wrong thread, wrong cursor and skipped sent admission', async () => {
  const f = await fixture(); await f.submit(); await f.submit('other');
  const facts = await f.runtime.observerEvents(subscription(), 'thread', 64); expect(facts).toHaveLength(1);
  expect(await f.runtime.observerEvents(subscription(), 'thread', 64, undefined, facts[0]!.cursor - 1)).toEqual([]);
  expect(await f.runtime.observerEvents(subscription(), 'thread', 64, undefined, facts[0]!.cursor)).toEqual(facts);
  await expect(f.runtime.observerDelivery(subscription(), 'other', facts[0]!.cursor, 'selected')).rejects.toThrow();
  await expect(f.runtime.observerDelivery(subscription(), 'thread', facts[0]!.cursor + 1, 'selected')).rejects.toThrow();
  await expect(f.runtime.observerDelivery(subscription(), 'thread', facts[0]!.cursor, 'committed')).rejects.toThrow();
  expect(await f.runtime.observerEvents(subscription(), 'thread', 64)).toEqual(facts);
});
it('hung broker does not block another subscription, native cancel, or observer stop', async () => {
  const f = await fixture(); await f.install('example.slow', gated()); await f.install(); await f.route('slow', 'example.slow'); await f.route('fast');
  const slow = await f.submit('slow'); const observer = f.start();
  await poll(() => f.invoke('seen', [], 'slow')).toHaveLength(1);
  const fast = await f.submit('fast');
  await poll(() => f.invoke('getSnapshot', [subscription('fast')], 'fast')).toMatchObject({ projection: { [fast.run_id]: { state: 'accepted' } } });
  await f.runtime.cancelRun(slow.run_id); expect((await f.runtime.run(slow.run_id)).state).toBe('cancelled');
  observer.stop(); expect((await f.runtime.observerEvents(subscription('slow', 'example.slow'), 'slow', 64)).length).toBeGreaterThan(0);
});
it.each(['({...d, fact:{...d.fact,cursor:d.fact.cursor+1}})', '({...d, subscriptionId:"wrong-thread-subscription"})', '({...d, deliveryId:"wrong-invocation"})', '({...d, fact:{...d.fact,cursor:null}})'])('wrong or malformed broker ACK never commits original fact: %s', async ack => {
  const f = await fixture(); await f.install('example.bad', gated(ack)); await f.route('thread', 'example.bad'); await f.submit(); f.start();
  await poll(() => f.invoke('seen')).toHaveLength(1); await f.invoke('release');
  await poll(() => f.errors.length).toBeGreaterThan(0);
  expect(await f.runtime.observerEvents(subscription('thread', 'example.bad'), 'thread', 64)).toHaveLength(1);
});
it('routing replacement rejects old ACK while thread refresh is pending', async () => {
  const f = await fixture(); await f.install('example.old', gated()); await f.install(); await f.route('thread', 'example.old'); await f.submit(); f.start();
  await poll(() => f.invoke('seen')).toHaveLength(1);
  const oldBinding = await f.extensions.prepareService({ serviceId, version:1, method:'release', args:[], routing:{sessionId:'thread'} });
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); const realThreads = f.runtime.threads.bind(f.runtime);
  vi.spyOn(f.runtime, 'threads').mockImplementation(async signal => { const result = await realThreads(signal); await gate; return result; });
  await f.route();
  await oldBinding.invoke('release', []);
  await new Promise(resolve => setTimeout(resolve, 50));
  try { expect(await f.runtime.observerEvents(subscription('thread', 'example.old'), 'thread', 64)).toHaveLength(1); } finally { release(); }
});
it('lost ACK replays after worker/kernel reopen without applying projection twice', async () => {
  const f = await fixture();
  await f.install('example.run-activity', `import {defineHostExtension,provideRunActivityProjection} from '@varin/extension-sdk'; export default defineHostExtension({migrate:({data})=>data,activate(c){provideRunActivityProjection(c,(p,d)=>({count:Number(p.count??0)+1}));}});`);
  await f.route(); await f.submit();
  const original = f.runtime.observerDelivery.bind(f.runtime);
  const delivery = vi.spyOn(f.runtime, 'observerDelivery').mockImplementation((id, thread, cursor, state, signal) => state === 'committed' ? Promise.reject(new Error('test lost ACK before durable commit')) : original(id, thread, cursor, state, signal));
  const first = f.start();
  await poll(() => f.invoke('getSnapshot', [subscription()])).toMatchObject({ projection: { count: 1 } });
  await poll(() => f.errors.length).toBeGreaterThan(0);
  expect(await f.runtime.observerEvents(subscription(), 'thread', 64)).toHaveLength(1);
  first.stop(); await f.extensions.stop(); await f.crash(); delivery.mockRestore();
  await f.runtime.status();
  const replacement = await ApplicationExtensionRuntime.create({ dataDir: path.join(f.root, 'extensions'), varinVersion: buildVersion, brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await replacement.start(); const observers = new NativeRunObservers(f.runtime, replacement, (_thread, error) => f.errors.push(error));
  cleanups.push(async () => { observers.stop(); await replacement.stop(); });
  await poll(() => f.runtime.observerEvents(subscription(), 'thread', 64)).toEqual([]);
  expect(await replacement.invokeService({serviceId,version:1,method:'getSnapshot',args:[subscription()],routing:{sessionId:'thread'}})).toMatchObject({projection:{count:1}});
});
it('a dirty wake between successful pump resolution and its finally drains real newly committed facts', async () => {
  const f = await fixture(); await f.install(); await f.route(); const receipt = await f.submit();
  // Hold producer notifications only to place the real committed fact at the exact pump interleave.
  let mute = false; const onEvent = f.runtime.onEvent.bind(f.runtime);
  vi.spyOn(f.runtime, 'onEvent').mockImplementation(listener => onEvent(event => { if (!mute) listener(event); }));
  const observer = f.start();
  await poll(() => f.runtime.observerEvents(subscription(), 'thread', 64)).toEqual([]);
  const control = observer as unknown as { subscriptions: Map<string, unknown>; sourceCursor: number; kick(value: unknown): void };
  const current = control.subscriptions.get('thread'); expect(current).toBeDefined();
  const read = f.runtime.observerEvents.bind(f.runtime); let inject = true;
  vi.spyOn(f.runtime, 'observerEvents').mockImplementation(async (...args) => {
    const facts = await read(...args);
    if (inject && facts.length === 0) {
      inject = false; mute = true; await f.runtime.cancelRun(receipt.run_id);
      // Model the source reader having processed that real commit before issuing its dirty wake.
      control.sourceCursor = (await f.runtime.status()).eventCursor;
      // First microtask precedes the pump's await continuation; second follows that continuation
      // but precedes its chained finally. This used to leave dirty=true,pumping=false forever.
      queueMicrotask(() => queueMicrotask(() => { control.kick(current); mute = false; }));
    }
    return facts;
  });
  control.kick(current);
  await poll(() => f.invoke('getSnapshot', [subscription()])).toMatchObject({ projection: { [receipt.run_id]: { state: 'cancelled' } } });
  expect(await read(subscription(), 'thread', 64)).toEqual([]);
});
it('next real durable notification recovers a failed initial head read without kernel exit', async () => {
  const f = await fixture(); await f.install(); await f.route(); await f.invoke('inspect');
  const status = f.runtime.status.bind(f.runtime); let fail = true;
  vi.spyOn(f.runtime, 'status').mockImplementation(async signal => { const result = await status(signal); if (fail) { fail = false; throw new Error('transient read failure after actual committed head'); } return result; });
  f.start(); await poll(() => f.errors.length).toBeGreaterThan(0);
  const receipt = await f.submit();
  await poll(() => f.invoke('getSnapshot', [subscription()])).toMatchObject({ projection: { [receipt.run_id]: { state: 'accepted' } } });
});
it('normal same-provider retirement admits an old pinned ACK and preserves its original committed fact', async () => {
  const f = await fixture(); await f.install('example.old', gated()); await f.route('thread', 'example.old'); await f.submit(); f.start();
  await poll(() => f.invoke('seen')).toHaveLength(1);
  const binding = await f.extensions.prepareService({serviceId,version:1,method:'release',args:[],routing:{sessionId:'thread'}});
  const old = binding.pin();
  // A changed module of the same provider prepares an ordinary new generation.
  await f.install('example.old', gated().replace('let seen = [];', "let seen = ['generation2'];"));
  const catalog = await f.extensions.catalog.snapshot(); const candidate = catalog.extensions.find(entry => entry.manifest.id === 'example.old')!.candidate!;
  await f.extensions.requestCandidateApplication({extensionId:'example.old',candidateIntegrity:candidate.integrity,expectedRevision:(await f.extensions.catalog.snapshot()).revision});
  await f.extensions.prepareCandidate('example.old', candidate.integrity);
  const selecting = f.extensions.selectCandidate({extensionId:'example.old',candidateIntegrity:candidate.integrity,expectedRevision:(await f.extensions.catalog.snapshot()).revision});
  let selectionError: unknown; void selecting.catch(error => { selectionError = error; });
  try {
    await poll(() => { if (selectionError) throw selectionError; return f.extensions.services.getSnapshot().providers.find(p => p.providerId === binding.providerId)?.status; }).toBe('draining');
    await old.invoke('release', []); old.release();
    await poll(() => f.runtime.observerEvents(subscription('thread','example.old'),'thread',64)).toEqual([]);
    await selecting;
  } finally { old.release(); await selecting.catch(() => {}); }
});
it('same Observer recovers pending delivery on handshake alone without a new Run fact', async () => {
  const f = await fixture(); await f.install(); await f.route(); await f.submit();
  const original = f.runtime.observerDelivery.bind(f.runtime);
  const delivery = vi.spyOn(f.runtime, 'observerDelivery').mockImplementation((id, thread, cursor, state, signal) => state === 'committed' ? Promise.reject(new Error('hold durable ACK until kernel restart')) : original(id, thread, cursor, state, signal));
  f.start(); await poll(() => f.errors.length).toBeGreaterThan(0);
  expect(await f.runtime.observerEvents(subscription(), 'thread', 64)).toHaveLength(1);
  await f.crash(); delivery.mockRestore(); await f.runtime.status();
  await poll(() => f.runtime.observerEvents(subscription(), 'thread', 64)).toEqual([]);
});
it('explicit disable terminates noncooperative observer and never commits its late delivery', async () => {
  const f = await fixture(); await f.install('example.disabled', gated()); await f.route('thread', 'example.disabled'); await f.submit(); f.start();
  await poll(() => f.invoke('seen')).toHaveLength(1);
  await f.extensions.setEnabled('example.disabled', false, (await f.extensions.state()).catalog.revision);
  expect(await f.runtime.observerEvents(subscription('thread','example.disabled'),'thread',64)).toHaveLength(1);
});
it('new branch project ambiguity removes prior project-scoped observer before later facts', async () => {
  const f = await fixture(); await f.install();
  await f.extensions.upsertServiceRoutingRule({expectedRevision:(await f.extensions.routing.read()).document.revision,rule:{serviceId,version:1,providerKey:key(),scope:{projectId:'project-a'},allowFallback:false}});
  const context = (projectId: string) => ({effectiveSystemPrompt:'',instructionSources:[],memoryCheckpoint:null,personalization:{revision:1,sessionId:'thread',projectId,originalSections:[],instructionSources:[]}});
  await f.runtime.createThread('thread','thread-branch');
  await f.runtime.forkBranch('thread-branch','forked-branch',null);
  const first = await f.runtime.submit({key:'scoped-first',threadId:'thread',branchId:'thread-branch',expectedHead:null,input:{text:'first'},configuration:{},initialContext:context('project-a')});
  const id = JSON.stringify([`${serviceId}@1`,key(),'thread','project-a']);
  const snapshot = () => f.extensions.invokeService({serviceId,version:1,method:'getSnapshot',args:[id],routing:{sessionId:'thread',projectId:'project-a'}});
  f.start(); await poll(snapshot).toMatchObject({projection:{[first.run_id]:{state:'accepted'}}});
  let releaseScope!: () => void; const scopeGate = new Promise<void>(resolve => releaseScope = resolve); let scopeRead = false;
  const readContext = f.runtime.context.bind(f.runtime);
  vi.spyOn(f.runtime, 'context').mockImplementation(async (branch, signal) => { const result = await readContext(branch, signal); if (branch === 'forked-branch') { scopeRead = true; await scopeGate; } return result; });
  const second = await f.runtime.submit({key:'scoped-second',threadId:'thread',branchId:'forked-branch',expectedHead:null,input:{text:'second'},configuration:{},initialContext:context('project-b')});
  await poll(() => scopeRead).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 100));
  try { expect((await snapshot() as any).projection[second.run_id]).toBeUndefined(); } finally { releaseScope(); }
  await poll(() => f.errors.map(String).some(value => value.includes('unambiguous'))).toBe(true);
  expect((await f.runtime.observerEvents(id,'thread',64)).some(fact => fact.subject === second.run_id)).toBe(true);
});
