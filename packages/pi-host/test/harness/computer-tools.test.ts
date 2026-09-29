import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createComputerTool } from "../../src/harness/computer-tools.js";
import { selectHarnessTools } from "../../src/harness/select-tools.js";
import { DEFAULT_HARNESS_SETTINGS, type HarnessRequestData } from "@varin/protocol";

const SESSION = "session-1";
const isError = (result: unknown) => (result as { isError?: boolean }).isError;

function scriptedBridge(handlers: Record<string, (params: never) => unknown>) {
  const requests: HarnessRequestData[] = [];
  const bridge = new HostServicesBridge({
    emit: (_event, data) => {
      const request = data as HarnessRequestData;
      requests.push(request);
      queueMicrotask(() => {
        const handler = handlers[request.method] ?? (request.method === "computer.control" ? () => ({ control: { desktopId: "local-console", automationEpoch: "epoch-1", owner: "agent", reachable: true, since: "now" } }) : undefined);
        if (!handler) {
          bridge.respond(SESSION, request.requestId, {
            ok: false,
            error: { code: "unavailable", message: `no handler for ${request.method}` },
          });
          return;
        }
        try {
          bridge.respond(SESSION, request.requestId, { ok: true, result: handler(request.params as never) });
        } catch (error) {
          bridge.respond(SESSION, request.requestId, {
            ok: false,
            error: { code: "failed", message: error instanceof Error ? error.message : String(error) },
          });
        }
      });
    },
    sessionId: SESSION,
    defaultTimeoutMs: 5_000,
  });
  return { bridge, requests };
}

const execute = (tool: ReturnType<typeof createComputerTool>, params: Record<string, unknown>) =>
  tool.execute("call-1", params as never, undefined, undefined, undefined as never);

const observation = (id: string) => ({
  observation: {
    id, desktopId: "local-console", machineId: "local",
    app: { name: "notepad", pid: 7 },
    treeLines: ["window x"], elements: [{ index: 0, name: "Edit" }],
    capturedAt: "2026-01-01T00:00:00Z",
  },
});

describe("computer tool", () => {
  it("observe forwards app and screenshot choice and returns the observation id", async () => {
    const { bridge, requests } = scriptedBridge({
      "computer.observe": () => observation("obs-1"),
    });
    const tool = createComputerTool(bridge, SESSION);
    const result = await execute(tool, { action: "observe", app: "notepad", includeScreenshot: true });
    assert.equal(isError(result), undefined);
    assert.deepEqual(requests[0]!.params, { app: "notepad", includeScreenshot: true });
    assert.equal((result.details as { observationId: string }).observationId, "obs-1");
    assert.match((result.content[0] as { text: string }).text, /observation obs-1/);
  });

  it("act forwards the operation and reports acceptance, not completion", async () => {
    const { bridge, requests } = scriptedBridge({
      "computer.act": () => ({ result: { accepted: true, detail: "uia invoke" } }),
    });
    const tool = createComputerTool(bridge, SESSION);
    const result = await execute(tool, {
      action: "act",
      operation: { kind: "click", app: "notepad", elementIndex: 0, observationId: "obs-1" },
    });
    assert.deepEqual(requests[0]!.method, "computer.act");
    assert.match((result.content[0] as { text: string }).text, /observe to verify/);
  });

  it("registers a saved desktop file with the current work through the Host", async () => {
    const { bridge, requests } = scriptedBridge({
      "computer.artifact": () => ({ artifact: { id: "a1", relativePath: "Downloads/report.pdf", sha256: "abc" } }),
    });
    const tool = createComputerTool(bridge, SESSION);
    const result = await execute(tool, { action: "artifact", desktopId: "managed-linux", relativePath: "Downloads/report.pdf" });
    assert.equal(isError(result), undefined);
    assert.equal(requests[0]!.method, "computer.artifact");
    assert.deepEqual(requests[0]!.params, { desktopId: "managed-linux", relativePath: "Downloads/report.pdf" });
  });

  it("the persistent REPL shares bindings across run calls and routes through the bridge", async () => {
    const { bridge, requests } = scriptedBridge({
      "computer.observe": () => observation("obs-9"),
      "computer.act": () => ({ result: { accepted: true } }),
    });
    const tool = createComputerTool(bridge, SESSION);
    const first = await execute(tool, {
      action: "run",
      desktopId: "local-console",
      script: "const obs = await computer.observe('notepad'); obs.id",
    });
    assert.match((first.content[0] as { text: string }).text, /obs-9/);
    // Second call reuses the context: `obs` is still bound.
    const second = await execute(tool, {
      action: "run",
      desktopId: "local-console",
      script: "await computer.act({ kind: 'click', app: 'notepad', elementIndex: 0, observationId: obs.id }); obs.id",
    });
    assert.match((second.content[0] as { text: string }).text, /obs-9/);
    assert.equal(requests.filter((r) => r.method !== "computer.control").map((r) => r.method).join(","), "computer.observe,computer.act");
    assert.equal((requests.find((r) => r.method === "computer.act")!.params as { automationEpoch: string }).automationEpoch, "epoch-1");
  });

  it("reset clears REPL bindings", async () => {
    const { bridge } = scriptedBridge({ "computer.observe": () => observation("o") });
    const tool = createComputerTool(bridge, SESSION);
    await execute(tool, { action: "run", script: "globalThis.marker = 7;" });
    await execute(tool, { action: "reset" });
    const result = await execute(tool, { action: "run", script: "typeof marker" });
    assert.match((result.content[0] as { text: string }).text, /undefined/);
  });

  it("terminates timed-out scripts before delayed input and survives loops after await", async () => {
    const { bridge, requests } = scriptedBridge({ "computer.act": () => ({ result: { accepted: true } }) });
    const tool = createComputerTool(bridge, SESSION);
    await execute(tool, { action: "run", script: "const ready = 1" });
    const result = await execute(tool, { action: "run", desktopId: "local-console", timeoutMs: 100,
      script: "await sleep(300); await computer.act({kind:'key',app:'notepad',key:'enter'})" });
    assert.equal(isError(result), true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(requests.filter((r) => r.method !== "computer.control").length, 0);
    const loop = await execute(tool, { action: "run", timeoutMs: 150, script: "await Promise.resolve(); while (true) {}" });
    assert.equal(isError(loop), true);
    const recovered = await execute(tool, { action: "run", script: "const {value} = await Promise.resolve({value: 8}); value" });
    assert.match((recovered.content[0] as { text: string }).text, /8/);
    await execute(tool, { action: "reset" });
  });

  it("host errors surface as structured tool errors", async () => {
    const { bridge } = scriptedBridge({});
    const tool = createComputerTool(bridge, SESSION);
    const result = await execute(tool, { action: "observe", app: "notepad" });
    assert.equal(isError(result), true);
    assert.match((result.content[0] as { text: string }).text, /unavailable/);
  });

  it("scripts emit real image blocks and stop on an uncertain action receipt", { timeout: 5_000 }, async () => {
    const { bridge, requests } = scriptedBridge({
      "computer.observe": () => ({ observation: { ...observation("image-1").observation, screenshot: { mime: "image/png", base64: "AA==" } } }),
      "computer.act": () => ({ result: { accepted: false, outcome: "unknown", detail: "connection lost" } }),
    });
    const tool = createComputerTool(bridge, SESSION);
    const imageResult = await execute(tool, { action: "run", script: "await computer.emitImage(await computer.observe('notepad')); 'captured'" });
    assert.ok(imageResult.content.some((part) => part.type === "image" && part.data === "AA=="));
    const stopped = await execute(tool, { action: "run", script: "await computer.act({kind:'key',app:'notepad',key:'enter'}); await computer.act({kind:'key',app:'notepad',key:'enter'});" });
    assert.equal(isError(stopped), true);
    assert.equal(requests.filter((request) => request.method === "computer.act").length, 1);
    const syncError = await execute(tool, { action: "run", script: "throw new Error('sync failure')" });
    assert.equal(isError(syncError), true);
    assert.match((syncError.content[0] as { text: string }).text, /sync failure/);
    const continued = await execute(tool, { action: "run", script: "21 * 2" });
    assert.match((continued.content[0] as { text: string }).text, /42/);
    await execute(tool, { action: "reset" });
  });
});

describe("computer tool selection", () => {
  const deps = {
    bridge: undefined as never,
    cwd: "C:/workspace",
    isOpenAIFamily: true,
    sessionId: SESSION,
    workspaceMutationJournal: undefined,
  };

  it("registers by default and respects tools.computer = false", () => {
    const registered = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, deps).map((tool) => tool.name);
    assert.equal(registered.includes("computer"), true);
    const disabled = selectHarnessTools(
      { ...DEFAULT_HARNESS_SETTINGS, tools: { computer: false } },
      deps,
    ).map((tool) => tool.name);
    assert.equal(disabled.includes("computer"), false);
  });
});
