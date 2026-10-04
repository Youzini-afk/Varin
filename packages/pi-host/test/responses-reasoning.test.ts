import assert from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { convertResponsesMessages, processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";

const model: Model<"openai-responses"> = {
  api: "openai-responses", provider: "openai", id: "reasoning-fixture", name: "Reasoning fixture",
  baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const reasoning = (id = "rs_1", text = "", encrypted_content?: string) => ({
  id, type: "reasoning", summary: text ? [{ type: "summary_text", text }] : [],
  ...(encrypted_content ? { encrypted_content } : {}),
});
const added = (item: Record<string, unknown> = reasoning(), output_index = 0) => ({ type: "response.output_item.added", output_index, item });
const itemDone = (item: Record<string, unknown> = reasoning(), output_index = 0) => ({ type: "response.output_item.done", output_index, item });
const terminal = (output: unknown[] = [], status = "completed") => ({
  type: `response.${status}`, response: { id: "resp_1", status, output,
    ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
  },
});

async function parse(events: Record<string, unknown>[]) {
  const output: AssistantMessage = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 1,
    content: [], stopReason: "stop", usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  type ResponseEvent = Parameters<typeof processResponsesStream>[0] extends AsyncIterable<infer Event> ? Event : never;
  const provider = (async function* () {
    for (const [sequence_number, event] of events.entries()) yield { sequence_number, ...event } as unknown as ResponseEvent;
  })();
  const stream = createAssistantMessageEventStream();
  const received = (async () => {
    const thinking: string[] = [];
    for await (const event of stream) {
      if (event.type === "thinking_delta") thinking.push(event.delta);
      if (event.type === "thinking_end") thinking.push(event.content);
    }
    return thinking;
  })();
  await processResponsesStream(provider, output, stream, model);
  stream.push({ type: "done", reason: output.stopReason === "length" ? "length" : "stop", message: output });
  return { output: await stream.result(), received: await received };
}

test("Responses recovers completed reasoning text and summary parts without deltas", async () => {
  for (const event of [
    { type: "response.reasoning_summary_text.done", summary_index: 0, text: "visible summary" },
    { type: "response.reasoning_summary_part.done", summary_index: 0, part: { type: "summary_text", text: "visible summary" } },
    { type: "response.reasoning_text.done", content_index: 0, text: "visible summary" },
  ]) {
    const result = await parse([added(), { ...event, output_index: 0, item_id: "rs_1" }, itemDone(), terminal()]);
    assert.equal(result.output.content[0]?.type, "thinking");
    assert.equal((result.output.content[0] as { thinking: string }).thinking, "visible summary", event.type);
    assert.ok(result.received.includes("visible summary"), "recovered text must reach stream consumers");
  }
});

test("Responses keeps reasoning items and summary parts separate without repeating streamed text", async () => {
  const result = await parse([
    added(), added(reasoning("rs_2"), 1),
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "first" },
    { type: "response.reasoning_summary_text.done", output_index: 0, summary_index: 0, text: "first part" },
    { type: "response.reasoning_summary_part.done", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "first part" } },
    { type: "response.reasoning_summary_text.delta", output_index: 1, summary_index: 0, delta: "other item" },
    { type: "response.reasoning_summary_text.done", output_index: 0, summary_index: 1, text: "second part" },
    added({ id: "msg_1", type: "message", content: [] }, 2),
    { type: "response.output_text.delta", output_index: 2, content_index: 0, delta: "answer" },
    itemDone({ id: "msg_1", type: "message", content: [{ type: "output_text", text: "answer" }] }, 2),
    itemDone(), itemDone(reasoning("rs_2"), 1), terminal(),
  ]);
  assert.deepEqual(result.output.content.map(part => part.type === "thinking" ? part.thinking : part.type === "text" ? part.text : ""), [
    "first part\n\nsecond part", "other item", "answer",
  ]);
});

test("Responses restores visible reasoning and encrypted replay state from terminal output", async () => {
  for (const status of ["completed", "incomplete"]) {
    for (const prefix of [[], [added(), itemDone()]]) {
      const item = reasoning("rs_1", "terminal summary", "opaque-state");
      const result = await parse([...prefix, terminal([item], status)]);
      assert.equal(result.output.content.length, 1);
      const block = result.output.content[0];
      assert.ok(block?.type === "thinking");
      assert.equal(block.thinking, "terminal summary");
      assert.deepEqual(JSON.parse(block.thinkingSignature!), item);
      assert.equal(result.output.stopReason, status === "completed" ? "stop" : "length");
      assert.ok(result.received.includes("terminal summary"));
    }
  }
});

test("Responses retains encrypted-only reasoning for replay while leaving visible text empty", async () => {
  const result = await parse([added(), itemDone(reasoning("rs_1", "", "opaque-state")), terminal([reasoning()])]);
  const block = result.output.content[0];
  assert.ok(block?.type === "thinking");
  assert.equal(block.thinking, "");
  const replay = convertResponsesMessages(model, normalizeContext({ messages: [result.output] }), new Set(["openai"]));
  assert.deepEqual(replay, [reasoning("rs_1", "", "opaque-state")]);
});
