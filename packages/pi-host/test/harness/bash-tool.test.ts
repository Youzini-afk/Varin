import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBashTool } from "../../src/harness/bash-tool.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS, type ShellExecResult } from "@varin/protocol";

function createFakeBridge(result: ShellExecResult): Pick<HostServicesBridge, "request"> {
  return {
    request: async () => result,
  } as unknown as Pick<HostServicesBridge, "request">;
}

async function executeBash(bridge: HostServicesBridge, command: string): Promise<string> {
  const tool = createBashTool(bridge, "s1", "/workspace");
  const result = await tool.execute("call-1", { command }, undefined, undefined, undefined as never);
  return (result.content[0] as { type: "text"; text: string }).text;
}

describe("bash tool", () => {
  it("forwards explicit zero wait with an RPC deadline beyond process detachment", async () => {
    let observed: { params?: unknown; options?: unknown } = {};
    const bridge = {
      request: async (_method: string, params: unknown, options: unknown) => {
        observed = { params, options };
        return { kind: "background", id: "sh_1", waitedMs: 0, cwd: "/workspace", outputSoFar: "" };
      },
    } as unknown as HostServicesBridge;
    const tool = createBashTool(bridge, "s1", "/workspace", 10_000);
    await tool.execute("call-1", { command: "long", waitMs: 0 }, undefined, undefined, undefined as never);
    assert.deepEqual(observed.params, { command: "long", toolCallId: "call-1", waitMs: 0 });
    assert.deepEqual(observed.options, { timeoutMs: 30_000 });
  });

  it("does not truncate an explicitly longer foreground wait to the generic RPC ceiling", async () => {
    let observed: { params?: unknown; options?: unknown } = {};
    const bridge = {
      request: async (_method: string, params: unknown, options: unknown) => {
        observed = { params, options };
        return { kind: "preparing", id: "exec_long", executionId: "exec_long", waitedMs: 0, command: "long" };
      },
    } as unknown as HostServicesBridge;
    const waitMs = HARNESS_MAX_REQUEST_TIMEOUT_MS + 1;
    const tool = createBashTool(bridge, "s1", "/workspace");
    await tool.execute("call-long", { command: "long", waitMs }, undefined, undefined, undefined as never);
    assert.deepEqual(observed.params, { command: "long", toolCallId: "call-long", waitMs });
    assert.deepEqual(observed.options, { timeoutMs: 0 });
  });

  it("uses the configured session wait when the call omits waitMs", async () => {
    let observedParams: unknown;
    const bridge = {
      request: async (_method: string, params: unknown) => {
        observedParams = params;
        return { kind: "background", id: "sh_1", waitedMs: 7_500, cwd: "/workspace", outputSoFar: "" };
      },
    } as unknown as HostServicesBridge;
    const tool = createBashTool(bridge, "s1", "/workspace", 7_500);
    await tool.execute("call-1", { command: "long" }, undefined, undefined, undefined as never);
    assert.deepEqual(observedParams, { command: "long", toolCallId: "call-1", waitMs: 7_500 });
  });

  it("formats completed result with exit code", async () => {
    const bridge = createFakeBridge({
      kind: "completed",
      exitCode: 0,
      durationMs: 100,
      cwd: "/workspace",
      stdout: "hello world",
      stderr: "",
      handle: null,
      shown: null,
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "echo hello world");
    assert.match(text, /hello world/);
    assert.match(text, /\[exit 0\]/);
  });

  it("marks a returned terminal fact with its completion receipt", async () => {
    const bridge = createFakeBridge({
      kind: "completed",
      exitCode: 1,
      durationMs: 100,
      cwd: "/workspace",
      stdout: "failed",
      stderr: "",
      handle: null,
      shown: null,
      executionId: "exec-1",
    }) as HostServicesBridge;
    const result = await createBashTool(bridge, "s1", "/workspace").execute(
      "call-1", { command: "false" }, undefined, undefined, undefined as never,
    );
    assert.deepEqual((result.details as { shellCompletion?: unknown }).shellCompletion, { executionId: "exec-1" });
  });

  it("formats completed result with handle for large output", async () => {
    const bridge = createFakeBridge({
      kind: "completed",
      exitCode: 0,
      durationMs: 100,
      cwd: "/workspace",
      stdout: "large output",
      stderr: "",
      handle: "out_abc123",
      shown: { head: 100, tail: 100, total: 50000 },
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "cat big.txt");
    assert.match(text, /get_output\("out_abc123"\)/);
  });

  it("formats background result with id", async () => {
    const bridge = createFakeBridge({
      kind: "background",
      id: "sh_1",
      waitedMs: 60000,
      cwd: "/workspace",
      outputSoFar: "partial output",
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "sleep 100");
    assert.match(text, /still running/);
    assert.match(text, /partial output/);
    assert.match(text, /get_output\("sh_1"\)/);
  });

  it("formats spawn-failed result", async () => {
    const bridge = createFakeBridge({
      kind: "spawn-failed",
      reason: "no-shell",
      interpreter: "bash",
      hint: "Install bash",
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "echo test");
    assert.match(text, /spawn failed/);
    assert.match(text, /no-shell/);
  });

  it("prefers organized display over raw stdout", async () => {
    const bridge = createFakeBridge({
      kind: "completed",
      exitCode: 1,
      durationMs: 100,
      cwd: "/workspace",
      stdout: "RERUN src/mid.test.ts\nFAIL src/mid.test.ts\n",
      stderr: "",
      handle: "out_full",
      shown: null,
      display: "FAIL src/mid.test.ts\n      Tests  1 failed (1)",
      organized: { kind: "vitest", omitted: false, partial: false },
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "bunx vitest run");
    assert.match(text, /FAIL src\/mid\.test\.ts/);
    assert.doesNotMatch(text, /RERUN/);
    assert.match(text, /\[exit 1\]/);
    assert.match(text, /get_output\("out_full"\)/);
  });

  it("formats stderr in completed result", async () => {
    const bridge = createFakeBridge({
      kind: "completed",
      exitCode: 1,
      durationMs: 100,
      cwd: "/workspace",
      stdout: "",
      stderr: "command not found",
      handle: null,
      shown: null,
    }) as HostServicesBridge;
    const text = await executeBash(bridge, "nonexistent");
    assert.match(text, /\[stderr\]/);
    assert.match(text, /command not found/);
    assert.match(text, /\[exit 1\]/);
  });
});
