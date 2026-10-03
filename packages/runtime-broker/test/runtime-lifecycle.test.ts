import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HostHandshakeResult, SessionSnapshot, SessionSummary } from "@varin/protocol";
import { readPinnedPiVersion, type RuntimeCandidate } from "@varin/pi-host/discovery";
import { PiRuntimeNotReadyError } from "../src/errors.js";
import { dispatchRuntimeRequest } from "../src/runtime-dispatcher.js";
import { PiRuntimeLifecycle, type PiRuntimeLifecycleOptions } from "../src/runtime-lifecycle.js";
import type { PiRuntimeBroker, PiRuntimeBrokerEvent } from "../src/runtime-broker.js";

const SYSTEM_ROOT = "C:\\tools\\node_modules\\@earendil-works\\pi-coding-agent";
const CUSTOM_ROOT = "D:\\other\\pi-coding-agent";
const TARGET_VERSION = readPinnedPiVersion();

const createLifecycle = (options: PiRuntimeLifecycleOptions): PiRuntimeLifecycle => new PiRuntimeLifecycle({
  ...options,
  discovery: { commandRunner: async () => ({ exitCode: 1, stderr: '', stdout: '' }), ...options.discovery },
});

const handshakeFor = (packageRoot: string, source: "system" | "custom"): HostHandshakeResult => ({
  capabilities: {
    agentProviders: true,
    extensionUi: true,
    fleet: true,
    models: true,
    packages: true,
    providerConfiguration: true,
    recovery: true,
    resources: true,
    sessionFeatures: true,
    sessions: true,
    settings: true,
  },
  hostVersion: "0.1.0",
  protocolVersion: 1,
  runtime: {
    agentDir: "C:\\agent",
    nodePath: "C:\\tools\\node.exe",
    nodeVersion: "22.19.0",
    packageRoot,
    piVersion: TARGET_VERSION,
    source,
  },
});

const systemCandidate: RuntimeCandidate = {
  available: true,
  command: "C:\\tools\\pi.cmd",
  compatible: true,
  id: "system",
  nodePath: "C:\\tools\\node.exe",
  packageRoot: SYSTEM_ROOT,
  source: "system",
  version: TARGET_VERSION,
};

const customCandidate: RuntimeCandidate = {
  available: true,
  compatible: true,
  id: "custom:other",
  nodePath: "C:\\tools\\node.exe",
  packageRoot: CUSTOM_ROOT,
  source: "custom",
  version: TARGET_VERSION,
};

const fakeBroker = (
  packageRoot: string,
  activeSessionIds: string[] = [],
  onDispose?: () => void,
): PiRuntimeBroker => ({
  activeSessionIds,
  packageRoot,
  workerCount: activeSessionIds.length + 1,
  subscribe: () => () => {},
  warmup: async () => handshakeFor(packageRoot, packageRoot === CUSTOM_ROOT ? "custom" : "system"),
  dispose: async () => {
    onDispose?.();
  },
} as unknown as PiRuntimeBroker);

const sessionSnapshot = (sessionId: string): SessionSnapshot => ({
  activeTools: [],
  busy: false,
  cwd: "C:\\workspace",
  features: {
    revision: 0,
    schemaVersion: 1,
  },
  followUp: [],
  followUpMode: "all",
  queuedMessages: [],
  isCompacting: false,
  isStreaming: false,
  leafId: null,
  pendingMessageCount: 0,
  retryAttempt: 0,
  sessionFile: `C:\\sessions\\${sessionId}.jsonl`,
  sessionId,
  steering: [],
  steeringMode: "all",
  thinkingLevel: "off",
});

const sessionSummary = (sessionId: string): SessionSummary => ({
  allMessagesText: "",
  createdAt: "2026-08-16T00:00:00.000Z",
  cwd: "C:\\workspace",
  firstMessage: "",
  id: sessionId,
  messageCount: 0,
  persisted: true,
  sessionFile: `C:\\sessions\\${sessionId}.jsonl`,
  updatedAt: "2026-08-16T00:00:00.000Z",
});

const recordingBroker = (
  label: string,
  packageRoot: string,
  activeSessionIds: string[],
  calls: string[],
): { broker: PiRuntimeBroker; emit: (event: PiRuntimeBrokerEvent) => void } => {
  let listener: ((event: PiRuntimeBrokerEvent) => void) | undefined;
  const record = <T>(operation: string, result: T): T => {
    calls.push(`${label}:${operation}`);
    return result;
  };
  const broker = {
    activeSessionIds,
    catalogStarted: true,
    packageRoot,
    workerCount: activeSessionIds.length + 1,
    subscribe(next: (event: PiRuntimeBrokerEvent) => void) {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    warmup: async () => handshakeFor(packageRoot, packageRoot === CUSTOM_ROOT ? "custom" : "system"),
    listSessions: async () => record("list", activeSessionIds.map(sessionSummary)),
    createSession: async () => record("create", sessionSnapshot(`${label}-new`)),
    openSession: async (input: { sessionId?: string }) => record("open", sessionSnapshot(input.sessionId ?? `${label}-opened`)),
    closeSession: async () => record("close", { closed: true }),
    forkSession: async () => record("fork", { snapshot: sessionSnapshot(`${label}-fork`) }),
    renameSession: async (sessionId: string, name: string) => record("rename", { name, sessionId }),
    archiveSession: async (sessionId: string) => record("archive", sessionSummary(sessionId)),
    deleteSession: async (sessionId: string) => record("delete", { deleted: true, sessionId }),
    respondToExtensionUi: async () => record("extension-ui", true),
    respondToProviderAuth: async () => record("provider-auth", true),
    respondToProjectTrust: async () => record("project-trust", true),
    requestForSession: async () => record("request", {}),
    dispose: async () => {},
  } as unknown as PiRuntimeBroker;
  return {
    broker,
    emit: (event) => listener?.(event),
  };
};

test("starts without a broker when Pi is missing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-lifecycle-"));
  try {
    const lifecycle = createLifecycle({
      dataDir,
      createBroker: () => {
        throw new Error("should not create a broker");
      },
      discover: async () => [],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      planInstall: () => ({
        action: "install",
        reason: "missing",
        targetVersion: TARGET_VERSION,
      }),
    });
    const result = await lifecycle.start();
    assert.equal(result, undefined);
    assert.equal(lifecycle.snapshot.status, "missing");
    assert.throws(() => lifecycle.requireBroker(), PiRuntimeNotReadyError);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("starts the real broker once and publishes ready only after its handshake", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-lifecycle-"));
  try {
    const created: string[] = [];
    const lifecycle = createLifecycle({
      dataDir,
      createBroker: (options) => {
        created.push(options.packageRoot ?? "");
        return fakeBroker(options.packageRoot ?? SYSTEM_ROOT);
      },
      discover: async () => [systemCandidate],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      planInstall: () => ({
        action: "none",
        reason: "already installed",
        targetVersion: TARGET_VERSION,
      }),
    });
    const observed: Array<{ revision: number; status: string }> = [];
    lifecycle.subscribe((snapshot) => observed.push({ revision: snapshot.revision, status: snapshot.status }));
    const result = await lifecycle.start();
    assert.equal(result?.runtime.source, "system");
    assert.deepEqual(created, [SYSTEM_ROOT]);
    assert.equal(lifecycle.requireBroker().packageRoot, SYSTEM_ROOT);
    assert.equal(observed.at(-1)?.status, "ready");
    assert.ok(observed.some((snapshot) => snapshot.status === "probing"));
    assert.ok(observed.every((snapshot, index) => index === 0 || snapshot.revision > observed[index - 1]!.revision));
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("reports broker activation failure instead of publishing a false ready state", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-lifecycle-"));
  try {
    let disposed = false;
    const lifecycle = createLifecycle({
      dataDir,
      createBroker: () => ({
        activeSessionIds: [],
        dispose: async () => {
          disposed = true;
        },
        packageRoot: SYSTEM_ROOT,
        subscribe: () => () => {},
        warmup: async () => {
          throw Object.assign(new Error("broker warmup failed"), {
            code: "host-entry-unavailable",
          });
        },
        workerCount: 0,
      } as unknown as PiRuntimeBroker),
      discover: async () => [systemCandidate],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      planInstall: () => ({
        action: "none",
        reason: "already installed",
        targetVersion: TARGET_VERSION,
      }),
    });
    assert.equal(await lifecycle.start(), undefined);
    assert.equal(disposed, true);
    assert.equal(lifecycle.snapshot.status, "failed");
    assert.match(lifecycle.snapshot.issue ?? "", /broker warmup failed/);
    assert.equal(lifecycle.snapshot.issueCode, "host-entry-unavailable");
    assert.throws(() => lifecycle.requireBroker(), PiRuntimeNotReadyError);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("keeps the previous broker generation after activating another install", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-lifecycle-"));
  try {
    const first = fakeBroker(SYSTEM_ROOT, ["session-old"]);
    const second = fakeBroker(CUSTOM_ROOT);
    const created: PiRuntimeBroker[] = [];
    const lifecycle = createLifecycle({
      dataDir,
      createBroker: (options) => {
        const broker = options.packageRoot === CUSTOM_ROOT ? second : first;
        created.push(broker);
        return broker;
      },
      discover: async () => [systemCandidate, customCandidate],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      planInstall: () => ({
        action: "none",
        reason: "already installed",
        targetVersion: TARGET_VERSION,
      }),
    });
    await lifecycle.start();
    await lifecycle.activate("custom:other");
    assert.equal(lifecycle.brokerForSession("session-old"), first);
    assert.equal(lifecycle.requireBroker(), second);
    assert.equal(created.length, 2);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("routes old-session and worker operations to their owning generation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-lifecycle-"));
  try {
    const calls: string[] = [];
    const first = recordingBroker("old", SYSTEM_ROOT, ["session-old"], calls);
    const second = recordingBroker("current", CUSTOM_ROOT, [], calls);
    const lifecycle = createLifecycle({
      dataDir,
      createBroker: (options) => options.packageRoot === CUSTOM_ROOT ? second.broker : first.broker,
      discover: async () => [systemCandidate, customCandidate],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      planInstall: () => ({
        action: "none",
        reason: "already installed",
        targetVersion: TARGET_VERSION,
      }),
    });
    await lifecycle.start();
    first.emit({
      envelope: {} as never,
      kind: "host",
      role: "session",
      runtimeGeneration: 1,
      sessionId: "session-old",
      workerId: "worker-old",
    });
    await lifecycle.activate("custom:other");

    const facade = lifecycle.asBroker();
    assert.equal(facade.catalogStarted, true);
    await dispatchRuntimeRequest(facade, "session.open", { sessionId: "session-old" });
    await dispatchRuntimeRequest(facade, "session.rename", { name: "Renamed", sessionId: "session-old" });
    await dispatchRuntimeRequest(facade, "session.archive", { sessionId: "session-old" });
    await dispatchRuntimeRequest(facade, "session.fork", { entryId: "entry-1", sessionId: "session-old" });
    await dispatchRuntimeRequest(facade, "provider.auth.respond", {
      response: { requestId: "auth-1", value: "secret" },
      sessionId: "session-old",
    });
    await dispatchRuntimeRequest(facade, "extension.ui.respond", {
      response: { requestId: "ui-1", value: true },
      sessionId: "session-old",
    });
    await dispatchRuntimeRequest(facade, "project.trust.respond", {
      remember: false,
      requestId: "trust-1",
      trusted: true,
      workerId: "worker-old",
    });
    await dispatchRuntimeRequest(facade, "session.close", { sessionId: "session-old" });
    const summaries = await facade.listSessions();

    assert.deepEqual(calls, [
      "old:open",
      "old:rename",
      "old:archive",
      "old:fork",
      "old:provider-auth",
      "old:extension-ui",
      "old:project-trust",
      "old:close",
      "old:list",
      "current:list",
    ]);
    assert.deepEqual(summaries.map((summary) => summary.id), ["session-old"]);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("stops workers that use the global install before upgrading", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "varin-lifecycle-"));
  try {
    let disposed = false;
    const lifecycle = createLifecycle({
      dataDir,
      createBroker: (options) => fakeBroker(options.packageRoot ?? SYSTEM_ROOT, ["session-old"], () => {
        disposed = true;
      }),
      discover: async () => [systemCandidate],
      hostEntry: join(dataDir, "host-bootstrap.js"),
      installer: {
        runCommand: async () => {
          assert.equal(disposed, true);
          return { exitCode: 0, stderr: "", stdout: "upgraded" };
        },
      },
      planInstall: () => ({
        action: "upgrade",
        args: ["install", "-g", `@earendil-works/pi-coding-agent@${TARGET_VERSION}`],
        currentVersion: "0.80.0",
        executable: "npm.cmd",
        manager: "npm",
        reason: "upgrade",
        targetVersion: TARGET_VERSION,
      }),
    });
    await lifecycle.start();
    assert.equal(disposed, false);
    await lifecycle.upgrade();
    assert.equal(disposed, true);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
