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
import { createRecallSearchService, createZone2AssembleService } from "./harness-services.js";
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
      recall: async ({ query, signal }) => (await executeRecall(query, 5, deps, signal)).results,
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
