import type { Thread, ThreadRun } from "@varin/protocol";
import type { ThreadResultHistory, ThreadResultRetentionReason } from "@varin/application-client";
import type { WorkingResult, WorkingStateRootStore } from "./types.js";

export type RetentionThreadSnapshot = { thread: Thread; activeRun: ThreadRun | null };

const referencedBytes = (result: WorkingResult): number => {
  const sizes = new Map<string, number>();
  for (const state of [...Object.values(result.baseStates), ...Object.values(result.pathStates)]) {
    if (state.kind !== "regular-file") continue;
    const previous = sizes.get(state.objectHash);
    if (previous !== undefined && previous !== state.byteLength) throw new Error("Historical content has inconsistent byte lengths");
    sizes.set(state.objectHash, state.byteLength);
  }
  return [...sizes.values()].reduce((total, bytes) => total + bytes, 0);
};

/** Called while the owning storage is leased. It never changes Registry state. */
export async function projectThreadResultHistory(input: {
  workspaceId: string;
  thread: Thread;
  snapshots: RetentionThreadSnapshot[];
  store: WorkingStateRootStore;
}): Promise<ThreadResultHistory> {
  const { thread, store, workspaceId, snapshots } = input;
  const branchId = thread.workBranchId;
  if (!branchId) return { workspaceId, threadId: thread.id, branchId: null, results: [] };
  const branch = await store.getBranchRoot(branchId);
  if (!branch) throw new Error("The Thread's working-state metadata is unavailable");
  const results = (await store.listResults(branchId)).sort((left, right) => right.resultRevision - left.resultRevision);
  const retained = new Map<number, Set<ThreadResultRetentionReason>>();
  const keep = (revision: number | undefined, reason: ThreadResultRetentionReason) => {
    if (revision === undefined) return;
    const reasons = retained.get(revision) ?? new Set<ThreadResultRetentionReason>();
    reasons.add(reason);
    retained.set(revision, reasons);
  };
  keep(branch.headRevision, "branch-head");
  const owners = snapshots.filter((snapshot) => snapshot.thread.workBranchId === branchId);
  const ownerIds = new Set(owners.map((snapshot) => snapshot.thread.id));
  for (const { thread: owner, activeRun } of owners) {
    keep(owner.resultRevision, "current-result");
    if (owner.mergedSource?.branchId === branchId) keep(owner.mergedSource.resultRevision, "integration");
    if (activeRun && (activeRun.outcome === null || activeRun.outcome === "lost")) keep(activeRun.inputRevision, "run-input");
    if (owner.verification?.review?.status === "running") keep(owner.verification.review.resultRevision, "review");
  }
  for (const snapshot of snapshots) {
    const review = snapshot.thread.reviewOf;
    if (review && ownerIds.has(review.sourceThreadId)
      && (snapshot.thread.lifecycle === "queued" || snapshot.thread.lifecycle === "active")) {
      keep(review.resultRevision, "review");
    }
  }
  // Completed operations hold their own safety/target references; undo does not
  // need the original WorkingResult. Conflicts still need their selected input.
  const operations = (await store.listDurableOperations("integration")).filter((operation) => (
    !["complete", "compensated", "aborted", "undone"].includes(String(operation.state ?? ""))
  ));
  for (const row of operations) {
    if (!row.data || typeof row.data !== "object" || Array.isArray(row.data)) throw new Error("An unfinished integration record cannot be read; history retention is unknown");
    const data = row.data as Record<string, unknown>;
    if (typeof data.threadId !== "string") throw new Error("An unfinished integration has no owning Thread");
    if (!ownerIds.has(data.threadId)) continue;
    const retry = data.retryBinding;
    if (retry && typeof retry === "object" && "branchId" in retry
      && typeof retry.branchId === "string" && retry.branchId !== branchId) continue;
    if (typeof data.resultRevision === "number" && Number.isSafeInteger(data.resultRevision) && data.resultRevision > 0) keep(data.resultRevision, "integration");
    else for (const result of results) keep(result.resultRevision, "integration");
  }
  return {
    workspaceId, threadId: thread.id, branchId,
    results: results.map((result) => ({
      resultRevision: result.resultRevision, createdAt: result.createdAt,
      changedPaths: result.changedPaths, retainedBytes: referencedBytes(result),
      protectedReasons: [...(retained.get(result.resultRevision) ?? [])],
    })),
  };
}
