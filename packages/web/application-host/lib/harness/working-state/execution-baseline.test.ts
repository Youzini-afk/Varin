import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessActorContext, HarnessServiceMap, PiMessage } from "@varin/protocol";
import { createDocumentAuthority } from "../../documents/authority.js";
import { openRecoveryJournalCatalog } from "../../recovery/journal-catalog.js";
import { createRecoveryFileStore } from "../../recovery/file-store.test-helper.js";
import {
  createDocumentBranchWriteService,
  createWorkingBranchEnsureMaterializedService,
} from "../harness-services.js";
import { createHarnessPathAuthority } from "../path-authority.js";
import { createHarnessRouter } from "../router.js";
import { createThreadRegistry } from "../thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "../thread-runtime.js";
import { createThreadWorktreeRuntime } from "../thread-worktree.js";
import { IntegrationCoordinator } from "./integration-coordinator.js";
import { ThreadExecutionViewRegistry } from "./execution-view.js";
import { createWorkingBranchWriteServices } from "./working-branch-writes.js";
import { VirtualWriteGate } from "./virtual-write-gate.js";
import { createTestWorkingStateRootAccess } from "./working-state-root-adapter.test-helper.js";

const disposes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposes.splice(0).reverse()) await dispose(); });

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const assistantMessage = (text: string): PiMessage => ({
  api: "test",
  content: [{ type: "text", text }],
  model: "test-model",
  provider: "test-provider",
  role: "assistant",
  stopReason: "stop",
  timestamp: 0,
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "varin-execution-baseline-"));
  const workspace = path.join(root, "workspace");
  const recoveryRoot = path.join(root, "recovery");
  const worktrees = path.join(root, "worktrees");
  await fs.mkdir(workspace);
  await fs.mkdir(worktrees);
  git(workspace, ["init"]);
  git(workspace, ["config", "user.name", "Test"]);
  git(workspace, ["config", "user.email", "test@example.com"]);
  git(workspace, ["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(workspace, "kept.txt"), "parent kept\n");
  git(workspace, ["add", "."]);
  git(workspace, ["commit", "-m", "base"]);
  const parentHead = git(workspace, ["rev-parse", "HEAD"]);
  const documents = createDocumentAuthority({
    hostId: "test-host",
    dataDir: path.join(root, "data"),
    isAllowedRoot: async () => true,
    isTrusted: async () => true,
  });
  const { workspaceId } = await documents.resolveWorkspace({ path: workspace });
  const database = await openRecoveryJournalCatalog(recoveryRoot, { create: true });
  if (!database) throw new Error("catalog missing");
  const workingStates = createTestWorkingStateRootAccess({
    withWorkspaceStorage: async (_workspaceId, _options, operation) => operation({
      database,
      fileStore: createRecoveryFileStore(),
      identity: { authorityId: "test-host", canonicalRoot: workspace, filesystemProfile: "test", workspaceId },
      resourceOperationGate: {
        run: async <Result>(_resources: readonly unknown[], next: () => Promise<Result>) => next(),
      },
      root: recoveryRoot,
    }),
  });
  const views = new ThreadExecutionViewRegistry();
  const writeGate = new VirtualWriteGate();
  const writes = createWorkingBranchWriteServices({ views, workingStates, writeGate });
  const worktreeRuntime = createThreadWorktreeRuntime({
    createWorktree: async (_directory, input) => {
      const target = path.join(worktrees, String(input.worktreeName));
      return { path: target };
    },
    getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
  });
  const registry = createThreadRegistry({ dataDir: path.join(root, "threads"), hostId: "test-host" });
  const actor: HarnessActorContext = {
    authorityInstanceId: "test-host",
    sessionId: "child-session",
    workerId: "worker",
    workerGeneration: 1,
    workspaceId,
    grantedCapabilities: ["read.document", "write.document"],
    runId: "run-1",
  };
  const coordinator = new IntegrationCoordinator({
    workingStates,
    beginDirtyStateBarrier: (id, barrierPaths) => documents.beginDirtyStateBarrier(id, barrierPaths),
  });
  const runtime = createThreadRuntime({
    registry,
    workingStates,
    executionViews: views,
    virtualWriteGate: writeGate,
    resolveIntegrationCoordinator: () => coordinator,
    resolveWorkspaceRoot: async () => workspace,
    resolveRuntimeWorkspaceId: async () => workspaceId,
    sessions: {
      create: async (input) => ({ sessionId: actor.sessionId, cwd: input.cwd } as never),
      open: async (input) => ({ sessionId: input.sessionId, cwd: input.cwd } as never),
      prompt: async () => undefined,
      send: async () => undefined,
      abort: async () => undefined,
      close: async () => undefined,
      snapshot: async (sessionId) => ({
        sessionId,
        cwd: workspace,
        busy: false,
        isStreaming: false,
        isCompacting: false,
        workspace: { kind: "workspace", id: workspaceId, authorityId: workspaceId },
      } as never),
      summary: async (sessionId) => ({
        id: sessionId,
        sessionFile: `${sessionId}.jsonl`,
        cwd: workspace,
      } as never),
      stats: async () => ({ tokens: { input: 0, output: 0, cacheRead: 0 }, toolCalls: 0, cost: 0 } as never),
      entries: async (sessionId) => ({ sessionId, scope: "branch", leafId: null, entries: [] }),
    } as ThreadSessionAdapter,
    worktrees: worktreeRuntime,
  });
  const paths = createHarnessPathAuthority({ authorityId: "test-host", documents });
  let response: unknown;
  const router = createHarnessRouter({
    resolveActor: async () => actor,
    authorizeWorkspacePath: (current, input, resolveOptions) => paths.resolve(current, input, resolveOptions),
    respond: async (_sessionId, _requestId, result) => { response = result; },
  });
  router.register("document.branchWrite", createDocumentBranchWriteService({
    documentBranchWrite: (sessionId, changes, expectedRevision) => writes.branchWrite(sessionId, changes, expectedRevision),
  }));
  router.register("workingBranch.ensureMaterialized", createWorkingBranchEnsureMaterializedService({
    workingBranchEnsureMaterialized: (sessionId, signal) => runtime.materializeExecutionView(sessionId, signal),
  }));

  disposes.push(async () => {
    router.dispose();
    await runtime.dispose();
    await registry.dispose();
    database.close();
    await documents.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const request = async <M extends "document.branchWrite" | "workingBranch.ensureMaterialized">(
    method: M,
    params: HarnessServiceMap[M]["params"],
  ) => {
    await router.processEvent({
      kind: "host",
      actor,
      envelope: {
        kind: "event",
        event: "harness.request",
        data: { requestId: crypto.randomUUID(), method, params },
      },
    });
    return response as
      | { ok: true; result: HarnessServiceMap[M]["result"] }
      | { ok: false; error: { code: string; message: string } };
  };

  const settleRun = async () => {
    runtime.processEvent({
      kind: "host",
      sessionId: actor.sessionId,
      envelope: {
        kind: "event",
        event: "agent.event",
        data: { event: { type: "agent_end", messages: [assistantMessage("Conclusion\n- done")], willRetry: false } },
      },
    });
    runtime.processEvent({
      kind: "host",
      sessionId: actor.sessionId,
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "agent_settled" } } },
    });
    await runtime.drain();
  };

  return {
    actor,
    parentHead,
    registry,
    request,
    runtime,
    settleRun,
    views,
    workspace,
    workspaceId,
    workingStates,
    worktreeRuntime,
  };
}

describe("execution Git baseline production chain", () => {
  it("settles virtual and shell writes through an isolated init without a bad object", async () => {
    const f = await fixture();
    const thread = await f.registry.createThread({
      scopeId: f.workspaceId,
      parent: { kind: "session", id: "parent-1" },
      brief: "isolated execution baseline",
      preset: "worker",
      kind: "implementation",
      createdBy: "agent",
      concurrency: 1,
      autoRun: true,
      worktree: "isolated",
      model: { providerId: "test", modelId: "test" },
      tools: ["read", "write", "bash"],
      permissions: {},
    });
    await f.runtime.prepareIsolatedBranch({
      scopeId: f.workspaceId,
      parent: { kind: "session", id: "parent-1" },
      threadId: thread.id,
    });
    const run = await f.registry.startRun(f.workspaceId, thread.id);
    f.actor.runId = run.id;
    await f.runtime.spawn({
      scopeId: f.workspaceId,
      parent: { kind: "session", id: "parent-1" },
      threadId: thread.id,
      runId: run.id,
      brief: "isolated execution baseline",
      preset: "worker",
      kind: "implementation",
      createdBy: "agent",
      concurrency: 1,
      autoRun: true,
      worktree: "isolated",
      model: { providerId: "test", modelId: "test" },
      tools: ["read", "write", "bash"],
      permissions: {},
    });
    expect(await f.request("document.branchWrite", {
      path: "virtual-only.ts",
      action: "write",
      content: "from virtual write\n",
    })).toMatchObject({ ok: true, result: { status: "committed" } });
    const materialized = await f.request("workingBranch.ensureMaterialized", {});
    expect(materialized).toMatchObject({ ok: true, result: { status: "materialized" } });
    if (!materialized.ok || materialized.result.status !== "materialized") {
      throw new Error(`expected materialized directory: ${JSON.stringify(materialized)}`);
    }
    const live = await f.registry.getThreadById(f.workspaceId, thread.id);
    expect(live?.worktree?.base).toBe(f.parentHead);
    expect(live?.worktree?.executionBaseline).toMatch(/^[0-9a-f]{40}$/);
    expect(live?.worktree?.executionBaseline).not.toBe(f.parentHead);
    await fs.writeFile(path.join(materialized.result.path, "shell-only.ts"), "from bash\n");
    await f.settleRun();
    const settled = await f.registry.getThreadById(f.workspaceId, thread.id);
    expect(settled?.resultRevision).toBeGreaterThan(0);
    expect((settled?.report?.unresolved ?? []).join("\n")).not.toMatch(/bad object|unknown revision|needed a single revision/i);
    const published = await f.workingStates.withStore(
      f.workspaceId,
      "assert-native-result",
      (store) => store.getResult(`thread-${thread.id}`, settled!.resultRevision!),
      "shared",
    );
    expect(published?.changedPaths).toEqual(expect.arrayContaining(["virtual-only.ts", "shell-only.ts"]));
    const merged = await f.runtime.merge(f.workspaceId, { kind: "session", id: "parent-1" }, thread.id);
    expect(merged.status === undefined || merged.status === "applied").toBe(true);
    expect(await fs.readFile(path.join(f.workspace, "virtual-only.ts"), "utf8")).toBe("from virtual write\n");
    expect(await fs.readFile(path.join(f.workspace, "shell-only.ts"), "utf8")).toBe("from bash\n");
    expect(await fs.readFile(path.join(f.workspace, "kept.txt"), "utf8")).toBe("parent kept\n");
    expect(git(f.workspace, ["rev-parse", "HEAD"])).toBe(f.parentHead);

    const previousBaseline = settled!.worktree!.executionBaseline!;
    const reclaimed = await f.worktreeRuntime.reclaim(settled!.worktree!, { nativeVerified: true });
    expect(reclaimed.reclaimed).toBe(true);
    expect(settled!.worktree!.executionBaseline).toBeUndefined();
    const rematerialized = await f.worktreeRuntime.materialize(f.workspace, settled!.worktree!);
    expect(rematerialized.executionBaseline).toMatch(/^[0-9a-f]{40}$/);
    expect(rematerialized.executionBaseline).not.toBe(previousBaseline);
    const inspected = await f.worktreeRuntime.inspect(rematerialized, "live");
    expect(inspected.changedFiles).toEqual(expect.any(Array));
  }, 30_000);

  it("recovers a promoted materialization crash with a resolvable execution baseline", async () => {
    const f = await fixture();
    const thread = await f.registry.createThread({
      scopeId: f.workspaceId,
      parent: { kind: "session", id: "parent-1" },
      brief: "crash recovery baseline",
      preset: "worker",
      kind: "implementation",
      createdBy: "agent",
      concurrency: 1,
      autoRun: true,
      worktree: "isolated",
      model: { providerId: "test", modelId: "test" },
      tools: ["read", "write", "bash"],
      permissions: {},
    });
    const prepared = await f.runtime.prepareIsolatedBranch({
      scopeId: f.workspaceId,
      parent: { kind: "session", id: "parent-1" },
      threadId: thread.id,
    });
    const run = await f.registry.startRun(f.workspaceId, thread.id);
    f.actor.runId = run.id;
    await f.runtime.spawn({
      scopeId: f.workspaceId,
      parent: { kind: "session", id: "parent-1" },
      threadId: thread.id,
      runId: run.id,
      brief: "crash recovery baseline",
      preset: "worker",
      kind: "implementation",
      createdBy: "agent",
      concurrency: 1,
      autoRun: true,
      worktree: "isolated",
      model: { providerId: "test", modelId: "test" },
      tools: ["read", "write", "bash"],
      permissions: {},
    });
    expect(await f.request("document.branchWrite", {
      path: "kept.txt",
      action: "write",
      content: "frozen crash body\n",
    })).toMatchObject({ ok: true, result: { status: "committed" } });
    const livePath = prepared.worktree.path;
    const backup = `${livePath}.virtual-backup-crash`;
    const staging = `${livePath}.materializing-crash`;
    await fs.rm(livePath, { recursive: true, force: true }).catch(() => undefined);
    await fs.mkdir(livePath, { recursive: true });
    await fs.writeFile(path.join(livePath, "kept.txt"), "frozen crash body\n");
    await f.registry.setWorktree(f.workspaceId, thread.id, {
      ...prepared.worktree,
      path: livePath,
      base: f.parentHead,
      viewMode: "virtual",
      materialized: false,
      materializationSwitch: {
        revision: 0,
        writeRevision: 1,
        root: "sha256-crash-root",
        stagingPath: staging,
        backupPath: backup,
        stage: "staging-promoted",
      },
    });
    f.views.bind({ ...f.views.get(f.actor.sessionId)!, writeRevision: 1, mode: "virtual" });
    await expect(f.request("workingBranch.ensureMaterialized", {})).resolves.toMatchObject({
      ok: true,
      result: { status: "materialized", path: livePath },
    });
    const recovered = await f.registry.getThreadById(f.workspaceId, thread.id);
    expect(recovered?.worktree?.executionBaseline).toMatch(/^[0-9a-f]{40}$/);
    const inspected = await f.worktreeRuntime.inspect(recovered!.worktree!, "live");
    expect(inspected.changedFiles).toEqual(expect.any(Array));
    expect(await fs.readFile(path.join(livePath, "kept.txt"), "utf8")).toBe("frozen crash body\n");
  }, 30_000);
});
