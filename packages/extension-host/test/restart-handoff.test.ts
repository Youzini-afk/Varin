import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { VarinExtensionCatalogSnapshot, VarinExtensionHostStateSnapshot } from '@varin/extension-contract';

const extensionId = 'test.restart.native', serviceId = 'test.restart.read';
const directories: string[] = [];
const children: ChildProcess[] = [];
test.after(async () => { for (const child of children) if (child.connected) child.kill('SIGKILL'); await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(options: { grouped?: boolean; fails?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'varin-native-handoff-')); directories.push(root);
  for (const [name, version] of [['old', '1.0.0'], ['candidate', '2.0.0']]) {
    const directory = join(root, name!); await mkdir(directory);
    const grouped = name === 'candidate' && options.grouped;
    await writeFile(join(directory, 'varin.extension.json'), JSON.stringify({
      schemaVersion: 1, id: extensionId, version, engines: { varin: '*' },
      entrypoints: { host: { file: 'host.cjs', mode: 'native', activation: ['service-request'] },
        ...(grouped ? { surfaces: [{ id: 'panel', mode: 'managed', file: 'surface.cjs', supports: ['web'], activation: ['contribution-visible'] }] } : {}) },
      ...(grouped ? { updateReadiness: { surfaceEntrypoints: ['panel'] }, contributions: [{ id: `${extensionId}.panel`, entrypoint: 'panel',
        kind: 'page', contractVersion: 1, supports: ['web'], placement: { slot: 'workbench.secondary.after' }, data: {} }] } : {}),
      provides: { services: [{ id: serviceId, version: 1 }] },
    }));
    await writeFile(join(directory, 'host.cjs'), `
require('node:fs').appendFileSync(process.env.VARIN_RESTART_TEST_LOAD_LOG, process.pid + ':${version}\\n');
if (globalThis.loadedRestartVersion && globalThis.loadedRestartVersion !== '${version}') throw new Error('Both native generations entered the same process');
globalThis.loadedRestartVersion = '${version}';
module.exports = { activate(context) {
  ${name === 'candidate' && options.fails ? "throw new Error('Candidate activation failed after code evaluation');" : ''}
  context.services.provide({ id: '${serviceId}', version: 1 }, { read() { return '${version}'; } });
} };
`);
    if (grouped) await writeFile(join(directory, 'surface.cjs'), `module.exports = { activate(context) {
      context.contribute({ id: '${extensionId}.panel', kind: 'page', contractVersion: 1, supports: ['web'], placement: { slot: 'workbench.secondary.after' }, data: {} }, {
        async mount(container) {
          (globalThis.handoffMounts ??= []).push('${version}');
          await globalThis.handoffMountGate;
          if (globalThis.failHandoffMount) throw new Error('Actual candidate mount failed');
          container.textContent = '${version}';
          return () => { container.textContent = ''; };
        }
      });
    } };`);
  }
  const other = join(root, 'other'); await mkdir(other);
  await writeFile(join(other, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id: 'test.restart.other', version: '1.0.0', engines: { varin: '*' },
    entrypoints: { host: { file: 'host.cjs', mode: 'native', activation: ['service-request'] } }, provides: { services: [{ id: 'test.restart.other.read', version: 1 }] } }));
  await writeFile(join(other, 'host.cjs'), "module.exports={activate(context){context.services.provide({id:'test.restart.other.read',version:1},{read(){return 'unrelated service';}});}};");
  return root;
}
async function host(root: string) {
  const child = fork(new URL('./fixtures/restart-handoff-host.ts', import.meta.url), [join(root, 'data')], {
    execArgv: process.execArgv.filter(arg => arg !== '--test'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, VARIN_RESTART_TEST_LOAD_LOG: join(root, 'loads') },
  });
  children.push(child);
  let sequence = 0, errors = '';
  child.stderr?.on('data', bytes => { errors += String(bytes); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const ready = new Promise<VarinExtensionHostStateSnapshot>((resolve, reject) => {
    child.on('message', (raw: any) => {
      if (raw.ready) resolve(raw.state);
      else { const request = pending.get(raw.id); pending.delete(raw.id); if (raw.error) request?.reject(new Error(raw.error)); else request?.resolve(raw.result); }
    });
    child.on('exit', (code, signal) => { const error = new Error(`Test Host exited (${code ?? signal}): ${errors}`); reject(error); for (const request of pending.values()) request.reject(error); });
  });
  await ready;
  const call = <T = any>(operation: string, args: Record<string, unknown> = {}): Promise<T> => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); child.send({ id, operation, args });
  });
  return { call, pid: child.pid!, stop: () => call('stop') };
}
const entry = (state: VarinExtensionHostStateSnapshot) => state.catalog.extensions.find(value => value.manifest.id === extensionId)!;
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) { const value = await read(); if (check(value)) return value; if (Date.now() >= deadline) throw new Error(`Condition did not become true: ${JSON.stringify(value)}`); await delay(10); }
}
async function stage(root: string, instance: Awaited<ReturnType<typeof host>>, handoffId: string) {
  await instance.call('install', { directory: join(root, 'other') });
  await instance.call('install', { directory: join(root, 'old') });
  assert.equal(await instance.call('service', { serviceId }), '1.0.0');
  await instance.call('install', { directory: join(root, 'candidate') });
  await assert.rejects(instance.call('apply', { extensionId }), /restart handoff/);
  const requested = await instance.call<VarinExtensionCatalogSnapshot>('request', { extensionId, handoffId });
  assert.equal(requested.extensions.find(value => value.manifest.id === extensionId)!.restartHandoffs!.at(-1)!.status, 'pending-restart');
  await assert.rejects(instance.call('apply', { extensionId }), /restart|recovery/i);
  return requested;
}

test('clean Host prepares only the candidate, returns startup while awaiting actual mount, and retains the original commit after response loss', { timeout: 30_000 }, async () => {
  const root = await fixture({ grouped: true }), handoffId = randomUUID();
  const old = await host(root); await stage(root, old, handoffId); await old.stop();
  const fresh = await host(root);
  await until(() => fresh.call<VarinExtensionHostStateSnapshot>('state'), state => entry(state).restartHandoffs!.at(-1)!.status === 'waiting-surface');
  assert.equal((await readFile(join(root, 'loads'), 'utf8')).includes(`${fresh.pid}:1.0.0`), false);
  const surface = fresh.call('surface', { blockMount: true, lostResponse: true });
  await until(() => fresh.call<string[]>('mounts'), mounts => mounts.length > 0);
  const waiting = entry(await fresh.call<VarinExtensionHostStateSnapshot>('state'));
  assert.equal(waiting.selectedVersion, '1.0.0'); assert.equal(waiting.restartHandoffs!.at(-1)!.status, 'waiting-surface');
  assert.equal(await fresh.call('service', { serviceId: 'test.restart.other.read' }), 'unrelated service');
  await fresh.call('releaseMount'); await surface;
  const applied = entry(await fresh.call<VarinExtensionHostStateSnapshot>('state'));
  assert.equal(applied.selectedVersion, '2.0.0'); assert.equal(applied.restartHandoffs!.at(-1)!.id, handoffId);
  assert.equal(applied.restartHandoffs!.at(-1)!.status, 'applied');
  assert.equal(applied.restartHandoffs!.at(-1)!.surfaceReadiness!.preparedConsumerCount, 1);
  assert.deepEqual(applied.restartHandoffs!.at(-1)!.surfaceReadiness!.members.map(member => member.entrypointId), ['panel']);
  assert.equal(await fresh.call('service', { serviceId }), '2.0.0'); await fresh.stop();
  const reopened = await host(root); assert.equal(entry(await reopened.call('state')).restartHandoffs!.at(-1)!.status, 'applied');
  assert.equal(await reopened.call('service', { serviceId }), '2.0.0'); await reopened.stop();
});

test('failed evaluated candidate is durable, cannot load the old generation in that process, and does not auto-retry on another boot', { timeout: 30_000 }, async () => {
  const root = await fixture({ fails: true }), handoffId = randomUUID();
  const old = await host(root); await stage(root, old, handoffId); await old.stop();
  const fresh = await host(root);
  const failed = await until(() => fresh.call<VarinExtensionHostStateSnapshot>('state'), state => entry(state).restartHandoffs!.at(-1)!.status === 'failed');
  assert.match(entry(failed).restartHandoffs!.at(-1)!.failure!.message, /activation failed/);
  assert.equal(entry(failed).selectedVersion, '1.0.0');
  await assert.rejects(fresh.call('service', { serviceId }), /restart|recovery/i); await fresh.stop();
  const reopened = await host(root);
  assert.equal(entry(await reopened.call('state')).restartHandoffs!.at(-1)!.status, 'failed');
  assert.equal((await readFile(join(root, 'loads'), 'utf8')).includes(`${reopened.pid}:`), false);
  await reopened.call('recover', { extensionId, handoffId });
  await assert.rejects(reopened.call('service', { serviceId }), /restart|recovery/i); await reopened.stop();
  const recovered = await host(root);
  assert.equal(entry(await recovered.call('state')).restartHandoffs!.at(-1)!.status, 'restored');
  assert.equal(await recovered.call('service', { serviceId }), '1.0.0'); await recovered.stop();
});

test('interrupted waiting handoff fails once and an explicit retry preserves both original attempt identities', { timeout: 30_000 }, async () => {
  const root = await fixture({ grouped: true }), firstId = randomUUID();
  const old = await host(root); await stage(root, old, firstId); await old.stop();
  const waiting = await host(root);
  await until(() => waiting.call<VarinExtensionHostStateSnapshot>('state'), state => entry(state).restartHandoffs!.at(-1)!.status === 'waiting-surface');
  await waiting.stop();
  const retry = await host(root);
  const interrupted = entry(await retry.call('state')); assert.equal(interrupted.restartHandoffs!.at(-1)!.failure!.code, 'host_interrupted');
  const secondId = randomUUID(); await retry.call('request', { extensionId, handoffId: secondId }); await retry.stop();
  const next = await host(root);
  await until(() => next.call<VarinExtensionHostStateSnapshot>('state'), state => entry(state).restartHandoffs!.at(-1)!.status === 'waiting-surface');
  await next.call('surface');
  const records = entry(await next.call('state')).restartHandoffs!;
  assert.deepEqual(records.map(value => [value.id, value.status]), [[firstId, 'failed'], [secondId, 'applied']]); await next.stop();
});

test('real Surface mount failure leaves selection unchanged and records a terminal original handoff result', { timeout: 30_000 }, async () => {
  const root = await fixture({ grouped: true }), handoffId = randomUUID();
  const old = await host(root); await stage(root, old, handoffId); await old.stop();
  const next = await host(root);
  await until(() => next.call<VarinExtensionHostStateSnapshot>('state'), state => entry(state).restartHandoffs!.at(-1)!.status === 'waiting-surface');
  await next.call('surface', { failMount: true });
  const failed = entry(await next.call('state'));
  assert.equal(failed.selectedVersion, '1.0.0'); assert.equal(failed.restartHandoffs!.at(-1)!.status, 'failed');
  assert.equal(failed.restartHandoffs!.at(-1)!.failure!.code, 'surface_preparation_failed'); await next.stop();
});


test('fixed dependency withdrawal fails before candidate evaluation in the new process', { timeout: 30_000 }, async () => {
  const root = await fixture(), handoffId = randomUUID();
  const manifestPath = join(root, 'candidate', 'varin.extension.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.requires = { services: [{ id: 'test.restart.other.read', version: 1, realms: ['host'] }] };
  await writeFile(manifestPath, JSON.stringify(manifest));
  const old = await host(root); await stage(root, old, handoffId);
  await old.call('disable', { extensionId: 'test.restart.other' }); await old.stop();
  const next = await host(root);
  const failed = await until(() => next.call<VarinExtensionHostStateSnapshot>('state'), state => entry(state).restartHandoffs!.at(-1)!.status === 'failed');
  assert.match(entry(failed).restartHandoffs!.at(-1)!.failure!.message, /Frozen Host artifact is unavailable/);
  assert.equal((await readFile(join(root, 'loads'), 'utf8')).includes(`${next.pid}:`), false);
  await next.stop();
});
