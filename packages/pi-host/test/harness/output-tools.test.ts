import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBashTool } from "../../src/harness/bash-tool.js";
import {
  createGetOutputTool,
  createWriteToProcessTool,
  createKillShellTool,
  createDiagnosticsTool,
} from "../../src/harness/output-tools.js";
import type { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS } from "@varin/protocol";

function createFakeBridge(handler: (method: string, params: Record<string, unknown>) => unknown): Pick<HostServicesBridge, "request"> {
  return {
    request: async (method: string, params: Record<string, unknown>) => handler(method, params),
  } as unknown as Pick<HostServicesBridge, "request">;
}

async function executeTool(tool: ReturnType<typeof createGetOutputTool>, params: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("call-1", params as never, undefined, undefined, undefined as never);
  return (result.content[0] as { type: "text"; text: string }).text;
}

describe("get_output tool", () => {
  it("reads a preparing execution id and reports that no runtime shell exists yet", async () => {
    let observed: { method?: string; params?: unknown } = {};
    const bridge = {
      request: async (method: string, params: unknown) => {
        observed = { method, params };
        return {
          text: "", offset: 0, length: 0, nextOffset: 0, total: 0, eof: false,
          running: true, phase: "preparing", executionId: "exec_0123456789abcdef0123456789abcdef",
          command: "npm test", observation: { mode: "incremental", first: true },
        };
      },
    } as unknown as HostServicesBridge;
    const tool = createGetOutputTool(bridge, "s1");
    const result = await tool.execute("call-1", { handle: "exec_0123456789abcdef0123456789abcdef" }, undefined, undefined, undefined as never);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.deepEqual(observed, { method: "shell.read", params: { id: "exec_0123456789abcdef0123456789abcdef" } });
    assert.match(text, /accepted; preparing \(payload not sent yet\)/);
    assert.doesNotMatch(text, /still running/);
  });

  it("reports old shell and execution references as unavailable after Host replacement", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "shell.read") return {
        text: "", offset: 0, length: 0, nextOffset: 0, total: 0, eof: false,
        running: false, executionId: "exec_0123456789abcdef0123456789abcdef",
        unavailable: "This shell reference is unavailable in the current Host generation; live execution output was not retained.",
      };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { handle: "exec_0123456789abcdef0123456789abcdef" });
    assert.match(text, /unavailable: This shell reference is unavailable/);
    assert.doesNotMatch(text, /not found/);
  });

  it("resolves the same preparing reference to completed output and exit status", async () => {
    const body = "full restored output tail-marker";
    let reads = 0;
    const bridge = createFakeBridge((method) => {
      if (method !== "shell.read") throw new Error(`unexpected: ${method}`);
      reads += 1;
      return reads === 1
        ? { text: "", offset: 0, length: 0, nextOffset: 0, total: 0, eof: false,
            running: true, phase: "preparing", executionId: "exec_0123456789abcdef0123456789abcdef" }
        : { text: body, offset: 0, length: body.length, nextOffset: body.length, total: body.length,
            eof: true, running: false, exitCode: 7, executionId: "exec_0123456789abcdef0123456789abcdef" };
    });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    const handle = "exec_0123456789abcdef0123456789abcdef";
    assert.match(await executeTool(tool, { handle }), /preparing/);
    const completed = await executeTool(tool, { handle });
    assert.match(completed, /full restored output tail-marker/);
    assert.match(completed, /exit 7/);
    assert.equal(reads, 2);
  });

  it("forwards an event wait and keeps it separate from historical slicing", async () => {
    let observed: { params?: unknown; options?: unknown } = {};
    const bridge = {
      request: async (_method: string, params: unknown, options: unknown) => {
        observed = { params, options };
        return { text: "", offset: 0, length: 0, nextOffset: 0, total: 0, eof: true, running: true,
          observation: { mode: "incremental", first: true } };
      },
    } as unknown as HostServicesBridge;
    const tool = createGetOutputTool(bridge, "s1");
    await executeTool(tool, { handle: "sh_1", waitMs: 2_000 });
    assert.deepEqual(observed.params, { id: "sh_1", waitMs: 2_000 });
    assert.deepEqual(observed.options, { timeoutMs: 32_000 });
  });

  it("keeps a longer shell observation wait without the generic RPC ceiling", async () => {
    let observed: { params?: unknown; options?: unknown } = {};
    const bridge = {
      request: async (_method: string, params: unknown, options: unknown) => {
        observed = { params, options };
        return { text: "", offset: 0, length: 0, nextOffset: 0, total: 0, eof: true, running: true };
      },
    } as unknown as HostServicesBridge;
    const waitMs = HARNESS_MAX_REQUEST_TIMEOUT_MS + 1;
    await executeTool(createGetOutputTool(bridge, "s1"), { handle: "sh_1", waitMs });
    assert.deepEqual(observed.params, { id: "sh_1", waitMs });
    assert.deepEqual(observed.options, { timeoutMs: 0 });
  });

  it("reads stored output via output.read for out_ handles", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "output.read") return { text: "stored content", offset: 0, length: 14, nextOffset: 14, total: 14, eof: true };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { handle: "out_abc" });
    assert.match(text, /stored content/);
    assert.match(text, /14\/14 bytes/);
  });

  it("shows organized display on incremental shell reads", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "shell.read") {
        return {
          text: "RERUN src/mid.test.ts\nFAIL src/mid.test.ts\n",
          display: "FAIL src/mid.test.ts\n      Tests  1 failed (1)",
          organized: { kind: "vitest", omitted: false, partial: true },
          offset: 0,
          length: 40,
          nextOffset: 40,
          total: 40,
          eof: true,
          running: true,
          observation: { mode: "incremental", first: true },
        };
      }
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { handle: "sh_1" });
    assert.match(text, /FAIL src\/mid\.test\.ts/);
    assert.doesNotMatch(text, /RERUN/);
    assert.match(text, /still running/);
    assert.match(text, /current observation/);
  });

  it("marks an exited incremental slice as a current observation", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "shell.read") {
        return {
          text: "Error: expected 2 to be 1",
          display: "Error: expected 2 to be 1",
          organized: { kind: "vitest", omitted: false, partial: true },
          offset: 40,
          length: 24,
          nextOffset: 64,
          total: 64,
          eof: true,
          running: false,
          exitCode: 1,
          executionId: "exec-1",
          observation: { mode: "incremental", first: false, sinceMs: 1000 },
        };
      }
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    const result = await tool.execute("call-1", { handle: "sh_1" }, undefined, undefined, undefined as never);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /incremental slice; not a final summary/);
    assert.match(text, /exited 1/);
    assert.deepEqual((result.details as { shellCompletion?: unknown }).shellCompletion, { executionId: "exec-1" });
  });

  it("reads background shell via shell.read for sh_ IDs", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "shell.read") return { text: "shell output", offset: 0, length: 12, nextOffset: 12, total: 100, eof: false, running: true };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { handle: "sh_1" });
    assert.match(text, /shell output/);
    assert.match(text, /still running/);
    assert.match(text, /12\/100 bytes/);
  });

  it("renders incremental shell changes and discourages empty polling", async () => {
    let reads = 0;
    const bridge = createFakeBridge((method) => {
      if (method !== "shell.read") throw new Error(`unexpected: ${method}`);
      reads += 1;
      return reads === 1
        ? { text: "new output", offset: 10, length: 10, nextOffset: 20, total: 20, eof: true, running: true, observation: { mode: "incremental", first: false, sinceMs: 2_000, lastOutputAgoMs: 100 } }
        : { text: "", offset: 20, length: 0, nextOffset: 20, total: 20, eof: true, running: false, exitCode: 0, observation: { mode: "incremental", first: false, sinceMs: 3_000, lastOutputAgoMs: 1_000 } };
    });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    assert.match(await executeTool(tool, { handle: "sh_1" }), /\+10 bytes since last read \(2s ago\).*still running/s);
    assert.match(await executeTool(tool, { handle: "sh_1" }), /no new output since last read \(3s ago\).*exited 0.*last output 1s ago/s);
  });

  it("handles errors gracefully", async () => {
    const bridge = createFakeBridge(() => { throw new Error("not found"); });
    const tool = createGetOutputTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { handle: "out_missing" });
    assert.match(text, /get_output failed/);
  });
});

describe("bash tool preparation result", () => {
  it("offers only get_output while startup has no runtime shell identity", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "shell.exec") return {
        kind: "preparing",
        id: "exec_0123456789abcdef0123456789abcdef",
        executionId: "exec_0123456789abcdef0123456789abcdef",
        command: "npm test",
        waitedMs: 25,
        timing: { acceptedAt: 10, detachedAt: 35, respondedAt: 36 },
      };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createBashTool(bridge as HostServicesBridge, "s1", "", 10_000);
    const result = await tool.execute("call-1", { command: "npm test", waitMs: 25 }, undefined, undefined, undefined as never);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /no runtime shell handle exists yet/);
    assert.match(text, /get_output\("exec_0123456789abcdef0123456789abcdef"\)/);
    assert.doesNotMatch(text, /write_to_process|kill_shell/);
  });
});

describe("write_to_process tool", () => {
  it("writes to shell via shell.write", async () => {
    const bridge = createFakeBridge((method, _params) => {
      if (method === "shell.write") return { accepted: true };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createWriteToProcessTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { shellId: "sh_1", text: "y\n" });
    assert.match(text, /wrote/);
  });

  it("reports when shell not found", async () => {
    const bridge = createFakeBridge(() => { return { accepted: false }; });
    const tool = createWriteToProcessTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { shellId: "sh_missing", text: "y\n" });
    assert.match(text, /not found or not writable/);
  });
});

describe("kill_shell tool", () => {
  it("kills shell via shell.kill", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "shell.kill") return { killed: true };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createKillShellTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { shellId: "sh_1" });
    assert.match(text, /killed sh_1/);
  });

  it("reports when shell not found", async () => {
    const bridge = createFakeBridge(() => { return { killed: false }; });
    const tool = createKillShellTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { shellId: "sh_missing" });
    assert.match(text, /not found or termination failed/);
  });
});

describe("diagnostics tool", () => {
  it("formats clean result", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "lsp.diagnosticsSnapshot") return { status: "ready", diagnostics: [] };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createDiagnosticsTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { path: "/src/test.ts" });
    assert.match(text, /clean/);
    assert.match(text, /0 diagnostics/);
  });

  it("formats diagnostics with errors", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "lsp.diagnosticsSnapshot") return {
        status: "ready",
        diagnostics: [
          { line: 5, character: 1, severity: "error", code: "TS2304", message: "Cannot find name 'foo'", source: "tsc" },
          { line: 10, character: 3, severity: "warning", message: "Unused variable", source: "tsc" },
        ],
      };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createDiagnosticsTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { path: "/src/test.ts" });
    assert.match(text, /2 diagnostic/);
    assert.match(text, /error.*TS2304.*Cannot find name/);
    assert.match(text, /warning.*Unused variable/);
  });

  it("formats unavailable result", async () => {
    const bridge = createFakeBridge((method) => {
      if (method === "lsp.diagnosticsSnapshot") return { status: "unavailable", diagnostics: [] };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createDiagnosticsTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { path: "/src/test.ts" });
    assert.match(text, /unavailable/);
  });

  it("formats added and resolved diagnostics and forwards full snapshots", async () => {
    let observedParams: Record<string, unknown> | undefined;
    const bridge = createFakeBridge((method, params) => {
      observedParams = params;
      if (method === "lsp.diagnosticsSnapshot") return {
        status: "ready",
        diagnostics: [{ line: 2, character: 1, severity: "error", code: "NEW", message: "new error", source: "ts" }],
        resolvedDiagnostics: [{ line: 1, character: 1, severity: "warning", code: "OLD", message: "old warning", source: "ts" }],
        observation: { mode: "incremental", first: false, sinceMs: 1_000, added: 1, resolved: 1 },
      };
      throw new Error(`unexpected: ${method}`);
    });
    const tool = createDiagnosticsTool(bridge as HostServicesBridge, "s1");
    const text = await executeTool(tool, { path: "/src/test.ts", full: true });
    assert.deepEqual(observedParams, { path: "/src/test.ts", full: true });
    assert.match(text, /\+1 −1 since last check/);
    assert.match(text, /\+ error.*new error/);
    assert.match(text, /− resolved warning.*old warning/);
  });
});
