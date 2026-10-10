import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostServicesBridge } from "../../src/harness/host-services-bridge.js";
import {
  createExperimentTool,
  createResearchSourceTool,
  createResourcesTool,
} from "../../src/harness/experiment-tools.js";
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
        const handler = handlers[request.method];
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

const attemptView = (over: Record<string, unknown> = {}) => ({
  attemptId: "attempt-1",
  specId: "spec-1",
  cancelRequested: false,
  backend: "local",
  machineId: "local",
  state: "running",
  collection: "none",
  createdAt: 1,
  ...over,
});

describe("experiment tool", () => {
  it("reads a collected result by identity and keeps binary bytes out of model text", async () => {
    const { bridge, requests } = scriptedBridge({
      "experiment.artifact": (params: { artifactId: string }) => ({
        attemptId: "attempt-1", artifactId: params.artifactId, name: "result.csv",
        offset: 0, nextOffset: 9, eof: true, bytesBase64: "private-raw-bytes",
        text: params.artifactId === "binary" ? null : "score,0.9",
      }),
    });
    const tool = createExperimentTool(bridge, SESSION);
    const text = await tool.execute("text", { action: "artifact", attemptId: "attempt-1", artifactId: "csv" } as never, undefined, undefined, undefined as never);
    assert.match(JSON.stringify(text.content), /score,0.9/);
    assert.doesNotMatch(JSON.stringify(text), /private-raw-bytes/);
    const binary = await tool.execute("binary", { action: "artifact", attemptId: "attempt-1", artifactId: "binary" } as never, undefined, undefined, undefined as never);
    assert.match(JSON.stringify(binary.content), /binary/);
    assert.doesNotMatch(JSON.stringify(binary), /private-raw-bytes/);
    assert.equal(requests[0]!.method, "experiment.artifact");
    bridge.dispose();
  });

  it("submit retains the tool-call key and returns an accepted attempt before its spec is ready", async () => {
    const { bridge, requests } = scriptedBridge({
      "experiment.submit": (params: { command: string; args?: string[] }) => {
        assert.equal(params.command, "python");
        assert.deepEqual(params.args, ["train.py", "--seed", "1"]);
        return {
          spec: null,
          attempt: attemptView({ specId: null, state: "submitted" }),
          text: "attempt attempt-1 accepted; preparing input",
        };
      },
    });
    const tool = createExperimentTool(bridge, SESSION);
    const result = await tool.execute("call-1", {
      action: "submit",
      command: "python",
      args: ["train.py", "--seed", "1"],
    } as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), undefined);
    assert.equal(requests[0]!.method, "experiment.submit");
    assert.equal((result.details as { attemptId: string }).attemptId, "attempt-1");
    assert.equal((result.details as { specId: string | null }).specId, null);
    await tool.execute("call-1", { action: "submit", command: "python", args: ["train.py", "--seed", "1"] } as never, undefined, undefined, undefined as never);
    assert.equal((requests[0]!.params as { requestId: string }).requestId, "experiment:call-1");
    assert.equal((requests[1]!.params as { requestId: string }).requestId, "experiment:call-1");
    bridge.dispose();
  });

  it("submit rejects specId combined with inline spec fields before any request", async () => {
    const { bridge, requests } = scriptedBridge({});
    const tool = createExperimentTool(bridge, SESSION);
    const result = await tool.execute("call-1", {
      action: "submit",
      specId: "spec-1",
      command: "python",
    } as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), true);
    assert.equal((result.details as { code: string }).code, "invalid-params");
    assert.equal(requests.length, 0);
    bridge.dispose();
  });

  it("submit requires a command when no specId is given", async () => {
    const { bridge, requests } = scriptedBridge({});
    const tool = createExperimentTool(bridge, SESSION);
    const result = await tool.execute("call-1", { action: "submit" } as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), true);
    assert.equal(requests.length, 0);
    bridge.dispose();
  });

  it("get requires attemptId", async () => {
    const { bridge, requests } = scriptedBridge({});
    const tool = createExperimentTool(bridge, SESSION);
    const result = await tool.execute("call-1", { action: "get" } as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), true);
    assert.equal((result.details as { code: string }).code, "invalid-params");
    assert.equal(requests.length, 0);
    bridge.dispose();
  });

  it("list forwards state and specId filters", async () => {
    const { bridge, requests } = scriptedBridge({
      "experiment.list": (params: { state?: string; specId?: string }) => {
        assert.equal(params.state, "running");
        assert.equal(params.specId, "spec-9");
        return { attempts: [attemptView()], text: "1 attempt" };
      },
    });
    const tool = createExperimentTool(bridge, SESSION);
    const result = await tool.execute("call-1", {
      action: "list", state: "running", specId: "spec-9",
    } as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), undefined);
    assert.equal(requests[0]!.method, "experiment.list");
    bridge.dispose();
  });

  it("logs pages by offset and reports stream origin and eof", async () => {
    const { bridge } = scriptedBridge({
      "experiment.logs": (params: { attemptId: string; offset?: number }) => {
        assert.equal(params.attemptId, "attempt-1");
        assert.equal(params.offset, 128);
        return {
          attemptId: "attempt-1", stream: "stderr",
          offset: 128, nextOffset: 256, eof: false,
          text: "line", origin: "live",
        };
      },
    });
    const tool = createExperimentTool(bridge, SESSION);
    const result = await tool.execute("call-1", {
      action: "logs", attemptId: "attempt-1", stream: "stderr", offset: 128,
    } as never, undefined, undefined, undefined as never);
    const details = result.details as { nextOffset: number; eof: boolean; origin: string };
    assert.equal(details.nextOffset, 256);
    assert.equal(details.eof, false);
    assert.equal(details.origin, "live");
    bridge.dispose();
  });

  it("wait lets the service own the deadline — no second client timer", async () => {
    const { bridge, requests } = scriptedBridge({
      "experiment.wait": (params: { attemptId: string; timeoutMs: number }) => {
        assert.equal(params.timeoutMs, 12_000);
        return { attempt: attemptView({ state: "completed", exitCode: 0 }), timedOut: false };
      },
    });
    const tool = createExperimentTool(bridge, SESSION);
    const result = await tool.execute("call-1", {
      action: "wait", attemptId: "attempt-1", timeout_ms: 12_000,
    } as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), undefined);
    // timeoutMs: 0 is forwarded so the router does not arm its own abort timer.
    assert.equal(requests[0]!.timeoutMs, 0);
    bridge.dispose();
  });

  it("cancel and collect address the attempt", async () => {
    const { bridge, requests } = scriptedBridge({
      "experiment.cancel": () => ({ attempt: attemptView({ state: "cancelled" }) }),
      "experiment.collect": () => ({
        attempt: attemptView({ state: "completed", collection: "done" }),
        artifacts: [{ artifactId: "a1", attemptId: "attempt-1", name: "stdout", kind: "stdout", state: "available", byteLength: 10 }],
      }),
    });
    const tool = createExperimentTool(bridge, SESSION);
    const cancelled = await tool.execute("call-1", { action: "cancel", attemptId: "attempt-1" } as never, undefined, undefined, undefined as never);
    assert.equal(requests[0]!.method, "experiment.cancel");
    assert.match((cancelled.content[0] as { text: string }).text, /cancelled/);
    const collected = await tool.execute("call-1", { action: "collect", attemptId: "attempt-1" } as never, undefined, undefined, undefined as never);
    assert.equal(requests[1]!.method, "experiment.collect");
    assert.match((collected.content[0] as { text: string }).text, /collection done/);
    bridge.dispose();
  });

  it("maps a Host error to a structured error result", async () => {
    const { bridge } = scriptedBridge({});
    const tool = createExperimentTool(bridge, SESSION);
    const result = await tool.execute("call-1", { action: "list" } as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), true);
    assert.equal((result.details as { code: string }).code, "unavailable");
    bridge.dispose();
  });
});

describe("resources tool", () => {
  it("returns the machine overview text", async () => {
    const { bridge, requests } = scriptedBridge({
      "resource.list": () => ({
        machines: [{ machineId: "local", kind: "local", state: "available", connection: { status: "connected", checkedAt: 1 }, commitments: [] }],
        generatedAt: 1,
        text: "local — 8 cores, 32GB",
      }),
    });
    const tool = createResourcesTool(bridge, SESSION);
    const result = await tool.execute("call-1", {} as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), undefined);
    assert.equal(requests[0]!.method, "resource.list");
    assert.match((result.content[0] as { text: string }).text, /8 cores/);
    bridge.dispose();
  });
});

describe("research_source tool", () => {
  it("register requires a kind and at least one locator", async () => {
    const { bridge, requests } = scriptedBridge({});
    const tool = createResearchSourceTool(bridge, SESSION);
    const noKind = await tool.execute("call-1", { action: "register", uri: "https://x" } as never, undefined, undefined, undefined as never);
    assert.equal(isError(noKind), true);
    const noLocator = await tool.execute("call-2", { action: "register", kind: "dataset" } as never, undefined, undefined, undefined as never);
    assert.equal(isError(noLocator), true);
    assert.equal(requests.length, 0);
    bridge.dispose();
  });

  it("register forwards provenance fields", async () => {
    const { bridge, requests } = scriptedBridge({
      "source.register": (params: { kind: string; uri?: string; note?: string }) => {
        assert.equal(params.kind, "paper");
        assert.equal(params.uri, "https://example.test/paper");
        assert.equal(params.note, "baseline method");
        return { source: { sourceId: "src-1", kind: "paper", uri: "https://example.test/paper", state: "available", createdAt: 1 } };
      },
    });
    const tool = createResearchSourceTool(bridge, SESSION);
    const result = await tool.execute("call-1", {
      action: "register", kind: "paper", uri: "https://example.test/paper", note: "baseline method",
    } as never, undefined, undefined, undefined as never);
    assert.equal(isError(result), undefined);
    assert.equal(requests[0]!.method, "source.register");
    bridge.dispose();
  });

  it("list forwards the kind filter", async () => {
    const { bridge, requests } = scriptedBridge({
      "source.list": (params: { kind?: string }) => {
        assert.equal(params.kind, "dataset");
        return { sources: [], text: "no sources" };
      },
    });
    const tool = createResearchSourceTool(bridge, SESSION);
    await tool.execute("call-1", { action: "list", kind: "dataset" } as never, undefined, undefined, undefined as never);
    assert.equal(requests[0]!.method, "source.list");
    bridge.dispose();
  });
});

describe("experiment tool gating", () => {
  const baseDeps = {
    bridge: new HostServicesBridge({ emit: () => {}, sessionId: SESSION }),
    sessionId: SESSION,
    cwd: "/tmp",
    workspaceMutationJournal: undefined,
    isOpenAIFamily: false,
  };

  it("registers experiment, resources, research_source only when the Host advertises them", () => {
    const without = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, baseDeps).map((tool) => tool.name);
    assert.equal(without.includes("experiment"), false);
    assert.equal(without.includes("resources"), false);
    assert.equal(without.includes("research_source"), false);

    const with_ = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
      ...baseDeps,
      experimentAvailable: true,
    }).map((tool) => tool.name);
    assert.equal(with_.includes("experiment"), true);
    assert.equal(with_.includes("resources"), true);
    assert.equal(with_.includes("research_source"), true);
  });

  it("respects per-tool settings flags", () => {
    const tools = selectHarnessTools(
      { ...DEFAULT_HARNESS_SETTINGS, tools: { experiment: false, research_source: false } },
      { ...baseDeps, experimentAvailable: true },
    ).map((tool) => tool.name);
    assert.equal(tools.includes("experiment"), false);
    assert.equal(tools.includes("resources"), true);
    assert.equal(tools.includes("research_source"), false);
  });
});
