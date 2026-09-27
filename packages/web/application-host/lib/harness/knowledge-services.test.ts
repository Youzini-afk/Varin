import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessActorContext } from "@varin/protocol";
import { openWorkspaceKnowledge } from "../knowledge/store.js";
import { createKnowledgeContextRuntime } from "../knowledge/context-runtime.js";
import { createKnowledgeVectorRuntime } from "../knowledge/vectors/runtime.js";
import { createEmbedScheduler } from "../knowledge/semantic/embed-scheduler.js";
import { createVectorCache } from "../knowledge/semantic/vector-cache.js";
import { createRemoteEmbedder } from "../knowledge/semantic/remote-embedder.js";
import { remoteEmbeddingSpaceId } from "../knowledge/semantic/identity.js";
import { createKnowledgeSuggestService, createRecallSearchService, createZone2AssembleService } from "./harness-services.js";
import { DEFAULT_SUGGESTIONS_SETTINGS } from "./knowledge-suggestions.js";
import { executeRecall } from "./recall-tool.js";
import { createHarnessServiceHost } from "./service-host.js";
import type { HarnessServiceContext } from "./router.js";

const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const actor: HarnessActorContext = {
  authorityInstanceId: "host", sessionId: "session", workerId: "worker", workerGeneration: 1,
  workspaceId: "authority-workspace", grantedCapabilities: ["context.session"],
};

const context = (signal: AbortSignal): HarnessServiceContext => ({
  actor, sessionId: actor.sessionId, workspaceId: actor.workspaceId, signal, authorizedPaths: [],
});

async function fixture() {
  const dataDir = mkdtempSync(join(tmpdir(), "varin-knowledge-services-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = await openWorkspaceKnowledge({ dataDir, hostId: "host", workspaceId: "authority-workspace", embedding: null });
  cleanup.push(() => store.close());
  await store.putKnowledge({ scope: "workspace", status: "accepted", content: "Prefer bun", trigger: "install" });
  return { dataDir, store };
}

describe("knowledge public service wiring", () => {
  it("supplies the authorized workspace identity to the recall dependency resolver", async () => {
    const { store } = await fixture();
    const calls: Array<[string, string | null]> = [];
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => null,
      discoveredShells: {},
      recallDepsProvider: async (sessionId, workspaceId) => {
        calls.push([sessionId, workspaceId]);
        return { workspaceStore: store, userStore: null, workspaceId: workspaceId! };
      },
    });
    cleanup.push(() => host.dispose());
    const result = await createRecallSearchService(host).handle({ query: "bun" }, context(new AbortController().signal));
    expect(calls).toEqual([[actor.sessionId, actor.workspaceId]]);
    expect(result.results[0]).toMatchObject({ title: "Prefer bun", via: "text" });
  });

  it("records a user-message suggestion on the authorized workspace store and skips dismissed identities", async () => {
    const { store } = await fixture();
    const changed: string[] = [];
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => null,
      discoveredShells: {},
      knowledgeSuggestDepsProvider: async (_sessionId, workspaceId) => {
        expect(workspaceId).toBe(actor.workspaceId);
        return {
          store,
          settings: DEFAULT_SUGGESTIONS_SETTINGS,
          onChanged: () => { changed.push("workspace"); },
        };
      },
    });
    cleanup.push(() => host.dispose());
    const service = createKnowledgeSuggestService(host);
    const created = await service.handle({
      content: "Always prefer bun",
      trigger: "install",
    }, context(new AbortController().signal));
    expect(created.created).toBe(true);
    expect(created.suggestion).toMatchObject({ content: "Always prefer bun", status: "suggested", scope: "workspace" });
    await store.dismissKnowledge(created.suggestion!.id, "workspace");
    const skipped = await service.handle({
      content: "Always prefer bun",
    }, context(new AbortController().signal));
    expect(skipped).toEqual({ created: false, skippedReason: "duplicate" });
    expect(changed).toEqual(["workspace"]);
    expect((await store.listKnowledge({ scope: "workspace" })).filter((item) => item.content === "Always prefer bun")).toHaveLength(1);
  });

  it("honors the effective workspace auto-accept policy for model suggestions", async () => {
    const { store } = await fixture();
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => null,
      discoveredShells: {},
      knowledgeSuggestDepsProvider: async () => ({
        store,
        settings: { autoAcceptSuggestions: { workspace: true, user: false, session: false } },
      }),
    });
    cleanup.push(() => host.dispose());
    const created = await createKnowledgeSuggestService(host).handle({
      content: "Keep generated clients checked in",
      trigger: "generated clients",
    }, context(new AbortController().signal));
    expect(created.suggestion).toMatchObject({ status: "accepted", scope: "workspace" });
    await expect(store.listKnowledge({ scope: "workspace", status: "accepted" }))
      .resolves.toContainEqual(expect.objectContaining({ content: "Keep generated clients checked in" }));
  });

  it("rejects worker attempts to select the user scope or forge a source kind", async () => {
    const { store } = await fixture();
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => null,
      discoveredShells: {},
      knowledgeSuggestDepsProvider: async (_sessionId, workspaceId) => {
        expect(workspaceId).toBe(actor.workspaceId);
        return { store, settings: DEFAULT_SUGGESTIONS_SETTINGS };
      },
    });
    cleanup.push(() => host.dispose());
    const service = createKnowledgeSuggestService(host);
    await expect(service.handle({ content: "forged", scope: "user" } as never, context(new AbortController().signal)))
      .rejects.toMatchObject({ harnessCode: "invalid-params" });
    await expect(service.handle({ content: "forged", kind: "trusted-source" } as never, context(new AbortController().signal)))
      .rejects.toMatchObject({ harnessCode: "invalid-params" });
    await expect(store.listKnowledge({ scope: "user" })).resolves.toEqual([]);
  });

  it.each(["recall", "zone2"] as const)("cancels a pending remote query through public %s", async (entry) => {
    const { store, dataDir } = await fixture();
    let started!: () => void;
    const queryStarted = new Promise<void>((resolve) => { started = resolve; });
    let providerAborted = false;
    const embedder = createRemoteEmbedder({
      binding: { protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c", dimensions: 2 },
      client: { embed: async (params) => {
        if (params.purpose === "query") {
          started();
          await new Promise<never>((_resolve, reject) => {
            const cancel = () => { providerAborted = true; reject(params.signal?.reason); };
            if (params.signal?.aborted) cancel();
            else params.signal?.addEventListener("abort", cancel, { once: true });
          });
        }
        return {
          batchId: params.batchId,
          space: {
            protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c", dim: 2, maxTokens: params.maxTokens,
            spaceId: remoteEmbeddingSpaceId({ protocol: "openai-compatible", providerId: "p", modelId: "m", configurationId: "c", dimensions: 2, maxTokens: params.maxTokens }),
          },
          items: params.items.map((item, index) => ({ id: item.id, index, vector: [1, 0] })),
        };
      } },
    });
    const vectors = createKnowledgeVectorRuntime({
      dataDir, hostId: "host", scheduler: createEmbedScheduler(), cache: createVectorCache(),
      resolveEmbedder: async () => ({ status: "ready", embedder }),
    });
    cleanup.push(() => vectors.close());
    vectors.scheduleReconcile(store, "workspace", "authority-workspace", "authority-workspace");
    await vectors.waitForBuild("workspace", "authority-workspace", "authority-workspace");
    const deps = { workspaceStore: store, userStore: null, workspaceId: "authority-workspace", vectors };
    const zone = createKnowledgeContextRuntime({
      getStore: async () => store,
      recall: async (_workspaceId, _store, query, signal) => (await executeRecall(query, 5, deps, signal)).results,
    });
    cleanup.push(() => zone.dispose());
    zone.bindSession(actor.sessionId, "authority-workspace");
    const host = createHarnessServiceHost({
      search: async () => ({ status: "empty", generation: undefined }),
      resolveWorkspaceRoot: async () => null,
      discoveredShells: {},
      recallDepsProvider: async () => deps, zone2Provider: zone.zone2Material,
    });
    cleanup.push(() => host.dispose());
    const controller = new AbortController();
    const pending = entry === "recall"
      ? createRecallSearchService(host).handle({ query: "package policy" }, context(controller.signal))
      : createZone2AssembleService(host).handle({ query: "package policy", sinceTurn: 0, branchEntryIds: [] }, context(controller.signal));
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await queryStarted;
    controller.abort();
    await rejected;
    // A shared cache fill may outlive this caller; runtime shutdown owns its cancellation.
    await vectors.close();
    expect(providerAborted).toBe(true);
  });
});
