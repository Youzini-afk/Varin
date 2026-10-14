import { expect, it, vi } from 'vitest';
import type { BotSummary } from '@varin/application-client';
import type { ComputerDesktop, ComputerVmDescriptor } from '@varin/protocol';
import { createBotLifecycleRuntime, type BotLifecycleRuntimeOptions } from './bot-lifecycle-runtime.js';

const bot: BotSummary = { id: 'b', name: 'Bot', archived: false, instructions: null, model: null,
  homeDir: '/bot', coordinatorHostId: 'coordinator', entry: { runtime: 'agent', threadId: 'entry', branchId: 'main' }, createdAt: '', updatedAt: '',
  activity: { state: 'sleeping', operationId: 'sleep-original', planned: true, work: [], machines: [], error: null } };
const work = { runtime: 'agent' as const, threadId: 't', branchId: 'main', runId: 'run', resume: true, stopped: false, resumed: false };
const vm = (id: string): ComputerVmDescriptor => ({ machineId: id, name: id, state: 'running',
  binding: { domainUuid: id, guest: { state: 'ready', connectionId: `vm:${id}`, hostId: `guest-${id}` } },
} as ComputerVmDescriptor);
const desktop = (id: string): ComputerDesktop => ({ id: `desktop-${id}`, machineId: id,
  label: id, kind: 'remote-session', status: 'available', work: [{ work: { runtime: 'agent', threadId: 't', branchId: 'main' }, registry: null, at: '' }] });
const setup = () => {
  let machines = [vm('owned')];
  let desktops = [desktop('owned')];
  const computers = {
    list: vi.fn(async () => ({ desktops })), listVms: vi.fn(async () => machines),
    vmAction: vi.fn(async () => machines[0]), control: vi.fn(async () => ({ owner: 'agent' })),
    reconcileVmGuests: vi.fn(async () => {}), finishExecution: vi.fn(async () => {}),
  };
  const status = { currentKernelWorkersDrained: true, unprovenOperationStopIds: [] as string[], unknownEffectOperationIds: ['effect-original'], unresolvedModelRequestIds: [] as string[] };
  const scope = { threads: [{ thread_id: 't' }], runs: [{ threadId: 't', branchId: 'main', runId: 'run', state: 'waiting', cancelRequested: false }] };
  const agent = { runtime: { botScope: vi.fn(async () => scope), thread: vi.fn(async (id: string) => ({ bot_id: id === 'other' ? 'other' : 'b' })),
    reconcileMemory: vi.fn(async () => {}), reconcilePlan: vi.fn(async () => {}), run: vi.fn(async () => ({ state: 'waiting', cancel_requested: false })) },
    kernel: { kernelEpoch: 'epoch', drainRunDomains: vi.fn(async () => {}), agentRuntimeRequest: vi.fn(async (method: string) => method === 'runtime.bot.scope.resume' ? { blockedRunIds: [] as string[] } : status) },
    gate: vi.fn(async () => ({ botId: 'b', profileRevision: 3, activityOperationId: 'sleep-original', permitted: false })),
    continueLaunch: vi.fn(async () => {}), drainScripts: vi.fn(async () => {}), drainForwards: vi.fn(async () => {}), drainCollaborations: vi.fn(async () => {}) };
  const options = { hostId: 'coordinator', computers, agent,
    stopRemoteScope: vi.fn(async () => {}), resumeRemoteScope: vi.fn(async () => {}), stopMemory: vi.fn(async () => {}), resumeMemory: vi.fn(),
    remoteMachineOwners: vi.fn(async () => [] as string[]),
  };
  return { runtime: createBotLifecycleRuntime(options as unknown as BotLifecycleRuntimeOptions), computers, options, agent, status, scope,
    setMachines: (value: ComputerVmDescriptor[]) => { machines = value; }, setDesktops: (value: ComputerDesktop[]) => { desktops = value; } };
};

it('suspends the original scope once, drains every owner, and keeps unknown effect distinct from executor stop', async () => {
  const { runtime, agent, computers, options, status } = setup();
  expect(await runtime.planWork(bot)).toEqual([work]);
  await Promise.all([runtime.stop(bot, work), runtime.stop(bot, work)]);
  expect(agent.kernel.agentRuntimeRequest).toHaveBeenCalledExactlyOnceWith('runtime.bot.scope.suspend', { botId: 'b', profileRevision: 3, activityOperationId: 'sleep-original' });
  expect(await runtime.stopScope(bot)).toEqual(status);
  expect(agent.kernel.drainRunDomains).toHaveBeenCalledWith(['run']);
  expect(agent.drainScripts).toHaveBeenCalledWith(new Set(['run']));
  expect(agent.drainForwards).toHaveBeenCalledWith(new Set(['run']));
  expect(agent.drainCollaborations).toHaveBeenCalledWith(new Set(['t']));
  expect(agent.runtime.reconcileMemory).toHaveBeenCalledWith('run');
  expect(agent.runtime.reconcilePlan).toHaveBeenCalledWith('run');
  expect(computers.finishExecution).toHaveBeenCalledWith({ work: { runtime: 'agent', threadId: 't', branchId: 'main' }, runId: 'run' });
  expect(options.stopMemory).toHaveBeenCalledWith('bot:b');
  expect(options.stopRemoteScope).toHaveBeenCalledWith('bot:b');
});

it('retains a failed stop and refuses wake replay of an unknown original effect', async () => {
  const { runtime, agent, status, computers } = setup();
  status.unprovenOperationStopIds.push('effect-original');
  computers.finishExecution.mockRejectedValueOnce(new Error('release unconfirmed'));
  await expect(runtime.stopScope(bot)).rejects.toMatchObject({ execution: { unprovenOperationStopIds: ['effect-original'] } });
  agent.kernel.agentRuntimeRequest.mockImplementation(async method => method === 'runtime.bot.scope.resume' ? { blockedRunIds: ['run'] } : status);
  await expect(runtime.resume(bot, work)).rejects.toThrow('Wake does not resend Unknown');
  expect(agent.continueLaunch).not.toHaveBeenCalled();
  status.unprovenOperationStopIds = [];
  agent.kernel.agentRuntimeRequest.mockImplementation(async method => method === 'runtime.bot.scope.resume' ? { blockedRunIds: [] as string[] } : status);
  await runtime.resume(bot, work);
  expect(agent.continueLaunch).toHaveBeenCalledExactlyOnceWith('run');
});

it('only shuts down exclusive Bot VMs, retaining shared and coordinator machines', async () => {
  const { runtime, setMachines, setDesktops } = setup();
  const coordinator = vm('coordinator'); coordinator.binding.guest!.hostId = 'coordinator';
  const shared = desktop('shared'); shared.work!.push({ work: { runtime: 'agent', threadId: 'other', branchId: 'main' }, registry: null, at: '' });
  setMachines([vm('owned'), vm('shared'), coordinator]); setDesktops([desktop('owned'), shared, desktop('coordinator')]);
  expect((await runtime.planMachines(bot)).map(item => [item.machineId, item.state])).toEqual([
    ['owned', 'pending'], ['shared', 'kept-running'], ['coordinator', 'kept-running'],
  ]);
});

it('waits for actual VM shutdown and guest readiness, retaining a VM taken over by a human', async () => {
  const { runtime, computers, setMachines } = setup();
  const machine = { machineId: 'owned', label: 'VM', state: 'pending' as const };
  const stopping = await runtime.machine(bot, machine, false);
  expect(stopping.state).toBe('stopping');
  expect(computers.vmAction).toHaveBeenCalledWith({ machineId: 'owned', action: 'shutdown' });
  await runtime.machine(bot, stopping, false); expect(computers.vmAction).toHaveBeenCalledTimes(1);
  setMachines([{ ...vm('owned'), state: 'shutoff' }]);
  expect((await runtime.machine(bot, stopping, false)).state).toBe('stopped');
  const starting = await runtime.machine(bot, { ...machine, state: 'stopped' }, true);
  expect(starting.state).toBe('starting');
  const booting = vm('owned'); booting.binding.guest!.state = 'preparing'; setMachines([booting]);
  expect((await runtime.machine(bot, starting, true)).state).toBe('starting');
  expect(computers.reconcileVmGuests).toHaveBeenCalled();
  setMachines([vm('owned')]); expect((await runtime.machine(bot, starting, true)).state).toBe('ready');
  computers.control.mockResolvedValue({ owner: 'human' });
  expect((await runtime.machine(bot, machine, false)).state).toBe('kept-running');
});
