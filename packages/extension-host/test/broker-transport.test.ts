import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { type ChildProcess, type fork } from "node:child_process";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { ChildBrokeredHostTransport } from "../src/broker-supervisor.js";
import { HostServiceRegistry } from "../src/service-registry.js";

for (const failure of ["callback", "throw"] as const) {
  test(`failed cancellation delivery (${failure}) cannot drain a live provider`, async () => {
    let requestId = "";
    let requestSent!: () => void;
    const sent = new Promise<void>((resolve) => { requestSent = resolve; });
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      send(message: { kind: string; id: string }, callback: (error: Error | null) => void) {
        if (message.kind === "cancel") {
          const error = new Error("injected cancel IPC failure while child remains alive");
          if (failure === "throw") throw error;
          callback(error);
          return false;
        }
        requestId = message.id;
        callback(null);
        requestSent();
        return true;
      },
    });
    const transport = new ChildBrokeredHostTransport({
      brokerScript: "unused-fixture",
      forkProcess: (() => child as unknown as ChildProcess) as typeof fork,
      onCrash: () => undefined,
      requestFromChild: async () => null,
    });
    child.emit("message", { kind: "event", event: "ready" });
    const registry = new HostServiceRegistry("cancel-failure-fixture");
    const owner = { extensionId: "dev.example.cancel", entrypointId: "host", extensionVersion: "1", generation: 1 };
    await registry.replaceOwner(owner, [{
      descriptor: { id: "dev.example.cancel", version: 1 },
      handler: async (method, args, call) => await transport.request("service.invoke", { method, args }, call.signal) as string,
    }]);
    const controller = new AbortController();
    let settled = false;
    const invocation = registry.invoke({ serviceId: "dev.example.cancel", version: 1, method: "wait", args: [] }, controller.signal)
      .then((value) => { settled = true; return { value }; }, (error: unknown) => { settled = true; return { error }; });
    await sent;
    controller.abort();
    let drained = false;
    const draining = registry.drainOwner(owner).then(() => { drained = true; });
    await setImmediate();
    assert.equal(child.connected, true);
    assert.equal(settled, false, "cancel delivery failure does not settle the original invocation");
    assert.equal(drained, false, "the original execution still owns its in-flight reference");

    if (failure === "callback") {
      child.emit("message", { kind: "response", id: requestId, success: true, result: "actual result" });
      assert.deepEqual(await invocation, { value: "actual result" });
    } else {
      child.connected = false;
      child.emit("exit", 17, null);
      const result = await invocation;
      assert.ok("error" in result);
      assert.match(String(result.error), /process exited/);
    }
    await draining;
    assert.equal(drained, true);
  });
}

for (const failure of ["request-callback", "request-throw", "process-error", "disconnect"] as const) {
  test(`${failure} retains callback and pin ownership until the unreliable broker actually exits`, async () => {
    const registry = new HostServiceRegistry("request-failure-fixture");
    const owner = { extensionId: "dev.example.channel", entrypointId: "host", extensionVersion: "1", generation: 1 };
    let killed = false;
    let requestId = "";
    let crashCount = 0;
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      connected: true,
      kill() { killed = true; return true; },
      send(message: { kind: string; id: string }, callback: (error: Error | null) => void) {
        if (message.kind === "cancel") { callback(null); return true; }
        requestId = message.id;
        const error = new Error("injected IPC failure while the callback may still run");
        if (failure === "request-throw") throw error;
        if (failure === "request-callback") callback(error);
        else callback(null);
        return true;
      },
    });
    const transport = new ChildBrokeredHostTransport({
      brokerScript: "unused-fixture",
      forkProcess: (() => child as unknown as ChildProcess) as typeof fork,
      onCrash: () => { crashCount++; registry.revokeOwner(owner); },
      requestFromChild: async () => null,
    });
    child.emit("message", { kind: "event", event: "ready" });
    await registry.replaceOwner(owner, [{ descriptor: { id: "dev.example.channel", version: 1 },
      handler: async (method, args, context) => await transport.request("service.invoke", { method, args }, context.signal) as string }]);
    const pin = registry.bind("dev.example.channel", 1).pin();
    let settled = false;
    const pending = pin.invoke("wait", []).then(value => ({ value }), (error: unknown) => ({ error }))
      .finally(() => { settled = true; });
    await setImmediate();
    assert.ok(requestId);
    if (failure === "process-error") child.emit("error", new Error("injected live-process error"));
    if (failure === "disconnect") { child.connected = false; child.emit("disconnect"); }
    await setImmediate();
    assert.equal(killed, true);
    assert.equal(crashCount, 1);
    assert.equal(pin.revocationSignal.aborted, true);
    assert.equal(settled, false, "a kill request is not execution-stopped evidence");
    assert.equal(registry.hasPendingOwnerCalls(owner), true);
    let drained = false;
    const draining = registry.drainOwner(owner).then(() => { drained = true; });
    await setImmediate(); assert.equal(drained, false);
    child.connected = false; child.emit("exit", null, "SIGKILL");
    const result = await pending;
    assert.ok("error" in result); assert.match(String(result.error), /process exited/);
    await draining; assert.equal(drained, true); pin.release();
  });
}
