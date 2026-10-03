import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionSnapshot, ThreadReport } from "@varin/protocol";
import { openRecoveryJournalCatalog } from "../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../recovery/file-store.test-helper.js";
import { createThreadRegistry } from "./thread-registry.js";
import { createThreadRuntime } from "./thread-runtime.js";
import { registerHarnessThreadRoutes } from "./thread-routes.js";
import { IntegrationCoordinator } from "./working-state/integration-coordinator.js";
import { WorkingStateStore } from "./working-state/working-state-store.js";
import { createTestWorkingStateRootAccess, createWorkingStateObjectCollector, createWorkingStateStoreContextAccess } from "./working-state/working-state-root-adapter.test-helper.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "varin-thread-history-"));
  const workspace = path.join(root, "workspace");
  await fs.promises.mkdir(workspace);
  await fs.promises.writeFile(path.join(workspace, "a.txt"), "base\n");
  const recoveryRoot = path.join(root, "recovery");
  const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
  if (!database) throw new Error("catalog missing");
  const workingStates = createTestWorkingStateRootAccess(createWorkingStateStoreContextAccess({
    database,
    fileStore: createRecoveryFileStore(),
    identity: { authorityId: "test", canonicalRoot: workspace, filesystemProfile: "test", workspaceId: "ws" },
    resourceOperationGate: { run: async <Result>(_resources: readonly unknown[], next: () => Promise<Result>) => next() },
    root: recoveryRoot,
    collectUnreachableObjects: createWorkingStateObjectCollector(recoveryRoot, database),
  }));
  const registry = createThreadRegistry({ hostId: "test", dataDir: path.join(root, "threads") });
  const parent = { kind: "session", id: "parent" } as const;
  const thread = await registry.createThread({
    scopeId: "ws", parent, brief: "Retained work", kind: "implementation", createdBy: "user",
    concurrency: 8, autoRun: true, worktree: "isolated", tools: ["read", "edit"], permissions: {},
  });
  const branchId = thread.id;
  await workingStates.withStore("ws", "test-baseline", async (store) => {
    await store.createBranch("ws", branchId, await store.captureDirectory(workspace));
  });
  await registry.setWorkingState("ws", thread.id, { branchId });
  const publish = async (text: string) => {
    const published = await workingStates.withStore("ws", "test-publish", async (store) => {
      const object = await store.putObject(Buffer.from(text));
      const mode = (await fs.promises.stat(path.join(workspace, "a.txt"))).mode & 0o777;
      const state = { kind: "regular-file" as const, objectHash: object.hash, byteLength: object.byteLength, mode };
      return { result: await store.publishStates(branchId, { "a.txt": state }), state };
    });
    await registry.setWorkingState("ws", thread.id, { branchId, resultRevision: published.result.resultRevision });
    return published;
  };
  const coordinator = new IntegrationCoordinator({ workingStates });
  const runtime = createThreadRuntime({
    registry, workingStates, resolveIntegrationCoordinator: () => coordinator,
    sessions: { snapshot: async (sessionId: string) => ({
      sessionId, cwd: workspace, workspace: { kind: "workspace", id: "ws", authorityId: "ws" },
    } as SessionSnapshot) } as never,
    worktrees: {} as never,
    resolveWorkspaceRoot: async () => workspace, resolveRuntimeWorkspaceId: async () => "ws",
  });
  const app = express();
  app.use(express.json());
  registerHarnessThreadRoutes(app, {
    registry, runtime,
    requireAuth: (req, res, next) => { if (req.header("Authorization") !== "test") res.sendStatus(401); else next(); },
  });
  const url = `/api/harness/sessions/parent/threads/${thread.id}/history`;
  const release = (resultRevisions: number[], selectedBranch = branchId) => request(app).post(`${url}/release`)
    .set("Authorization", "test").send({ branchId: selectedBranch, resultRevisions });
  const inspect = () => request(app).get(url).set("Authorization", "test");
  cleanups.push(async () => {
    await runtime.dispose(); await registry.dispose(); database.close();
    await fs.promises.rm(root, { recursive: true, force: true });
  });
  return { root, workspace, workingStates, registry, parent, thread, branchId, publish, coordinator, runtime, app, url, inspect, release };
}

describe("user Thread history release", () => {
  it("releases selected old versions, preserves shared objects and archived reports, and reports actual cleanup", async () => {
    const h = await setup();
    const first = await h.publish("exclusive old content\n");
    const second = await h.publish("shared old content\n");
    const third = await h.publish("latest content\n");
    await h.workingStates.withStore("ws", "test-shared-owner", async (store) => {
      await store.createBranch("ws", "sibling", { "shared.txt": second.state });
    });
    const run = await h.registry.startRun("ws", h.thread.id);
    const report: ThreadReport = {
      conclusion: "Keep this report", changedFiles: ["a.txt"], unresolved: [], deviations: [], confidence: 1,
      transcriptRef: { runtimeId: "pi", sessionId: "child", fromEntryId: null, toEntryId: null }, blocksSnapshot: {},
    };
    await h.registry.endRun("ws", h.thread.id, run.id, "success", null, report);
    await h.registry.setWorkingState("ws", h.thread.id, { branchId: h.branchId, resultRevision: 3 });
    await h.registry.archiveThread("ws", h.thread.id);
    const before = await h.inspect().expect(200);
    expect(before.body.results.map((entry: { resultRevision: number }) => entry.resultRevision)).toEqual([3, 2, 1]);
    expect(before.body.results[0].protectedReasons).toEqual(["branch-head", "current-result"]);
    const response = await h.release([1, 2]).expect(200);
    expect(response.body).toEqual({
      releasedRevisions: [1, 2], missingRevisions: [],
      cleanup: { status: "complete", objectsDeleted: 1, byteLengthReclaimed: first.state.byteLength },
    });
    await h.workingStates.withStore("ws", "test-surviving-state", async (store) => {
      expect(store.getResult(h.branchId, 1)).toBeNull();
      expect(store.getResult(h.branchId, 3)).not.toBeNull();
      expect(await store.getObject(first.state.objectHash)).toBeNull();
      expect((await store.getObject(second.state.objectHash))?.toString()).toBe("shared old content\n");
      expect(store.effectiveState(h.branchId)?.["a.txt"]).toEqual(third.state);
    });
    expect((await h.registry.getThread("ws", h.parent, h.thread.id))?.report).toEqual(report);
    expect((await h.release([1, 2]).expect(200)).body).toMatchObject({ releasedRevisions: [], missingRevisions: [1, 2] });
  });

  it("authenticates and rechecks session ownership, branch identity and the whole selection", async () => {
    const h = await setup();
    await h.publish("old\n"); await h.publish("current\n");
    await request(h.app).get(h.url).expect(401);
    await request(h.app).post(`${h.url}/release`).send({ branchId: h.branchId, resultRevisions: [1] }).expect(401);
    // An existing thread outside the session's research tree is denied; a
    // thread that does not exist at all is not found.
    await request(h.app).get(h.url.replace("/parent/", "/unrelated/")).set("Authorization", "test").expect(403);
    await request(h.app).post(`${h.url.replace("/parent/", "/unrelated/")}/release`)
      .set("Authorization", "test").send({ branchId: h.branchId, resultRevisions: [1] }).expect(403);
    await request(h.app).get(h.url.replace(`/${h.thread.id}/`, "/missing-thread/")).set("Authorization", "test").expect(404);
    await h.release([1], "stale-branch").expect(409);
    await h.release([1, 2]).expect(409);
    await h.release([0]).expect(400);
    await request(h.app).post(`${h.url}/release`).set("Authorization", "test")
      .send({ branchId: h.branchId, resultRevisions: [1], workspaceId: "spoofed" }).expect(400);
    expect((await h.inspect().expect(200)).body.results).toHaveLength(2);
  });

  it("preserves referenced review evidence and active or lost Run inputs", async () => {
    const h = await setup();
    await h.publish("old\n"); await h.publish("new\n");
    expect((await h.inspect().expect(200)).body.results[1].protectedReasons).toEqual([]);
    await h.registry.setVerification("ws", h.thread.id, {
      currentResultRevision: 2, childChecks: null, parentChecks: null,
      review: { resultRevision: 1, status: "running" },
    });
    await h.release([1]).expect(409);
    expect((await h.inspect().expect(200)).body.results[1].protectedReasons).toContain("review");
    await h.registry.setVerification("ws", h.thread.id, {
      currentResultRevision: 2, childChecks: null, parentChecks: null,
      review: { resultRevision: 1, status: "completed" },
    });
    await h.registry.setWorkingState("ws", h.thread.id, { branchId: h.branchId, resultRevision: 1 });
    const run = await h.registry.startRun("ws", h.thread.id);
    expect((await h.inspect().expect(200)).body.results[1].protectedReasons).toEqual(["run-input"]);
    await h.release([1]).expect(409);
    await h.registry.endRun("ws", h.thread.id, run.id, "lost");
    await h.release([1]).expect(409);
  });

  it("retains conflicting integration inputs but can undo a complete integration after releasing its source version", async () => {
    const h = await setup();
    await h.publish("child one\n"); await h.publish("child two\n");
    const input = { workspaceId: "ws", threadId: h.thread.id, branchId: h.branchId, resultRevision: 1 };
    const applied = await h.coordinator.mergeResult(input);
    expect(applied.status).toBe("applied");
    await h.release([1]).expect(200);
    const undone = await h.runtime.undoIntegration("ws", h.parent, h.thread.id, { operationId: applied.operationId! });
    expect(undone.status).toBe("compensated");
    expect(await fs.promises.readFile(path.join(h.workspace, "a.txt"), "utf8")).toBe("base\n");
    await h.publish("child three\n");
    await fs.promises.writeFile(path.join(h.workspace, "a.txt"), "conflicting parent\n");
    const conflicted = await h.coordinator.mergeResult({ ...input, resultRevision: 2 });
    expect(conflicted.status).toBe("conflict");
    expect((await h.inspect().expect(200)).body.results.find((entry: { resultRevision: number }) => entry.resultRevision === 2).protectedReasons)
      .toContain("integration");
    await h.release([2]).expect(409);
  });

  it("serializes catalog mutations through the release decision, then lets queued work continue", async () => {
    const h = await setup();
    await h.publish("old\n"); await h.publish("new\n");
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    let resume!: () => void;
    const pause = new Promise<void>((resolve) => { resume = resolve; });
    const original = WorkingStateStore.prototype.deleteResults;
    vi.spyOn(WorkingStateStore.prototype, "deleteResults").mockImplementationOnce(async function (this: WorkingStateStore, branchId, revisions) {
      reached(); await pause; return original.call(this, branchId, revisions);
    });
    const releasing = h.runtime.releaseResultHistory("ws", h.parent, h.thread.id, { branchId: h.branchId, resultRevisions: [1] });
    await entered;
    let started = false;
    const starting = h.registry.startRun("ws", h.thread.id).then((run) => { started = true; return run; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toBe(false);
    resume();
    expect((await releasing).releasedRevisions).toEqual([1]);
    const run = await starting;
    expect(run.inputRevision).toBe(2);
    expect((await h.inspect().expect(200)).body.results[0].protectedReasons).toContain("run-input");
  });
});
