import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  PiRuntimeBroker,
  PiRuntimeBrokerError,
  type PiSessionExecutionAdmissionRequest,
} from "../src/index.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/src/main.ts");

test("session execution admission precedes worker and agent execution and owns cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-session-admission-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const startupMarker = join(root, "worker-started.txt");
  const commandMarker = join(root, "command-executed.txt");
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(workspace, ".pi", "extensions", "admission.ts"),
    `import { appendFileSync } from "node:fs";
    export default function extension(pi: any) {
      appendFileSync(${JSON.stringify(startupMarker)}, "started\\n", "utf8");
      pi.registerCommand("admission-write", {
        description: "Write only while the broker admission is active",
        handler: async () => {
          appendFileSync(${JSON.stringify(commandMarker)}, "began\\n", "utf8");
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
          appendFileSync(${JSON.stringify(commandMarker)}, "executed\\n", "utf8");
        },
      });
    }\n`,
    "utf8",
  );

  let deny = true;
  let botSleeping = false;
  let throwOnClose = false;
  let activeLeases = 0;
  const admissions: PiSessionExecutionAdmissionRequest[] = [];
  const broker = new PiRuntimeBroker({
    agentDir,
    client: {
      clientName: "session-admission-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
  });
  broker.setSessionExecutionAdmission(async (request) => {
    admissions.push(request);
    if (deny) {
      throw new PiRuntimeBrokerError("maintenance", "Workspace is in maintenance mode", {
        retryable: true,
      });
    }
    activeLeases += 1;
    let closed = false;
    return {
      async assertCanExecute() {
        if (botSleeping) throw new Error('Bot sleeping');
      },
      close() {
        if (closed) return;
        closed = true;
        activeLeases -= 1;
        if (throwOnClose) throw new Error("lease close failed");
      },
    };
  });
  try {
    await assert.rejects(
      broker.createSession(workspace),
      (error: unknown) => error instanceof PiRuntimeBrokerError && error.code === "maintenance",
    );
    await assert.rejects(access(startupMarker), (error: unknown) => (
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ));
    assert.equal(broker.workerCount, 0);
    assert.equal(activeLeases, 0);
    assert.equal(admissions[0]?.phase, "worker-start");
    assert.equal(admissions[0]?.runtimeGeneration, 1);
    assert.equal(typeof admissions[0]?.executionId, "string");

    deny = false;
    const workspaceBinding = {
      authorityId: "workspace-authority",
      id: "workspace-project",
      kind: "workspace" as const,
    };
    const created = await broker.createSession(workspace, undefined, undefined, workspaceBinding);
    await broker.requestForSession(created.sessionId, "command.execute", {
      command: "/admission-write",
      sessionId: created.sessionId,
    });
    assert.equal(broker.workerCount, 1);
    assert.equal(activeLeases, 0, "worker startup admission must close after create settles");
    assert.deepEqual(admissions.slice(-2).map((request) => request.phase), [
      "worker-start",
      "agent-run",
    ]);
    assert.equal(admissions.at(-1)?.sessionId, created.sessionId);

    const before = await readFile(commandMarker, 'utf8');
    const runningCommand = broker.requestForSession(created.sessionId, 'command.execute', {
      command: '/admission-write', sessionId: created.sessionId,
    });
    while ((await readFile(commandMarker, 'utf8')).length === before.length) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    botSleeping = true;
    await assert.rejects(broker.requestForSession(created.sessionId, 'command.execute', {
      command: '/admission-write', sessionId: created.sessionId,
    }), /Bot sleeping/);
    assert.equal(activeLeases, 1, 'rejecting a cached admission must not release the running command lease');
    await runningCommand;
    botSleeping = false;
    assert.equal((await readFile(commandMarker, 'utf8')).slice(before.length), 'began\nexecuted\n');

    const invalidCommand = broker.requestForSession(created.sessionId, "command.execute", {
      command: "not-a-command",
      sessionId: created.sessionId,
    });
    const validCommand = broker.requestForSession(created.sessionId, "command.execute", {
      command: "/admission-write",
      sessionId: created.sessionId,
    });
    await assert.rejects(
      invalidCommand,
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "invalid_command"
      ),
    );
    assert.equal(activeLeases, 1, "a sibling request failure must not release the active writer");
    await validCommand;
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    assert.match(await readFile(commandMarker, "utf8"), /executed/);
    assert.equal(activeLeases, 0, "agent request settlement must close its admission");
    assert.equal(admissions.at(-1)?.phase, "agent-run");
    assert.equal(admissions.at(-1)?.method, "command.execute");
    assert.equal(admissions.at(-1)?.sessionId, created.sessionId);
    assert.deepEqual(admissions.at(-1)?.workspace, workspaceBinding);

    deny = true;
    await assert.rejects(
      broker.requestForSession(created.sessionId, "recovery.checkpoint.create", {
        name: "blocked-during-maintenance",
        sessionId: created.sessionId,
      }),
      (error: unknown) => error instanceof PiRuntimeBrokerError && error.code === "maintenance",
    );
    assert.equal(admissions.at(-1)?.phase, "workspace-mutation");
    assert.equal(admissions.at(-1)?.method, "recovery.checkpoint.create");
    deny = false;

    throwOnClose = true;
    await assert.rejects(
      broker.requestForSession(created.sessionId, "command.execute", {
        command: "still-not-a-command",
        sessionId: created.sessionId,
      }),
      (error: unknown) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "invalid_command"
      ),
      "lease cleanup failure must not replace the typed host failure",
    );
    throwOnClose = false;
    assert.equal(activeLeases, 0);

    let coordinatedCodeRuns = 0;
    broker.setSessionRunCoordinator(async () => { coordinatedCodeRuns += 1; }, {
      appliesToWorkFocus: ["research"],
    });
    const submitted = await broker.requestForSession(created.sessionId, "agent.prompt", {
      sessionId: created.sessionId,
      text: "/admission-write",
    });
    assert.equal(submitted.accepted, true);
    assert.equal(coordinatedCodeRuns, 0,
      "an already selected code focus does not need research workspace preparation");

    await broker.closeSession(created.sessionId);
    assert.equal(activeLeases, 0);
  } finally {
    await broker.dispose();
    assert.equal(activeLeases, 0);
    await rm(root, { force: true, recursive: true });
  }
});

test("workspace worker startup and project configuration writes are admitted before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-workspace-admission-"));
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const startupMarker = join(root, "workspace-worker-started.txt");
  const projectSettings = join(workspace, ".pi", "wtf.json");
  await mkdir(join(workspace, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(workspace, ".pi", "extensions", "workspace-admission.ts"),
    `import { appendFileSync } from "node:fs";
    export default function extension() {
      appendFileSync(${JSON.stringify(startupMarker)}, "started\n", "utf8");
    }\n`,
    "utf8",
  );

  let deny = true;
  let activeLeases = 0;
  const admissions: PiSessionExecutionAdmissionRequest[] = [];
  const broker = new PiRuntimeBroker({
    admitSessionExecution: async (request) => {
      admissions.push(request);
      if (deny) {
        throw new PiRuntimeBrokerError("maintenance", "Workspace is in maintenance mode", {
          retryable: true,
        });
      }
      activeLeases += 1;
      let closed = false;
      return {
        close() {
          if (closed) return;
          closed = true;
          activeLeases -= 1;
        },
      };
    },
    agentDir,
    client: {
      clientName: "workspace-admission-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
  });

  try {
    await assert.rejects(
      broker.requestForWorkspace(workspace, "model.list", {}),
      (error: unknown) => error instanceof PiRuntimeBrokerError && error.code === "maintenance",
    );
    await assert.rejects(access(startupMarker), (error: unknown) => (
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ));
    assert.equal(broker.workerCount, 0);
    assert.equal(admissions.at(-1)?.phase, "worker-start");

    deny = false;
    const snapshot = await broker.requestForWorkspace(workspace, "config.document.get", {
      path: "wtf.json",
      scope: "project",
    });
    assert.equal(broker.workerCount, 1);
    assert.equal(activeLeases, 0);

    deny = true;
    await assert.rejects(
      broker.requestForWorkspace(workspace, "config.document.update", {
        expectedRevision: snapshot.revision,
        path: "wtf.json",
        remove: [],
        scope: "project",
        set: { fenced: true },
      }),
      (error: unknown) => error instanceof PiRuntimeBrokerError && error.code === "maintenance",
    );
    assert.equal(admissions.at(-1)?.phase, "workspace-mutation");
    assert.equal(admissions.at(-1)?.method, "config.document.update");
    await assert.rejects(access(projectSettings), (error: unknown) => (
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ));
    assert.equal(activeLeases, 0);
  } finally {
    await broker.dispose();
    assert.equal(activeLeases, 0);
    await rm(root, { force: true, recursive: true });
  }
});

test("pending session admission is released exactly once when the broker is disposed", async () => {
  let closeCount = 0;
  let resolveAdmission!: (lease: { close(): void }) => void;
  let signalAdmissionStarted!: () => void;
  const admissionStarted = new Promise<void>((resolveStarted) => {
    signalAdmissionStarted = resolveStarted;
  });
  const broker = new PiRuntimeBroker({
    client: {
      clientName: "session-admission-dispose-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
  });
  broker.setSessionExecutionAdmission(() => {
    signalAdmissionStarted();
    return new Promise((resolveLease) => {
      resolveAdmission = resolveLease;
    });
  });

  const creating = broker.createSession(process.cwd());
  await admissionStarted;
  const disposing = broker.dispose();
  resolveAdmission({ close: () => { closeCount += 1; } });

  await assert.rejects(creating, /disposed/);
  await disposing;
  assert.equal(closeCount, 1);
  assert.equal(broker.workerCount, 0);
});
