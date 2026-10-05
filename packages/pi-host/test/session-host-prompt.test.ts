import { fauxProvider } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData, PiAgentEvent } from "@varin/protocol";
import { SessionHost } from "../src/session-host.js";

describe("SessionHost prompt streaming", () => {
  it("runs a complete prompt through a deterministic provider and settles", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-prompt-"));
    const agentDir = join(root, "agent");
    const agentStartedMarker = join(root, "agent-started.txt");
    const projectExtensions = join(root, ".pi", "extensions");
    await mkdir(projectExtensions, { recursive: true });
    await writeFile(
      join(projectExtensions, "delayed-agent-start.ts"),
      `import { writeFile } from "node:fs/promises";
      export default function extension(pi: any) {
        pi.on("agent_start", async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          await writeFile(${JSON.stringify(agentStartedMarker)}, "started", "utf8");
        });
      }\n`,
      "utf8",
    );
    const events: Array<{ data: unknown; event: string }> = [];
    const faux = fauxProvider();
    let observedContext: unknown;
    const answer = (context: unknown) => {
      observedContext = context;
      return fauxAssistantMessage("hello from Varin");
    };
    faux.setResponses([answer, answer]);
    const model = faux.getModel();
    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
          streamSimple: faux.provider.streamSimple,
        api: model.api,
        baseUrl: model.baseUrl,
        models: [
          {
            api: model.api,
            baseUrl: model.baseUrl,
            contextWindow: model.contextWindow,
            cost: model.cost,
            id: model.id,
            input: model.input,
            maxTokens: model.maxTokens,
            name: model.name,
            reasoning: model.reasoning,
          },
        ],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    };
    const surfaceRequests: Array<Record<string, unknown>> = [];
    const host = new SessionHost({
      agentDir,
      configureServices,
      emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
        events.push({ data, event });
        if (event === "harness.request" && data && typeof data === "object") {
          const request = data as unknown as Record<string, unknown>;
          if (request.method === "session.instructions") {
            queueMicrotask(() => host.respondHarness(host.sessionId ?? "", String(request.requestId), {
              ok: true, result: { instructions: null },
            }));
          }
          if (request.method === "surface.snapshot.commit" || request.method === "surface.snapshot.release") {
            surfaceRequests.push(request);
            queueMicrotask(() => host.respondHarness(
              host.sessionId ?? "",
              String(request.requestId),
              request.method === "surface.snapshot.commit"
                ? { ok: true, result: { committed: true } }
                : { ok: true, result: { released: true } },
            ));
          } else if (request.method !== "session.instructions") {
            queueMicrotask(() => host.respondHarness(host.sessionId ?? "", String(request.requestId), {
              ok: false, error: { code: "unavailable", message: "No harness service in this prompt fixture" },
            }));
          }
        }
      },
      projectTrustOverride: true,
    });
    host.setSessionInstructionsAvailable(true);

    try {
      const snapshot = await host.create(root);
      assert.equal(snapshot.model?.provider, model.provider);
      assert.deepEqual(host.clearQueue(snapshot.sessionId), {
        cleared: false,
        followUp: [],
        steering: [],
      });
      assert.deepEqual(
        await host.prompt(
          snapshot.sessionId,
          "say hello",
          undefined,
          "Answer with the hidden Varin instruction.",
          {
            source: "surface",
            roots: [{ workspaceId: "workspace-1", dirtyPaths: ["draft.ts"] }],
            snapshot: { status: "ready", ref: "opaque-ref" },
          },
        ),
        { accepted: true },
      );
      assert.equal(
        await readFile(agentStartedMarker, "utf8"),
        "started",
        "accepted prompt responses must not precede the projected agent_start lifecycle",
      );
      assert.deepEqual(surfaceRequests.map((request) => request.method), ["surface.snapshot.commit"]);
      assert.equal(JSON.stringify(surfaceRequests).includes("document body"), false);
      assert.deepEqual(surfaceRequests[0]?.inputContext, {
        source: "surface",
        roots: [{ workspaceId: "workspace-1", dirtyPaths: ["draft.ts"] }],
        snapshot: { status: "ready", ref: "opaque-ref" },
      });
      await host.session.waitForIdle();

      const serialized = JSON.stringify(events);
      assert.match(serialized, /hello from Varin/);
      assert.match(JSON.stringify(observedContext), /hidden Varin instruction/);
      assert.ok(
        events.some(
          (entry) =>
            entry.event === "agent.event" &&
            typeof entry.data === "object" &&
            entry.data !== null &&
            JSON.stringify(entry.data).includes("agent_settled"),
        ),
      );
      const entries = host.entries(snapshot.sessionId, "branch");
      assert.equal(entries.scope, "branch");
      const projectedAgentEvents = events
        .filter((entry) => entry.event === "agent.event")
        .map((entry) => (entry.data as { event: PiAgentEvent }).event);
      const appended = projectedAgentEvents.filter((event) => event.type === "entry_appended");
      assert.ok(appended.some((event) => event.entry.type === "message" && event.entry.message.role === "user"));
      assert.ok(appended.some((event) => event.entry.type === "message" && event.entry.message.role === "assistant"));
      for (const event of projectedAgentEvents) {
        if (event.type === "agent_start"
          || event.type === "agent_end"
          || event.type === "agent_settled"
          || event.type === "turn_start"
          || event.type === "turn_end"
          || event.type === "entry_appended") {
          assert.equal(Number.isSafeInteger(event.turnIndex), true);
          assert.equal(event.leafId === null || typeof event.leafId === "string", true);
        }
      }
      const instructionsEntry = entries.entries.find(
        (entry) => entry.type === "custom_message" && entry.customType === "varin.instructions",
      );
      assert.ok(instructionsEntry && instructionsEntry.type === "custom_message");
      assert.equal(instructionsEntry.display, false);
      assert.match(JSON.stringify(instructionsEntry.content), /hidden Varin instruction/);
      const userEntry = entries.entries.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          !Array.isArray(entry) &&
          entry.type === "message" &&
          typeof entry.message === "object" &&
          entry.message !== null &&
          !Array.isArray(entry.message) &&
          entry.message.role === "user",
      );
      const userEntryId =
        typeof userEntry === "object" &&
        userEntry !== null &&
        !Array.isArray(userEntry) &&
        typeof userEntry.id === "string"
          ? userEntry.id
          : undefined;
      assert.ok(userEntryId);
      const recovery = host.recoveryStatus(snapshot.sessionId);
      assert.equal(recovery.available, true);
      assert.ok(recovery.modes.includes("conversation"));
      assert.ok(recovery.providers.some((provider) => provider.id === "pi-native"));
      const recovered = await host.navigateRecovery(
        snapshot.sessionId,
        userEntryId,
        "conversation",
      );
      assert.equal(recovered.handledBy, "pi-native");
      assert.equal(recovered.outcome, "applied");
      assert.equal(recovered.editorText, "say hello");
      assert.equal(
        host.entries(snapshot.sessionId, "branch").entries.some(
          (entry) => entry.type === "custom_message" && entry.customType === "varin.instructions",
        ),
        false,
      );
      host.applySessionInstructions(snapshot.sessionId, "Bot persona after the profile changed.");
      await host.prompt(snapshot.sessionId, "say again", undefined, "Answer with the hidden Varin instruction.");
      await host.session.waitForIdle();
      assert.match(JSON.stringify(observedContext), /Bot persona after the profile changed/);
      assert.equal(
        host.entries(snapshot.sessionId, "branch").entries.some(
          (entry) => entry.type === "custom_message" && entry.customType === "varin.instructions",
        ),
        true,
      );
      const forked = await host.fork(snapshot.sessionId, userEntryId, "at");
      assert.equal(forked.cancelled, false);
      assert.notEqual(forked.snapshot.sessionId, snapshot.sessionId);
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("keeps an accepted prompt accepted when surface snapshot commit fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-prompt-source-failure-"));
    const agentDir = join(root, "agent");
    const events: Array<{ data: unknown; event: string }> = [];
    const faux = fauxProvider();
    faux.setResponses([() => fauxAssistantMessage("accepted once")]);
    const model = faux.getModel();
    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
          streamSimple: faux.provider.streamSimple,
        api: model.api,
        baseUrl: model.baseUrl,
        models: [{
          api: model.api,
          baseUrl: model.baseUrl,
          contextWindow: model.contextWindow,
          cost: model.cost,
          id: model.id,
          input: model.input,
          maxTokens: model.maxTokens,
          name: model.name,
          reasoning: model.reasoning,
        }],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    };
    const host = new SessionHost({
      agentDir,
      configureServices,
      emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
        events.push({ data, event });
        if (event !== "harness.request" || !data || typeof data !== "object") return;
        const request = data as unknown as Record<string, unknown>;
        queueMicrotask(() => host.respondHarness(
          host.sessionId ?? "",
          String(request.requestId),
          request.method === "surface.snapshot.commit"
            ? { ok: true, result: { committed: false } }
            : request.method === "surface.snapshot.release"
              ? { ok: true, result: { released: true } }
              : { ok: false, error: { code: "unavailable", message: "No harness service in this prompt fixture" } },
        ));
      },
      projectTrustOverride: true,
    });
    try {
      const snapshot = await host.create(root);
      const result = await host.prompt(snapshot.sessionId, "run exactly once", undefined, undefined, {
        source: "surface",
        roots: [{ workspaceId: "workspace-1", dirtyPaths: ["draft.ts"] }],
        snapshot: { status: "ready", ref: "pending-ref" },
      });
      assert.deepEqual(result, { accepted: true });
      await host.session.waitForIdle();
      assert.equal(faux.state.callCount, 1);
      const sourceRequests = events
        .filter((entry) => entry.event === "harness.request")
        .map((entry) => entry.data as { inputContext?: unknown; method: string })
        .filter((request) => request.method === "surface.snapshot.commit" || request.method === "surface.snapshot.release");
      assert.deepEqual(sourceRequests.map((request) => request.method), ["surface.snapshot.commit", "surface.snapshot.release"]);
      assert.deepEqual(sourceRequests[1]?.inputContext, {
        source: "surface",
        roots: [{ workspaceId: "workspace-1", dirtyPaths: ["draft.ts"] }],
        snapshot: { status: "unavailable", reason: "surface-unavailable" },
      });
      assert.ok(events.some((entry) => (
        entry.event === "host.log"
        && JSON.stringify(entry.data).includes("Agent input source commit failed")
      )));
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("acknowledges manual abort after signalling cancellation without waiting for idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-abort-"));
    const agentDir = join(root, "agent");
    const faux = fauxProvider();
    faux.setResponses([() => fauxAssistantMessage("unused")]);
    const model = faux.getModel();
    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
          streamSimple: faux.provider.streamSimple,
        api: model.api,
        baseUrl: model.baseUrl,
        models: [{
          api: model.api,
          baseUrl: model.baseUrl,
          contextWindow: model.contextWindow,
          cost: model.cost,
          id: model.id,
          input: model.input,
          maxTokens: model.maxTokens,
          name: model.name,
          reasoning: model.reasoning,
        }],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    };
    const host = new SessionHost({
      agentDir,
      configureServices,
      emit: () => undefined,
      projectTrustOverride: true,
    });

    try {
      const snapshot = await host.create(root);
      const session = host.session;
      const mutableAgent = session.agent as unknown as { abort: () => void };
      const mutableSession = session as unknown as {
        _emit: (event: { reason: "manual"; type: "compaction_start" }) => void;
        abortCompaction: () => void;
        compact: () => Promise<unknown>;
        waitForIdle: () => Promise<void>;
      };
      const originalAgentAbort = mutableAgent.abort.bind(session.agent);
      const originalAbortCompaction = mutableSession.abortCompaction.bind(session);
      const originalCompact = mutableSession.compact.bind(session);
      const originalWaitForIdle = mutableSession.waitForIdle.bind(session);
      let abortSignals = 0;
      let compactionAbortSignals = 0;
      mutableAgent.abort = () => { abortSignals += 1; };
      mutableSession.abortCompaction = () => { compactionAbortSignals += 1; };
      mutableSession.waitForIdle = async () => {
        throw new Error("SessionHost.abort must not wait for idle");
      };
      try {
        assert.equal(await host.abort(snapshot.sessionId), false);
        assert.equal(abortSignals, 1);
        let finishCompaction!: () => void;
        mutableSession.compact = () => new Promise((resolve) => {
          finishCompaction = () => {
            // Pi emits this only after its compaction controller exists. A stop
            // accepted during Pi's initial await must be signalled again here.
            mutableSession._emit({ reason: "manual", type: "compaction_start" });
            resolve({});
          };
        });
        const compacting = host.compact(snapshot.sessionId);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const activityId = host.snapshot().runId;
        assert.ok(activityId, "the first manual compaction has an observable stop identity");
        assert.equal(host.snapshot().busy, true);
        assert.equal(host.snapshot().isCompacting, true);
        assert.equal(await host.abort(snapshot.sessionId, activityId), true);
        assert.equal(abortSignals, 2);
        assert.equal(compactionAbortSignals, 2);
        finishCompaction();
        await compacting;
        assert.equal(compactionAbortSignals, 3);
        assert.equal(host.snapshot().runId, activityId);
        assert.equal(host.snapshot().busy, false);
      } finally {
        mutableAgent.abort = originalAgentAbort;
        mutableSession.abortCompaction = originalAbortCompaction;
        mutableSession.compact = originalCompact;
        mutableSession.waitForIdle = originalWaitForIdle;
      }
    } finally {
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a delayed stop for a settled run while a newer run is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-abort-run-"));
    const faux = fauxProvider();
    let releaseSecond!: () => void;
    const heldSecond = new Promise<void>((resolve) => { releaseSecond = resolve; });
    faux.setResponses([
      () => fauxAssistantMessage("first complete"),
      async () => { await heldSecond; return fauxAssistantMessage("second complete"); },
    ]);
    const model = faux.getModel();
    const lifecycleEvents: PiAgentEvent[] = [];
    const host = new SessionHost({
      agentDir: join(root, "agent"),
      configureServices: async (services) => {
        services.modelRuntime.registerProvider(model.provider, {
          streamSimple: faux.provider.streamSimple,
          api: model.api, baseUrl: model.baseUrl,
          models: [{
            api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow,
            cost: model.cost, id: model.id, input: model.input, maxTokens: model.maxTokens,
            name: model.name, reasoning: model.reasoning,
          }],
        });
        await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
        return { model };
      },
      emit: (event, data) => {
        if (event === "agent.event") lifecycleEvents.push((data as { event: PiAgentEvent }).event);
        if (event === "harness.request") {
          const request = data as HostEventData<"harness.request">;
          queueMicrotask(() => host.respondHarness(host.sessionId ?? "", request.requestId, {
            ok: false, error: { code: "unavailable", message: "No harness service in this prompt fixture" },
          }));
        }
      },
      projectTrustOverride: true,
    });
    try {
      const { sessionId } = await host.create(root);
      assert.deepEqual(await host.prompt(sessionId, "first"), { accepted: true });
      await host.session.waitForIdle();
      const firstRunId = host.snapshot().runId;
      assert.ok(firstRunId);
      assert.deepEqual(await host.prompt(sessionId, "second"), { accepted: true });
      const secondRunId = host.snapshot().runId;
      assert.ok(secondRunId);
      assert.notEqual(secondRunId, firstRunId);
      const mutableAgent = host.session.agent as unknown as { abort: () => void };
      const originalAbort = mutableAgent.abort.bind(host.session.agent);
      let abortSignals = 0;
      mutableAgent.abort = () => { abortSignals += 1; originalAbort(); };
      try {
        assert.equal(await host.abort(sessionId, firstRunId), false);
        assert.equal(abortSignals, 0);
        assert.equal(host.snapshot().busy, true);
        assert.equal(await host.abort(sessionId, secondRunId), true);
        assert.equal(abortSignals, 1);
      } finally {
        mutableAgent.abort = originalAbort;
      }
      releaseSecond();
      await host.session.waitForIdle();
      const staleRunId = host.snapshot().runId;
      assert.equal(staleRunId, secondRunId);
      const session = host.session as unknown as {
        compact: () => Promise<unknown>;
        navigateTree: (targetId: string, options?: { summarize?: boolean }) => Promise<{ cancelled: boolean }>;
      };
      const originalCompact = session.compact.bind(host.session);
      const originalNavigate = session.navigateTree.bind(host.session);
      const agent = host.session.agent as unknown as { abort: () => void };
      const originalAgentAbort = agent.abort.bind(host.session.agent);
      let activityAbortSignals = 0;
      agent.abort = () => { activityAbortSignals += 1; originalAgentAbort(); };
      try {
        let finishCompaction!: () => void;
        session.compact = () => new Promise((resolve) => { finishCompaction = () => resolve({}); });
        const compacting = host.compact(sessionId);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const compactionId = host.snapshot().runId;
        assert.ok(compactionId);
        assert.notEqual(compactionId, staleRunId);
        (host.session as unknown as { _emit: (event: { type: "agent_settled" }) => void })
          ._emit({ type: "agent_settled" });
        assert.equal(lifecycleEvents.at(-1)?.runId, staleRunId);
        assert.equal(host.snapshot().busy, true);
        assert.equal(await host.abort(sessionId, staleRunId), false);
        assert.equal(activityAbortSignals, 0);
        assert.equal(await host.abort(sessionId, compactionId), true);
        assert.equal(activityAbortSignals, 1);
        finishCompaction();
        await compacting;

        let finishSummary!: () => void;
        session.navigateTree = () => new Promise((resolve) => {
          finishSummary = () => resolve({ cancelled: false });
        });
        const navigating = host.navigate(sessionId, "branch-target", true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        const summaryId = host.snapshot().runId;
        assert.ok(summaryId);
        assert.notEqual(summaryId, compactionId);
        assert.equal(await host.abort(sessionId, compactionId), false);
        assert.equal(activityAbortSignals, 1);
        assert.equal(await host.abort(sessionId, summaryId), true);
        assert.equal(activityAbortSignals, 2);
        finishSummary();
        await navigating;
      } finally {
        session.compact = originalCompact;
        session.navigateTree = originalNavigate;
        agent.abort = originalAgentAbort;
      }
    } finally {
      releaseSecond();
      await host.dispose();
      await rm(root, { force: true, recursive: true });
    }
  });
});
