import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { PiRuntimeBroker, type PiRuntimeBrokerEvent } from "../src/index.js";

const HOST_ENTRY = resolve(import.meta.dirname, "../../pi-host/src/main.ts");

test("reopening a desktop session revalidates work context only after worker identity is pinned", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-work-context-open-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  const sessionFile = join(sessionDir, "session.jsonl");
  const sessionId = "work-context-open-session";
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(sessionFile, `${JSON.stringify({
    type: "session", version: 3, id: sessionId, cwd, timestamp: "2026-09-27T00:00:00.000Z",
  })}\n`);
  const events: PiRuntimeBrokerEvent[] = [];
  const responses: Promise<unknown>[] = [];
  let registrationReadCompleted = false;
  const broker = new PiRuntimeBroker({
    agentDir,
    authorityInstanceId: "work-context-open-test",
    client: {
      clientName: "work-context-open-test",
      clientVersion: "0.1.0",
      mode: "test",
      capabilities: { harnessWorkContext: true },
    },
    emit: (event) => {
      events.push(event);
      if (event.kind !== "host" || event.envelope.event !== "harness.request") return;
      const request = event.envelope.data;
      if (request.method !== "context.get") return;
      assert.equal(event.sessionId === undefined, false);
      responses.push((async () => {
        // Production registration reads settings and the branch journal before
        // admitting context.get. Both requests must run while sync is pending.
        await broker.requestForSession(event.sessionId!, "settings.get", {});
        await broker.requestForSession(event.sessionId!, "session.workContext.read", { sessionId: event.sessionId! });
        registrationReadCompleted = true;
        return broker.requestForWorker(event.workerId, "harness.respond", {
          sessionId: event.sessionId!,
          requestId: request.requestId,
          ok: true,
          result: { context: { operationDir: "", queryScope: null, revision: 3 }, workspaceRoot: cwd },
        });
      })());
    },
    execArgv: ["--import", import.meta.resolve("tsx")],
    hostEntry: HOST_ENTRY,
  });
  try {
    const workspace = { id: "workspace-a", kind: "workspace" as const };
    const opened = await broker.openSession({ cwd, sessionFile, workspace });
    await Promise.all(responses);
    assert.equal(registrationReadCompleted, true);
    assert.equal(opened.workContext?.revision, 3);
    assert.equal(opened.workContext?.operationDir, "");
    assert.equal(events.filter((event) => event.kind === "host" && event.envelope.event === "harness.request").length, 1);
    assert.equal(events.some((event) => event.kind === "diagnostic" && event.message.includes("protocol violation")), false);
  } finally {
    await broker.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
