/**
 * Phase 2 e2e integration test — todo and recall tools through the full
 * bridge → router → service → knowledge store chain.
 *
 * Also tests request-boundary Zone 2 injection and context.retained.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { openWorkspaceKnowledge } from "../../../web/application-host/lib/knowledge/store.js";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createTodoTool } from "../../src/harness/todo-tool.js";
import { createRecallTool } from "../../src/harness/recall-tool.js";
import { attachContextRequestBoundary } from "../../src/harness/context-request-boundary.js";
import { createRequestContextInjector } from "../../src/harness/request-context.js";
import { SessionManager, convertToLlm, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, normalizeContext, type Api, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai";
import type { Zone2Material } from "../../../web/application-host/lib/harness/zone2.js";
import type { TodoToolDeps } from "../../../web/application-host/lib/harness/todo-tool.js";
import type { RecallToolDeps } from "../../../web/application-host/lib/harness/recall-tool.js";

const SESSION_ID = "p2-e2e-session";
const WORKSPACE_ID = "p2-e2e-workspace";
const ACTOR = { authorityInstanceId: "test-authority", sessionId: SESSION_ID, workerId: "test-worker", workerGeneration: 1 } as const;
const CAPABILITIES = ["context.session", "read.lsp", "read.output"] as const;

async function setupP2E2E() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "p2-e2e-"));
  const dataDir = mkdtempSync(join(tmpdir(), "p2-e2e-data-"));

  // Open a real knowledge store
  const knowledgeStore = await openWorkspaceKnowledge({
    dataDir,
    hostId: "test-host",
    workspaceId: WORKSPACE_ID,
    embedding: null,
  });

  // Seed a knowledge node for recall
  await knowledgeStore.putKnowledge({
    scope: "workspace",
    status: "accepted",
    content: "Always use typebox for schemas",
    trigger: "schema typebox",
  });

  // Zone 2 provider — returns material with a knowledge hit
  async function zone2Provider(): Promise<{ eventCursor: number; material: Zone2Material }> {
    return { eventCursor: 7, material: {
      userEdits: [{ path: "src/index.ts", kind: "modified" }],
      userCommands: [],
      newDiagnostics: [],
      git: { branch: "main", changed: 1 },
      knowledge: [],
      blocks: [{ label: "plan", content: "- [ ] test e2e" }],
      contextUsage: { used: 5000, window: 200000 },
    } };
  }

  // Todo deps provider
  async function todoDepsProvider(sessionId: string): Promise<TodoToolDeps> {
    return {
      store: knowledgeStore,
      sessionId,
    };
  }

  // Recall deps provider
  async function recallDepsProvider(_sessionId: string): Promise<RecallToolDeps> {
    return {
      workspaceStore: knowledgeStore,
      userStore: null,
    };
  }

  const harnessServiceHost = createHarnessServiceHost({
    search: async () => ({ status: "empty" as const, generation: undefined }),
    resolveWorkspaceRoot: async () => workspaceRoot,
    discoveredShells: {
      hasBash: process.platform !== "win32",
      hasPowerShell: process.platform === "win32",
    },
    knowledgeStore,
    zone2Provider,
    todoDepsProvider,
    recallDepsProvider,
  });
  harnessServiceHost.registerSession({ actor: ACTOR, grantedCapabilities: CAPABILITIES, workspaceId: WORKSPACE_ID, workspaceRoot });

  const bridgeState: { current?: HostServicesBridge } = {};
  const router = createHarnessRouter({
    respond: async (identity, requestId, outcome) => {
      bridgeState.current?.respond(identity.sessionId, requestId, outcome);
    },
    resolveActor: (identity) => harnessServiceHost.resolveActor(identity),
  });
  registerHarnessServices(router, harnessServiceHost);

  const bridge = new HostServicesBridge({
    emit: (_event, data) => {
      void router.processEvent({
        actor: ACTOR,
        kind: "host",
        envelope: { kind: "event", event: "harness.request", data },
      });
    },
    sessionId: SESSION_ID,
    defaultTimeoutMs: 10000,
  });
  bridgeState.current = bridge;

  return { workspaceRoot, dataDir, knowledgeStore, harnessServiceHost, router, bridge };
}

async function executeTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<{ text: string; details: unknown }> {
  const result = await tool.execute(`test-call-${++toolCallSequence}`, params as never, undefined, undefined, {
    sessionManager: { getBranch: () => [] },
  } as never) as { content: Array<{ type: string; text: string }>; details?: unknown };
  return { text: result.content.map((c) => c.text).join("\n"), details: result.details };
}

let toolCallSequence = 0;

describe("Phase 2 e2e integration", () => {
  it("todo tool → bridge → router → service → store: upsert plan", async () => {
    const { workspaceRoot, dataDir, knowledgeStore, bridge, harnessServiceHost } = await setupP2E2E();
    try {
      const todoTool = createTodoTool(bridge);
      const { text } = await executeTool(todoTool, {
        items: [
          { text: "write tests", status: "open" },
          { text: "run tests", status: "done" },
        ],
        confidence: 0.8,
      });

      assert.match(text, /plan updated/, `todo tool should return "plan updated": got "${text}"`);
      assert.match(text, /1\/2 done/, `todo tool should report 1/2 done: got "${text}"`);

      // Verify the plan block was written to the store
      const blocks = await knowledgeStore.getBlocks(SESSION_ID);
      const planBlock = blocks.find((b) => b.label === "plan");
      assert.ok(planBlock, "plan block should exist in store");
      assert.match(planBlock!.content, /write tests/, "plan block should contain 'write tests'");
      assert.match(planBlock!.content, /\[x\] run tests/, "plan block should mark 'run tests' as done");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("recall tool → bridge → router → service → store: search knowledge", async () => {
    const { workspaceRoot, dataDir, bridge, harnessServiceHost } = await setupP2E2E();
    try {
      const recallTool = createRecallTool(bridge, SESSION_ID);
      const { text, details } = await executeTool(recallTool, {
        query: "typebox schema",
        k: 5,
      });

      assert.match(text, /memories for/, `recall tool should return memories: got "${text}"`);
      assert.match(text, /Always use typebox/, `recall tool should find seeded knowledge: got "${text}"`);

      const detailsObj = details as { count: number; results: Array<{ scope: string; title: string }> };
      assert.ok(detailsObj.count > 0, "recall details should have count > 0");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("request boundary → bridge → router → service: injects and retains assembled Zone 2 content", async () => {
    const { workspaceRoot, dataDir, bridge, harnessServiceHost } = await setupP2E2E();
    let boundary: ReturnType<typeof attachContextRequestBoundary> | undefined;
    try {
      const model = {
        provider: "faux", id: "faux-1", api: "openai-completions", contextWindow: 100_000, maxTokens: 400,
      } as Model<Api>;
      const manager = SessionManager.inMemory(workspaceRoot);
      manager.appendMessage({ role: "user", content: "What is the current plan?", timestamp: Date.now() });
      const outgoing: Context[] = [];
      const response: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "ok" }], stopReason: "stop", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const session = {
        model,
        sessionId: manager.getSessionId(),
        sessionManager: manager,
        agent: {
          streamFunction: async (_model: Model<Api>, context: Context) => {
            outgoing.push(structuredClone(context));
            const stream = createAssistantMessageEventStream();
            stream.push({ type: "start", partial: response });
            stream.push({ type: "done", reason: "stop", message: response });
            return stream;
          },
          convertToLlm,
          state: { systemPrompt: "stable", tools: [], thinkingLevel: "off", messages: manager.buildSessionContext().messages },
        },
      } as unknown as AgentSession;
      boundary = attachContextRequestBoundary(session, {
        getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 50 }),
        observe: () => undefined,
        compact: async () => { throw new Error("unexpected compaction"); },
        inject: createRequestContextInjector(bridge),
      });
      const stream = await session.agent.streamFunction(model, normalizeContext({
        systemPrompt: "stable",
        messages: convertToLlm(manager.buildSessionContext().messages),
      }), {});
      await stream.result();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const providerMessages = JSON.stringify(outgoing[0]?.messages ?? []);
      assert.match(providerMessages, /varin-context/, "assembled Zone 2 content must reach the provider request");
      assert.match(providerMessages, /plan/, "the current plan must reach the provider request");
      assert.match(providerMessages, /varin-status/, "the request boundary must append a transient current roster status");
      const retained = manager.getBranch().filter((entry) => entry.type === "custom_message");
      assert.equal(retained.length, 1, "delivered environment content must become one durable receipt");
      assert.match(JSON.stringify(retained), /varin-context/);
      assert.doesNotMatch(JSON.stringify(retained), /varin-status/, "the current roster must remain request-scoped");
    } finally {
      boundary?.dispose();
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });

  it("context.retained → bridge → router → service: returns acknowledged", async () => {
    const { workspaceRoot, dataDir, bridge, harnessServiceHost } = await setupP2E2E();
    try {
      const result = await bridge.request("context.retained", {
        retainedObservationRefs: [],
        retainedGit: false,
      });
      assert.equal(result.acknowledged, true, "context.retained should return acknowledged: true");
    } finally {
      await harnessServiceHost.dispose();
      try { rmSync(workspaceRoot, { recursive: true, force: true }); } catch { /* Windows */ }
      try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows */ }
    }
  });
});
