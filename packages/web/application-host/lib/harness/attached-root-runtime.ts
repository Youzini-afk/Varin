import type {
  PiMessage,
  SessionEntriesResult,
  SessionSnapshot,
  SessionStats,
  Thread,
  ThreadPurpose,
  ThreadReport,
  ThreadRunOutcome,
  WorkFocusId,
} from "@varin/protocol";
import type { ThreadRegistry } from "./thread-registry.js";

export interface BrokerEventLike {
  kind: string;
  sessionId?: string;
  expected?: boolean;
  role?: string;
  envelope?: { kind?: string; event?: string; data?: unknown };
}

interface ActiveAttachedRoot {
  baseline: SessionStats | null;
  fromEntryId: string | null;
  messages: PiMessage[];
  runId: string;
  threadId: string;
  workspaceId: string;
}

/** What a purpose-specific attach resolves about an eligible session. */
export interface AttachedRootTarget {
  /** Durable owner scope for the root Thread — a workspace id or `bot:<id>`. */
  scopeId: string;
  /** Frozen work focus recorded on the root Thread and its Runs. */
  workFocus: WorkFocusId;
  /** `createdBy` recorded on the root Thread (user chat vs bot entry). */
  createdBy: "user" | "agent";
}

export interface AttachedRootRuntimeOptions {
  /** Purpose discriminator recorded on the root Thread (`research-root`, `bot-root`). */
  purpose: ThreadPurpose;
  /**
   * Decide whether this session is an eligible root for this runtime.
   * Returning `null` leaves the session to the ordinary thread paths.
   * Called once per `agent_start`; a throw marks the session blocked until
   * the next `agent_start`/`agent_settled`/`worker.exit`.
   */
  resolveTarget(sessionId: string, snapshot: SessionSnapshot): Promise<AttachedRootTarget | null> | AttachedRootTarget | null;
  registry: ThreadRegistry;
  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> | SessionSnapshot | null;
  sessions: {
    entries(sessionId: string, scope?: "branch" | "all"): Promise<SessionEntriesResult>;
    snapshot(sessionId: string): Promise<SessionSnapshot>;
    stats(sessionId: string): Promise<SessionStats>;
  };
  onError?(error: unknown): void;
  rejectHarnessRequest?(sessionId: string, requestId: string, message: string): Promise<void>;
}

const recordOf = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const assistantText = (messages: readonly PiMessage[], noun: string): { text: string; outcome: ThreadRunOutcome; error: string | null } => {
  const assistant = messages.findLast((message) => message.role === "assistant");
  if (!assistant || assistant.role !== "assistant") {
    return { text: `${noun} turn completed without a final assistant message.`, outcome: "failure", error: "missing final assistant message" };
  }
  const text = assistant.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (assistant.stopReason === "aborted") {
    return { text: text || `${noun} turn was cancelled.`, outcome: "cancelled", error: `${noun.toLowerCase()} turn was cancelled` };
  }
  if (assistant.stopReason === "error" || assistant.errorMessage) {
    const error = assistant.errorMessage || `${noun.toLowerCase()} model returned an error`;
    return { text: text || error, outcome: "failure", error };
  }
  return { text: text || `${noun} turn completed.`, outcome: "success", error: null };
};

const deltaStats = (current: SessionStats, baseline: SessionStats | null) => ({
  costUsd: Math.max(0, current.cost - (baseline?.cost ?? 0)),
  steps: Math.max(0, current.toolCalls - (baseline?.toolCalls ?? 0)),
  tokens: {
    input: Math.max(0, current.tokens.input - (baseline?.tokens.input ?? 0)),
    output: Math.max(0, current.tokens.output - (baseline?.tokens.output ?? 0)),
    cacheRead: Math.max(0, current.tokens.cacheRead - (baseline?.tokens.cacheRead ?? 0)),
  },
});

const userInputFromEntries = (entries: SessionEntriesResult): { entryId: string; text: string } | null => {
  for (let index = entries.entries.length - 1; index >= 0; index -= 1) {
    const entry = entries.entries[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    const text = typeof entry.message.content === "string"
      ? entry.message.content.trim()
      : entry.message.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join("\n")
        .trim();
    if (text) return { entryId: entry.id, text };
  }
  return null;
};

/**
 * Shared lifecycle for attached roots: a user's real Pi session is bound to
 * one durable root Thread per purpose, and each turn admits a Run whose
 * stats/report close when the turn settles. The Pi worker remains the sole
 * model/runtime owner; this runtime owns catalog identity only.
 */
export function createAttachedRootRuntime(options: AttachedRootRuntimeOptions) {
  const purpose = options.purpose;
  const noun = purpose === "research-root" ? "Research" : "Bot";
  const active = new Map<string, ActiveAttachedRoot>();
  const blocked = new Map<string, string>();
  const tails = new Map<string, Promise<void>>();
  let disposed = false;

  const reportError = (error: unknown): void => {
    try { options.onError?.(error); } catch { /* observer errors cannot break event routing */ }
  };

  const enqueue = <T>(sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(sessionId) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    const tail = task.then(() => undefined, () => undefined);
    tails.set(sessionId, tail);
    return task.finally(() => {
      if (tails.get(sessionId) === tail) tails.delete(sessionId);
    });
  };

  const snapshotFor = async (sessionId: string): Promise<SessionSnapshot | null> => (
    await options.getSessionSnapshot(sessionId) ?? options.sessions.snapshot(sessionId).catch(() => null)
  );

  const findRoot = async (scopeId: string, sessionId: string): Promise<Thread | null> => {
    const roots = (await options.registry.listThreads(
      scopeId,
      { kind: "session", id: sessionId },
      true,
    )).filter((thread) => thread.purpose === purpose);
    return roots.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null;
  };

  const attach = async (sessionId: string): Promise<void> => {
    if (disposed || active.has(sessionId)) return;
    const snapshot = await snapshotFor(sessionId);
    if (!snapshot) return;
    const target = await options.resolveTarget(sessionId, snapshot);
    if (!target) return;
    const scopeId = target.scopeId;
    const existingBinding = await options.registry.getSessionBinding(sessionId);
    if (existingBinding?.owner === "spawned-child") return;
    if (existingBinding?.owner === "attached-root") {
      const boundThread = await options.registry.getThreadById(existingBinding.owningScopeId, existingBinding.threadId);
      // A Bot entry using research focus must not be adopted and settled by
      // two attached-root runtimes.
      if (boundThread?.purpose !== purpose) return;
      const run = await options.registry.getActiveRun(existingBinding.owningScopeId, existingBinding.threadId);
      if (run?.id === existingBinding.runId && run.outcome === null) {
        const entries = await options.sessions.entries(sessionId, "branch").catch(() => null);
        const input = entries ? userInputFromEntries(entries) : null;
        active.set(sessionId, {
          baseline: await options.sessions.stats(sessionId).catch(() => null),
          fromEntryId: input?.entryId ?? entries?.leafId ?? null,
          messages: [],
          runId: run.id,
          threadId: existingBinding.threadId,
          workspaceId: existingBinding.owningScopeId,
        });
        return;
      }
      await options.registry.unbindRunSession(sessionId, { retainHistorical: false });
    }

    const startEntries = await options.sessions.entries(sessionId, "branch");
    const input = userInputFromEntries(startEntries);
    if (!input) throw new Error(`The ${purpose} root cannot identify the current user request`);
    let thread = await findRoot(scopeId, sessionId);
    if (!thread) {
      thread = await options.registry.createThread({
        scopeId,
        parent: { kind: "session", id: sessionId },
        brief: input.text,
        kind: "discussion",
        purpose,
        createdBy: target.createdBy,
        carryBlocks: true,
        concurrency: options.registry.maxConcurrency,
        scope: [],
        worktree: "none",
        ...(snapshot.model ? { model: { providerId: snapshot.model.provider, modelId: snapshot.model.id } } : {}),
        tools: [...snapshot.activeTools],
        workFocus: target.workFocus,
        permissions: {},
        autoRun: false,
        hidden: true,
      });
    } else if (thread.lifecycle === "archived") {
      thread = await options.registry.restoreThread(scopeId, thread.id) ?? thread;
    }
    thread = await options.registry.updateThreadBrief(scopeId, thread.id, input.text) ?? thread;

    const previous = await options.registry.getActiveRun(scopeId, thread.id);
    if (previous?.outcome === null) {
      await options.registry.endRun(scopeId, thread.id, previous.id, "lost", "attached root binding was not retained");
    }
    const run = (await options.registry.admitRun(scopeId, thread.id, "pi", {
      allowSettled: true,
      sessionOwner: "attached-root",
      frozen: {
        model: snapshot.model ? { providerId: snapshot.model.provider, modelId: snapshot.model.id } : null,
        tools: [...snapshot.activeTools],
        scope: [],
        worktree: "none",
        systemPromptFragment: null,
        inputOrigin: "task",
        workFocus: target.workFocus,
      },
    })).run;
    try {
      await options.registry.markRunRunning(scopeId, thread.id, run.id, sessionId);
    } catch (error) {
      await options.registry.endRun(scopeId, thread.id, run.id, "failure", `unable to attach the ${purpose} root`).catch(reportError);
      throw error;
    }
    active.set(sessionId, {
      baseline: await options.sessions.stats(sessionId).catch(() => null),
      fromEntryId: input.entryId,
      messages: [],
      runId: run.id,
      threadId: thread.id,
      workspaceId: scopeId,
    });
  };

  const finish = async (
    sessionId: string,
    forced?: { outcome: ThreadRunOutcome; reason: string },
  ): Promise<void> => {
    const binding = active.get(sessionId);
    if (!binding) return;
    active.delete(sessionId);
    try {
      const currentRun = await options.registry.getActiveRun(binding.workspaceId, binding.threadId);
      if (currentRun?.id !== binding.runId || currentRun.outcome !== null) return;
      if (forced) {
        await options.registry.endRun(
          binding.workspaceId,
          binding.threadId,
          binding.runId,
          forced.outcome,
          forced.reason,
        );
        return;
      }
      const [stats, entries] = await Promise.all([
        options.sessions.stats(sessionId).catch(() => null),
        options.sessions.entries(sessionId, "branch").catch(() => null),
      ]);
      // A failed baseline read cannot be treated as zero: the user session may
      // already contain unrelated history, so publishing its totals as this
      // Run would fabricate cost and token evidence. Tool steps remain tracked
      // from lifecycle events; omit aggregate counters until a real baseline is
      // available.
      if (stats && binding.baseline) {
        await options.registry.updateRunProgress(
          binding.workspaceId,
          binding.threadId,
          deltaStats(stats, binding.baseline),
        );
      }
      const conclusion = assistantText(binding.messages, noun);
      const branchEntries = entries?.entries ?? [];
      const report: ThreadReport = {
        conclusion: conclusion.text,
        changedFiles: [],
        unresolved: conclusion.error ? [conclusion.error] : [],
        deviations: [],
        confidence: conclusion.outcome === "success" ? 0.5 : 0,
        transcriptRef: {
          runtimeId: "pi",
          sessionId,
          fromEntryId: binding.fromEntryId,
          toEntryId: entries?.leafId ?? branchEntries.at(-1)?.id ?? null,
          ...(entries?.leafId ? { branchLeafId: entries.leafId } : {}),
        },
        blocksSnapshot: {},
      };
      await options.registry.endRun(
        binding.workspaceId,
        binding.threadId,
        binding.runId,
        conclusion.outcome,
        conclusion.error,
        report,
      );
    } finally {
      await options.registry.unbindRunSession(sessionId, { retainHistorical: false }).catch(reportError);
    }
  };

  const eventType = (event: BrokerEventLike): { data: Record<string, unknown>; type: string } | null => {
    if (event.kind !== "host" || event.envelope?.kind !== "event" || event.envelope.event !== "agent.event") return null;
    const data = recordOf(recordOf(event.envelope.data).event);
    return typeof data.type === "string" ? { data, type: data.type } : null;
  };

  const harnessRequest = (event: BrokerEventLike): { method: string; requestId: string } | null => {
    if (event.kind !== "host" || event.envelope?.kind !== "event" || event.envelope.event !== "harness.request") return null;
    const data = recordOf(event.envelope.data);
    const method = typeof data.method === "string" ? data.method : "";
    const requestId = typeof data.requestId === "string"
      ? data.requestId
      : typeof data.id === "string" ? data.id : "";
    return method && requestId ? { method, requestId } : null;
  };

  const processEvent = (
    event: BrokerEventLike,
    forward: () => Promise<void> | void,
  ): Promise<void> => {
    // A service request can be waiting for this very cancellation. Queuing the
    // cancel behind its forward() would prevent the router from aborting it.
    // Cancellation does not attach or mutate root-thread lifecycle state.
    if (event.kind === "host" && event.envelope?.kind === "event"
      && event.envelope.event === "harness.cancel") return Promise.resolve(forward());
    const sessionId = event.sessionId;
    if (!sessionId) return Promise.resolve(forward());
    return enqueue(sessionId, async () => {
      const agentEvent = eventType(event);
      if (agentEvent?.type === "agent_start") {
        blocked.delete(sessionId);
        try {
          await attach(sessionId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          blocked.set(sessionId, message);
          reportError(error);
        }
      }
      const request = harnessRequest(event);
      const blockedReason = blocked.get(sessionId);
      if (blockedReason && request?.method.startsWith("thread.")) {
        if (options.rejectHarnessRequest) {
          await options.rejectHarnessRequest(
            sessionId,
            request.requestId,
            `${noun} root attachment failed; thread execution is unavailable for this Run: ${blockedReason}`,
          );
        } else {
          reportError(new Error(`Unable to reject ${request.method} after ${purpose} root attachment failed`));
        }
      } else {
        await forward();
      }
      const binding = active.get(sessionId);
      if (!binding) {
        if ((event.kind === "worker.exit" && event.role === "session")
          || agentEvent?.type === "agent_settled") {
          blocked.delete(sessionId);
        }
        return;
      }
      // Auxiliary worker exits (e.g. a compaction worker) share the
      // sessionId; only the session worker's exit loses the attached Run.
      if (event.kind === "worker.exit" && event.role === "session") {
        await finish(sessionId, {
          outcome: "lost",
          reason: event.expected ? "root session closed before the attached Run settled" : "root session worker exited unexpectedly",
        });
        return;
      }
      if (event.kind === "worker.exit") return;
      if (!agentEvent) return;
      if (agentEvent.type === "agent_end" && agentEvent.data.willRetry !== true) {
        binding.messages = Array.isArray(agentEvent.data.messages) ? agentEvent.data.messages as PiMessage[] : [];
      } else if (agentEvent.type === "tool_execution_start") {
        const run = await options.registry.getActiveRun(binding.workspaceId, binding.threadId);
        if (run?.id === binding.runId && run.outcome === null) {
          await options.registry.updateRunProgress(binding.workspaceId, binding.threadId, {
            steps: run.steps + 1,
            lastToolCall: {
              name: typeof agentEvent.data.toolName === "string" ? agentEvent.data.toolName : "unknown",
              at: new Date().toISOString(),
            },
          });
        }
      } else if (agentEvent.type === "agent_settled") {
        await finish(sessionId);
        blocked.delete(sessionId);
      }
    }).catch((error) => {
      reportError(error);
    });
  };

  const cancelSession = (sessionId: string, reason: string): Promise<void> => (
    enqueue(sessionId, () => finish(sessionId, { outcome: "cancelled", reason }))
  );

  const drain = async (): Promise<void> => {
    while (tails.size > 0) await Promise.allSettled([...tails.values()]);
  };

  const dispose = async (): Promise<void> => {
    disposed = true;
    await drain();
    active.clear();
    blocked.clear();
  };

  return { cancelSession, dispose, drain, processEvent };
}

export type AttachedRootRuntime = ReturnType<typeof createAttachedRootRuntime>;
