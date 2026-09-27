import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEvent,
  createRuntimeRequest,
  decodeRuntimeEnvelope,
  encodeRuntimeEnvelope,
  VARIN_PROTOCOL_VERSION,
  type RuntimeWireEnvelope,
} from "@varin/protocol";
import {
  PiRuntimeSurfaceConnection,
  type PiRuntimeBroker,
  type PiRuntimeBrokerEvent,
} from "../src/index.js";

const handshakeResult = {
  capabilities: {
    agentProviders: true,
    extensionUi: true,
    fleet: true,
    models: true,
    packages: true,
    recovery: true,
    resources: true,
    sessions: true,
    settings: true,
  },
  hostVersion: "0.1.0",
  protocolVersion: VARIN_PROTOCOL_VERSION,
  runtime: {
    agentDir: "C:/agent",
    nodePath: "node",
    nodeVersion: process.version,
    piVersion: "0.83.0",
    source: "bundled" as const,
  },
};

const createFakeBroker = () => {
  const listeners = new Set<(event: PiRuntimeBrokerEvent) => void>();
  let listSessions = async () => [];
  let nextWatchId = 0;
  const unwatched: string[] = [];
  const broker = {
    listSessions: (...args: Parameters<typeof listSessions>) => listSessions(...args),
    subscribe(listener: (event: PiRuntimeBrokerEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    unwatchConfig: async (watchId: string) => {
      unwatched.push(watchId);
      return { unwatched: true };
    },
    warmup: async () => handshakeResult,
    watchConfig: async (_runtimeTarget: unknown, target: unknown) => ({
      target,
      watchId: `watch-${++nextWatchId}`,
    }),
  } as unknown as PiRuntimeBroker;
  return {
    broker,
    emit(event: PiRuntimeBrokerEvent) {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
    unwatched,
    setListSessions(next: typeof listSessions) {
      listSessions = next;
    },
  };
};

const createHarness = (options: { maxPendingRequests?: number } = {}) => {
  const fake = createFakeBroker();
  const frames: RuntimeWireEnvelope[] = [];
  const waiters: Array<(frame: RuntimeWireEnvelope) => void> = [];
  const closeReasons: string[] = [];
  const connection = new PiRuntimeSurfaceConnection({
    broker: fake.broker,
    ...(options.maxPendingRequests === undefined
      ? {}
      : { maxPendingRequests: options.maxPendingRequests }),
    onClose: (reason) => closeReasons.push(reason),
    send: (frame) => {
      const envelope = decodeRuntimeEnvelope(frame);
      const waiter = waiters.shift();
      if (waiter) waiter(envelope);
      else frames.push(envelope);
    },
  });
  const next = (): Promise<RuntimeWireEnvelope> => {
    const queued = frames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => waiters.push(resolve));
  };
  const receive = (envelope: RuntimeWireEnvelope) => {
    connection.receive(encodeRuntimeEnvelope(envelope));
  };
  return { ...fake, closeReasons, connection, next, receive };
};

const handshake = async (harness: ReturnType<typeof createHarness>, id = "handshake") => {
  harness.receive(createRuntimeRequest(id, "host.handshake", {
    clientName: "surface-connection-test",
    clientVersion: "0.1.0",
    mode: "test",
    protocolVersions: [VARIN_PROTOCOL_VERSION],
  }));
  return harness.next();
};

test("surface connection gates requests behind a successful handshake", async () => {
  const harness = createHarness();
  try {
    harness.receive(createRuntimeRequest("list-before", "session.list", {}));
    assert.deepEqual(await harness.next(), {
      error: {
        code: "handshake_required",
        message: "Runtime handshake is required before other requests",
        retryable: true,
      },
      id: "list-before",
      kind: "response",
      ok: false,
      v: VARIN_PROTOCOL_VERSION,
    });
    assert.equal((await handshake(harness)).kind, "response");
    assert.equal(harness.connection.handshakeComplete, true);
    harness.receive(createRuntimeRequest("list-after", "session.list", {}));
    assert.deepEqual(await harness.next(), {
      id: "list-after",
      kind: "response",
      ok: true,
      result: [],
      v: VARIN_PROTOCOL_VERSION,
    });
  } finally {
    harness.connection.close();
  }
});

test("surface connection projects routed host events only after handshake", async () => {
  const harness = createHarness();
  try {
    harness.emit({
      envelope: createEvent(1, "session.closed", { sessionId: "session-before" }),
      kind: "host",
      role: "session",
      runtimeGeneration: 1,
      sessionId: "session-before",
      workerId: "worker-before",
    });
    await handshake(harness);
    harness.emit({
      envelope: createEvent(7, "session.closed", { sessionId: "session-1" }),
      executionId: "execution-1",
      kind: "host",
      role: "session",
      runtimeGeneration: 2,
      sessionId: "session-1",
      workerId: "worker-1",
    });
    assert.deepEqual(await harness.next(), {
      data: { sessionId: "session-1" },
      event: "session.closed",
      kind: "event",
      seq: 7,
      surfaceSeq: 0,
      source: {
        executionId: "execution-1",
        role: "session",
        runtimeGeneration: 2,
        sessionId: "session-1",
        workerId: "worker-1",
      },
      v: VARIN_PROTOCOL_VERSION,
    });
  } finally {
    harness.connection.close();
  }
});

test("surface connection forwards compaction progress without treating the worker as a session", async () => {
  const harness = createHarness();
  try {
    await handshake(harness);
    harness.emit({
      envelope: createEvent(3, "compaction.trace", {
        sessionId: "session-1", taskId: "task-1", type: "delta", channel: "text", delta: "Working",
      }),
      kind: "host",
      role: "compaction",
      runtimeGeneration: 2,
      sessionId: "session-1",
      workerId: "worker-compaction",
    });
    const event = await harness.next();
    assert.equal(event.kind, "event");
    if (event.kind !== "event") assert.fail("expected event");
    assert.equal(event.event, "compaction.trace");
    assert.equal(event.source.role, "compaction");
    assert.deepEqual(event.data, {
      sessionId: "session-1", taskId: "task-1", type: "delta", channel: "text", delta: "Working",
    });
  } finally {
    harness.connection.close();
  }
});

test("surface connection reports a session worker exit to every connected surface", async () => {
  const harness = createHarness();
  try {
    await handshake(harness);
    harness.emit({
      code: 1,
      expected: false,
      kind: "worker.exit",
      role: "session",
      runtimeGeneration: 3,
      sequence: 8,
      sessionId: "session-crashed",
      signal: null,
      workerId: "worker-crashed",
    });
    assert.deepEqual(await harness.next(), {
      data: {
        code: 1,
        expected: false,
        sessionId: "session-crashed",
        signal: null,
      },
      event: "session.worker.exited",
      kind: "event",
      seq: 8,
      surfaceSeq: 0,
      source: {
        role: "session",
        runtimeGeneration: 3,
        sessionId: "session-crashed",
        workerId: "worker-crashed",
      },
      v: VARIN_PROTOCOL_VERSION,
    });
  } finally {
    harness.connection.close();
  }
});

test("surface connection projects and cancels only configuration watches owned by that client", async () => {
  const harness = createHarness();
  try {
    await handshake(harness);
    harness.receive(createRuntimeRequest("watch", "config.watch", {
      cwd: "C:/workspace",
      target: { kind: "document", path: "plugin.json", scope: "global" },
    }));
    const watchResponse = await harness.next();
    assert.equal(watchResponse.kind, "response");
    assert.equal(watchResponse.ok, true);
    if (watchResponse.kind !== "response" || !watchResponse.ok) assert.fail("expected watch response");
    const watchId = (watchResponse.result as { watchId: string }).watchId;

    harness.emit({
      envelope: createEvent(3, "config.changed", {
        reason: "rename",
        target: { kind: "document", path: "plugin.json", scope: "global" },
        watchId: "another-client-watch",
      }),
      kind: "host",
      role: "catalog",
      runtimeGeneration: 4,
      workerId: "catalog-worker",
    });
    harness.emit({
      envelope: createEvent(4, "config.changed", {
        reason: "rename",
        target: { kind: "document", path: "plugin.json", scope: "global" },
        watchId,
      }),
      kind: "host",
      role: "catalog",
      runtimeGeneration: 4,
      workerId: "catalog-worker",
    });
    const changed = await harness.next();
    assert.equal(changed.kind, "event");
    if (changed.kind !== "event") assert.fail("expected config event");
    assert.equal(changed.event, "config.changed");
    assert.equal(changed.surfaceSeq, 0, "an unowned watch must not consume a surface sequence");
    assert.equal((changed.data as { watchId: string }).watchId, watchId);

    harness.receive(createRuntimeRequest("unwatch", "config.unwatch", { watchId }));
    const unwatchResponse = await harness.next();
    assert.equal(unwatchResponse.kind, "response");
    assert.equal(unwatchResponse.ok, true);
    assert.deepEqual(harness.unwatched, [watchId]);

    harness.receive(createRuntimeRequest("watch-close", "config.watch", {
      cwd: "C:/workspace",
      target: { kind: "settings", scope: "global" },
    }));
    const watchOnClose = await harness.next();
    assert.equal(watchOnClose.kind, "response");
    assert.equal(watchOnClose.ok, true);
    if (watchOnClose.kind !== "response" || !watchOnClose.ok) {
      assert.fail("expected second watch response");
    }
    const closeWatchId = (watchOnClose.result as { watchId: string }).watchId;
    harness.connection.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.unwatched, [watchId, closeWatchId]);
  } finally {
    harness.connection.close();
  }
});

test("surface connection enforces an explicit pending-request budget", async () => {
  const harness = createHarness({ maxPendingRequests: 1 });
  let resolveList: ((value: []) => void) | undefined;
  harness.setListSessions(() => new Promise((resolve) => { resolveList = resolve; }));
  try {
    await handshake(harness);
    harness.receive(createRuntimeRequest("list-1", "session.list", {}));
    harness.receive(createRuntimeRequest("list-2", "session.list", {}));
    const limited = await harness.next();
    assert.equal(limited.kind, "response");
    assert.equal(limited.id, "list-2");
    assert.equal(limited.ok, false);
    if (limited.ok) assert.fail("expected a request-budget error");
    assert.equal(limited.error.code, "too_many_requests");
    resolveList?.([]);
    const completed = await harness.next();
    assert.equal(completed.kind, "response");
    assert.equal(completed.id, "list-1");
    assert.equal(completed.ok, true);
  } finally {
    harness.connection.close();
  }
});

test("surface connection closes malformed transport frames without a request id", () => {
  const harness = createHarness();
  harness.connection.receive("not-json");
  assert.equal(harness.connection.closed, true);
  assert.deepEqual(harness.closeReasons, ["invalid runtime frame"]);
  assert.equal(harness.listenerCount(), 0);
});
