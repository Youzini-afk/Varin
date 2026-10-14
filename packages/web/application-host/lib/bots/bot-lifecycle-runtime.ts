import type { BotSummary, BotSleepMachine, BotActivity } from "@varin/application-client";
import type { ComputerDesktop, ComputerVmDescriptor, ComputerExecutionRef } from "@varin/protocol";
import type { ComputerService } from "../computer/computer-service.js";
import { botScopeId } from "../harness/owner-scope.js";
import type { BotLifecycleRuntime } from "./bot-service.js";

import { drainBotComputerExecutions } from './bot-computer-drain.js';
import type { AgentRuntimeClient } from '../kernel/agent-runtime-client.js';
import type { KernelClient } from '../kernel/kernel-client.js';
import type { BotExecutionGate, BotKernelScopeStatus, BotScopeResume, BotScopeSuspension } from '../kernel/protocol.generated.js';

export interface BotLifecycleRuntimeOptions {
  hostId: string;
  agent: { runtime: AgentRuntimeClient; kernel: KernelClient; gate(botId: string): Promise<BotExecutionGate>;
    continueLaunch(runId: string): Promise<void>; drainScripts(runIds: ReadonlySet<string>): Promise<void>;
    drainForwards(runIds: ReadonlySet<string>): Promise<void>; drainCollaborations(threadIds: ReadonlySet<string>): Promise<void> };
  computers: ComputerService;
  stopRemoteScope(scopeId: string): Promise<void>;
  resumeRemoteScope(scopeId: string): Promise<void>;
  remoteMachineOwners(hostId: string): Promise<string[]>;
  stopMemory(scopeId: string): Promise<void>;
  resumeMemory(scopeId: string): void;
}

const vmDesktops = (vm: ComputerVmDescriptor, desktops: ComputerDesktop[]) => desktops.filter((desktop) =>
  desktop.machineId === vm.machineId || desktop.remote?.connectionId === `vm:${vm.binding.domainUuid}`
  || (vm.binding.guest?.connectionId && desktop.remote?.connectionId === vm.binding.guest.connectionId));

export function createBotLifecycleRuntime(options: BotLifecycleRuntimeOptions): BotLifecycleRuntime {
  const suspension = async (bot: BotSummary): Promise<BotScopeSuspension> => {
    const gate = await options.agent.gate(bot.id);
    if (!gate.activityOperationId) throw new Error('Bot lifecycle has no durable operation');
    return { botId: bot.id, profileRevision: gate.profileRevision, activityOperationId: gate.activityOperationId };
  };
  const suspending = new Map<string, Promise<BotKernelScopeStatus>>();
  const suspend = (bot: BotSummary) => {
    const key = `${options.agent.kernel.kernelEpoch}:${bot.id}:${bot.activity!.operationId}`;
    let work = suspending.get(key);
    if (!work) { work = suspension(bot).then(input => options.agent.kernel.agentRuntimeRequest<BotKernelScopeStatus, 'runtime.bot.scope.suspend'>('runtime.bot.scope.suspend', input));
      suspending.set(key, work); void work.catch(() => { suspending.delete(key); }); }
    return work;
  };
  const executions = async (bot: BotSummary): Promise<ComputerExecutionRef[]> =>
    (await options.agent.runtime.botScope(bot.id)).runs.map(run => ({ work: { runtime: 'agent', threadId: run.threadId, branchId: run.branchId }, runId: run.runId }));
  const isOwned = async (bot: BotSummary, work: NonNullable<ComputerDesktop['work']>[number]): Promise<boolean> =>
    work.work.runtime === 'agent' && (await options.agent.runtime.thread(work.work.threadId)).bot_id === bot.id;
  const vmRetention = async (bot: BotSummary, vm: ComputerVmDescriptor, desktops: ComputerDesktop[]): Promise<string | null> => {
    if (vm.binding.guest?.hostId === options.hostId) return "This VM hosts the Bot coordinator";
    const owners = vm.binding.guest?.hostId ? await options.remoteMachineOwners(vm.binding.guest.hostId) : [];
    if (owners.some((scope) => scope !== botScopeId(bot.id))) return "Shared with other remote work";
    const associated = vmDesktops(vm, desktops);
    if (!associated.length && !owners.includes(botScopeId(bot.id))) return "The VM has no verified exclusive Bot work association";
    for (const desktop of associated) {
      if ((await Promise.all((desktop.work ?? []).map(work => isOwned(bot, work)))).some(owned => !owned)) return "Shared with other work";
      if ((await options.computers.control(desktop.id)).owner === "human") return "Currently controlled by the user";
    }
    return null;
  };
  return {
    async planWork(bot) {
      const scope = await options.agent.runtime.botScope(bot.id);
      return scope.runs.map(run => ({ runtime: 'agent' as const, threadId: run.threadId, branchId: run.branchId, runId: run.runId,
        resume: !run.cancelRequested && !['completed','failed','cancelled'].includes(run.state), stopped: false, resumed: false }));
    },
    async planMachines(bot) {
      const scope = botScopeId(bot.id);
      const { desktops } = await options.computers.list();
      const used = (await Promise.all(desktops.map(async desktop => (await Promise.all((desktop.work ?? []).map(work => isOwned(bot, work)))).some(Boolean) ? desktop : null))).filter((desktop): desktop is ComputerDesktop => desktop !== null);
      const machines: BotSleepMachine[] = [];
      for (const vm of await options.computers.listVms()) {
        const remoteOwners = vm.binding.guest?.hostId ? await options.remoteMachineOwners(vm.binding.guest.hostId) : [];
        if (!vmDesktops(vm, used).length && !remoteOwners.includes(scope)) continue;
        if (vm.state === 'shutoff') {
          machines.push({ machineId: vm.machineId, label: vm.name, state: 'kept-running', detail: 'Already off before Bot sleep' });
          continue;
        }
        const retention = await vmRetention(bot, vm, desktops);
        machines.push({ machineId: vm.machineId, label: vm.name,
          state: retention ? "kept-running" : "pending",
          ...(retention ? { detail: retention } : {}),
        });
      }
      return machines;
    },
    async stop(bot) { await suspend(bot); },
    async stopScope(bot) {
      const scope = botScopeId(bot.id);
      const results = await Promise.allSettled([options.stopRemoteScope(scope), options.stopMemory(scope),
        (async () => {
          await suspend(bot);
          const scope = await options.agent.runtime.botScope(bot.id);
          const runIds = new Set(scope.runs.map(run => run.runId));
          await Promise.all([options.agent.kernel.drainRunDomains([...runIds]), options.agent.drainScripts(runIds), options.agent.drainForwards(runIds),
            options.agent.drainCollaborations(new Set(scope.threads.map(thread => thread.thread_id)))]);
          for (const runId of runIds) await Promise.all([options.agent.runtime.reconcileMemory(runId), options.agent.runtime.reconcilePlan(runId)]);
        })(),
        (async () => drainBotComputerExecutions(options.computers, await executions(bot)))(),
      ]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => String(result.reason));
      const status = await options.agent.kernel.agentRuntimeRequest<BotKernelScopeStatus, 'runtime.bot.scope.status'>('runtime.bot.scope.status', await suspension(bot));
      const execution: BotActivity['execution'] = { currentKernelWorkersDrained: status.currentKernelWorkersDrained, unprovenOperationStopIds: status.unprovenOperationStopIds,
        unknownEffectOperationIds: status.unknownEffectOperationIds, unresolvedModelRequestIds: status.unresolvedModelRequestIds };
      if (!status.currentKernelWorkersDrained || status.unprovenOperationStopIds.length) failures.push('Original Bot executors have not confirmed stopping. Retry Sleep after the listed owners can reconcile.');
      if (failures.length) throw Object.assign(new Error(failures.join('\n')), { execution });
      return execution;
    },
    async machine(bot, machine, waking) {
      const vm = (await options.computers.listVms()).find((item) => item.machineId === machine.machineId);
      if (!vm) throw new Error(`VM is unavailable: ${machine.label}`);
      if (vm.state === "unknown" || vm.state === "crashed") throw new Error(`VM ${machine.label}: ${vm.statusDetail ?? vm.state}`);
      if (waking) {
        if (vm.state === "running") {
          if (vm.binding.guest?.state === "failed") throw new Error(`VM ${machine.label}: ${vm.binding.guest.detail ?? 'Guest startup failed'}`);
          if (vm.binding.guest && vm.binding.guest.state !== "ready") {
            await options.computers.reconcileVmGuests();
            return { ...machine, state: "starting", detail: vm.binding.guest.detail ?? "Waiting for the guest desktop" };
          }
          return { ...machine, state: "ready", detail: undefined };
        }
        if (machine.state !== "starting") await options.computers.vmAction({ machineId: vm.machineId, action: "start" });
        return { ...machine, state: "starting" };
      }
      if (vm.state === "shutoff") return { ...machine, state: "stopped", detail: undefined };
      const retention = await vmRetention(bot, vm, (await options.computers.list()).desktops);
      if (retention) return { ...machine, state: "kept-running", detail: retention };
      if (machine.state !== "stopping") await options.computers.vmAction({ machineId: vm.machineId, action: "shutdown" });
      return { ...machine, state: "stopping", detail: "Waiting for the VM to confirm shutdown" };
    },
    async prepareWake(bot) {
      await options.resumeRemoteScope(botScopeId(bot.id));
    },
    async resume(bot, work) {
      const resumed = await options.agent.kernel.agentRuntimeRequest<BotScopeResume, 'runtime.bot.scope.resume'>('runtime.bot.scope.resume', await suspension(bot));
      if (resumed.blockedRunIds.includes(work.runId)) throw new Error(`Run ${work.runId} has an unresolved original effect or request. Inspect it before continuing; Wake does not resend Unknown.`);
      const current = await options.agent.runtime.run(work.runId);
      if (!current.cancel_requested && !['completed','failed','cancelled'].includes(current.state)) await options.agent.continueLaunch(work.runId);
    },
    async awakened(bot) { options.resumeMemory(botScopeId(bot.id)); },
  };
}
