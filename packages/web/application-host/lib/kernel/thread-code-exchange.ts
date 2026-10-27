/** Read the original exchange journal and its retained objects; no live-file preview or write. */
import type {
  ThreadCodeExchange,
  ThreadCodeExchangeRequest,
  ThreadExchangeFileContent,
  ThreadIdentity,
} from "@varin/application-client";
import type { RecoveryDurableOperationPort } from "../recovery/journal-engine.js";
import type {
  RecoveryFileStore,
  RecoveryState,
} from "../recovery/journal-files.js";
import { projectIntegrationOperation } from "../recovery/durable-file-operation.js";
import { inspectDocumentBytes } from "../documents/inspect.js";
import type { IntegrationTargetOwners } from "./integration-tool-owner.js";
import type { ManagedSourceCodeExchangeRequest } from "../harness/managed-remote-types.js";

type JournalOwners = {
  journal: Pick<RecoveryDurableOperationPort, "getOperation">;
  files: Pick<RecoveryFileStore, "readContent">;
};
export async function readExchangeJournal(
  owners: JournalOwners,
  input: {
    workspaceId: string;
    operationId: string;
    threadId: string;
    runId: string;
    path?: string;
  },
  signal?: AbortSignal,
): Promise<ThreadCodeExchange> {
  signal?.throwIfAborted();
  const id = `integration:${input.operationId}`;
  const record = await owners.journal.getOperation(input.workspaceId, id);
  if (!record) throw new Error("The original file exchange is unavailable");
  const journal = projectIntegrationOperation(id, record);
  const binding = journal.operationBinding;
  if (
    (binding?.kind !== "code_exchange" && binding?.kind !== "external_code_exchange") ||
    binding.operationId !== input.operationId ||
    binding.parentThreadId !== input.threadId ||
    binding.parentRunId !== input.runId ||
    binding.result.workspaceId !== input.workspaceId
  )
    throw new Error("File exchange does not belong to the original sender");
  const paths = [
    ...new Set([
      ...Object.keys(journal.targets),
      ...Object.keys(journal.retryBinding?.childStates ?? {}),
      ...journal.conflictPaths,
    ]),
  ].sort();
  const result: ThreadCodeExchange = {
    operationId: input.operationId,
    sourceThreadId: binding.childThreadId,
    targetThreadId: binding.targetThreadId,
    state: journal.state,
    ...(journal.applyCanonicalRoot
      ? { targetDirectory: journal.applyCanonicalRoot }
      : {}),
    files: paths.map((path) => ({
      path,
      target: journal.targetKinds[path] ?? "disk",
      state: journal.compensatedPaths.includes(path)
        ? "compensated"
        : journal.needsAttentionPaths.includes(path)
          ? "needs_attention"
          : journal.conflictPaths.includes(path)
            ? "conflict"
            : journal.appliedPaths.includes(path)
              ? "applied"
              : "unchanged",
    })),
  };
  if (input.path !== undefined) {
    const target = journal.targets[input.path];
    // Conflicts retain their compared versions even when they never reached file apply.
    const before =
      target?.expected ?? journal.retryBinding?.parentStates[input.path];
    const after =
      target?.target ?? journal.retryBinding?.childStates[input.path];
    if (!paths.includes(input.path) || !before || !after)
      throw new Error("The original file versions are unavailable");
    const content = async (
      state: RecoveryState,
    ): Promise<ThreadExchangeFileContent> => {
      signal?.throwIfAborted();
      if (state.kind === "symlink")
        return { kind: "symlink", target: state.symlinkTarget };
      if (state.kind !== "regular-file") return { kind: state.kind };
      if (!owners.files.readContent)
        throw new Error("The original file content reader is unavailable");
      const bytes = await owners.files.readContent(
        {
          authorityId: "kernel",
          workspaceId: input.workspaceId,
          canonicalRoot: journal.applyCanonicalRoot ?? "",
          filesystemProfile:
            process.platform === "win32"
              ? "windows-local"
              : `${process.platform}-local`,
        },
        state,
      );
      signal?.throwIfAborted();
      const decoded = inspectDocumentBytes(bytes);
      return decoded.kind === "text"
        ? { kind: "text", text: decoded.content }
        : { kind: "binary", byteLength: bytes.byteLength };
    };
    const [oldFile, newFile] = await Promise.all([
      content(before),
      content(after),
    ]);
    result.file = { path: input.path, before: oldFile, after: newFile };
  }
  return result;
}

export type ThreadCodeExchangeReader = (
  identity: ThreadIdentity,
  request: ThreadCodeExchangeRequest,
  signal?: AbortSignal,
) => Promise<ThreadCodeExchange>;
export function createThreadCodeExchangeReader(
  owners: JournalOwners & Pick<IntegrationTargetOwners, "runtime">,
): ThreadCodeExchangeReader {
  return async (identity, request, suppliedSignal) => {
    const signal = suppliedSignal ?? new AbortController().signal;
    const family = await owners.runtime.familyList(
      {
        callerThreadId: identity.threadId,
        includeSelf: true,
        scope: "all",
        query: request.senderThreadId,
      },
      signal,
    );
    if (
      !family.members.some(
        (member) =>
          member.threadId === request.senderThreadId &&
          member.branches.some(
            (branch) => branch.branchId === request.senderBranchId,
          ),
      )
    )
      throw new Error("Message sender is outside this task family");
    const message = await owners.runtime.getMessage(
      {
        threadId: request.senderThreadId,
        branchId: request.senderBranchId,
        messageId: request.messageId,
      },
      signal,
    );
    if (
      message.actor.kind !== "agent" ||
      message.senderThreadId !== request.senderThreadId ||
      message.senderBranchId !== request.senderBranchId
    )
      throw new Error("The message is not an Agent file exchange");
    const operation = await owners.runtime.operation(
      message.actor.operationId,
      signal,
    );
    if (
      !["submit_code", "update"].includes(operation.executor ?? "") ||
      operation.run_id !== message.actor.runId
    )
      throw new Error("The message is not an original file exchange receipt");
    const run = await owners.runtime.run(operation.run_id, signal);
    const launch = await owners.runtime.launch(run.id, signal);
    const source = launch?.selection.source;
    if (
      !launch ||
      !source ||
      run.thread_id !== message.senderThreadId ||
      run.branch_id !== message.senderBranchId
    )
      throw new Error("The original exchange source is unavailable");
    const input = {
      workspaceId: source.workspace_id,
      operationId: operation.id,
      threadId: run.thread_id,
      runId: run.id,
      ...(request.path === undefined ? {} : { path: request.path }),
    };
    if (source.resource_owner.kind !== "managed_host")
      return readExchangeJournal(owners, input, signal);
    const service = await owners.runtime.managedSource(
      source.resource_owner,
      signal,
    );
    return service.codeExchange(
      {
        coordinatorHostId: owners.runtime.coordinatorHostId,
        source,
        runId: run.id,
        threadId: run.thread_id,
        operationId: operation.id,
        ...(request.path === undefined ? {} : { path: request.path }),
      },
      signal,
    );
  };
}
export function createManagedCodeExchangeReader(owners: JournalOwners) {
  return async (
    input: ManagedSourceCodeExchangeRequest,
    signal?: AbortSignal,
  ) => {
    return readExchangeJournal(
      owners,
      {
        workspaceId: input.source.workspace_id,
        threadId: input.threadId,
        runId: input.runId,
        operationId: input.operationId,
        ...(input.path === undefined ? {} : { path: input.path }),
      },
      signal,
    );
  };
}
