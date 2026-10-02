import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PiMessage, SessionSnapshot, SessionStats } from "@varin/protocol";
import { createResearchRootRuntime } from "./research-root-runtime.js";
import { createThreadRegistry } from "./thread-registry.js";

const WORKSPACE = "workspace-research";
const SESSION = "user-session";

const snapshot = (focus: "code" | "research"): SessionSnapshot => ({
  activeTools: ["read", "thread.dispatch", "thread.read"],
  busy: focus === "research",
  cwd: "/workspace",
  features: { revision: 1, schemaVersion: 1 },
  followUp: [],
  followUpMode: "one-at-a-time",
  queuedMessages: [],
  isCompacting: false,
  isStreaming: focus === "research",
  leafId: "entry-2",
  model: {
    api: "responses",
    available: true,
    baseUrl: "https://example.invalid",
    contextWindow: 100_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    id: "current-model",
    input: ["text"],
    maxTokens: 8_000,
    name: "Current model",
    provider: "faux",
    supportedThinkingLevels: [],
  },
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId: SESSION,
  steering: [],
  steeringMode: "all",
  thinkingLevel: "off",
  workspace: { authorityId: WORKSPACE, id: WORKSPACE, kind: "workspace" },
  workFocus: {
    active: { generation: focus === "research" ? 2 : 3, id: focus, source: "explicit" },
    selected: { id: focus, source: "explicit" },
    status: "applied",
  },
});

const stats = (toolCalls = 0): SessionStats => ({
  cost: toolCalls * 0.01,
  sessionId: SESSION,
  tokens: { cacheRead: 0, cacheWrite: 0, input: toolCalls * 10, output: toolCalls * 5, total: toolCalls * 15 },
  totalMessages: 0,
  toolCalls,
  toolResults: toolCalls,
  assistantMessages: 0,
  userMessages: 0,
});

const assistant = (text: string): PiMessage => ({
  api: "responses",
  content: [{ type: "text", text }],
  model: "current-model",
  provider: "faux",
  role: "assistant",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input: 0,
    output: 0,
    totalTokens: 0,
  },
});

const user = (text: string): PiMessage => ({
  content: text,
  role: "user",
  timestamp: Date.now(),
});

describe("research root runtime", () => {
  const dataDirs: string[] = [];

  afterEach(() => {
    for (const directory of dataDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("forwards cancellation while an earlier service request is still executing", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-root-cancel-"));
    dataDirs.push(dataDir);
    const current = snapshot("code");
    const runtime = createResearchRootRuntime({
      registry: createThreadRegistry({ dataDir, hostId: "host" }),
      getSessionSnapshot: () => current,
      sessions: {
        snapshot: async () => current,
        stats: async () => stats(),
        entries: async () => ({ scope: "branch", entries: [], leafId: null, sessionId: SESSION }),
      },
    });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const pending = runtime.processEvent({
      kind: "host", sessionId: SESSION,
      envelope: { kind: "event", event: "harness.request", data: { method: "explore.query.start", requestId: "slow" } },
    }, async () => { enter(); await released; });
    await entered;
    let cancelled = false;
    try {
      const cancellation = runtime.processEvent({
        kind: "host", sessionId: SESSION,
        envelope: { kind: "event", event: "harness.cancel", data: { requestId: "slow" } },
      }, () => { cancelled = true; release(); });
      // Must reach the router without waiting on the service's completion.
      expect(cancelled).toBe(true);
      await cancellation;
    } finally {
      release();
      await pending;
      await runtime.dispose();
    }
  });

  it("binds before forwarding execution events, reuses one root, and never tombstones the user session", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-research-root-"));
    dataDirs.push(dataDir);
    let registry = createThreadRegistry({ dataDir, hostId: "host" });
    let currentSnapshot = snapshot("research");
    let currentStats = stats();
    const runtime = createResearchRootRuntime({
      registry,
      getSessionSnapshot: () => currentSnapshot,
      sessions: {
        snapshot: async () => currentSnapshot,
        stats: async () => currentStats,
        entries: async () => ({
          scope: "branch",
          entries: [
            { id: "entry-user", parentId: null, timestamp: new Date().toISOString(), type: "message", message: user("Which mechanism explains the anomaly?") },
            { id: "entry-1", parentId: "entry-user", timestamp: new Date().toISOString(), type: "message", message: assistant("finding") },
          ],
          leafId: "entry-1",
          sessionId: SESSION,
        }),
      },
    });

    let bindingSeenBeforeForward = false;
    await runtime.processEvent({
      kind: "host",
      sessionId: SESSION,
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "agent_start" } } },
    }, async () => {
      bindingSeenBeforeForward = (await registry.getSessionBinding(SESSION))?.owner === "attached-root";
    });
    expect(bindingSeenBeforeForward).toBe(true);
    const binding = await registry.getSessionBinding(SESSION);
    expect(binding?.owner).toBe("attached-root");
    const root = await registry.getThreadById(WORKSPACE, binding!.threadId);
    expect(root).toMatchObject({ brief: "Which mechanism explains the anomaly?", purpose: "research-root", parent: { kind: "session", id: SESSION } });
    expect((await registry.getActiveRun(WORKSPACE, root!.id))?.frozen).toMatchObject({
      model: { providerId: "faux", modelId: "current-model" },
      tools: ["read", "thread.dispatch", "thread.read"],
      workFocus: "research",
    });

    const branch = await registry.createThread({
      scopeId: WORKSPACE,
      parent: { kind: "thread", id: root!.id },
      brief: "bounded route",
      kind: "discussion",
      createdBy: "agent",
      concurrency: 12,
      worktree: "none",
      tools: ["read"],
      permissions: {},
      autoRun: false,
    });
    expect(branch.manifest.workFocus).toBe("research");

    currentStats = stats(2);
    await runtime.processEvent({
      kind: "host",
      sessionId: SESSION,
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "agent_end", messages: [assistant("finding")], willRetry: false } } },
    }, () => undefined);
    await runtime.processEvent({
      kind: "host",
      sessionId: SESSION,
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "agent_settled" } } },
    }, () => undefined);
    expect(await registry.getSessionBinding(SESSION)).toBeNull();
    expect(await registry.getThreadById(WORKSPACE, root!.id)).toMatchObject({
      lifecycle: "settled",
      report: { conclusion: "finding", transcriptRef: { fromEntryId: "entry-user" } },
    });

    currentSnapshot = snapshot("code");
    await runtime.processEvent({
      kind: "host",
      sessionId: SESSION,
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "agent_start" } } },
    }, () => undefined);
    expect(await registry.getSessionBinding(SESSION)).toBeNull();

    currentSnapshot = snapshot("research");
    await runtime.processEvent({
      kind: "host",
      sessionId: SESSION,
      envelope: { kind: "event", event: "agent.event", data: { event: { type: "agent_start" } } },
    }, () => undefined);
    const rebound = await registry.getSessionBinding(SESSION);
    expect(rebound?.threadId).toBe(root!.id);
    expect((await registry.getActiveRun(WORKSPACE, root!.id))?.attempt).toBe(2);

    await runtime.dispose();
    await registry.dispose();
    registry = createThreadRegistry({ dataDir, hostId: "host" });
    await registry.reconcileAfterHostRestart();
    expect(await registry.getSessionBinding(SESSION)).toBeNull();
    expect((await registry.getActiveRun(WORKSPACE, root!.id))?.outcome).toBe("lost");
    await registry.dispose();
  });
});
