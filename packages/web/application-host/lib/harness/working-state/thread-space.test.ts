import { describe, expect, it } from "vitest";
import {
  assembleKeepReasons,
  measurementFromHashes,
  projectThreadOccupancy,
  projectWorkspaceSpace,
} from "./thread-space.js";
import type { Thread } from "@varin/protocol";

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  id: "thread-1",
  parent: { kind: "session", id: "parent-1" },
  workspaceId: "workspace-1",
  forkPoint: null,
  brief: "work",
  preset: "worker",
  model: null,
  manifest: { carryBlocks: true, concurrency: 1, draftBaselineId: null, scope: [], systemPromptFragment: "", tools: [], workFocus: "code", worktree: "isolated" },
  createdBy: "agent",
  kind: "implementation",
  purpose: "task",
  worktree: { path: "/tmp/thread", base: "zero-commit", materialized: true },
  lifecycle: "settled",
  attention: "none",
  waitingFor: null,
  integration: "none",
  diffStats: null,
  report: { conclusion: "done", changedFiles: [], unresolved: [], deviations: [], confidence: 1, transcriptRef: { runtimeId: "pi", sessionId: "child", fromEntryId: "a", toEntryId: "b" }, blocksSnapshot: {} },
  activeRunId: "run-1",
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
  eventSeq: 1,
  hidden: false,
  ...overrides,
});

describe("thread space accounting", () => {
  it("counts a shared object once at workspace level and splits exclusive vs shared per thread", () => {
    const shared = new Map<string, number | null>([["sha-shared", 10]]);
    const leftExclusive = new Map<string, number | null>([["sha-left", 3]]);
    const rightExclusive = new Map<string, number | null>([["sha-right", 4]]);
    const left = projectThreadOccupancy({
      thread: thread({ id: "left" }),
      materialized: { logicalBytes: 20, allocatedBytes: 24, unknown: false },
      exclusive: leftExclusive,
      shared,
      keepReasons: [],
    });
    const right = projectThreadOccupancy({
      thread: thread({ id: "right" }),
      materialized: { logicalBytes: 30, allocatedBytes: 32, unknown: false },
      exclusive: rightExclusive,
      shared,
      keepReasons: ["User requested keep_worktree"],
    });
    expect(left.exclusiveObjects.logicalBytes).toBe(3);
    expect(left.sharedObjects.logicalBytes).toBe(10);
    expect(right.reclaimable).toBe(false);
    expect(left.reclaimableLogicalBytes).toBe(20);
    const unique = measurementFromHashes(new Map([["sha-shared", 10], ["sha-left", 3], ["sha-right", 4]]));
    expect(unique.logicalBytes).toBe(17);
    const space = projectWorkspaceSpace("workspace-1", [left, right], unique, { maxBytes: 40 }, {
      freeBytes: 50,
      totalBytes: 100,
    });
    expect(space.materializedLogicalBytes).toBe(50);
    expect(space.uniqueObjectLogicalBytes).toBe(17);
    expect(space.status).toBe("over-budget");
  });

  it("does not treat unknown occupancy as zero or merge-ready budget success", () => {
    const occupancy = projectThreadOccupancy({
      thread: thread(),
      materialized: { logicalBytes: null, allocatedBytes: null, unknown: true },
      exclusive: new Map([["sha", null]]),
      shared: new Map(),
      keepReasons: [],
    });
    expect(occupancy.materialized.logicalBytes).toBeNull();
    expect(occupancy.exclusiveObjects.unknown).toBe(true);
    const space = projectWorkspaceSpace(
      "workspace-1",
      [occupancy],
      { logicalBytes: null, allocatedBytes: null, unknown: true },
      { maxBytes: 1 },
      null,
    );
    expect(space.status).toBe("unknown");
    expect(space.materializedLogicalBytes).toBeNull();
    expect(space.note).toMatch(/unknown sizes are not treated as zero/i);
  });

  it("does not hide a known budget overage behind another unknown directory", () => {
    const known = projectThreadOccupancy({
      thread: thread({ id: "known" }),
      materialized: { logicalBytes: 20, allocatedBytes: 20, unknown: false },
      exclusive: new Map(),
      shared: new Map(),
      keepReasons: [],
    });
    const unknown = projectThreadOccupancy({
      thread: thread({ id: "unknown" }),
      materialized: { logicalBytes: null, allocatedBytes: null, unknown: true },
      exclusive: new Map(),
      shared: new Map(),
      keepReasons: [],
    });
    const space = projectWorkspaceSpace("workspace-1", [known, unknown], {
      logicalBytes: 0,
      allocatedBytes: null,
      unknown: false,
    }, { maxBytes: 10 }, null);
    expect(space.status).toBe("over-budget");
    expect(space.materializedLogicalBytes).toBeNull();
    expect(space.note).toMatch(/already exceeded/i);
  });

  it("keeps an in-progress baseline capture from being treated as a complete branch", () => {
    expect(assembleKeepReasons({
      thread: thread({
        worktree: { path: "/tmp/scratch", base: "zero-commit", materialized: false, viewMode: "virtual", preparationStage: "capturing-baseline" },
      }),
      runActive: false,
      unfinishedIntegration: [],
      matchesResult: null,
      hasPublishedResult: false,
      hasActiveCommands: false,
    })).toContain("Baseline capture is incomplete");
  });

  it("keeps directories for keep_worktree, active runs, unfinished integration, and unverified content", () => {
    expect(assembleKeepReasons({
      thread: thread({ keepWorktree: true, integration: "conflict", lifecycle: "archived" }),
      runActive: false,
      unfinishedIntegration: ["Unfinished integration (conflict)"],
      matchesResult: false,
      hasPublishedResult: true,
      hasActiveCommands: true,
    })).toEqual([
      "User requested keep_worktree",
      "Unfinished integration (conflict)",
      "A background command is still using this directory",
      "Directory content does not match the published result",
    ]);
  });

  it("treats a virtual scratch as reclaimable when keep reasons are empty", () => {
    const occupancy = projectThreadOccupancy({
      thread: thread({
        worktree: { path: "/tmp/scratch", base: "zero-commit", materialized: false, viewMode: "virtual" },
      }),
      materialized: { logicalBytes: 0, allocatedBytes: 0, unknown: false },
      exclusive: new Map(),
      shared: new Map(),
      keepReasons: [],
    });
    expect(occupancy.reclaimable).toBe(true);
    expect(occupancy.reclaimableLogicalBytes).toBe(0);
  });

  it("marks low-free from the configured ratio without inventing a default cap", () => {
    const occupancy = projectThreadOccupancy({
      thread: thread(),
      materialized: { logicalBytes: 1, allocatedBytes: 1, unknown: false },
      exclusive: new Map(),
      shared: new Map(),
      keepReasons: ["Thread lifecycle is active"],
    });
    const space = projectWorkspaceSpace("workspace-1", [occupancy], {
      logicalBytes: 0,
      allocatedBytes: null,
      unknown: false,
    }, { minFreeRatio: 0.25 }, { freeBytes: 10, totalBytes: 100 });
    expect(space.status).toBe("low-free");
    expect(occupancy.reclaimable).toBe(false);
    expect(occupancy.reclaimableLogicalBytes).toBe(0);
  });
});
