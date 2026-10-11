import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ScriptFrameDecoder, encodeScriptFrame, parseScriptWorkerFrame } from "../dist/index.js";

function worker(t, environmentId = "test-environment") {
  const child = spawn(process.execPath, ["--experimental-repl-await", fileURLToPath(new URL("../dist/worker.js", import.meta.url))], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const decoder = new ScriptFrameDecoder(parseScriptWorkerFrame);
  const frames = [];
  const waiters = [];
  let stderr = "";
  let ended = false;
  let failure;
  const exit = once(child, "exit");
  const closed = once(child, "close");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    try {
      for (const frame of decoder.push(chunk)) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(frame);
        else frames.push(frame);
      }
    } catch (error) {
      failure = error;
      for (const waiter of waiters.splice(0)) waiter.reject(error);
    }
  });
  child.on("error", (error) => {
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  child.on("close", () => {
    ended = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error("Worker exited before its next frame"));
  });
  t.after(async () => {
    if (!ended) child.kill("SIGKILL");
    await closed;
  });
  return {
    child, frames, exit, closed,
    stderr: () => stderr,
    send(frame) { child.stdin.write(encodeScriptFrame({ v: 2, environmentId, ...frame })); },
    next() {
      if (failure) return Promise.reject(failure);
      if (frames.length) return Promise.resolve(frames.shift());
      if (ended) return Promise.reject(new Error("Worker already exited"));
      return new Promise((resolve, reject) => { waiters.push({ resolve, reject }); });
    },
  };
}

async function initialized(t) {
  const runtime = worker(t);
  runtime.send({ type: "initialize", bindingIdentity: "frozen-binding" });
  assert.deepEqual(await runtime.next(), { v: 2, type: "ready", environmentId: "test-environment", bindingIdentity: "frozen-binding" });
  return runtime;
}

test("compiled stdio worker preserves lexical cells, output and recovery", { timeout: 10000 }, async (t) => {
  const runtime = await initialized(t);
  runtime.send({ type: "eval", cellId: "one", script: "let total = await Promise.resolve(5); const item = { total }; function add(){ item.total += 1; return item; } console.log('ready'); item" });
  assert.equal((await runtime.next()).part.text, "ready");
  assert.equal((await runtime.next()).valueText, "{ total: 5 }");
  runtime.send({ type: "eval", cellId: "syntax", script: "let bad = ;" });
  assert.match((await runtime.next()).error.message, /Unexpected token/);
  runtime.send({ type: "eval", cellId: "throw", script: "throw new Error('cell failed')" });
  assert.equal((await runtime.next()).error.message, "cell failed");
  runtime.send({ type: "eval", cellId: "two", script: "add() === item && item.total === 6" });
  assert.equal((await runtime.next()).valueText, "true");
  runtime.child.stdin.end();
  assert.deepEqual(await runtime.exit, [0, null]);
  assert.equal(runtime.stderr(), "");
});

test("same semantic callId has independent transport requests and original full JSON", { timeout: 10000 }, async (t) => {
  const runtime = await initialized(t);
  runtime.send({ type: "eval", cellId: "calls", script: `
    const input = { callId: "same-call", name: "original.tool", arguments: { unicode: "文🙂", extra: [true, null] }, originalDecoderMustSeeThis: "present" };
    const first = tools.invoke(input);
    const second = tools.invoke(input);
    const receipts = await Promise.all([first, second]);
    receipts.map(receipt => receipt.operationId).join(',')
  ` });
  const first = await runtime.next();
  const second = await runtime.next();
  assert.equal(first.type, "invoke");
  assert.equal(second.type, "invoke");
  assert.equal(first.input.callId, second.input.callId);
  assert.notEqual(first.requestId, second.requestId);
  assert.deepEqual(first.input, second.input);
  assert.equal(first.input.originalDecoderMustSeeThis, "present");
  runtime.send({ type: "receipt", cellId: "calls", requestId: second.requestId, receipt: { operationId: "second-original", completion: { kind: "result", outcome: "succeeded", effect: "none", content: { data: { original: true }, parts: [] } } } });
  runtime.send({ type: "receipt", cellId: "calls", requestId: first.requestId, receipt: { operationId: "first-original", completion: { kind: "result", outcome: "succeeded", effect: "none", content: { data: { original: true }, parts: [] } } } });
  assert.equal((await runtime.next()).valueText, "first-original,second-original");
  runtime.child.stdin.end();
  assert.deepEqual(await runtime.exit, [0, null]);
});

test("worker drains unawaited calls, closes old scope, and keeps Host rejection as error", { timeout: 10000 }, async (t) => {
  const runtime = await initialized(t);
  runtime.send({ type: "eval", cellId: "unawaited", script: `
    let lateCode;
    tools.invoke({callId:'accepted',name:'tool',arguments:{}})
      .then(() => tools.invoke({callId:'late',name:'tool',arguments:{}}))
      .catch(error => { lateCode = error.code; });
    'body done'
  ` });
  const request = await runtime.next();
  assert.equal(request.type, "invoke");
  // Another request establishes a deterministic protocol round trip while the
  // first callback is still pending. Completion cannot precede its receipt.
  runtime.send({ type: "eval", cellId: "busy", script: "1" });
  const busy = await runtime.next();
  assert.equal(busy.cellId, "busy");
  assert.equal(busy.error.code, "SCRIPT_ENVIRONMENT_BUSY");
  runtime.send({ type: "receipt", cellId: "unawaited", requestId: request.requestId, receipt: { operationId: "original", completion: { kind: "result", outcome: "succeeded", effect: "none", content: { data: {}, parts: [] } } } });
  const completed = await runtime.next();
  assert.equal(completed.type, "completed");
  assert.equal(completed.cellId, "unawaited");
  assert.equal(completed.valueText, "body done");
  runtime.send({ type: "eval", cellId: "read-closure", script: "lateCode" });
  assert.equal((await runtime.next()).valueText, "SCRIPT_CELL_CLOSED");
  runtime.send({ type: "eval", cellId: "denied", script: "await tools.invoke({callId:'denied',name:'tool',arguments:{}})" });
  const denied = await runtime.next();
  runtime.send({ type: "rejected", cellId: "denied", requestId: denied.requestId, error: { message: "Original authorization denied", code: "DENIED" } });
  const error = await runtime.next();
  assert.deepEqual(error.error, { message: "Original authorization denied", code: "DENIED" });
  assert.equal(error.valueText, undefined);
  runtime.child.stdin.end();
  assert.deepEqual(await runtime.exit, [0, null]);
});

test("EOF rejects pending transport promises without reporting completed or stopped", { timeout: 10000 }, async (t) => {
  const runtime = await initialized(t);
  runtime.send({ type: "eval", cellId: "pending", script: "await tools.invoke({callId:'pending',name:'tool',arguments:{}})" });
  assert.equal((await runtime.next()).type, "invoke");
  runtime.child.stdin.end();
  assert.deepEqual(await runtime.exit, [0, null]);
  await runtime.closed;
  assert.deepEqual(runtime.frames, []);
  assert.equal(runtime.stderr(), "");
});

test("wrong environment and malformed protocol fail without echoing payload", { timeout: 10000 }, async (t) => {
  const runtime = await initialized(t);
  runtime.send({ type: "eval", environmentId: "wrong", cellId: "bad", script: "'private-body-marker'" });
  assert.deepEqual(await runtime.exit, [1, null]);
  await runtime.closed;
  assert.equal(runtime.stderr(), "Script worker protocol failed\n");
  assert.deepEqual(runtime.frames, []);
});


test("compiled worker publishes only explicit ordered media and keeps earlier image on failure", { timeout: 10000 }, async t => {
  const runtime = await initialized(t);
  runtime.send({ type: "eval", cellId: "images", script: `
    const receipt = await tools.invoke({callId:'observe',name:'computer_observe',arguments:{}});
    print('before'); emitImage(receipt.completion.content.parts[0].media);
    console.log('after'); throw new Error('outer failed');
  ` });
  const invoke = await runtime.next();
  const media = {media_type:'image/png',data_base64:'aW1hZ2U=',source:{kind:'operation',operation_id:'original-operation'}};
  runtime.send({type:'receipt',cellId:'images',requestId:invoke.requestId,receipt:{operationId:'original-operation',completion:{kind:'result',outcome:'succeeded',effect:'none',content:{data:{metadata:true},parts:[{kind:'media',media}]}}}});
  assert.deepEqual((await runtime.next()).part, {kind:'text',text:'before'});
  assert.deepEqual((await runtime.next()).part, {kind:'media',media:{media_type:'image/png',data_base64:'aW1hZ2U='}});
  assert.deepEqual((await runtime.next()).part, {kind:'text',text:'after'});
  assert.equal((await runtime.next()).error.message, 'outer failed');
  runtime.send({type:'eval',cellId:'no-forward',script:"await tools.invoke({callId:'hidden',name:'computer_observe',arguments:{}}); undefined"});
  const hidden=await runtime.next();
  runtime.send({type:'receipt',cellId:'no-forward',requestId:hidden.requestId,receipt:{operationId:'hidden-operation',completion:{kind:'result',outcome:'succeeded',effect:'none',content:{data:null,parts:[{kind:'media',media}]}}}});
  assert.equal((await runtime.next()).type,'completed');
  runtime.child.stdin.end(); await runtime.exit;
});
