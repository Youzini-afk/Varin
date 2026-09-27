import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { CompactionTaskSpec } from "@varin/protocol";
import { PiRuntimeBroker } from "../src/index.js";

test("compaction runs and queries in its own process, cancels, and rejects an expired owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-compaction-process-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await mkdir(join(root, ".pi"));
  let hold = false;
  let onHeld: (() => void) | undefined;
  const bodies: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += chunk;
    const body = JSON.parse(input) as (typeof bodies)[number];
    bodies.push(body);
    if (hold) { onHeld?.(); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const hasQueryResult = body.messages.some((message) => message.role === "tool");
    const delta = hasQueryResult
      ? { content: "Continue the original task; the recorded evidence was checked." }
      : { tool_calls: [{ index: 0, id: "history-1", type: "function",
        function: { name: "history", arguments: '{"entry":"old"}' } }] };
    const chunk = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    chunk({ id: "response", object: "chat.completion.chunk", model: "summary-model",
      choices: [{ index: 0, delta, finish_reason: null }] });
    chunk({ id: "response", object: "chat.completion.chunk", model: "summary-model",
      choices: [{ index: 0, delta: {}, finish_reason: hasQueryResult ? "stop" : "tool_calls" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const model = { api: "openai-completions", provider: "local-summary", id: "summary-model", name: "Summary",
    baseUrl, contextWindow: 32_000, maxTokens: 2_000, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  await writeFile(join(root, ".pi", "models.json"), JSON.stringify({ providers: {
    "local-summary": { api: model.api, baseUrl, apiKey: "local-test-key", models: [model] },
  } }));
  const broker = new PiRuntimeBroker({
    agentDir, cwd: root,
    client: { clientName: "compaction-process-test", clientVersion: "0.1.0", mode: "test" },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: resolve(import.meta.dirname, "../../pi-host/src/main.ts"),
    // The child must use the parent's one-session grant, which is not saved in
    // ProjectTrustStore and cannot be reconstructed from disk.
    promptForProjectTrust: async () => ({ trusted: true, remember: false }),
  });
  let registeredWorker = "";
  let droppedWorker = "";
  const progress: string[] = [];
  const unsubscribe = broker.subscribe((event) => {
    if (event.kind !== "host" || event.role !== "compaction") return;
    if (event.envelope.event === "compaction.trace") {
      progress.push(event.envelope.data.type);
      return;
    }
    if (event.envelope.event !== "harness.request") return;
    const data = event.envelope.data as { requestId: string; method: string };
    assert.equal(event.workerId, registeredWorker);
    assert.equal(data.method, "compaction.history");
    void broker.requestForWorker(event.workerId, "harness.respond", {
      sessionId: event.sessionId!, requestId: data.requestId, ok: true,
      result: { content: [{ type: "text", text: "Original evidence from old entry." }], details: {} },
    });
  });
  try {
    const session = await broker.createSession(root);
    const spec: CompactionTaskSpec = {
      projectTrusted: true,
      sessionId: session.sessionId, boundaryCompactionId: null,
      firstSummarizedEntryId: "old", lastSummarizedEntryId: "old", firstKeptEntryId: "recent",
      fixedLeafEntryId: "recent", isSplitTurn: false, model,
      previousSummary: "The earlier requirement must survive the second compaction.",
      summarizedMessages: [{ role: "user", content: "Original task", timestamp: 1 }],
      turnPrefixMessages: [], keptMessages: [{ role: "user", content: "Recent clarification", timestamp: 2 }],
      options: { maxTokens: 1_000 },
    };
    const callbacks = {
      registerWorker: (id: string) => { registeredWorker = id; },
      dropWorker: (id: string) => { droppedWorker = id; },
    };
    const result = await broker.runCompactionTask(session.sessionId, spec, callbacks);
    assert.match(result.summary, /recorded evidence/);
    assert.equal(result.queries, 1);
    assert.ok(result.trace?.taskId);
    assert.deepEqual(result.trace?.entries.map((entry) => entry.kind), ["tool-call", "tool-result", "assistant"]);
    assert.equal(result.trace?.entries.at(-1)?.text, result.summary);
    assert.deepEqual(progress.filter((type) => type !== "delta"), ["started", "entry", "entry", "entry", "finished"]);
    assert.equal(droppedWorker, registeredWorker);
    assert.match(JSON.stringify(bodies[0]), /earlier requirement must survive/);
    assert.equal(broker.workerCount, 1, "only the parent session remains");

    hold = true;
    const held = new Promise<void>((resolveHeld) => { onHeld = resolveHeld; });
    const abort = new AbortController();
    const cancelled = broker.runCompactionTask(session.sessionId, spec, { ...callbacks, signal: abort.signal });
    // Attach the rejection consumer before cancellation can settle the request.
    const cancelledResult = assert.rejects(cancelled);
    await held;
    abort.abort();
    await cancelledResult;
    assert.equal(broker.workerCount, 1);

    await assert.rejects(broker.runCompactionTask(session.sessionId, spec, {
      ...callbacks,
      registerWorker: async (id) => {
        registeredWorker = id;
        await broker.closeSession(session.sessionId);
      },
    }), /owner exited or changed/);
    assert.equal(broker.workerCount, 0);
  } finally {
    unsubscribe();
    await broker.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    await rm(root, { recursive: true, force: true });
  }
});
