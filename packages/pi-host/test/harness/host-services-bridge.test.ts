import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HostServicesBridge,
  HarnessRequestError,
} from "../../src/harness/host-services-bridge.js";
import type { HarnessCancelData, HarnessRequestData } from "@varin/protocol";

describe("HostServicesBridge", () => {
  it("correlates request and response by requestId", async () => {
    const emitted: HarnessRequestData[] = [];
    const bridge = new HostServicesBridge({
      emit: (_event, data) => { emitted.push(data); },
      sessionId: "session-1",
    });
    const resultPromise = bridge.request("output.store", { text: "hello" });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]!.method, "output.store");
    assert.ok(!("sessionId" in emitted[0]!));
    const requestId = emitted[0]!.requestId;
    bridge.respond("session-1", requestId, { ok: true, result: { ref: { durability: "ephemeral", generation: "g", handle: "out_abc" }, total: 5 } });
    const result = await resultPromise;
    assert.deepEqual(result, { ref: { durability: "ephemeral", generation: "g", handle: "out_abc" }, total: 5 });
    bridge.dispose();
  });

  it("rejects on timeout", async () => {
    const emitted: Array<{ event: string; data: HarnessRequestData | HarnessCancelData }> = [];
    const bridge = new HostServicesBridge({
      emit: (event, data) => { emitted.push({ event, data }); },
      sessionId: "session-1",
      defaultTimeoutMs: 50,
    });
    const resultPromise = bridge.request("shell.exec", { command: "echo hi" });
    await assert.rejects(resultPromise, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      assert.equal(error.code, "timeout");
      return true;
    });
    const request = emitted.find((item) => item.event === "harness.request")?.data as HarnessRequestData;
    assert.ok(emitted.some((item) => item.event === "harness.cancel" && (item.data as HarnessCancelData).requestId === request.requestId));
    bridge.dispose();
  });

  it("rejects on abort signal", async () => {
    const bridge = new HostServicesBridge({
      emit: () => {},
      sessionId: "session-1",
      defaultTimeoutMs: 10_000,
    });
    const controller = new AbortController();
    const resultPromise = bridge.request("shell.exec", { command: "echo hi" }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(resultPromise, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      assert.equal(error.code, "failed");
      assert.equal(error.message, "aborted");
      return true;
    });
    bridge.dispose();
  });

  it("rejects all pending on dispose", async () => {
    const emitted: Array<{ event: string; data: HarnessRequestData | HarnessCancelData }> = [];
    const bridge = new HostServicesBridge({
      emit: (event, data) => { emitted.push({ event, data }); },
      sessionId: "session-1",
      defaultTimeoutMs: 10_000,
    });
    const p1 = bridge.request("shell.exec", { command: "a" });
    const p2 = bridge.request("shell.exec", { command: "b" });
    bridge.dispose();
    await assert.rejects(p1, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      assert.equal(error.code, "failed");
      assert.equal(error.message, "disposed");
      return true;
    });
    await assert.rejects(p2, (error: unknown) => {
      assert.ok(error instanceof HarnessRequestError);
      return true;
    });
    const requestIds = emitted
      .filter((item) => item.event === "harness.request")
      .map((item) => (item.data as HarnessRequestData).requestId);
    const cancelled = new Set(emitted
      .filter((item) => item.event === "harness.cancel")
      .map((item) => (item.data as HarnessCancelData).requestId));
    assert.ok(requestIds.every((requestId) => cancelled.has(requestId)));
  });

  it("handles 50 concurrent requests each receiving their own result", async () => {
    const emitted: HarnessRequestData[] = [];
    const bridge = new HostServicesBridge({
      emit: (_event, data) => { emitted.push(data); },
      sessionId: "session-1",
      defaultTimeoutMs: 5_000,
    });
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(bridge.request("output.store", { text: `item-${i}` }));
    }
    // Wait for all emits to be collected
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(emitted.length, 50);
    // Respond to each with its own result
    for (let i = 0; i < 50; i++) {
      const data = emitted[i]!;
      bridge.respond("session-1", data.requestId, { ok: true, result: { ref: { durability: "ephemeral", generation: "g", handle: `out_${i}` }, total: i } });
    }
    const results = await Promise.all(promises);
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(results[i], { ref: { durability: "ephemeral", generation: "g", handle: `out_${i}` }, total: i });
    }
    bridge.dispose();
  });

  it("emits harness.cancel on abort and does not start an already-aborted request", async () => {
    const emitted: Array<{ event: string; data: unknown }> = [];
    const bridge = new HostServicesBridge({
      emit: (event, data) => { emitted.push({ event, data }); },
      sessionId: "session-1",
      defaultTimeoutMs: 10_000,
    });
    const controller = new AbortController();
    const pending = bridge.request("explore.query.views", { queryId: "eq_1" }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending);
    assert.ok(emitted.some((item) => item.event === "harness.cancel"));

    const late = new AbortController();
    late.abort();
    const before = emitted.length;
    await assert.rejects(bridge.request("explore.query.views", { queryId: "eq_1" }, { signal: late.signal }));
    assert.equal(emitted.slice(before).some((item) => item.event === "harness.request"), false);
    bridge.dispose();
  });

  it("ignores respond for wrong sessionId", async () => {
    const bridge = new HostServicesBridge({
      emit: () => {},
      sessionId: "session-1",
      defaultTimeoutMs: 10_000,
    });
    const resultPromise = bridge.request("output.store", { text: "hello" });
    // Wrong sessionId → should not resolve
    bridge.respond("session-wrong", "any-id", { ok: true, result: {} });
    // Correct respond still works (we need the requestId, but we can test with a fake one)
    // The wrong-sessionId respond should return false
    const accepted = bridge.respond("session-wrong", "fake-id", { ok: true, result: {} });
    assert.equal(accepted, false);
    // Clean up
    bridge.dispose();
    await assert.rejects(resultPromise);
  });
});


describe("scheduler wait transport lifetime", () => {
  it("wakes dependency watching for new input while leaving other requests active", async () => {
    const events: Array<{ event: string; data: HarnessRequestData | HarnessCancelData }> = [];
    const bridge = new HostServicesBridge({ sessionId: "session", emit: (event, data) => { events.push({ event, data }); } });
    const waiting = bridge.request("thread.wait", {}, { timeoutMs: 0 });
    const reply = bridge.request("thread.send", { threadId: "peer", message: "Please answer", from: "parent-agent", kind: "request", wait: 60 });
    const output = bridge.request("output.read", { handle: "out" });
    bridge.wakeDependencyWaits();
    const wakes = events.filter(entry => entry.event === "harness.cancel").map(entry => entry.data as HarnessCancelData);
    assert.ok(wakes.every(wake => wake.wake === true));
    assert.deepEqual(wakes.map(wake => wake.requestId), events.slice(0, 2).map(entry => (entry.data as HarnessRequestData).requestId));
    bridge.respond("session", wakes[0]!.requestId!, { ok: true, result: { text: "new input", timedOut: false } });
    assert.equal((await waiting).timedOut, false);
    bridge.respond("session", wakes[1]!.requestId!, { ok: true, result: { accepted: true, lifecycle: "active", attention: "none", interrupted: true } });
    assert.equal((await reply).interrupted, true);
    bridge.respond("session", (events[2]!.data as HarnessRequestData).requestId, { ok: true, result: { text: "retained output" } });
    assert.equal((await output).text, "retained output");
    bridge.dispose();
  });
  it("lets scheduler admission outlive a dependency deadline and still cancels", async () => {
    const controller = new AbortController();
    const emitted: Array<{ event: string; data: HarnessRequestData | HarnessCancelData }> = [];
    const bridge = new HostServicesBridge({ sessionId: "session-1", defaultTimeoutMs: 10,
      emit: (event, data) => { emitted.push({ event, data }); } });
    let finished = false;
    const pending = bridge.request("thread.wait", { timeoutMs: 5 }, { timeoutMs: 0, signal: controller.signal });
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof HarnessRequestError && error.message === "aborted");
    void pending.then(() => { finished = true; }, () => { finished = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(finished, false);
    assert.equal((emitted[0]!.data as HarnessRequestData).timeoutMs, 0);
    controller.abort();
    await rejected;
    assert.ok(emitted.some((item) => item.event === "harness.cancel"));
    bridge.dispose();
  });

  it("does not disable another tool's timeout with zero", async () => {
    const bridge = new HostServicesBridge({ emit: () => undefined, sessionId: "session-1" });
    await assert.rejects(bridge.request("output.store", { text: "x" }, { timeoutMs: 0 }),
      (error: unknown) => error instanceof HarnessRequestError && error.code === "timeout");
    bridge.dispose();
  });

  it("lets a shell observation own its wait beyond the generic RPC deadline", async () => {
    const controller = new AbortController();
    const bridge = new HostServicesBridge({ emit: () => undefined, sessionId: "session-1", defaultTimeoutMs: 10 });
    const pending = bridge.request("shell.read", { id: "sh_1", waitMs: 60_000 }, { timeoutMs: 0, signal: controller.signal });
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof HarnessRequestError && error.message === "aborted");
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    await rejected;
    bridge.dispose();
  });
});
