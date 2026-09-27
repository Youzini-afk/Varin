import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeEvent,
  createRuntimeRequest,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  isRuntimeMethod,
  parseAgentInputContext,
  VARIN_PROTOCOL_VERSION,
  ProtocolDecodeError,
} from "../src/index.js";

describe("surface runtime protocol", () => {
  it("keeps passive input delivery and parent capture on the private Host boundary", () => {
    assert.equal(isRuntimeMethod("agent.notify"), false);
    assert.equal(isRuntimeMethod("session.input.capture"), false);
  });

  it("parses only content-free input source fields", () => {
    assert.deepEqual(parseAgentInputContext({
      source: "surface",
      workspaceId: "workspace-1",
      dirtyPaths: ["draft.ts"],
      snapshot: { status: "ready", ref: "opaque-ref" },
      content: "must not cross the runtime boundary",
    }), {
      source: "surface",
      workspaceId: "workspace-1",
      dirtyPaths: ["draft.ts"],
      snapshot: { status: "ready", ref: "opaque-ref" },
    });
    assert.equal(parseAgentInputContext({
      source: "surface",
      workspaceId: "workspace-1",
      dirtyPaths: ["draft.ts", "draft.ts"],
      snapshot: { status: "ready", ref: "opaque-ref" },
    }), null);
  });

  it("round-trips session-scoped requests", () => {
    const request = createRuntimeRequest("req-1", "provider.list", {
      sessionId: "session-1",
    });
    const configRequest = createRuntimeRequest("req-2", "config.document.update", {
      cwd: "C:/workspace",
      expectedRevision: "revision-1",
      path: "wtf.json",
      remove: [],
      scope: "global",
      set: { words: ["oops"] },
    });
    const promptRequest = createRuntimeRequest("req-3", "agent.prompt", {
      inputContext: {
        source: "surface",
        roots: [{ workspaceId: "workspace-1", dirtyPaths: ["draft.ts"] }],
        snapshot: { status: "ready", ref: "opaque-ref" },
      },
      instructions: "hidden context",
      sessionId: "session-1",
      text: "visible prompt",
    });
    const featureRequest = createRuntimeRequest("req-4", "session.features.mutate", {
      mutation: {
        objective: "Ship the Pi-native feature",
        tokenBudget: 20_000,
        type: "goal.start",
      },
      sessionId: "session-1",
    });
    const watchRequest = createRuntimeRequest("req-5", "config.watch", {
      cwd: "C:/workspace",
      target: { authority: "aft-user", kind: "text-authority" },
    });
    const authorityRequest = createRuntimeRequest("req-6", "config.text.authority.get", {
      authority: "aft-user",
      cwd: "C:/workspace",
    });
    const clearQueueRequest = createRuntimeRequest("req-7", "agent.queue.clear", {
      sessionId: "session-1",
    });

    assert.deepEqual(decodeRuntimeEnvelope(encodeRuntimeEnvelope(request)), request);
    assert.deepEqual(
      decodeRuntimeEnvelope(encodeRuntimeEnvelope(configRequest)),
      configRequest,
    );
    assert.deepEqual(
      decodeRuntimeEnvelope(encodeRuntimeEnvelope(promptRequest)),
      promptRequest,
    );
    assert.equal(JSON.stringify(promptRequest).includes("draft document body"), false);
    assert.deepEqual(
      decodeRuntimeEnvelope(encodeRuntimeEnvelope(featureRequest)),
      featureRequest,
    );
    assert.deepEqual(decodeRuntimeEnvelope(encodeRuntimeEnvelope(watchRequest)), watchRequest);
    assert.deepEqual(
      decodeRuntimeEnvelope(encodeRuntimeEnvelope(authorityRequest)),
      authorityRequest,
    );
    assert.deepEqual(
      decodeRuntimeEnvelope(encodeRuntimeEnvelope(clearQueueRequest)),
      clearQueueRequest,
    );
    assert.equal(isRuntimeMethod("config.document.get"), true);
    assert.equal(isRuntimeMethod("agentProvider.action"), true);
    assert.equal(isRuntimeMethod("agentProvider.list"), true);
    assert.equal(isRuntimeMethod("agent.queue.clear"), true);
    assert.equal(isRuntimeMethod("config.document.update"), true);
    assert.equal(isRuntimeMethod("config.text.get"), true);
    assert.equal(isRuntimeMethod("config.text.update"), true);
    assert.equal(isRuntimeMethod("config.text.authority.get"), true);
    assert.equal(isRuntimeMethod("config.text.authority.update"), true);
    assert.equal(isRuntimeMethod("config.unwatch"), true);
    assert.equal(isRuntimeMethod("config.watch"), true);
    assert.equal(isRuntimeMethod("mcp.config.snapshot"), true);
    assert.equal(isRuntimeMethod("harness.embed"), false);
    assert.equal(isRuntimeMethod("harness.rerank"), false);
    assert.equal(isRuntimeMethod("harness.inference.cancel"), false);
    assert.equal(isRuntimeMethod("package.setEnabled"), true);
    assert.equal(isRuntimeMethod("package.foundation.status"), true);
    assert.equal(isRuntimeMethod("package.foundation.restore"), true);
    assert.equal(isRuntimeMethod("package.foundation.setAutoInstallNew"), true);
    assert.equal(isRuntimeMethod("session.tree"), true);
    assert.equal(isRuntimeMethod("session.features.get"), true);
    assert.equal(isRuntimeMethod("session.features.mutate"), true);
    assert.equal(isRuntimeMethod("session.archive"), true);
    assert.equal(isRuntimeMethod("session.unarchive"), true);
    assert.equal(isRuntimeMethod("session.delete"), true);
    assert.equal(isRuntimeMethod("session.entries.preview"), true);
    assert.equal(isRuntimeMethod("thinking.select"), true);
    assert.equal(isRuntimeMethod("project.trust.respond"), true);
    assert.equal(isRuntimeMethod("recovery.status"), true);
    assert.equal(isRuntimeMethod("recovery.navigate"), true);
    assert.equal(isRuntimeMethod("recovery.repair"), true);
    assert.equal(isRuntimeMethod("resource.copy"), true);
    assert.equal(isRuntimeMethod("resource.create"), true);
    assert.equal(isRuntimeMethod("resource.delete"), true);
    assert.equal(isRuntimeMethod("resource.get"), true);
    assert.equal(isRuntimeMethod("resource.list"), true);
    assert.equal(isRuntimeMethod("resource.update"), true);
    assert.equal(isRuntimeMethod("recovery.apply"), false);
    assert.equal(isRuntimeMethod("session.recovery.navigation.prepare"), false);
    assert.equal(isRuntimeMethod("session.recovery.navigation.commit"), false);
  });

  it("carries an explicit worker source on events", () => {
    const event = createRuntimeEvent(
      { executionId: "execution-1", role: "session", runtimeGeneration: 2, sessionId: "session-1", workerId: "worker-1" },
      12,
      "session.closed",
      { sessionId: "session-1" },
    );

    assert.deepEqual(decodeRuntimeEnvelope(encodeRuntimeEnvelope(event)), event);

    const extensionState = createRuntimeEvent(
      { role: "session", runtimeGeneration: 2, sessionId: "session-1", workerId: "worker-1" },
      13,
      "extension.state",
      {
        channel: "pi-mcp-adapter/status/v1",
        sessionId: "session-1",
        value: { connectedCount: 1, version: 1 },
      },
    );
    assert.deepEqual(decodeRuntimeEnvelope(encodeRuntimeEnvelope(extensionState)), extensionState);

    const configChanged = createRuntimeEvent(
      { role: "workspace", runtimeGeneration: 2, workerId: "worker-2" },
      14,
      "config.changed",
      {
        reason: "rename",
        target: { authority: "aft-user", kind: "text-authority" },
        watchId: "watch-1",
      },
    );
    assert.deepEqual(decodeRuntimeEnvelope(encodeRuntimeEnvelope(configChanged)), configChanged);

    const packageProgress = createRuntimeEvent(
      { role: "package", runtimeGeneration: 2, workerId: "worker-3" },
      15,
      "package.progress",
      { message: "Installing", operation: "install", source: "npm:pi-mcp-adapter" },
    );
    assert.deepEqual(decodeRuntimeEnvelope(encodeRuntimeEnvelope(packageProgress)), packageProgress);
  });

  it("rejects worker-only methods and unrouted events", () => {
    assert.equal(isRuntimeMethod("host.shutdown"), false);
    assert.equal(isRuntimeMethod("package.bootstrap"), false);
    assert.equal(isRuntimeMethod("session.resolve"), false);
    assert.throws(
      () =>
        decodeRuntimeEnvelope(
          JSON.stringify({
            id: "x",
            kind: "request",
            method: "host.shutdown",
            params: {},
            v: VARIN_PROTOCOL_VERSION,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, "unsupported_method");
        return true;
      },
    );
    assert.throws(
      () =>
        decodeRuntimeEnvelope(
          JSON.stringify({
            data: { sessionId: "s" },
            event: "session.closed",
            kind: "event",
            seq: 0,
            v: VARIN_PROTOCOL_VERSION,
          }),
        ),
      /event.source/,
    );
    assert.throws(
      () =>
        decodeRuntimeEnvelope(
          JSON.stringify({
            data: {},
            event: "unknown",
            kind: "event",
            seq: 0,
            source: { role: "catalog", workerId: "w" },
            v: VARIN_PROTOCOL_VERSION,
          }),
        ),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, "unsupported_event");
        return true;
      },
    );
  });
});
