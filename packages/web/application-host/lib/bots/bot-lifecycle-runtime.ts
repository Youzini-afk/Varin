import type { BotSummary, BotSleepMachine } from "@varin/application-client";
import type { PiRuntimeBroker } from "@varin/runtime-broker";
import type { ComputerDesktop, ComputerVmDescriptor } from "@varin/protocol";
import type { ComputerService } from "../computer/computer-service.js";
import type { ThreadRegistry } from "../harness/thread-registry.js";
import type { ThreadRuntime } from "../harness/thread-runtime.js";
import { botScopeId } from "../harness/owner-scope.js";
import type { BotLifecycleRuntime } from "./bot-service.js";

const RESUME_TEXT = "The user woke this Bot after putting it to sleep. Continue the unfinished work from its saved progress. Inspect the current files, processes and desktop first. Do not replay an uncertain external side effect, restart a completed task, or resume work that was already paused for user input.";

export interface BotLifecycleRuntimeOptions {
  hostId: string;
  registry: ThreadRegistry;
  runtime: ThreadRuntime;
  broker: Pick<PiRuntimeBroker, "requestForSession" | "openSession" | "closeSession">;
  computers: ComputerService;
  stopSessionProcesses(sessionId: string): Promise<void>;
  stopRemoteScope(scopeId: string): Promise<void>;
  resumeRemoteScope(scopeId: string): Promise<void>;
  remoteMachineOwners(hostId: string): Promise<string[]>;
  stopRoot(sessionId: string): Promise<void>;
  stopMemory(scopeId: string): Promise<void>;
  resumeMemory(scopeId: string): void;
  wakeFollowUps(scopeId: string): Promise<void>;
}

const vmDesktops = (vm: ComputerVmDescriptor, desktops: ComputerDesktop[]) => desktops.filter((desktop) =>
  desktop.machineId === vm.machineId || desktop.remote?.connectionId === `vm:${vm.binding.domainUuid}`
  || (vm.binding.guest?.connectionId && desktop.remote?.connectionId === vm.binding.guest.connectionId));

export function createBotLifecycleRuntime(options: BotLifecycleRuntimeOptions): BotLifecycleRuntime {
  const vmRetention = async (bot: BotSummary, vm: ComputerVmDescriptor, desktops: ComputerDesktop[]): Promise<string | null> => {
    if (vm.binding.guest?.hostId === options.hostId) return "This VM hosts the Bot coordinator";
    const owners = vm.binding.guest?.hostId ? await options.remoteMachineOwners(vm.binding.guest.hostId) : [];
    if (owners.some((scope) => scope !== botScopeId(bot.id))) return "Shared with other remote work";
    const associated = vmDesktops(vm, desktops);
    if (!associated.length && !owners.includes(botScopeId(bot.id))) return "The VM has no verified exclusive Bot work association";
    for (const desktop of associated) {
      if (desktop.work?.some((work) => work.scopeId !== botScopeId(bot.id))) return "Shared with other work";
      if ((await options.computers.control(desktop.id)).owner === "human") return "Currently controlled by the user";
    }
    return null;
  };
  return {
    async planWork(bot) {
      const scope = botScopeId(bot.id);
      await options.registry.flushScope(scope);
      const snapshots = await options.registry.listWorkspaceThreadSnapshots(scope);
      const work = snapshots.filter(({ thread }) => thread.purpose !== "bot-root").map(({ thread, activeRun }) => ({
        threadId: thread.id,
        sessionId: activeRun?.sessionId ?? null,
        runId: activeRun?.id ?? null,
        resume: thread.lifecycle === "active" && Boolean(activeRun && (activeRun.outcome === null || activeRun.outcome === "lost"))
          && thread.attention !== "user" && thread.attention !== "permission",
        stopped: false,
        resumed: false,
      }));
      // Entry goes first: stop the orchestrator before its delegated workers.
      if (bot.entrySessionId) {
        const root = snapshots.find(({ thread }) => thread.purpose === "bot-root");
        let streaming = root?.activeRun?.outcome === null;
        try {
          const snapshot = await options.broker.requestForSession(bot.entrySessionId, "session.snapshot", { sessionId: bot.entrySessionId });
          streaming = snapshot.isStreaming === true || snapshot.busy === true;
        } catch { /* The durable Run still supplies resume intent for an unreachable worker. */ }
        work.unshift({ threadId: "", sessionId: bot.entrySessionId, runId: root?.activeRun?.id ?? null,
          resume: streaming, stopped: false, resumed: false });
      }
      // Old Runs can still own background shells after their model turn ended.
      const sessions = await options.registry.listWorkspaceRunSessionIds(scope);
      const covered = new Set(work.map((item) => item.sessionId));
      for (const sessionId of sessions) if (!covered.has(sessionId)) {
        work.push({ threadId: "", sessionId, runId: null, resume: false, stopped: false, resumed: false });
      }
      return work;
    },
    async planMachines(bot) {
      const scope = botScopeId(bot.id);
      const { desktops } = await options.computers.list();
      const used = desktops.filter((desktop) => desktop.work?.some((item) => item.scopeId === scope));
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
    async stop(bot, work) {
      if (work.threadId) {
        const latest = await options.registry.getActiveRun(botScopeId(bot.id), work.threadId);
        if (latest?.outcome === 'success' || (latest && latest.id !== work.runId)) work.resume = false;
      } else if (work.sessionId === bot.entrySessionId && work.sessionId) {
        try {
          const snapshot = await options.broker.requestForSession(work.sessionId, 'session.snapshot', { sessionId: work.sessionId });
          if (!snapshot.isStreaming && !snapshot.busy) work.resume = false;
        } catch { /* A lost worker retains its previously recorded continuation intent. */ }
      }
      if (work.threadId) await options.runtime.suspendForBot(botScopeId(bot.id), work.threadId);
      if (work.sessionId) {
        try { await options.broker.requestForSession(work.sessionId, "agent.abort", { sessionId: work.sessionId }); }
        catch { /* Successful worker closure below confirms the stop independently of abort. */ }
        const stops = await Promise.allSettled([
          options.stopSessionProcesses(work.sessionId), options.broker.closeSession(work.sessionId).catch((error: unknown) => {
            // Delegated workers were already closed by suspendForBot; retained
            // historical sessions also have no live worker to terminate.
            if ((error as { code?: string }).code !== 'session_not_found') throw error;
          }),
        ]);
        const failures = stops.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) throw new Error(failures.map((result) => String(result.reason)).join('\n'));
        if (work.sessionId === bot.entrySessionId) await options.stopRoot(work.sessionId);
      }
    },
    async stopScope(bot) {
      const scope = botScopeId(bot.id);
      const results = await Promise.allSettled([options.stopRemoteScope(scope), options.stopMemory(scope)]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length) throw new Error(failures.map((result) => String(result.reason)).join('\n'));
      for (const desktop of await options.computers.workDesktops(scope)) {
        if (!desktop.usage || !desktop.work?.some((work) => work.scopeId === scope && work.sessionId === desktop.usage!.sessionId)) continue;
        try {
          if ((await options.computers.control(desktop.id)).owner !== "human") await options.computers.cancel(desktop.id);
        } catch (error) {
          const stoppedVm = (await options.computers.listVms()).some((vm) => vm.state === 'shutoff' && vmDesktops(vm, [desktop]).length > 0);
          if (!stoppedVm) throw error;
        }
      }
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
      const requestPrefix = `bot-wake:${bot.activity!.operationId}:${work.threadId || work.sessionId}:`;
      const requestId = `${requestPrefix}${bot.activity!.wakeAttempt ?? 0}`;
      if (!work.threadId) {
        if (!work.sessionId) return;
        await options.broker.openSession({ sessionId: work.sessionId, cwd: bot.homeDir });
        await options.broker.requestForSession(work.sessionId, 'session.instructions.apply', { sessionId: work.sessionId, instructions: bot.instructions });
        if (bot.model) await options.broker.requestForSession(work.sessionId, 'model.select', { sessionId: work.sessionId, provider: bot.model.providerId, modelId: bot.model.modelId });
        else await options.broker.requestForSession(work.sessionId, 'model.resetDefault', { sessionId: work.sessionId });
        const result = await options.broker.requestForSession(work.sessionId, "agent.threadRequest", { sessionId: work.sessionId, text: RESUME_TEXT, messageId: requestId });
        if (!result.accepted) throw new Error("Bot entry rejected the wake continuation");
        return;
      }
      const scopeId = botScopeId(bot.id);
      const thread = await options.registry.getThreadById(scopeId, work.threadId);
      if (!thread || thread.lifecycle === "archived" || thread.attention === "user" || thread.attention === "permission") return;
      const runs = await options.registry.listRuns(scopeId, thread.id);
      const submitted = runs.find((run) => run.request?.requestId === requestId);
      if (submitted) {
        if (submitted.outcome === 'failure' || submitted.outcome === 'cancelled') throw new Error(submitted.exitReason ?? 'Wake continuation failed');
        return;
      }
      // A user continuation after the stop owns the new state; never replay it.
      const previous = runs.find((run) => run.id === thread.activeRunId);
      if (previous?.outcome === 'success') return;
      if (thread.activeRunId !== work.runId && !(previous?.request?.requestId.startsWith(requestPrefix)
        && (previous.outcome === 'failure' || previous.outcome === 'cancelled' || previous.outcome === 'lost'))) return;
      await options.runtime.continueRun({ scopeId, parent: thread.parent, threadId: thread.id,
        mode: previous?.sessionId ? "continue" : "fresh", task: RESUME_TEXT, requestId, resumeSuspended: true });
    },
    async awakened(bot) {
      const scope = botScopeId(bot.id);
      options.resumeMemory(scope);
      for (const { thread } of await options.registry.listWorkspaceThreadSnapshots(scope)) {
        await options.registry.tryDequeue(scope, thread.parent);
      }
      await options.wakeFollowUps(scope);
    },
  };
}
