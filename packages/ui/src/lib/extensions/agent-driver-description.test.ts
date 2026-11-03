import { expect, test, vi } from 'vitest';
import type { ExtensionsAPI } from '@varin/application-client';
import { readAgentDriverDescription } from './agent-driver-description';

const description = { identity: { name: 'parallel', version: '1' }, configuration: null,
  modelRoles: [], recovery: 'none', checkpointSchema: null };
const providerKey = 'example.parallel-driver:host:varin.agent.driver@1';
test('recovery inspection activates the selected lazy provider then describes its exact live generation', async () => {
  let active = false;
  const invokeService = vi.fn<ExtensionsAPI['invokeService']>(async () => description);
  const api = { hostState: async () => ({ catalog: { authoritative: true, hostId: 'host-a' },
    services: { providers: active ? [{ providerKey, providerId: 'generation-original', status: 'active' }] : [] } }),
    activateExtension: vi.fn(async () => { active = true; }), invokeService } as unknown as ExtensionsAPI;
  expect(await readAgentDriverDescription(api, { extensionId: 'example.parallel-driver', providerKey,
    hostId: 'host-a', assertCurrent() {}, signal: new AbortController().signal })).toEqual(description);
  expect(api.activateExtension).toHaveBeenCalledWith('example.parallel-driver');
  expect(invokeService.mock.calls[0]![0]).toMatchObject({ providerId: 'generation-original', method: 'describe', serviceId: 'varin.agent.driver' });
});

test('a Host switch during lazy activation cannot inspect an equal-named generation on the replacement Host', async () => {
  let current = true;
  const invokeService = vi.fn();
  const api = { hostState: async () => ({ catalog: { authoritative: true, hostId: 'host-a' }, services: { providers: [] } }),
    activateExtension: async () => { current = false; }, invokeService } as unknown as ExtensionsAPI;
  await expect(readAgentDriverDescription(api, { extensionId: 'example.parallel-driver', providerKey,
    hostId: 'host-a', assertCurrent() { if (!current) throw new Error('Runtime changed'); }, signal: new AbortController().signal })).rejects.toThrow('Runtime changed');
  expect(invokeService).not.toHaveBeenCalled();
});

test('a switch between the inner state read and the outer activation continuation dispatches no activation to the new Host', async () => {
  let current = 'host-a';
  let finishRead!: (value: unknown) => void;
  const read = new Promise(resolve => { finishRead = resolve; });
  const activateExtension = vi.fn(async () => { throw new Error(`Activation dispatched to ${current}`); });
  const invokeService = vi.fn();
  const api = { hostState: () => read, activateExtension, invokeService } as unknown as ExtensionsAPI;
  const inspection = readAgentDriverDescription(api, { extensionId: 'example.parallel-driver', providerKey,
    hostId: 'host-a', assertCurrent() { if (current !== 'host-a') throw new Error('Runtime changed'); }, signal: new AbortController().signal });
  // Resolving schedules the inner state() continuation. The switch then runs after its guard
  // but before the outer await continuation: a captured API object may use a dynamic endpoint.
  finishRead({ catalog: { authoritative: true, hostId: 'host-a' }, services: { providers: [] } });
  queueMicrotask(() => { current = 'host-b'; });
  await expect(inspection).rejects.toThrow('Runtime changed');
  expect(activateExtension).not.toHaveBeenCalled();
  expect(invokeService).not.toHaveBeenCalled();
});
