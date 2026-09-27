/**
 * Review sensor — open a hidden review thread for one published result revision.
 *
 * Design: design/harness-verification.md §9.2.3
 * Plan: plan/agent-harness-plan.md §3.7
 *
 * Trigger is a published child result with a non-empty diff, not a parent
 * journaled-change scan. The review thread is created through the same
 * createThread + startRun + spawn path as dispatch, with hidden: true.
 * Input is the source brief, the stored WorkingResult diff, and optional
 * project knowledge — not the parent conversation.
 */

import type { ModelSelection, ThreadReviewFinding, ThreadVerificationProjection } from "@varin/protocol";
import type { ResolvedPreset } from "./presets.js";
import type { CreateThreadInput, Thread } from "./thread-registry.js";

export interface ReviewSensorSettings {
  enabled: boolean;
  gate: boolean;
}

export const DEFAULT_REVIEW_SENSOR_SETTINGS: ReviewSensorSettings = {
  enabled: false,
  gate: false,
};

export interface ReviewDispatchInput {
  workspaceId: string;
  source: Thread;
  resultRevision: number;
  changedPaths: readonly string[];
  reviewPreset: ResolvedPreset | null;
  settings: ReviewSensorSettings;
  formatDiff: () => Promise<string>;
  recallKnowledge?: () => Promise<string>;
  existingReview?: ThreadVerificationProjection["review"];
  createAndStart: (input: CreateThreadInput & { promptText: string }) => Promise<Thread>;
  cancelReview?: (reviewThreadId: string) => Promise<void>;
}

export interface ReviewResult {
  reviewDispatched: boolean;
  threadId?: string;
  blocking: boolean;
  skippedReason?: string;
}

const FINDING_LINE = /^(?:[-*]\s*)?(?:\[(?<sev>critical|high|medium|low|info)\]\s*)?(?:(?<file>[^\s:]+):(?<line>\d+)[:\s]+)?(?<msg>.+)$/i;

export const parseReviewFindings = (text: string, extras: readonly string[] = []): ThreadReviewFinding[] => {
  const findings: ThreadReviewFinding[] = [];
  for (const raw of [...extras, ...text.split(/\r?\n/)]) {
    const line = raw.trim();
    if (!line || /^-?\s*none\b/i.test(line) || /^conclusion\b/i.test(line) || /^unresolved\b/i.test(line)) continue;
    const match = line.match(FINDING_LINE);
    if (!match?.groups?.msg) continue;
    const message = match.groups.msg.trim();
    if (!message) continue;
    findings.push({
      severity: (match.groups.sev ?? "info").toLowerCase(),
      message,
      ...(match.groups.file ? { file: match.groups.file } : {}),
      ...(match.groups.line ? { line: Number(match.groups.line) } : {}),
    });
  }
  return findings;
};

export async function onPublishedResult(input: ReviewDispatchInput): Promise<ReviewResult> {
  const { source, resultRevision, changedPaths, reviewPreset, settings } = input;
  if (!settings.enabled) {
    return { reviewDispatched: false, blocking: false, skippedReason: "disabled" };
  }
  if (changedPaths.length === 0) {
    return { reviewDispatched: false, blocking: false, skippedReason: "empty-diff" };
  }
  if (!reviewPreset) {
    return { reviewDispatched: false, blocking: false, skippedReason: "no-review-preset" };
  }
  const current = input.existingReview;
  const inFlight = current?.status === "queued" || current?.status === "running";
  if (current && current.resultRevision === resultRevision
    && (inFlight || current.status === "completed")) {
    return { reviewDispatched: false, blocking: settings.gate && inFlight, skippedReason: "dedup" };
  }
  if (inFlight && current?.reviewThreadId && current.resultRevision !== resultRevision) {
    await input.cancelReview?.(current.reviewThreadId);
  }

  const [diff, knowledge] = await Promise.all([
    input.formatDiff(),
    input.recallKnowledge?.().catch(() => "") ?? Promise.resolve(""),
  ]);
  const promptText = [
    `Review published result ${source.id}@${resultRevision}.`,
    "You have not seen the parent conversation. Judge this revision on the task, the published diff, and the project knowledge below.",
    `Task:\n${source.brief}`,
    knowledge ? `Project knowledge:\n${knowledge}` : null,
    diff ? `Published diff:\n${diff}` : "Published diff is empty.",
    "Return a conclusion and any issues with severity and file:line when known.",
  ].filter((line): line is string => line !== null).join("\n\n");

  const thread = await input.createAndStart({
    scopeId: input.workspaceId,
    parent: source.parent,
    brief: `Review ${source.id}@${resultRevision} (${changedPaths.length} files)`,
    preset: reviewPreset.id,
    kind: "implementation",
    createdBy: "agent",
    // Reviews draw from the same shared root budget as the source (3.18C).
    concurrency: source.manifest.concurrency,
    model: reviewPreset.model,
    autoRun: true,
    worktree: "none",
    carryBlocks: false,
    tools: reviewPreset.definition.tools,
    permissions: {},
    systemPromptFragment: reviewPreset.definition.systemPromptFragment,
    hidden: true,
    reviewOf: { sourceThreadId: source.id, resultRevision },
    promptText,
  });

  return {
    reviewDispatched: true,
    threadId: thread.id,
    blocking: settings.gate,
  };
}

export function formatReviewForZone2(input: {
  threadId: string;
  resultRevision: number;
  status: string;
  conclusion?: string;
  findings?: ThreadReviewFinding[];
  error?: string;
}): string {
  const lines = [
    `result ${input.threadId}@${input.resultRevision} ${input.status}`,
    input.conclusion ? input.conclusion : null,
    input.error ? `error: ${input.error}` : null,
    ...(input.findings ?? []).map((finding) => {
      const where = finding.file
        ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""} `
        : "";
      return `[${finding.severity}] ${where}${finding.message}`;
    }),
  ].filter((line): line is string => line !== null);
  return `<review>\n${lines.join("\n")}\n</review>`;
}

export const reviewModelFromSlots = (
  review: ModelSelection | null | undefined,
  main: ModelSelection | null,
): ModelSelection | null => review ?? main;
