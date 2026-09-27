import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PiRuntimeBroker } from "../src/runtime-broker.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/src/main.ts");
const delay = (milliseconds: number) => new Promise((resolveDelay) => {
  setTimeout(resolveDelay, milliseconds);
});

interface CwdRecord {
  factoryCwd: string;
  label: string;
  pid: number;
}

async function installCwdExtension(workspace: string, label: string, logFile: string): Promise<void> {
  const extensionDir = join(workspace, ".pi", "extensions");
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, "factory-cwd.ts"),
    `import { appendFileSync } from "node:fs";
    export default function extension(pi: any) {
      const record = { factoryCwd: process.cwd(), label: ${JSON.stringify(label)}, pid: process.pid };
      appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(record) + "\\n", "utf8");
      pi.registerCommand("record-factory-cwd", {
        description: "Record the extension factory cwd",
        handler: async () => pi.appendEntry("varin.test.factory-cwd", record),
      });
    }\n`,
    "utf8",
  );
}

async function readCwdRecords(logFile: string): Promise<CwdRecord[]> {
  let content: string;
  try {
    content = await readFile(logFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CwdRecord);
}

function createBroker(options: {
  agentDir: string;
  catalogCwd: string;
}): PiRuntimeBroker {
  return new PiRuntimeBroker({
    agentDir: options.agentDir,
    client: {
      clientName: "session-worker-cwd-test",
      clientVersion: "0.1.0",
      mode: "test",
    },
    cwd: options.catalogCwd,
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
  });
}

async function writeSessionHeader(
  sessionFile: string,
  input: { cwd: string; sessionId: string },
): Promise<void> {
  await writeFile(
    sessionFile,
    `${JSON.stringify({
      cwd: input.cwd,
      id: input.sessionId,
      timestamp: "2026-08-19T00:00:00.000Z",
      type: "session",
      version: 3,
    })}\n`,
    "utf8",
  );
}

test("catalog, workspace, and session workers keep independent cwd ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-worker-cwd-create-"));
  const agentDir = join(root, "agent");
  const catalogCwd = join(root, "catalog");
  const workspaceA = join(root, "workspace-a");
  const workspaceB = join(root, "workspace-b");
  const logFile = join(root, "factory-cwd.jsonl");
  await mkdir(catalogCwd, { recursive: true });
  await installCwdExtension(workspaceA, "a", logFile);
  await installCwdExtension(workspaceB, "b", logFile);
  const broker = createBroker({ agentDir, catalogCwd });

  try {
    await broker.warmup();
    assert.equal(broker.workerCount, 1);
    assert.ok((await broker.listCommandsForWorkspace(workspaceA)).some(
      (command) => command.name === "record-factory-cwd",
    ));
    assert.ok((await broker.listCommandsForWorkspace(workspaceB)).some(
      (command) => command.name === "record-factory-cwd",
    ));
    assert.equal(broker.workerCount, 3, "catalog and both workspace owners remain isolated");
    const workspaceRecords = await readCwdRecords(logFile);
    assert.ok(workspaceRecords.some(
      (record) => record.label === "a" && record.factoryCwd === resolve(workspaceA),
    ));
    assert.ok(workspaceRecords.some(
      (record) => record.label === "b" && record.factoryCwd === resolve(workspaceB),
    ));
    assert.equal(
      workspaceRecords.some((record) => record.factoryCwd === resolve(catalogCwd)),
      false,
    );

    await writeFile(logFile, "", "utf8");
    const createdA = await broker.createSession(workspaceA);
    const createdB = await broker.createSession(workspaceB);
    assert.equal(createdA.cwd, resolve(workspaceA));
    assert.equal(createdB.cwd, resolve(workspaceB));
    assert.equal(broker.workerCount, 5);
    assert.ok(createdA.sessionFile);
    await broker.openSession({ sessionFile: createdA.sessionFile, sessionId: createdA.sessionId });
    assert.equal(broker.workerCount, 5, "reopening an active session reuses its worker");

    const sessionRecords = await readCwdRecords(logFile);
    assert.ok(sessionRecords.some(
      (record) => record.label === "a" && record.factoryCwd === resolve(workspaceA),
    ));
    assert.ok(sessionRecords.some(
      (record) => record.label === "b" && record.factoryCwd === resolve(workspaceB),
    ));
    assert.equal(
      sessionRecords.some((record) => record.factoryCwd === resolve(catalogCwd)),
      false,
    );
  } finally {
    await broker.dispose();
    assert.equal(broker.workerCount, 0);
    await rm(root, { force: true, recursive: true });
  }
});

test("session.open resolves every cwd source before starting the session worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-worker-cwd-open-"));
  const agentDir = join(root, "agent");
  const catalogCwd = join(root, "catalog");
  const headerCwd = join(root, "header-cwd");
  const resolvedCwd = join(root, "resolved-cwd");
  const explicitCwd = join(root, "explicit-cwd");
  const staleCwd = join(root, "stale-cwd");
  const authoritativeCwd = join(root, "authoritative-cwd");
  const logFile = join(root, "factory-cwd.jsonl");
  await mkdir(catalogCwd, { recursive: true });
  await installCwdExtension(headerCwd, "header", logFile);
  await installCwdExtension(resolvedCwd, "resolved", logFile);
  await installCwdExtension(explicitCwd, "explicit", logFile);
  await installCwdExtension(staleCwd, "stale", logFile);
  await installCwdExtension(authoritativeCwd, "authoritative", logFile);
  const broker = createBroker({ agentDir, catalogCwd });

  try {
    const known = await broker.createSession(headerCwd, "Known cwd session");
    assert.ok(known.sessionFile);
    await writeSessionHeader(known.sessionFile, {
      cwd: headerCwd,
      sessionId: known.sessionId,
    });
    await broker.closeSession(known.sessionId);
    await writeFile(logFile, "", "utf8");
    const openedKnown = await broker.openSession({ sessionId: known.sessionId });
    assert.equal(openedKnown.cwd, resolve(headerCwd));
    const knownRecords = await readCwdRecords(logFile);
    assert.ok(knownRecords.length > 0);
    assert.ok(knownRecords.every(
      (record) => record.factoryCwd === resolve(headerCwd),
    ));
    await broker.closeSession(openedKnown.sessionId);

    const externalSessionFile = join(catalogCwd, "external-session.jsonl");
    await writeSessionHeader(externalSessionFile, {
      cwd: resolvedCwd,
      sessionId: "external-session",
    });
    await writeFile(logFile, "", "utf8");
    const openedResolved = await broker.openSession({
      sessionFile: "external-session.jsonl",
      sessionId: "conflicting-session-id",
    });
    assert.equal(openedResolved.cwd, resolve(resolvedCwd));
    assert.equal(openedResolved.sessionId, "external-session");
    const resolvedRecords = await readCwdRecords(logFile);
    assert.ok(resolvedRecords.length > 0);
    assert.ok(resolvedRecords.every(
      (record) => record.factoryCwd === resolve(resolvedCwd),
    ));
    await broker.closeSession(openedResolved.sessionId);

    const explicitSessionFile = join(root, "explicit-session.jsonl");
    await writeSessionHeader(explicitSessionFile, {
      cwd: headerCwd,
      sessionId: "explicit-session",
    });
    await writeFile(logFile, "", "utf8");
    const openedExplicit = await broker.openSession({
      cwd: explicitCwd,
      sessionFile: explicitSessionFile,
    });
    assert.equal(openedExplicit.cwd, resolve(explicitCwd));
    const explicitRecords = await readCwdRecords(logFile);
    assert.ok(explicitRecords.length > 0);
    assert.ok(explicitRecords.every(
      (record) => record.factoryCwd === resolve(explicitCwd),
    ));
    await broker.closeSession(openedExplicit.sessionId);

    const relativeCwd = join(catalogCwd, "relative-project");
    await installCwdExtension(relativeCwd, "relative", logFile);
    const relativeSessionFile = join(catalogCwd, "relative-session.jsonl");
    await writeSessionHeader(relativeSessionFile, {
      cwd: "relative-project",
      sessionId: "relative-session",
    });
    await writeFile(logFile, "", "utf8");
    const openedRelative = await broker.openSession({ sessionFile: relativeSessionFile });
    assert.equal(openedRelative.cwd, resolve(relativeCwd));
    const relativeRecords = await readCwdRecords(logFile);
    assert.ok(relativeRecords.length > 0);
    assert.ok(relativeRecords.every(
      (record) => record.factoryCwd === resolve(relativeCwd),
    ));
    await broker.closeSession(openedRelative.sessionId);

    const stale = await broker.createSession(staleCwd, "Stale cwd session");
    assert.ok(stale.sessionFile);
    await writeSessionHeader(stale.sessionFile, {
      cwd: staleCwd,
      sessionId: stale.sessionId,
    });
    await broker.closeSession(stale.sessionId);
    const staleContent = await readFile(stale.sessionFile, "utf8");
    const [headerLine, ...remainingLines] = staleContent.split("\n");
    assert.ok(headerLine);
    const staleHeader = JSON.parse(headerLine) as Record<string, unknown>;
    staleHeader.cwd = authoritativeCwd;
    await writeFile(
      stale.sessionFile,
      [JSON.stringify(staleHeader), ...remainingLines].join("\n"),
      "utf8",
    );
    await rm(staleCwd, { force: true, recursive: true });
    await writeFile(logFile, "", "utf8");
    const reopenedStale = await broker.openSession({ sessionId: stale.sessionId });
    assert.equal(reopenedStale.cwd, resolve(authoritativeCwd));
    assert.deepEqual(broker.activeSessionIds, [stale.sessionId]);
    assert.equal(broker.workerCount, 2, "only catalog and the header-resolved session worker remain");
    const staleRecords = await readCwdRecords(logFile);
    assert.ok(staleRecords.length > 0);
    assert.ok(staleRecords.every(
      (record) => record.label === "authoritative"
        && record.factoryCwd === resolve(authoritativeCwd),
    ));
  } finally {
    await broker.dispose();
    assert.equal(broker.workerCount, 0);
    await rm(root, { force: true, recursive: true });
  }
});

test("a missing child cwd leaves no failed session worker behind", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-worker-cwd-missing-"));
  const catalogCwd = join(root, "catalog");
  const missingCwd = join(root, "missing");
  await mkdir(catalogCwd, { recursive: true });
  const broker = createBroker({ agentDir: join(root, "agent"), catalogCwd });
  try {
    await assert.rejects(broker.createSession(missingCwd));
    assert.equal(broker.workerCount, 0);
    assert.deepEqual(broker.activeSessionIds, []);
  } finally {
    await broker.dispose();
    await rm(root, { force: true, recursive: true });
  }
});

test("an existing session opens when its historical cwd is offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-worker-cwd-offline-"));
  const catalogCwd = join(root, "catalog");
  const sessionCwd = join(root, "removed-project");
  await Promise.all([mkdir(catalogCwd), mkdir(sessionCwd)]);
  const broker = createBroker({ agentDir: join(root, "agent"), catalogCwd });
  try {
    const created = await broker.createSession(sessionCwd);
    assert.ok(created.sessionFile);
    await writeSessionHeader(created.sessionFile, { cwd: sessionCwd, sessionId: created.sessionId });
    await broker.closeSession(created.sessionId);
    await rm(sessionCwd, { recursive: true, force: true });

    const reopened = await broker.openSession({ sessionFile: created.sessionFile });
    assert.equal(reopened.cwd, resolve(sessionCwd));
    assert.deepEqual(broker.activeSessionIds, [created.sessionId]);
    const snapshot = await broker.requestForSession(created.sessionId, "session.snapshot", { sessionId: created.sessionId });
    assert.equal(snapshot.cwd, resolve(sessionCwd));
    await assert.rejects(access(sessionCwd), { code: "ENOENT" });
  } finally {
    await broker.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("a blocked workspace extension cannot stall the catalog or another workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-workspace-isolation-"));
  const agentDir = join(root, "agent");
  const catalogCwd = join(root, "catalog");
  const blockedWorkspace = join(root, "blocked");
  const healthyWorkspace = join(root, "healthy");
  await Promise.all([
    mkdir(agentDir, { recursive: true }),
    mkdir(catalogCwd, { recursive: true }),
    mkdir(join(blockedWorkspace, ".pi", "extensions"), { recursive: true }),
    mkdir(join(healthyWorkspace, ".pi", "extensions"), { recursive: true }),
  ]);
  await writeFile(
    join(blockedWorkspace, ".pi", "extensions", "blocked.ts"),
    "await new Promise<void>(() => {});\nexport default function () {}\n",
    "utf8",
  );
  await writeFile(
    join(healthyWorkspace, ".pi", "extensions", "healthy.ts"),
    "export default function (pi: any) { pi.registerCommand('healthy', { description: 'healthy', handler() {} }); }\n",
    "utf8",
  );
  const broker = new PiRuntimeBroker({
    agentDir,
    client: { clientName: "workspace-isolation-test", clientVersion: "0.1.0", mode: "test" },
    cwd: catalogCwd,
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
    projectTrustOverride: true,
    shutdownTimeoutMs: 100,
  });
  let blocked: Promise<unknown> | undefined;
  try {
    await broker.warmup();
    blocked = broker.listCommandsForWorkspace(blockedWorkspace);
    await delay(50);
    assert.deepEqual(
      await Promise.race([
        broker.listSessions(),
        delay(5_000).then(() => { throw new Error("session catalog was blocked"); }),
      ]),
      [],
    );
    const commands = await Promise.race([
      broker.listCommandsForWorkspace(healthyWorkspace),
      delay(5_000).then(() => { throw new Error("healthy workspace was blocked"); }),
    ]);
    assert.ok(commands.some((command) => command.name === "healthy"));
  } finally {
    await broker.dispose();
    await blocked?.catch(() => undefined);
    await rm(root, { force: true, recursive: true });
  }
});
