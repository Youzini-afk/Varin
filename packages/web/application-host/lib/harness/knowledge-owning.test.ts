import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { HarnessActorContext } from "@varin/protocol";
import { openWorkspaceKnowledge } from "../knowledge/store.js";
import { createKnowledgeContextRuntime } from "../knowledge/context-runtime.js";
import { createKnowledgeSuggestService, createRecallSearchService } from "./harness-services.js";
import { DEFAULT_SUGGESTIONS_SETTINGS } from "./knowledge-suggestions.js";
import { createHarnessServiceHost } from "./service-host.js";
import type { HarnessServiceContext } from "./router.js";
import { createThreadRegistry } from "./thread-registry.js";

describe("thread knowledge owning workspace", () => {
  const cleanup: Array<() => unknown | Promise<unknown>> = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
  });

  it("routes recall, suggestions, and Zone 2 knowledge to the owning store after snapshot binds execution first", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "varin-knowledge-owning-"));
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const owningStore = await openWorkspaceKnowledge({
      dataDir,
      hostId: "host",
      workspaceId: "owning-ws",
      embedding: null,
    });
    const executionStore = await openWorkspaceKnowledge({
      dataDir,
      hostId: "host",
      workspaceId: "execution-ws",
      embedding: null,
    });
    cleanup.push(() => owningStore.close(), () => executionStore.close());
    await owningStore.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Owning workspace fact",
      trigger: "owning",
    });
    await executionStore.putKnowledge({
      scope: "workspace",
      status: "accepted",
      content: "Execution workspace fact",
      trigger: "execution",
    });

    const registry = createThreadRegistry({ dataDir, hostId: "host" });
    cleanup.push(() => registry.dispose());
    const thread = await registry.createThread({
      scopeId: "owning-ws",
      parent: { kind: "session", id: "root-session" },
      brief: "nested worker",
      preset: "hard-implement",
      kind: "implementation",
      createdBy: "agent",
      concurrency: 2,
      autoRun: true,
      worktree: "isolated",
      tools: ["read"],
      permissions: {},
    });
    const run = await registry.startRun("owning-ws", thread.id);

    const stores = new Map([
      ["owning-ws", owningStore],
      ["execution-ws", executionStore],
    ]);
    const runtime = createKnowledgeContextRuntime({
      getStore: async (workspaceId) => stores.get(workspaceId) ?? null,
    });
    cleanup.push(() => runtime.dispose());
    runtime.bindSession("child-session", "execution-ws");

    const owningKnowledgeWorkspaceIdForSession = async (
      sessionId: string,
      fallback: string | null,
    ): Promise<string | null> => {
      const binding = await registry.getSessionBinding(sessionId);
      return binding?.owningScopeId ?? fallback;
    };

    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => null,
      discoveredShells: {},
      threadRegistry: registry,
      recallDepsProvider: async (sessionId, workspaceId) => {
        const owningWorkspaceId = await owningKnowledgeWorkspaceIdForSession(sessionId, workspaceId);
        if (!owningWorkspaceId) throw new Error("No knowledge workspace for session");
        const workspaceStore = stores.get(owningWorkspaceId);
        if (!workspaceStore) throw new Error(`Missing knowledge store: ${owningWorkspaceId}`);
        return { workspaceStore, userStore: null, workspaceId: owningWorkspaceId };
      },
      knowledgeSuggestDepsProvider: async (sessionId, workspaceId) => {
        const owningWorkspaceId = await owningKnowledgeWorkspaceIdForSession(sessionId, workspaceId);
        if (!owningWorkspaceId || owningWorkspaceId === "user") return null;
        const store = stores.get(owningWorkspaceId);
        if (!store) return null;
        return { store, settings: DEFAULT_SUGGESTIONS_SETTINGS };
      },
    });
    cleanup.push(() => host.dispose());

    const actor: HarnessActorContext = {
      authorityInstanceId: "host",
      sessionId: "child-session",
      workerId: "worker",
      workerGeneration: 1,
      workspaceId: "execution-ws",
      grantedCapabilities: ["context.session"],
    };
    const ctx = (signal: AbortSignal): HarnessServiceContext => ({
      actor,
      sessionId: actor.sessionId,
      workspaceId: actor.workspaceId,
      signal,
      authorizedPaths: [],
    });

    const beforeBinding = await runtime.zone2Material({
      sessionId: "child-session",
      sinceTurn: 0,
      contextUsage: null,
      query: "workspace fact",
    });
    expect(beforeBinding.material.knowledge.map((item) => item.title)).toEqual(["Execution workspace fact"]);

    await registry.markRunRunning("owning-ws", thread.id, run.id, "child-session");
    runtime.bindSession("child-session", "owning-ws");

    const recalled = await createRecallSearchService(host).handle(
      { query: "workspace fact" },
      ctx(new AbortController().signal),
    );
    expect(recalled.results.map((item) => item.title)).toEqual(["Owning workspace fact"]);

    const suggestedStores: string[] = [];
    const suggestingHost = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => null,
      discoveredShells: {},
      threadRegistry: registry,
      knowledgeSuggestDepsProvider: async (sessionId, workspaceId) => {
        const owningWorkspaceId = await owningKnowledgeWorkspaceIdForSession(sessionId, workspaceId);
        if (!owningWorkspaceId || owningWorkspaceId === "user") return null;
        suggestedStores.push(owningWorkspaceId);
        const store = stores.get(owningWorkspaceId);
        if (!store) return null;
        return { store, settings: DEFAULT_SUGGESTIONS_SETTINGS };
      },
    });
    cleanup.push(() => suggestingHost.dispose());
    const suggested = await createKnowledgeSuggestService(suggestingHost).handle({
      content: "Remember owning convention",
      trigger: "owning",
    }, ctx(new AbortController().signal));
    expect(suggested.created).toBe(true);
    expect(suggestedStores).toEqual(["owning-ws"]);

    const afterRebind = await runtime.zone2Material({
      sessionId: "child-session",
      sinceTurn: 0,
      contextUsage: null,
      query: "workspace fact",
    });
    expect(afterRebind.material.knowledge.map((item) => item.title)).toEqual(["Owning workspace fact"]);
  });
});
