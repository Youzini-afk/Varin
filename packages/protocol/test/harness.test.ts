import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isHarnessMethod,
  buildHarnessRespondParams,
} from "../src/index.js";

describe("harness protocol", () => {
  it("preserves response identity, a null result, and retryable failure details", () => {
    assert.deepEqual(buildHarnessRespondParams("session", "request", { ok: true, result: null }), {
      sessionId: "session", requestId: "request", ok: true, result: null,
    });
    const error = { code: "timeout" as const, message: "service did not finish", retryable: true };
    assert.deepEqual(buildHarnessRespondParams("session", "request", { ok: false, error }), {
      sessionId: "session", requestId: "request", ok: false, error,
    });
  });
  it("isHarnessMethod rejects unknown methods", () => {
    assert.ok(!isHarnessMethod("unknown.method"));
    assert.ok(!isHarnessMethod(""));
    assert.ok(!isHarnessMethod(123 as unknown as string));
    assert.ok(!isHarnessMethod(null as unknown as string));
  });
});
