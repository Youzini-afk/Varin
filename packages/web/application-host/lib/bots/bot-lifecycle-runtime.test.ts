import { expect, it, vi } from 'vitest';
import type { BotSummary } from '@varin/application-client';
import type { ComputerDesktop, ComputerVmDescriptor } from '@varin/protocol';
import { createBotLifecycleRuntime, type BotLifecycleRuntimeOptions } from './bot-lifecycle-runtime.js';

const bot: BotSummary = { id: 'b', name: 'Bot', archived: false, instructions: null, model: null,
  homeDir: '/bot', coordinatorHostId: 'coordinator', entrySessionId: null, createdAt: '', updatedAt: '' };
const vm = (id: string): ComputerVmDescriptor => ({ machineId: id, name: id, state: 'running',
  binding: { domainUuid: id, guest: { state: 'ready', connectionId: `vm:${id}`, hostId: `guest-${id}` } },
} as ComputerVmDescriptor);
const desktop = (id: string, scopeId = 'bot:b'): ComputerDesktop => ({ id: `desktop-${id}`, machineId: id,
  label: id, kind: 'remote-session', status: 'available', work: [{ scopeId, threadId: 't', sessionId: 's', at: '' }] });
const setup = () => {
  let machines = [vm('owned')];
  let desktops = [desktop('owned')];
  const computers = {
    list: vi.fn(async () => ({ desktops })), listVms: vi.fn(async () => machines),
    vmAction: vi.fn(async () => machines[0]), control: vi.fn(async () => ({ owner: 'agent' })),
    reconcileVmGuests: vi.fn(async () => {}), workDesktops: vi.fn(async () => desktops), cancel: vi.fn(async () => ({})),
  };
  const options = { hostId: 'coordinator', computers,
    registry: { flushScope: async () => {}, listWorkspaceThreadSnapshots: async () => [], listWorkspaceRunSessionIds: async () => [], getActiveRun: async () => null },
    runtime: { suspendForBot: vi.fn(async () => {}) }, broker: {
      requestForSession: vi.fn(async () => { throw Object.assign(new Error('No worker'), { code: 'session_not_found' }); }),
      closeSession: vi.fn(async () => { throw Object.assign(new Error('No worker'), { code: 'session_not_found' }); }),
    }, stopRoot: vi.fn(), stopSessionProcesses: vi.fn(), stopRemoteScope: vi.fn(),
    resumeRemoteScope: vi.fn(), stopMemory: vi.fn(), resumeMemory: vi.fn(), wakeFollowUps: vi.fn(),
    remoteMachineOwners: vi.fn(async () => []),
  } as unknown as BotLifecycleRuntimeOptions;
  return { runtime: createBotLifecycleRuntime(options), computers, options,
    setMachines: (value: ComputerVmDescriptor[]) => { machines = value; }, setDesktops: (value: ComputerDesktop[]) => { desktops = value; } };
};

it('accepts already-closed delegated and historical sessions but propagates a real close failure', async () => {
  const { runtime, options } = setup();
  const work = { threadId: 't', sessionId: 'child', runId: 'run', resume: true, stopped: false, resumed: false };
  await runtime.stop(bot, work);
  expect(options.runtime.suspendForBot).toHaveBeenCalledWith('bot:b', 't');
  expect(options.stopSessionProcesses).toHaveBeenCalledWith('child');
  vi.mocked(options.broker.closeSession).mockRejectedValueOnce(new Error('worker would not stop'));
  await expect(runtime.stop(bot, { ...work, threadId: '' })).rejects.toThrow(/would not stop/);
});

it('only plans automatic shutdown for exclusive Bot VMs and retains shared or coordinator machines', async () => {
  const { runtime, setMachines, setDesktops } = setup();
  const coordinator = vm('coordinator');
  coordinator.binding.guest!.hostId = 'coordinator';
  setMachines([vm('owned'), vm('shared'), coordinator]);
  const shared = desktop('shared');
  shared.work!.push({ scopeId: 'bot:other', threadId: 'other', sessionId: 'other', at: '' });
  setDesktops([desktop('owned'), shared, desktop('coordinator')]);
  const machines = await runtime.planMachines(bot);
  expect(machines.map((item) => [item.machineId, item.state])).toEqual([
    ['owned', 'pending'], ['shared', 'kept-running'], ['coordinator', 'kept-running'],
  ]);
});

it('does not cancel a shared desktop lane when a Bot sleeps', async () => {
  const { runtime, computers, setDesktops } = setup();
  const owned = { ...desktop('owned'), usage: { sessionId: 's', at: '' } };
  const shared = { ...desktop('shared'), usage: { sessionId: 's', at: '' } };
  shared.work!.push({ scopeId: 'bot:other', threadId: 'other', sessionId: 'other', at: '' });
  setDesktops([owned, shared]);
  await runtime.stopScope(bot);
  expect(computers.cancel).toHaveBeenCalledExactlyOnceWith(owned.id);
});

it('waits for actual shutdown and guest readiness, retaining a VM taken over by a human', async () => {
  const { runtime, computers, setMachines } = setup();
  const machine = { machineId: 'owned', label: 'VM', state: 'pending' as const };
  const stopping = await runtime.machine(bot, machine, false);
  expect(stopping.state).toBe('stopping');
  expect(computers.vmAction).toHaveBeenCalledWith({ machineId: 'owned', action: 'shutdown' });
  await runtime.machine(bot, stopping, false);
  expect(computers.vmAction).toHaveBeenCalledTimes(1);
  setMachines([{ ...vm('owned'), state: 'shutoff' }]);
  const stopped = await runtime.machine(bot, stopping, false);
  expect(stopped.state).toBe('stopped');
  const starting = await runtime.machine(bot, stopped, true);
  expect(starting.state).toBe('starting');
  const preparing = vm('owned'); preparing.binding.guest!.state = 'preparing';
  setMachines([preparing]);
  expect((await runtime.machine(bot, starting, true)).state).toBe('starting');
  setMachines([vm('owned')]);
  expect((await runtime.machine(bot, starting, true)).state).toBe('ready');
  computers.control.mockResolvedValue({ owner: 'human' });
  expect((await runtime.machine(bot, machine, false)).state).toBe('kept-running');
  expect(computers.vmAction).toHaveBeenCalledTimes(2);
});
