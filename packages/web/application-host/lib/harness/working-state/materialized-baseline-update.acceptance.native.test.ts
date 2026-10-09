import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createDocumentAuthority } from "../../documents/authority.js";
import { createAuthorityTestRuntime } from "../../kernel/authority.test-helper.js";
import { createThreadRegistry } from "../thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "../thread-runtime.js";
import { createThreadUpdateService } from "../thread-services.js";
import { createWorktreeReclaimGuard } from "../worktree-reclaim-guard.js";
import { assertManagedWorktreeOwnership } from "../worktree-ownership.js";
import type { HarnessServiceHost } from "../service-host.js";
import type { HarnessServiceContext } from "../router.js";
import type { RecoveryState, WorkspaceWorkingStateRootAccess } from "./types.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "varin-baseline-update-"));
  const workspace = join(root, "workspace");
  const managedRoot = join(root, "managed");
  const directory = join(managedRoot, "child");
  await mkdir(workspace); await mkdir(directory, { recursive: true });
  const original = "first\nsecond\nthird\nfourth\nfifth\n";
  for (const dir of [workspace, directory]) {
    await writeFile(join(dir, "code.txt"), original);
    await writeFile(join(dir, "conflict.txt"), "base\n");
  }
  const documents = createDocumentAuthority({ hostId: "baseline-host", dataDir: join(root, "documents"), isAllowedRoot: async () => true });
  const { workspaceId } = await documents.resolveWorkspace({ path: workspace });
  const registry = createThreadRegistry({ hostId: "baseline-host", dataDir: join(root, "threads") });
  const native = await createAuthorityTestRuntime({ documents, hostId: "baseline-host", dataDir: join(root, "data") });
  const common = { scopeId: workspaceId, brief: "Implement", kind: "implementation" as const, createdBy: "agent" as const,
    concurrency: 2, autoRun: true, worktree: "isolated" as const, tools: ["read", "write", "update"], permissions: {} };
  const parent = await registry.createThread({ ...common, parent: { kind: "session", id: "root-session" } });
  const ownerRun = await registry.startRun(workspaceId, parent.id);
  await registry.markRunRunning(workspaceId, parent.id, ownerRun.id, "parent-session");
  const child = await registry.createThread({ ...common, parent: { kind: "thread", id: parent.id } });
  const childRun = await registry.startRun(workspaceId, child.id);
  await registry.markRunRunning(workspaceId, child.id, childRun.id, "child-session");
  const parentBranchId = `branch-${parent.id}`;
  const childBranchId = `branch-${child.id}`;
  const result = await native.workingStates.withBranchStore(workspaceId, "fixture", async (store) => {
    const states = await store.captureDirectory(workspace);
    await store.createBranch(workspaceId, parentBranchId, states, "initial");
    const first = await store.publishHeadResult(parentBranchId);
    const pin = await store.pinBranch(parentBranchId, { revision: first.resultRevision });
    try { await store.createBranchFromPin(workspaceId, childBranchId, pin, `${parentBranchId}@${first.resultRevision}`); }
    finally { await pin.release(); }
    const make = async (text: string): Promise<RecoveryState> => {
      const stored = await store.putObject(Buffer.from(text));
      return { kind: "regular-file", objectHash: stored.hash, byteLength: stored.byteLength,
        ...(states["code.txt"]!.kind === "regular-file" ? { mode: states["code.txt"]!.mode } : {}) };
    };
    const branch = (await store.getBranchRoot(parentBranchId))!;
    await store.commitVirtualWrites(parentBranchId, branch.writeRevision, {
      "code.txt": await make(original.replace("first", "parent first")),
      "conflict.txt": await make("parent change\n"),
      "new-api.txt": await make("NEW_PARENT_API\n"),
    });
    const second = await store.publishHeadResult(parentBranchId);
    return { first, second };
  });
  await registry.setWorkingState(workspaceId, parent.id, { branchId: parentBranchId, resultRevision: result.second.resultRevision });
  await registry.setWorkingState(workspaceId, child.id, { branchId: childBranchId,
    worktree: { path: directory, managedRoot, base: `${parentBranchId}@${result.first.resultRevision}`,
      materialized: true, viewMode: "materialized", preparationStage: "ready" } });
  await writeFile(join(directory, "code.txt"), original.replace("fifth", "child fifth"));
  await writeFile(join(directory, "conflict.txt"), "child change\n");
  // Match index.ts: the recovery file store and its reentrant resource gate
  // must use the same native backend and owning/execution identity.
  const resolveApply = async (target: string, owningWorkspaceId = workspaceId) => {
    const identity = await documents.resolveWorkspace({ path: target });
    return { workspaceId: identity.workspaceId, resourceOperationGate: native.backend.gateFor({
      authorityId: "baseline-host", canonicalRoot: target,
      filesystemProfile: process.platform === "win32" ? "windows-local" : `${process.platform}-local`,
      workspaceId: owningWorkspaceId,
    }) };
  };
  const runtimes: ReturnType<typeof createThreadRuntime>[] = [];
  const runtime = (workingStates: WorkspaceWorkingStateRootAccess = native.workingStates) => {
    const value = createThreadRuntime({ registry, workingStates,
      sessions: { abort: vi.fn(), close: vi.fn() } as unknown as ThreadSessionAdapter,
      resolveWorkspaceRoot: async () => workspace,
      resolveRuntimeWorkspaceId: async (cwd) => (await documents.resolveWorkspace({ path: cwd })).workspaceId,
      resolveBaselineApplyContext: resolveApply,
      canReclaimWorktree: createWorktreeReclaimGuard(documents),
      worktrees: { assertOwnership: (tree, operation, candidates) => assertManagedWorktreeOwnership(tree, operation, candidates,
        { authorizeManagedRoot: (candidate) => candidate === managedRoot }),
      } as Parameters<typeof createThreadRuntime>[0]["worktrees"],
    });
    runtimes.push(value); return value;
  };
  const ctx: HarnessServiceContext = { sessionId: "parent-session", workspaceId, signal: new AbortController().signal, authorizedPaths: [],
    actor: { authorityInstanceId: "baseline-host", sessionId: "parent-session", workerId: "parent-worker", workerGeneration: 1,
      workspaceId, grantedCapabilities: ["control.thread"] } };
  const invoke = (instance: ReturnType<typeof createThreadRuntime>) => createThreadUpdateService({
    threadRegistry: registry, threadUpdateBaseline: instance.updateBaseline,
  } as unknown as HarnessServiceHost).handle({ threadId: child.id, resultRevision: result.second.resultRevision }, ctx);
  return { root, workspace, directory, documents, native, registry, runtime, invoke, workspaceId, parent, child, childRun, parentBranchId, childBranchId, result,
    async dispose() { for (const instance of runtimes) await instance.dispose(); await registry.dispose(); await native.dispose(); await documents.dispose(); await rm(root, { recursive: true, force: true }); } };
}

describe("materialized baseline — public Host service and release Rust authority", () => {
  it("adopts selected parent bytes, keeps child edits/conflicts and leaves the old result readable", async () => {
    const f = await fixture();
    try {
      const result = await f.invoke(f.runtime());
      expect(result.status).toBe("applied");
      expect(await f.native.recovery.listOperations(f.workspaceId, "integration"))
        .toEqual([expect.objectContaining({ state: "complete" })]);
      expect(await readFile(join(f.directory, "code.txt"), "utf8")).toBe("parent first\nsecond\nthird\nfourth\nchild fifth\n");
      expect(await readFile(join(f.directory, "new-api.txt"), "utf8")).toBe("NEW_PARENT_API\n");
      expect(await readFile(join(f.directory, "conflict.txt"), "utf8")).toBe("child change\n");
      expect(result.conflicts).toContainEqual(expect.objectContaining({ path: "conflict.txt" }));
      const current = await f.registry.getThreadById(f.workspaceId, f.child.id);
      expect(current?.worktree?.baselineUpdate).toBeUndefined();
      await f.native.workingStates.withBranchStore(f.workspaceId, "verify", async (store) => {
        const before = await store.readPath(f.parentBranchId, "code.txt", { revision: f.result.first.resultRevision });
        expect((await store.readContent(before!))?.toString()).toBe("first\nsecond\nthird\nfourth\nfifth\n");
        const child = (await store.getBranchRoot(f.childBranchId))!;
        const parent = (await store.getResult(f.parentBranchId, f.result.second.resultRevision))!;
        expect(child.baseRoot).toBe(parent.root);
        const latest = await store.publishDirectoryResult(f.childBranchId, f.directory);
        expect(latest.changedPaths).not.toContain("new-api.txt");
        expect(latest.changedPaths).toContain("code.txt");
      }, "exclusive", { executionWorkspace: (await f.documents.resolveWorkspace({ path: f.directory })).workspaceId });
      expect((await f.native.client.health()).temporaryObjectOwners).toBe(0);
    } finally { await f.dispose(); }
  });

  for (const failure of ["before-commit", "after-commit", "external-drift"] as const) {
    it(`retains and reconciles the native handoff after ${failure}`, async () => {
      const f = await fixture();
      let fail = true;
      const interrupted: WorkspaceWorkingStateRootAccess = { withBranchStore: (id, purpose, operation, mode, actor) =>
        f.native.workingStates.withBranchStore(id, purpose, (store, context) => operation(new Proxy(store, {
          get(target, property) {
            if (property === "rebaseBranch") return async (...args: Parameters<typeof store.rebaseBranch>) => {
              if (args[0] === f.childBranchId && fail) {
                fail = false;
                if (failure === "after-commit") await target.rebaseBranch(...args);
                throw new Error("injected interrupted handoff");
              }
              return target.rebaseBranch(...args);
            };
            const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
          },
        }), context), mode, actor),
      };
      try {
        const firstRuntime = f.runtime(interrupted);
        await expect(f.invoke(firstRuntime)).rejects.toThrow("injected interrupted handoff");
        expect((await f.registry.getThreadById(f.workspaceId, f.child.id))?.worktree?.baselineUpdate?.phase).toBe("prepared");
        const merged = await readFile(join(f.directory, "code.txt"), "utf8");
        expect(merged).toContain("parent first"); expect(merged).toContain("child fifth");
        await expect(firstRuntime.continueRun({ scopeId: f.workspaceId, parent: { kind: "thread", id: f.parent.id },
          threadId: f.child.id, mode: "fresh", task: "must not run over an unfinished handoff" })).rejects.toThrow(/Finish baseline update/);
        expect(await f.registry.listRuns(f.workspaceId, f.child.id)).toHaveLength(1);
        await firstRuntime.dispose();
        if (failure === "external-drift") {
          await writeFile(join(f.directory, "conflict.txt"), "user changed after interruption\n");
          await expect(f.invoke(f.runtime())).rejects.toThrow(/requires recovery/);
          expect(await readFile(join(f.directory, "conflict.txt"), "utf8")).toBe("user changed after interruption\n");
          expect((await f.registry.getThreadById(f.workspaceId, f.child.id))?.worktree?.baselineUpdate).toBeDefined();
        } else {
          const recovered = await f.invoke(f.runtime());
          expect(recovered.status).toBe("applied");
          expect(await readFile(join(f.directory, "code.txt"), "utf8")).toBe(merged);
          expect((await f.registry.getThreadById(f.workspaceId, f.child.id))?.worktree?.baselineUpdate).toBeUndefined();
        }
      } finally { await f.dispose(); }
    });
  }
});
