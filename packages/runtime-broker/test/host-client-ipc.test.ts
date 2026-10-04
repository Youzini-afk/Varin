import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { type EventEnvelope, ProtocolDecodeError } from "@varin/protocol";
import { PiHostClient, type PiHostExit } from "../src/host-client.js";

const TRANSPORT_URL = pathToFileURL(
  resolve(import.meta.dirname, "../../pi-host/src/transport.ts"),
).href;

// This process contains only the actual IPC transport and controlled replies.
// It does not load Pi, create a session, or open any user configuration.
const FIXTURE_SOURCE = [
  "import { IpcHostTransport } from " + JSON.stringify(TRANSPORT_URL) + ";",
  "const transport = new IpcHostTransport();",
  "let sequence = 0;",
  "const event = (name, data) => transport.send({ v: 1, kind: 'event', seq: sequence++, event: name, data });",
  "const reply = (request, result) => transport.send({ v: 1, kind: 'response', id: request.id, ok: true, result });",
  "const rejectedBySender = (value) => {",
  "  try { process.send(value); return false; } catch { return true; }",
  "};",
  "transport.start((request) => {",
  "  if (request.method === 'host.handshake') {",
  "    reply(request, { protocolVersion: 1 });",
  "  } else if (request.method === 'host.shutdown') {",
  "    reply(request, {});",
  "    transport.close();",
  "  } else if (request.method === 'fixture.throw') {",
  "    throw new Error('fixture handler failed');",
  "  } else if (process.env.VARIN_IPC_FIXTURE_MODE === 'malformed') {",
  "    transport.send({ v: 1, kind: 'response', id: request.id, ok: true });",
  "  } else if (process.env.VARIN_IPC_FIXTURE_MODE === 'sequence-gap') {",
  "    sequence += 1;",
  "    event('host.log', { level: 'info', message: 'invalid sequence' });",
  "  } else {",
  "    const result = {",
  "      normal: request.params.fixture,",
  "      bigintRejected: rejectedBySender({ value: 1n }),",
  "      undefinedRejected: rejectedBySender(undefined),",
  "    };",
  "    event('host.log', { level: 'info', message: 'fixture event', fixture: result });",
  "    reply(request, result);",
  "  }",
  "}, () => transport.close(), (error) => {",
  "  event('host.error', { code: error.code ?? 'fixture_handler', message: error.message });",
  "});",
  "event('host.ready', {});",
].join("\n");

async function fixtureEntry(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "varin-ipc-codec-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, "worker.mjs");
  await writeFile(entry, FIXTURE_SOURCE, "utf8");
  return entry;
}

async function fixtureClient(t: TestContext, mode = "valid") {
  const hostEntry = await fixtureEntry(t);
  const events: EventEnvelope[] = [];
  let resolveExit!: (exit: PiHostExit) => void;
  const exited = new Promise<PiHostExit>((resolve) => { resolveExit = resolve; });
  const client = new PiHostClient({
    environment: { VARIN_IPC_FIXTURE_MODE: mode },
    execArgv: ["--import", import.meta.resolve("tsx")],
    handshake: { clientName: "ipc-fixture", clientVersion: "0", mode: "test" },
    hostEntry,
    onEvent: (event) => events.push(event),
    onExit: resolveExit,
    shutdownTimeoutMs: 1_000,
  });
  t.after(() => client.dispose());
  await client.start();
  return { client, events, exited };
}

test("Node IPC normalizes JSON once in each process direction", { timeout: 10_000 }, async (t) => {
  const { client, events } = await fixtureClient(t);
  await assert.rejects(
    client.request("session.summary", { sessionId: "fixture", fixture: 1n } as never),
    /BigInt/,
  );
  let toJsonCalls = 0;
  const inherited = Object.assign(Object.create({ inherited: "not transferred" }), { own: "kept" });
  const result = await client.request("session.summary", {
    sessionId: "fixture",
    fixture: {
      absent: undefined,
      date: new Date("2026-01-01T00:00:00.000Z"),
      inherited,
      nonfinite: Number.POSITIVE_INFINITY,
      array: [undefined, Number.NaN],
      converted: { toJSON: () => { toJsonCalls += 1; return "converted"; } },
    },
  } as never) as unknown;
  const expected = {
    normal: {
      date: "2026-01-01T00:00:00.000Z",
      inherited: { own: "kept" },
      nonfinite: null,
      array: [null, null],
      converted: "converted",
    },
    bigintRejected: true,
    undefinedRejected: true,
  };
  assert.equal(toJsonCalls, 1);
  assert.deepEqual(result, expected);
  const event = events.find((item) => item.event === "host.log");
  assert.deepEqual((event?.data as { fixture?: unknown }).fixture, expected);
});

test("malformed IPC replies reject pending broker requests and retire the worker", { timeout: 10_000 }, async (t) => {
  const { client, events, exited } = await fixtureClient(t, "malformed");
  await assert.rejects(
    client.request("session.summary", { sessionId: "fixture" }),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolDecodeError);
      assert.equal(error.code, "invalid_envelope");
      assert.match(error.message, /response.result is required/);
      return true;
    },
  );
  await exited;
  assert.equal(client.running, false);
  assert.equal(events.length, 1);
});

test("IPC event sequence gaps still reject pending requests", { timeout: 10_000 }, async (t) => {
  const { client, events, exited } = await fixtureClient(t, "sequence-gap");
  await assert.rejects(
    client.request("session.summary", { sessionId: "fixture" }),
    /event sequence gap: expected 1, received 2/,
  );
  await exited;
  assert.equal(events.length, 1);
});

test("Host IPC reports malformed requests and handler errors through onError", { timeout: 10_000 }, async (t) => {
  const entry = await fixtureEntry(t);
  const child = fork(entry, [], {
    execArgv: ["--import", import.meta.resolve("tsx")],
    serialization: "json",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill();
    await exited;
  });
  const [ready] = await once(child, "message");
  assert.equal(ready.event, "host.ready");
  const rejected = once(child, "message");
  child.send({ v: 1, kind: "request", id: "missing-params", method: "session.summary" });
  const [invalid] = await rejected;
  assert.equal(invalid.event, "host.error");
  assert.equal(invalid.data.code, "invalid_envelope");
  assert.equal(invalid.data.message, "request.params is required");

  const failed = once(child, "message");
  child.send({ v: 1, kind: "request", id: "handler-failure", method: "fixture.throw", params: {} });
  const [handlerError] = await failed;
  assert.equal(handlerError.data.code, "fixture_handler");
  assert.equal(handlerError.data.message, "fixture handler failed");
});
