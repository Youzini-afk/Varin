import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HARNESS_TOOL_META,
  defaultRules,
  toolExecutionMode,
  toolMutation,
} from "../src/index.js";

describe("harness tool mutation attributes", () => {
  it("reports unknown for tools not in the table", () => {
    assert.equal(toolMutation("nonexistent_tool"), "unknown");
    assert.equal(toolExecutionMode("nonexistent_tool"), "unknown");
  });

  it("marks read-only tools as none and parallel", () => {
    for (const name of ["read", "grep", "find", "ls", "webfetch", "websearch"]) {
      assert.equal(toolMutation(name), "none");
      assert.equal(toolExecutionMode(name), "parallel");
    }
  });

  it("marks file-writing tools as journaled", () => {
    for (const name of ["write", "edit", "apply_patch"]) {
      assert.equal(toolMutation(name), "journaled");
    }
  });

  it("marks shell tools as process and sequential", () => {
    for (const name of ["bash", "write_to_process"]) {
      assert.equal(toolMutation(name), "process");
      assert.equal(toolExecutionMode(name), "sequential");
    }
  });

  it("keeps bash-family control tools none but sequential", () => {
    for (const name of ["kill_shell", "get_output"]) {
      assert.equal(toolMutation(name), "none");
    }
    assert.equal(toolExecutionMode("kill_shell"), "sequential");
    assert.equal(toolExecutionMode("get_output"), "parallel");
  });

  it("classifies settings tools as harness reads or guarded control", () => {
    assert.equal(HARNESS_TOOL_META.settings_search?.permissionAction, "read");
    assert.equal(HARNESS_TOOL_META.settings_read?.permissionAction, "read");
    assert.equal(HARNESS_TOOL_META.settings_update?.permissionAction, "control");
    assert.equal(toolExecutionMode("settings_update"), "sequential");
    assert.equal(defaultRules("normal").find((rule) => rule.tool === "settings_update")?.decision, "ask");
  });
});
