import path from "node:path";
import type {
  ThreadChildCheckProjection,
  ThreadParentCheckProjection,
  ThreadReviewProjection,
  ThreadVerificationCommandFact,
  ThreadVerificationProjection,
} from "@varin/protocol";
import type {
  CommandVerificationRecord,
  ParentVerificationBundle,
  ResultReviewRecord,
  ResultVerificationBundle,
} from "./types.js";


export const cwdUnderRoot = (cwd: string, root: string): boolean => {
  const resolvedCwd = path.resolve(cwd).replace(/\\/g, "/").toLowerCase();
  const resolvedRoot = path.resolve(root).replace(/\\/g, "/").toLowerCase();
  return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}/`);
};

export const inputChangedDuringCommand = (record: {
  startTreeHash?: string;
  endTreeHash?: string;
}): boolean | null => {
  if (record.startTreeHash === undefined || record.endTreeHash === undefined) return null;
  return record.startTreeHash !== record.endTreeHash;
};

export const relateCommandToPublish = (
  record: Pick<CommandVerificationRecord, "cwd" | "runId" | "endedAt">,
  context: {
    worktreePath?: string;
    runId: string;
    publishedAt: number;
    startTreeHash?: string;
    endTreeHash?: string;
    resultTreeHash?: string;
  },
): CommandVerificationRecord["relationToPublished"] => {
  if (!context.worktreePath || !cwdUnderRoot(record.cwd, context.worktreePath)) return "unbound";
  if (record.runId !== context.runId) return "uncertain";
  if (record.endedAt > context.publishedAt) return "uncertain";
  if (!context.startTreeHash || !context.endTreeHash || !context.resultTreeHash) return "uncertain";
  if (context.startTreeHash !== context.endTreeHash || context.endTreeHash !== context.resultTreeHash) return "uncertain";
  return "same-run-matching-result";
};

export const bindCommandsToPublishedResult = (input: {
  branchId: string;
  resultRevision: number;
  runId: string;
  worktreePath?: string;
  publishedAt?: number;
  resultTreeHash?: string;
  commands: Array<Omit<CommandVerificationRecord, "relationToPublished" | "inputChangedDuringRun">>;
}): ResultVerificationBundle => {
  const publishedAt = input.publishedAt ?? Date.now();
  const checks: CommandVerificationRecord[] = input.commands.map((command) => {
    const relation = relateCommandToPublish(command, {
      runId: input.runId,
      publishedAt,
      ...(command.inputIdentity.startTreeHash ? { startTreeHash: command.inputIdentity.startTreeHash } : {}),
      ...(command.inputIdentity.endTreeHash ? { endTreeHash: command.inputIdentity.endTreeHash } : {}),
      ...(input.resultTreeHash ? { resultTreeHash: input.resultTreeHash } : {}),
      ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    });
    const changed = inputChangedDuringCommand(command.inputIdentity);
    return {
      id: command.id,
      runId: command.runId,
      command: command.command,
      cwd: command.cwd,
      ...(command.envSummary ? { envSummary: command.envSummary } : {}),
      ...(command.commandRunId ? { commandRunId: command.commandRunId } : {}),
      startedAt: command.startedAt,
      endedAt: command.endedAt,
      exitCode: command.exitCode,
      cancelled: command.cancelled,
      ...(command.outputHandle ? { outputHandle: command.outputHandle } : {}),
      ...(command.outputPreview ? { outputPreview: command.outputPreview } : {}),
      actor: command.actor,
      bindingGeneration: command.bindingGeneration,
      inputIdentity: command.inputIdentity.kind === "tree"
        ? { ...command.inputIdentity, branchId: command.inputIdentity.branchId ?? input.branchId }
        : command.inputIdentity,
      inputChangedDuringRun: changed,
      relationToPublished: relation,
    };
  });
  const attached = checks.filter((check) => check.relationToPublished === "same-run-matching-result");
  return {
    resultRevision: input.resultRevision,
    branchId: input.branchId,
    ...(input.resultTreeHash ? { resultTreeHash: input.resultTreeHash } : {}),
    recordedAt: publishedAt,
    binding: attached.length > 0 ? "bound" : "uncertain",
    bindingReason: attached.length > 0
      ? "observed command start/end and publish boundaries matched the fixed branch identity (base plus tracked/non-ignored delta and explicit capture scopes)"
      : "no completed same-run command had matching observed boundary identities for this published result",
    checks,
  };
};

const commandFact = (check: CommandVerificationRecord): ThreadVerificationCommandFact => ({
  command: check.command,
  cwd: check.cwd,
  exitCode: check.exitCode,
  cancelled: check.cancelled,
  relation: check.relationToPublished,
  inputChanged: check.inputChangedDuringRun,
  ...(check.outputHandle ? { outputHandle: check.outputHandle } : {}),
});

const allExitedZero = (checks: CommandVerificationRecord[]): boolean | null => {
  if (checks.length === 0) return null;
  return checks.every((check) => check.exitCode === 0 && !check.cancelled);
};

export const projectChildChecks = (bundle: ResultVerificationBundle | undefined): ThreadChildCheckProjection | null => {
  if (!bundle) return null;
  const proven = bundle.checks.filter((check) => check.relationToPublished === "same-run-matching-result");
  return {
    resultRevision: bundle.resultRevision,
    binding: proven.length > 0 ? "bound" : "uncertain",
    ...(proven.length > 0 && bundle.bindingReason
      ? { bindingReason: bundle.bindingReason }
      : { bindingReason: "No command record has matching observed start/end/publish boundary identities" }),
    commands: bundle.checks.map(commandFact),
    allExitedZero: allExitedZero(proven),
  };
};

export const projectParentChecks = (bundle: ParentVerificationBundle | undefined): ThreadParentCheckProjection | null => {
  if (!bundle) return null;
  const proven = bundle.checks.filter((check) => check.relationToPublished === "post-merge-matching-tree");
  const binding = bundle.binding === "bound" && proven.length === 0 ? "uncertain" : bundle.binding;
  return {
    mergedResultRevision: bundle.mergedResultRevision,
    ...(bundle.mergeOperationId ? { mergeOperationId: bundle.mergeOperationId } : {}),
    draftUnsaved: bundle.draftUnsaved,
    binding,
    ...(bundle.note ? { note: bundle.note } : {}),
    commands: bundle.checks.map(commandFact),
    allExitedZero: binding === "bound" ? allExitedZero(proven) : null,
  };
};

export const projectReview = (
  record: ResultReviewRecord | undefined,
  currentResultRevision?: number,
): ThreadReviewProjection | null => {
  if (!record) return currentResultRevision === undefined ? null : {
    resultRevision: currentResultRevision,
    status: "none",
  };
  if (currentResultRevision !== undefined && record.resultRevision !== currentResultRevision) {
    return { resultRevision: currentResultRevision, status: "none" };
  }
  return {
    resultRevision: record.resultRevision,
    status: record.status,
    ...(record.reviewThreadId ? { reviewThreadId: record.reviewThreadId } : {}),
    ...(record.reviewRunId ? { reviewRunId: record.reviewRunId } : {}),
    ...(record.conclusion ? { conclusion: record.conclusion } : {}),
    ...(record.findings ? { findings: record.findings } : {}),
    ...(record.error ? { error: record.error } : {}),
  };
};

export const projectThreadVerification = (input: {
  currentResultRevision?: number;
  child?: ResultVerificationBundle;
  parent?: ParentVerificationBundle;
  review?: ResultReviewRecord;
}): ThreadVerificationProjection => ({
  ...(input.currentResultRevision !== undefined ? { currentResultRevision: input.currentResultRevision } : {}),
  childChecks: projectChildChecks(input.child),
  parentChecks: projectParentChecks(input.parent),
  review: projectReview(input.review, input.currentResultRevision),
});
