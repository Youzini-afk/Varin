import { expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import type { VarinSurfaceServiceLeaseEvent } from '@varin/extension-contract';
import { bindPluginInvocationPrincipal, requirePluginPrincipal } from './invocation-principal.js';

for (const mode of ['native', 'brokered'] as const) test(`${mode}: only the authenticated Surface lease lends its stable principal to a service`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-surface-principal-'));
  const runtime = await ApplicationExtensionRuntime.create({
    dataDir: join(root, 'data'), varinVersion: '1.2.3', bindSurfacePrincipal: bindPluginInvocationPrincipal,
    brokerScript: fileURLToPath(new URL('../../../../extension-host/broker/broker-child.mjs', import.meta.url)),
  });
  const controller = new AbortController();
  let watching: Promise<void> | undefined;
  try {
    runtime.capabilities.register('example.subject', (_method, _args, context) => requirePluginPrincipal(context));
    const directory = join(root, 'plugin'); await mkdir(directory);
    const id = 'example.subject';
    await writeFile(join(directory, 'varin.extension.json'), JSON.stringify({ schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' },
      capabilities: { host: ['example.subject'] }, entrypoints: { host: { mode, file: 'host.cjs', activation: ['service-request'] },
        surfaces: [{ id: 'settings', file: 'surface.cjs', mode: 'managed', supports: ['web'] }] },
      provides: { services: [{ id: 'example.subject.read', version: 1 }] } }));
    await writeFile(join(directory, 'host.cjs'), `module.exports={activate(context){context.services.provide({id:'example.subject.read',version:1},{read(args){return context.capabilities.call('example.subject','read',args)}})}};`);
    await writeFile(join(directory, 'surface.cjs'), 'module.exports={activate(){}};');
    await runtime.start();
    await runtime.installOrStage({ source: { kind: 'local', display: id, specifier: directory }, expectedRevision: (await runtime.catalog.snapshot()).revision });
    await runtime.reviewCapabilities({ extensionId: id, expectedRevision: (await runtime.catalog.snapshot()).revision,
      decisions: [{ capability: 'example.subject', realm: 'host', granted: true }] });
    await runtime.setEnabled(id, true, (await runtime.catalog.snapshot()).revision);
    const catalog = await runtime.catalog.snapshot(), entry = catalog.extensions.find(item => item.manifest.id === id)!;
    const owner = { hostId: catalog.hostId, realmId: 'settings', extensionId: id, extensionVersion: '1.0.0', entrypointId: 'settings', generation: 1, desiredRevision: entry.desired.revision };
    const routingRevision = (await runtime.routing.read()).document.revision;
    const ready = new Promise<Extract<VarinSurfaceServiceLeaseEvent, { kind: 'ready' }>>((resolve, reject) => {
      watching = runtime.watchServiceLease({ owner, surface: 'web', artifactIntegrity: entry.integrity, slot: 'selected', routing: {},
        expectedRoutingRevision: routingRevision, services: [{ serviceId: 'example.subject.read', version: 1, providerKey: `${id}:host:example.subject.read@1` }] },
      'session-lease', event => { if (event.kind === 'ready') resolve(event); else if (event.kind === 'error') reject(new Error(event.message)); }, controller.signal, 'alice');
      void watching.catch(reject);
    });
    const lease = await ready;
    const request = { serviceId: 'example.subject.read', version: 1, method: 'read', args: [{ principalId: 'bob' }], providerId: lease.providers[0]!.providerId,
      lease: { id: lease.leaseId, owner: { realmId: owner.realmId, extensionId: id, entrypointId: owner.entrypointId, generation: 1 } } };
    expect(await runtime.invokeService(request, undefined, 'session-lease', 'alice')).toBe('alice');
    await expect(runtime.invokeService(request, undefined, 'session-lease', 'bob')).rejects.toThrow('authenticated composition owner');
    await expect(runtime.invokeService(request, undefined, 'other-session', 'alice')).rejects.toThrow('authenticated composition owner');
    const { lease: _lease, ...unscoped } = request;
    await expect(runtime.invokeService(unscoped)).rejects.toThrow('Authenticated plugin user unavailable');
    controller.abort(); await watching;
    await expect(runtime.invokeService(request, undefined, 'session-lease', 'alice')).rejects.toThrow('authenticated composition owner');
  } finally { controller.abort(); await watching; await runtime.stop(); await rm(root, { recursive: true, force: true }); }
});
