import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { HostEvent, HostEventData, HostMethodParams } from "@varin/protocol";
import { SessionHost } from "../src/session-host.js";

async function fixture(t: TestContext, mode: "all" | "one-at-a-time" = "one-at-a-time") {
  const root = await mkdtemp(join(tmpdir(), "varin-native-queue-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    compaction: { enabled: false }, harness: { context: { backgroundPreparation: false } },
    steeringMode: mode, followUpMode: mode,
  }));
  const faux = fauxProvider();
  const model = faux.getModel();
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
      if (event !== "harness.request") return;
      const request = data as { requestId: string };
      queueMicrotask(() => host.respondHarness(host.sessionId ?? "", request.requestId, {
        ok: false, error: { code: "unavailable", message: "Queue fixture has no harness service" },
      }));
    },
  });
  const { sessionId } = await host.create(root);
  t.after(async () => {
    await host.dispose();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  return { host, sessionId, faux };
}

for (const mode of ["one-at-a-time", "all"] as const) test(`native ${mode} queue edits and sends one delivery unit without losing images or instructions`, async t => {
  const { host, sessionId, faux } = await fixture(t, mode);
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const contexts: string[] = [];
  faux.setResponses([
    async () => { started(); await blocked; return fauxAssistantMessage("first answer"); },
    (context) => { contexts.push(JSON.stringify(context)); return fauxAssistantMessage("steering answer"); },
    (context) => { contexts.push(JSON.stringify(context)); return fauxAssistantMessage("follow-up answer"); },
  ]);
  t.after(() => release());
  await host.prompt(sessionId, "initial");
  await entered;
  const image = { data: "aW1hZ2U=", mimeType: "image/png" };
  await host.followUp(sessionId, "same text", undefined, "REMOVE this context");
  await host.followUp(sessionId, "same text", [image], "KEEP selected context");
  await host.followUp(sessionId, "last follow-up", undefined, "KEEP last context");
  const [first, selected, last] = host.snapshot().queuedMessages;
  assert.notEqual(first!.id, selected!.id);
  assert.equal(selected!.imageCount, 1);
  assert.equal(JSON.stringify(host.snapshot().queuedMessages).includes(image.data), false);
  const mutate = (entry: typeof selected, action: HostMethodParams<"agent.queue.update">["action"], text?: string) =>
    host.updateQueue({ sessionId, id: entry!.id, revision: entry!.revision, action, ...(text === undefined ? {} : { text }) });
  assert.equal((await mutate(selected, "edit", "revised input")).status, "updated");
  assert.equal((await mutate(selected, "remove")).status, "conflict");
  assert.equal((await mutate(first, "remove")).status, "updated");
  const revised = host.snapshot().queuedMessages.find(message => message.id === selected!.id)!;
  assert.equal((await mutate(revised, "steer")).accepted, true);
  assert.equal((await mutate(revised, "steer")).status, "conflict");
  assert.deepEqual(host.snapshot().queuedMessages.map(message => [message.id, message.mode]), [[selected!.id, "steer"], [last!.id, "followUp"]]);
  release();
  await host.session.waitForIdle();
  assert.equal(faux.state.callCount, 3, "hidden instructions must not create a separate model turn");
  assert.ok(contexts[0]!.includes("revised input"));
  assert.ok(contexts[0]!.includes(image.data));
  assert.ok(contexts[0]!.includes("KEEP selected context"));
  assert.ok(!contexts[0]!.includes("last follow-up"));
  assert.ok(!contexts.join().includes("REMOVE this context"));
  assert.ok(contexts[1]!.includes("last follow-up"));
  assert.deepEqual(host.snapshot().queuedMessages, []);
  assert.equal(host.snapshot().pendingMessageCount, 0);
  assert.equal((await mutate(last, "steer")).status, "missing");
  assert.equal(faux.state.callCount, 3, "sending a consumed identity must never duplicate it");
  const users = host.session.messages.filter(message => message.role === "user");
  assert.equal(users.length, 3);
});

test("late queue admission resumes after an idle boundary without a duplicate user prompt", async t => {
  const { host, sessionId, faux } = await fixture(t);
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("resumed")]);
  await host.prompt(sessionId, "initial");
  await host.session.waitForIdle();
  // Models can settle between a surface's busy observation and queue admission.
  await host.followUp(sessionId, "late input", undefined, "late instructions");
  await host.session.waitForIdle();
  assert.equal(faux.state.callCount, 2);
  assert.equal(host.session.messages.filter(message => message.role === "user").length, 2);
  assert.deepEqual(host.snapshot().queuedMessages, []);
});

test("removing a drained native message is a no-op even before its public message event completes", async t => {
  const { host, sessionId, faux } = await fixture(t);
  faux.setResponses([fauxAssistantMessage("done")]);
  // A native pending entry after a stop remains user-controlled until explicitly sent.
  await host.session.followUp("pending");
  const entry = host.snapshot().queuedMessages[0]!;
  let lateResult: string | undefined;
  host.session.subscribe(event => {
    if (event.type === "message_start" && event.message.role === "user") {
      lateResult = host.session.updateQueuedUserMessage(entry.id, entry.revision + 1, "remove");
    }
  });
  await host.updateQueue({ sessionId, id: entry.id, revision: entry.revision, action: "steer" });
  await host.session.waitForIdle();
  assert.equal(lateResult, "missing");
  assert.equal(faux.state.callCount, 1);
  assert.equal(host.session.messages.filter(message => message.role === "user").length, 1);
});
