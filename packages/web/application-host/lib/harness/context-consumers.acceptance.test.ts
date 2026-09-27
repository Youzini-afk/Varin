import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createObservationCursorStore } from "./observation-cursors.js";
import { createThreadRegistry } from "./thread-registry.js";
import { createZone2DeliveryService, prepareZone2Threads } from "./zone2-threads.js";
import { createContextRetainedService, createZone2AssembleService } from "./harness-services.js";
import type { HarnessServiceHost } from "./service-host.js";
import type { HarnessServiceContext } from "./router.js";
import type { Zone2Material } from "./zone2.js";

const context = (): HarnessServiceContext => ({
  sessionId: "parent", workspaceId: "workspace", authorizedPaths: [], signal: new AbortController().signal,
  actor: { authorityInstanceId: "test", sessionId: "parent", workerId: "worker", workerGeneration: 1,
    workspaceId: "workspace", grantedCapabilities: ["context.session"] },
});

describe("context consumers — presentation and retained-source authority", () => {
  it("retains a kept observation, drops a summarized dependency, and rejects an old delivery callback", async () => {
    const cursors = createObservationCursorStore();
    const first = await cursors.prepare("parent", "shell", "sh_1", async () => ({ cursor: { offset: 10 }, result: null }));
    first.commit();
    const second = await cursors.prepare("parent", "shell", "sh_1", async () => ({ cursor: { offset: 20 }, result: null }));
    second.commit();
    const kept = await cursors.prepare("parent", "diagnostics", "file", async () => ({ cursor: { diagnostics: [] }, result: null }));
    kept.commit();
    const late = await cursors.prepare("parent", "diagnostics", "file", async () => ({ cursor: { diagnostics: ["late"] }, result: null }));
    const service = createContextRetainedService({ observationCursors: cursors } as unknown as HarnessServiceHost);
    await service.handle({ retainedGit: false,
      retainedObservationRefs: [second.observationRef, kept.observationRef] }, context());
    expect(cursors.get("parent", "shell", "sh_1")).toBeNull(); // incremental second needs its initial raw baseline
    expect(cursors.get("parent", "diagnostics", "file")).toMatchObject({ value: { diagnostics: [] } });
    expect(late.commit()).toBe(false);
    cursors.dispose();
  });

  it("the Host emits changed plans/knowledge but not a per-turn usage panel, and does not invent deletion on missing data", async () => {
    const cursors = createObservationCursorStore();
    let material: Zone2Material = { userEdits: [], userCommands: [], newDiagnostics: [], git: null,
      blocks: [{ label: "plan", content: "ORIGINAL_PLAN" }], blocksComplete: true,
      knowledge: [{ id: 5, title: "KNOWN_FACT", trigger: "work" }], contextUsage: { used: 120, window: 300 } };
    const service = createZone2AssembleService({ observationCursors: cursors, zone2Delivery: createZone2DeliveryService(),
      zone2Provider: async () => ({ material, eventCursor: 0 }),
    } as unknown as HarnessServiceHost);
    const params = { sinceTurn: 0, branchEntryIds: [] };
    const first = await service.handle(params, context());
    expect(first.content).toContain("ORIGINAL_PLAN");
    expect(first.content).toContain("KNOWN_FACT");
    expect(first.content).not.toContain("window used");
    expect((await service.handle({ ...params, knownMaterial: first.materialRevisions ?? {} }, context())).content).toBeNull();
    material = { ...material, blocks: [], blocksComplete: false };
    expect((await service.handle({ ...params, knownMaterial: first.materialRevisions ?? {} }, context())).content).toBeNull();
    material = { ...material, blocksComplete: true };
    const removed = await service.handle({ ...params, knownMaterial: first.materialRevisions ?? {} }, context());
    expect(removed.content).toContain("previous version is no longer current");
    expect((await service.handle({ ...params, knownMaterial: { ...first.materialRevisions, ...removed.materialRevisions } }, context())).content).toBeNull();
    material = { ...material, blocks: [{ label: "plan", content: "NEW_PLAN" }] };
    const changed = await service.handle({ ...params, knownMaterial: first.materialRevisions ?? {} }, context());
    expect(changed.content).toContain("NEW_PLAN");
    expect(changed.content).not.toContain("KNOWN_FACT");
    // With no retained raw material after a cut, both are eligible again.
    expect((await service.handle(params, context())).content).toContain("KNOWN_FACT");
    cursors.dispose();
  });

  it("acknowledges only presented message/result material and keeps omitted material pending", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "zone2-presentation-"));
    const registry = createThreadRegistry({ dataDir, hostId: "test" });
    const cursors = createObservationCursorStore();
    try {
      const common = { scopeId: "workspace", parent: { kind: "session" as const, id: "parent" },
        brief: "task", kind: "implementation" as const, createdBy: "agent" as const,
        concurrency: 2, autoRun: true, worktree: "isolated" as const, tools: ["read"], permissions: {} };
      const first = await registry.createThread(common);
      const second = await registry.createThread(common);
      await registry.setWorkingState("workspace", first.id, { branchId: "branch-first", resultRevision: 1 });
      await registry.setWorkingState("workspace", second.id, { branchId: "branch-second", resultRevision: 1 });
      const pending = await prepareZone2Threads({ registry, cursors }, { sessionId: "parent", scopeId: "workspace" });
      expect(pending.result.status === "ready" && pending.result.items.length).toBe(2);
      pending.commitPresented(new Set([first.id]), false);
      const next = await prepareZone2Threads({ registry, cursors }, { sessionId: "parent", scopeId: "workspace" });
      expect(next.result.status === "ready" && next.result.items.map((item) => item.id)).toEqual([second.id]);
      next.abort();
    } finally { cursors.dispose(); await registry.dispose(); await rm(dataDir, { recursive: true, force: true }); }
  });

  it("includes child material for a root session without a project", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "zone2-session-scope-"));
    const registry = createThreadRegistry({ dataDir, hostId: "test" });
    const cursors = createObservationCursorStore();
    try {
      const child = await registry.createThread({
        scopeId: "session:parent",
        parent: { kind: "session", id: "parent" },
        brief: "inspect attachment",
        kind: "discussion",
        createdBy: "agent",
        concurrency: 2,
        autoRun: false,
        worktree: "none",
        tools: [],
        permissions: {},
      });
      await registry.setWorkingState("session:parent", child.id, { branchId: "branch-child", resultRevision: 1 });
      const host = {
        observationCursors: cursors,
        threadRegistry: registry,
        zone2Delivery: createZone2DeliveryService(),
        zone2Provider: async () => ({
          material: { userEdits: [], userCommands: [], newDiagnostics: [], git: null, blocks: [], knowledge: [], contextUsage: null },
          eventCursor: 0,
        }),
      } as unknown as HarnessServiceHost;
      const observer = context();
      observer.workspaceId = null;
      observer.actor.workspaceId = null;

      const assembled = await createZone2AssembleService(host).handle({ sinceTurn: 0, branchEntryIds: [] }, observer);
      expect(assembled.content).toContain(child.id);
    } finally { cursors.dispose(); await registry.dispose(); await rm(dataDir, { recursive: true, force: true }); }
  });
});
