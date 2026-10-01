import { fauxProvider } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@varin/protocol";
import { activeCompactionMessages } from "../src/harness/compaction-context.js";
import { estimateModelInputTokens } from "../src/harness/context-request-boundary.js";
import { SessionHost } from "../src/session-host.js";

test("manual compaction runs beside an active turn and commits only at the next capacity boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-manual-compaction-"));
  const faux = fauxProvider();
  const model = { ...faux.getModel(), contextWindow: 60_000, maxTokens: 400 };
  const traceEvents: Array<{ taskId: string; type: string; message?: string }> = [];
  const harnessMethods: string[] = [];
  let workerRequestId: string | undefined;
  let workerRequests = 0;
  let releaseRunningTurn: () => void = () => undefined;
  const runningTurn = new Promise<void>((resolve) => { releaseRunningTurn = resolve; });
  let providerStarted!: () => void;
  const enteredProvider = new Promise<void>(resolve => { providerStarted = resolve; });
  faux.setResponses([
    async () => { providerStarted(); await runningTurn; return fauxAssistantMessage("The foreground turn completed normally."); },
    () => fauxAssistantMessage("Continued after the prepared summary was applied."),
  ]);
  const host = new SessionHost({
    agentDir: join(root, "agent"),
    configureServices: async (services) => {
      services.modelRuntime.registerProvider(model.provider, {
        streamSimple: faux.provider.streamSimple,
        api: model.api, baseUrl: model.baseUrl,
        models: [{ api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow,
          cost: model.cost, id: model.id, input: model.input, maxTokens: model.maxTokens,
          name: model.name, reasoning: model.reasoning }],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    },
    emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
      if (event === "harness.request") harnessMethods.push((data as { method: string }).method);
      if (event === "harness.request" && ["zone2.assemble", "zone2.status", "context.retained"].includes((data as { method: string }).method)) {
        const request = data as { method: string; requestId: string };
        queueMicrotask(() => host.respondHarness(host.sessionId ?? "", request.requestId, { ok: true,
          result: request.method === "zone2.assemble"
            ? { content: null, eventCursor: 0 }
            : request.method === "context.retained" ? { acknowledged: true } : { status: "ready", content: null },
        }));
      }
      if (event === "harness.request" && (data as { method?: string }).method === "compaction.run") {
        workerRequestId = (data as { requestId: string }).requestId;
        workerRequests += 1;
      }
      if (event === "compaction.trace") {
        const update = data as { taskId: string; type: string; message?: string };
        traceEvents.push({ taskId: update.taskId, type: update.type,
          ...(update.message ? { message: update.message } : {}) });
      }
    },
    projectTrustOverride: true,
  });
  try {
    // This case isolates explicit preparation. Automatic preparation of a new
    // prefix after the commit has separate coverage in the session e2e suite.
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(join(root, "agent", "settings.json"), JSON.stringify({
      harness: { context: { backgroundPreparation: false } },
    }));
    const { sessionId } = await host.create(root);
    const manager = host.session.sessionManager;
    for (let index = 0; index < 6; index += 1) {
      manager.appendMessage({ role: "user", content: `Task ${index}: ${"detail ".repeat(150)}`, timestamp: Date.now() });
      manager.appendMessage(fauxAssistantMessage(`Result ${index}: ${"finding ".repeat(150)}`));
    }
    assert.deepEqual(await host.prompt(sessionId, "Continue the active task"), { accepted: true });
    await enteredProvider;
    assert.equal(host.session.isIdle, false);
    const started = host.prepareCompaction(sessionId);
    assert.equal(started.status, "preparing");
    assert.ok(workerRequestId, "the worker task started without waiting for its summary");
    assert.equal(manager.getBranch().at(-1)?.type, "message");
    assert.equal(workerRequests, 1);

    host.respondHarness(sessionId, workerRequestId, { ok: true, result: {
      summary: "The earlier tasks and findings remain relevant.", queries: 0,
      trace: { taskId: started.taskId, entries: [{ kind: "assistant", at: 1, text: "Summary prepared" }] },
    } });
    for (let attempt = 0; attempt < 100 && !traceEvents.some((event) => event.type === "finished"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(traceEvents.some((event) => event.type === "finished"), JSON.stringify(traceEvents));
    assert.equal(manager.getBranch().at(-1)?.type, "message", "preparation never commits inside the worker callback");
    releaseRunningTurn();
    await host.session.waitForIdle();
    assert.equal(manager.getBranch().at(-1)?.type, "message", "idle settlement must not commit a ready summary");
    const repeated = host.prepareCompaction(sessionId);
    assert.deepEqual(repeated, { taskId: started.taskId, status: "ready" });
    assert.deepEqual(await host.executeCommand(sessionId, "/compact"), repeated,
      "the slash-command route must use the same background preparation");
    assert.equal(workerRequests, 1, "the same source and focus reuse the existing worker result");
    assert.equal(manager.getBranch().at(-1)?.type, "message");
    assert.deepEqual(traceEvents.map((event) => event.type), ["requested", "finished", "requested", "requested"]);

    // Later work stays in native history until a real provider request needs
    // capacity. The prepared prefix is then adopted without another worker.
    const reserve = host.runtime.services.settingsManager.getCompactionSettings().reserveTokens;
    const estimatedInput = () => estimateModelInputTokens({
      messages: convertToLlm(activeCompactionMessages(manager.buildSessionContext().messages)),
    });
    for (let index = 0; estimatedInput() + reserve < model.contextWindow - 100; index += 1) {
      manager.appendMessage({ role: "user", content: `Later task ${index}: ${"detail ".repeat(20)}`, timestamp: Date.now() });
      manager.appendMessage(fauxAssistantMessage(`Later finding ${index}: ${"result ".repeat(20)}`));
    }
    assert.ok(estimatedInput() + reserve >= model.contextWindow - 100,
      "the test must reach the next capacity boundary");
    host.session.refreshContext();
    assert.deepEqual(await host.prompt(sessionId, `Continue work: ${"next ".repeat(60)}`), { accepted: true });
    for (let attempt = 0; attempt < 200 && !manager.getBranch().some((entry) => entry.type === "compaction"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(workerRequests, 1, "capacity admission must reuse the manual summary");
    assert.ok(manager.getBranch().some((entry) => entry.type === "compaction"),
      `the next full request must commit the prepared summary; requests=${harnessMethods.join(",")}; traces=${JSON.stringify(traceEvents)}`);
    await host.session.waitForIdle();
    assert.ok(traceEvents.some((event) => event.taskId === started.taskId && event.type === "committed"));
  } finally {
    releaseRunningTurn();
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
