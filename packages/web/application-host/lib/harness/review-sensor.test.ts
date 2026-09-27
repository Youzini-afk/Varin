import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  onPublishedResult,
  formatReviewForZone2,
  parseReviewFindings,
  DEFAULT_REVIEW_SENSOR_SETTINGS,
} from "./review-sensor.js";
import { createThreadRegistry, type CreateThreadInput } from "./thread-registry.js";
import { resolvePresets } from "./presets.js";
import type { ModelSelection } from "@varin/protocol";

const mainModel: ModelSelection = { providerId: "anthropic", modelId: "claude-sonnet-4" };
const workspaceId = "workspace-1";
const parent = { kind: "session", id: "p1" } as const;
const ENABLED = { enabled: true, gate: false };

function reviewPresetFor(main: ModelSelection = mainModel) {
  const roles = resolvePresets({ review: main }, main);
  return roles.find((r) => r.id === "review")!;
}

describe("onPublishedResult", () => {
  let dataDir: string;
  let registry: ReturnType<typeof createThreadRegistry>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "review-sensor-"));
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
  });

  afterEach(() => {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  const sourceThread = async () => registry.createThread({
    scopeId: workspaceId,
    parent,
    brief: "Implement login",
    preset: "hardImplement",
    kind: "implementation",
    createdBy: "agent",
    concurrency: 12,
    autoRun: false,
    worktree: "isolated",
    tools: ["bash"],
    permissions: {},
  });

  const start = async (input: CreateThreadInput & { promptText: string }) => {
    const { promptText: _promptText, ...createInput } = input;
    const thread = await registry.createThread(createInput);
    await registry.startRun(workspaceId, thread.id);
    return thread;
  };

  it("does not open a thread when the published diff is empty", async () => {
    const source = await sourceThread();
    const result = await onPublishedResult({
      workspaceId,
      source,
      resultRevision: 1,
      changedPaths: [],
      reviewPreset: reviewPresetFor(),
      settings: ENABLED,
      formatDiff: async () => "",
      createAndStart: start,
    });
    expect(result.reviewDispatched).toBe(false);
    expect(result.skippedReason).toBe("empty-diff");
    expect(await registry.listThreads(workspaceId, parent, true)).toHaveLength(1);
  });

  it("defaults automatic review to off (D-285)", () => {
    expect(DEFAULT_REVIEW_SENSOR_SETTINGS).toEqual({ enabled: false, gate: false });
  });

  it("does not open a thread when review is disabled", async () => {
    const source = await sourceThread();
    const result = await onPublishedResult({
      workspaceId,
      source,
      resultRevision: 1,
      changedPaths: ["a.ts"],
      reviewPreset: reviewPresetFor(),
      settings: { enabled: false, gate: false },
      formatDiff: async () => "diff",
      createAndStart: start,
    });
    expect(result.reviewDispatched).toBe(false);
    expect(result.skippedReason).toBe("disabled");
  });

  it("does not open a thread when no review preset is available", async () => {
    const source = await sourceThread();
    const result = await onPublishedResult({
      workspaceId,
      source,
      resultRevision: 1,
      changedPaths: ["a.ts"],
      reviewPreset: null,
      settings: ENABLED,
      formatDiff: async () => "diff",
      createAndStart: start,
    });
    expect(result.reviewDispatched).toBe(false);
    expect(result.skippedReason).toBe("no-review-preset");
  });

  it("creates a hidden review bound to the published revision and starts a run", async () => {
    const source = await sourceThread();
    const result = await onPublishedResult({
      workspaceId,
      source,
      resultRevision: 3,
      changedPaths: ["a.ts"],
      reviewPreset: reviewPresetFor(),
      settings: ENABLED,
      formatDiff: async () => "diff content",
      recallKnowledge: async () => "#1 Use bun",
      createAndStart: start,
    });
    expect(result.reviewDispatched).toBe(true);
    expect(result.blocking).toBe(false);
    const review = await registry.getThread(workspaceId, parent, result.threadId!);
    expect(review?.hidden).toBe(true);
    expect(review?.reviewOf).toEqual({ sourceThreadId: source.id, resultRevision: 3 });
    expect(review?.brief).toContain(`${source.id}@3`);
    expect(await registry.getActiveRun(workspaceId, review!.id)).toMatchObject({ workerState: "starting" });
    expect(await registry.listThreads(workspaceId, parent)).toHaveLength(1);
    expect(await registry.listThreads(workspaceId, parent, true)).toHaveLength(2);
  });

  it("dedups the same result revision and cancels a running older review", async () => {
    const source = await sourceThread();
    const first = await onPublishedResult({
      workspaceId,
      source,
      resultRevision: 1,
      changedPaths: ["a.ts"],
      reviewPreset: reviewPresetFor(),
      settings: ENABLED,
      formatDiff: async () => "old",
      createAndStart: start,
    });
    const cancelled: string[] = [];
    const second = await onPublishedResult({
      workspaceId,
      source,
      resultRevision: 2,
      changedPaths: ["a.ts"],
      reviewPreset: reviewPresetFor(),
      settings: ENABLED,
      existingReview: { resultRevision: 1, status: "running", reviewThreadId: first.threadId! },
      formatDiff: async () => "new",
      cancelReview: async (id) => { cancelled.push(id); },
      createAndStart: start,
    });
    expect(cancelled).toEqual([first.threadId]);
    expect(second.reviewDispatched).toBe(true);
    const dup = await onPublishedResult({
      workspaceId,
      source,
      resultRevision: 2,
      changedPaths: ["a.ts"],
      reviewPreset: reviewPresetFor(),
      settings: ENABLED,
      existingReview: { resultRevision: 2, status: "running", reviewThreadId: second.threadId! },
      formatDiff: async () => "new",
      createAndStart: start,
    });
    expect(dup.reviewDispatched).toBe(false);
    expect(dup.skippedReason).toBe("dedup");
  });
});

describe("review formatting", () => {
  it("parses severity and file:line from findings", () => {
    expect(parseReviewFindings("- [high] src/a.ts:12 missing null check\n- none")).toEqual([
      { severity: "high", file: "src/a.ts", line: 12, message: "missing null check" },
    ]);
  });

  it("wraps review text in <review> tags", () => {
    const formatted = formatReviewForZone2({
      threadId: "thread-1",
      resultRevision: 2,
      status: "completed",
      conclusion: "Looks good",
      findings: [{ severity: "medium", file: "a.ts", line: 4, message: "unused" }],
    });
    expect(formatted).toContain("<review>");
    expect(formatted).toContain("thread-1@2 completed");
    expect(formatted).toContain("[medium] a.ts:4 unused");
    expect(formatted).toContain("</review>");
  });
});
