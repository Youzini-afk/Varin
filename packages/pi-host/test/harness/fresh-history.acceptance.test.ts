import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@varin/protocol";
import { SessionHost } from "../../src/session-host.js";
import { createThreadRegistry } from "../../../web/application-host/lib/harness/thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "../../../web/application-host/lib/harness/thread-runtime.js";
import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { createThreadHistoryService } from "../../../web/application-host/lib/harness/thread-services.js";

/** Real Pi requests consume a fresh input and read the preceding native transcript. */
describe("fresh continuation and same-Thread history", () => {
  it("reads original tool text through history(run), never parent or sibling history", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-fresh-history-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "evidence.txt"), "ORIGINAL_RAW_TOOL_DETAIL_739\nsecond exact line", "utf8");
    const faux = registerFauxProvider();
    const outgoing: Context[] = [];
    let originalRunId = "";
    faux.setResponses([
      (context) => { outgoing.push(structuredClone(context)); return fauxAssistantMessage([fauxToolCall("read", { path: "evidence.txt" })]); },
      (context) => { outgoing.push(structuredClone(context)); return fauxAssistantMessage("The original task is complete."); },
      (context) => { outgoing.push(structuredClone(context)); return fauxAssistantMessage([fauxToolCall("history", { run: originalRunId, query: "ORIGINAL_RAW_TOOL_DETAIL_739" })]); },
      (context) => { outgoing.push(structuredClone(context)); return fauxAssistantMessage("The fresh Run used the original evidence."); },
    ]);
    const model = faux.getModel();
    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
        api: model.api, baseUrl: model.baseUrl,
        models: [{ api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow,
          cost: model.cost, id: model.id, input: model.input, maxTokens: model.maxTokens,
          name: model.name, reasoning: model.reasoning }],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    };
    const parentHost = new SessionHost({ agentDir: join(root, "agent"), configureServices, emit: () => {}, projectTrustOverride: true });
    const registry = createThreadRegistry({ dataDir: join(root, "data"), hostId: "fresh-history" });
    const hosts = new Map<string, SessionHost>();
    const sessionFiles = new Map<string, string>();
    const allHosts: SessionHost[] = [];
    let runtime!: ReturnType<typeof createThreadRuntime>;
    const serviceHost = createHarnessServiceHost({
      threadRegistry: registry,
      search: async () => ({ status: "empty" as const, generation: undefined }),
      resolveWorkspaceRoot: async () => workspace,
      threadHistoryEntries: async (sessionId) => {
        const file = sessionFiles.get(sessionId);
        if (!file) throw new Error("Retained native transcript not found");
        return parentHost.readEntries(sessionId, file, workspace, "branch");
      },
    });
    const router = createHarnessRouter({
      respond: async (identity, requestId, outcome) => { hosts.get(identity.sessionId)!.respondHarness(identity.sessionId, requestId, outcome); },
      resolveActor: (identity) => serviceHost.resolveActor(identity),
    });
    registerHarnessServices(router, serviceHost);
    let generation = 0;
    const createHost = () => {
      const workerGeneration = ++generation;
      const emit = <E extends HostEvent>(event: E, data: HostEventData<E>) => {
        const sessionId = host.sessionId;
        if (!sessionId) return;
        if (event === "harness.request") {
          const actor = { authorityInstanceId: "fresh-history", workerId: `worker-${workerGeneration}`, workerGeneration, sessionId };
          if (!serviceHost.hasActor(actor)) serviceHost.registerSession({ actor,
            workspaceId: "workspace", workspaceRoot: workspace,
            grantedCapabilities: ["context.session", "read.output", "control.thread", "read.lsp"],
          });
          void router.processEvent({ actor, kind: "host", envelope: { kind: "event", event, data } });
        }
        runtime?.processEvent({ kind: "host", sessionId, envelope: { kind: "event", event, data } });
      };
      const host = new SessionHost({ agentDir: join(root, "agent"), configureServices, emit, projectTrustOverride: true });
      host.setHarnessThreadRuntimeEnabled(true);
      allHosts.push(host);
      return host;
    };
    try {
      const parent = await parentHost.create(workspace, "Parent");
      const getHost = (sessionId: string) => sessionId === parent.sessionId ? parentHost : hosts.get(sessionId)!;
      const adapter: ThreadSessionAdapter = {
        create: async (input) => {
          const host = createHost();
          const created = await host.create(input.cwd, input.name, input.parentSession, input.tools, input.model, input.permissions);
          hosts.set(created.sessionId, host); sessionFiles.set(created.sessionId, created.sessionFile!);
          return created;
        },
        open: async (input) => {
          const host = createHost();
          const opened = await host.open({ cwd: input.cwd, sessionFile: sessionFiles.get(input.sessionId)!, tools: input.tools });
          hosts.set(opened.sessionId, host); return opened;
        },
        prompt: async (sessionId, text, instructions, images) => { assert.equal((await getHost(sessionId).prompt(sessionId, text, images, instructions)).accepted, true); },
        send: async (sessionId, text) => { await getHost(sessionId).followUp(sessionId, text); },
        notify: async (sessionId, text, messageId) => { await getHost(sessionId).notify(sessionId, messageId, text); },
        request: async (sessionId, text, messageId) => { await getHost(sessionId).requestThreadMessage(sessionId, messageId, text); },
        abort: async (sessionId) => { await getHost(sessionId).abort(sessionId); },
        close: async (sessionId) => { await getHost(sessionId).close(sessionId); },
        snapshot: async (sessionId) => getHost(sessionId).snapshot(),
        summary: (sessionId) => getHost(sessionId).summary(sessionId),
        stats: async (sessionId) => getHost(sessionId).stats(sessionId),
        entries: async (sessionId, scope = "branch") => getHost(sessionId).entries(sessionId, scope),
        readEntries: async (sessionId, _cwd, scope = "branch") => parentHost.readEntries(sessionId, sessionFiles.get(sessionId)!, workspace, scope),
      };
      runtime = createThreadRuntime({ registry, sessions: adapter,
        resolveWorkspaceRoot: async () => workspace, resolveRuntimeWorkspaceId: async () => "workspace", readBlocks: async () => [],
        worktrees: { prepare: async () => ({ cwd: workspace, worktree: null }), snapshot: async (tree) => tree,
          inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
          merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }) },
      });
      const input = { scopeId: "workspace", parent: { kind: "session" as const, id: parent.sessionId },
        brief: "Read evidence.txt and complete the task", kind: "implementation" as const, createdBy: "agent" as const,
        concurrency: 1, autoRun: true, worktree: "none" as const, tools: ["read", "history"],
        model: { providerId: model.provider, modelId: model.id }, permissions: {} };
      const thread = await registry.createThread(input);
      const first = await registry.startRun("workspace", thread.id);
      originalRunId = first.id;
      const initial = await runtime.spawn({ ...input, threadId: thread.id, runId: first.id });
      await hosts.get(initial.sessionId)!.session.waitForIdle();
      await runtime.drain();
      assert.equal((await registry.getThreadById("workspace", thread.id))!.lifecycle, "settled");
      const continued = await runtime.continueRun({ scopeId: "workspace", parent: input.parent,
        threadId: thread.id, mode: "fresh", task: "Look up the exact evidence from the prior Run", requestId: "fresh-1" });
      assert.ok(continued.runId && continued.runId !== first.id);
      const active = (await registry.getActiveRun("workspace", thread.id))!;
      assert.ok(active.sessionId && active.sessionId !== initial.sessionId);
      const newSession = hosts.get(active.sessionId)!;
      // The new session is live long enough to test the real actor's source authorization.
      const source = createThreadHistoryService(serviceHost);
      const ctx = { sessionId: active.sessionId, workspaceId: "workspace", authorizedPaths: [], signal: new AbortController().signal,
        actor: { authorityInstanceId: "fresh-history", workerId: "test-source", workerGeneration: 1,
          sessionId: active.sessionId, workspaceId: "workspace", grantedCapabilities: ["context.session" as const] } };
      await assert.rejects(source.handle({ runId: "some-other-thread-run" }, ctx), /does not belong|no longer|binding/);
      await newSession.session.waitForIdle();
      await runtime.drain();
      assert.equal(outgoing.length, 4);
      assert.match(JSON.stringify(outgoing[2]!.messages), new RegExp(first.id));
      assert.doesNotMatch(JSON.stringify(outgoing[2]!.messages), /ORIGINAL_RAW_TOOL_DETAIL_739/);
      assert.match(JSON.stringify(outgoing[3]!.messages), /ORIGINAL_RAW_TOOL_DETAIL_739/);
      assert.match(JSON.stringify(outgoing[3]!.messages), /second exact line/);
      assert.equal((await registry.getActiveRun("workspace", thread.id))!.outcome, "success");
      const retained = parentHost.readEntries(initial.sessionId, sessionFiles.get(initial.sessionId)!, workspace, "branch");
      assert.match(JSON.stringify(retained.entries), /ORIGINAL_RAW_TOOL_DETAIL_739/);
    } finally {
      await runtime?.dispose();
      for (const host of allHosts) await host.dispose();
      await parentHost.dispose(); router.dispose(); await serviceHost.dispose(); await registry.dispose();
      faux.unregister(); await rm(root, { recursive: true, force: true });
    }
  });
});
