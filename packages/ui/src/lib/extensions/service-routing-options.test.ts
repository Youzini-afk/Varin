import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { ApplicationExtensionRuntime } from '../../../../extension-host/dist/index.js';
import { resolveVarinExtensionServiceRouting } from '@varin/extension-contract';
import { serviceRoutingOptions } from './service-routing-options';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const serviceId = 'varin.retrieval.plan';
const keyword = 'varin.builtin.retrieval-keyword:host:varin.retrieval.plan@1';
const structured = 'varin.builtin.retrieval-structured:host:varin.retrieval.plan@1';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-retrieval-routing-ui-'));
  const runtime = await ApplicationExtensionRuntime.create({ dataDir: path.join(root, 'extensions'), varinVersion: '0.9.24', brokerScript: path.join(repository, 'packages/extension-host/broker/broker-child.mjs') });
  await runtime.start(); cleanups.push(async () => { await runtime.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const context = { userId: 'default', workspaceId: '/retrieval-picker-workspace' };
  const request = { serviceId, version: 1, method: 'describe', args: [], routing: context };
  const route = async (providerKey: string) => runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
    rule: { allowFallback: false, providerKey, serviceId, version: 1, scope: { workspaceId: context.workspaceId } } });
  const view = async () => {
    const snapshot = await runtime.state(); const groups = serviceRoutingOptions(snapshot); const choices = groups.get(`${serviceId}@1`) ?? [];
    const resolution = resolveVarinExtensionServiceRouting({ candidates: choices.map(provider => ({ providerId: provider.providerId ?? provider.providerKey, providerKey: provider.providerKey })),
      context, document: snapshot.routing.document, serviceId, version: 1, defaultProviderKey: structured });
    return { snapshot, groups, choices, resolution };
  };
  return { root, runtime, request, route, view };
}

it('the settings selector lists installed lazy plans before activation, selects one through real routing, and distinguishes active from disabled availability', async () => {
  const f = await fixture(); const before = await f.view();
  expect(before.choices.find(option => option.providerKey === keyword)).toMatchObject({ status: 'declared' });
  expect(before.choices.find(option => option.providerKey === structured)).toMatchObject({ status: 'declared' });
  expect(before.choices.find(option => option.providerKey === keyword)?.providerId).toBeUndefined();
  await f.route(keyword);
  const selected = await f.view(); expect(selected.resolution).toMatchObject({ status: 'resolved', providerKey: keyword });
  expect(selected.choices.find(option => option.providerKey === keyword)?.status).toBe('declared');
  const binding = await f.runtime.prepareService(f.request, { defaultProviderKey: structured });
  expect(await binding.invoke('describe', [])).toEqual({ configurationId: 'keyword-only-v1', structure: 'disabled' });
  const active = await f.view();
  expect(active.choices.filter(option => option.providerKey === keyword)).toHaveLength(1);
  expect(active.choices.find(option => option.providerKey === keyword)).toMatchObject({ status: 'active', providerId: binding.providerId });
  expect(active.choices.find(option => option.providerKey === structured)?.status).toBe('declared');
  await f.runtime.setEnabled('varin.builtin.retrieval-keyword', false, (await f.runtime.state()).catalog.revision);
  const disabled = await f.view();
  expect(disabled.choices.some(option => option.providerKey === keyword)).toBe(false);
  expect(disabled.resolution).toMatchObject({ status: 'unavailable', providerKey: keyword });
  await expect(f.runtime.prepareService(f.request, { defaultProviderKey: structured })).rejects.toThrow();
}, 20_000);

it('the actual selector and Host do not admit a provider from another service or an uninstalled provider as a retrieval choice', async () => {
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
  for (const providerKey of [`${id}:host:${otherService}@1`, 'review.not-installed:host:varin.retrieval.plan@1']) {
    await f.route(providerKey);
    expect((await f.view()).resolution).toMatchObject({ status: 'unavailable', providerKey });
    await expect(f.runtime.prepareService(f.request, { defaultProviderKey: structured })).rejects.toThrow();
  }
}, 20_000);
