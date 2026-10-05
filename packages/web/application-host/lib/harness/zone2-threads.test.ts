import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ThreadReport } from "@varin/protocol";
import { createObservationCursorStore } from "./observation-cursors.js";
import { createThreadRegistry, ThreadRegistryError, type CreateThreadInput } from "./thread-registry.js";
import { projectZone2Threads } from "./zone2-threads.js";
import { createZone2StatusService } from "./harness-services.js";
import type { HarnessServiceHost } from "./service-host.js";

const WORKSPACE = "workspace-1";
const PARENT = { kind: "session", id: "parent-1" } as const;

const input = (overrides: Partial<CreateThreadInput> = {}): CreateThreadInput => ({
  scopeId: WORKSPACE,
  parent: PARENT,
  brief: "verify the implementation",
  preset: "worker",
  kind: "implementation",
  createdBy: "agent",
  concurrency: 12,
  autoRun: true,
  worktree: "isolated",
  tools: [],
  permissions: {},
  ...overrides,
});

const report = (): ThreadReport => ({
  conclusion: "all checks pass",
  changedFiles: ["a.ts"],
  unresolved: [],
  deviations: ["used the existing adapter"],
  confidence: 0.9,
  transcriptRef: { runtimeId: "pi", sessionId: "child-1", fromEntryId: null, toEntryId: null },
  blocksSnapshot: {},
});

describe("Zone 2 thread projection", () => {
  let dataDir: string;
  let registry: ReturnType<typeof createThreadRegistry>;
  let cursors: ReturnType<typeof createObservationCursorStore>;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "zone2-threads-"));
    registry = createThreadRegistry({ dataDir, hostId: "test-host" });
    cursors = createObservationCursorStore();
  });

  afterEach(async () => {
    cursors.dispose();
    await registry.dispose();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it("emits active and settled facts only when they change", async () => {
    const thread = await registry.createThread(input());
    const run = await registry.startRun(WORKSPACE, thread.id);
    await registry.markRunRunning(WORKSPACE, thread.id, run.id, "child-1");
    await registry.updateRunProgress(WORKSPACE, thread.id, {
      steps: 3,
      lastToolCall: { name: "read", at: new Date().toISOString() },
    });

    const options = { registry, cursors };
    const first = await projectZone2Threads(options, { sessionId: PARENT.id, scopeId: WORKSPACE });
    const second = await projectZone2Threads(options, { sessionId: PARENT.id, scopeId: WORKSPACE });
    expect(first.status === "ready" ? first.items : []).toMatchObject([{ id: thread.id, workerState: "running", steps: 3 }]);
    expect(second.status === "ready" ? second.items : []).toHaveLength(0);

    await registry.completeThread(WORKSPACE, thread.id, report());
    const completed = await projectZone2Threads(options, { sessionId: PARENT.id, scopeId: WORKSPACE });
    const unchanged = await projectZone2Threads(options, { sessionId: PARENT.id, scopeId: WORKSPACE });
    expect(completed.status === "ready" ? completed.items : []).toMatchObject([{ id: thread.id, outcome: "success", conclusion: "all checks pass" }]);
    expect(unchanged).toEqual({ status: "ready", items: [] });
  });

  it("uses the owning Thread as parent when a child session opens a nested thread", async () => {
    const outer = await registry.createThread(input());
    const run = await registry.startRun(WORKSPACE, outer.id);
    await registry.markRunRunning(WORKSPACE, outer.id, run.id, "child-session");
    const nested = await registry.createThread(input({
      parent: { kind: "thread", id: outer.id },
      brief: "nested check",
      autoRun: false,
      worktree: "none",
    }));
    const result = await projectZone2Threads({ registry, cursors }, { sessionId: "child-session", scopeId: "execution-ws" });
    expect(result.status === "ready" ? result.items.map((item) => item.id) : []).toEqual([nested.id]);
    const root = await projectZone2Threads({ registry, cursors }, { sessionId: PARENT.id, scopeId: WORKSPACE });
    expect(root.status === "ready" ? root.items.map((item) => item.id) : []).toEqual([outer.id]);
  });

  it("keeps a registry failure distinct from an empty thread list", async () => {
    const host = {
      observationCursors: cursors,
      threadRegistry: {
        getSessionBinding: async () => null,
        listThreadSnapshots: async () => { throw new ThreadRegistryError("corrupt", "bad catalog", "catalog.json"); },
      },
      zone2Provider: async () => ({
        eventCursor: 0,
        material: {
          userEdits: [], userCommands: [], newDiagnostics: [], git: null,
          knowledge: [], blocks: [], contextUsage: null,
        },
      }),
    } as unknown as HarnessServiceHost;
    const result = await createZone2StatusService(host).handle({}, {
      actor: {
        authorityInstanceId: "authority",
        sessionId: PARENT.id,
        workerId: "worker",
        workerGeneration: 1,
        workspaceId: WORKSPACE,
        grantedCapabilities: ["context.session"],
      },
      authorizedPaths: [],
      sessionId: PARENT.id,
      workspaceId: WORKSPACE,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("unavailable");
    expect(result.content).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  it("calculates overlapWarning when multiple active threads touch overlapping paths", async () => {
    await registry.createThread(input({
      brief: "task 1",
      scope: ["packages/web/index.ts", "packages/web/utils.ts"],
      worktree: "none",
    }));
    await registry.createThread(input({
      brief: "task 2",
      scope: ["packages/web/utils.ts", "packages/web/other.ts"],
      worktree: "none",
    }));

    const options = { registry, cursors };
    const result = await projectZone2Threads(options, { sessionId: PARENT.id, scopeId: WORKSPACE });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.overlapWarning).toBeDefined();
      expect(result.overlapWarning).toContain("overlap on packages/web/utils.ts");
    }
  });
});
