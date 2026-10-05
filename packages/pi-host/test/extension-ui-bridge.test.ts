import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type EventEnvelope,
  type HostEvent,
  type HostEventData,
  VARIN_PROTOCOL_VERSION,
} from "@varin/protocol";
import { ExtensionUiBridge } from "../src/extension-ui-bridge.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

function createHarness() {
  const events: EventEnvelope[] = [];
  let sequence = 0;
  const bridge = new ExtensionUiBridge(
    <E extends HostEvent>(event: E, data: HostEventData<E>) => {
      events.push({
        data,
        event,
        kind: "event",
        seq: sequence++,
        v: VARIN_PROTOCOL_VERSION,
      } as EventEnvelope);
    },
    () => "session-1",
  );
  return { bridge, events };
}

describe("ExtensionUiBridge", () => {
  it("retains a nonblocking question across rebinding and delivers a later answer once", async () => {
    const { bridge } = createHarness();
    const journal = SessionManager.inMemory();
    bridge.bindQuestions(journal);
    const question = { id: "choice", type: "confirm" as const, question: "Use the proposed approach?" };
    const submitted = bridge.postQuestion("question-1", [question]);
    assert.equal((await submitted.result).status, "pending");
    assert.equal(submitted.request.popupUntil - submitted.request.createdAt, 60_000);
    bridge.cancelAll(); bridge.bindQuestions(journal);
    assert.equal(bridge.questionRequests().length, 1);
    const response = { requestId: "question-1", value: [{ id: "choice", value: false }] };
    const replied = bridge.respondWithContinuation(response);
    assert.ok(replied.continuation);
    assert.match(replied.continuation.text, /false/);
    assert.deepEqual(bridge.respondWithContinuation(response), replied);
    assert.equal(bridge.questionRequests().length, 0);
  });

  it("ends a bounded wait without losing the unanswered question, and does not continue twice for an immediate answer", async () => {
    const { bridge } = createHarness();
    bridge.bindQuestions(SessionManager.inMemory());
    const question = { id: "name", type: "input" as const, question: "What is the project name?" };
    const timed = bridge.postQuestion("timed", [question], 0.005);
    assert.equal((await timed.result).status, "pending");
    assert.equal(bridge.questionRequests().length, 1);
    assert.ok(bridge.respondWithContinuation({ requestId: "timed", value: [{ id: "name", value: "Sample" }] }).continuation);
    const waiting = bridge.postQuestion("waiting", [question], 600);
    assert.equal(bridge.respondWithContinuation({ requestId: "waiting", value: [{ id: "name", value: "Sample" }] }).continuation, undefined);
    assert.equal((await waiting.result).status, "answered");
    assert.throws(() => bridge.postQuestion("too-long", [question], 601), /wait_seconds/);
  });

  it("round-trips interactive confirmation requests", async () => {
    const { bridge, events } = createHarness();
    const result = bridge.createContext().confirm("Proceed?", "Apply changes");
    const request = events.find(
      (event) => event.event === "extension.ui.request" && event.data.method === "confirm",
    );
    assert.ok(request && request.event === "extension.ui.request");
    assert.ok(request.data.id);

    assert.equal(bridge.respond({ requestId: request.data.id, value: true }), true);
    assert.equal(await result, true);
    assert.equal(bridge.respond({ requestId: request.data.id, value: false }), false);
  });

  it("dismisses timed out requests", async () => {
    const { bridge, events } = createHarness();
    const result = bridge.createContext().input("Value", "placeholder", { timeout: 5 });

    assert.equal(await result, undefined);
    assert.ok(events.some((event) => event.event === "extension.ui.dismiss"));
  });

  it("tracks editor text and emits fire-and-forget UI state", () => {
    const { bridge, events } = createHarness();
    const context = bridge.createContext();

    context.setEditorText("restored prompt");
    context.notify("done", "info");

    assert.equal(context.getEditorText(), "restored prompt");
    assert.deepEqual(
      events
        .filter((event) => event.event === "extension.ui.request")
        .map((event) => (event.event === "extension.ui.request" ? event.data.method : "")),
      ["setEditorText", "notify"],
    );
  });

  it("renders custom Pi components into a surface-owned read-only panel", async () => {
    const { bridge, events } = createHarness();
    let disposed = false;
    const result = bridge.createContext().custom(() => ({
      dispose: () => {
        disposed = true;
      },
      handleInput: () => {},
      invalidate: () => {},
      render: (width) => [`width ${width}`, "\u001b[31mstatus\u001b[0m"],
    }), {
      overlay: true,
      overlayOptions: { width: 78 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const request = events.find(
      (event) => event.event === "extension.ui.request" && event.data.method === "custom",
    );
    assert.ok(request && request.event === "extension.ui.request");
    assert.ok(request.data.id);
    assert.deepEqual(request.data.payload, {
      lines: ["width 78", "status"],
      title: "Extension panel",
    });

    assert.equal(bridge.respond({ requestId: request.data.id }), true);
    assert.equal(await result, undefined);
    assert.equal(disposed, true);
  });
});
