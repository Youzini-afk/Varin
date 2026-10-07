import { randomUUID } from "node:crypto";
import type {
  Thread,
  ThreadParent,
  ThreadRun,
  ThreadMessagePeer,
} from "@varin/protocol";
import { summarizeRetrievalEvidence } from "@varin/protocol";
import type { ObservationCursorEntry, ObservationCursorStore, PendingObservation } from "./observation-cursors.js";
import type { ThreadRegistry } from "./thread-registry.js";
import type { Zone2Thread, Zone2Threads } from "./zone2.js";

interface Zone2ThreadCursor {
  eventSeqByThread: Record<string, number>;
  materialByThread: Record<string, string | null>;
  messageIdsByThread: Record<string, string[]>;
  resultByThread: Record<string, string | null>;
  overlapWarning: string | null;
}

export interface Zone2ThreadProjectionOptions {
  cursors: ObservationCursorStore;
  registry: ThreadRegistry;
}

/**
 * Explicit delivery acknowledgement for historical thread material. A
 * session has at most one pending preparation; a newer preparation aborts the
 * older one so a failed/replaced request cannot advance its cursor later.
 */
export function createZone2DeliveryService() {
  const pending = new Map<string, PendingObservation<Zone2Threads>>();
  const deliveryIds = new Map<string, string>();
  return {
    reconcile(sessionId: string, retainedRefs: ReadonlySet<string>): void {
      const observation = pending.get(sessionId);
      if (observation && retainedRefs.has(observation.observationRef)) {
        // The response was persisted in Pi history but the explicit ACK was
        // lost. Treat that retained receipt as delivery before replacing the
        // pending preparation.
        observation.commit();
      } else {
        observation?.abort();
      }
      pending.delete(sessionId);
      deliveryIds.delete(sessionId);
    },
    setPending(sessionId: string, observation: PendingObservation<Zone2Threads>): string {
      pending.get(sessionId)?.abort();
      const deliveryId = randomUUID();
      pending.set(sessionId, observation);
      deliveryIds.set(sessionId, deliveryId);
      return deliveryId;
    },
    confirm(sessionId: string, deliveryId: string): boolean {
      if (deliveryIds.get(sessionId) !== deliveryId) return false;
      const observation = pending.get(sessionId);
      pending.delete(sessionId);
      deliveryIds.delete(sessionId);
      return observation?.commit() ?? false;
    },
    abort(sessionId: string): void {
      pending.get(sessionId)?.abort();
      pending.delete(sessionId);
      deliveryIds.delete(sessionId);
    },
    dispose(): void {
      for (const observation of pending.values()) observation.abort();
      pending.clear();
      deliveryIds.clear();
    },
  };
}

const priority = (thread: Thread): number => {
  if (thread.attention === "user" || thread.attention === "permission" || thread.attention === "thread") return 0;
  if (thread.attention === "stalled" || thread.attention === "looping") return 1;
  if (thread.lifecycle === "active" || thread.lifecycle === "queued") return 2;
  if (thread.integration === "conflict") return 3;
  return 4;
};

const addressedMessages = (thread: Thread, observer: ThreadMessagePeer) => (thread.messages ?? [])
  .filter((message) => message.direction === "in"
    && (message.status === "delivered" || message.status === "resolved")
    && message.to.kind === observer.kind && message.to.id === observer.id
    && !(message.from.kind === observer.kind && message.from.id === observer.id));

const projectThread = (thread: Thread, activeRun: ThreadRun | null, observer: ThreadMessagePeer): Zone2Thread => ({
  id: thread.id,
  brief: thread.brief,
  preset: thread.preset,
  lifecycle: thread.lifecycle,
  attention: thread.attention,
  integration: thread.integration,
  waitingFor: thread.waitingFor?.text ?? null,
  steps: activeRun?.steps ?? 0,
  workerState: activeRun?.workerState ?? null,
  outcome: activeRun?.outcome ?? null,
  lastActivityAt: activeRun?.lastActivityAt ?? thread.updatedAt,
  lastToolCall: activeRun?.lastToolCall?.name ?? null,
  diffStats: thread.diffStats,
  conclusion: thread.report?.conclusion ?? null,
  evidenceSummary: thread.report?.evidence
    ? summarizeRetrievalEvidence(thread.report.evidence)
    : thread.pendingEvidence
      ? summarizeRetrievalEvidence(thread.pendingEvidence)
      : null,
  deviations: [...(thread.report?.deviations ?? [])],
  ...(thread.messages
    ? {
        messages: addressedMessages(thread, observer)
          .map((message) => ({
            id: message.id,
            from: `${message.from.kind} ${message.from.id}`,
            kind: message.kind,
            text: message.text,
            at: message.at,
          })),
      }
    : {}),
  ...(thread.resultRevision === undefined ? {} : { resultRevision: thread.resultRevision }),
  mergeReady: thread.integrationBinding?.valid === false ? false : thread.integrationBinding?.mergeReady ?? null,
  ...(thread.verification ? { verification: thread.verification } : {}),
});

/** Identity of durable message/result material, excluding transient state. */
const materialParts = (thread: Thread, observer: ThreadMessagePeer): { messages: Array<[string, string]>; result: unknown | null } => {
  const messages = addressedMessages(thread, observer)
    .map((message) => [message.id, message.text] as [string, string]);
  const review = thread.verification?.review;
  const result = (observer.kind === "thread" && thread.id === observer.id)
    || (thread.resultRevision === undefined && !thread.report && (!review || review.status === "none"))
    ? null
    : {
        revision: thread.resultRevision ?? thread.report?.resultRevision ?? null,
        conclusion: thread.report?.conclusion ?? null,
        evidence: thread.report?.evidence ?? thread.pendingEvidence ?? null,
        deviations: thread.report?.deviations ?? [],
        review: review && review.status !== "none"
          ? { revision: review.resultRevision, status: review.status, conclusion: review.conclusion ?? null, error: review.error ?? null }
          : null,
      };
  return { messages, result };
};

const materialIdentity = (thread: Thread, observer: ThreadMessagePeer): string | null => {
  const parts = materialParts(thread, observer);
  if (parts.messages.length === 0 && parts.result === null) return null;
  return JSON.stringify(parts);
};

const computeOverlapWarning = (snapshots: Array<{ thread: Thread; activeRun: ThreadRun | null }>): string | null => {
  const threadPaths = new Map<string, string[]>();
  for (const { thread } of snapshots) {
    if (thread.lifecycle === "archived" || thread.integration === "merged") continue;
    const paths = new Set<string>();
    const scope = thread.manifest.scope;
    if (scope && Array.isArray(scope)) {
      for (const s of scope) paths.add(s);
    }
    if (thread.report?.changedFiles) {
      for (const f of thread.report.changedFiles) paths.add(f);
    }
    if (thread.worktree?.changedFiles) {
      for (const f of thread.worktree.changedFiles) paths.add(f);
    }
    if (paths.size > 0) {
      threadPaths.set(thread.id, Array.from(paths));
    }
  }

  const warnings: string[] = [];
  const threadIds = Array.from(threadPaths.keys());
  for (let i = 0; i < threadIds.length; i++) {
    for (let j = i + 1; j < threadIds.length; j++) {
      const idA = threadIds[i]!;
      const idB = threadIds[j]!;
      const pathsA = threadPaths.get(idA)!;
      const pathsB = new Set(threadPaths.get(idB)!);
      const common = pathsA.filter((p) => pathsB.has(p));
      if (common.length > 0) {
        warnings.push(
          `${idA} and ${idB} overlap on ${common.slice(0, 3).join(", ")}${common.length > 3 ? ` (+${common.length - 3} more)` : ""}`,
        );
      }
    }
  }

  return warnings.length > 0 ? warnings.join("; ") : null;
};

/**
 * Model input carries changed facts, not a repeated UI dashboard. The cursor
 * is separate from the explicit `threads` tool and advances only for the
 * items the formatter actually presented.
 */
const zone2ThreadTask = (
  options: Zone2ThreadProjectionOptions,
  workspaceId: string,
  parent: ThreadParent,
  observer: ThreadMessagePeer,
  prepared?: (cursor: Zone2ThreadCursor, previous: Zone2ThreadCursor | undefined) => void,
  materialOnly = false,
  family?: { rootIds: Set<string>; sessionParent: ThreadParent },
) => async (previous: ObservationCursorEntry<Zone2ThreadCursor> | null): Promise<{ cursor: Zone2ThreadCursor; result: Zone2Threads }> => {
  // BC0: every bot-root in the scope shares one family — a replaced entry
  // session must still see work dispatched under its predecessor.
  const snapshots = (family
    ? (await options.registry.listWorkspaceThreadSnapshots(workspaceId)).filter(({ thread }) => (
      !thread.hidden
      && ((thread.parent.kind === "thread" && family.rootIds.has(thread.parent.id))
        || (thread.parent.kind === family.sessionParent.kind && thread.parent.id === family.sessionParent.id))
    ))
    : await options.registry.listThreadSnapshots(workspaceId, parent))
    .filter(({ thread }) => observer.kind !== "thread" || thread.id !== observer.id);
  // The observer's inbound messages are already persisted through Pi's
  // idempotent notification/continuation path. Do not replay its own ledger.
  const eventSeqByThread = Object.fromEntries(snapshots.map(({ thread }) => [thread.id, thread.eventSeq]));
  const materialByThread = Object.fromEntries(snapshots.map(({ thread }) => [thread.id, materialIdentity(thread, observer)]));
  const messageIdsByThread = Object.fromEntries(snapshots.map(({ thread }) => [
    thread.id,
    materialParts(thread, observer).messages.map(([id]) => id),
  ]));
  const resultByThread = Object.fromEntries(snapshots.map(({ thread }) => {
    const result = materialParts(thread, observer).result;
    return [thread.id, result === null ? null : JSON.stringify(result)];
  }));
  const selected = snapshots.filter(({ thread }) => materialOnly
    ? materialByThread[thread.id] !== null
      && materialByThread[thread.id] !== (previous?.value.materialByThread?.[thread.id] ?? null)
    : previous?.value.eventSeqByThread[thread.id] !== thread.eventSeq)
    .toSorted((left, right) => (
      priority(left.thread) - priority(right.thread)
      || right.thread.updatedAt.localeCompare(left.thread.updatedAt)
      || left.thread.id.localeCompare(right.thread.id)
    ));
  const overlapWarning = computeOverlapWarning(snapshots);
  const cursor: Zone2ThreadCursor = {
    eventSeqByThread,
    materialByThread,
    messageIdsByThread,
    resultByThread,
    overlapWarning,
  };
  prepared?.(cursor, previous?.value);
  return {
    cursor,
    result: {
      status: "ready",
      items: selected.map(({ thread, activeRun }) => {
        const item = projectThread(thread, activeRun, observer);
        if (!materialOnly) return item;
        const previousMessages = new Set(previous?.value.messageIdsByThread?.[thread.id] ?? []);
        const currentMessages = item.messages ?? [];
        item.materialMessageIds = currentMessages
          .map((message) => message.id)
          .filter((id) => !previousMessages.has(id));
        item.includeResult = resultByThread[thread.id] !== (previous?.value.resultByThread?.[thread.id] ?? null);
        return item;
      }),
      ...(overlapWarning !== (previous?.value.overlapWarning ?? null)
        ? { overlapWarning: overlapWarning ?? "previous path overlap cleared" } : {}),
    },
  };
};

const zone2Scope = async (
  options: Zone2ThreadProjectionOptions,
  input: { sessionId: string; scopeId: string },
): Promise<{
  objectId: string;
  parent: ThreadParent;
  observer: ThreadMessagePeer;
  scopeId: string;
  family?: { rootIds: Set<string>; sessionParent: ThreadParent };
}> => {
  const activeBinding = typeof options.registry.getSessionBinding === "function"
    ? await options.registry.getSessionBinding(input.sessionId)
    : null;
  const binding = activeBinding ?? (typeof options.registry.resolveSessionOwner === "function"
    ? await options.registry.resolveSessionOwner(input.sessionId) : null);
  if (binding) {
    const parent: ThreadParent = { kind: "thread", id: binding.threadId };
    const owner = await options.registry.getThreadById(binding.owningScopeId, binding.threadId);
    if (owner?.purpose === "bot-root") {
      const snapshots = await options.registry.listWorkspaceThreadSnapshots(binding.owningScopeId);
      const rootIds = new Set(snapshots
        .filter(({ thread }) => thread.purpose === "bot-root")
        .map(({ thread }) => thread.id));
      return {
        objectId: `${binding.owningScopeId}\0bot-root-family`,
        parent,
        observer: parent,
        scopeId: binding.owningScopeId,
        family: { rootIds, sessionParent: owner.parent },
      };
    }
    return {
      objectId: `${binding.owningScopeId}\0${parent.kind}\0${parent.id}`,
      parent,
      observer: parent,
      scopeId: binding.owningScopeId,
    };
  }
  const parent: ThreadParent = { kind: "session", id: input.sessionId };
  return { objectId: `${input.scopeId}\0${parent.kind}\0${parent.id}`, parent, observer: parent, scopeId: input.scopeId };
};

export async function projectZone2Threads(
  options: Zone2ThreadProjectionOptions,
  input: { sessionId: string; scopeId: string },
): Promise<Zone2Threads> {
  const scope = await zone2Scope(options, input);
  return options.cursors.observe<Zone2ThreadCursor, Zone2Threads>(
    input.sessionId,
    "zone2-threads",
    scope.objectId,
    zone2ThreadTask(options, scope.scopeId, scope.parent, scope.observer, undefined, false, scope.family),
  );
}

export async function prepareZone2Threads(
  options: Zone2ThreadProjectionOptions,
  input: { sessionId: string; scopeId: string },
): Promise<PendingObservation<Zone2Threads> & {
  commitPresented(ids: ReadonlySet<string>, overlapPresented: boolean): boolean;
}> {
  const scope = await zone2Scope(options, input);
  let next!: Zone2ThreadCursor;
  let previous: Zone2ThreadCursor | undefined;
  const pending = await options.cursors.prepare(
    input.sessionId,
    "zone2-threads",
    scope.objectId,
    zone2ThreadTask(options, scope.scopeId, scope.parent, scope.observer, (cursor, baseline) => {
      next = cursor;
      previous = baseline;
    }, true, scope.family),
  );
  return {
    ...pending,
    commitPresented(ids, overlapPresented) {
      // Budget omission is not delivery. Keep each unpresented fact pending.
      for (const id of Object.keys(next.materialByThread)) {
        if (ids.has(id)) continue;
        const old = previous?.materialByThread?.[id];
        if (old === undefined) delete next.materialByThread[id];
        else next.materialByThread[id] = old;
        const oldMessages = previous?.messageIdsByThread?.[id];
        if (oldMessages === undefined) delete next.messageIdsByThread[id];
        else next.messageIdsByThread[id] = [...oldMessages];
        const oldResult = previous?.resultByThread?.[id];
        if (oldResult === undefined) delete next.resultByThread[id];
        else next.resultByThread[id] = oldResult;
      }
      if (!overlapPresented) next.overlapWarning = previous?.overlapWarning ?? null;
      return pending.commit();
    },
  };
}
