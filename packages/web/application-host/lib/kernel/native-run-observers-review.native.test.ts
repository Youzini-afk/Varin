import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
import { createSettingsNormalizationRuntime } from '../platform/settings-normalization-runtime.js';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const { build } = createRequire(path.join(repository, 'packages/extension-builtins/package.json'))('esbuild');
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH!;
const buildVersion = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8')).version;
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const poll = (fn: () => unknown) => expect.poll(fn, { timeout: 10_000 });
const serviceId = 'varin.run.activity';
const key = (id = 'example.run-activity') => `${id}:host:${serviceId}@1`;
const subscription = (thread = 'thread', id = 'example.run-activity', project: string | null = null) => JSON.stringify([`${serviceId}@1`, key(id), thread, project]);
const context = (projectId: string) => ({effectiveSystemPrompt:'private prompt',instructionSources:[],memoryCheckpoint:null,personalization:{mode:'agent',threadRole:'main',memorySnapshot:{revision:0,memories:[]},configurationDigest:'review-profile-v1',revision:1,sessionId:'thread',projectId,originalSections:[],instructionSources:[]}});
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
  let entered = false; let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); const realThreads = f.runtime.threads.bind(f.runtime);
  vi.spyOn(f.runtime, 'threads').mockImplementation(async signal => { const result = await realThreads(signal); entered = true; await gate; return result; });
  await f.route(); await poll(() => entered).toBe(true);
  await oldBinding.invoke('release', []);
  await new Promise(resolve => setTimeout(resolve, 50));
  try { expect(await f.runtime.observerEvents(subscription('thread', 'example.old'), 'thread', 64)).toHaveLength(1); } finally { release(); }
});
it.each([null, 'project-a'])('lost ACK in scope %s replays after worker/kernel reopen without applying projection twice', async project => {
  const f = await fixture();
  await f.install('example.run-activity', `import {defineHostExtension,provideRunActivityProjection} from '@varin/extension-sdk'; export default defineHostExtension({migrate:({data})=>data,activate(c){provideRunActivityProjection(c,(p,d)=>({count:Number(p.count??0)+1}));}});`);
  await f.route();
  if (project === null) await f.submit(); else { await f.runtime.createThread('thread','thread-branch'); await submitScoped(f,'thread-branch',project,'scoped-replay'); }
  const id = subscription('thread','example.run-activity',project);
  const original = f.runtime.observerDelivery.bind(f.runtime);
  const delivery = vi.spyOn(f.runtime, 'observerDelivery').mockImplementation((id, thread, cursor, state, signal) => state === 'committed' ? Promise.reject(new Error('test lost ACK before durable commit')) : original(id, thread, cursor, state, signal));
  const first = f.start();
  await poll(() => f.invoke('getSnapshot', [id])).toMatchObject({ projection: { count: 1 } });
  await poll(() => f.errors.length).toBeGreaterThan(0);
  expect(await f.runtime.observerEvents(id, 'thread', 64)).toHaveLength(1);
  first.stop(); await f.extensions.stop(); await f.crash(); delivery.mockRestore();
  await f.runtime.status();
  const replacement = await ApplicationExtensionRuntime.create({ dataDir: path.join(f.root, 'extensions'), varinVersion: buildVersion, brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await replacement.start(); const observers = new NativeRunObservers(f.runtime, replacement, (_thread, error) => f.errors.push(error));
  cleanups.push(async () => { observers.stop(); await replacement.stop(); });
  await poll(() => f.runtime.observerEvents(id, 'thread', 64)).toEqual([]);
  expect(await replacement.invokeService({serviceId,version:1,method:'getSnapshot',args:[id],routing:{sessionId:'thread'}})).toMatchObject({projection:{count:1}});
});
it('a dirty wake between successful pump resolution and its finally drains real newly committed facts', async () => {
  const f = await fixture(); await f.install(); await f.route(); const receipt = await f.submit();
  // Hold producer notifications only to place the real committed fact at the exact pump interleave.
  let mute = false; const onEvent = f.runtime.onEvent.bind(f.runtime);
  vi.spyOn(f.runtime, 'onEvent').mockImplementation(listener => onEvent(event => { if (!mute) listener(event); }));
  const observer = f.start();
  await poll(() => f.runtime.observerEvents(subscription(), 'thread', 64)).toEqual([]);
  const control = observer as unknown as { subscriptions: Map<string, unknown>; sourceCursor: number; kick(value: unknown): void };
  const current = control.subscriptions.get(JSON.stringify(['thread', null])); expect(current).toBeDefined();
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
async function projectRoute(f: Awaited<ReturnType<typeof fixture>>, projectId: string, id: string) {
  await f.extensions.upsertServiceRoutingRule({expectedRevision:(await f.extensions.routing.read()).document.revision,rule:{serviceId,version:1,providerKey:key(id),scope:{projectId},allowFallback:false}});
}
const projectInvoke = (f: Awaited<ReturnType<typeof fixture>>, projectId: string, id: string, method = 'getSnapshot') =>
  f.extensions.invokeService({serviceId,version:1,method,args:method === 'getSnapshot' ? [subscription('thread',id,projectId)] : [],routing:{sessionId:'thread',projectId}});
async function submitScoped(f: Awaited<ReturnType<typeof fixture>>, branchId: string, projectId: string, key: string) {
  return f.runtime.submit({key,threadId:'thread',branchId,expectedHead:null,input:{text:key},configuration:{},initialContext:context(projectId)});
}
it('no-context forks admit A and B independently and deliver actual facts only to their selected brokers', async () => {
  const f = await fixture(); await f.install('example.a'); await f.install('example.b');
  await projectRoute(f,'project-a','example.a'); await projectRoute(f,'project-b','example.b');
  await f.runtime.createThread('thread','thread-branch'); await f.runtime.forkBranch('thread-branch','forked-branch',null);
  const a = await submitScoped(f,'thread-branch','project-a','a'); f.start();
  await poll(() => projectInvoke(f,'project-a','example.a')).toMatchObject({projection:{[a.run_id]:{state:'accepted'}}});
  const b = await submitScoped(f,'forked-branch','project-b','b');
  await poll(() => projectInvoke(f,'project-b','example.b')).toMatchObject({projection:{[b.run_id]:{state:'accepted'}}});
  await f.runtime.cancelRun(a.run_id); await f.runtime.cancelRun(b.run_id);
  await poll(() => projectInvoke(f,'project-a','example.a')).toMatchObject({projection:{[a.run_id]:{state:'cancelled'}}});
  await poll(() => projectInvoke(f,'project-b','example.b')).toMatchObject({projection:{[b.run_id]:{state:'cancelled'}}});
  expect(Object.keys((await projectInvoke(f,'project-a','example.a') as any).projection)).toEqual([a.run_id]);
  expect(Object.keys((await projectInvoke(f,'project-b','example.b') as any).projection)).toEqual([b.run_id]);
  expect((await f.runtime.thread('thread')).observer_project_ids).toEqual(['project-a','project-b']);
  expect(f.errors).toEqual([]);
});
it('unscoped Run remains null-scoped after its branch gains context, including terminal facts and restart discovery', async () => {
  const f = await fixture(); const first = await f.submit();
  await f.runtime.cancelRun(first.run_id);
  const head = (await f.runtime.thread('thread')).branches[0]!.head;
  const second = await f.runtime.submit({key:'later',threadId:'thread',branchId:'thread-branch',expectedHead:head,input:{text:'later'},configuration:{},initialContext:context('project-a')});
  await f.runtime.cancelRun(second.run_id); await f.crash(); await f.runtime.status();
  expect((await f.runtime.thread('thread')).observer_project_ids).toEqual([null,'project-a']);
  const unscoped = await f.runtime.observerEvents(subscription(),'thread',64);
  const scoped = await f.runtime.observerEvents(subscription('thread','example.run-activity','project-a'),'thread',64);
  expect(new Set(unscoped.map(fact => fact.subject))).toEqual(new Set([first.run_id]));
  expect(new Set(scoped.map(fact => fact.subject))).toEqual(new Set([second.run_id]));
  expect(unscoped.some(fact => (fact.data as {state?: string}).state === 'cancelled')).toBe(true);
  await f.install(); await f.route(); f.start();
  await poll(() => f.invoke('getSnapshot',[subscription()])).toMatchObject({projection:{[first.run_id]:{state:'cancelled'}}});
  await poll(() => f.invoke('getSnapshot',[subscription('thread','example.run-activity','project-a')])).toMatchObject({projection:{[second.run_id]:{state:'cancelled'}}});
});
it('queued NextRun pins scope at enqueue rather than promotion or later branch context', async () => {
  const f = await fixture(); const first = await f.submit();
  const queuedNull = await f.runtime.enqueue({key:'queued-null',threadId:'thread',branchId:'thread-branch',mode:'next_run',input:{text:'queued null'}});
  await f.runtime.cancelRun(first.run_id); await f.runtime.cancelRun(queuedNull.run_id);
  const head = (await f.runtime.thread('thread')).branches[0]!.head;
  const activeA = await f.runtime.submit({key:'first-context',threadId:'thread',branchId:'thread-branch',expectedHead:head,input:{text:'first A context'},configuration:{},initialContext:context('project-a')});
  const queuedA = await f.runtime.enqueue({key:'queued-a',threadId:'thread',branchId:'thread-branch',mode:'next_run',input:{text:'queued A'}});
  await f.runtime.refreshContext({branchId:'thread-branch',expectedRevision:1,context:{...context('project-a'),personalization:{...context('project-a').personalization,configurationDigest:'review-profile-v2',revision:2},effectiveSystemPrompt:'refreshed execution prompt'}});
  await f.runtime.cancelRun(activeA.run_id); await f.runtime.cancelRun(queuedA.run_id);
  const subjects = async (project: string | null) => new Set((await f.runtime.observerEvents(subscription('thread','example.run-activity',project),'thread',64)).map(fact => fact.subject));
  expect(await subjects(null)).toEqual(new Set([first.run_id,queuedNull.run_id]));
  expect(await subjects('project-a')).toEqual(new Set([activeA.run_id,queuedA.run_id]));
  expect(await subjects('project-b')).toEqual(new Set());
});
it('exact nullable project scope rejects wrong-scope ACKs and reads, keeps valid project distinct, and fences throughCursor', async () => {
  const f = await fixture(); const first = await f.submit();
  await f.runtime.forkBranch('thread-branch','scoped-branch',null);
  const scoped = await submitScoped(f,'scoped-branch','project-a','scoped');
  const nullId = subscription(), scopedId = subscription('thread','example.run-activity','project-a');
  const nullFacts = await f.runtime.observerEvents(nullId,'thread',64), scopedFacts = await f.runtime.observerEvents(scopedId,'thread',64);
  expect(nullFacts.map(fact => fact.subject)).toEqual([first.run_id]); expect(scopedFacts.map(fact => fact.subject)).toEqual([scoped.run_id]);
  expect(await f.runtime.observerEvents(scopedId,'thread',64,undefined,scopedFacts[0]!.cursor - 1)).toEqual([]);
  expect(await f.runtime.observerEvents(scopedId,'thread',64,undefined,scopedFacts[0]!.cursor)).toEqual(scopedFacts);
  await expect(f.runtime.observerDelivery(nullId,'thread',scopedFacts[0]!.cursor,'selected')).rejects.toThrow();
  await expect(f.runtime.observerDelivery(scopedId,'thread',nullFacts[0]!.cursor,'selected')).rejects.toThrow();
  await expect(f.runtime.observerEvents(nullId,'other',64)).rejects.toThrow();
  for (const state of ['selected','sent','committed'] as const) await f.runtime.observerDelivery(scopedId,'thread',scopedFacts[0]!.cursor,state);
  expect(await f.runtime.observerEvents(scopedId,'thread',64)).toEqual([]);
  expect(await f.runtime.observerEvents(nullId,'thread',64)).toEqual(nullFacts);
  // Use a different real provider so the earlier manual ACK does not suppress its delivery.
  await f.install('example.exact'); await f.route('thread','example.exact'); f.start();
  const nullSnapshot = subscription('thread','example.exact',null), scopedSnapshot = subscription('thread','example.exact','project-a');
  await poll(() => f.invoke('getSnapshot',[nullSnapshot])).toMatchObject({projection:{[first.run_id]:{state:'accepted'}}});
  await poll(() => f.invoke('getSnapshot',[scopedSnapshot])).toMatchObject({projection:{[scoped.run_id]:{state:'accepted'}}});
  expect(Object.keys((await f.invoke('getSnapshot',[nullSnapshot]) as any).projection)).toEqual([first.run_id]);
  expect(Object.keys((await f.invoke('getSnapshot',[scopedSnapshot]) as any).projection)).toEqual([scoped.run_id]);
});
it.each(['', ' ', '\t\n', ' project-a', 'project-a ', ' project-a '])('noncanonical project %j is rejected before admission and creates no global Observer delivery', async project => {
  const f = await fixture(); const unscoped = await f.submit();
  await f.runtime.forkBranch('thread-branch','invalid-branch',null);
  await f.install(); await f.route(); f.start();
  await poll(() => f.invoke('getSnapshot',[subscription()])).toMatchObject({projection:{[unscoped.run_id]:{state:'accepted'}}});
  await poll(() => f.runtime.observerEvents(subscription(),'thread',64)).toEqual([]);
  const cursor = (await f.runtime.status()).eventCursor;
  await expect(submitScoped(f,'invalid-branch',project,'invalid-project')).rejects.toThrow(/project/i);
  const invalidScope = subscription('thread','example.run-activity',project);
  expect(await f.runtime.observerEvents(invalidScope,'thread',64)).toEqual([]);
  await expect(f.runtime.observerDelivery(invalidScope,'thread',unscoped.cursor,'selected')).rejects.toThrow();
  expect(await f.runtime.context('invalid-branch')).toBeNull();
  expect(await f.runtime.history('invalid-branch')).toEqual([]);
  const thread = await f.runtime.thread('thread');
  expect(thread.observer_project_ids).toEqual([null]);
  expect(thread.branches.find(branch => branch.branch_id === 'invalid-branch')!.latest_run).toBeNull();
  expect((await f.runtime.events(cursor,64)).filter(event => event.kind === 'run.accepted')).toEqual([]);
  expect(Object.keys((await f.invoke('getSnapshot',[subscription()]) as any).projection)).toEqual([unscoped.run_id]);
});
it.each(['prepare','observe'])('slow %s in project A never blocks project B in the same Thread', async mode => {
  const f = await fixture(); await f.install('example.a',mode === 'observe' ? gated() : undefined); await f.install('example.b');
  await projectRoute(f,'project-a','example.a'); await projectRoute(f,'project-b','example.b');
  await f.runtime.createThread('thread','thread-branch'); await f.runtime.forkBranch('thread-branch','forked-branch',null);
  let release!: () => void; const gate = new Promise<void>(resolve => release = resolve); let entered = false;
  const prepare = f.extensions.prepareService.bind(f.extensions);
  if (mode === 'prepare') vi.spyOn(f.extensions,'prepareService').mockImplementation(async request => { if ((request as {routing?: {projectId?: string}}).routing?.projectId === 'project-a') {entered = true; await gate;} return prepare(request); });
  const a = await submitScoped(f,'thread-branch','project-a','a'); const observer = f.start();
  if (mode === 'prepare') await poll(() => entered).toBe(true); else await poll(() => projectInvoke(f,'project-a','example.a','seen')).toHaveLength(1);
  try {
    const b = await submitScoped(f,'forked-branch','project-b','b');
    await poll(() => projectInvoke(f,'project-b','example.b')).toMatchObject({projection:{[b.run_id]:{state:'accepted'}}});
    await f.runtime.cancelRun(a.run_id); expect((await f.runtime.run(a.run_id)).state).toBe('cancelled');
  } finally { observer.stop(); release(); }
});
it('opening a genuine old context schema fails clearly without deleting or rewriting history and content', async () => {
  const f = await fixture(); await f.runtime.createThread('thread','thread-branch'); await submitScoped(f,'thread-branch','project-a','old-history');
  await f.crash();
  const database = path.join(f.root,'kernel','agent-runtime','conversation.sqlite');
  const python = (script: string) => execFileSync('python3',['-c',script,database],{encoding:'utf8'});
  python("import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('ALTER TABLE runs DROP COLUMN context_checkpoint_id'); c.execute('ALTER TABLE context_checkpoints DROP COLUMN project_id'); c.execute(\"UPDATE runtime_domains SET version=1 WHERE name='context_checkpoints'\"); c.commit()");
  const snapshot = () => python("import sqlite3,sys,json,hashlib,pathlib; c=sqlite3.connect(sys.argv[1]); tables=[r[0] for r in c.execute(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\")]; print(json.dumps({t:c.execute('SELECT * FROM '+t).fetchall() for t in tables},sort_keys=True)); root=pathlib.Path(sys.argv[1]).parent/'content'; print(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.rglob('*')) if p.is_file()},sort_keys=True))");
  const before = snapshot(); expect(before).toContain('old-history');
  await expect(f.runtime.status()).rejects.toThrow(/unsupported context checkpoint format|context checkpoint.*preserved/);
  expect(snapshot()).toBe(before);
});

it.each(['\uFEFFproject-a\uFEFF', '\u0085project-a\u0085'])('native admission agrees with actual Host project canonicalization for %j', async project => {
  const owner = createSettingsNormalizationRuntime({os,path,processLike:{platform:process.platform,env:{}},realpathSync:value => value,
    tunnelBootstrapTtlDefaultMs:600000,tunnelBootstrapTtlMinMs:60000,tunnelBootstrapTtlMaxMs:3600000,
    tunnelSessionTtlDefaultMs:86400000,tunnelSessionTtlMinMs:3600000,tunnelSessionTtlMaxMs:604800000});
  const normalized = owner.sanitizeProjects([{id:project,path:'/tmp/project-a'}])?.[0]?.id ?? null;
  const f = await fixture(); await f.runtime.createThread('thread','thread-branch');
  const admission = await submitScoped(f,'thread-branch',project,'owner-canonicalization')
    .then(receipt => ({accepted:true,error:null,receipt}),error => ({accepted:false,error:String(error),receipt:null}));
  expect({normalized,accepted:admission.accepted,error:admission.error}).toMatchObject({normalized,accepted:normalized === project});
});
