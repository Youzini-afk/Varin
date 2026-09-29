import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createKnowledgeContextRuntime } from "./context-runtime.js";
import { zone2MaterialRevision } from "../harness/zone2-material.js";
import { createGitStatusObserver } from "./git-status-runtime.js";
import { openWorkspaceKnowledge, type KnowledgeStore } from "./store.js";
import { createTerminalCommandObserveAdapter, createTerminalCommandProjector } from "./terminal-projection.js";
import type { TerminalCommandRecord } from "../terminal/session-api.js";

const TEST_DIR = join(tmpdir(), "varin-knowledge-context-runtime");

describe("knowledge context runtime", () => {
  let store: KnowledgeStore;

  beforeEach(async () => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    store = await openWorkspaceKnowledge({
      dataDir: TEST_DIR,
      hostId: "host-1",
      workspaceId: "workspace-1",
      embedding: null,
    });
  });

  afterEach(async () => {
    await store.close();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("fans a user document mutation out to each session and advances an event cursor", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    runtime.bindSession("session-b", "workspace-1");
    runtime.observeDocumentMutation({
      workspaceId: "workspace-1",
      resourceId: "src/user.ts",
      kind: "modified",
      owner: { kind: "web-route", id: "editor" },
    });
    const first = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      contextUsage: { used: 200, window: 1000 },
    });
    expect(first.material.userEdits).toEqual([{ path: "src/user.ts", kind: "modified" }]);
    expect(first.material.contextUsage).toEqual({ used: 200, window: 1000 });
    expect(first.eventCursor).toBeGreaterThan(0);
    await expect(runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      afterEventId: first.eventCursor,
      contextUsage: null,
    })).resolves.toMatchObject({ material: { userEdits: [] } });
    await expect(runtime.zone2Material({
      sessionId: "session-b",
      sinceTurn: 0,
      contextUsage: null,
    })).resolves.toMatchObject({ material: { userEdits: [{ path: "src/user.ts" }] } });
    await runtime.dispose();
  });

  it("projects only prompt-relevant accepted knowledge into Zone 2", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Use Vitest for component tests",
      trigger: "vitest component tests",
    });
    await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Unrelated release policy",
      trigger: "publishing releases",
    });
    const result = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      query: "fix the vitest component tests",
      contextUsage: null,
    });
    expect(result.material.knowledge).toHaveLength(1);
    expect(result.material.knowledge[0]?.title).toContain("Vitest");
    await runtime.dispose();
  });

  it("reuses same-query recall until the store knowledge revision changes", async () => {
    const id = await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Use the cache-aware path",
      trigger: "cache path",
    });
    let recalls = 0;
    const runtime = createKnowledgeContextRuntime({
      getStore: async () => store,
      recall: async ({ store: current, query }) => {
        recalls += 1;
        return current.recall(query, 5);
      },
    });
    runtime.bindSession("session-a", "workspace-1");
    await runtime.zone2Material({ sessionId: "session-a", sinceTurn: 0, query: "cache path", contextUsage: null });
    await runtime.zone2Material({ sessionId: "session-a", sinceTurn: 0, query: "cache path", contextUsage: null });
    expect(recalls).toBe(1);
    await store.updateAcceptedKnowledge(id, {
      content: "Use the revised cache-aware path",
      trigger: "cache path",
    }, "workspace", {
      content: "Use the cache-aware path",
      trigger: "cache path",
      status: "accepted",
      invalidAt: null,
    });
    const changed = await runtime.zone2Material({ sessionId: "session-a", sinceTurn: 0, query: "cache path", contextUsage: null });
    expect(recalls).toBe(2);
    expect(changed.material.knowledge[0]?.title).toContain("revised");
    await runtime.dispose();
  });

  it("delivers shell completion facts once and respects retained execution receipts", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    runtime.observeShellCompletion("session-a", {
      command: "bun test",
      commandRunId: "sh_1",
      executionId: "exec-1",
      cwd: "/workspace",
      startedAt: 10,
      endedAt: 20,
      exitCode: 1,
      cancelled: false,
    });
    await runtime.drain();
    const first = await runtime.zone2Material({ sessionId: "session-a", sinceTurn: 0, contextUsage: null });
    expect(first.material.shellCompletions).toEqual([expect.objectContaining({ executionId: "exec-1", exitCode: 1 })]);
    expect(first.shellCompletions).toEqual(["exec-1"]);
    const retained = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      afterEventId: first.eventCursor,
      observedShellExecutions: ["exec-1"],
      contextUsage: null,
    });
    expect(retained.material.shellCompletions).toBeUndefined();
    await runtime.dispose();
  });

  it("emits an explicit invalidation when retained knowledge is retired", async () => {
    const id = await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Retire this fact",
      trigger: "retire fact",
    });
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    await runtime.zone2Material({ sessionId: "session-a", sinceTurn: 0, query: "retire fact", contextUsage: null });
    await store.retireKnowledge(id, "workspace", {
      content: "Retire this fact",
      trigger: "retire fact",
      status: "accepted",
      invalidAt: null,
    });
    await runtime.dispose();
    const rebuilt = createKnowledgeContextRuntime({ getStore: async () => store });
    rebuilt.bindSession("session-a", "workspace-1");
    const retired = await rebuilt.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      query: "retire fact",
      knownMaterial: {
        ["knowledge:workspace:" + id]: zone2MaterialRevision({ id, scope: "workspace", title: "Retire this fact", trigger: "retire fact" }),
      },
      contextUsage: null,
    });
    expect(retired.material.knowledgeInvalidations).toEqual([{ id, scope: "workspace" }]);
    await rebuilt.dispose();
  });

  it("delivers a superseding row as an explicit correction beside the invalidation", async () => {
    const id = await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "The deadline is Friday",
      trigger: "release deadline",
    });
    const superseded = await store.supersedeKnowledge(id, {
      scope: "workspace",
      status: "accepted",
      content: "The deadline moved to Monday",
      trigger: "release deadline",
    });
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    const result = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      query: "release deadline",
      knownMaterial: {
        [`knowledge:workspace:${id}`]: zone2MaterialRevision({ id, scope: "workspace", title: "The deadline is Friday", trigger: "release deadline" }),
      },
      contextUsage: null,
    });
    expect(result.material.knowledgeInvalidations).toEqual([{ id, scope: "workspace" }]);
    expect(result.material.knowledgeCorrections).toEqual([{
      id: superseded.id,
      scope: "workspace",
      supersedes: id,
      title: "The deadline moved to Monday",
      trigger: "release deadline",
    }]);
    await runtime.dispose();
  });

  it("recognizes retained bot- and session-scope rows for invalidation", async () => {
    const id = await store.putKnowledge({
      scope: "bot",
      status: "accepted",
      content: "Bot-owned fact",
      trigger: "bot fact",
    });
    await store.retireKnowledge(id, "bot", {
      content: "Bot-owned fact",
      trigger: "bot fact",
      status: "accepted",
      invalidAt: null,
    });
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    const result = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      knownMaterial: { [`knowledge:bot:${id}`]: "whatever-was-delivered" },
      contextUsage: null,
    });
    expect(result.material.knowledgeInvalidations).toEqual([{ id, scope: "bot" }]);
    await runtime.dispose();
  });

  it("composes the recall query from the owning work's goal plus the latest message", async () => {
    await store.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Store layer migration decisions",
      trigger: "migration runbook",
    });
    const queries: string[] = [];
    const runtime = createKnowledgeContextRuntime({
      getStore: async () => store,
      goalForSession: async () => "migrate the store layer",
      recall: async ({ query }) => { queries.push(query); return store.recall(query, 5); },
    });
    runtime.bindSession("session-a", "workspace-1");
    const result = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      query: "keep going",
      contextUsage: null,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("migrate the store layer");
    expect(queries[0]).toContain("keep going");
    expect(result.material.knowledge[0]?.title).toContain("Store layer migration");
    await runtime.dispose();
  });

  it("keeps agent-authored events out of Zone 2 while preserving current blocks", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    await store.upsertBlock({
      sessionId: "session-a",
      label: "plan",
      content: "- [ ] keep working",
      updatedBy: "agent",
    });
    runtime.observeDocumentMutation({
      workspaceId: "workspace-1",
      resourceId: "src/agent.ts",
      kind: "created",
      owner: { kind: "pi-worker", id: "worker-1" },
    });
    await runtime.drain();

    const result = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      contextUsage: null,
    });
    expect(result.material.userEdits).toEqual([]);
    expect(result.material.blocks).toEqual([{ label: "plan", content: "- [ ] keep working" }]);
    expect(result.eventCursor).toBeGreaterThan(0);
    await runtime.dispose();
  });

  it("records diagnostics only when they follow a user-authored change", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    runtime.observeDocumentMutation({
      workspaceId: "workspace-1",
      resourceId: "src/user.ts",
      kind: "modified",
      owner: { kind: "web-route", id: "editor" },
    });
    runtime.observeDiagnostics({
      workspaceId: "workspace-1",
      sessionId: "lsp",
      path: "src/user.ts",
      count: 2,
      worst: "error",
    });
    runtime.observeDocumentMutation({
      workspaceId: "workspace-1",
      resourceId: "src/agent.ts",
      kind: "modified",
      owner: { kind: "pi-worker", id: "worker" },
    });
    runtime.observeDiagnostics({
      workspaceId: "workspace-1",
      sessionId: "lsp",
      path: "src/agent.ts",
      count: 1,
      worst: "error",
    });
    await runtime.drain();

    const result = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      contextUsage: null,
    });
    expect(result.material.newDiagnostics).toEqual([{ path: "src/user.ts", count: 2, worst: "error" }]);
    await runtime.dispose();
  });

  it("records Git state changes once per session instead of repeating status polls", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    runtime.observeGitStatus({ workspaceId: "workspace-1", branch: "main", changed: 0 });
    await runtime.drain();
    const first = await runtime.zone2Material({ sessionId: "session-a", sinceTurn: 0, contextUsage: null });
    expect(first.material.git).toEqual({ branch: "main", changed: 0 });

    runtime.observeGitStatus({ workspaceId: "workspace-1", branch: "main", changed: 0 });
    await runtime.drain();
    const duplicate = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      afterEventId: first.eventCursor,
      contextUsage: null,
    });
    expect(duplicate.material.git).toBeNull();
    expect(duplicate.eventCursor).toBe(first.eventCursor);

    runtime.resetSessionObservationBaselines("session-a");
    runtime.observeGitStatus({ workspaceId: "workspace-1", branch: "main", changed: 0 });
    await runtime.drain();
    const reset = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      afterEventId: first.eventCursor,
      contextUsage: null,
    });
    expect(reset.material.git).toEqual({ branch: "main", changed: 0 });

    runtime.observeGitStatus({ workspaceId: "workspace-1", branch: "feature", changed: 2, note: "1 ahead" });
    await runtime.drain();
    const changed = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      afterEventId: reset.eventCursor,
      contextUsage: null,
    });
    expect(changed.material.git).toEqual({ branch: "feature", changed: 2, note: "1 ahead" });
    await runtime.dispose();
  });

  it("carries a raw Git route snapshot through workspace resolution into Zone 2", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    const observer = createGitStatusObserver({
      resolveWorkspaceId: async (scope) => scope === "/workspace/repo" ? "workspace-1" : null,
      observe: (event) => runtime.observeGitStatus(event),
    });
    observer("/workspace/repo", {
      current: "feature/git-observation",
      files: [{ path: "a.ts" }, { path: "b.ts" }],
      ahead: 1,
      behind: 0,
    });
    await Promise.resolve();
    await runtime.drain();
    const result = await runtime.zone2Material({ sessionId: "session-a", sinceTurn: 0, contextUsage: null });
    expect(result.material.git).toEqual({ branch: "feature/git-observation", changed: 2, note: "1 ahead" });
    await runtime.dispose();
  });

  it("projects a user terminal command into Zone 2 once and keeps harness commands out", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    runtime.observeTerminalCommand({
      workspaceId: "workspace-1",
      sessionId: "term-1",
      command: "echo hi",
      commandId: "term-1:1:1",
      cwd: "/workspace",
      exitCode: 0,
      source: "user",
      integration: "osc-633",
      endedAt: Date.now(),
    });
    runtime.observeTerminalCommand({
      workspaceId: "workspace-1",
      sessionId: "term-1",
      command: "echo hi",
      commandId: "term-1:1:1",
      exitCode: 0,
      source: "user",
      integration: "osc-633",
    });
    runtime.observeTerminalExit({
      workspaceId: "workspace-1",
      sessionId: "sh_1",
      command: "agent-build",
      commandId: "sh_1:1:1",
      exitCode: 0,
      source: "harness",
    });
    await runtime.drain();
    const first = await runtime.zone2Material({ sessionId: "session-a", sinceTurn: 0, contextUsage: null });
    expect(first.material.userCommands).toEqual([
      expect.objectContaining({ command: "echo hi", exitCode: 0, cwd: "/workspace" }),
    ]);
    const second = await runtime.zone2Material({
      sessionId: "session-a",
      sinceTurn: 0,
      afterEventId: first.eventCursor,
      contextUsage: null,
    });
    expect(second.material.userCommands).toEqual([]);
    expect(second.eventCursor).toBe(first.eventCursor);
    expect(runtime.listBoundSessions("workspace-1")).toEqual(["session-a"]);
    await runtime.dispose();
  });

  it("production adapter projects one command independently to every bound session", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    runtime.bindSession("session-b", "workspace-1");
    const projector = createTerminalCommandProjector({
      resolveWorkspaceId: async () => "workspace-1",
      observe: createTerminalCommandObserveAdapter(runtime),
      drain: () => runtime.drain(),
      listBoundSessions: (workspaceId) => runtime.listBoundSessions(workspaceId),
    });
    const record: TerminalCommandRecord = {
      command: "echo fanout",
      commandId: "term-fanout:0:1",
      cwd: "/workspace",
      endedAt: 10,
      exitCode: 0,
      integration: "osc-633",
      owner: "user",
      terminalId: "term-fanout",
    };

    await expect(projector.project(record)).resolves.toEqual({ "session-a": true, "session-b": true });
    expect((await store.listEvents({ sessionId: "session-a" })).filter((event) => event.kind === "command")).toHaveLength(1);
    expect((await store.listEvents({ sessionId: "session-b" })).filter((event) => event.kind === "command")).toHaveLength(1);
    await expect(projector.project(record)).resolves.toEqual({ "session-a": false, "session-b": false });
    await runtime.dispose();
  });

  it("does not retain a commandId after a failed durable write", async () => {
    const runtime = createKnowledgeContextRuntime({ getStore: async () => store });
    runtime.bindSession("session-a", "workspace-1");
    const putEvent = store.putEvent.bind(store);
    let failuresRemaining = 1;
    store.putEvent = async (input) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("temporary store failure");
      }
      return putEvent(input);
    };
    const event = {
      workspaceId: "workspace-1",
      sessionId: "term-retry",
      command: "echo retry",
      commandId: "term-retry:0:1",
      exitCode: 0,
      source: "user" as const,
    };
    await expect(runtime.observeTerminalCommand(event)).rejects.toThrow("temporary store failure");
    await expect(runtime.observeTerminalCommand(event)).resolves.toBe(true);
    expect((await store.listEvents({ sessionId: "session-a" })).filter((item) => item.kind === "command")).toHaveLength(1);
    await runtime.dispose();
  });

  it("keeps one command event after context-runtime rebuild and does not insert the duplicate", async () => {
    const first = createKnowledgeContextRuntime({ getStore: async () => store });
    first.bindSession("session-a", "workspace-1");
    const event = {
      workspaceId: "workspace-1",
      sessionId: "term-1",
      command: "echo hi",
      commandId: "term-1:1:1",
      cwd: "/workspace",
      exitCode: 0,
      source: "user" as const,
      integration: "osc-633" as const,
      endedAt: Date.now(),
    };
    await expect(first.observeTerminalCommand(event)).resolves.toBe(true);
    await first.dispose();

    const second = createKnowledgeContextRuntime({ getStore: async () => store });
    second.bindSession("session-a", "workspace-1");
    await expect(second.observeTerminalCommand(event)).resolves.toBe(false);
    await second.drain();
    const events = await store.listEvents({ sessionId: "session-a" });
    expect(events.filter((item) => item.kind === "command")).toHaveLength(1);
    await second.dispose();
  });

  it("rebuilds the projector path without a second event", async () => {
    const record: TerminalCommandRecord = {
      command: "echo hi",
      commandId: "term-1:1:1",
      cwd: "/workspace",
      endedAt: 10,
      exitCode: 0,
      integration: "osc-633",
      owner: "user",
      terminalId: "term-1",
    };
    const first = createKnowledgeContextRuntime({ getStore: async () => store });
    first.bindSession("session-a", "workspace-1");
    const firstProjector = createTerminalCommandProjector({
      resolveWorkspaceId: async () => "workspace-1",
      observe: (event) => first.observeTerminalCommand(event),
      drain: () => first.drain(),
      listBoundSessions: (workspaceId) => first.listBoundSessions(workspaceId),
    });
    await firstProjector.project(record);
    await first.dispose();

    const second = createKnowledgeContextRuntime({ getStore: async () => store });
    second.bindSession("session-a", "workspace-1");
    const secondProjector = createTerminalCommandProjector({
      resolveWorkspaceId: async () => "workspace-1",
      observe: (event) => second.observeTerminalCommand(event),
      drain: () => second.drain(),
      listBoundSessions: (workspaceId) => second.listBoundSessions(workspaceId),
    });
    await secondProjector.project(record);
    expect((await store.listEvents({ sessionId: "session-a" })).filter((item) => item.kind === "command")).toHaveLength(1);
    await second.dispose();
  });
});
