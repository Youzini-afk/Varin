import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { createNodeReplSession, type ReplInstallation } from "../src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(environmentId = "environment") {
  const calls: { cellId: string; input: unknown }[] = [];
  const outputs: { cellId: string; text: string }[] = [];
  const session = createNodeReplSession<unknown, unknown>({
    environmentId,
    invoke: async (cellId, input) => { calls.push({ cellId, input }); return input; },
    output: (cellId, text) => { outputs.push({ cellId, text }); },
  });
  return { session, calls, outputs };
}

test("Node cells preserve lexical bindings, top-level await, closures and object identity", async (t) => {
  const { session, outputs } = fixture();
  t.after(() => session.closeAdmission());
  assert.equal((await session.evaluate({ cellId: "one", script: `
    let count = await Promise.resolve(2);
    const shared = { count };
    class Counter { next() { return ++count; } }
    function increment() { shared.count = new Counter().next(); return shared; }
    print("created", count); shared
  ` })).valueText, "{ count: 2 }");
  assert.equal((await session.evaluate({ cellId: "two", script: "increment() === shared && shared.count === 3" })).valueText, "true");
  assert.equal((await session.evaluate({ cellId: "three", script: "Promise.resolve(count + 4)" })).valueText, "7");
  assert.deepEqual(outputs, [{ cellId: "one", text: "created 2" }]);
});

test("contexts are isolated and syntax/runtime errors preserve subsequent usable cells", async (t) => {
  const { session } = fixture("first");
  const other = fixture("second").session;
  t.after(() => { session.closeAdmission(); other.closeAdmission(); });
  await session.evaluate({ cellId: "declare", script: "let retained = 12" });
  assert.equal((await other.evaluate({ cellId: "read", script: "typeof retained" })).valueText, "undefined");
  assert.match((await session.evaluate({ cellId: "syntax", script: "const bad = ;" })).error?.message ?? "", /Unexpected token/);
  assert.equal((await session.evaluate({ cellId: "throw", script: "throw Object.assign(new Error('runtime failed'), { code: 'EXAMPLE' })" })).error?.code, "EXAMPLE");
  assert.equal((await session.evaluate({ cellId: "reject", script: "await Promise.reject(new Error('async failed'))" })).error?.message, "async failed");
  assert.equal((await session.evaluate({ cellId: "promise", script: "Promise.reject(new Error('returned failed'))" })).error?.message, "returned failed");
  assert.equal((await session.evaluate({ cellId: "after", script: "retained += 1" })).valueText, "13");
});

test("an old function uses its new caller's scope; detached continuations retain their closed scope", async (t) => {
  const gate = deferred<void>();
  const detachedDone = deferred<string>();
  const timerDone = deferred<string>();
  const calls: { cellId: string; input: unknown }[] = [];
  const session = createNodeReplSession<unknown, unknown>({
    environmentId: "scopes",
    invoke: async (cellId, input) => { calls.push({ cellId, input }); return input; },
    output() {},
    install({ context, invoke }) {
      context.tools = { invoke };
      context.gate = gate.promise;
      context.detachedDone = detachedDone.resolve;
      context.timerDone = timerDone.resolve;
    },
  });
  t.after(() => session.closeAdmission());
  await session.evaluate({ cellId: "old", script: `
    function saved(value) { return tools.invoke(value); }
    gate.then(() => saved("detached")).then(() => detachedDone("wrong"), error => detachedDone(error.code));
    setTimeout(() => saved("timer").then(() => timerDone("wrong"), error => timerDone(error.code)), 10);
    undefined
  ` });
  const newCell = session.evaluate({ cellId: "new", script: "await saved('fresh'); await new Promise(resolve => setTimeout(resolve, 30)); 'done'" });
  gate.resolve();
  assert.equal(await detachedDone.promise, "SCRIPT_CELL_CLOSED");
  assert.equal(await timerDone.promise, "SCRIPT_CELL_CLOSED");
  assert.equal((await newCell).valueText, "done");
  assert.deepEqual(calls, [{ cellId: "new", input: "fresh" }]);
});

test("completion closes admission before draining admitted unawaited invocations", async (t) => {
  const receipt = deferred<string>();
  const detached = deferred<string>();
  const calls: unknown[] = [];
  const session = createNodeReplSession<unknown, string>({
    environmentId: "drain",
    invoke: async (_cell, input) => { calls.push(input); return receipt.promise; },
    output() {},
    install({ context, invoke }) { context.tools = { invoke }; context.finished = detached.resolve; },
  });
  t.after(() => session.closeAdmission());
  let complete = false;
  const result = session.evaluate({ cellId: "one", script: `
    tools.invoke("accepted").then(() => tools.invoke("late")).then(() => finished("wrong"), error => finished(error.code));
    "cell value"
  ` }).then((value) => { complete = true; return value; });
  await turn();
  assert.equal(complete, false);
  assert.equal((await session.evaluate({ cellId: "too-soon", script: "1" })).error?.code, "SCRIPT_ENVIRONMENT_BUSY");
  receipt.resolve("original receipt");
  assert.equal((await result).valueText, "cell value");
  assert.equal(await detached.promise, "SCRIPT_CELL_CLOSED");
  assert.deepEqual(calls, ["accepted"]);
});

test("drain also waits after script failure; invoke rejection stays an error", async (t) => {
  const receipt = deferred<string>();
  const session = createNodeReplSession<unknown, string>({ environmentId: "failure", invoke: () => receipt.promise, output() {} });
  t.after(() => session.closeAdmission());
  let complete = false;
  const result = session.evaluate({ cellId: "one", script: "tools.invoke({callId:'one'}); throw new Error('outer failed')" })
    .then((value) => { complete = true; return value; });
  await turn();
  assert.equal(complete, false);
  receipt.reject(Object.assign(new Error("original rejected"), { code: "DENIED" }));
  assert.equal((await result).error?.message, "outer failed");
  assert.equal((await session.evaluate({ cellId: "two", script: "await tools.invoke('again')" })).error?.code, "DENIED");
});

test("closeAdmission fences immediately without pretending to stop an in-flight callback", async () => {
  const receipt = deferred<string>();
  let installation!: ReplInstallation<unknown, string>;
  const session = createNodeReplSession<unknown, string>({
    environmentId: "closed", invoke: () => receipt.promise, output() {},
    install(value) { installation = value; value.context.call = value.invoke; },
  });
  assert.equal((await session.evaluate({ cellId: "namespace", script: "typeof tools" })).valueText, "undefined");
  const result = session.evaluate({ cellId: "one", script: "await call('pending'); await call('after-close')" });
  session.closeAdmission();
  assert.equal((await session.evaluate({ cellId: "two", script: "42" })).error?.code, "SCRIPT_CELL_CLOSED");
  await assert.rejects(installation.invoke("outside"), { code: "SCRIPT_CELL_CLOSED" });
  receipt.resolve("accepted");
  assert.equal((await result).error?.code, "SCRIPT_CELL_CLOSED");
});

test("console and print produce explicit cell-associated output", async (t) => {
  const { session, outputs } = fixture();
  t.after(() => session.closeAdmission());
  await session.evaluate({ cellId: "logs", script: "console.log('value %d', 4); console.warn('careful'); print({ ok: true }); undefined" });
  assert.deepEqual(outputs, [
    { cellId: "logs", text: "value 4" },
    { cellId: "logs", text: "careful" },
    { cellId: "logs", text: "{ ok: true }" },
  ]);
});

test("plain eval closes synchronously before a detached queued microtask can invoke", async (t) => {
  const done = deferred<string>();
  const calls: unknown[] = [];
  const session = createNodeReplSession<unknown, unknown>({
    environmentId: "microtask",
    invoke: async (_cell, input) => { calls.push(input); return input; },
    output() {},
    install({ context, invoke }) { context.tools = { invoke }; context.done = done.resolve; },
  });
  t.after(() => session.closeAdmission());
  assert.equal((await session.evaluate({ cellId: "one", script: `
    Promise.resolve().then(() => tools.invoke("too late"))
      .then(() => done("wrong"), error => done(error.code));
    "finished"
  ` })).valueText, "finished");
  assert.equal(await done.promise, "SCRIPT_CELL_CLOSED");
  assert.deepEqual(calls, []);
});

test("direct null/undefined throws and returned/falsy Promise rejections stay failures", async (t) => {
  const { session } = fixture();
  t.after(() => session.closeAdmission());
  for (const [script, message] of [
    ["throw null", "null"],
    ["throw undefined", "undefined"],
    ["Promise.reject(undefined)", "undefined"],
    ["await Promise.reject(undefined)", "undefined"],
    ["await Promise.reject(false)", "false"],
    ["await Promise.reject(0)", "0"],
  ]) {
    const result = await session.evaluate({ cellId: "failure", script: script! });
    assert.equal(result.error?.message, message);
    assert.equal(result.valueText, undefined);
  }
  assert.equal((await session.evaluate({ cellId: "next", script: "21 * 2" })).valueText, "42");
});

test("adapter error projection preserves only its explicitly selected error facts", async (t) => {
  type AdapterError = { message: string; code?: string; actionSent?: boolean; retry?: string };
  const session = createNodeReplSession<unknown, unknown, AdapterError>({
    environmentId: "adapter",
    invoke: async () => { throw Object.assign(new Error("Action uncertain"), { code: "UNCERTAIN", actionSent: true, retry: "observe", unrelated: "not forwarded" }); },
    output() {},
    serializeError(error) {
      const value = error as AdapterError;
      return { message: value.message, ...(value.code === undefined ? {} : { code: value.code }),
        ...(value.actionSent === undefined ? {} : { actionSent: value.actionSent }),
        ...(value.retry === undefined ? {} : { retry: value.retry }) };
    },
  });
  t.after(() => session.closeAdmission());
  const result = await session.evaluate({ cellId: "one", script: "await tools.invoke('call')" });
  assert.deepEqual(result.error, { message: "Action uncertain", code: "UNCERTAIN", actionSent: true, retry: "observe" });
});
