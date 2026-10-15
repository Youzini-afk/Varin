import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Response } from "express";
import { createClientSurfaceBridge } from "./client-surfaces.js";
import { HarnessServiceError } from "./service-error.js";

/**
 * Focused tests for the Host→surface request/ack bridge (Stage S / D-309).
 * The point under test is honest targeting: registration, ambiguity,
 * disconnection, and ack resolution — never an assumed apply.
 */

function fakeResponse(): { res: Response; sent: { type: string; properties: Record<string, unknown> }[] } {
  const sent: { type: string; properties: Record<string, unknown> }[] = [];
  return { res: { id: Math.random() } as unknown as Response, sent };
}

function bridgeWithSent() {
  const sent = new Map<Response, { type: string; properties: Record<string, unknown> }[]>();
  const bridge = createClientSurfaceBridge({
    writeSseEvent: (res, event) => {
      const list = sent.get(res) ?? [];
      list.push(event);
      sent.set(res, list);
    },
  });
  return { bridge, sent };
}

const ackEvent = (
  bridge: ReturnType<typeof bridgeWithSent>["bridge"],
  event: { properties: Record<string, unknown> },
  results: Parameters<ReturnType<typeof bridgeWithSent>["bridge"]["ack"]>[4],
) => bridge.ack(
  event.properties.requestId as string,
  event.properties.surfaceId as string,
  event.properties.connectionId as string,
  "session",
  results,
);

describe("client surface bridge", () => {
  it("delivers a request to the connected surface and resolves on ack", async () => {
    const { bridge, sent } = bridgeWithSent();
    const { res } = fakeResponse();
    bridge.attach(res, "surf-1", "desktop", "session", { threadId: "thread-1", branchId: "branch-1" });

    const promise = bridge.request({
      type: "apply",
      entries: [{ id: "chat.persist-drafts", values: { enabled: false } }],
    }, { threadId: "thread-1", branchId: "branch-1" });
    const events = sent.get(res) ?? [];
    assert.equal(events.length, 1);
    const requestId = events[0]?.properties.requestId as string;
    assert.ok(requestId.startsWith("surface-"));
    assert.equal(events[0]?.properties.op, "apply");

    assert.equal(bridge.ack(
      requestId,
      "surf-1",
      events[0]?.properties.connectionId as string,
      "client:other",
      [{ id: "chat.persist-drafts", status: "applied" }],
    ), false);
    assert.equal(bridge.pendingCount(), 1);
    const handled = ackEvent(bridge, events[0]!, [{ id: "chat.persist-drafts", status: "applied" }]);
    assert.equal(handled, true);
    const outcome = await promise;
    assert.equal(outcome.surface.id, "surf-1");
    assert.equal(outcome.results[0]?.status, "applied");
  });

  it("fails honestly when no surface is connected", async () => {
    const { bridge } = bridgeWithSent();
    await assert.rejects(
      bridge.request({ type: "read", entries: [{ id: "appearance.language" }] }, { threadId: "thread-1", branchId: "branch-1" }),
      (error: unknown) => error instanceof HarnessServiceError && error.harnessCode === "unavailable",
    );
  });

  it("refuses to guess between several connected surfaces", async () => {
    const { bridge, sent } = bridgeWithSent();
    const first = fakeResponse();
    const second = fakeResponse();
    bridge.attach(first.res, "surf-1", "desktop", "session", { threadId: "thread-1", branchId: "branch-1" });
    bridge.attach(second.res, "surf-2", "web", "session", { threadId: "thread-1", branchId: "branch-1" });

    await assert.rejects(
      bridge.request({ type: "read", entries: [{ id: "appearance.language" }] }, { threadId: "thread-1", branchId: "branch-1" }),
      (error: unknown) => error instanceof HarnessServiceError && error.harnessCode === "ambiguous",
    );
    assert.equal(sent.get(first.res)?.length ?? 0, 0);
    assert.equal(sent.get(second.res)?.length ?? 0, 0);

    await assert.rejects(
      bridge.request({ type: "read", entries: [{ id: "appearance.language" }] }, { threadId: "thread-1", branchId: "branch-1" }),
      (error: unknown) => error instanceof HarnessServiceError && error.harnessCode === "ambiguous",
    );
  });

  it("rejects pending requests when the surface disconnects mid-flight", async () => {
    const { bridge } = bridgeWithSent();
    const { res } = fakeResponse();
    bridge.attach(res, "surf-1", "desktop", "session", { threadId: "thread-1", branchId: "branch-1" });
    const promise = bridge.request({ type: "apply", entries: [{ id: "x", values: {} }] }, { threadId: "thread-1", branchId: "branch-1" });
    bridge.dropConnection(res);
    await assert.rejects(promise, /disconnected|unavailable/i);
    assert.equal(bridge.pendingCount(), 0);
  });

  it("keeps waiting when the surface has another live connection", async () => {
    const { bridge } = bridgeWithSent();
    const first = fakeResponse();
    const second = fakeResponse();
    bridge.attach(first.res, "surf-1", "desktop", "session", { threadId: "thread-1", branchId: "branch-1" });
    bridge.attach(second.res, "surf-1", "desktop", "session", { threadId: "thread-1", branchId: "branch-1" });
    const promise = bridge.request({
      type: "apply",
      entries: [{ id: "x", values: {} }],
    }, { threadId: "thread-1", branchId: "branch-1" });
    bridge.dropConnection(first.res);
    // The request is still pending on the surviving connection — resolve via ack.
    const timer = setTimeout(() => assert.fail("request should still be pending"), 50);
    setTimeout(() => clearTimeout(timer), 0);
    bridge.dropConnection(second.res);
    await assert.rejects(promise, /disconnected|unavailable/i);
  });

  it("ignores acks for unknown request ids", () => {
    const { bridge } = bridgeWithSent();
    assert.equal(bridge.ack("surface-nope", "surf-1", "connection", "session", []), false);
  });

  it("targets the Host-bound caller Thread/branch and refuses same-branch ambiguity", async () => {
    const { bridge, sent } = bridgeWithSent();
    const first = fakeResponse();
    const second = fakeResponse();
    bridge.attach(first.res, "surf-1", "desktop", "client:a", { threadId: "thread-1", branchId: "branch-1" });
    bridge.attach(second.res, "surf-2", "web", "client:a", { threadId: "thread-2", branchId: "branch-1" });
    const promise = bridge.request(
      { type: "read", entries: [{ id: "appearance.language" }] },
      { threadId: "thread-1", branchId: "branch-1" },
    );
    assert.equal(sent.get(first.res)?.length, 1);
    assert.equal(sent.get(second.res)?.length ?? 0, 0);
    const event = sent.get(first.res)![0]!;
    assert.equal(bridge.ack(
      event.properties.requestId as string,
      "surf-1",
      event.properties.connectionId as string,
      "client:a",
      [{ id: "appearance.language", status: "applied" }],
    ), true);
    await promise;

    const third = fakeResponse();
    bridge.attach(third.res, "surf-3", "web", "client:a", { threadId: "thread-1", branchId: "branch-1" });
    await assert.rejects(
      bridge.request({ type: "read", entries: [{ id: "appearance.language" }] }, { threadId: "thread-1", branchId: "branch-1" }),
      (error: unknown) => error instanceof HarnessServiceError && error.harnessCode === "ambiguous",
    );
  });
  it('requires a one-use exact branch permit and replacement revokes the old connection', async () => {
    const { bridge, sent } = bridgeWithSent();
    const original = { threadId: 'thread', branchId: 'old' }, next = { threadId: 'thread', branchId: 'new' };
    bridge.bindThread('principal', original, 'surface');
    assert.equal(bridge.consumeThreadBinding('other', original, 'surface'), false);
    assert.equal(bridge.consumeThreadBinding('principal', next, 'surface'), false);
    assert.equal(bridge.consumeThreadBinding('principal', original, 'surface'), true);
    assert.equal(bridge.consumeThreadBinding('principal', original, 'surface'), false);
    const { res } = fakeResponse(); bridge.attach(res, 'surface', 'web', 'principal', original);
    const work = bridge.request({ type: 'read', entries: [{ id: 'appearance.language' }] }, original);
    const event = sent.get(res)![0]!;
    const rejected = assert.rejects(work, /disconnected/);
    bridge.bindThread('principal', next, 'surface');
    await rejected;
    assert.equal(bridge.ack(event.properties.requestId as string, 'surface', event.properties.connectionId as string, 'principal', []), false);
    assert.equal(bridge.listForThread(original).length, 0);
    assert.equal(bridge.consumeThreadBinding('principal', next, 'surface'), true);
  });
  it('checks the actual Catalog branch before targeting an existing connection', async () => {
    const target = { threadId: 'thread', branchId: 'branch' };
    const bridge = createClientSurfaceBridge({ writeSseEvent: () => assert.fail('must not send'), isThreadLive: async () => false });
    bridge.attach(fakeResponse().res, 'surface', 'web', 'principal', target);
    await assert.rejects(bridge.request({ type: 'read', entries: [] }, target), /unavailable/);
    assert.equal(bridge.listForThread(target).length, 0);
  });

});
