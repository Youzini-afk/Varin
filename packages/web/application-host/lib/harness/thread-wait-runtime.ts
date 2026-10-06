import type { Thread, ThreadDependencyWait, ThreadRun } from "@varin/protocol";
import type { ThreadRegistry } from "./thread-registry.js";

export function dependencyChange(wait: ThreadDependencyWait, thread: Thread, run: ThreadRun | null): string | null {
  if (wait.replyTo) return null;
  const target = wait.targets.find(entry => entry.id === thread.id);
  if (!target) return null;
  if (thread.codeSubmissions?.some(submission => ["applied", "conflict", "failed"].includes(submission.status)
    && target.codeSubmissionStates?.[submission.id] !== submission.status)) return `Code submission receipt available in ${thread.id}`;
  if (target.runId === wait.runId) return null;
  if (thread.resultRevision !== undefined && thread.resultRevision !== target.resultRevision) return `Result available from ${thread.id}`;
  if (run?.outcome === "lost" && target.outcome !== "lost") return `Execution lost in ${thread.id}`;
  if (["user", "permission", "stalled", "looping"].includes(thread.attention) && thread.attention !== target.attention) return `Attention required in ${thread.id}`;
  if (thread.integration === "conflict" && target.integration !== "conflict") return `Integration conflict in ${thread.id}`;
  if ((thread.lifecycle === "settled" || thread.lifecycle === "archived") && (thread.lifecycle !== target.lifecycle
    || thread.activeRunId !== target.runId || run?.outcome !== target.outcome)) return `Execution finished in ${thread.id}`;
  return null;
}

export function correlatedReply(thread: Thread, messageId: string) {
  return thread.messages?.find(message => message.direction === "in" && message.replyTo === messageId
    && (message.status === "held" || message.status === "delivered" || message.status === "resolved"));
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
      const waits = thread?.dependencyWaits ?? [];
      if (!thread || !waits.length || thread.lifecycle === "archived" || thread.deletion) { watched.delete(key); return; }
      watched.set(key, { scopeId, thread });
      const run = await options.registry.getActiveRun(scopeId, threadId);
      const priorTimer = timers.get(key);
      if (priorTimer) clearTimeout(priorTimer);
      timers.delete(key);
      let nextDeadline: number | undefined;
      for (const wait of waits) {
        if (run?.id !== wait.runId || run.outcome === "cancelled") {
          await options.registry.setDependencyWait(scopeId, threadId, null, wait.id); continue;
        }
        if (wait.error) continue;
        let reason = wait.reason;
        const reply = wait.replyTo ? correlatedReply(thread, wait.replyTo) : undefined;
        if (reply) reason = `Reply to message ${wait.replyTo} from ${reply.from.kind} ${reply.from.id}:\n${reply.text}`;
        if (!reason && wait.deadline !== undefined && Date.now() >= wait.deadline) reason = "Requested waiting time elapsed";
        if (!reason && !wait.replyTo) {
          for (const target of wait.targets) {
            const current = await options.registry.getThreadSnapshot(scopeId, target.id);
            if (!current) { reason = `Dependency ${target.id} is no longer available`; break; }
            reason = dependencyChange(wait, current.thread, current.activeRun) ?? undefined;
            if (reason) break;
          }
        }
        if (!reason && !wait.replyTo && thread.messages?.some(message => message.direction === "in"
          && (message.status === "delivered" || message.status === "resolved") && (message.kind === "request" || message.replyTo)
          && !wait.requestIds.includes(message.id))) reason = "Addressed request or reply received";
        if (!reason) {
          if (wait.deadline !== undefined) {
            nextDeadline = Math.min(nextDeadline ?? Infinity, wait.deadline);
          }
          continue;
        }
        // The live wait handler owns its tool response. Only a lost/idle execution
        // needs a new input; progress can never manufacture another model turn.
        if (run.workerState !== "lost" && run.workerState !== "exited") continue;
        const ready = { ...wait, state: "resuming" as const, reason,
          ...(wait.replyTo && !reply && wait.deadline !== undefined && Date.now() >= wait.deadline ? { replyOutcome: "elapsed" as const } : {}) };
        if (!await options.registry.setDependencyWait(scopeId, threadId, ready, wait.id)) return;
        try {
          await options.resume(scopeId, thread, ready);
          await options.registry.setDependencyWait(scopeId, threadId, null, wait.id);
        } catch (error) {
          await options.registry.setDependencyWait(scopeId, threadId, { ...ready, state: "ready", error: error instanceof Error ? error.message : String(error) }, wait.id);
          options.onError(error);
        }
        return;
      }
      if (nextDeadline !== undefined && nextDeadline > Date.now()) {
        const timer = setTimeout(() => { timers.delete(key); void process(scopeId, threadId).catch(options.onError); }, Math.min(2_147_483_647, Math.max(1, nextDeadline - Date.now())));
        timer.unref?.(); timers.set(key, timer);
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
    if (thread.dependencyWaits?.length && thread.lifecycle !== "archived" && !thread.deletion) {
      watched.set(key, { scopeId, thread });
      if (thread.dependencyWaits.some(wait => !wait.error && (wait.state === "watching" || run?.workerState === "lost" || run?.workerState === "exited"))) {
        if (inFlight.has(key)) changedWhileChecking.add(key);
        else void process(scopeId, thread.id).catch(options.onError);
      }
    } else {
      watched.delete(key); const timer = timers.get(key); if (timer) clearTimeout(timer); timers.delete(key);
    }
    for (const entry of watched.values()) if (entry.scopeId === scopeId && entry.thread.id !== thread.id
      && entry.thread.dependencyWaits?.some(wait => dependencyChange(wait, thread, run))) {
      const targetKey = `${scopeId}:${entry.thread.id}`;
      if (inFlight.has(targetKey)) changedWhileChecking.add(targetKey);
      else void process(scopeId, entry.thread.id).catch(options.onError);
    }
  };
  return {
    observe,
    reconcile: async () => {
      for (const scopeId of await options.registry.listWorkspaceIds()) {
        for (const snapshot of await options.registry.listWorkspaceThreadSnapshots(scopeId)) if (snapshot.thread.dependencyWaits?.length) {
          watched.set(`${scopeId}:${snapshot.thread.id}`, { scopeId, thread: snapshot.thread });
          await process(scopeId, snapshot.thread.id);
        }
      }
    },
    dispose: async () => { disposed = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); watched.clear(); await Promise.allSettled(inFlight.values()); },
  };
}
