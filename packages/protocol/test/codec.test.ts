import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEvent,
  createRequest,
  createSuccessResponse,
  decodeEnvelope,
  encodeEnvelope,
  JsonLineDecoder,
  VARIN_PROTOCOL_VERSION,
  ProtocolDecodeError,
  validateEnvelope,
} from "../src/index.js";

describe("protocol envelopes", () => {
  it("round-trips typed requests", () => {
    const request = createRequest("req-1", "host.handshake", {
      clientName: "test",
      clientVersion: "0.0.0",
      mode: "test",
      protocolVersions: [VARIN_PROTOCOL_VERSION],
    });

    assert.deepEqual(decodeEnvelope(encodeEnvelope(request).trimEnd()), request);
  });

  it("round-trips responses and events", () => {
    const response = createSuccessResponse<"agent.abort">("req-2", { aborted: true });
    const event = createEvent(4, "session.closed", { sessionId: "session-1" });

    assert.deepEqual(decodeEnvelope(encodeEnvelope(response).trimEnd()), response);
    assert.deepEqual(decodeEnvelope(encodeEnvelope(event).trimEnd()), event);
  });

  it("rejects malformed and unsupported envelopes", () => {
    assert.throws(
      () => decodeEnvelope("{"),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, "invalid_json");
        return true;
      },
    );
    assert.throws(
      () => decodeEnvelope('{"v":999,"kind":"request","id":"x","method":"x","params":{}}'),
      /Unsupported protocol version/,
    );
    assert.throws(
      () =>
        decodeEnvelope(
          JSON.stringify({
            data: {},
            event: "x",
            kind: "event",
            seq: -1,
            v: VARIN_PROTOCOL_VERSION,
          }),
        ),
      /event.seq/,
    );
  });

  it("validates already decoded requests, responses, and events", () => {
    for (const envelope of [
      createRequest("request", "session.list", {}),
      createSuccessResponse<"agent.abort">("response", { aborted: true }),
      createEvent(0, "session.closed", { sessionId: "fixture" }),
    ]) {
      assert.deepEqual(validateEnvelope(envelope), decodeEnvelope(JSON.stringify(envelope)));
    }
  });

  it("keeps object and text envelope failures equivalent after JSON decoding", () => {
    const invalid: unknown[] = [
      null,
      [],
      {},
      { v: 999, kind: "request", id: "request", method: "session.list", params: {} },
      { v: 1, kind: "unknown" },
      { v: 1, kind: "request", id: "", method: "session.list", params: {} },
      { v: 1, kind: "request", id: "request", method: "", params: {} },
      { v: 1, kind: "request", id: "request", method: "session.list" },
      { v: 1, kind: "response", id: "", ok: true, result: {} },
      { v: 1, kind: "response", id: "response", ok: 1, result: {} },
      { v: 1, kind: "response", id: "response", ok: true },
      { v: 1, kind: "response", id: "response", ok: false, error: null },
      { v: 1, kind: "event", event: "", seq: 0, data: {} },
      { v: 1, kind: "event", event: "session.closed", seq: -1, data: {} },
      { v: 1, kind: "event", event: "session.closed", seq: 0.5, data: {} },
      { v: 1, kind: "event", event: "session.closed", seq: "0", data: {} },
      { v: 1, kind: "event", event: "session.closed", seq: 0 },
    ];
    for (const value of invalid) {
      let expected: ProtocolDecodeError | undefined;
      try {
        decodeEnvelope(JSON.stringify(value));
      } catch (error) {
        assert.ok(error instanceof ProtocolDecodeError);
        expected = error;
      }
      assert.ok(expected);
      assert.throws(() => validateEnvelope(value), (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, expected.code);
        assert.equal(error.message, expected.message);
        return true;
      });
    }
  });
});

describe("JsonLineDecoder", () => {
  it("decodes split UTF-8 and CRLF frames", () => {
    const decoder = new JsonLineDecoder();
    const first = encodeEnvelope(
      createRequest("req-3", "command.execute", { command: "/检查", sessionId: "s" }),
    ).replace("\n", "\r\n");
    const second = encodeEnvelope(createEvent(5, "session.closed", { sessionId: "s" }));
    const bytes = new TextEncoder().encode(first + second);
    const split = bytes.indexOf(230) + 1;

    assert.deepEqual(decoder.push(bytes.slice(0, split)), []);
    const envelopes = decoder.push(bytes.slice(split));

    assert.equal(envelopes.length, 2);
    assert.equal(envelopes[0]?.kind, "request");
    assert.equal(envelopes[1]?.kind, "event");
    assert.deepEqual(decoder.finish(), []);
  });

  it("decodes a final frame without a newline", () => {
    const decoder = new JsonLineDecoder();
    const frame = encodeEnvelope(createEvent(6, "session.closed", { sessionId: "s" })).trimEnd();

    assert.deepEqual(decoder.push(frame), []);
    assert.equal(decoder.finish().length, 1);
  });

  it("rejects oversized frames and clears buffered data", () => {
    const decoder = new JsonLineDecoder({ maxFrameBytes: 16 });

    assert.throws(
      () => decoder.push("x".repeat(17)),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolDecodeError);
        assert.equal(error.code, "frame_too_large");
        return true;
      },
    );
    assert.deepEqual(decoder.finish(), []);
  });

  it("accepts unrestricted frames when no deployment ceiling is configured", () => {
    const decoder = new JsonLineDecoder({ maxFrameBytes: 0 });
    const frame = encodeEnvelope(
      createRequest("large", "command.execute", {
        command: `/${"x".repeat(1024 * 1024)}`,
        sessionId: "s",
      }),
    );

    assert.equal(decoder.push(frame).length, 1);
  });
});
