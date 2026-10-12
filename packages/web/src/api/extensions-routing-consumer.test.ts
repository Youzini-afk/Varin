import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { Root } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import express, { type Express, type RequestHandler } from 'express';
import { test } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { parseVarinExtensionServiceProvision, VARIN_CONTEXT_FRAGMENTS_SERVICE as descriptor } from '@varin/extension-contract';
import type { RuntimeAPIs } from '@varin/application-client';
import { registerExtensionRoutes } from '#application-host/lib/extensions/routes.js';
import { routerTransport } from '#application-host/lib/extensions/direct-router.test-helper.js';
import { createWebExtensionsAPI } from './extensions';
import * as store from '@/lib/extensions/catalog-store';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { ServiceRoutingControl } from '@/components/sections/extensions/ServiceRoutingControl';
import { I18nProvider } from '@/lib/i18n';
import { serviceRoutingOptions, serviceRoutingComposition } from '@/lib/extensions/service-routing-options';

// React is a UI-owned runtime dependency. Resolve the same instance as the real settings controls.
const requireUI = createRequire(new URL('../../../ui/package.json', import.meta.url));
const React: typeof import('react') = requireUI('react');
const { createRoot }: typeof import('react-dom/client') = requireUI('react-dom/client');

// Real DOM, public client, original Router and file storage. No listener, kernel or broker process.
test('real settings controls persist ordered choices through the original client, Router and file CAS', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'varin-ordered-consumer-'));
  const dataDir = join(directory, 'extensions');
  let brokerStarts = 0;
  const runtimeOptions = { dataDir, varinVersion: '1.0.0', brokerScript: 'unused-no-activation.cjs',
    transportFactory: () => { brokerStarts += 1; throw new Error('Settings must not execute extensions'); } };
  let runtime = await ApplicationExtensionRuntime.create(runtimeOptions);
  const serviceId = descriptor.id;
  const scope = { userId: 'default' };
  const providerKey = (id: string) => `${id}:host:${serviceId}@1`;
  const a = providerKey('review.a'), b = providerKey('review.b'), c = providerKey('review.c');
  const missing = providerKey('review.missing');
  const now = new Date().toISOString();
  for (const id of ['review.a', 'review.b', 'review.c', 'review.legacy']) {
    const provision = parseVarinExtensionServiceProvision(
      id === 'review.legacy' ? { id: 'review.single', version: 1, multiple: true } : descriptor,
    );
    await runtime.catalog.upsert({
      manifest: { schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
        entrypoints: { host: { activation: ['service-request'], file: 'host.cjs', mode: 'brokered' } },
        provides: { services: [provision] } },
      source: { kind: 'npm', specifier: id, display: id }, resolvedVersion: '1.0.0', selectedVersion: '1.0.0',
      desired: { enabled: true, revision: 1, updatedAt: now }, capabilityGrants: [], installedAt: now, updatedAt: now,
    }, (await runtime.catalog.snapshot()).revision);
  }
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    if (!previous.has(name)) previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const { window } = parseHTML('<html><body><div id="app"></div></body></html>');
  Object.defineProperty(window, 'location', { configurable: true, value: {
    href: 'https://application-host.invalid/', origin: 'https://application-host.invalid',
  } });
  for (const [name, value] of Object.entries({ window, document: window.document, HTMLElement: window.HTMLElement,
    Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) setGlobal(name, value);
  let root: Root | undefined;
  let transport: ReturnType<typeof routerTransport>;
  const attachRouter = () => {
    const router = express.Router();
    const auth: RequestHandler = (request, response, next) =>
      request.headers.cookie === 'review-session=authenticated' ? next() : response.status(401).json({ error: { message: 'Authentication required' } });
    registerExtensionRoutes(router as unknown as Express, { extensionCatalog: runtime.catalog, extensionPackages: runtime.packages,
      extensionRuntime: runtime, uiAuthController: { requireAuth: auth, requireSessionAuth: auth } });
    transport = routerTransport(router);
  };
  attachRouter();
  const writes: Array<{ method: string; path: string; body: { expectedRevision: number; rule?: { providerKeys?: string[]; providerKey?: string } }; status?: number }> = [];
  let competeBeforeNextWrite = false;
  setGlobal('fetch', async (input: URL | string, init: RequestInit = {}) => {
    const target = new URL(String(input));
    assert.equal(target.origin, 'https://application-host.invalid');
    const headers = new Headers(init.headers);
    assert.equal(init.credentials, 'include');
    headers.set('cookie', 'review-session=authenticated');
    const write = target.pathname.includes('/services/routing') ? {
      method: init.method ?? 'GET', path: target.pathname, body: JSON.parse(String(init.body)), status: undefined as number | undefined,
    } : undefined;
    if (write) writes.push(write);
    if (competeBeforeNextWrite && init.method === 'PUT') {
      competeBeforeNextWrite = false;
      await runtime.upsertServiceRoutingRule({ expectedRevision: (await runtime.routing.read()).document.revision,
        rule: { allowFallback: false, providerKeys: [b, a], scope, serviceId, version: 1 } });
    }
    const response = await transport(target, { ...init, headers });
    if (write) write.status = response.status;
    return response;
  });
  const api = createWebExtensionsAPI();
  registerRuntimeAPIs({ extensions: api } as RuntimeAPIs);
  store.resetVarinExtensionCatalogForTests();
  let pending: Promise<void> = Promise.resolve();
  const selectedRule = () => store.getVarinExtensionCatalogState().snapshot?.routing.document.rules.find((rule) =>
    rule.serviceId === serviceId && JSON.stringify(rule.scope) === JSON.stringify(scope));
  function SettingsConsumer() {
    const catalog = React.useSyncExternalStore(store.subscribeVarinExtensionCatalog, store.getVarinExtensionCatalogState, store.getVarinExtensionCatalogState);
    const snapshot = catalog.snapshot;
    if (!snapshot) return null;
    const rule = selectedRule();
    return React.createElement(I18nProvider, null, React.createElement(ServiceRoutingControl, {
      busy: false, composition: serviceRoutingComposition(snapshot, serviceId, 1),
      extensionNames: new Map([['review.a', 'A'], ['review.b', 'B'], ['review.c', 'C']]),
      providers: serviceRoutingOptions(snapshot).get(`${serviceId}@1`) ?? [],
      selection: rule?.providerKeys ?? rule?.providerKey ?? null,
      onSelect: (selection: string | readonly string[] | null) => { pending = store.setVarinExtensionServiceRoute(serviceId, 1, scope, selection); },
    }));
  }
  const click = async (label: string) => {
    const button = [...window.document.querySelectorAll<HTMLButtonElement>('button')].find((element) =>
      element.getAttribute('aria-label') === label || element.textContent === label);
    assert.ok(button, label);
    await React.act(async () => { button.click(); await pending; });
  };
  const members = () => [...window.document.querySelectorAll('[data-provider-key]')].map((element) => element.getAttribute('data-provider-key'));
  const selectionLabel = () => window.document.querySelector('[data-slot="select-value"]')?.textContent;
  const readWhileWatching = async <T,>(read: () => Promise<T>): Promise<T> => {
    let result!: T;
    // The real long-poll watcher can publish while independent reads are in flight.
    await React.act(async () => { result = await read(); });
    return result;
  };
  try {
    await store.startVarinExtensionCatalog();
    const initial = store.getVarinExtensionCatalogState().snapshot;
    assert.ok(initial);
    assert.equal(serviceRoutingComposition(initial, 'review.single', 1), undefined);
    root = createRoot(window.document.getElementById('app')!);
    await React.act(async () => root!.render(React.createElement(SettingsConsumer)));
    assert.equal(selectionLabel(), 'Automatic');
    assert.equal(writes.length, 0);
    await React.act(async () => store.setVarinExtensionServiceRoute(serviceId, 1, scope, [a, b]));
    await click('Move B earlier');
    assert.deepEqual(members(), [b, a]);
    assert.deepEqual(writes.at(-1)?.body.rule?.providerKeys, [b, a]);
    assert.equal(writes.at(-1)?.method, 'PUT');
    assert.ok(!members().includes(c));
    await click('Remove A');
    await click('Add A');
    assert.deepEqual(members(), [b, a]);
    const described = await readWhileWatching(() => api.queryContracts({ action: 'describe', kind: 'service', serviceId, version: 1 }));
    assert.ok(described.action === 'describe' && described.kind === 'service');
    assert.deepEqual(described.service?.selection.providerKeys, [b, a]);
    assert.equal(described.service?.selection.composition, 'ordered');

    // Stop and reconstruct both client store and Host owner; the original routing file owns order.
    await React.act(async () => root!.unmount()); root = undefined;
    store.resetVarinExtensionCatalogForTests();
    await runtime.stop();
    runtime = await ApplicationExtensionRuntime.create(runtimeOptions);
    attachRouter();
    await store.startVarinExtensionCatalog();
    assert.deepEqual(selectedRule()?.providerKeys, [b, a]);
    root = createRoot(window.document.getElementById('app')!);
    await React.act(async () => root!.render(React.createElement(SettingsConsumer)));
    assert.deepEqual(members(), [b, a]);

    await React.act(async () => store.setVarinExtensionServiceRoute(serviceId, 1, scope, [b, missing, a]));
    assert.deepEqual(members(), [b, missing, a]);
    assert.match(window.document.body.textContent ?? '', /Unavailable provider/);
    const unavailable = await readWhileWatching(() => api.queryContracts({ action: 'describe', kind: 'service', serviceId, version: 1 }));
    assert.ok(unavailable.action === 'describe' && unavailable.kind === 'service');
    assert.equal(unavailable.service?.selection.status, 'unavailable');
    assert.deepEqual(unavailable.service?.selection.providerKeys, [b, missing, a]);
    const beforeConflict = writes.length;
    competeBeforeNextWrite = true;
    await React.act(async () => {
      await assert.rejects(store.setVarinExtensionServiceRoute(serviceId, 1, scope, [a]), /revision/i);
      await store.refreshVarinExtensionCatalog();
    });
    assert.equal(writes.length, beforeConflict + 1, 'stale writes must not silently retry or overwrite the winner');
    assert.equal(writes.at(-1)?.status, 409);
    assert.deepEqual((await readWhileWatching(() => runtime.routing.read())).document.rules.find((rule) => rule.serviceId === serviceId)?.providerKeys, [b, a]);
    assert.deepEqual(members(), [b, a]);
    await click('Remove A');
    await click('Remove B');
    assert.deepEqual(writes.at(-1)?.body.rule?.providerKeys, []);
    assert.equal(selectionLabel(), 'No providers (explicit empty list)');
    assert.deepEqual(selectedRule()?.providerKeys, []);
    const empty = await readWhileWatching(() => api.queryContracts({ action: 'describe', kind: 'service', serviceId, version: 1 }));
    assert.ok(empty.action === 'describe' && empty.kind === 'service');
    assert.equal(empty.service?.selection.status, 'resolved');
    assert.deepEqual(empty.service?.selection.providerKeys, []);
    await React.act(async () => store.setVarinExtensionServiceRoute(serviceId, 1, scope, null));
    assert.equal(writes.at(-1)?.path, '/api/varin/extensions/v1/services/routing/remove');
    assert.equal(selectedRule(), undefined);
    assert.equal(selectionLabel(), 'Automatic');
    await React.act(async () => store.setVarinExtensionServiceRoute(serviceId, 1, scope, a));
    assert.equal(writes.at(-1)?.body.rule?.providerKey, a);
    assert.equal(writes.at(-1)?.body.rule?.providerKeys, undefined);
    assert.equal(selectionLabel(), 'Single provider: A');
    await React.act(async () => store.setVarinExtensionServiceRoute(serviceId, 1, { workspaceId: '/selected-project' }, [b, a]));
    const documents = await readWhileWatching(async () => {
      const files = await readdir(runtime.storage.directory, { recursive: true });
      return Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) =>
        JSON.parse(await readFile(join(runtime.storage.directory, file), 'utf8'))));
    });
    const persisted = documents.find((document: { address: { extensionId: string } }) => document.address.extensionId === 'varin.core.service-routing');
    assert.deepEqual(persisted.data.rules.find((rule: { scope: { workspaceId?: string } }) => rule.scope.workspaceId === '/selected-project').providerKeys, [b, a]);
    assert.equal(brokerStarts, 0);
    assert.equal(writes.length, 11);
  } finally {
    if (root) await React.act(async () => root!.unmount());
    store.resetVarinExtensionCatalogForTests();
    registerRuntimeAPIs(null);
    await runtime.stop();
    for (const [name, value] of previous) {
      if (value) Object.defineProperty(globalThis, name, value);
      else Reflect.deleteProperty(globalThis, name);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
