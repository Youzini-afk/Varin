import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createRuntimeErrorResponse,
  createRuntimeEvent,
  createRuntimeSuccessResponse,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
} from "@varin/protocol";
import {
  PiRuntimeAmbiguousRequestError,
  PiRuntimeClient,
  PiRuntimeRequestError,
  PiRuntimeRequestTimeoutError,
} from "../src/index.js";
import type { RuntimeTransport, RuntimeTransportHandlers } from "../src/index.js";

class MemoryTransport implements RuntimeTransport {
  handlers: RuntimeTransportHandlers | undefined;
  sent: string[] = [];

  start(handlers: RuntimeTransportHandlers): void {
    this.handlers = handlers;
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {}

  receive(frame: string): void {
    this.handlers?.message(frame);
  }

  disconnect(error?: Error): void {
    this.handlers?.close(error);
  }
}

describe("PiRuntimeClient", () => {
  it("observes a response deadline even when async transport send never settles", async () => {
    const transport = new MemoryTransport();
    const errors: Error[] = [];
    transport.send = () => new Promise<void>(() => {});
    const client = new PiRuntimeClient({ createId: () => "slow-send", transport, onProtocolError: (error) => errors.push(error) });
    await client.connect();
    try {
      await assert.rejects(client.request("agent.prompt", { sessionId: "s", text: "once" }, 20), PiRuntimeRequestTimeoutError);
      transport.receive(encodeRuntimeEnvelope(createRuntimeSuccessResponse<"agent.prompt">("slow-send", { accepted: true })));
      assert.deepEqual(errors, []);
    } finally {
      await client.close();
    }
  });

  it("retires a half-open connection without retrying a sent mutation or declaring it failed", async () => {
    const transport = new MemoryTransport();
    let closes = 0;
    let losses = 0;
    transport.close = () => { closes++; };
    const client = new PiRuntimeClient({ transport, onConnectionLost: () => { losses++; } });
    await client.connect();
    const pending = client.request("agent.prompt", { sessionId: "session-1", text: "run once" });
    const outcome = assert.rejects(pending, PiRuntimeAmbiguousRequestError);
    await client.invalidate(new Error("Read-only health probe timed out"));
    await outcome;
    assert.equal(client.connected, false);
    assert.equal(transport.sent.length, 1);
    assert.equal(losses, 1);
    assert.equal(closes, 1);
    await client.invalidate(new Error("late duplicate health failure"));
    assert.equal(losses, 1);
    assert.equal(closes, 1);
  });

  it("correlates responses without depending on response order", async () => {
    const transport = new MemoryTransport();
    let nextId = 0;
    const client = new PiRuntimeClient({
      createId: () => `request-${++nextId}`,
      transport,
    });
    await client.connect();

    const first = client.request("session.list", { cwd: "C:/one" });
    const second = client.request("session.list", { cwd: "C:/two" });
    assert.equal(transport.sent.length, 2);
    transport.receive(
      encodeRuntimeEnvelope(createRuntimeSuccessResponse<"session.list">("request-2", [])),
    );
    transport.receive(
      encodeRuntimeEnvelope(createRuntimeSuccessResponse<"session.list">("request-1", [])),
    );

    assert.deepEqual(await second, []);
    assert.deepEqual(await first, []);
    assert.equal(decodeRuntimeEnvelope(transport.sent[0] ?? "").kind, "request");
    await client.close();
  });

  it("surfaces typed request failures", async () => {
    const transport = new MemoryTransport();
    const client = new PiRuntimeClient({ createId: () => "failed", transport });
    await client.connect();
    const request = client.request("session.list", {});
    transport.receive(
      encodeRuntimeEnvelope(
        createRuntimeErrorResponse("failed", {
          code: "denied",
          message: "Request denied",
          retryable: false,
        }),
      ),
    );

    await assert.rejects(request, (error: unknown) => {
      assert.ok(error instanceof PiRuntimeRequestError);
      assert.equal(error.code, "denied");
      return true;
    });
    await client.close();
  });

  it("detects missing delivered frames without treating filtered worker sequences as gaps", async () => {
    const transport = new MemoryTransport();
    const gaps: Array<{ expected: number; received: number }> = [];
    const events: number[] = [];
    const client = new PiRuntimeClient({
      onSequenceGap: ({ expected, received }) => gaps.push({ expected, received }),
      transport,
    });
    client.subscribe((event) => events.push(event.seq));
    await client.connect();

    const sourceA = {
      role: "session" as const,
      runtimeGeneration: 1,
      sessionId: "a",
      workerId: "worker-a",
    };
    const sourceB = { role: "catalog" as const, runtimeGeneration: 1, workerId: "worker-b" };
    transport.receive(
      encodeRuntimeEnvelope({ ...createRuntimeEvent(sourceA, 5, "session.closed", { sessionId: "a" }), surfaceSeq: 0 }),
    );
    transport.receive(
      encodeRuntimeEnvelope({ ...createRuntimeEvent(sourceB, 9, "session.closed", { sessionId: "b" }), surfaceSeq: 1 }),
    );
    transport.receive(
      encodeRuntimeEnvelope({ ...createRuntimeEvent(sourceA, 7, "session.closed", { sessionId: "a" }), surfaceSeq: 3 }),
    );
    transport.receive(
      encodeRuntimeEnvelope({ ...createRuntimeEvent(sourceA, 7, "session.closed", { sessionId: "a" }), surfaceSeq: 3 }),
    );

    assert.deepEqual(events, [5, 9, 7]);
    assert.deepEqual(gaps, [{ expected: 2, received: 3 }]);
    await client.close();
  });

  it("rejects pending requests when the transport disconnects", async () => {
    const transport = new MemoryTransport();
    const client = new PiRuntimeClient({ createId: () => "pending", transport });
    await client.connect();
    const request = client.request("session.list", {});
    transport.disconnect(new Error("offline"));

    await assert.rejects(request, (error: unknown) => {
      assert.ok(error instanceof PiRuntimeAmbiguousRequestError);
      assert.equal(error.method, "session.list");
      assert.match(error.message, /result is unknown/);
      assert.match(error.cause.message, /offline/);
      return true;
    });
  });

  it("reports a lost connection to the supervision callback but not an explicit close", async () => {
    const transport = new MemoryTransport();
    const lost: Array<Error | undefined> = [];
    const client = new PiRuntimeClient({
      onConnectionLost: (error) => lost.push(error),
      transport,
    });
    await client.connect();
    transport.disconnect(new Error("offline"));
    assert.equal(lost.length, 1);
    assert.match(lost[0]?.message ?? "", /offline/);

    const second = new PiRuntimeClient({
      onConnectionLost: (error) => lost.push(error),
      transport: new MemoryTransport(),
    });
    await second.connect();
    await second.close();
    assert.equal(lost.length, 1);
  });

  it("rejects with a typed timeout whose remote outcome stays unknown", async () => {
    const transport = new MemoryTransport();
    const client = new PiRuntimeClient({ createId: () => "timed", transport });
    await client.connect();
    const request = client.request("session.list", {}, 20);

    await assert.rejects(request, (error: unknown) => {
      assert.ok(error instanceof PiRuntimeRequestTimeoutError);
      assert.equal(error.method, "session.list");
      return true;
    });
    // The request is forgotten: a late response is ignored, not delivered.
    transport.receive(
      encodeRuntimeEnvelope(createRuntimeSuccessResponse<"session.list">("timed", [])),
    );
    await client.close();
  });

  it("does not impose a client-side request timeout by default", async () => {
    const transport = new MemoryTransport();
    const client = new PiRuntimeClient({ createId: () => "interactive", transport });
    await client.connect();
    const request = client.request("provider.login", {
      cwd: "C:/workspace",
      interactionId: "interactive-login",
      providerId: "example",
      type: "oauth",
    });
    transport.receive(
      encodeRuntimeEnvelope(
        createRuntimeSuccessResponse<"provider.login">("interactive", { authenticated: true }),
      ),
    );

    assert.deepEqual(await request, { authenticated: true });
    await client.close();
  });
});
