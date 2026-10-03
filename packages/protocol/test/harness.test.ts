import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isHarnessMethod,
} from "../src/index.js";

describe("harness protocol", () => {
  it("isHarnessMethod rejects unknown methods", () => {
    assert.ok(!isHarnessMethod("unknown.method"));
    assert.ok(!isHarnessMethod(""));
    assert.ok(!isHarnessMethod(123 as unknown as string));
    assert.ok(!isHarnessMethod(null as unknown as string));
  });
});
