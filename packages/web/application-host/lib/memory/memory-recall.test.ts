import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openKnowledgeStoreEngine, type KnowledgeStoreEngine } from "../knowledge/store-engine.js";
import type { KnowledgeScope } from "../knowledge/store.js";
import { recallSources } from "../knowledge/vectors/index.js";
import { recallMemories, type MemoryRecallFastDecision } from "./memory-recall.js";

const TEST_DIR = mkdtempSync(join(tmpdir(), "varin-memory-recall-"));
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

let counter = 0;
const openStore = async (scope: KnowledgeScope, name = `store-${++counter}`): Promise<KnowledgeStoreEngine> => (
  openKnowledgeStoreEngine({ dataDir: join(TEST_DIR, name), hostId: "test-host", workspaceId: name, scope, embedding: null })
);

const remember = async (
  store: KnowledgeStoreEngine,
  content: string,
  extra: { scope?: KnowledgeScope; threadId?: string; sessionId?: string } = {},
) => {
  const created = await store.createKnowledgeIfAbsent({
    scope: extra.scope ?? "workspace",
    status: "accepted",
    content,
    trigger: "relevant",
    source: { kind: "memory.remember", ...(extra.threadId ? { threadId: extra.threadId } : {}), ...(extra.sessionId ? { sessionId: extra.sessionId } : {}) },
  });
  return created.knowledge;
};

describe("recallSources — scope-generalized candidate selection (BC3)", () => {
  it("returns bot- and session-scope rows with their own labels", async () => {
    const bot = await openStore("bot");
    const session = await openStore("session");
    const user = await openStore("user");
    await remember(bot, "deploys freeze on Fridays", { scope: "bot" });
    await remember(session, "this session chose port 8443", { scope: "session" });
    await remember(user, "user prefers terse answers", { scope: "user" });
    const { results } = await recallSources({
      sources: [
        { authority: bot, scope: "bot", scopeId: "bot:one" },
        { authority: session, scope: "session", scopeId: "session:one" },
        { authority: user, scope: "user", scopeId: "user" },
      ],
      query: "prefers deploys port freeze",
      k: 5,
    });
    const scopes = results.map((r) => r.node.payload.scope).sort();
    expect(scopes).toEqual(["bot", "session", "user"]);
  });

  it("pins work-associated memories ahead of ranked hits even without a text match", async () => {
    const store = await openStore("workspace");
    const bound = await remember(store, "unrelated wording but produced by this work", { threadId: "thr-1" });
    await remember(store, "text match terms galore");
    const { results } = await recallSources({
      sources: [{ authority: store, scope: "workspace", scopeId: "ws" }],
      query: "text match terms",
      k: 2,
      associated: { threadIds: ["thr-1"] },
    });
    expect(results[0]?.node.id).toBe(bound.id);
    expect(results[0]?.via).toBe("associated");
    expect(results.map((r) => r.node.id)).toHaveLength(2);
  });
});

describe("recallMemories — memory-recall judging (BC3)", () => {
  const judge = (impl: Partial<MemoryRecallFastDecision>): MemoryRecallFastDecision => ({
    status: impl.status ?? (async () => ({ status: "ready" as const, binding: { protocol: "typesafe-systemone" as const, providerId: "p", modelId: "m", configurationId: "c" } })),
    decide: impl.decide ?? (async () => ({ batchId: "b", providerId: "p", modelId: "m", answers: [], missing: [] })),
  });

  it("drops candidates the fast decision judges non-contributing, keeps unanswered ones", async () => {
    const store = await openStore("workspace");
    await remember(store, "the goal is apple filing");
    await remember(store, "the goal is zebra filing");
    const decided = judge({
      decide: async () => ({
        batchId: "b", providerId: "p", modelId: "m",
        answers: [{ id: "m0", kind: "judge", value: 0.9 }, { id: "m1", kind: "judge", value: 0.1 }],
        missing: [],
      }),
    });
    const { results, judge: judgeState } = await recallMemories({
      sources: [{ authority: store, scope: "workspace", scopeId: "ws" }],
      query: "goal filing",
      k: 5,
      goal: "file apples",
      judgeWorkspaceId: "ws",
      fastDecision: decided,
    });
    expect(judgeState).toBe("used");
    expect(results).toHaveLength(1);
    expect(results[0]?.node.payload.content).toBe("the goal is apple filing");
  });

  it("keeps real retrieval when the fast decision is unconfigured or fails", async () => {
    const store = await openStore("workspace");
    await remember(store, "goal terms");
    for (const fastDecision of [
      judge({ status: async () => ({ status: "unconfigured" as const }) }),
      judge({ status: async () => { throw new Error("worker gone"); } }),
      judge({ decide: async () => { throw new Error("provider down"); } }),
    ]) {
      const { results, judge: judgeState } = await recallMemories({
        sources: [{ authority: store, scope: "workspace", scopeId: "ws" }],
        query: "goal",
        k: 5,
        judgeWorkspaceId: "ws",
        fastDecision,
      });
      expect(judgeState).toBe("unavailable");
      expect(results.map((r) => r.node.payload.content)).toContain("goal terms");
    }
  });
});
