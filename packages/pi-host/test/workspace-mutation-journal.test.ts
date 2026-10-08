import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type AgentInputContext,
  createRequest,
  type EventEnvelope,
  type HarnessRequestData,
  type HostEvent,
  type HostEventData,
  VARIN_PROTOCOL_VERSION,
  type ResponseEnvelope,
  type WireEnvelope,
} from "@varin/protocol";
import { HostController } from "../src/host-controller.js";
import { SessionHost } from "../src/session-host.js";
import { MemoryHostTransport } from "../src/transport.js";
import { HostServicesBridge } from "../src/harness/host-services-bridge.js";
import {
  createWorkspaceMutationJournalTools,
  WorkspaceMutationJournalBridge,
} from "../src/workspace-mutation-journal.js";

type MutationRequest = HostEventData<"workspace.mutation.request">;

class MutationEventCollector {
  readonly seen: MutationRequest[] = [];
  readonly #waiting: Array<(event: MutationRequest) => void> = [];

  emit<E extends HostEvent>(event: E, data: HostEventData<E>): void {
    if (event !== "workspace.mutation.request") return;
    const mutation = data as MutationRequest;
    const waiting = this.#waiting.shift();
    if (waiting) waiting(mutation);
    else this.seen.push(mutation);
  }

  next(): Promise<MutationRequest> {
    const existing = this.seen.shift();
    if (existing) return Promise.resolve(existing);
    return new Promise<MutationRequest>((resolveEvent, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for workspace mutation event")),
        5_000,
      );
      this.#waiting.push((event) => {
        clearTimeout(timeout);
        resolveEvent(event);
      });
    });
  }
}

function isResponse(envelope: WireEnvelope, id: string): envelope is ResponseEnvelope {
  return envelope.kind === "response" && envelope.id === id;
}

function isMutationEvent(envelope: WireEnvelope): envelope is EventEnvelope<"workspace.mutation.request"> {
  return envelope.kind === "event" && envelope.event === "workspace.mutation.request";
}

function serveHarnessRequest(
  host: SessionHost,
  event: HostEvent,
  data: HostEventData<HostEvent>,
  workspaceRoot?: string,
): void {
  if (event !== "harness.request") return;
  const request = data as HostEventData<"harness.request">;
  const sessionId = host.sessionId;
  if (!sessionId) return;
  if (request.method === "fs.lock") {
    const result = (request.params as { action?: string }).action === "acquire"
      ? { held: true, leaseIds: ["lease-test"] }
      : { held: false, released: true };
    host.respondHarness(sessionId, request.requestId, { ok: true, result });
    return;
  }
  if (request.method === "lsp.diagnostics") {
    throw new Error("File mutations must complete without waiting for the language service");
  }
  if (request.method === "document.branchWrite") {
    host.respondHarness(sessionId, request.requestId, { ok: true, result: { status: "disk" } });
    return;
  }
  if (request.method === "document.surfaceWrite" && workspaceRoot) {
    const params = request.params as { path?: string; action?: "write" | "edit" | "delete"; content?: string; edits?: Array<{ oldText: string; newText: string }> };
    const relative = params.path ?? "";
    const target = join(workspaceRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    if (params.action === "delete") rmSync(target, { force: true });
    else if (params.action === "edit") {
      let content = readFileSync(target, "utf8");
      for (const edit of params.edits ?? []) content = content.replace(edit.oldText, edit.newText);
      writeFileSync(target, content, "utf8");
    } else {
      writeFileSync(target, params.content ?? "", "utf8");
    }
    host.respondHarness(sessionId, request.requestId, {
      ok: true,
      result: { status: "applied", operationId: `op-${request.requestId}`, results: [{ path: relative, target: "disk", status: "applied" }] },
    });
  }
}

describe("workspace mutation journal", () => {
  it("routes enabled write and edit through the Host document mutation backend", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-mutation-tools-"));
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const events = new MutationEventCollector();
    const host = new SessionHost({
      agentDir: join(root, "agent"),
      emit: (event, data) => {
        events.emit(event, data);
        serveHarnessRequest(host, event, data, cwd);
      },
      projectTrustOverride: true,
    });
    host.setWorkspaceMutationJournalEnabled(true);
    host.setHarnessDocumentReadEnabled(true);
    await host.openCatalogContext(cwd);
    try {
      const write = host.session.getToolDefinition("write") as ReturnType<typeof createWriteToolDefinition>;
      const writeResult = await write.execute("write-call", { content: "created", path: "created.txt" }, undefined, undefined, undefined as never);
      assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "created");
      assert.deepEqual(writeResult.details, { mutation: { status: "applied", results: [{ path: "created.txt", target: "disk", status: "applied" }] } });

      const edit = host.session.getToolDefinition("edit") as ReturnType<typeof createEditToolDefinition>;
      const editResult = await edit.execute(
        "edit-call",
        { edits: [{ newText: "updated", oldText: "created" }], path: "created.txt" },
        undefined,
        undefined,
        undefined as never,
      );
      assert.equal(await readFile(join(cwd, "created.txt"), "utf8"), "updated");
      assert.deepEqual(editResult.details, { mutation: { status: "applied", results: [{ path: "created.txt", target: "disk", status: "applied" }] } });
      assert.equal(events.seen.length, 0, "Host-backed document mutations must not enter the legacy pi-host disk journal");
    } finally {
      await host.dispose();
    }
  });
  it("does not override Pi's built-ins when the capability is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-mutation-disabled-"));
    const cwd = join(root, "workspace");
    await mkdir(cwd, { recursive: true });
    const events = new MutationEventCollector();
    const host = new SessionHost({
      agentDir: join(root, "agent"),
      emit: (event, data) => events.emit(event, data),
      projectTrustOverride: true,
    });
    await host.openCatalogContext(cwd);
    try {
      assert.equal(
        host.session.getAllTools().find((tool) => tool.name === "write")?.sourceInfo.source,
        "builtin",
      );
      const write = host.session.getToolDefinition("write") as ReturnType<
        typeof createWriteToolDefinition
      >;
      await write.execute(
        "write-call",
        { content: "unblocked", path: "plain.txt" },
        undefined,
        undefined,
        undefined as never,
      );
      assert.equal(await readFile(join(cwd, "plain.txt"), "utf8"), "unblocked");
      assert.equal(events.seen.length, 0);
    } finally {
      await host.dispose();
    }
  });

  it("routes both fixed drafts and ordinary disk paths through document.surfaceWrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-mutation-write-guard-"));
    const events = new MutationEventCollector();
    const journal = new WorkspaceMutationJournalBridge({
      emit: (event, data) => events.emit(event, data),
      sessionId: "session-guard",
    });
    const surfaceWrites: string[] = [];
    let inputContext: AgentInputContext = {
      source: "surface",
      roots: [{ workspaceId: "workspace-1", dirtyPaths: ["draft.txt"] }],
      snapshot: { status: "ready", ref: "ref-1" },
    };
    const harnessRequests: HarnessRequestData[] = [];
    const hostServices = new HostServicesBridge({
      emit: (_event, data) => {
        harnessRequests.push(data);
        if (data.method === "fs.lock") {
          const action = (data.params as { action?: string }).action;
          hostServices.respond("session-guard", data.requestId, {
            ok: true,
            result: action === "acquire" ? { held: true, leaseIds: ["lease-1"] } : { held: false, released: true },
          });
          return;
        }
        if (data.method === "document.branchWrite") {
          hostServices.respond("session-guard", data.requestId, { ok: true, result: { status: "disk" } });
          return;
        }
        if (data.method === "document.surfaceWrite") {
          const path = (data.params as { path?: string }).path ?? "";
          if (path === "conflict.txt") {
            hostServices.respond("session-guard", data.requestId, { ok: true, result: {
              status: "conflict", results: [{ path, target: "disk", status: "conflict", message: "Source changed" }],
            } });
            return;
          }
          surfaceWrites.push(path);
          const params = data.params as { path?: string; content?: string };
          const diskTarget = !path.endsWith("draft.txt");
          if (diskTarget) writeFileSync(join(root, path), params.content ?? "", "utf8");
          hostServices.respond("session-guard", data.requestId, {
            ok: true,
            result: {
              status: "applied",
              operationId: diskTarget ? "op-disk" : "op-surface",
              results: [{ path, target: diskTarget ? "disk" : "surface", status: "applied" }],
            },
          });
          return;
        }
        if (data.method === "lsp.diagnostics") {
          hostServices.respond("session-guard", data.requestId, { ok: true, result: { status: "ready", diagnostics: [] } });
        }
      },
      sessionId: "session-guard",
      getInputContext: () => inputContext,
    });
    const write = createWorkspaceMutationJournalTools(root, journal, hostServices, "session-guard", {
      surfaceWrite: true,
    }).find((tool) => tool.name === "write") as ReturnType<typeof createWriteToolDefinition>;

    const surfaceResult = await write.execute(
      "surface",
      { content: "C", path: "draft.txt" },
      undefined,
      undefined,
      undefined as never,
    );
    assert.match((surfaceResult.content[0] as { text: string }).text, /Successfully wrote/);
    assert.deepEqual(surfaceResult.details, { mutation: { status: "applied", results: [{ path: "draft.txt", target: "surface", status: "applied" }] } });
    await assert.rejects(readFile(join(root, "draft.txt")), { code: "ENOENT" });
    assert.equal(events.seen.length, 0);
    assert.deepEqual(surfaceWrites, ["draft.txt"]);

    // Disk-sourced paths are also applied by Host Documents; pi-host does not
    // fall back to its own write implementation or mutation journal.
    await write.execute("allowed", { content: "plain", path: "other.txt" }, undefined, undefined, undefined as never);
    assert.equal(await readFile(join(root, "other.txt"), "utf8"), "plain");

    inputContext = { source: "disk" };
    await write.execute("disk", { content: "disk turn", path: "disk.txt" }, undefined, undefined, undefined as never);
    assert.equal(await readFile(join(root, "disk.txt"), "utf8"), "disk turn");
    assert.equal(events.seen.length, 0);
    assert.deepEqual(surfaceWrites, ["draft.txt", "other.txt", "disk.txt"]);

    const conflict = await write.execute("conflict", { content: "never written", path: "conflict.txt" }, undefined, undefined, undefined as never);
    assert.equal(conflict.isError, true);
    assert.deepEqual(conflict.details, { mutation: { status: "conflict", results: [{ path: "conflict.txt", target: "disk", status: "conflict", message: "Source changed" }] } });
    await assert.rejects(readFile(join(root, "conflict.txt")), { code: "ENOENT" });

    journal.dispose();
    hostServices.dispose();
  });

  it("isolates concurrent request ids and preserves the original tool result", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-mutation-concurrent-"));
    const events = new MutationEventCollector();
    const bridge = new WorkspaceMutationJournalBridge({
      emit: (event, data) => events.emit(event, data),
      sessionId: "session-concurrent",
    });
    const write = createWorkspaceMutationJournalTools(root, bridge).find(
      (tool) => tool.name === "write",
    ) as ReturnType<typeof createWriteToolDefinition>;
    const firstRun = write.execute(
      "first-call",
      { content: "first", path: "first.txt" },
      undefined,
      undefined,
      undefined as never,
    );
    const secondRun = write.execute(
      "second-call",
      { content: "second", path: "second.txt" },
      undefined,
      undefined,
      undefined as never,
    );

    const firstBefore = await events.next();
    const secondBefore = await events.next();
    assert.notEqual(firstBefore.requestId, secondBefore.requestId);
    assert.equal(bridge.respond("session-concurrent", secondBefore.requestId, true), true);
    const secondAfter = await events.next();
    assert.equal(secondAfter.toolCallId, "second-call");
    assert.equal(await readFile(join(root, "second.txt"), "utf8"), "second");
    await assert.rejects(readFile(join(root, "first.txt")), { code: "ENOENT" });
    assert.equal(bridge.respond("session-concurrent", secondAfter.requestId, true), true);
    await secondRun;

    assert.equal(bridge.respond("session-concurrent", firstBefore.requestId, true), true);
    const firstAfter = await events.next();
    assert.equal(firstAfter.toolCallId, "first-call");
    assert.equal(bridge.respond("session-concurrent", firstAfter.requestId, true), true);
    await firstRun;
    bridge.dispose();
  });

  it("continues without journaling when event emission throws", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-mutation-emit-error-"));
    const bridge = new WorkspaceMutationJournalBridge({
      emit: () => {
        throw new Error("transport unavailable");
      },
      sessionId: "session-emit-error",
    });
    const write = createWorkspaceMutationJournalTools(root, bridge).find(
      (tool) => tool.name === "write",
    ) as ReturnType<typeof createWriteToolDefinition>;
    await write.execute(
      "write-call",
      { content: "written", path: "written.txt" },
      undefined,
      undefined,
      undefined as never,
    );
    assert.equal(await readFile(join(root, "written.txt"), "utf8"), "written");
    bridge.dispose();
  });

  it("releases pending standalone journal waits on disposal", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-mutation-dispose-"));
    const events = new MutationEventCollector();
    const bridge = new WorkspaceMutationJournalBridge({
      emit: (event, data) => events.emit(event, data),
      sessionId: "session-dispose",
    });
    const write = createWorkspaceMutationJournalTools(root, bridge)
      .find((tool) => tool.name === "write") as ReturnType<typeof createWriteToolDefinition>;
    const run = write.execute(
      "disposal-call",
      { content: "disposal", path: "disposal.txt" },
      undefined,
      undefined,
      undefined as never,
    );
    await events.next();
    bridge.dispose();
    await run;
    assert.equal(await readFile(join(root, "disposal.txt"), "utf8"), "disposal");
  });

  it("commits a virtual write through document.branchWrite without touching disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "varin-virtual-write-"));
    const journal = new WorkspaceMutationJournalBridge({
      emit: () => {
        throw new Error("virtual writes must not journal disk mutations");
      },
      sessionId: "session-virtual",
    });
    const writes: Array<{ path: string; content?: string }> = [];
    const hostServices = new HostServicesBridge({
      emit: (_event, data) => {
        if (data.method === "document.branchWrite") {
          const params = data.params as { path: string; content?: string };
          writes.push(params.content === undefined ? { path: params.path } : { path: params.path, content: params.content });
          hostServices.respond("session-virtual", data.requestId, {
            ok: true,
            result: {
              status: "committed",
              revision: 1,
              provenance: { branchId: "thread-child", revision: 1, origin: "delta" },
            },
          });
          return;
        }
        throw new Error(`unexpected method: ${data.method}`);
      },
      sessionId: "session-virtual",
    });
    const write = createWorkspaceMutationJournalTools(root, journal, hostServices, "session-virtual")
      .find((tool) => tool.name === "write") as ReturnType<typeof createWriteToolDefinition>;
    const result = await write.execute(
      "virtual-write",
      { content: "virtual only", path: "kept.txt" },
      undefined,
      undefined,
      undefined as never,
    );
    assert.match((result.content[0] as { text: string }).text, /Successfully wrote kept.txt/);
    assert.deepEqual(result.details, { mutation: { status: "committed" } });
    assert.deepEqual(writes, [{ path: "kept.txt", content: "virtual only" }]);
    await assert.rejects(readFile(join(root, "kept.txt")), { code: "ENOENT" });
  });

  it("negotiates the capability and accepts worker-only responses in HostController", async () => {
    const transport = new MemoryHostTransport();
    const controller = new HostController({ transport });
    controller.start();
    try {
      transport.receive(createRequest("handshake", "host.handshake", {
        capabilities: { workspaceMutationJournal: true },
        clientName: "web-host",
        clientVersion: "0.1.0",
        mode: "web",
        protocolVersions: [VARIN_PROTOCOL_VERSION],
      }));
      const handshake = await transport.waitFor((envelope) => isResponse(envelope, "handshake"));
      assert.equal(handshake.kind, "response");
      assert.equal(handshake.ok, true);

      transport.receive(createRequest("respond", "workspace.mutation.respond", {
        accepted: true,
        requestId: "unknown-request",
        sessionId: "unknown-session",
      }));
      const response = await transport.waitFor((envelope) => isResponse(envelope, "respond"));
      assert.deepEqual(response, {
        id: "respond",
        kind: "response",
        ok: true,
        result: { accepted: false },
        v: VARIN_PROTOCOL_VERSION,
      });
      assert.equal(transport.sent.some(isMutationEvent), false);
    } finally {
      await controller.dispose();
    }
  });
});
