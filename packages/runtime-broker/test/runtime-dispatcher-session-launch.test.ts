import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionSnapshot } from "@varin/protocol";
import { dispatchRuntimeRequest, RuntimeDispatchError } from "../src/runtime-dispatcher.js";
import type { PiRuntimeBroker } from "../src/runtime-broker.js";

const snapshot = (sessionId: string): SessionSnapshot => ({
  activeTools: ["read"],
  busy: false,
  cwd: "/workspace",
  features: { revision: 0, schemaVersion: 1 },
  followUp: [],
  followUpMode: "one-at-a-time",
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionId,
  steering: [],
  steeringMode: "all",
  thinkingLevel: "off",
});

describe("runtime dispatcher session launch projection", () => {
  it("routes immediate application to the exact session and requires a candidate identity", async () => {
    const calls: unknown[][] = [];
    const broker = { requestForSession: async (...args: unknown[]) => {
      calls.push(args); return { accepted: true, taskId: "summary-1" };
    } } as unknown as PiRuntimeBroker;
    await dispatchRuntimeRequest(broker, "agent.compact.apply", { sessionId: "session-1", taskId: "summary-1" });
    assert.deepEqual(calls, [["session-1", "agent.compact.apply", { sessionId: "session-1", taskId: "summary-1" }]]);
    await assert.rejects(dispatchRuntimeRequest(broker, "agent.compact.apply", { sessionId: "session-1" }), { code: "invalid_params" });
    assert.equal(calls.length, 1);
  });
  it("passes a validated frozen model and tool set into create and open", async () => {
    const calls: unknown[][] = [];
    const broker = {
      createSession: async (...args: unknown[]) => {
        calls.push(args);
        return snapshot("created");
      },
      openSession: async (input: unknown) => {
        calls.push([input]);
        return snapshot("opened");
      },
    } as unknown as PiRuntimeBroker;
    const launch = {
      model: { providerId: "openai", modelId: "gpt-test" },
      scope: ["packages/web"],
      tools: ["read", "grep"],
      workFocus: "research" as const,
    };

    await dispatchRuntimeRequest(broker, "session.create", {
      cwd: "/workspace",
      ...launch,
      workspace: { kind: "workspace", id: "workspace-1" },
    });
    await dispatchRuntimeRequest(broker, "session.open", {
      cwd: "/workspace",
      sessionId: "child-1",
      ...launch,
    });

    assert.deepEqual(calls[0]?.[4], launch);
    assert.deepEqual(calls[1]?.[0], {
      cwd: "/workspace",
      sessionId: "child-1",
      model: launch.model,
      scope: launch.scope,
      tools: launch.tools,
    });
  });

  it("routes an explicit session work-focus selection through the broker", async () => {
    const calls: unknown[][] = [];
    const broker = {
      setSessionWorkFocus: async (...args: unknown[]) => {
        calls.push(args);
        return snapshot("session-1");
      },
    } as unknown as PiRuntimeBroker;
    await dispatchRuntimeRequest(broker, "session.workFocus.set", {
      sessionId: "session-1",
      workFocus: "research",
    });
    assert.deepEqual(calls, [["session-1", "research"]]);
  });

  it("rejects malformed tool lists before they reach the broker", async () => {
    const broker = { openSession: () => assert.fail("must not dispatch") } as unknown as PiRuntimeBroker;
    await assert.rejects(
      dispatchRuntimeRequest(broker, "session.open", {
        cwd: "/workspace",
        sessionId: "child-1",
        tools: ["read", 42],
      } as never),
      (error: unknown) => error instanceof RuntimeDispatchError && error.code === "invalid_params",
    );
  });
});
