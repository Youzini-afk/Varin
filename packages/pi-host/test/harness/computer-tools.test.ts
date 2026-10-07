import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import { createComputerTool, cancelComputerEvaluations } from "../../src/harness/computer-tools.js";
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
  it('reports uncertain changes only for interrupted mutation requests', async () => {
    const bridge = new HostServicesBridge({
      sessionId: SESSION,
      emit: (_event, data) => queueMicrotask(() => bridge.respond(SESSION, data.requestId, {
        ok: false, error: { code: 'timeout', message: 'request timed out' },
      })),
    });
    const tool = createComputerTool(bridge, SESSION);
    try {
      for (const [params, changed] of [
        [{ action: 'list' }, false],
        [{ action: 'observe', app: 'editor' }, false],
        [{ action: 'browser', browserOp: 'act', browserAct: { kind: 'screenshot' } }, false],
        [{ action: 'office', officeOp: 'act', officeAct: { kind: 'read' } }, false],
        [{ action: 'act', operation: { kind: 'key', app: 'editor', key: 'enter' } }, true],
        [{ action: 'open', url: 'https://example.com' }, true],
      ] as const) {
        const result = await execute(tool, params);
        assert.equal(isError(result), true);
        assert.equal((result.content[0] as { text: string }).text.includes('desktop may have changed'), changed);
      }
    } finally { bridge.dispose(); }
  });
  it('requests observation by default for a read-only thread and exposes an observation-only bound app', async () => {
    const { bridge, requests } = scriptedBridge({
      'computer.access': () => ({ state: { leases: [], requests: [] } }),
      'computer.control': () => ({ control: { desktopId: 'local-console', automationEpoch: 'epoch:read', executionId: 'read-run', owner: 'agent', reachable: true, since: 'now' } }),
      'computer.observe': () => observation('read-1'),
    });
    const tool = createComputerTool(bridge, SESSION, () => 'read-only');
    try {
      assert.equal(isError(await execute(tool, { action: 'request', reason: 'inspect UI' })), undefined);
      assert.equal((requests.find(request => request.method === 'computer.access')!.params as { access: string }).access, 'observe');
      const result = await execute(tool, { action: 'run', script: "const readApp = await computer.getApp('notepad'); console.log(typeof readApp.click, typeof readApp.getAXState); await readApp.getAXState();" });
      assert.equal(isError(result), undefined);
      assert.match((result.content[0] as { text: string }).text, /undefined function/);
      assert.equal(requests.some(request => request.method === 'computer.act'), false);
    } finally { await execute(tool, { action: 'reset' }); }
  });

  it('revokes a sleeping Computer evaluation without stopping other Agent work, and ignores cleanup from an older execution', async () => {
    let runId = 'first';
    let ready!: () => void;
    let started = new Promise<void>(resolve => { ready = resolve; });
    const { bridge, requests } = scriptedBridge({
      'computer.control': () => ({ control: { desktopId: 'local-console', automationEpoch: `epoch:${runId}`, executionId: runId, owner: 'agent', reachable: true, since: 'now' } }),
      'computer.apps': () => { ready(); return { apps: [] }; },
      'computer.act': () => ({ result: { accepted: true } }),
    });
    const tool = createComputerTool(bridge, SESSION);
    const pending = execute(tool, { action: 'run', script: "await computer.apps(); await sleep(300); await computer.act({kind:'key',app:'editor',key:'enter'})" });
    await started; cancelComputerEvaluations(SESSION, 'first');
    assert.equal(isError(await pending), true);
    assert.equal(requests.filter(item => item.method === 'computer.act').length, 0);
    runId = 'second'; started = new Promise<void>(resolve => { ready = resolve; });
    const next = execute(tool, { action: 'run', script: "await computer.apps(); await sleep(100); await computer.act({kind:'key',app:'editor',key:'enter'})" });
    await started; cancelComputerEvaluations(SESSION, 'first');
    assert.equal(isError(await next), undefined);
    assert.equal(requests.filter(item => item.method === 'computer.act').length, 1);
    await execute(tool, { action: 'reset' }); bridge.dispose();
  });
  it("validates and forwards desktop, browser, and office operation arguments", async () => {
    const { bridge, requests } = scriptedBridge({
      "computer.act": () => ({ result: { accepted: true } }),
      "computer.browser": () => ({ ok: true }),
      "computer.office": () => ({ ok: true }),
    });
    const tool = createComputerTool(bridge, SESSION);
    for (const [args, method, key, operation] of [
      [{ action: "act", operation: { kind: "key", app: "editor", key: "ctrl+s" } }, "computer.act", "action", { kind: "key", app: "editor", key: "ctrl+s" }],
      [{ action: "browser", browserOp: "act", tabId: "tab-1", browserAct: { kind: "navigate", url: "https://example.test" } }, "computer.browser", "act", { kind: "navigate", url: "https://example.test" }],
      [{ action: "office", officeOp: "act", officeAct: { kind: "write", range: "A1:B1", values: [[1, "name"]] } }, "computer.office", "act", { kind: "write", range: "A1:B1", values: [[1, "name"]] }],
    ] as const) {
      const parsed = validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: args });
      const result = await execute(tool, parsed);
      assert.notEqual(isError(result), true);
      assert.equal(requests.at(-1)?.method, method);
      assert.deepEqual((requests.at(-1)?.params as Record<string, unknown>)[key], operation);
    }
    const count = requests.length;
    for (const args of [
      { action: "act", operation: { kind: "key" } },
      { action: "browser", browserAct: { kind: "click", x: "bad", y: 2 } },
      { action: "office", officeAct: { kind: "unsupported-operation" } },
    ]) {
      assert.throws(() => validateToolArguments(tool, { type: "toolCall", id: "invalid", name: tool.name, arguments: args }), JSON.stringify(args));
    }
    assert.equal(requests.length, count, "invalid arguments never reach the Host");
    bridge.dispose();
  });

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
    assert.equal((result.details as { accepted: boolean }).accepted, true);
    assert.equal((result.details as { observationId?: string }).observationId, undefined);
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

  it("binds an app across cells, batches actions without captures and carries the original control epoch", async () => {
    let reads = 0;
    let epoch = 'epoch-1';
    const { bridge, requests } = scriptedBridge({
      "computer.control": () => ({ control: { desktopId: 'local-console', automationEpoch: epoch, owner: 'agent', reachable: true, since: 'now' } }),
      "computer.observe": () => observation(`bound-${++reads}`),
      "computer.act": (params: { automationEpoch: string }) => ({ result: params.automationEpoch === epoch ? { accepted: true } : { accepted: false, detail: 'Control changed' } }),
    });
    const tool = createComputerTool(bridge, SESSION);
    const first = await execute(tool, { action: "run", script: "const app = await computer.getApp('notepad'); await app.getAXState(); await app.click(0); await app.setValue(0, 'hello'); app.name" });
    assert.notEqual(isError(first), true, JSON.stringify(first));
    assert.match((first.content[0] as { text: string }).text, /window x/, 'the tree is returned through the worker log channel');
    assert.equal(reads, 1, 'binding and first displayed tree share one observation');
    const second = await execute(tool, { action: "run", script: "await app.pressKey('enter'); await app.getAXState(); 'done'" });
    assert.notEqual(isError(second), true, JSON.stringify(second));
    assert.equal(reads, 2, 'only the explicit decision-point read refreshes the tree');
    const actions = requests.filter(request => request.method === 'computer.act').map(request => request.params as { action: { kind: string; app: string; observationId?: string; returnState: string }; automationEpoch: string });
    assert.equal(actions.length, 3);
    for (const action of actions) {
      assert.equal(action.action.app, '7');
      assert.equal(action.action.observationId, action.action.kind === 'key' ? undefined : 'bound-1');
      assert.equal(action.action.returnState, 'none');
      assert.equal(action.automationEpoch, 'epoch-1');
    }
    epoch = 'epoch-2';
    const stale = await execute(tool, { action: 'run', script: "try { await app.pressKey('enter') } catch (error) { console.log(error.code, error.actionSent, error.retry) }; await app.getAXState(); 'checked'" });
    assert.match((stale.content[0] as { text: string }).text, /ACTION_REJECTED false never/);
    assert.equal(reads, 3, 'a failed action invalidates the cached read');
    const rebound = await execute(tool, { action: 'run', script: "const currentApp = await computer.getApp('notepad'); await currentApp.pressKey('enter'); 'sent'" });
    assert.notEqual(isError(rebound), true, JSON.stringify(rebound));
    assert.equal((requests.at(-1)!.params as { automationEpoch: string }).automationEpoch, 'epoch-2');
    await execute(tool, { action: 'reset' });
    bridge.dispose();
  });

  it('emits one image without duplicating base64 and keeps uncertain action effects explicit', async () => {
    const imageData = Buffer.from('opaque-image-payload').toString('base64');
    const { bridge } = scriptedBridge({
      'computer.observe': (params: { includeScreenshot?: boolean }) => ({ observation: { ...observation('raster').observation,
        ...(params.includeScreenshot ? { screenshot: { mime: 'image/png', base64: imageData, width: 1600, height: 1200 } } : {}) } }),
      'computer.act': () => ({ result: { accepted: false, outcome: 'unknown', detail: 'lost response' } }),
    });
    const tool = createComputerTool(bridge, SESSION);
    const capture = await execute(tool, { action: 'run', script: "const app = await computer.getApp('notepad'); await app.getScreenshot()" });
    assert.equal(capture.content.filter(item => item.type === 'image').length, 1);
    assert.match((capture.content[0] as { text: string }).text, /1600/);
    assert.ok(!(capture.content[0] as { text: string }).text.includes(imageData));
    const uncertain = await execute(tool, { action: 'run', script: "try { await app.click([120, 80]) } catch (error) { console.log(error.code, error.actionSent, error.retry) }; 'checked'" });
    assert.match((uncertain.content[0] as { text: string }).text, /ACTION_UNKNOWN true reobserve/);
    const uncaught = await execute(tool, { action: 'run', script: "await app.pressKey('enter')" });
    assert.equal(isError(uncaught), true);
    assert.deepEqual(uncaught.details, { code: 'ACTION_UNKNOWN', actionSent: true, retry: 'reobserve' });
    const withoutImage = await execute(tool, { action: 'run', script: "await app.click([120, 80])" });
    assert.equal(isError(withoutImage), true);
    assert.match((withoutImage.content[0] as { text: string }).text, /Take a screenshot/);
    await execute(tool, { action: 'reset' });
    bridge.dispose();
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
    assert.ok(!(result.content[0] as { text: string }).text.includes('desktop may have changed'));
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
