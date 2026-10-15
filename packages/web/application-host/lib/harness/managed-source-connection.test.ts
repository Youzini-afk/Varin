import { expect, it, vi } from 'vitest';
import { createManagedRemoteTargetRegistry, managedEndpointIdentity } from './managed-remote-client.js';

it('wakes source-only recovery after failed release and on a new Host lifetime without Experiment registration', async () => {
  const owner = { kind: 'managed_host' as const, hostId: 'source-b', connectionId: 'connection-b',
    endpointIdentity: managedEndpointIdentity({ apiUrl: 'https://source-b.example' }) };
  let offline = false;
  const reachable = vi.fn();
  const resources = { listMachines: vi.fn(() => { throw new Error('Source has no Experiment workspace'); }),
    registerMachine: vi.fn(() => { throw new Error('Source must not register an Experiment machine'); }) };
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    if (offline) throw new TypeError('original source transport disconnected');
    if (!String(url).endsWith('/identity')) throw new Error('Only original identity is retried');
    return new Response(JSON.stringify({ protocolVersion: 1, hostId: owner.hostId, capabilities: ['sources'],
      machine: { machineId: 'managed:source-b', kind: 'managed-remote', state: 'available' } }),
      { headers: { 'x-varin-managed-host': owner.hostId } });
  });
  const create = () => createManagedRemoteTargetRegistry({ coordinatorHostId: 'source-a', kernel: {} as never,
    resources: resources as never, onSourceReachable: reachable, fetch: fetchMock as typeof fetch,
    readSettings: async () => ({ desktopHosts: [{ id: owner.connectionId, apiUrl: 'https://source-b.example' }] }) });
  const registry = create(), source = await registry.source(owner);
  expect(reachable).toHaveBeenCalledExactlyOnceWith(owner);
  await registry.source(owner);
  expect(reachable).toHaveBeenCalledTimes(1);
  offline = true;
  await expect(source.release({ coordinatorHostId: 'source-a', authorityId: 'original-capture', resourceEpoch: 'original-epoch', mode: 'retire' }))
    .rejects.toThrow('disconnected');
  offline = false;
  await registry.sourceTargets();
  expect(reachable).toHaveBeenCalledTimes(2);
  await registry.source(owner);
  expect(reachable).toHaveBeenCalledTimes(2);
  // A new Host has no in-memory failed bit, but the original Catalog may still
  // own cleanup. Its first authenticated Source connection must wake recovery.
  await create().source(owner);
  expect(reachable).toHaveBeenCalledTimes(3);
  expect(resources.listMachines).not.toHaveBeenCalled();
  expect(resources.registerMachine).not.toHaveBeenCalled();
});
