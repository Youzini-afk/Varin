import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ApplicationExtensionRuntime } from '../../../../extension-host/dist/index.js';
import { resolveVarinExtensionServiceRouting } from '@varin/extension-contract';
import { serviceRoutingOptions } from './service-routing-options';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const serviceId = 'review.routing';
const first = 'review.routing-first:host:review.routing@1';
const second = 'review.routing-second:host:review.routing@1';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-service-routing-ui-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '0.9.24', brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await runtime.start(); cleanups.push(async () => { await runtime.stop(); await fs.rm(root, { recursive: true, force: true }); });
  for (const variant of ['first', 'second']) {
    const id = `review.routing-${variant}`;
    const folder = path.join(root, variant); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
      entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } }, provides: { services: [{ id: serviceId, version: 1, multiple: true }] } }));
    await fs.writeFile(path.join(folder, 'host.cjs'), `module.exports={activate(context){context.services.provide({id:'${serviceId}',version:1,multiple:true},{describe(){return {variant:'${variant}'}}})}}`);
    await runtime.installOrStage({ expectedRevision: (await runtime.catalog.snapshot()).revision, source: { kind: 'local', display: id, specifier: folder } });
  }
  const context = { userId: 'default', workspaceId: '/service-picker-workspace' };
  const request = { serviceId, version: 1, method: 'describe', args: [], routing: context };
  const route = async (providerKey: string) => runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
    rule: { allowFallback: false, providerKeys: [providerKey], serviceId, version: 1, scope: { workspaceId: context.workspaceId } } });
  const view = async () => {
    const snapshot = await runtime.state(); const groups = serviceRoutingOptions(snapshot); const choices = groups.get(`${serviceId}@1`) ?? [];
    const resolution = resolveVarinExtensionServiceRouting({ candidates: choices.map(provider => ({ providerId: provider.providerId ?? provider.providerKey, providerKey: provider.providerKey })),
      context, document: snapshot.routing.document, serviceId, version: 1, defaultProviderKey: second });
    return { snapshot, groups, choices, resolution };
  };
  return { root, runtime, request, route, view };
}

it('the settings selector lists installed lazy providers before activation, selects one through real routing, and distinguishes active from disabled availability', async () => {
  const f = await fixture(); const before = await f.view();
  expect(before.choices.find(option => option.providerKey === first)).toMatchObject({ status: 'declared' });
  expect(before.choices.find(option => option.providerKey === second)).toMatchObject({ status: 'declared' });
  expect(before.choices.find(option => option.providerKey === first)?.providerId).toBeUndefined();
  await f.route(first);
  const selected = await f.view(); expect(selected.resolution).toMatchObject({ status: 'resolved', providerKeys: [first] });
  expect(selected.choices.find(option => option.providerKey === first)?.status).toBe('declared');
  const binding = await f.runtime.prepareService(f.request, { defaultProviderKey: second });
  expect(await binding.invoke('describe', [])).toEqual({ variant: 'first' });
  const active = await f.view();
  binding.release();
  expect(active.choices.filter(option => option.providerKey === first)).toHaveLength(1);
  expect(active.choices.find(option => option.providerKey === first)).toMatchObject({ status: 'active', providerId: binding.providerId });
  expect(active.choices.find(option => option.providerKey === second)?.status).toBe('declared');
  await f.runtime.setEnabled('review.routing-first', false, (await f.runtime.state()).catalog.revision);
  const disabled = await f.view();
  expect(disabled.choices.some(option => option.providerKey === first)).toBe(false);
  expect(disabled.resolution).toMatchObject({ status: 'unavailable', providerKeys: [first] });
  await expect(f.runtime.prepareService(f.request, { defaultProviderKey: second })).rejects.toThrow();
}, 20_000);

it('the actual selector and Host do not admit a provider from another service or an uninstalled provider as a routing choice', async () => {
  const f = await fixture(); const folder = path.join(f.root, 'wrong-service'); await fs.mkdir(folder);
  const id = 'review.other-service'; const otherService = 'review.unrelated';
  await fs.writeFile(path.join(folder, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
  await fs.writeFile(path.join(folder, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
    entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } }, provides: { services: [{ id: otherService, version: 1, multiple: true }] } }));
  await fs.writeFile(path.join(folder, 'host.cjs'), `module.exports={activate(context){context.services.provide({id:'${otherService}',version:1,multiple:true},{describe(){return {unrelated:true}}})}}`);
  await f.runtime.installOrStage({ expectedRevision: (await f.runtime.state()).catalog.revision, source: { kind: 'local', display: 'Unrelated test service', specifier: folder } });
  const installed = await f.view();
  expect(installed.groups.get(`${otherService}@1`)).toEqual(expect.arrayContaining([expect.objectContaining({ extensionId: id, status: 'declared' })]));
  expect(installed.choices.some(option => option.extensionId === id)).toBe(false);
  for (const providerKey of [`${id}:host:${otherService}@1`, 'review.not-installed:host:review.routing@1']) {
    await f.route(providerKey);
    expect((await f.view()).resolution).toMatchObject({ status: 'unavailable', providerKeys: [providerKey] });
    await expect(f.runtime.prepareService(f.request, { defaultProviderKey: second })).rejects.toThrow();
  }
}, 20_000);
