import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it as vitestIt } from "vitest";
import { createKernelClient, type KernelClient } from "../kernel/kernel-client.js";
import { createExperimentService, type ExperimentCaller } from "./experiments.js";
import type { ExperimentBackend } from "./experiment-backend.js";
import { createResourceService } from "./resources.js";
import { createSourceService } from "./sources.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const kernelPath = process.env.VARIN_TEST_KERNEL_PATH
  ?? path.join(repositoryRoot, "kernel/target/release", process.platform === "win32" ? "varin-kernel.exe" : "varin-kernel");
const buildVersion = JSON.parse(await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8")).version as string;
const available = await fs.stat(kernelPath).then(() => true).catch(() => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === "1") {
  throw new Error("Experiment acceptance requires the release kernel");
}
const it = vitestIt.skipIf(!available);

const clients: KernelClient[] = [];
const roots: string[] = [];
const pause = (ms = 25) => new Promise<void>((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "varin-experiment-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const storageRoot = path.join(root, "storage");
  const client = createKernelClient({
    hostId: "experiment-test", storageRoot, kernelPath, buildVersion, allowCargoDevRunner: false,
  });
  clients.push(client);
  await client.start();
  const errors: Error[] = [];
  const onError = (error: Error) => errors.push(error);
  const resources = createResourceService({ client, onError });
  const sources = createSourceService({ client });
  const experiments = createExperimentService({
    client,
    resources,
    sources,
    resolveWorkspaceRoot: async () => workspace,
    onError,
  });
  const caller: ExperimentCaller = {
    workspaceId: "ws",
    executionWorkspaceId: "ws",
    sessionId: "s-1",
    rootSessionId: "s-1",
    threadId: "t-1",
    runId: "r-1",
    workspaceScope: [],
  };
  return { root, workspace, client, resources, sources, experiments, caller, errors };
}

const node = (...script: string[]) => ({
  command: process.execPath,
  args: ["-e", script.join(";")],
  env: { ELECTRON_RUN_AS_NODE: "1" },
});

async function serviceWithBackend(
  f: Awaited<ReturnType<typeof fixture>>,
  machineId: string,
  backend: ExperimentBackend,
) {
  await f.resources.registerMachine(f.caller.workspaceId, {
    machineId,
    kind: "cluster",
    label: machineId,
    backend: backend.backend,
    state: "available",
    connection: { status: "connected" },
    capacity: { cpuCores: 64 },
  });
  return createExperimentService({
    client: f.client,
    resources: f.resources,
    sources: f.sources,
    resolveWorkspaceRoot: async () => f.workspace,
    resolveBackend: async (_ctx, target) => target === machineId
      ? {
          backend,
          site: {
            workspaceId: f.caller.workspaceId,
            rootId: `${machineId}-root`,
            canonicalRoot: f.workspace,
            transport: null,
          },
          prepare: async ({ input }) => ({
            site: {
              workspaceId: f.caller.workspaceId,
              rootId: `${machineId}-root`,
              canonicalRoot: f.workspace,
              transport: null,
            },
            cwd: input.cwd ?? "",
            inputRoot: input.root,
          }),
        }
      : null,
    onError: (error) => f.errors.push(error),
  });
}

describe("experiment service on the real kernel", () => {
  it("runs a local attempt to completion, collects streams and output files, and dedupes the request", async () => {
    const f = await fixture();
    const spec = node(
      "require('node:fs').writeFileSync('result.txt','answer=42')",
      "process.stdout.write('stdout-marker')",
      "process.stderr.write('stderr-marker')",
    );
    const submitted = await f.experiments.submit(f.caller, {
      requestId: "req-complete-1",
      title: "quick check",
      ...spec,
      outputPaths: ["result.txt"],
    });
    assert.equal(submitted.spec.state, "active");
    assert.match(submitted.attempt.attemptId, /^attempt-[a-f0-9]{40}$/);

    // A retry with the same requestId returns the recorded attempt — no second job.
    const retry = await f.experiments.submit(f.caller, { requestId: "req-complete-1", ...spec, outputPaths: ["result.txt"] });
    assert.equal(retry.attempt.attemptId, submitted.attempt.attemptId);

    const waited = await f.experiments.wait(f.caller, submitted.attempt.attemptId, 30_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.attempt.state, "completed");
    assert.equal(waited.attempt.exitCode, 0);
    const detail = await f.experiments.get(f.caller, submitted.attempt.attemptId);
    assert.equal(waited.attempt.collection, "done", JSON.stringify({ artifacts: detail.artifacts, errors: f.errors.map(String) }));
    assert.equal(detail.job?.backend, "local");
    assert.ok(detail.job?.backendJobId);
    assert.equal(detail.job?.state, "released");
    assert.ok(detail.artifacts.some((a) => a.name === "stdout" && a.state === "available" && a.byteLength));
    assert.ok(detail.artifacts.some((a) => a.name === "result.txt" && a.state === "available" && a.objectHash));
    const resultArtifact = detail.artifacts.find((artifact) => artifact.name === "result.txt")!;
    const download = await f.experiments.readArtifact(f.caller, submitted.attempt.attemptId, resultArtifact.artifactId);
    const downloaded: Buffer[] = [];
    for await (const chunk of download.chunks) downloaded.push(Buffer.from(chunk));
    assert.equal(Buffer.concat(downloaded).toString("utf8"), "answer=42");
    const resultPage = await f.experiments.readArtifactPage(f.caller, {
      attemptId: submitted.attempt.attemptId,
      artifactId: resultArtifact.artifactId,
      maxBytes: 64,
    });
    assert.equal(resultPage.text, "answer=42");

    const out = await f.experiments.logs(f.caller, { attemptId: submitted.attempt.attemptId, stream: "stdout" });
    assert.equal(out.origin, "artifact");
    assert.equal(out.eof, true);
    assert.match(out.text, /stdout-marker/);
    const err = await f.experiments.logs(f.caller, { attemptId: submitted.attempt.attemptId, stream: "stderr" });
    assert.match(err.text, /stderr-marker/);

    // specId reuse launches a second attempt under the same pinned spec.
    const second = await f.experiments.submit(f.caller, { specId: submitted.spec.specId });
    assert.equal(second.attempt.specId, submitted.spec.specId);
    assert.notEqual(second.attempt.attemptId, submitted.attempt.attemptId);
    const secondWait = await f.experiments.wait(f.caller, second.attempt.attemptId, 30_000);
    assert.equal(secondWait.attempt.state, "completed");

    const listed = await f.experiments.list(f.caller, { specId: submitted.spec.specId });
    assert.equal(listed.attempts.length, 2);
    assert.deepEqual(f.errors, []);
  });

  it("cancels a running attempt and keeps the outcome distinct from collection", async () => {
    const f = await fixture();
    const submitted = await f.experiments.submit(f.caller, node("setInterval(()=>{},1000)"));
    const attemptId = submitted.attempt.attemptId;
    const deadline = Date.now() + 15_000;
    let view = submitted.attempt;
    while (view.state !== "running" && Date.now() < deadline) {
      await pause();
      view = (await f.experiments.get(f.caller, attemptId)).attempt;
    }
    assert.equal(view.state, "running");

    const cancelled = await f.experiments.cancel(f.caller, attemptId);
    assert.ok(cancelled.state === "stopping" || cancelled.state === "cancelled");
    const waited = await f.experiments.wait(f.caller, attemptId, 30_000);
    assert.equal(waited.attempt.state, "cancelled");

    // collect stays honest after cancellation — artifacts are still readable.
    const collected = await f.experiments.collect(f.caller, attemptId);
    assert.equal(collected.attempt.state, "cancelled");
    assert.ok(collected.attempt.collection === "done" || collected.attempt.collection === "none");
    assert.deepEqual(f.errors, []);
  });

  it("queues an attempt that exceeds confirmed capacity and releases the commitment when it drains", async () => {
    const f = await fixture();
    const impossible = await f.experiments.submit(f.caller, {
      ...node("process.stdout.write('never')"),
      resources: { cpuCores: 1_000_000 },
    });
    assert.equal(impossible.attempt.state, "queued");
    assert.ok(impossible.attempt.queueReason);

    // The queue is a visible resource fact, separate from confirmed commitments.
    const whileQueued = await f.resources.list(f.caller.workspaceId);
    const queuedMachine = whileQueued.machines.find((machine) => machine.machineId === "local");
    assert.ok(queuedMachine);
    assert.equal(queuedMachine.queued.length, 1);
    assert.equal(queuedMachine.queued[0]!.attemptId, impossible.attempt.attemptId);
    assert.match(queuedMachine.queued[0]!.reason ?? "", /cpuCores|insufficient/i);
    assert.match(whileQueued.text, /1 queued/);

    // Cancelling the queued attempt releases nothing it never held and ends it.
    const cancelled = await f.experiments.cancel(f.caller, impossible.attempt.attemptId);
    assert.equal(cancelled.state, "cancelled");

    const overview = await f.resources.list(f.caller.workspaceId);
    const local = overview.machines.find((machine) => machine.machineId === "local");
    assert.ok(local);
    assert.equal(local.state, "available");
    assert.ok((local.capacity?.cpuCores ?? 0) > 0);
    assert.equal(local.queued.length, 0);
    assert.ok(overview.text.length > 0);
    assert.deepEqual(f.errors, []);
  });

  it("reattaches a running attempt after the supervising service restarts", async () => {
    const f = await fixture();
    // ~1.5s job: persist one output page, then the first service instance and
    // original source directory go away while the independent attempt runs.
    const submitted = await f.experiments.submit(f.caller, node(
      "process.stdout.write('early-page')",
      "setTimeout(()=>{process.stdout.write('late-exit')},1500)",
    ));
    const attemptId = submitted.attempt.attemptId;
    const deadline = Date.now() + 15_000;
    let view = submitted.attempt;
    while (view.state !== "running" && Date.now() < deadline) {
      await pause();
      view = (await f.experiments.get(f.caller, attemptId)).attempt;
    }
    assert.equal(view.state, "running");
    const outputDeadline = Date.now() + 10_000;
    let early = "";
    while (!early.includes("early-page") && Date.now() < outputDeadline) {
      await pause();
      early = (await f.experiments.logs(f.caller, { attemptId })).text;
    }
    assert.match(early, /early-page/);

    // A fresh service instance over the same kernel reconciles the attempt and
    // rebuilds the poller — its wait resolves when the process actually exits.
    f.experiments.detachObservers();
    await fs.rm(f.workspace, { recursive: true, force: true });
    const errors: Error[] = [];
    const restarted = createExperimentService({
      client: f.client,
      resources: f.resources,
      sources: f.sources,
      resolveWorkspaceRoot: async () => f.workspace,
      onError: (error) => errors.push(error),
    });
    const waited = await restarted.wait(f.caller, attemptId, 30_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.attempt.state, "completed");
    const logs = await restarted.logs(f.caller, { attemptId });
    assert.match(logs.text, /early-page/);
    assert.match(logs.text, /late-exit/);
  });

  it("can inspect and stop a materialized local attempt after its original source directory is reclaimed", async () => {
    const f = await fixture();
    const submitted = await f.experiments.submit(f.caller, node("setInterval(()=>{},1000)"));
    const attemptId = submitted.attempt.attemptId;
    const deadline = Date.now() + 15_000;
    let state = submitted.attempt.state;
    while (state !== "running" && Date.now() < deadline) {
      await pause();
      state = (await f.experiments.get(f.caller, attemptId)).attempt.state;
    }
    assert.equal(state, "running");
    f.experiments.detachObservers();
    await fs.rm(f.workspace, { recursive: true, force: true });

    const restarted = createExperimentService({
      client: f.client,
      resources: f.resources,
      sources: f.sources,
      resolveWorkspaceRoot: async () => f.workspace,
      onError: (error) => f.errors.push(error),
    });
    assert.equal((await restarted.get(f.caller, attemptId)).attempt.state, "running");
    const stopping = await restarted.cancel(f.caller, attemptId);
    assert.ok(stopping.state === "stopping" || stopping.state === "cancelled");
    const waited = await restarted.wait(f.caller, attemptId, 15_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.attempt.state, "cancelled");
  });

  it("registers sources, resolves them as inputs, and rejects retired or malformed locators", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.workspace, "data/fixtures"), { recursive: true });
    await fs.writeFile(path.join(f.workspace, "data/fixtures/example.txt"), "fixed input");
    const registered = await f.sources.register(f.caller.workspaceId, {
      kind: "dataset",
      label: "fixtures",
      path: "data/fixtures",
      note: "baseline inputs",
    }, { sessionId: "s-1", threadId: "t-1", runId: "r-1" });
    assert.equal(registered.state, "available");

    const listed = await f.sources.list(f.caller.workspaceId, { kind: "dataset" });
    assert.equal(listed.sources.length, 1);
    assert.equal(listed.sources[0]!.sourceId, registered.sourceId);

    await assert.rejects(
      f.sources.register(f.caller.workspaceId, { kind: "dataset" }, {}),
      /locator|uri|path|objectHash/i,
    );

    // A registered sourceId is a valid experiment input.
    const submitted = await f.experiments.submit(f.caller, {
      ...node("process.stdout.write('with-input')"),
      inputs: [{ sourceId: registered.sourceId, role: "training data" }],
    });
    const waited = await f.experiments.wait(f.caller, submitted.attempt.attemptId, 30_000);
    assert.equal(waited.attempt.state, "completed");
    const detail = await f.experiments.get(f.caller, submitted.attempt.attemptId);
    assert.equal(detail.spec?.inputs[0]?.sourceId, registered.sourceId);

    // A bogus object hash is rejected at submit, not at run time.
    await assert.rejects(
      f.experiments.submit(f.caller, { ...node("process.stdout.write('x')"), inputs: [{ objectHash: "md5-deadbeef" }] }),
      /sha256/i,
    );
    // An unknown source is rejected as well.
    await assert.rejects(
      f.experiments.submit(f.caller, { ...node("process.stdout.write('x')"), inputs: [{ sourceId: "src-missing" }] }),
      /unknown|retired/i,
    );
    assert.deepEqual(f.errors, []);
  });

  it("fails honestly when a registered machine has no backend, and refuses unregistered machines", async () => {
    const f = await fixture();
    await assert.rejects(
      f.experiments.submit(f.caller, { ...node("process.stdout.write('x')"), machineId: "ghost" }),
      /not registered/i,
    );

    const registered = await f.resources.registerMachine(f.caller.workspaceId, {
      machineId: "remote-a",
      kind: "ssh",
      label: "Unbacked remote",
    });
    assert.equal(registered.state, "offline");
    assert.equal(registered.connection.status, "unknown");

    const submitted = await f.experiments.submit(f.caller, {
      requestId: "req-nobackend",
      ...node("process.stdout.write('x')"),
      machineId: "remote-a",
    });
    assert.equal(submitted.attempt.state, "failed");
    assert.match(submitted.attempt.error ?? "", /no execution backend/i);
    assert.deepEqual(f.errors, []);
  });

  it("drives a registered machine through its resolved backend end to end", async () => {
    const f = await fixture();
    await f.resources.registerMachine(f.caller.workspaceId, {
      machineId: "sim-cluster",
      kind: "cluster",
      label: "Simulated cluster",
      backend: "sim",
      state: "available",
      capacity: { cpuCores: 64 },
    });

    const spawned: string[] = [];
    const released: string[] = [];
    const sim: ExperimentBackend = {
      backend: "sim",
      controls: ["cancel", "attach", "collect"],
      async spawn(_site, request) {
        spawned.push(request.backendJobId);
        return {
          handle: { backendJobId: `sim-${request.backendJobId}` },
          observation: { status: "running", writerActive: true },
        };
      },
      async inspect() {
        return { status: "exited", writerActive: false, exitCode: 0 };
      },
      async read(_site, _id, cursor) {
        return {
          chunks: cursor === 0
            ? [{ channel: "stdout" as const, bytesBase64: Buffer.from("sim-output").toString("base64") }]
            : [],
          nextCursor: 10,
          endCursor: 10,
          observation: { status: "exited", writerActive: false, exitCode: 0 },
        };
      },
      async kill() {},
      async release(_site, id) { released.push(id); },
      async collectFile(_site, relativePath) { return Buffer.from(`collected:${relativePath}`); },
    };
    const errors: Error[] = [];
    const experiments = createExperimentService({
      client: f.client,
      resources: f.resources,
      sources: f.sources,
      resolveWorkspaceRoot: async () => f.workspace,
      resolveBackend: async (_ctx, machineId) => {
        if (machineId === "sim-cluster") {
          return {
            backend: sim,
            site: {
              workspaceId: f.caller.workspaceId,
              rootId: "sim-root",
              canonicalRoot: f.workspace,
              transport: null,
            },
            prepare: async ({ input }) => ({
              site: {
                workspaceId: f.caller.workspaceId,
                rootId: "sim-root",
                canonicalRoot: f.workspace,
                transport: null,
              },
              cwd: input.cwd ?? "",
              inputRoot: input.root,
            }),
          };
        }
        return null;
      },
      onError: (error) => errors.push(error),
    });

    const submitted = await experiments.submit(f.caller, {
      requestId: "req-sim-1",
      ...node("process.stdout.write('ignored-by-sim')"),
      outputPaths: ["result.txt"],
      machineId: "sim-cluster",
    });
    assert.equal(submitted.attempt.backend, "sim");
    assert.equal(submitted.attempt.machineId, "sim-cluster");

    const waited = await experiments.wait(f.caller, submitted.attempt.attemptId, 15_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.attempt.state, "completed");
    assert.equal(waited.attempt.exitCode, 0);
    const releaseDeadline = Date.now() + 5_000;
    while (released.length === 0 && Date.now() < releaseDeadline) await pause();
    assert.equal(released.length, 1);
    assert.ok(released[0]!.startsWith("sim-"));

    const detail = await experiments.get(f.caller, submitted.attempt.attemptId);
    assert.equal(detail.job?.backend, "sim");
    assert.equal(detail.job?.machineId, "sim-cluster");
    assert.ok(detail.job?.backendJobId?.startsWith("sim-"));
    assert.ok(detail.artifacts.some((a) => a.name === "stdout" && a.state === "available"));
    assert.ok(detail.artifacts.some((a) => a.name === "result.txt" && a.state === "available"));

    const logs = await experiments.logs(f.caller, { attemptId: submitted.attempt.attemptId });
    assert.match(logs.text, /sim-output/);

    // The idempotent retry returns the recorded attempt — no second spawn.
    const retry = await experiments.submit(f.caller, {
      requestId: "req-sim-1",
      ...node("process.stdout.write('ignored-by-sim')"),
      outputPaths: ["result.txt"],
      machineId: "sim-cluster",
    });
    assert.equal(retry.attempt.attemptId, submitted.attempt.attemptId);
    assert.equal(spawned.length, 1);
    assert.deepEqual(errors, []);
  });

  it("keeps ordered args and root-scoped request identities distinct and rejects request reuse with another spec", async () => {
    const f = await fixture();
    const resources = { cpuCores: 1_000_000 };
    const first = await f.experiments.submit(f.caller, {
      requestId: "matrix/a?b",
      command: "ordered-command",
      args: ["alpha", "beta"],
      resources,
    });
    const reordered = await f.experiments.submit(f.caller, {
      requestId: "matrix/a/b",
      command: "ordered-command",
      args: ["beta", "alpha"],
      resources,
    });
    assert.notEqual(first.attempt.attemptId, reordered.attempt.attemptId);
    assert.notEqual(first.spec.specId, reordered.spec.specId);
    await assert.rejects(
      f.experiments.submit(f.caller, {
        requestId: "matrix/a?b",
        command: "ordered-command",
        args: ["different"],
        resources,
      }),
      /already bound|different experiment/i,
    );
    await f.experiments.cancel(f.caller, first.attempt.attemptId);
    await f.experiments.cancel(f.caller, reordered.attempt.attemptId);
  });

  it("uses resources pinned on a reused spec instead of bypassing admission", async () => {
    const f = await fixture();
    const first = await f.experiments.submit(f.caller, {
      command: "never-launched",
      resources: { cpuCores: 1_000_000 },
    });
    assert.equal(first.attempt.state, "queued");
    await f.experiments.cancel(f.caller, first.attempt.attemptId);

    const reused = await f.experiments.submit(f.caller, { specId: first.spec.specId });
    assert.equal(reused.attempt.state, "queued");
    assert.match(reused.attempt.queueReason ?? "", /cpuCores|insufficient/i);
    await f.experiments.cancel(f.caller, reused.attempt.attemptId);
  });

  it("reconciles a lost submit response and transient polling failure without releasing or duplicating the job", async () => {
    const f = await fixture();
    let spawnCalls = 0;
    let createdJobs = 0;
    let readCalls = 0;
    const backend: ExperimentBackend = {
      backend: "fault-reconcile",
      controls: ["cancel", "attach", "collect"],
      async spawn(_site, request) {
        spawnCalls += 1;
        if (createdJobs === 0) createdJobs += 1;
        if (spawnCalls === 1) throw new Error("response dropped after durable submit");
        return { handle: { backendJobId: request.backendJobId }, observation: { status: "running", writerActive: true } };
      },
      async inspect() { return { status: "running", writerActive: true }; },
      async read(_site, _id, cursor) {
        readCalls += 1;
        if (readCalls === 1) throw new Error("temporary observation outage");
        const bytes = Buffer.from("reconciled-output");
        return {
          chunks: cursor === 0 ? [{ channel: "stdout", bytesBase64: bytes.toString("base64") }] : [],
          nextCursor: bytes.byteLength,
          endCursor: bytes.byteLength,
          observation: { status: "exited", writerActive: false, exitCode: 0 },
        };
      },
      async kill() {},
      async release() {},
      async collectFile() { throw new Error("no declared files"); },
    };
    const experiments = await serviceWithBackend(f, "fault-reconcile-machine", backend);
    const submitted = await experiments.submit(f.caller, {
      requestId: "lost-response",
      ...node("process.stdout.write('unused')"),
      machineId: "fault-reconcile-machine",
      resources: { cpuCores: 1 },
    });
    assert.equal(submitted.attempt.state, "submitted");
    const reserved = await f.resources.list(f.caller.workspaceId);
    assert.equal(reserved.machines.find((machine) => machine.machineId === "fault-reconcile-machine")?.commitments.length, 1);

    const waited = await experiments.wait(f.caller, submitted.attempt.attemptId, 15_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.attempt.state, "completed");
    assert.equal(createdJobs, 1);
    assert.equal(spawnCalls, 2);
    assert.ok(readCalls >= 2);
    const logs = await experiments.logs(f.caller, { attemptId: submitted.attempt.attemptId });
    assert.equal(logs.text, "reconciled-output");
  });

  it("persists logs before release, retries collection independently, and never marks a failed release as released", async () => {
    const f = await fixture();
    let fileAvailable = false;
    let releases = 0;
    const output = Buffer.from("durable-before-release");
    const backend: ExperimentBackend = {
      backend: "fault-finalize",
      controls: ["cancel", "attach", "collect"],
      async spawn(_site, request) {
        return { handle: { backendJobId: request.backendJobId }, observation: { status: "running", writerActive: true } };
      },
      async inspect() { return { status: "exited", writerActive: false, exitCode: 0 }; },
      async read(_site, _id, cursor) {
        return {
          chunks: cursor === 0 ? [{ channel: "stdout", bytesBase64: output.toString("base64") }] : [],
          nextCursor: output.byteLength,
          endCursor: output.byteLength,
          observation: { status: "exited", writerActive: false, exitCode: 0 },
        };
      },
      async kill() {},
      async release() {
        releases += 1;
        if (releases === 1) throw new Error("release bookkeeping unavailable");
      },
      async collectFile() {
        if (!fileAvailable) throw new Error("result transfer unavailable");
        return Buffer.from("final-result");
      },
    };
    const experiments = await serviceWithBackend(f, "fault-finalize-machine", backend);
    const submitted = await experiments.submit(f.caller, {
      ...node("process.stdout.write('unused')"),
      machineId: "fault-finalize-machine",
      outputPaths: ["result.txt"],
    });
    const waited = await experiments.wait(f.caller, submitted.attempt.attemptId, 15_000);
    assert.equal(waited.attempt.state, "completed");
    assert.equal(waited.attempt.collection, "failed");
    assert.equal(releases, 0);
    const durableLog = await experiments.logs(f.caller, { attemptId: submitted.attempt.attemptId });
    assert.equal(durableLog.origin, "live");
    assert.equal(durableLog.text, output.toString());

    fileAvailable = true;
    const collected = await experiments.collect(f.caller, submitted.attempt.attemptId);
    assert.equal(collected.attempt.collection, "done");
    assert.equal(releases, 1);
    const retriedRelease = await experiments.get(f.caller, submitted.attempt.attemptId);
    assert.equal(releases, 2);
    assert.equal(retriedRelease.job?.state, "released");
    const persistedLog = await experiments.logs(f.caller, { attemptId: submitted.attempt.attemptId });
    assert.equal(persistedLog.origin, "artifact");
    assert.equal(persistedLog.text, output.toString());
  });

  it("retries a failed terminal commitment release after the backend job is already released", async () => {
    const f = await fixture();
    let releaseUnavailable = true;
    let markReleaseFailure!: () => void;
    const releaseFailed = new Promise<void>((resolve) => { markReleaseFailure = resolve; });
    const flakyResources = {
      ...f.resources,
      release: async (workspaceId: string, commitmentId: string, reason: string) => {
        // Keep the outage observable even if wait/get reconciles the terminal
        // attempt again before the test reads its retained commitment.
        if (releaseUnavailable) {
          markReleaseFailure();
          throw new Error("temporary commitment persistence failure");
        }
        await f.resources.release(workspaceId, commitmentId, reason);
      },
    };
    const experiments = createExperimentService({
      client: f.client,
      resources: flakyResources,
      sources: f.sources,
      resolveWorkspaceRoot: async () => f.workspace,
      onError: (error) => f.errors.push(error),
    });
    const submitted = await experiments.submit(f.caller, {
      ...node("process.exit(0)"),
      resources: { cpuCores: 1 },
    });
    const waited = await experiments.wait(f.caller, submitted.attempt.attemptId, 15_000);
    assert.equal(waited.attempt.state, "completed");
    await releaseFailed;
    const pending = await experiments.get(f.caller, submitted.attempt.attemptId);
    assert.equal(pending.job?.state, "released");
    assert.equal(
      (await f.resources.list(f.caller.workspaceId)).machines.find((machine) => machine.machineId === "local")?.commitments.length,
      1,
    );

    releaseUnavailable = false;
    const reconciled = await experiments.get(f.caller, submitted.attempt.attemptId);
    assert.equal(reconciled.job?.state, "released");
    assert.equal(
      (await f.resources.list(f.caller.workspaceId)).machines.find((machine) => machine.machineId === "local")?.commitments.length,
      0,
    );
  });

  it("keeps polling after restart when inspect throws and the first observation is unknown", async () => {
    const f = await fixture();
    let phase: "initial" | "recovery" = "initial";
    let recoveryReads = 0;
    const backend: ExperimentBackend = {
      backend: "unknown-recovery",
      controls: ["cancel", "attach", "collect"],
      async spawn(_site, request) {
        return { handle: { backendJobId: request.backendJobId }, observation: { status: "running", writerActive: true } };
      },
      async inspect() {
        if (phase === "recovery") throw new Error("connector is reconnecting");
        return { status: "running", writerActive: true };
      },
      async read(_site, _id, cursor) {
        if (phase === "initial") {
          return { chunks: [], nextCursor: cursor, endCursor: cursor, observation: { status: "running", writerActive: true } };
        }
        recoveryReads += 1;
        if (recoveryReads === 1) {
          return { chunks: [], nextCursor: cursor, endCursor: cursor, observation: { status: "unknown", writerActive: true, reason: "reconnecting" } };
        }
        return { chunks: [], nextCursor: cursor, endCursor: cursor, observation: { status: "exited", writerActive: false, exitCode: 0 } };
      },
      async kill() {},
      async release() {},
      async collectFile() { throw new Error("no files"); },
    };
    const first = await serviceWithBackend(f, "unknown-recovery-machine", backend);
    const submitted = await first.submit(f.caller, {
      ...node("process.exit(0)"),
      machineId: "unknown-recovery-machine",
    });
    assert.equal(submitted.attempt.state, "running");
    first.detachObservers();
    phase = "recovery";
    const restarted = await serviceWithBackend(f, "unknown-recovery-machine", backend);
    const waited = await restarted.wait(f.caller, submitted.attempt.attemptId, 15_000);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.attempt.state, "completed");
    assert.ok(recoveryReads >= 2);
  });

  it("retains output beyond eight MiB and pages UTF-8 without splitting code points", async () => {
    const f = await fixture();
    const prefixBytes = 8 * 1024 * 1024 + 1024;
    const submitted = await f.experiments.submit(f.caller, node(
      `process.stdout.write(Buffer.concat([Buffer.alloc(${prefixBytes},120),Buffer.from('😀tail')]))`,
    ));
    const waited = await f.experiments.wait(f.caller, submitted.attempt.attemptId, 45_000);
    assert.equal(waited.attempt.state, "completed");
    const detail = await f.experiments.get(f.caller, submitted.attempt.attemptId);
    const stdout = detail.artifacts.find((artifact) => artifact.name === "stdout");
    assert.equal(stdout?.byteLength, prefixBytes + Buffer.byteLength("😀tail"));
    assert.equal(stdout?.truncated, undefined);
    const page = await f.experiments.logs(f.caller, {
      attemptId: submitted.attempt.attemptId,
      offset: prefixBytes + 1,
      maxBytes: 8,
    });
    assert.equal(page.offset, prefixBytes);
    assert.equal(page.text, "😀tail");
    assert.equal(page.eof, true);
    const artifactPage = await f.experiments.readArtifactPage(f.caller, {
      attemptId: submitted.attempt.attemptId,
      artifactId: stdout!.artifactId,
      offset: prefixBytes + 1,
      maxBytes: 8,
    });
    assert.equal(artifactPage.offset, prefixBytes);
    assert.equal(artifactPage.text, "😀tail");
  }, 45_000);

  it("isolates root-scoped specs and preserves the original attempt attribution during UI collection", async () => {
    const f = await fixture();
    const firstCaller: ExperimentCaller = {
      ...f.caller,
      rootSessionId: "root-one",
      allowedThreadIds: ["t-1"],
    };
    const secondCaller: ExperimentCaller = {
      workspaceId: f.caller.workspaceId,
      executionWorkspaceId: f.caller.executionWorkspaceId,
      sessionId: "s-2",
      rootSessionId: "root-two",
      threadId: "t-2",
      runId: "r-2",
      workspaceScope: [],
      allowedThreadIds: ["t-2"],
    };
    const first = await f.experiments.submit(firstCaller, node("process.stdout.write('one')"));
    const second = await f.experiments.submit(secondCaller, node("process.stdout.write('two')"));
    assert.notEqual(first.spec.specId, second.spec.specId);
    await assert.rejects(f.experiments.get(firstCaller, second.attempt.attemptId), /unknown experiment attempt/i);
    assert.deepEqual((await f.experiments.list(firstCaller, {})).attempts.map((attempt) => attempt.attemptId), [first.attempt.attemptId]);

    await f.experiments.wait(firstCaller, first.attempt.attemptId, 15_000);
    const uiCaller: ExperimentCaller = {
      workspaceId: f.caller.workspaceId,
      executionWorkspaceId: f.caller.executionWorkspaceId,
      sessionId: "ui-session",
      rootSessionId: "root-one",
      workspaceScope: [],
      allowedThreadIds: ["t-1"],
    };
    const collected = await f.experiments.collect(uiCaller, first.attempt.attemptId);
    assert.equal(collected.attempt.threadId, "t-1");
    assert.equal(collected.attempt.runId, "r-1");
  });

  it("closes thread submission while stop waits for an in-flight intent and confirms backend termination", async () => {
    const f = await fixture();
    let spawnEntered!: () => void;
    const entered = new Promise<void>((resolve) => { spawnEntered = resolve; });
    let finishSpawn!: () => void;
    const spawnGate = new Promise<void>((resolve) => { finishSpawn = resolve; });
    let stopped = false;
    const backend: ExperimentBackend = {
      backend: "stop-race",
      controls: ["cancel", "attach", "collect"],
      async spawn(_site, request) {
        spawnEntered();
        await spawnGate;
        return { handle: { backendJobId: request.backendJobId }, observation: { status: "running", writerActive: true } };
      },
      async inspect() {
        return stopped
          ? { status: "cancelled", writerActive: false }
          : { status: "running", writerActive: true };
      },
      async read(_site, _id, cursor) {
        return {
          chunks: [], nextCursor: cursor, endCursor: cursor,
          observation: stopped
            ? { status: "cancelled", writerActive: false }
            : { status: "running", writerActive: true },
        };
      },
      async kill() { stopped = true; },
      async release() {},
      async collectFile() { throw new Error("no files"); },
    };
    const experiments = await serviceWithBackend(f, "stop-race-machine", backend);
    const submitting = experiments.submit(f.caller, {
      requestId: "stop-race-submit",
      ...node("setInterval(()=>{},1000)"),
      machineId: "stop-race-machine",
    });
    await entered;
    const stopping = experiments.stopForThreads(f.caller.workspaceId, [f.caller.threadId!]);
    await assert.rejects(
      experiments.submit(f.caller, {
        requestId: "must-not-pass-stop-gate",
        ...node("process.exit(0)"),
        machineId: "stop-race-machine",
      }),
      /thread .* stopping/i,
    );
    finishSpawn();
    const submitted = await submitting;
    await stopping;
    const detail = await experiments.get(f.caller, submitted.attempt.attemptId);
    assert.equal(detail.attempt.state, "cancelled");
  });
});
