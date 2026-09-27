import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import { SessionHost } from "../../src/session-host.js";
import { createThreadRegistry } from "../../../web/application-host/lib/harness/thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "../../../web/application-host/lib/harness/thread-runtime.js";
import { createThreadDispatchService } from "../../../web/application-host/lib/harness/thread-services.js";
import { createOnThreadDequeued } from "../../../web/application-host/lib/harness/thread-dequeue.js";
import { createHarnessServiceHost, type HarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessPathAuthority } from "../../../web/application-host/lib/harness/path-authority.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import type { HostEventData } from "@varin/protocol";

/** Real Pi owns the source compaction and receives the child model input. */
describe("inherit — Pi capture through Host dispatch and dequeue", () => {
  it("retains pre-compaction kept input, exact tool text and images without reading future parent state", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-inherit-acceptance-"));
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const faux = registerFauxProvider();
    const outgoing: Context[] = [];
    faux.setResponses([(context) => {
      outgoing.push(structuredClone(context));
      return fauxAssistantMessage("child consumed the fixed input");
    }]);
    const model = faux.getModel();
    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
        api: model.api, baseUrl: model.baseUrl,
        models: [{ api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow,
          cost: model.cost, id: model.id, input: ["text", "image"], maxTokens: model.maxTokens,
          name: model.name, reasoning: model.reasoning }],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model: { ...model, input: ["text", "image"] as Array<"text" | "image"> } };
    };
    const sourceServices = createHarnessServiceHost({ search: async () => ({ status: "empty" as const, generation: undefined }),
      resolveWorkspaceRoot: async () => workspace,
      pathAuthority: createHarnessPathAuthority({ authorityId: "inherit-test",
        documents: { inspectWorkspace: async () => ({ root: workspace }) } }),
    });
    const sourceRouter = createHarnessRouter({
      respond: async (identity, requestId, outcome) => { parentHost.respondHarness(identity.sessionId, requestId, outcome); },
      resolveActor: (identity) => sourceServices.resolveActor(identity),
    });
    registerHarnessServices(sourceRouter, sourceServices);
    const parentHost = new SessionHost({ agentDir, configureServices, projectTrustOverride: true,
      emit: (event, data) => {
        if (event !== "harness.request") return;
        const actor = { authorityInstanceId: "inherit-test", sessionId: parentHost.sessionId!, workerId: "parent-worker", workerGeneration: 1 };
        if (!sourceServices.hasActor(actor)) sourceServices.registerSession({ actor, workspaceId: "workspace", workspaceRoot: workspace,
          grantedCapabilities: ["context.session", "read.output"] });
        void sourceRouter.processEvent({ actor, kind: "host", envelope: { kind: "event", event,
          data: data as HostEventData<"harness.request"> } });
      },
    });
    const childHost = new SessionHost({ agentDir, configureServices, emit: () => {}, projectTrustOverride: true });
    let runtime!: ReturnType<typeof createThreadRuntime>;
    const registry = createThreadRegistry({
      dataDir: join(root, "data"), hostId: "inherit-test",
      onThreadDequeued: createOnThreadDequeued({ getRegistry: () => registry, getRuntime: () => runtime }),
    });
    try {
      const parent = await parentHost.create(workspace, "Parent");
      sourceServices.registerSession({
        actor: { authorityInstanceId: "inherit-test", sessionId: parent.sessionId,
          workerId: "parent-worker", workerGeneration: 1 },
        workspaceId: "workspace", workspaceRoot: workspace,
        grantedCapabilities: ["context.session", "control.thread", "read.output"],
      });
      const manager = parentHost.session.sessionManager;
      manager.appendMessage({ role: "user", content: "OLD_RAW_OUTSIDE_ACTIVE_INPUT", timestamp: 1 });
      manager.appendMessage(fauxAssistantMessage("old answer"));
      const exactRequirement = "KEEP_REQUIREMENT_BEGIN\n" + "important constraint\n".repeat(1700) + "KEEP_REQUIREMENT_END";
      const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" };
      const keptId = manager.appendMessage({
        role: "user", content: [{ type: "text", text: exactRequirement }, image], timestamp: 2,
      });
      manager.appendMessage(fauxAssistantMessage([{ ...fauxToolCall("read", { path: "fixture.txt" }), id: "source-read" }]));
      manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "source-read", isError: false,
        content: [{ type: "text", text: "EXACT_TOOL_BODY_739\nwith details on a second line" }], timestamp: 3 });
      const fullOutput = "SOURCE_OUTPUT_BEGIN\n" + "完整工具正文🙂\n".repeat(7000) + "SOURCE_OUTPUT_END";
      const stored = sourceServices.outputStore.store(parent.sessionId, fullOutput, "read");
      manager.appendMessage(fauxAssistantMessage([{ ...fauxToolCall("read", { path: "large.txt" }), id: "source-full" }]));
      manager.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "source-full", isError: false, timestamp: 3,
        content: [{ type: "text", text: `preview; source output ${stored.ref.handle}` }], details: { truncated: { ref: stored.ref, total: stored.total } } });
      manager.appendCompaction("COMMITTED_SUMMARY_739", keptId, 18000);
      manager.appendMessage(fauxAssistantMessage([fauxToolCall("dispatch", { task: "PENDING_DISPATCH_MUST_NOT_TRANSFER" })]));
      parentHost.session.agent.state.messages = manager.buildSessionContext().messages;

      let spawned!: () => void;
      const childStarted = new Promise<void>((resolve) => { spawned = resolve; });
      const adapter: ThreadSessionAdapter = {
        create: async (input) => childHost.create(input.cwd, input.name, input.parentSession, input.tools, input.model, input.permissions,
          undefined, 1, "branch"),
        open: async () => { throw new Error("new dispatch must not open an old child"); },
        prompt: async (sessionId, text, instructions, images) => {
          const result = await childHost.prompt(sessionId, text, images, instructions);
          assert.equal(result.accepted, true);
          spawned();
        },
        send: async () => { throw new Error("inherit must not queue an extra follow-up"); },
        abort: async (sessionId) => { await childHost.abort(sessionId); },
        close: async (sessionId) => { await childHost.close(sessionId); },
        snapshot: async () => parentHost.snapshot(),
        summary: (sessionId) => sessionId === parent.sessionId ? parentHost.summary(sessionId) : childHost.summary(sessionId),
        stats: async (sessionId) => childHost.stats(sessionId),
        entries: async (sessionId, scope = "branch") => childHost.entries(sessionId, scope),
        captureInput: async (sessionId) => parentHost.captureInput(sessionId),
      };
      let parentBlockReads = 0;
      runtime = createThreadRuntime({
        registry, sessions: adapter, resolveWorkspaceRoot: async () => workspace,
        resolveRuntimeWorkspaceId: async () => "workspace", readBlocks: async () => {
          parentBlockReads += 1;
          return [{ label: "notes", content: "PARENT_FUTURE_BLOCK_MUST_NOT_LEAK" }];
        },
        worktrees: {
          prepare: async () => ({ cwd: workspace, worktree: null }),
          snapshot: async (worktree) => worktree,
          inspect: async () => ({ patch: "", untracked: [], changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
          merge: async () => ({ merged: 0, conflicts: [], conflictState: "none", changedFiles: [], diffStats: { files: 0, insertions: 0, deletions: 0 } }),
        },
      });
      const common = { scopeId: "workspace", parent: { kind: "session" as const, id: parent.sessionId },
        brief: "block one slot", kind: "implementation" as const, createdBy: "agent" as const,
        concurrency: 1, autoRun: true, worktree: "shared" as const, tools: ["read"], permissions: {} };
      const blocker = await registry.createThread(common);
      const blockerRun = await registry.startRun("workspace", blocker.id);
      const dispatch = createThreadDispatchService({
        threadRegistry: registry, threadSpawnSession: (input) => runtime.spawn(input),
        threadCaptureInputContext: ({ sessionId }) => runtime.captureInputContext(sessionId),
      } as HarnessServiceHost);
      const result = await dispatch.handle({ task: "Use the inherited evidence", input: "inherit", worktree: "shared",
        concurrency: 1, model: { providerId: model.provider, modelId: model.id }, tools: ["read"] }, {
        sessionId: parent.sessionId, workspaceId: "workspace", authorizedPaths: [], signal: new AbortController().signal,
        actor: { authorityInstanceId: "inherit-test", sessionId: parent.sessionId, workerId: "parent-worker",
          workerGeneration: 1, workspaceId: "workspace", grantedCapabilities: ["control.thread"] },
      });
      assert.equal(result.queued, true);
      const queued = await registry.getThreadById("workspace", result.threadId);
      assert.equal(queued?.manifest.inheritedContext?.images?.[0]?.data, image.data);
      manager.appendMessage({ role: "user", content: "PARENT_FUTURE_MATERIAL_MUST_NOT_LEAK", timestamp: 4 });
      await registry.endRun("workspace", blocker.id, blockerRun.id, "success", null);
      await Promise.race([childStarted, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("dequeued child was not started")), 8000);
        timer.unref();
      })]);
      await childHost.session.waitForIdle();
      assert.equal(outgoing.length, 1);
      const actual = JSON.stringify(outgoing[0]!.messages);
      assert.equal(parentBlockReads, 0, "neither task nor inherit reads live parent blocks at spawn");
      assert.match(actual, /COMMITTED_SUMMARY_739/);
      assert.ok(actual.includes(JSON.stringify(exactRequirement).slice(1, -1)));
      assert.match(actual, /EXACT_TOOL_BODY_739/);
      assert.match(actual, /source-read/);
      assert.ok(actual.includes(JSON.stringify(fullOutput).slice(1, -1)), "authorized paged output is copied without truncation");
      assert.notEqual(sourceServices.outputStore.read(childHost.sessionId!, stored.ref.handle).status, "ready", "inherit does not grant the child's access to parent output handles");
      assert.doesNotMatch(actual, /OLD_RAW_OUTSIDE_ACTIVE_INPUT|PARENT_FUTURE_MATERIAL_MUST_NOT_LEAK|PENDING_DISPATCH_MUST_NOT_TRANSFER/);
      const images = outgoing[0]!.messages.flatMap((message) => typeof message.content === "string" ? []
        : message.content.filter((part) => part.type === "image"));
      assert.deepEqual(images, [image]);
      assert.equal(childHost.entries(childHost.sessionId!, "branch").entries.filter((entry) =>
        entry.type === "message" && entry.message.role === "toolResult").length, 0, "source tool calls are quoted, never executed again");
      sourceServices.outputStore.dropSession(parent.sessionId);
      await assert.rejects(parentHost.captureInput(parent.sessionId), /expired|not.found|unavailable/i);
    } finally {
      if (runtime) await runtime.dispose();
      await childHost.dispose();
      await parentHost.dispose();
      await registry.dispose();
      sourceRouter.dispose();
      await sourceServices.dispose();
      faux.unregister();
      await rm(root, { recursive: true, force: true });
    }
  });
});
