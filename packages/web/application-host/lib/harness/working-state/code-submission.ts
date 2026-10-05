import { createHash, randomUUID } from "node:crypto";
import type { Thread, ThreadCodeSubmission, ThreadSubmitCodeParams } from "@varin/protocol";
import type { ThreadRegistry } from "../thread-registry.js";
import { stableIdentityJson } from "../thread-registry.js";
import { normalizeThreadScopePath, scopePathContainedBy } from "../thread-nesting.js";
import type { IntegrationApplyResult, RecoveryState, WorkingStateRootStore, WorkspaceWorkingStateRootAccess } from "./types.js";
import { isBinaryBuffer, mergeText3Way, planThreeWayPath } from "./three-way-merge.js";

const terminal = (submission: ThreadCodeSubmission) => !["capturing", "queued", "applying"].includes(submission.status);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Fold the acknowledged source changes, retaining a later full integration and excluding recipient edits. */
export async function submittedCodeBaseline(store: WorkingStateRootStore, source: Thread, targetId: string, recipientAuthority?: string, full?: Thread["mergedSource"]): Promise<Record<string, RecoveryState>> {
  const states: Record<string, RecoveryState> = full
    ? Object.fromEntries(full.sourcePaths.map(path => [path, { kind: "missing" as const }])) : {};
  if (full) {
    const fixed = await store.readStateSlice(full.branchId, full.sourcePaths, { revision: full.resultRevision });
    if (!fixed) throw new Error("The last integrated source baseline is unavailable");
    Object.assign(states, fixed);
  }
  for (const submission of (source.codeSubmissions ?? []).toSorted((left, right) => (left.completedSequence ?? 0) - (right.completedSequence ?? 0))) {
    if (submission.fromThreadId !== source.id || submission.toThreadId !== targetId || !submission.acceptedPaths.length) continue;
    if (recipientAuthority !== undefined && submission.recipientAuthority !== recipientAuthority) continue;
    if (full?.codeReceiptIds.includes(submission.id)) continue;
    const result = await store.getResult(submission.branchId, submission.resultRevision);
    if (!result) throw new Error(`Submitted code source is unavailable: ${submission.id}`);
    for (const path of submission.acceptedPaths) {
      const baseState = result.baseStates[path] ?? { kind: "missing" as const };
      const childState = result.pathStates[path] ?? { kind: "missing" as const };
      const plan = await planThreeWayPath({ path, baseState, parentState: states[path] ?? baseState, childState,
        readContent: state => state.kind === "regular-file" ? store.getObject(state.objectHash) : Promise.resolve(null) });
      if (plan.decision === "conflict") throw new Error(`Acknowledged source changes disagree in ${path}`);
      if (plan.decision === "merge-clean" && plan.mergedText !== undefined) {
        const object = await store.putObject(Buffer.from(plan.mergedText));
        states[path] = { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength, ...(plan.mergedMode === undefined ? {} : { mode: plan.mergedMode }) };
      } else states[path] = plan.decision === "keep-parent" ? plan.parentState : childState;
    }
  }
  return states;
}

/** Select exact original/replacement snippets, then verify they are a subset of the actual source delta. */
export async function selectCodeChanges(store: WorkingStateRootStore, files: ThreadSubmitCodeParams["files"],
  base: Record<string, RecoveryState>, current: Record<string, RecoveryState>): Promise<Record<string, RecoveryState>> {
  const selected: Record<string, RecoveryState> = {};
  for (const file of files) {
    const before = base[file.path] ?? { kind: "missing" as const };
    const after = current[file.path] ?? { kind: "missing" as const };
    if (file.edits === undefined) { selected[file.path] = after; continue; }
    if (!file.edits.length) throw new Error(`No snippets selected in ${file.path}`);
    const textOf = async (state: RecoveryState): Promise<string> => {
      if (state.kind === "missing") return "";
      if (state.kind !== "regular-file") throw new Error(`Snippet selection needs a text file: ${file.path}`);
      const bytes = await store.getObject(state.objectHash);
      if (!bytes || isBinaryBuffer(bytes)) throw new Error(`Snippet source is not readable UTF-8 text: ${file.path}`);
      return bytes.toString("utf8");
    };
    const original = await textOf(before);
    const actual = await textOf(after);
    const ranges = file.edits.map(edit => {
      if (!edit.before && original) throw new Error(`Include original context for an insertion in ${file.path}`);
      const offset = original.indexOf(edit.before);
      if (offset < 0 || (edit.before && original.indexOf(edit.before, offset + 1) >= 0)) throw new Error(`Original snippet is missing or ambiguous in ${file.path}`);
      return { offset, end: offset + edit.before.length, text: edit.after };
    }).sort((left, right) => left.offset - right.offset);
    for (let index = 1; index < ranges.length; index++) if (ranges[index]!.offset <= ranges[index - 1]!.offset
      || ranges[index]!.offset < ranges[index - 1]!.end) throw new Error(`Selected snippets overlap in ${file.path}`);
    let candidate = original;
    for (const range of ranges.toReversed()) candidate = candidate.slice(0, range.offset) + range.text + candidate.slice(range.end);
    const subset = mergeText3Way(original, actual, candidate);
    if (!subset.clean || subset.text !== actual) throw new Error(`Selected snippet does not match the current source change in ${file.path}`);
    const object = await store.putObject(Buffer.from(candidate, "utf8"));
    selected[file.path] = { kind: "regular-file", objectHash: object.hash, byteLength: object.byteLength,
      ...(after.kind === "regular-file" && after.mode !== undefined ? { mode: after.mode } : {}) };
  }
  return selected;
}

/** Host orchestration only; all content and writes remain in native WorkingState/Integration. */
export function createCodeSubmissionRuntime(options: {
  registry: ThreadRegistry;
  workingStates: WorkspaceWorkingStateRootAccess;
  capture(scopeId: string, source: Thread, target: Thread, paths: string[], store: WorkingStateRootStore, signal?: AbortSignal, draftBaselineId?: string): Promise<{
    base: Record<string, RecoveryState>; current: Record<string, RecoveryState>;
  }>;
  apply(scopeId: string, target: Thread, submission: ThreadCodeSubmission, signal: AbortSignal): Promise<IntegrationApplyResult | null>;
  notify(scopeId: string, thread: Thread, submission: ThreadCodeSubmission): Promise<void>;
  onError(error: unknown): void;
  serializeRecipient?<T>(scopeId: string, targetId: string, operation: () => Promise<T>): Promise<T>;
  recipientAuthority?(scopeId: string, target: Thread): Promise<string>;
  baseline?(scopeId: string, store: WorkingStateRootStore, source: Thread, target: Thread, authority?: string): Promise<Record<string, RecoveryState>>;
}) {
  const active = new Map<string, Promise<void>>();
  const captureOwner = randomUUID();
  const shutdown = new AbortController();
  let disposed = false;
  const launch = (scopeId: string, submission: ThreadCodeSubmission) => {
    const key = `${scopeId}:${submission.id}`;
    if (disposed || active.has(key) || submission.status === "capturing") return;
    const task = Promise.resolve().then(async () => {
      const source = await options.registry.getThreadById(scopeId, submission.fromThreadId);
      const target = await options.registry.getThreadById(scopeId, submission.toThreadId);
      if (!source || !target) return;
      let receipt = source.codeSubmissions?.find(entry => entry.id === submission.id) ?? submission;
      const finish = async () => {
        if (terminal(receipt)) return;
        try {
          if (source.deletion || target.deletion || target.lifecycle === "archived") throw new Error("Code submission party is being removed or archived");
          receipt = await options.registry.recordCodeSubmission(scopeId, { ...receipt, status: "applying" });
          const result = await options.apply(scopeId, target, receipt, shutdown.signal);
          if (!result) { await options.registry.recordCodeSubmission(scopeId, { ...receipt, status: "queued" }); return; }
          const conflicts = [...new Set([...result.conflictPaths, ...(result.needsAttentionPaths ?? []), ...(result.preview?.unavailablePaths ?? [])])];
          const pending = result.preview?.paths.filter(path => path.target === "surface"
            && !["surface-applied", "skipped-identical"].includes(path.phase)).map(path => path.path) ?? [];
          const complete = result.status === "applied" && !conflicts.length && !pending.length;
          const accepted = ["applied", "conflict"].includes(result.status)
            ? receipt.paths.filter(file => !conflicts.includes(file) && !pending.includes(file)) : [];
          receipt = await options.registry.recordCodeSubmission(scopeId, { ...receipt,
            status: complete ? "applied" : result.status === "conflict" || conflicts.length ? "conflict" : "failed",
            appliedPaths: result.appliedPaths, acceptedPaths: accepted, conflictPaths: [...new Set([...conflicts, ...pending])],
            operationId: result.operationId, completedAt: new Date().toISOString(),
            ...(complete ? {} : { error: result.text }) });
        } catch (error) {
          if (disposed) return;
          receipt = await options.registry.recordCodeSubmission(scopeId, { ...receipt, status: "failed", completedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error) });
        }
      };
      if (options.serializeRecipient) await options.serializeRecipient(scopeId, target.id, finish);
      else await finish();
      if (!terminal(receipt) || disposed) return;
      if (!receipt.notificationsPending) return;
      await Promise.all([options.notify(scopeId, source, receipt), options.notify(scopeId, target, receipt)]);
      await options.registry.recordCodeSubmission(scopeId, { ...receipt, notificationsPending: false });
    }).catch(options.onError).finally(() => { active.delete(key); });
    active.set(key, task);
  };
  return {
    submit: async (scopeId: string, source: Thread, target: Thread, input: ThreadSubmitCodeParams, id: string, signal?: AbortSignal, draftBaselineId?: string): Promise<ThreadCodeSubmission> => {
      if (!id.trim() || source.id === target.id) throw new Error("Select another task thread and a nonempty submission identity");
      if (!Array.isArray(input.files) || !input.files.length) throw new Error("Select files or snippets to submit");
      const files = input.files.map(file => {
        if (!file || typeof file.path !== "string") throw new Error("Selected code needs a relative file path");
        const path = normalizeThreadScopePath(file.path);
        if (!path || path === ".") throw new Error("Select files, not a workspace root");
        for (const party of [source, target]) if (party.manifest.scope.length && !party.manifest.scope.some(root => scopePathContainedBy(root, path))) throw new Error(`Selected path is outside a thread's authorized scope: ${path}`);
        if (file.edits !== undefined && (!Array.isArray(file.edits) || file.edits.some(edit => !edit || typeof edit.before !== "string" || typeof edit.after !== "string"))) throw new Error("Snippets need original and replacement text");
        return { ...file, path };
      });
      if (new Set(files.map(file => file.path)).size !== files.length) throw new Error("Combine selections for the same file");
      const fingerprint = digest(stableIdentityJson({ from: source.id, to: target.id, files }));
      const freshSource = await options.registry.getThreadById(scopeId, source.id);
      const existing = freshSource?.codeSubmissions?.find(entry => entry.id === id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error("submissionId is already bound to another selected change");
        launch(scopeId, existing); return existing;
      }
      const branchId = `code-${digest(`${scopeId}:${id}:${fingerprint}`)}`;
      const recipientAuthority = await options.recipientAuthority?.(scopeId, target);
      await options.registry.recordCodeSubmission(scopeId, { id, fingerprint, fromThreadId: source.id, toThreadId: target.id, branchId, resultRevision: 0,
        paths: files.map(file => file.path), status: "capturing", captureOwner, ...(recipientAuthority ? { recipientAuthority } : {}), appliedPaths: [], acceptedPaths: [], conflictPaths: [], notificationsPending: true, createdAt: new Date().toISOString() });
      let record: ThreadCodeSubmission;
      try { record = await options.workingStates.withBranchStore(scopeId, "selected-code-capture", async store => {
        const currentSource = await options.registry.getThreadById(scopeId, source.id);
        const concurrent = currentSource?.codeSubmissions?.find(entry => entry.id === id);
        if (concurrent && concurrent.status !== "capturing") {
          if (concurrent.fingerprint !== fingerprint) throw new Error("submissionId is already bound to another selected change");
          return concurrent;
        }
        const paths = files.map(file => file.path);
        const captured = await options.capture(scopeId, source, target, paths, store, signal, draftBaselineId);
        const base = { ...captured.base, ...await (options.baseline?.(scopeId, store, currentSource ?? source, target, recipientAuthority)
          ?? submittedCodeBaseline(store, currentSource ?? source, target.id, recipientAuthority)) };
        const selected = await selectCodeChanges(store, files, base, captured.current);
        signal?.throwIfAborted();
        const orphan = await store.getBranchRoot(branchId);
        if (orphan) await store.deleteBranch(branchId);
        const branch = await store.createBranch(scopeId, branchId, Object.fromEntries(paths.map(file => [file, base[file] ?? { kind: "missing" as const }])));
        try {
          const committed = await store.commitVirtualWrites(branchId, branch.writeRevision, selected);
          if (committed.status !== "committed") throw new Error("Selected code changed during capture");
          const result = await store.publishHeadResult(branchId);
          signal?.throwIfAborted();
          return await options.registry.recordCodeSubmission(scopeId, { id, fingerprint, fromThreadId: source.id, toThreadId: target.id,
            branchId, resultRevision: result.resultRevision, paths: result.changedPaths, status: "queued",
            ...(recipientAuthority ? { recipientAuthority } : {}),
            appliedPaths: [], acceptedPaths: [], conflictPaths: [], notificationsPending: true, createdAt: new Date().toISOString() });
        } catch (error) {
          const persisted = (await options.registry.getThreadById(scopeId, source.id))?.codeSubmissions?.find(entry => entry.id === id);
          if (!persisted || persisted.resultRevision === 0) await store.deleteBranch(branchId);
          throw error;
        }
      }); } catch (error) {
        const pending = (await options.registry.getThreadById(scopeId, source.id))?.codeSubmissions?.find(entry => entry.id === id);
        if (pending?.status === "capturing") {
          const failed = await options.registry.recordCodeSubmission(scopeId, { ...pending, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
          launch(scopeId, failed);
        }
        throw error;
      }
      launch(scopeId, record); return record;
    },
    reconcile: async () => {
      if (disposed) return;
      for (const scopeId of await options.registry.listWorkspaceIds()) for (const { thread } of await options.registry.listWorkspaceThreadSnapshots(scopeId)) {
        for (const submission of thread.codeSubmissions ?? []) if (submission.fromThreadId === thread.id) {
          if (submission.status === "capturing") {
            if (submission.captureOwner === captureOwner) continue;
            await options.workingStates.withBranchStore(scopeId, "discard-interrupted-code-capture", store => store.deleteBranch(submission.branchId));
            const failed = await options.registry.recordCodeSubmission(scopeId, { ...submission, status: "failed", completedAt: new Date().toISOString(), error: "Code capture was interrupted before acceptance; submit the current selection with a new identity" });
            launch(scopeId, failed);
          } else if (!terminal(submission) || submission.notificationsPending) launch(scopeId, submission);
        }
      }
    },
    observe: (scopeId: string, thread: Thread) => {
      for (const submission of thread.codeSubmissions ?? []) if (!terminal(submission)) launch(scopeId, submission);
    },
    retire: async (scopeId: string, threadIds: string[]) => {
      const records = new Map<string, ThreadCodeSubmission>();
      for (const id of threadIds) for (const submission of (await options.registry.getThreadById(scopeId, id))?.codeSubmissions ?? []) records.set(submission.id, submission);
      await Promise.allSettled([...records.keys()].flatMap(id => { const task = active.get(`${scopeId}:${id}`); return task ? [task] : []; }));
      for (const entry of records.values()) {
        const current = (await options.registry.getThreadById(scopeId, entry.fromThreadId))?.codeSubmissions?.find(record => record.id === entry.id);
        if (!current || terminal(current)) continue;
        const receipt = await options.registry.recordCodeSubmission(scopeId, { ...current, status: "failed", error: "A code submission party was deleted", completedAt: new Date().toISOString() });
        launch(scopeId, receipt);
      }
    },
    dispose: async () => { disposed = true; shutdown.abort(); await Promise.allSettled(active.values()); },
  };
}
