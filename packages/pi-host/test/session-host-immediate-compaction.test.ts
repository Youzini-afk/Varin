import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { CompactionTraceUpdate, HostEvent, HostEventData } from "@varin/protocol";
import { SessionHost } from "../src/session-host.js";

const SUMMARY = "Prepared summary: retain the repository decisions and continue the active task.";
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5_000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), "expected compaction state did not arrive");
};

async function fixture(t: TestContext, summary = SUMMARY) {
  const root = await mkdtemp(join(tmpdir(), "varin-immediate-compaction-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: false }, harness: { context: { backgroundPreparation: false } },
  }));
  const faux = fauxProvider();
  const model = { ...faux.getModel(), contextWindow: 60_000, maxTokens: 400 };
  const traces: CompactionTraceUpdate[] = [];
  let workerRequests = 0;
  const host = new SessionHost({ agentDir, projectTrustOverride: true,
    configureServices: async services => {
      services.modelRuntime.registerProvider(model.provider, {
        streamSimple: faux.provider.streamSimple, api: model.api, baseUrl: model.baseUrl,
        models: [{ api: model.api, baseUrl: model.baseUrl, contextWindow: model.contextWindow,
          cost: model.cost, id: model.id, input: model.input, maxTokens: model.maxTokens,
          name: model.name, reasoning: model.reasoning }],
      });
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    },
    emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
      if (event === "compaction.trace") traces.push(data as CompactionTraceUpdate);
      if (event !== "harness.request") return;
      const request = data as { method: string; requestId: string; params: { taskId?: string } };
      let result: unknown;
      if (request.method === "compaction.run") {
        workerRequests += 1;
        result = { summary, queries: 0,
          trace: { taskId: request.params.taskId, entries: [{ kind: "assistant", at: 1, text: SUMMARY }] } };
      } else if (request.method === "zone2.assemble") result = { content: null, eventCursor: 0 };
      else if (request.method === "zone2.status") result = { status: "ready", content: null };
      else if (request.method === "context.retained") result = { acknowledged: true };
      else return;
      queueMicrotask(() => host.respondHarness(host.sessionId ?? "", request.requestId, { ok: true, result }));
    },
  });
  t.after(async () => {
    await host.dispose();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const { sessionId } = await host.create(root);
  const manager = host.session.sessionManager;
  for (let index = 0; index < 6; index++) {
    manager.appendMessage({ role: "user", content: `Task ${index}: ${"detail ".repeat(150)}`, timestamp: Date.now() });
    manager.appendMessage(fauxAssistantMessage(`Result ${index}: ${"finding ".repeat(150)}`));
  }
  const ready = async () => {
    const result = host.prepareCompaction(sessionId);
    await waitFor(() => host.snapshot().harness?.context.candidate === "ready");
    return result.taskId;
  };
  const committed = () => manager.getBranch().some(entry => entry.type === "compaction");
  return { host, sessionId, manager, faux, traces, ready, committed, workerRequests: () => workerRequests };
}

test("immediate application commits a ready idle summary below capacity with auto compaction off", async t => {
  const f = await fixture(t);
  const taskId = await f.ready();
  assert.equal(f.committed(), false);
  await assert.rejects(f.host.applyCompaction(f.sessionId, "obsolete-task"), /selected summary/);
  assert.equal(f.committed(), false);
  assert.deepEqual(await f.host.applyCompaction(f.sessionId, taskId), { accepted: true, taskId });
  await waitFor(f.committed);
  await waitFor(() => f.traces.some(event => event.type === "committed" && event.taskId === taskId));
  assert.equal(f.workerRequests(), 1);
  assert.equal(f.faux.state.callCount, 0, "applying must not start a foreground model request");
  assert.equal(f.manager.getBranch().at(-1)?.type, "compaction");
  await f.host.applyCompaction(f.sessionId, taskId);
  assert.equal(f.manager.getBranch().filter(entry => entry.type === "compaction").length, 1);
});

test("a final answer finishes before a queued immediate application commits at idle", async t => {
  const f = await fixture(t);
  let release!: () => void;
  let entered = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  f.faux.setResponses([async () => { entered = true; await blocked; return fauxAssistantMessage("Final answer stays raw."); }]);
  await f.host.prompt(f.sessionId, "Continue the current task");
  await waitFor(() => entered);
  const taskId = await f.ready();
  await f.host.applyCompaction(f.sessionId, taskId);
  await f.host.applyCompaction(f.sessionId, taskId);
  assert.equal(f.committed(), false);
  assert.equal(f.host.snapshot().harness?.context.applicationRequested, true);
  release();
  await f.host.session.waitForIdle();
  await waitFor(f.committed);
  assert.ok(JSON.stringify(f.manager.buildSessionContext()).includes("Final answer stays raw."));
  assert.equal(f.workerRequests(), 1);
  assert.equal(f.faux.state.callCount, 1);
});

test("a queued immediate application precedes the next model request without waiting for capacity", async t => {
  const f = await fixture(t);
  let release!: () => void;
  let entered = false;
  let nextContext = "";
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  f.faux.setResponses([
    async () => { entered = true; await blocked; return fauxAssistantMessage("First answer."); },
    context => { nextContext = JSON.stringify(context); return fauxAssistantMessage("Continued."); },
  ]);
  await f.host.prompt(f.sessionId, "Continue");
  await waitFor(() => entered);
  const taskId = await f.ready();
  await f.host.applyCompaction(f.sessionId, taskId);
  await f.host.steer(f.sessionId, "Keep this new instruction after compression");
  release();
  await f.host.session.waitForIdle();
  assert.ok(f.committed());
  assert.ok(nextContext.includes(SUMMARY), nextContext);
  assert.ok(nextContext.includes("Keep this new instruction after compression"));
  assert.equal(f.workerRequests(), 1);
});

test("stop cancels a queued application instead of applying it after the interrupted request", async t => {
  const f = await fixture(t);
  let release!: () => void;
  let entered = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  f.faux.setResponses([async () => { entered = true; await blocked; return fauxAssistantMessage("Interrupted."); }]);
  await f.host.prompt(f.sessionId, "Continue");
  await waitFor(() => entered);
  const taskId = await f.ready();
  await f.host.applyCompaction(f.sessionId, taskId);
  assert.equal(await f.host.abort(f.sessionId, f.host.snapshot().runId), true);
  release();
  await f.host.session.waitForIdle();
  assert.equal(f.committed(), false);
  assert.ok(f.traces.some(event => event.type === "failed" && event.taskId === taskId));
});

test("a prompt arriving during idle application waits and retains its new input in the rebuilt request", async t => {
  const f = await fixture(t);
  const taskId = await f.ready();
  const convert = f.host.session.agent.convertToLlm;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let delay = true;
  f.host.session.agent.convertToLlm = async messages => {
    if (delay) { delay = false; await blocked; }
    return convert(messages);
  };
  let outgoing = "";
  f.faux.setResponses([context => { outgoing = JSON.stringify(context); return fauxAssistantMessage("New answer."); }]);
  const application = f.host.applyCompaction(f.sessionId, taskId);
  await f.host.prompt(f.sessionId, "New input during application");
  assert.equal(f.faux.state.callCount, 0);
  release();
  await application;
  await f.host.session.waitForIdle();
  assert.ok(outgoing.includes(SUMMARY), outgoing);
  assert.ok(outgoing.includes("New input during application"));
  assert.equal(f.workerRequests(), 1);
});

test("a request assembled before application cannot revive its old context after the application finishes", async t => {
  const f = await fixture(t);
  const taskId = await f.ready();
  const convert = f.host.session.agent.convertToLlm;
  let releasePreview!: () => void;
  const preview = new Promise<void>(resolve => { releasePreview = resolve; });
  let holdPreview = true;
  f.host.session.agent.convertToLlm = async messages => {
    if (holdPreview) { holdPreview = false; await preview; }
    return convert(messages);
  };
  const stream = f.host.session.agent.streamFunction;
  let releaseRequest!: () => void;
  const request = new Promise<void>(resolve => { releaseRequest = resolve; });
  let entered = false;
  f.host.session.agent.streamFunction = async (...args) => { entered = true; await request; return stream(...args); };
  t.after(() => { releasePreview(); releaseRequest(); });
  let outgoing = "";
  f.faux.setResponses([context => { outgoing = JSON.stringify(context); return fauxAssistantMessage("Answer."); }]);
  const application = f.host.applyCompaction(f.sessionId, taskId);
  await f.host.prompt(f.sessionId, "Preserve this late input");
  await waitFor(() => entered);
  releasePreview();
  await application;
  assert.equal(f.faux.state.callCount, 0);
  releaseRequest();
  await f.host.session.waitForIdle();
  assert.ok(outgoing.includes(SUMMARY), outgoing);
  assert.ok(outgoing.includes("Preserve this late input"));
});

test("an oversized ready summary fails application without replacing the original history", async t => {
  const f = await fixture(t, "long summary ".repeat(10_000));
  const taskId = await f.ready();
  const leaf = f.manager.getLeafId();
  await assert.rejects(f.host.applyCompaction(f.sessionId, taskId), /does not free input capacity/);
  assert.equal(f.committed(), false);
  assert.equal(f.manager.getLeafId(), leaf);
  assert.ok(f.traces.some(event => event.taskId === taskId && event.type === "failed"));
});

test("stop cancels an idle application before its validated summary is committed", async t => {
  const f = await fixture(t);
  const taskId = await f.ready();
  const convert = f.host.session.agent.convertToLlm;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  let hold = true;
  f.host.session.agent.convertToLlm = async messages => {
    if (hold) { hold = false; await blocked; }
    return convert(messages);
  };
  const applying = f.host.applyCompaction(f.sessionId, taskId);
  const rejected = assert.rejects(applying, /abort|cancel/i);
  assert.equal(f.host.snapshot().isCompacting, true);
  assert.equal(await f.host.abort(f.sessionId, f.host.snapshot().runId), true);
  release();
  await rejected;
  assert.equal(f.committed(), false);
  assert.equal(f.host.snapshot().isCompacting, false);
});
