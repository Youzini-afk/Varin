import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createThreadRegistry, threadCatalogPath } from "./thread-registry.js";
import type { ThreadReport, ThreadRun } from "@varin/protocol";

it("emits only a newly persisted Run report, with fixed Run identity and no stale-report return", async () => {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "thread-return-"));
  const observed: Array<{ run: ThreadRun; report: ThreadReport }> = [];
  const observerError = vi.fn();
  const onThreadDone = vi.fn();
  const registry = createThreadRegistry({
    hostId: "host", dataDir, onThreadDone, onObserverError: observerError,
    onThreadReturned: (workspaceId, _parent, _threadId, run, report) => {
      const catalog = JSON.parse(fs.readFileSync(threadCatalogPath(dataDir, "host", workspaceId), "utf8")) as { runs: ThreadRun[] };
      expect(catalog.runs.find((entry) => entry.id === run.id)?.outcome).toBe(run.outcome);
      observed.push({ run, report });
      throw new Error("Observation does not roll back the Run");
    },
  });
  const report: ThreadReport = {
    conclusion: "same conclusion on different Runs", changedFiles: [], unresolved: [], deviations: [], confidence: 1,
    transcriptRef: { runtimeId: "pi", sessionId: "child", fromEntryId: null, toEntryId: null }, blocksSnapshot: {},
  };
  try {
    const thread = await registry.createThread({
      scopeId: "ws", parent: { kind: "session", id: "parent" }, kind: "implementation", createdBy: "agent",
      brief: "work", autoRun: true, concurrency: 8, worktree: "none", tools: [], permissions: {},
    });
    const first = await registry.startRun("ws", thread.id);
    await registry.endRun("ws", thread.id, first.id, "success", null, report);
    await registry.endRun("ws", thread.id, first.id, "success", null, report);
    expect(observed).toHaveLength(1);
    expect(onThreadDone).toHaveBeenCalledTimes(1);
    const second = await registry.startRun("ws", thread.id, "pi", { allowSettled: true });
    await registry.endRun("ws", thread.id, second.id, "failure", "setup failed");
    expect(observed).toHaveLength(1);
    const third = await registry.startRun("ws", thread.id, "pi", { allowSettled: true });
    await registry.endRun("ws", thread.id, third.id, "failure", "new failure", report);
    expect(observed.map((entry) => [entry.run.id, entry.run.outcome])).toEqual([[first.id, "success"], [third.id, "failure"]]);
    const fourth = await registry.startRun("ws", thread.id, "pi", { allowSettled: true });
    await registry.endRun("ws", thread.id, fourth.id, "lost", "disconnected", report);
    expect(observed).toHaveLength(2);
    expect(observerError).toHaveBeenCalledTimes(2);
    expect(onThreadDone).toHaveBeenCalledTimes(1);
  } finally {
    await registry.dispose();
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  }
});
