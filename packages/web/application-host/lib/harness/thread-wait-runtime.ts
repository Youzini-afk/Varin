import type { Thread, ThreadDependencyWait, ThreadRun } from "@varin/protocol";
import type { ThreadRegistry } from "./thread-registry.js";

export function dependencyChange(wait: ThreadDependencyWait, thread: Thread, run: ThreadRun | null): string | null {
  const target = wait.targets.find(entry => entry.id === thread.id);
  if (!target) return null;
  if (thread.resultRevision !== undefined && thread.resultRevision !== target.resultRevision) return `Result available from ${thread.id}`;
  if (run?.outcome === "lost" && target.outcome !== "lost") return `Execution lost in ${thread.id}`;
  if (["user", "permission", "stalled", "looping"].includes(thread.attention) && thread.attention !== target.attention) return `Attention required in ${thread.id}`;
  if (thread.integration === "conflict" && target.integration !== "conflict") return `Integration conflict in ${thread.id}`;
  if ((thread.lifecycle === "settled" || thread.lifecycle === "archived") && (thread.lifecycle !== target.lifecycle
    || thread.activeRunId !== target.runId || run?.outcome !== target.outcome)) return `Execution finished in ${thread.id}`;
  return null;
}

/** Rebuilds only durable dependency subscriptions, without periodic model/status polling. */
export function createThreadWaitRuntime(options: {
  registry: ThreadRegistry;
  resume(scopeId: string, thread: Thread, wait: ThreadDependencyWait): Promise<void>;
  onError(error: unknown): void;
}) {
  const watched = new Map<string, { scopeId: string; thread: Thread }>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const inFlight = new Map<string, Promise<void>>();
  const changedWhileChecking = new Set<string>();
  let disposed = false;

  const process = (scopeId: string, threadId: string): Promise<void> => {
    const key = `${scopeId}:${threadId}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = Promise.resolve().then(async () => {
      if (disposed) return;
      const thread = await options.registry.getThreadById(scopeId, threadId);
      const wait = thread?.dependencyWait;
      if (!thread || !wait || thread.lifecycle === "archived" || thread.deletion) { watched.delete(key); return; }
      watched.set(key, { scopeId, thread });
      let reason = wait.reason;
      if (!reason && wait.deadline !== undefined && Date.now() >= wait.deadline) reason = "Requested waiting time elapsed";
      if (!reason) {
        for (const target of wait.targets) {
          const current = await options.registry.getThreadSnapshot(scopeId, target.id);
          if (!current) { reason = `Dependency ${target.id} is no longer available`; break; }
          reason = dependencyChange(wait, current.thread, current.activeRun) ?? undefined;
          if (reason) break;
        }
      }
      if (!reason && thread.messages?.some(message => message.direction === "in"
        && (message.status === "delivered" || message.status === "resolved") && (message.kind === "request" || message.replyTo)
        && !wait.requestIds.includes(message.id))) reason = "Addressed request or reply received";
      const run = await options.registry.getActiveRun(scopeId, threadId);
      if (!reason) {
        const prior = timers.get(key);
        if (prior) clearTimeout(prior);
        if (wait.deadline !== undefined) {
          const timer = setTimeout(() => { timers.delete(key); void process(scopeId, threadId).catch(options.onError); }, Math.min(2_147_483_647, Math.max(1, wait.deadline - Date.now())));
          timer.unref?.(); timers.set(key, timer);
        }
        return;
      }
      if (run?.id !== wait.runId || run.outcome === "cancelled") {
        await options.registry.setDependencyWait(scopeId, threadId, null, wait.id); return;
      }
      // The live wait handler owns its tool response. Only a lost/idle execution
      // needs a new input; progress can never manufacture another model turn.
      if (run.workerState !== "lost" && run.workerState !== "exited") return;
      const ready = { ...wait, state: "resuming" as const, reason };
      if (!await options.registry.setDependencyWait(scopeId, threadId, ready, wait.id)) return;
      try {
        await options.resume(scopeId, thread, ready);
        await options.registry.setDependencyWait(scopeId, threadId, null, wait.id);
      } catch (error) {
        await options.registry.setDependencyWait(scopeId, threadId, { ...ready, state: "ready", error: error instanceof Error ? error.message : String(error) }, wait.id);
        options.onError(error);
      }
    }).finally(() => {
      if (inFlight.get(key) === task) inFlight.delete(key);
      if (changedWhileChecking.delete(key) && !disposed) void process(scopeId, threadId).catch(options.onError);
    });
    inFlight.set(key, task); return task;
  };

  const observe = (scopeId: string, thread: Thread, run: ThreadRun | null) => {
    if (disposed) return;
    const key = `${scopeId}:${thread.id}`;
    if (thread.dependencyWait && thread.lifecycle !== "archived" && !thread.deletion) {
      watched.set(key, { scopeId, thread });
      if (thread.dependencyWait.state === "watching") {
        if (inFlight.has(key)) changedWhileChecking.add(key);
        else void process(scopeId, thread.id).catch(options.onError);
      }
    } else {
      watched.delete(key); const timer = timers.get(key); if (timer) clearTimeout(timer); timers.delete(key);
    }
    for (const entry of watched.values()) if (entry.scopeId === scopeId && entry.thread.id !== thread.id
      && entry.thread.dependencyWait && dependencyChange(entry.thread.dependencyWait, thread, run)) {
      const targetKey = `${scopeId}:${entry.thread.id}`;
      if (inFlight.has(targetKey)) changedWhileChecking.add(targetKey);
      else void process(scopeId, entry.thread.id).catch(options.onError);
    }
  };
  return {
    observe,
    reconcile: async () => {
      for (const scopeId of await options.registry.listWorkspaceIds()) {
        for (const snapshot of await options.registry.listWorkspaceThreadSnapshots(scopeId)) if (snapshot.thread.dependencyWait) {
          watched.set(`${scopeId}:${snapshot.thread.id}`, { scopeId, thread: snapshot.thread });
          await process(scopeId, snapshot.thread.id);
        }
      }
    },
    dispose: async () => { disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); watched.clear(); await Promise.allSettled(inFlight.values()); },
  };
}
