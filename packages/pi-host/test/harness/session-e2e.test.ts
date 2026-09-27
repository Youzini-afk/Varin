/**
 * Real Pi session e2e — the three in-process extensions that session-host
 * registers for every session, exercised inside an actual agent loop with a
 * faux provider:
 *
 *   - zone2-extension            (before_agent_start → <varin-context>)
 *   - context-preparation        (context budget → session_before_compact)
 *   - permission-gate            (tool_call → ui.select → allow/deny)
 *
 * The tool-level e2e files (phase2/phase3/phase3b) drive `tool.execute`
 * directly, which never reaches a Pi hook. These tests wire a real
 * SessionHost to a real HarnessRouter + HarnessServiceHost, so the hook
 * path, the bridge round-trip and the UI answer flow are all covered.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import type { HarnessError, HostEvent, HostEventData } from "@varin/protocol";

import { createHarnessServiceHost, type HarnessServiceHostOptions } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { openWorkspaceKnowledge } from "../../../web/application-host/lib/knowledge/store.js";
import { createKnowledgeContextRuntime } from "../../../web/application-host/lib/knowledge/context-runtime.js";
import { createDocumentAuthority, type DocumentMutationObservation } from "../../../web/application-host/lib/documents/authority.js";
import {
  attachLiveSurfaceCompleter,
  createDocumentAuthorityHarness,
  hashSurfaceText,
  type LiveSurfaceBuffer,
} from "../../../web/application-host/lib/documents/contract-fixtures.js";
import { createLanguageSupervisor } from "../../../web/application-host/lib/lsp/supervisor.js";
import { VARIN_LSP_FIXTURE_SERVER_ARGS } from "../../../web/application-host/lib/lsp/servers.js";
import { createLanguageSupervisorDiagnosticsProvider } from "../../../web/application-host/lib/harness/diagnostics-adapter.js";
import { createWebSearchService, resolveConfiguredSearchProvider } from "../../../web/application-host/lib/harness/web-search.js";
import type { Zone2Material } from "../../../web/application-host/lib/harness/zone2.js";
import { createExploreFileReader } from "../../../web/application-host/lib/harness/explore-file-reader.js";
import type { StructureSource } from "../../../web/application-host/lib/structure/types.js";
import { createHarnessPathAuthority } from "../../../web/application-host/lib/harness/path-authority.js";
import { createNativeComputeTestHarness } from "../../../web/application-host/lib/kernel/compute.test-helper.js";
import { createRecoveryFileStore } from "../../../web/application-host/lib/recovery/file-store.test-helper.js";
import { createInMemoryRecoveryDurablePort } from "../../../web/application-host/lib/recovery/recovery-durable-port.test-helper.js";
import { createWorkspaceContentSearch } from "../../../web/application-host/lib/search/content.js";
import { createRemoteEmbedder } from "../../../web/application-host/lib/knowledge/semantic/remote-embedder.js";
import { createSemanticIndexRuntime } from "../../../web/application-host/lib/knowledge/semantic/runtime.js";
import { workspaceScope } from "../../../web/application-host/lib/knowledge/semantic/identity.js";
import { createStructureSource } from "../../../web/application-host/lib/structure/source.js";
import { createTreeSitterStructureProvider } from "../../../web/application-host/lib/structure/tree-sitter-provider.js";
import type { HarnessEmbedParams, HarnessEmbedResult, HarnessRerankParams, HarnessRerankResult } from "@varin/protocol";

import { SessionHost } from "../../src/session-host.js";
import { CompactionWorkerRuntime } from "../../src/compaction-worker.js";
import { deserializeCompactionModel } from "../../src/harness/compaction-agent.js";
import { serializedToolResult } from "./provider-context.js";

const WORKSPACE_ID = "session-e2e-workspace";

interface UiRequest {
  id: string;
  method: string;
  title: string;
}

/**
 * Build a SessionHost whose `harness.request` events are served by a real
 * router, and whose `extension.ui.request` dialogs are answered by
 * `answerDialog`. Returns the host plus the recorded dialog requests.
 */
async function setupSession(options: {
  root: string;
  faux: ReturnType<typeof registerFauxProvider>;
  /** Session launch dir — defaults to `root`; workspace fixtures pass their real root. */
  sessionRoot?: string;
  workspaceId?: string;
  harnessDocumentRead?: boolean;
  harnessDocumentPathOverlay?: boolean;
  harnessWebRead?: boolean;
  harnessWebSearch?: boolean;
  serviceHostOptions?: Partial<HarnessServiceHostOptions>;
  authorizeWorkspacePath?: NonNullable<Parameters<typeof createHarnessRouter>[0]["authorizeWorkspacePath"]>;
  /** Answer for a `ui.select` dialog; undefined = dismiss. */
  answerDialog?: (request: UiRequest, index: number) => string | undefined;
  inferenceFetch?: typeof fetch;
  observeHostEvent?: (event: HostEvent, data: unknown) => void;
}) {
  const { root, faux } = options;
  const workspaceId = options.workspaceId ?? WORKSPACE_ID;
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });

  // In-process stand-in for the broker-spawned compaction subprocess: the real
  // CompactionWorkerRuntime (Agent loop, query tools, harness bridge) runs here,
  // registered as an auxiliary actor whose harness.request traffic goes through
  // the same router the session uses. Only the OS process hop is absent.
  const harnessResponders = new Map<string, (
    requestId: string,
    outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError },
  ) => boolean>();
  let compactionWorkerSeq = 0;

  const harnessServiceHost = createHarnessServiceHost({
    search: async () => ({ status: "empty" as const, generation: undefined }),
    resolveWorkspaceRoot: async () => options.sessionRoot ?? root,
    discoveredShells: {
      hasBash: process.platform !== "win32",
      hasPowerShell: process.platform === "win32",
    },
    runCompactionTask: async (actor, spec, signal) => {
      const workerId = `worker-compaction-${++compactionWorkerSeq}`;
      harnessServiceHost.registerAuxiliaryActor(actor, workerId, spec.fixedLeafEntryId);
      const runtime = new CompactionWorkerRuntime({
        agentDir,
        // The worker owns its ModelRuntime in a subprocess; in-process tests
        // register the same faux provider the session's configureServices uses.
        configureModelRuntime: async (modelRuntime) => {
          const model = deserializeCompactionModel(spec.model);
          modelRuntime.registerProvider(model.provider, {
            api: model.api,
            baseUrl: model.baseUrl,
            models: [{
              api: model.api,
              baseUrl: model.baseUrl,
              contextWindow: model.contextWindow,
              cost: model.cost,
              id: model.id,
              input: model.input,
              maxTokens: model.maxTokens,
              name: model.name,
              reasoning: model.reasoning,
            }],
          });
          await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
        },
        emit: (event, data) => {
          if (event !== "harness.request") return;
          void router.processEvent({
            actor: { ...actor, workerId },
            kind: "host",
            envelope: { kind: "event", event: "harness.request", data },
          });
        },
      });
      harnessResponders.set(workerId, (requestId, outcome) =>
        runtime.respondHarness(spec.sessionId, requestId, outcome));
      try {
        // The production broker kills the worker process on abort; in-process
        // the same signal rejects the task without committing anything.
        return await Promise.race([runtime.run(spec), new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Compaction task aborted")), { once: true });
        })]);
      } finally {
        harnessResponders.delete(workerId);
        harnessServiceHost.dropAuxiliaryActor(workerId);
      }
    },
    ...options.serviceHostOptions,
    // Root sessions have no virtual working branch. Production still registers
    // document.branchWrite and returns disk; journal calls it before surfaceWrite.
    ...(options.harnessDocumentRead && !options.serviceHostOptions?.documentBranchWrite
      ? { documentBranchWrite: async () => ({ status: "disk" as const }) }
      : {}),
  });

  const uiRequests: UiRequest[] = [];

  const router = createHarnessRouter({
    respond: async (identity, requestId, outcome) => {
      const responder = harnessResponders.get(identity.workerId);
      if (responder) {
        responder(requestId, outcome);
        return;
      }
      host.respondHarness(identity.sessionId, requestId, outcome);
    },
    resolveActor: (identity) => harnessServiceHost.resolveActor(identity),
    cancelExploreQuery: (actor, queryId) => harnessServiceHost.exploreQueryStore.cancel(actor, queryId),
    authorizeWorkspacePath: options.authorizeWorkspacePath ?? (async (actor, inputPath, pathOptions) => {
      if (actor.workspaceId !== workspaceId) return null;
      const workspaceRoot = path.resolve(options.sessionRoot ?? root);
      const absolutePath = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(workspaceRoot, inputPath);
      const relativePath = path.relative(workspaceRoot, absolutePath);
      if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return null;
      if (!pathOptions.allowMissing && !existsSync(absolutePath)) return null;
      return {
        authorityId: "session-e2e-path-authority",
        workspaceId,
        inputPath,
        resourceId: relativePath.split(path.sep).join("/"),
        canonicalResourceId: absolutePath,
      };
    }),
  });
  registerHarnessServices(router, harnessServiceHost);

  const emit = (<E extends HostEvent>(event: E, data: HostEventData<E>): void => {
    options.observeHostEvent?.(event, data);
    if (event === "harness.cancel") {
      const payload = data as HostEventData<"harness.cancel">;
      const actor = {
        authorityInstanceId: "session-e2e-authority",
        sessionId: host.session.sessionManager.getSessionId(),
        workerId: "session-e2e-worker",
        workerGeneration: 1,
      } as const;
      void router.processEvent({
        actor,
        kind: "host",
        envelope: { kind: "event", event: "harness.cancel", data: payload },
      });
      return;
    }
    if (event === "workspace.mutation.request") {
      const payload = data as HostEventData<"workspace.mutation.request">;
      host.respondWorkspaceMutation(payload.sessionId, payload.requestId, true);
      return;
    }
    if (event === "harness.request") {
      const payload = data as HostEventData<"harness.request">;
      const actor = {
        authorityInstanceId: "session-e2e-authority",
        sessionId: host.session.sessionManager.getSessionId(),
        workerId: "session-e2e-worker",
        workerGeneration: 1,
      } as const;
      const registrationContext = {
          actor,
          grantedCapabilities: [
            "context.session", "process.shell", "read.lsp", "read.output", "read.search", "read.web", "write.document",
            ...(options.harnessDocumentRead || options.harnessDocumentPathOverlay ? ["read.document" as const] : []),
          ],
          workspaceId,
          workspaceRoot: options.sessionRoot ?? root,
        } as const;
      if (!harnessServiceHost.hasActor(actor)) harnessServiceHost.registerSession(registrationContext);
      void router.processEvent({
        actor,
        kind: "host",
        envelope: { kind: "event", event: "harness.request", data: payload },
      });
      return;
    }
    if (event === "extension.ui.request") {
      const payload = data as { id?: string; method?: string; payload?: { title?: string } };
      // `fire()` emits status/notify updates without an id; only dialogs
      // (select/confirm/input) carry one and expect an answer.
      if (!payload.id || payload.method !== "select") return;
      const request: UiRequest = {
        id: payload.id,
        method: payload.method,
        title: payload.payload?.title ?? "",
      };
      const index = uiRequests.length;
      uiRequests.push(request);
      const answer = options.answerDialog?.(request, index);
      host.ui.respond(
        answer === undefined
          ? { cancelled: true, requestId: payload.id }
          : { requestId: payload.id, value: answer },
      );
    }
  }) as <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

  const model = faux.getModel();
  const configureServices = async (services: AgentSessionServices) => {
    services.modelRuntime.registerProvider(model.provider, {
      api: model.api,
      baseUrl: model.baseUrl,
      models: [
        {
          api: model.api,
          baseUrl: model.baseUrl,
          contextWindow: model.contextWindow,
          cost: model.cost,
          id: model.id,
          input: model.input,
          maxTokens: model.maxTokens,
          name: model.name,
          reasoning: model.reasoning,
        },
      ],
    });
    await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
    return { model };
  };

  const host = new SessionHost({
    agentDir,
    configureServices,
    emit,
    projectTrustOverride: true,
    ...(options.inferenceFetch ? { inferenceFetch: options.inferenceFetch } : {}),
  });
  if (options.harnessDocumentRead) {
    host.setHarnessDocumentReadEnabled(true);
    host.setWorkspaceMutationJournalEnabled(true);
  }
  if (options.harnessDocumentPathOverlay) host.setHarnessDocumentPathOverlayEnabled(true);
  if (options.harnessWebRead || options.harnessWebSearch) {
    host.setHarnessWebCapabilities({
      read: options.harnessWebRead === true,
      search: options.harnessWebSearch === true,
    });
  }

  return {
    host,
    harnessServiceHost,
    router,
    uiRequests,
    dispose: async () => {
      await host.dispose();
      router.dispose();
      await harnessServiceHost.dispose();
    },
  };
}

async function withTempRoot(prefix: string, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await fn(root);
  } finally {
    try { await rm(root, { force: true, recursive: true }); } catch { /* Windows EBUSY */ }
  }
}

const waitUntil = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for background session work");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
};

describe("session e2e — authorized path boundary", () => {
  it("keeps desktop-capability read and write calls behind the authorized root", async () => {
    await withTempRoot("varin-desktop-path-boundary-", async (outer) => {
      const root = join(outer, "workspace");
      await mkdir(root);
      const outside = join(outer, "outside.txt");
      const secret = "outside-workspace-marker";
      await writeFile(outside, secret);
      const faux = registerFauxProvider();
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "inside.txt", content: "inside" })]),
        () => fauxAssistantMessage([fauxToolCall("write", { path: "../escape.txt", content: "escape" })]),
        () => fauxAssistantMessage([fauxToolCall("read", { path: "../outside.txt" })]),
        () => fauxAssistantMessage("done"),
      ]);
      const authority = createHarnessPathAuthority({
        authorityId: "desktop-path-boundary",
        documents: { inspectWorkspace: async () => ({ root }) },
      });
      const committed: string[] = [];
      const session = await setupSession({
        root,
        faux,
        harnessDocumentRead: true,
        answerDialog: () => "Allow once",
        authorizeWorkspacePath: (actor, candidate, options) => authority.resolve(actor, candidate, options),
        serviceHostOptions: {
          pathAuthority: authority,
          documentSurfaceWrite: async (_sessionId, _workspaceId, _context, changes) => {
            for (const change of changes) {
              committed.push(change.resourceId);
              if (change.action === "write") await writeFile(join(root, change.resourceId), change.content ?? "");
            }
            return {
              status: "applied" as const,
              results: changes.map((change) => ({ path: change.resourceId, target: "disk" as const, status: "applied" as const })),
            };
          },
        },
      });
      try {
        const created = await session.host.create(root, undefined, undefined, undefined, undefined, { mode: "bypass", rules: [] });
        assert.ok(created.activeTools.includes("document_read"));
        await session.host.prompt(created.sessionId, "Check the workspace path boundary");
        await session.host.session.waitForIdle();
        const branch = session.host.session.sessionManager.getBranch();
        assert.deepEqual(committed, ["inside.txt"], JSON.stringify(branch.filter((entry) => entry.type === "message" && entry.message.role === "toolResult")));
        assert.equal(await readFile(join(root, "inside.txt"), "utf8"), "inside");
        assert.equal(existsSync(join(outer, "escape.txt")), false);
        const writeResults = branch.filter((entry) => entry.type === "message"
          && entry.message.role === "toolResult" && entry.message.toolName === "write");
        assert.equal(writeResults.length, 2);
        assert.match(JSON.stringify(writeResults[1]), /outside the actor workspace/);
        const readResult = branch.find((entry) => entry.type === "message"
          && entry.message.role === "toolResult" && entry.message.toolName === "read");
        assert.ok(readResult && readResult.type === "message");
        assert.match(JSON.stringify(readResult.message), /outside the actor workspace/);
        assert.ok(!JSON.stringify(readResult.message).includes(secret), "an outside read must not disclose the file");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

});

describe("session e2e — cross-directory access", () => {
  it("reads an authorized external file by absolute path through the real read tool", async () => {
    await withTempRoot("varin-cross-dir-read-", async (outer) => {
      const root = join(outer, "workspace");
      await mkdir(root);
      const externalDir = join(outer, "external");
      await mkdir(externalDir);
      const externalFile = join(externalDir, "notes.md");
      await writeFile(externalFile, "external payload\n");
      const faux = registerFauxProvider();
      let toolResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("read", { path: externalFile })]),
        (context) => {
          toolResult = serializedToolResult(context, "read");
          return fauxAssistantMessage("done");
        },
      ]);
      // Real path authority over a minimal registry: the session workspace
      // plus one directory resource root covering the external directory.
      const externalCanonical = await realpath(externalDir);
      const externalRoot = { workspaceId: "external-root-b", canonicalPath: externalCanonical, kind: "directory" as const };
      const authority = createHarnessPathAuthority({
        authorityId: "cross-dir-authority",
        documents: {
          inspectWorkspace: async (id) => {
            if (id === externalRoot.workspaceId) return { root: externalRoot.canonicalPath };
            return { root };
          },
          findContainingResourceRoot: async (canonical) => {
            const rel = path.relative(externalRoot.canonicalPath, canonical);
            return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? externalRoot : null;
          },
          ensureResourceRoot: async (canonical, kind) => {
            assert.equal(kind, "file");
            return { workspaceId: "external-root-file", canonicalPath: canonical, kind };
          },
        },
      });
      const session = await setupSession({
        root,
        faux,
        harnessDocumentRead: true,
        authorizeWorkspacePath: (actor, candidate, options) => authority.resolve(actor, candidate, options),
        serviceHostOptions: {
          pathAuthority: authority,
          documentReadSource: async (_sessionId, _context, resourceId) => {
            assert.equal(resourceId, "notes.md");
            return { status: "disk" as const };
          },
          readAuthorizedDiskFile: (ctx, authorized) => authority.readAuthorizedFile(ctx.actor, authorized, ctx.signal),
        },
      });
      try {
        const created = await session.host.create(root);
        await session.host.prompt(created.sessionId, "Read the external file");
        await session.host.session.waitForIdle();
        assert.match(toolResult, /external payload/, JSON.stringify(toolResult));
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — work focus", () => {
  it("applies research only at run boundaries without retaining its prompt after code resumes", async () => {
    await withTempRoot("varin-work-focus-", async (root) => {
      await writeFile(join(root, "observation.txt"), "measured result\n", "utf8");
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("code turn"); },
        (context) => {
          contexts.push(structuredClone(context));
          return fauxAssistantMessage([fauxToolCall("read", { path: "observation.txt" })]);
        },
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("research turn"); },
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("code again"); },
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("research again"); },
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(
          root,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { id: "code", source: "product-default" },
        );
        await session.host.prompt(snapshot.sessionId, "implement a small change");
        await session.host.session.waitForIdle();
        assert.doesNotMatch(contexts[0]?.systemPrompt ?? "", /varin-work-focus id="research"/);

        assert.equal(session.host.applyWorkFocus(snapshot.sessionId, { id: "research", source: "explicit" }, 2), true);
        await session.host.prompt(snapshot.sessionId, "investigate the observation");
        await session.host.session.waitForIdle();
        assert.match(contexts[1]?.systemPrompt ?? "", /principal researcher/);
        assert.equal(contexts[2]?.systemPrompt, contexts[1]?.systemPrompt);
        assert.equal(session.host.snapshot().workFocus?.active.id, "research");

        assert.equal(session.host.applyWorkFocus(snapshot.sessionId, { id: "code", source: "explicit" }, 3), true);
        await session.host.prompt(snapshot.sessionId, "implement the selected analysis");
        await session.host.session.waitForIdle();
        assert.doesNotMatch(contexts[3]?.systemPrompt ?? "", /varin-work-focus id="research"/);

        assert.equal(session.host.applyWorkFocus(snapshot.sessionId, { id: "research", source: "explicit" }, 4), true);
        await session.host.prompt(snapshot.sessionId, "test a competing explanation");
        await session.host.session.waitForIdle();
        assert.equal((contexts[4]?.systemPrompt?.match(/<varin-work-focus id="research">/g) ?? []).length, 1);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("keeps the applied code focus when research preparation is rejected during a live run", async () => {
    await withTempRoot("varin-work-focus-failure-", async (root) => {
      const faux = registerFauxProvider();
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      faux.setResponses([
        async () => { entered(); await delayed; return fauxAssistantMessage("code turn done"); },
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(root);
        const running = session.host.prompt(snapshot.sessionId, "keep the code run active");
        await waiting;
        assert.throws(
          () => session.host.applyWorkFocus(snapshot.sessionId, { id: "research", source: "explicit" }, 2),
          /only be applied before a new user run/i,
        );
        assert.equal(session.host.snapshot().workFocus?.active.id, "code");
        release();
        await running;
        await session.host.session.waitForIdle();
      } finally {
        release?.();
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("uses the bounded research identity for a spawned branch session", async () => {
    await withTempRoot("varin-work-focus-branch-", async (root) => {
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("branch finding"); },
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(
          root,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { id: "research", source: "explicit" },
          1,
          "branch",
        );
        await session.host.prompt(snapshot.sessionId, "check the bounded alternative");
        await session.host.session.waitForIdle();
        assert.match(contexts[0]?.systemPrompt ?? "", /independent research branch/);
        assert.doesNotMatch(contexts[0]?.systemPrompt ?? "", /principal researcher/);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — passive thread input", () => {
  it("shows a passive note in the next actual tool continuation without adding a turn", async () => {
    await withTempRoot("varin-passive-tool-boundary-", async (root) => {
      await writeFile(join(root, "note-source.txt"), "tool result", "utf8");
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const delayed = new Promise<void>((resolve) => { release = resolve; });
      faux.setResponses([
        async (context) => { contexts.push(structuredClone(context)); entered(); await delayed;
          return fauxAssistantMessage([fauxToolCall("read", { path: "note-source.txt" })]); },
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("done"); },
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "read note-source.txt");
        await waiting;
        await session.host.notify(snapshot.sessionId, "intra-turn-note", "NOTE_AT_TOOL_BOUNDARY_739");
        release();
        await session.host.session.waitForIdle();
        assert.equal(contexts.length, 2, "one original request plus its existing tool continuation only");
        assert.equal(JSON.stringify(contexts[1]!.messages).match(/NOTE_AT_TOOL_BOUNDARY_739/g)?.length, 1);
      } finally { release?.(); await session.dispose(); faux.unregister(); }
    });
  });

  it("deduplicates concurrent execution requests and replays a native receipt after reopening", async () => {
    await withTempRoot("varin-thread-request-receipt-", async (root) => {
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("initial task done"); },
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("request handled"); },
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "initial task");
        await session.host.session.waitForIdle();
        const outcomes = await Promise.all(Array.from({ length: 4 }, () => session.host.requestThreadMessage(
          snapshot.sessionId, "request-once", "REQUEST_BODY_739",
        )));
        assert.ok(outcomes.every((result) => result.accepted));
        await session.host.session.waitForIdle();
        assert.equal(contexts.length, 2);
        assert.equal(JSON.stringify(contexts[1]!.messages).match(/REQUEST_BODY_739/g)?.length, 1);
        const sessionFile = session.host.session.sessionFile!;
        await session.host.close(snapshot.sessionId);
        await session.host.open({ cwd: root, sessionFile });
        assert.deepEqual(await session.host.requestThreadMessage(snapshot.sessionId, "request-once", "REQUEST_BODY_739"), {
          accepted: true, alreadyDelivered: true,
        });
        assert.equal(session.host.snapshot().busy, false);
        assert.equal(contexts.length, 2);
        await assert.rejects(session.host.requestThreadMessage(snapshot.sessionId, "request-once", "different input"), /different input/);
      } finally { await session.dispose(); faux.unregister(); }
    });
  });
  it("persists a notification without waking an idle model and deduplicates the Pi receipt", async () => {
    await withTempRoot("varin-passive-idle-", async (root) => {
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("ready"); },
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("read the note"); },
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "initial work");
        await session.host.session.waitForIdle();
        assert.deepEqual(await session.host.notify(snapshot.sessionId, "note-1", "PASSIVE_NOTE_739"), {
          accepted: true, alreadyDelivered: false,
        });
        assert.deepEqual(await session.host.notify(snapshot.sessionId, "note-1", "PASSIVE_NOTE_739"), {
          accepted: true, alreadyDelivered: true,
        });
        await assert.rejects(session.host.notify(snapshot.sessionId, "note-1", "different message"), /different input/);
        assert.equal(session.host.snapshot().busy, false);
        assert.equal(session.host.snapshot().pendingMessageCount, 0);
        assert.equal(contexts.length, 1, "a passive message must not request another model response");
        const raw = await readFile(session.host.session.sessionFile!, "utf8");
        assert.equal(raw.match(/PASSIVE_NOTE_739/g)?.length, 1, "the actual Pi JSONL owns one durable receipt");
        await session.host.prompt(snapshot.sessionId, "continue normal work");
        await session.host.session.waitForIdle();
        assert.equal(contexts.length, 2);
        assert.equal(JSON.stringify(contexts[1]!.messages).match(/PASSIVE_NOTE_739/g)?.length, 1);
      } finally { await session.dispose(); faux.unregister(); }
    });
  });

  it("does not schedule a follow-up when inform arrives during an actual model request", async () => {
    await withTempRoot("varin-passive-active-", async (root) => {
      const faux = registerFauxProvider();
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const held = new Promise<void>((resolve) => { release = resolve; });
      const contexts: Context[] = [];
      faux.setResponses([
        async (context) => { contexts.push(structuredClone(context)); entered(); await held; return fauxAssistantMessage("finished"); },
        (context) => { contexts.push(structuredClone(context)); return fauxAssistantMessage("continued"); },
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "work while a note arrives");
        await started;
        await session.host.notify(snapshot.sessionId, "note-active", "NOTE_DURING_REQUEST_739");
        release();
        await session.host.session.waitForIdle();
        assert.equal(contexts.length, 1);
        assert.equal(session.host.snapshot().pendingMessageCount, 0);
        await session.host.prompt(snapshot.sessionId, "next explicit request");
        await session.host.session.waitForIdle();
        assert.equal(contexts.length, 2);
        assert.match(JSON.stringify(contexts[1]!.messages), /NOTE_DURING_REQUEST_739/);
      } finally { release(); await session.dispose(); faux.unregister(); }
    });
  });
});

// ── Zone 2 ─────────────────────────────────────────────────────────

describe("session e2e — zone2 extension", () => {
  it("sends only new material and rebuilds only material actually removed by a native Pi cut", async () => {
    await withTempRoot("varin-zone2-retained-", async (root) => {
      const faux = registerFauxProvider();
      const requests: Context[] = [];
      faux.setResponses(Array.from({ length: 4 }, () => (context: Context) => {
        requests.push(structuredClone(context)); return fauxAssistantMessage("ok");
      }));
      let plan = "PLAN_ORIGINAL_739";
      const session = await setupSession({ root, faux, serviceHostOptions: {
        zone2Provider: async () => ({ eventCursor: 0, material: {
          userEdits: [], userCommands: [], newDiagnostics: [], git: null,
          knowledge: [{ id: 2, title: "KNOWLEDGE_739", trigger: "work" }],
          blocks: [{ label: "plan", content: plan }], blocksComplete: true,
          contextUsage: { used: 345, window: 1000 },
        } }),
      } });
      try {
        const snapshot = await session.host.create(root);
        const prompt = async (text: string) => {
          await session.host.prompt(snapshot.sessionId, text); await session.host.session.waitForIdle();
        };
        await prompt("first");
        await prompt("second");
        const second = JSON.stringify(requests[1]!.messages);
        assert.equal(second.match(/PLAN_ORIGINAL_739/g)?.length, 1);
        assert.equal(second.match(/KNOWLEDGE_739/g)?.length, 1);
        assert.doesNotMatch(second, /window used/);
        plan = "PLAN_CORRECTED_739";
        await prompt("third");
        const manager = session.host.session.sessionManager;
        const kept = manager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "user");
        assert.ok(kept);
        // Arrange a real Pi boundary retaining the third prompt and its new
        // plan, but not the older knowledge presentation. Summary generation
        // is covered separately by the controlled-provider compaction tests.
        const compactId = manager.appendCompaction("Earlier work completed", kept.id, 1000);
        const entry = manager.getEntry(compactId);
        assert.ok(entry?.type === "compaction");
        session.host.session.agent.state.messages = manager.buildSessionContext().messages;
        await session.host.session.extensionRunner?.emit({ type: "session_compact", compactionEntry: entry,
          fromExtension: true, reason: "manual", willRetry: false });
        await prompt("fourth");
        const actual = JSON.stringify(requests[3]!.messages);
        assert.equal(actual.match(/PLAN_CORRECTED_739/g)?.length, 1, "retained corrected plan must not be duplicated");
        assert.equal(actual.match(/KNOWLEDGE_739/g)?.length, 1, "knowledge outside the raw retained interval must be available again");
        assert.doesNotMatch(actual, /PLAN_ORIGINAL_739/);
        assert.match(await readFile(session.host.session.sessionFile!, "utf8"), /PLAN_ORIGINAL_739/);
      } finally { await session.dispose(); faux.unregister(); }
    });
  });
  it("carries a committed editor mutation through the Host store into the next real Pi turn", async () => {
    await withTempRoot("varin-s-zone2-documents-", async (root) => {
      const dataDir = join(root, "data");
      let observeMutation = (_event: DocumentMutationObservation): void => {};
      const documents = createDocumentAuthority({
        hostId: "zone2-host",
        dataDir,
        isAllowedRoot: async () => true,
        isTrusted: async () => true,
        onMutation: (event) => observeMutation(event),
      });
      const identity = await documents.resolveWorkspace({ path: root });
      const store = await openWorkspaceKnowledge({
        dataDir,
        hostId: "zone2-host",
        workspaceId: identity.workspaceId,
        embedding: null,
      });
      const knowledge = createKnowledgeContextRuntime({ getStore: async () => store });
      observeMutation = (event) => knowledge.observeDocumentMutation(event);
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(context); return fauxAssistantMessage("first done"); },
        (context) => { contexts.push(context); return fauxAssistantMessage("second done"); },
        (context) => { contexts.push(context); return fauxAssistantMessage("third done"); },
      ]);
      const session = await setupSession({
        root,
        faux,
        serviceHostOptions: { zone2Provider: (request) => knowledge.zone2Material(request) },
      });

      try {
        const snapshot = await session.host.create(root);
        knowledge.bindSession(snapshot.sessionId, identity.workspaceId);
        await session.host.prompt(snapshot.sessionId, "first turn");
        await session.host.session.waitForIdle();

        const write = await documents.write({
          resource: { workspaceId: identity.workspaceId, resourceId: "edited-between-turns.ts" },
          token: { workspaceId: identity.workspaceId, epoch: identity.epoch, owner: { kind: "web-route", id: "editor" } },
          expectedRevision: null,
          content: "export const changedByUser = true;\n",
          encoding: "utf-8",
          bom: false,
          operationId: randomUUID(),
        });
        assert.equal(write.status, "written");
        await knowledge.drain();

        await session.host.prompt(snapshot.sessionId, "second turn");
        await session.host.session.waitForIdle();
        assert.doesNotMatch(JSON.stringify(contexts[0]!.messages), /edited-between-turns/);
        assert.match(JSON.stringify(contexts[1]!.messages), /modified|created/);
        assert.match(JSON.stringify(contexts[1]!.messages), /edited-between-turns\.ts/);
        await session.host.prompt(snapshot.sessionId, "third turn");
        await session.host.session.waitForIdle();
        assert.equal(
          JSON.stringify(contexts[2]!.messages).match(/edited-between-turns\.ts/g)?.length,
          1,
          "the delivered event must remain in history without being appended a second time",
        );
      } finally {
        await session.dispose();
        await knowledge.dispose();
        await store.close();
        await documents.dispose();
        faux.unregister();
      }
    });
  });

  it("carries a user terminal command through the Host store into the next real Pi turn", async () => {
    await withTempRoot("varin-s-zone2-terminal-", async (root) => {
      const dataDir = join(root, "data");
      const documents = createDocumentAuthority({
        hostId: "zone2-term-host",
        dataDir,
        isAllowedRoot: async () => true,
        isTrusted: async () => true,
      });
      const identity = await documents.resolveWorkspace({ path: root });
      const store = await openWorkspaceKnowledge({
        dataDir,
        hostId: "zone2-term-host",
        workspaceId: identity.workspaceId,
        embedding: null,
      });
      const knowledge = createKnowledgeContextRuntime({ getStore: async () => store });
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(context); return fauxAssistantMessage("first done"); },
        (context) => { contexts.push(context); return fauxAssistantMessage("second done"); },
        (context) => { contexts.push(context); return fauxAssistantMessage("third done"); },
      ]);
      const session = await setupSession({
        root,
        faux,
        serviceHostOptions: { zone2Provider: (request) => knowledge.zone2Material(request) },
      });

      try {
        const snapshot = await session.host.create(root);
        knowledge.bindSession(snapshot.sessionId, identity.workspaceId);
        await session.host.prompt(snapshot.sessionId, "first turn");
        await session.host.session.waitForIdle();

        knowledge.observeTerminalCommand({
          workspaceId: identity.workspaceId,
          sessionId: "term-user",
          command: "echo varin-user-terminal",
          commandId: "term-user:1:1",
          cwd: root,
          exitCode: 0,
          source: "user",
          integration: "osc-633",
          endedAt: Date.now(),
        });
        knowledge.observeTerminalCommand({
          workspaceId: identity.workspaceId,
          sessionId: "term-user",
          command: "echo varin-user-terminal",
          commandId: "term-user:1:1",
          exitCode: 0,
          source: "user",
          integration: "osc-633",
        });
        knowledge.observeTerminalExit({
          workspaceId: identity.workspaceId,
          sessionId: "sh_1",
          command: "agent-build",
          commandId: "sh_1:1:1",
          exitCode: 0,
          source: "harness",
        });
        await knowledge.drain();

        await session.host.prompt(snapshot.sessionId, "second turn");
        await session.host.session.waitForIdle();
        const second = JSON.stringify(contexts[1]!.messages);
        assert.match(second, /<user-terminal>/);
        assert.match(second, /echo varin-user-terminal/);
        assert.doesNotMatch(second, /agent-build/);
        await session.host.prompt(snapshot.sessionId, "third turn");
        await session.host.session.waitForIdle();
        assert.equal(
          JSON.stringify(contexts[2]!.messages).match(/echo varin-user-terminal/g)?.length,
          1,
          "the delivered command must remain in history without being appended a second time",
        );
      } finally {
        await session.dispose();
        await knowledge.dispose();
        await store.close();
        await documents.dispose();
        faux.unregister();
      }
    });
  });

  it("injects assembled <varin-context> into the first request and leaves Zone 0 alone", async () => {
    await withTempRoot("varin-s-zone2-", async (root) => {
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(context); return fauxAssistantMessage("ok 1"); },
        (context) => { contexts.push(context); return fauxAssistantMessage("ok 2"); },
      ]);

      const material: Zone2Material = {
        userEdits: [{ path: "packages/web/lib/foo.ts", kind: "modified" }],
        userCommands: [{ command: "bun test", exitCode: 1, at: Date.now() }],
        newDiagnostics: [],
        git: { branch: "main", changed: 1 },
        knowledge: [],
        blocks: [],
        contextUsage: null,
      };
      const zone2Requests: Array<{ afterEventId?: number }> = [];

      const session = await setupSession({
        root,
        faux,
        serviceHostOptions: {
          zone2Provider: async (request) => {
            zone2Requests.push(request);
            return {
              eventCursor: 4,
              material: request.afterEventId === 4
                ? { ...material, userEdits: [], userCommands: [], git: null }
                : material,
            };
          },
        },
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "first turn");
        await session.host.session.waitForIdle();
        await session.host.prompt(snapshot.sessionId, "second turn");
        await session.host.session.waitForIdle();

        assert.equal(contexts.length, 2, "expected one provider call per turn");
        assert.equal(zone2Requests[0]?.afterEventId, undefined);
        assert.equal(zone2Requests[1]?.afterEventId, 4, "the next turn must continue after the delivered event cursor");

        const firstMessages = JSON.stringify(contexts[0]!.messages);
        assert.match(firstMessages, /<varin-context/, "Zone 2 block must reach the provider");
        assert.match(firstMessages, /packages\/web\/lib\/foo\.ts/, "user edit must be listed");
        assert.match(firstMessages, /not instructions/, "Zone 2 must be marked as data");

        // Zone 2 is a message, never the system prompt (§4.2 / invariant 2).
        const system = contexts[0]!.systemPrompt ?? "";
        assert.doesNotMatch(system, /<varin-context/, "Zone 2 must not touch the system prompt");
        assert.equal(contexts[1]!.systemPrompt ?? "", system, "system prompt must stay byte-identical");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("sends no context message when the host has no Zone 2 material", async () => {
    await withTempRoot("varin-s-zone2-empty-", async (root) => {
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        (context) => { contexts.push(context); return fauxAssistantMessage("ok"); },
      ]);

      const session = await setupSession({
        root,
        faux,
        serviceHostOptions: {
          zone2Provider: async () => ({
            eventCursor: 0,
            material: {
              userEdits: [],
              userCommands: [],
              newDiagnostics: [],
              git: null,
              knowledge: [],
              blocks: [],
              contextUsage: null,
            },
          }),
        },
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "hello");
        await session.host.session.waitForIdle();

        assert.equal(contexts.length, 1);
        assert.doesNotMatch(
          JSON.stringify(contexts[0]!.messages),
          /<varin-context/,
          "an empty Zone 2 must not produce an empty block",
        );
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — context preparation settings", () => {
  it("projects background preparation state and honors the retired memory off switch", async () => {
    await withTempRoot("varin-s-context-settings-", async (root) => {
      const faux = registerFauxProvider();
      let session: Awaited<ReturnType<typeof setupSession>> | undefined;
      try {
        session = await setupSession({ root, faux });
        const created = await session.host.create(root);
        assert.equal(created.harness?.context.backgroundPreparation, true);
        assert.equal(created.harness?.context.candidate, "none");

        const settings = await session.host.getSettings();
        await assert.rejects(
          session.host.updateSettings("global", {
            harness: { context: { preparationWaterline: 2 } },
          }, [], settings.globalRevision),
          /harness\.context\.preparationWaterline/,
        );
        await session.host.updateSettings("global", {
          harness: { context: { backgroundPreparation: false } },
        }, [], settings.globalRevision);
        assert.equal(session.host.snapshot().harness?.context.backgroundPreparation, false);
        await session.dispose();
        session = undefined;

        // A retired harness.memory.mode: "off" or shadowMode: false was the
        // user's explicit opt-out of background maintenance; it disables
        // background preparation only, never automatic compaction.
        await writeFile(join(root, "agent", "settings.json"), JSON.stringify({
          harness: { memory: { mode: "off" } },
        }), "utf8");
        session = await setupSession({ root, faux });
        const legacyOff = await session.host.create(root);
        assert.equal(legacyOff.harness?.context.backgroundPreparation, false);
      } finally {
        await session?.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — context preparation chain", () => {
  for (const outcome of ["commit", "cancel", "invalid-summary"] as const) it(`fixed candidate ${outcome}: foreground progress, capacity admission, and native history`, async () => {
    await withTempRoot("varin-fixed-context-chain-", async (root) => {
      await mkdir(join(root, "agent"), { recursive: true });
      await writeFile(join(root, "agent", "settings.json"), JSON.stringify({
        compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 4_000 },
        harness: { context: { preparationWaterline: 0.5 } },
      }), "utf8");
      await writeFile(join(root, "new-material.txt"), "RAW-TOOL-MATERIAL " + "observed ".repeat(800), "utf8");
      // Leave the first two turns below capacity and make the third cross it
      // despite platform-dependent system-prompt path lengths.
      const faux = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 44_000, maxTokens: 800, reasoning: true }] });
      let releaseSummary!: () => void;
      const gate = new Promise<void>((resolve) => { releaseSummary = resolve; });
      let markCompactionStarted!: () => void;
      const compactionStarted = new Promise<void>((resolve) => { markCompactionStarted = resolve; });
      let markSummaryRequested!: () => void;
      const summaryRequested = new Promise<void>((resolve) => { markSummaryRequested = resolve; });
      const summaries: { context: Context; reasoning?: string }[] = [];
      const foreground: Context[] = [];
      const compacted: string[] = [];
      let session: Awaited<ReturnType<typeof setupSession>> | undefined;
      let historyResult = "";
      let requestHistory = false;
      const respond = (context: Context, options: { cacheRetention?: string; reasoning?: string } | undefined) => {
        if (options) options.cacheRetention = "none"; // avoid faux's overlapping synthetic cache accounting
        if (context.systemPrompt?.includes("background compaction agent")) {
          markSummaryRequested();
          summaries.push({ context, ...(options?.reasoning ? { reasoning: options.reasoning } : {}) });
          return summaries.length === 1
            ? gate.then(() => outcome === "invalid-summary"
              // The worker agent owns a read-only surface: an attempted write
              // is never executed, and an errored/empty result is rejected.
              ? fauxAssistantMessage([fauxToolCall("write", { path: "unexpected-summary-write.txt", content: "must not execute" })],
                { stopReason: "error", errorMessage: "invalid summary" })
              : fauxAssistantMessage("FIRST FIXED SUMMARY: the initial task remains binding; older entries remain in native history."))
            : fauxAssistantMessage("NEXT CANDIDATE: continue the same task.");
        }
        foreground.push(context);
        if (foreground.length === 2) {
          // The dedicated worker's own model call lands asynchronously; the
          // blocked summary gate below proves the task is already in flight.
          return fauxAssistantMessage([fauxToolCall("read", { path: "new-material.txt" })]);
        }
        if (requestHistory) {
          requestHistory = false;
          return fauxAssistantMessage([fauxToolCall("history", { query: "ORIGINAL-TASK-MARKER" })]);
        }
        const history = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "history");
        if (history) historyResult = JSON.stringify(history);
        return fauxAssistantMessage("Foreground completion.");
      };
      faux.setResponses(Array.from({ length: 24 }, () => respond));
      try {
        session = await setupSession({
          root,
          faux,
          serviceHostOptions: { onSessionCompacted: (id) => compacted.push(id) },
          observeHostEvent: (event, data) => {
            if (event === "agent.event" && (data as { event?: { type?: string } }).event?.type === "compaction_start") {
              markCompactionStarted();
            }
          },
        });
        const created = await session.host.create(root);
        session.host.session.setThinkingLevel("high");
        await session.host.prompt(created.sessionId, "ORIGINAL-TASK-MARKER " + "alpha ".repeat(6_000));
        await session.host.session.waitForIdle();
        assert.equal(summaries.length, 0, "an ordinary completed turn must not schedule idle summarization");

        await session.host.prompt(created.sessionId, "KEPT-RAW-MARKER " + "beta ".repeat(8_000));
        await session.host.session.waitForIdle();
        assert.equal(foreground.length, 3, "both the foreground tool call and its continuation finish while the summary remains blocked");
        // The worker's own model call reaches the provider asynchronously;
        // it is still gated when the foreground turn is already complete.
        await summaryRequested;
        assert.equal(summaries.length, 1);
        assert.equal(compacted.length, 0, "preparing a candidate cannot reset observers or publish a boundary");
        const kept = session.host.session.sessionManager.getBranch().find((entry) => entry.type === "message"
          && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("KEPT-RAW-MARKER"));
        assert.ok(kept);
        // The dedicated compaction worker runs its own agent context: the
        // shared compaction system prompt plus the read-only query schemas —
        // never the session's executable tool surface.
        const workerContext = summaries[0]!.context;
        assert.match(workerContext.systemPrompt ?? "", /background compaction agent/);
        assert.deepEqual(workerContext.tools?.map((tool) => tool.name), ["history", "output", "records"],
          "the worker exposes only the read-only query tools");
        assert.equal(summaries[0]!.reasoning, "high", "the worker keeps the session's resolved reasoning level");
        const boundaryIndex = workerContext.messages.findIndex((message) =>
          JSON.stringify(message).includes("Retained material begins"));
        assert.ok(boundaryIndex > 0, "the worker material carries the retained-material marker");
        const summarizedRange = JSON.stringify(workerContext.messages.slice(0, boundaryIndex));
        const retainedRange = JSON.stringify(workerContext.messages.slice(boundaryIndex));
        assert.ok(summarizedRange.includes("ORIGINAL-TASK-MARKER"), "the replaced range reaches the worker");
        assert.ok(retainedRange.includes("KEPT-RAW-MARKER"), "retained material B is provided verbatim below the marker");
        assert.ok(!summarizedRange.includes("KEPT-RAW-MARKER"), "the fixed kept suffix is not part of the summarized prefix");

        const pending = (async () => {
          await session!.host.prompt(created.sessionId, "NEW-WHILE-PREPARING-MARKER " + "delta ".repeat(10_000));
          await session!.host.session.waitForIdle();
        })();
        await Promise.race([
          compactionStarted,
          pending.then(() => { throw new Error("capacity-bound request completed without entering compaction"); }),
        ]);
        assert.equal(session.host.snapshot().isCompacting, true);
        assert.equal(foreground.length, 3, "the capacity-bound request waits before reaching the provider");
        assert.equal(summaries.length, 1, "capacity waits on the same in-flight call");
        if (outcome === "cancel") await session.host.abort(created.sessionId);
        releaseSummary();
        await pending;
        if (outcome !== "commit") {
          assert.equal(foreground.length, 3, "a cancelled or failed summary cannot admit the over-capacity request");
          assert.equal(summaries.length, 1, "failure does not start a second summary implementation");
          assert.equal(compacted.length, 0);
          const original = session.host.session.sessionManager.getEntries();
          assert.ok(!original.some((entry) => entry.type === "compaction"));
          for (const marker of ["ORIGINAL-TASK-MARKER", "KEPT-RAW-MARKER", "NEW-WHILE-PREPARING-MARKER"]) {
            assert.ok(original.some((entry) => entry.type === "message" && entry.message.role === "user"
              && JSON.stringify(entry.message.content).includes(marker)), marker + " must remain verbatim");
          }
          await assert.rejects(readFile(join(root, "unexpected-summary-write.txt")), { code: "ENOENT" });
          return;
        }
        assert.equal(foreground.length, 4);
        const entries = session.host.session.sessionManager.getEntries();
        const committed = entries.find((entry) => entry.type === "compaction");
        assert.equal(committed?.type, "compaction");
        if (committed?.type !== "compaction") throw new Error("missing native boundary");
        assert.equal(committed.firstKeptEntryId, kept.id, "new tool output and prompts cannot move the fixed cut forward");
        assert.match(committed.summary, /FIRST FIXED SUMMARY/);
        assert.match(JSON.stringify(foreground[3]), /KEPT-RAW-MARKER/);
        assert.match(JSON.stringify(foreground[3]), /NEW-WHILE-PREPARING-MARKER/);
        assert.match(JSON.stringify(foreground[3]), /RAW-TOOL-MATERIAL/);
        assert.ok(!JSON.stringify(foreground[3]).includes("ORIGINAL-TASK-MARKER"));
        assert.deepEqual(compacted, [created.sessionId]);

        requestHistory = true;
        await session.host.prompt(created.sessionId, "Read the original initial task from history.");
        await session.host.session.waitForIdle();
        assert.match(historyResult, /ORIGINAL-TASK-MARKER/);
        assert.match(historyResult, /entry [0-9a-f]+/);
        assert.ok(session.host.session.sessionManager.getEntries().some((entry) => entry.type === "message"
          && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("ORIGINAL-TASK-MARKER")));
      } finally {
        releaseSummary();
        await session?.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — native file pagination", () => {
  it("keeps the native file page intact and follows its read continuation", async () => {
    await withTempRoot("varin-s-large-read-", async (root) => {
      await writeFile(
        join(root, "large.txt"),
        Array.from({ length: 8_000 }, (_, index) => `line ${index + 1} — 大文件`).join("\n"),
        "utf8",
      );
      const faux = registerFauxProvider();
      let nextLine = 0;
      let pagedContext = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("read", { path: "large.txt" })]),
        (context) => {
          const serialized = serializedToolResult(context, "read");
          assert.ok(serialized.includes("line 1000 — 大文件"), "middle content of the requested native page must survive");
          assert.ok(!serialized.includes("line 8000 — 大文件"), "the native tool owns file pagination");
          assert.doesNotMatch(serialized, /ephemeral, generation/);
          nextLine = 8000;
          return fauxAssistantMessage([fauxToolCall("read", { path: "large.txt", offset: nextLine, limit: 1 })]);
        },
        (context) => {
          pagedContext = serializedToolResult(context, "read");
          return fauxAssistantMessage("done");
        },
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "inspect the large file");
        await session.host.session.waitForIdle();
        assert.equal(nextLine, 8000);
        assert.match(pagedContext, /line 8000/);
        assert.doesNotMatch(pagedContext, /ephemeral, generation/);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — fixed surface read", () => {
  it("uses the Host-advertised read override inside a real Pi turn", async () => {
    await withTempRoot("varin-s-surface-read-", async (root) => {
      await writeFile(join(root, "draft.ts"), "stale disk value\n", "utf8");
      const faux = registerFauxProvider();
      let toolResult = "";
      let authorizedReadPath: string | undefined;
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("read", { path: "draft.ts" })]),
        (context) => {
          toolResult = serializedToolResult(context, "read");
          return fauxAssistantMessage("done");
        },
      ]);
      const session = await setupSession({
        root,
        faux,
        harnessDocumentRead: true,
        serviceHostOptions: {
          commitAgentInputContext: () => ({ committed: true }),
          documentReadSource: (_sessionId, context, resourceId) => {
            assert.equal(context.source, "surface");
            assert.equal(resourceId, "draft.ts");
            return {
              status: "ready",
              bom: false,
              content: "fixed editor value\n",
              encoding: "utf-8",
              revision: "surface-draft:fixed:1",
              source: "surface-draft",
            };
          },
        },
        authorizeWorkspacePath: async (_actor, inputPath) => {
          const absolutePath = path.resolve(inputPath);
          const expectedPath = path.resolve(root, "draft.ts");
          assert.equal(path.isAbsolute(inputPath), true);
          assert.equal(absolutePath, expectedPath);
          authorizedReadPath = absolutePath;
          return {
            authorityId: "session-e2e-authority",
            workspaceId: WORKSPACE_ID,
            canonicalResourceId: absolutePath,
            inputPath,
            resourceId: path.relative(path.resolve(root), absolutePath).split(path.sep).join("/"),
          };
        },
      });
      try {
        const snapshot = await session.host.create(root);
        const inputContext = {
          source: "surface" as const,
          workspaceId: WORKSPACE_ID,
          dirtyPaths: ["draft.ts"],
          snapshot: { status: "ready" as const, ref: "fixed" },
        };
        await session.host.prompt(snapshot.sessionId, "read the current editor", undefined, undefined, inputContext);
        await session.host.session.waitForIdle();

        assert.match(toolResult, /fixed editor value/);
        assert.doesNotMatch(toolResult, /stale disk value/);
        assert.equal(authorizedReadPath, path.resolve(root, "draft.ts"));
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — fixed surface edit", () => {
  it("edits the Host Document Registry buffer from a public Pi edit tool", async () => {
    const harness = await createDocumentAuthorityHarness();
    const durableRecoveryStore = createInMemoryRecoveryDurablePort();
    const inspected = await harness.authority.inspectWorkspace(harness.identity.workspaceId);
    harness.authority.bindDurableMutationStorage(async (_workspaceId, operation) => operation({
      durableRecoveryStore,
      fileStore: createRecoveryFileStore(),
      identity: {
        authorityId: harness.authority.hostId,
        canonicalRoot: inspected.root,
        filesystemProfile: "test",
        workspaceId: harness.identity.workspaceId,
      },
      resourceOperationGate: { run: (_resources, callback) => callback() },
      root: join(harness.dataDir, "agent-mutation-objects"),
    }));
    const live = new Map<string, LiveSurfaceBuffer>();
    const surface = attachLiveSurfaceCompleter(harness.authority, {
      generation: 1,
      live,
      ownerId: "surface",
      workspaceId: harness.identity.workspaceId,
    });
    const paths = createHarnessPathAuthority({
      authorityId: "session-e2e-authority",
      documents: harness.authority,
    });
    try {
      await writeFile(join(harness.workspaceRoot, "draft.ts"), "A disk-only\n", "utf8");
      const disk = await harness.authority.read(harness.resource("draft.ts"));
      if (disk.status !== "ready") throw new Error("Expected draft fixture");
      const binding = {
        baseRevision: disk.revision,
        localEditRevision: 2,
        documentInstanceId: "document-instance",
        bufferHash: hashSurfaceText("B unique-buffer\n"),
        encoding: "utf-8" as const,
        bom: false,
        lineEnding: "lf" as const,
        resource: harness.resource("draft.ts"),
      };
      live.set("draft.ts", { ...binding, content: "B unique-buffer\n" });
      await harness.authority.publishDirtyBuffers({
        generation: 1,
        ownerId: "surface",
        resources: [binding],
        workspaceId: harness.identity.workspaceId,
      });
      const faux = registerFauxProvider();
      let editResult = "";
      let readResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("edit", {
          path: "draft.ts",
          edits: [{ oldText: "B unique-buffer\n", newText: "C unique-buffer\n" }],
        })]),
        (context) => {
          editResult = serializedToolResult(context, "edit");
          return fauxAssistantMessage([fauxToolCall("read", { path: "draft.ts" })]);
        },
        (context) => {
          readResult = serializedToolResult(context, "read");
          return fauxAssistantMessage([fauxToolCall("edit", {
            path: "draft.ts",
            edits: [{ oldText: "C unique-buffer\n", newText: "E unique-buffer\n" }],
          })]);
        },
        (context) => {
          editResult = `${editResult}\n${serializedToolResult(context, "edit")}`;
          return fauxAssistantMessage("done");
        },
      ]);
      const session = await setupSession({
        root: harness.workspaceRoot,
        faux,
        workspaceId: harness.identity.workspaceId,
        harnessDocumentRead: true,
        answerDialog: () => "Allow for this session scope",
        serviceHostOptions: {
          commitAgentInputContext: (sessionId, context) => (
            harness.authority.commitAgentInputSnapshot(sessionId, context)
          ),
          documentReadSource: (sessionId, context, resourceId) => (
            harness.authority.readAgentInputSnapshot(sessionId, context, resourceId)
          ),
          documentSurfaceWrite: (sessionId, context, changes, signal) => (
            harness.authority.applyAgentSurfaceWrite(sessionId, context, changes, signal)
          ),
        },
        authorizeWorkspacePath: (actor, inputPath, options) => paths.resolve(actor, inputPath, options),
      });
      try {
        const snapshot = await session.host.create(harness.workspaceRoot);
        const rebound = await harness.authority.captureAgentInputSnapshot({
          generation: 1,
          ownerId: "surface",
          resources: [{ ...binding, content: "B unique-buffer\n" }],
          sessionId: snapshot.sessionId,
          workspaceId: harness.identity.workspaceId,
        });
        harness.authority.commitAgentInputSnapshot(snapshot.sessionId, rebound);
        await session.host.prompt(
          snapshot.sessionId,
          "edit the unsaved buffer",
          undefined,
          undefined,
          rebound,
        );
        await session.host.session.waitForIdle();

        assert.match(editResult, /Successfully edited|applied/i);
        assert.match(readResult, /C unique-buffer/);
        assert.doesNotMatch(readResult, /A disk-only/);
        assert.doesNotMatch(readResult, /B unique-buffer/);
        assert.equal(live.get("draft.ts")?.content, "E unique-buffer\n");
        assert.equal(await readFile(join(harness.workspaceRoot, "draft.ts"), "utf8"), "A disk-only\n");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    } finally {
      surface.close();
      await harness.cleanup();
    }
  });
});

describe("session e2e — fixed surface find and ls", () => {
  it("enters the Host-advertised same-name overrides for virtual paths and keeps disk paths native", async () => {
    await withTempRoot("varin-s-surface-find-ls-", async (root) => {
      await mkdir(join(root, "disk"), { recursive: true });
      await writeFile(join(root, "disk", "old.ts"), "disk old\n", "utf8");
      const faux = registerFauxProvider();
      let findResult = "";
      let lsResult = "";
      const overlayCalls: string[] = [];
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("find", { path: "nested", pattern: "*.ts" })]),
        (context) => {
          findResult = serializedToolResult(context, "find");
          return fauxAssistantMessage([fauxToolCall("ls", { path: "disk" })]);
        },
        (context) => {
          lsResult = serializedToolResult(context, "ls");
          return fauxAssistantMessage("done");
        },
      ]);
      const session = await setupSession({
        root,
        faux,
        harnessDocumentPathOverlay: true,
        serviceHostOptions: {
          commitAgentInputContext: () => ({ committed: true }),
          documentPathOverlay: (_sessionId, _context, resourceId) => {
            overlayCalls.push(resourceId);
            if (resourceId.endsWith(`${path.sep}nested`)) {
              return {
                status: "ready",
                entries: [
                  { path: ".", kind: "directory" },
                  { path: "new.ts", kind: "file", revision: "surface-draft:fixed" },
                ],
              };
            }
            return { status: "disk" };
          },
        },
        authorizeWorkspacePath: async (_actor, inputPath) => ({
          authorityId: "session-e2e-authority",
          workspaceId: WORKSPACE_ID,
          canonicalResourceId: path.resolve(root, inputPath),
          inputPath,
          resourceId: path.resolve(root, inputPath),
        }),
      });
      try {
        const snapshot = await session.host.create(root);
        const inputContext = {
          source: "surface" as const,
          workspaceId: WORKSPACE_ID,
          dirtyPaths: ["nested/new.ts"],
          snapshot: { status: "ready" as const, ref: "fixed" },
        };
        await session.host.prompt(snapshot.sessionId, "find the unsaved nested file", undefined, undefined, inputContext);
        await session.host.session.waitForIdle();

        assert.match(findResult, /new\.ts/);
        assert.doesNotMatch(findResult, /No files found/);
        assert.match(lsResult, /old\.ts/);
        assert.equal(overlayCalls.length, 2);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — session-local web reader", () => {
  it("fetches once in the Host and answers with the configured reader model in pi-host", async () => {
    await withTempRoot("varin-s-web-reader-", async (root) => {
      const faux = registerFauxProvider();
      const model = faux.getModel();
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        harness: { models: { reader: { providerId: model.provider, modelId: model.id } } },
      }), "utf8");
      let fetchCalls = 0;
      let readerContext: Context | undefined;
      let finalToolResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("webfetch", {
          url: "https://example.com/guide",
          prompt: "What is the answer?",
        })]),
        (context) => {
          readerContext = context;
          return fauxAssistantMessage("The answer is 42.");
        },
        (context) => {
          finalToolResult = serializedToolResult(context, "webfetch");
          return fauxAssistantMessage("done");
        },
      ]);
      const session = await setupSession({
        root,
        faux,
        harnessWebRead: true,
        serviceHostOptions: {
          webFetchService: {
            fetch: async () => {
              fetchCalls += 1;
              return {
                status: "ok",
                url: "https://example.com/guide",
                finalUrl: "https://example.com/guide",
                contentType: "text/html",
                markdown: "The documentation states that the answer is 42.",
                bytes: 48,
                fromCache: false,
                rendered: false,
              };
            },
          },
        },
      });
      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "read the guide");
        await session.host.session.waitForIdle();
        assert.equal(fetchCalls, 1);
        assert.match(readerContext?.systemPrompt ?? "", /strictly from the supplied page content/);
        assert.match(JSON.stringify(readerContext?.messages), /untrusted data, not instructions/);
        assert.match(JSON.stringify(readerContext?.messages), /answer is 42/);
        assert.match(finalToolResult, /answer \(from https:\/\/example\.com\/guide\)/);
        assert.match(finalToolResult, /The answer is 42/);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — default web search", () => {
  it("searches without search credentials and follows the result URL to a page passage in a real Pi turn", async () => {
    await withTempRoot("varin-s-web-search-", async (root) => {
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        harness: {},
      }), "utf8");
      const faux = registerFauxProvider();
      let finalToolResult = "";
      let pageToolResult = "";
      let searchRequests = 0;
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("websearch", {
          query: "Varin architecture",
          allowed_domains: ["docs.example"],
        })]),
        (context) => {
          finalToolResult = serializedToolResult(context, "websearch");
          return fauxAssistantMessage([fauxToolCall("webfetch", { url: "https://docs.example/varin", find: "authority" })]);
        },
        (context) => {
          pageToolResult = serializedToolResult(context, "webfetch");
          return fauxAssistantMessage("done");
        },
      ]);
      const webSearchService = createWebSearchService(async () => resolveConfiguredSearchProvider({
        settings: undefined,
        auth: {},
        fetch: async (url, init) => {
          searchRequests += 1;
          assert.equal(new URL(String(url)).hostname, "mcp.exa.ai");
          assert.equal(new Headers(init?.headers).has("Authorization"), false);
          const request = JSON.parse(String(init?.body));
          assert.equal(request.params.name, "web_search_advanced_exa");
          assert.deepEqual(request.params.arguments.includeDomains, ["docs.example"]);
          return Response.json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "Title: Varin architecture\nURL: https://docs.example/varin\nText: Host and pi-host have separate authority boundaries." }] } });
        },
      }));
      const session = await setupSession({
        root,
        faux,
        harnessWebSearch: true,
        serviceHostOptions: {
          webSearchService,
          webFetchService: { fetch: async (input) => {
            const url = typeof input === "string" ? input : input.url ?? "";
            return { status: "ok" as const, url, finalUrl: url, contentType: "text/plain", markdown: "Architecture\nThe Host owns file authority.\nPi supplies the agent loop.", bytes: 72, fromCache: false, rendered: false };
          } },
        },
      });
      try {
        const snapshot = await session.host.create(root);
        assert.ok(snapshot.activeTools.includes("websearch"));
        await session.host.prompt(snapshot.sessionId, "search for the architecture");
        await session.host.session.waitForIdle();
        assert.equal(searchRequests, 1);
        assert.match(finalToolResult, /default-exa/);
        assert.match(finalToolResult, /https:\/\/docs\.example\/varin/);
        assert.match(finalToolResult, /authority boundaries/);
        assert.match(pageToolResult, /2: The Host owns file authority/);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

// ── Explore ─────────────────────────────────────────────────────────

/**
 * Connect the real Documents reader and release Rust search to setupSession. The
 * regular session fixture intentionally has an empty search provider, so these
 * tests opt into the same Host-side services used by the application host.
 */
async function createExploreFixture(root: string) {
  const workspaceRoot = join(root, "explore-workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const documents = createDocumentAuthority({
    hostId: "explore-session-e2e-host",
    dataDir: join(root, "document-data"),
    isAllowedRoot: async () => true,
    isTrusted: async () => true,
  });
  const identity = await documents.resolveWorkspace({ path: workspaceRoot });
  const paths = createHarnessPathAuthority({
    authorityId: "explore-session-e2e-authority",
    documents,
  });
  const compute = createNativeComputeTestHarness();
  const search = createWorkspaceContentSearch({ documents, pathModule: path, compute });
  return { documents, identity, paths, search, workspaceRoot, compute,
    async dispose() { try { await compute.dispose(); } finally { await documents.dispose(); } },
  };
}

describe("session e2e — explore", () => {
  it("delivers a contiguous, versioned Documents excerpt and a usable output handle to the model", async () => {
    await withTempRoot("varin-s-explore-snapshot-", async (root) => {
      const fixture = await createExploreFixture(root);
      await writeFile(join(fixture.workspaceRoot, "target.ts"), [
        "export const before = 1;",
        "export const contextLine = 2;",
        "export function needle() { return 3; }",
        "export const after = 4;",
      ].join("\n"), "utf8");
      const faux = registerFauxProvider();
      let exploreResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("explore", { question: "needle" })]),
        (context) => {
          exploreResult = serializedToolResult(context, "explore");
          return fauxAssistantMessage("I found the current implementation.");
        },
      ]);
      const session = await setupSession({
        root,
        sessionRoot: fixture.workspaceRoot,
        faux,
        workspaceId: fixture.identity.workspaceId,
        serviceHostOptions: {
          search: (request, options) => fixture.search.searchContent(request, options),
          resolveWorkspaceRoot: async () => fixture.workspaceRoot,
          readExploreFile: createExploreFileReader(fixture.documents, fixture.paths),
        },
        authorizeWorkspacePath: (actor, inputPath, options) => fixture.paths.resolve(actor, inputPath, options),
      });

      try {
        const snapshot = await session.host.create(fixture.workspaceRoot);
        assert.ok(snapshot.activeTools.includes("explore"));
        await session.host.prompt(snapshot.sessionId, "locate needle");
        await session.host.session.waitForIdle();

        assert.match(exploreResult, /target\.ts:1-4/);
        assert.match(
          exploreResult,
          /export const before = 1;\\nexport const contextLine = 2;\\nexport function needle\(\) \{ return 3; \}\\nexport const after = 4;/,
          "the model must receive the contiguous current excerpt",
        );
        assert.match(exploreResult, /"revision":"d1_[A-Za-z0-9_-]+"/);
        assert.match(exploreResult, /Source: disk or fixed editor-draft snapshots/);
        const handle = exploreResult.match(/"handle":"(out_[A-Za-z0-9_-]+)"/)?.[1];
        assert.ok(handle, "the structured result must still issue a session-local output handle");
        const stored = session.harnessServiceHost.outputStore.read(snapshot.sessionId, handle);
        assert.equal(stored.status, "ready");
        assert.match(stored.slice.text, /target\.ts:1-4/);
      } finally {
        await session.dispose();
        await fixture.dispose();
        faux.unregister();
      }
    });
  });

  it("returns a structure slice in one explore.search result, not an extra symbols call", async () => {
    await withTempRoot("varin-s-explore-structure-", async (root) => {
      const fixture = await createExploreFixture(root);
      const body = Array.from({ length: 48 }, (_, index) => (
        index === 23 ? "  const needle = 1;" : `  const pad${index} = ${index};`
      ));
      await writeFile(join(fixture.workspaceRoot, "large.ts"), ["export function largeTarget() {", ...body, "}"].join("\n"), "utf8");
      const structureSource: StructureSource = {
        outline: async (request) => ({
          status: "ready",
          provider: "lsp",
          revision: request.revision,
          symbols: [{
            name: "largeTarget",
            kind: "function",
            range: { startLine: 1, endLine: 50 },
            signature: { startLine: 1, endLine: 1 },
          }],
        }),
        classifyHits: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, hits: [] }),
        literalCalls: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, calls: [] }),
        imports: async (request) => ({ status: "unsupported", provider: "lsp", revision: request.revision, imports: [] }),
      };
      const faux = registerFauxProvider();
      let exploreResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("explore", { question: "needle" })]),
        (context) => {
          exploreResult = serializedToolResult(context, "explore");
          return fauxAssistantMessage("I found the structured unit.");
        },
      ]);
      const session = await setupSession({
        root,
        sessionRoot: fixture.workspaceRoot,
        faux,
        workspaceId: fixture.identity.workspaceId,
        serviceHostOptions: {
          search: (request, options) => fixture.search.searchContent(request, options),
          resolveWorkspaceRoot: async () => fixture.workspaceRoot,
          readExploreFile: createExploreFileReader(fixture.documents, fixture.paths),
          structureSource,
        },
        authorizeWorkspacePath: (actor, inputPath, options) => fixture.paths.resolve(actor, inputPath, options),
      });
      try {
        const snapshot = await session.host.create(fixture.workspaceRoot);
        await session.host.prompt(snapshot.sessionId, "locate needle");
        await session.host.session.waitForIdle();
        assert.match(exploreResult, /"name":"largeTarget"/);
        assert.match(exploreResult, /"kind":"function"/);
        assert.match(exploreResult, /"provider":"lsp"/);
        assert.match(exploreResult, /"status":"ready"/);
        assert.match(exploreResult, /read large\.ts:1-50/);
        assert.match(exploreResult, /… omitted large\.ts:/);
        assert.match(exploreResult, /unit largeTarget \(function\) large\.ts:1-50/);
        assert.doesNotMatch(exploreResult, /"name":"symbols"/);
        assert.doesNotMatch(exploreResult, /lsp\.symbols/);
        assert.match(exploreResult, /large\.ts:1-/);
        assert.ok(
          /"startLine":1/.test(exploreResult) && /"endLine":50/.test(exploreResult),
          "the tool result must carry the full-unit range, not only a ±3 window",
        );
      } finally {
        await session.dispose();
        await fixture.dispose();
        faux.unregister();
      }
    });
  });

  it("reports a stale changed hit as partial through the real Pi tool result", async () => {
    await withTempRoot("varin-s-explore-stale-", async (root) => {
      const fixture = await createExploreFixture(root);
      await writeFile(join(fixture.workspaceRoot, "current.ts"), "export const needle = \"current\";", "utf8");
      await writeFile(join(fixture.workspaceRoot, "changed.ts"), "export const needle = \"before search\";", "utf8");
      let searched = false;
      const faux = registerFauxProvider();
      let exploreResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("explore", { question: "needle" })]),
        (context) => {
          exploreResult = serializedToolResult(context, "explore");
          return fauxAssistantMessage("The changed hit was omitted.");
        },
      ]);
      const session = await setupSession({
        root,
        sessionRoot: fixture.workspaceRoot,
        faux,
        workspaceId: fixture.identity.workspaceId,
        serviceHostOptions: {
          search: async (request, options) => {
            const result = await fixture.search.searchContent(request, options);
            if (!searched && result.status === "ready") {
              searched = true;
              await writeFile(join(fixture.workspaceRoot, "changed.ts"), "export const replacement = \"current\";", "utf8");
            }
            return result;
          },
          resolveWorkspaceRoot: async () => fixture.workspaceRoot,
          readExploreFile: createExploreFileReader(fixture.documents, fixture.paths),
        },
        authorizeWorkspacePath: (actor, inputPath, options) => fixture.paths.resolve(actor, inputPath, options),
      });

      try {
        const snapshot = await session.host.create(fixture.workspaceRoot);
        await session.host.prompt(snapshot.sessionId, "find needle");
        await session.host.session.waitForIdle();

        assert.equal(searched, true, "the test must mutate the source after real search completes");
        assert.match(exploreResult, /partial result/);
        assert.match(exploreResult, /current\.ts/);
        assert.match(exploreResult, /changed\.ts: stale/);
        assert.doesNotMatch(exploreResult, /before search/);
        assert.doesNotMatch(exploreResult, /replacement/);
        assert.match(exploreResult, /"handle":"out_[A-Za-z0-9_-]+"/);
      } finally {
        await session.dispose();
        await fixture.dispose();
        faux.unregister();
      }
    });
  });

  it("reports a missing hit as an unavailable source gap through the real Pi tool result", async () => {
    await withTempRoot("varin-s-explore-missing-", async (root) => {
      const fixture = await createExploreFixture(root);
      await writeFile(join(fixture.workspaceRoot, "current.ts"), "export const needle = \"current\";", "utf8");
      await writeFile(join(fixture.workspaceRoot, "missing.ts"), "export const needle = \"to be removed\";", "utf8");
      let searched = false;
      const faux = registerFauxProvider();
      let exploreResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("explore", { question: "needle" })]),
        (context) => {
          exploreResult = serializedToolResult(context, "explore");
          return fauxAssistantMessage("The missing hit was omitted.");
        },
      ]);
      const session = await setupSession({
        root,
        sessionRoot: fixture.workspaceRoot,
        faux,
        workspaceId: fixture.identity.workspaceId,
        serviceHostOptions: {
          search: async (request, options) => {
            const result = await fixture.search.searchContent(request, options);
            if (!searched && result.status === "ready") {
              searched = true;
              await rm(join(fixture.workspaceRoot, "missing.ts"), { force: true });
            }
            return result;
          },
          resolveWorkspaceRoot: async () => fixture.workspaceRoot,
          readExploreFile: createExploreFileReader(fixture.documents, fixture.paths),
        },
        authorizeWorkspacePath: (actor, inputPath, options) => fixture.paths.resolve(actor, inputPath, options),
      });

      try {
        const snapshot = await session.host.create(fixture.workspaceRoot);
        await session.host.prompt(snapshot.sessionId, "find needle");
        await session.host.session.waitForIdle();

        assert.equal(searched, true, "the test must remove the source after real search completes");
        assert.match(exploreResult, /partial result/);
        assert.match(exploreResult, /current\.ts/);
        assert.match(exploreResult, /missing\.ts: unavailable/);
        assert.doesNotMatch(exploreResult, /to be removed/);
        assert.match(exploreResult, /"handle":"out_[A-Za-z0-9_-]+"/);
      } finally {
        await session.dispose();
        await fixture.dispose();
        faux.unregister();
      }
    });
  });

  it("T9: forwards anchors through the real explore tool and prefers the literal hit", async () => {
    await withTempRoot("varin-s-explore-anchors-", async (root) => {
      const fixture = await createExploreFixture(root);
      await writeFile(join(fixture.workspaceRoot, "generic.ts"), "export const token = 1;\n", "utf8");
      await writeFile(join(fixture.workspaceRoot, "exact.ts"), "export const uniqueAnchor = 2;\n", "utf8");
      const faux = registerFauxProvider();
      let exploreResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("explore", { question: "token", anchors: ["uniqueAnchor"] })]),
        (context) => {
          exploreResult = serializedToolResult(context, "explore");
          return fauxAssistantMessage("The anchor hit was first.");
        },
      ]);
      const session = await setupSession({
        root,
        sessionRoot: fixture.workspaceRoot,
        faux,
        workspaceId: fixture.identity.workspaceId,
        serviceHostOptions: {
          search: (request, options) => fixture.search.searchContent(request, options),
          resolveWorkspaceRoot: async () => fixture.workspaceRoot,
          readExploreFile: createExploreFileReader(fixture.documents, fixture.paths),
        },
        authorizeWorkspacePath: (actor, inputPath, options) => fixture.paths.resolve(actor, inputPath, options),
      });

      try {
        const snapshot = await session.host.create(fixture.workspaceRoot);
        await session.host.prompt(snapshot.sessionId, "locate uniqueAnchor");
        await session.host.session.waitForIdle();

        assert.match(exploreResult, /exact\.ts/);
        assert.match(exploreResult, /uniqueAnchor/);
        assert.match(exploreResult, /"anchors":\["uniqueAnchor"\]|"supplied":\["uniqueAnchor"\]/);
      } finally {
        await session.dispose();
        await fixture.dispose();
        faux.unregister();
      }
    });
  });

  it("runs plan expressions through ModelRuntime and keeps a zero-overlap excerpt in the final source", async () => {
    await withTempRoot("varin-s-explore-model-", async (root) => {
      const fixture = await createExploreFixture(root);
      await writeFile(join(fixture.workspaceRoot, "reclaim.ts"), [
        "export function reclaimLease(handle: string) {",
        "  parkedHandles.delete(handle);",
        "  return handle;",
        "}",
        "",
      ].join("\n"), "utf8");
      const faux = registerFauxProvider();
      const model = faux.getModel();
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        harness: { models: { explore: { providerId: model.provider, modelId: model.id } } },
      }), "utf8");
      const planPrompts: string[] = [];
      let exploreResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("explore", { question: "how does the runtime discard idle tokens" })]),
        (context) => {
          planPrompts.push(JSON.stringify(context));
          return fauxAssistantMessage(JSON.stringify({
            behavior: "discard idle tokens",
            groups: [{ id: "g1", concept: "reclaim", expressions: ["reclaimLease"] }],
          }));
        },
        (context) => {
          const blob = JSON.stringify(context);
          const viewId = blob.match(/view (v\d+)/)?.[1] ?? "v1";
          return fauxAssistantMessage(JSON.stringify({
            groups: [{
              id: "sel1",
              purpose: "reclaim implementation",
              views: [{ viewId, rangeIds: [`${viewId}:full`], required: true }],
            }],
          }));
        },
        (context) => {
          exploreResult = serializedToolResult(context, "explore");
          return fauxAssistantMessage("The reclaim implementation is in reclaimLease.");
        },
      ]);
      const session = await setupSession({
        root,
        sessionRoot: fixture.workspaceRoot,
        faux,
        workspaceId: fixture.identity.workspaceId,
        serviceHostOptions: {
          search: (request, options) => fixture.search.searchContent(request, options),
          resolveWorkspaceRoot: async () => fixture.workspaceRoot,
          readExploreFile: createExploreFileReader(fixture.documents, fixture.paths),
        },
        authorizeWorkspacePath: (actor, inputPath, options) => fixture.paths.resolve(actor, inputPath, options),
      });
      try {
        const snapshot = await session.host.create(fixture.workspaceRoot);
        await session.host.prompt(snapshot.sessionId, "how idle tokens are discarded");
        await session.host.session.waitForIdle();
        assert.match(planPrompts.join("\n"), /discard idle tokens|reclaimLease|how does the runtime/);
        assert.match(exploreResult, /reclaimLease/);
        assert.match(exploreResult, /reclaim\.ts/);
        assert.match(exploreResult, /"plan":"used"/);
        assert.match(exploreResult, /"select":"used"/);
      } finally {
        await session.dispose();
        await fixture.dispose();
        faux.unregister();
      }
    });
  });

  it("uses the remote embedding binding and HTTP rerank on the public explore path", async () => {
    await withTempRoot("varin-s-explore-remote-", async (root) => {
      const fixture = await createExploreFixture(root);
      await writeFile(join(fixture.workspaceRoot, "remote.ts"), [
        "export function remotePineapple() {",
        "  return \"remote pineapple token\";",
        "}",
        "",
      ].join("\n"), "utf8");
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        harness: {
          embedding: { protocol: "openai-compatible", providerId: "embed-provider", modelId: "text-embedding-3-small", dimensions: 2 },
          rerank: { protocol: "http-rerank", providerId: "embed-provider", modelId: "rerank-test" },
        },
      }));
      await writeFile(join(agentDir, "models.json"), JSON.stringify({
        providers: {
          "embed-provider": {
            name: "Embed",
            baseUrl: "https://models.example/v1",
            api: "openai-completions",
            models: [],
          },
        },
      }));
      const faux = registerFauxProvider();
      const model = faux.getModel();
      let exploreResult = "";
      const embedBodies: string[][] = [];
      const rerankBodies: unknown[] = [];
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("explore", { question: "remote pineapple token" })]),
        (context) => {
          exploreResult = serializedToolResult(context, "explore");
          return fauxAssistantMessage("Found the remote pineapple.");
        },
      ]);
      const hostApi: {
        embed?: (params: HarnessEmbedParams) => Promise<HarnessEmbedResult>;
        rerank?: (params: HarnessRerankParams) => Promise<HarnessRerankResult>;
      } = {};
      const inferenceConfigurationId = (modelId: string) => createHash("sha256").update(JSON.stringify({
        providerId: "embed-provider",
        modelId,
        baseUrl: "https://models.example/v1",
        api: "openai-completions",
      })).digest("hex").slice(0, 16);
      const remote = createRemoteEmbedder({
        binding: {
          protocol: "openai-compatible",
          providerId: "embed-provider",
          modelId: "text-embedding-3-small",
          dimensions: 2,
          configurationId: inferenceConfigurationId("text-embedding-3-small"),
        },
        client: {
          embed: async (params) => {
            if (!hostApi.embed) throw new Error("SessionHost embed is not ready");
            return hostApi.embed(params);
          },
        },
      });
      const runtime = createSemanticIndexRuntime({
        dataDir: join(root, "semantic-data"),
        hostId: "explore-remote-e2e",
        documents: fixture.documents,
        structureSource: createStructureSource([createTreeSitterStructureProvider({ compute: fixture.compute, parseBudgetMs: 10_000 })]),
        searchFilesystemFiles: async () => [{
          name: "remote.ts",
          path: join(fixture.workspaceRoot, "remote.ts"),
          relativePath: "remote.ts",
        }],
        embedder: remote,
      });
      const session = await setupSession({
        root,
        sessionRoot: fixture.workspaceRoot,
        faux,
        workspaceId: fixture.identity.workspaceId,
        inferenceFetch: async (url, init) => {
          const parsed = JSON.parse(String(init?.body ?? "{}")) as { input?: string[]; documents?: unknown[] };
          if (String(url).includes("/embeddings")) {
            embedBodies.push(parsed.input ?? []);
            return new Response(JSON.stringify({
              data: (parsed.input ?? []).map((text, index) => ({
                index,
                embedding: text.includes("pineapple") ? [1, 0] : [0, 1],
              })),
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          rerankBodies.push(parsed.documents);
          return new Response(JSON.stringify({
            results: [{ index: 0, id: (parsed.documents as Array<{ id: string }>)?.[0]?.id, relevance_score: 0.91 }],
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        },
        serviceHostOptions: {
          search: (request, options) => fixture.search.searchContent(request, options),
          resolveWorkspaceRoot: async () => fixture.workspaceRoot,
          readExploreFile: createExploreFileReader(fixture.documents, fixture.paths),
          semanticRecall: async (workspaceId, question, limit, searchOptions) => {
            const result = await runtime.search(workspaceScope(workspaceId), question, limit, {
              ...(searchOptions?.signal ? { signal: searchOptions.signal } : {}),
              ...(searchOptions?.roots ? { roots: searchOptions.roots } : {}),
            });
            return {
              status: result.status.status,
              coverage: result.status.coverage,
              lifecycle: result.status.lifecycle,
              hits: result.hits,
              ...(result.status.generation ? { generation: result.status.generation } : {}),
              ...(result.status.spaceId ? { spaceId: result.status.spaceId } : {}),
              scope: result.status.scope,
              ...(result.gaps.length ? { gaps: result.gaps } : {}),
            };
          },
          harnessSettings: () => ({
            global: {
              harness: {
                rerank: { protocol: "http-rerank", providerId: "embed-provider", modelId: "rerank-test" },
              },
            },
            globalRevision: "1",
            project: {},
            projectRevision: "1",
            projectTrusted: true,
          }),
          rerankExploreViews: async (input) => {
            if (!hostApi.rerank) throw new Error("SessionHost rerank is not ready");
            return hostApi.rerank({
              configurationId: inferenceConfigurationId(input.settings.modelId),
              providerId: input.settings.providerId,
              modelId: input.settings.modelId,
              protocol: "http-rerank",
              query: input.query,
              documents: input.documents,
              batchId: "explore-e2e-rerank",
            });
          },
        },
        authorizeWorkspacePath: (actor, inputPath, options) => fixture.paths.resolve(actor, inputPath, options),
      });
      hostApi.embed = (params) => session.host.embed(params);
      hostApi.rerank = (params) => session.host.rerank(params);
      try {
        const snapshot = await session.host.create(fixture.workspaceRoot);
        await session.host.runtime.services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
        await session.host.runtime.services.modelRuntime.setRuntimeApiKey("embed-provider", "embed-key");
        await runtime.scanWorkspace(fixture.identity.workspaceId);
        await session.host.prompt(snapshot.sessionId, "find the remote pineapple");
        await session.host.session.waitForIdle();
        assert.ok(embedBodies.some((batch) => batch.some((text) => text.includes("pineapple"))));
        assert.match(exploreResult, /remote\.ts/);
        assert.match(exploreResult, /remote pineapple/);
        assert.match(exploreResult, /"rerank":"used"|"status":"used"/);
        assert.ok(rerankBodies.length > 0);
        assert.doesNotMatch(exploreResult, /embed-key|faux-key/);
      } finally {
        await runtime.dispose();
        await session.dispose();
        await fixture.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — related", () => {
  it("registers related and returns file-level topology from an already-open store", async () => {
    await withTempRoot("varin-s-related-", async (root) => {
      const fixture = await createExploreFixture(root);
      const store = await openWorkspaceKnowledge({
        dataDir: join(root, "knowledge"),
        hostId: "related-session-e2e-host",
        workspaceId: fixture.identity.workspaceId,
        embedding: null,
      });
      await store.replaceFileSymbols("target.ts", "typescript", [
        { name: "needle", kind: "function", range: { startLine: 0, startCharacter: 0, endLine: 2, endCharacter: 1 } },
      ], "disk-r1", [
        { kind: "import", value: "./dep.js", line: 1 },
        { kind: "connects", value: "related.query", callee: "register", line: 3 },
      ]);
      await store.replaceFileSymbols("dep.ts", "typescript", [
        { name: "dep", kind: "function", range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 3 } },
      ], "disk-r1", [
        { kind: "import", value: "./target.js", line: 1 },
      ]);
      await writeFile(join(fixture.workspaceRoot, "target.ts"), "export function needle() { return 1; }\n", "utf8");
      await writeFile(join(fixture.workspaceRoot, "dep.ts"), "import { needle } from \"./target.js\";\n", "utf8");
      const faux = registerFauxProvider();
      let relatedResult = "";
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("related", { anchor: "target.ts" })]),
        (context) => {
          relatedResult = serializedToolResult(context, "related");
          return fauxAssistantMessage("I have the file topology.");
        },
      ]);
      const session = await setupSession({
        root,
        sessionRoot: fixture.workspaceRoot,
        faux,
        workspaceId: fixture.identity.workspaceId,
        serviceHostOptions: {
          resolveWorkspaceRoot: async () => fixture.workspaceRoot,
          graphRecall: async (_sessionId, executionWorkspaceId) => executionWorkspaceId === fixture.identity.workspaceId
            ? { workspaceId: fixture.identity.workspaceId, store, directFactsCompatible: true }
            : null,
        },
        authorizeWorkspacePath: (actor, inputPath, options) => fixture.paths.resolve(actor, inputPath, options),
      });
      try {
        const snapshot = await session.host.create(fixture.workspaceRoot);
        assert.ok(snapshot.activeTools.includes("related"));
        await session.host.prompt(snapshot.sessionId, "what is related to target.ts");
        await session.host.session.waitForIdle();
        assert.match(relatedResult, /related target\.ts/);
        assert.match(relatedResult, /needle/);
        assert.match(relatedResult, /Imported by/);
        assert.match(relatedResult, /dep\.ts/);
        assert.match(relatedResult, /lsp\.references/);
        assert.doesNotMatch(relatedResult, /rank /);
      } finally {
        await session.dispose();
        await store.close();
        await fixture.dispose();
        faux.unregister();
      }
    });
  });
});

describe("session e2e — real LSP diagnostics", () => {
  it("carries fixture-server diagnostics through the Host bridge into a real Pi turn", async () => {
    const harness = await createDocumentAuthorityHarness();
    const language = createLanguageSupervisor({
      documents: harness.authority,
      spawn,
      pathModule: path,
      isTrusted: async () => true,
    });
    const faux = registerFauxProvider();
    let diagnosticResult = "";
    try {
      const resourceId = "fixture.ts";
      await writeFile(join(harness.workspaceRoot, resourceId), "FIXTURE_ERROR\n", "utf8");
      language.registerProvider({
        providerId: "fixture",
        command: process.execPath,
        args: VARIN_LSP_FIXTURE_SERVER_ARGS,
        languageIds: ["typescript"],
        source: "host",
      });
      const diagnosticsProvider = createLanguageSupervisorDiagnosticsProvider(language, {
        documents: harness.authority,
        resolveWorkspaceId: async () => harness.identity.workspaceId,
      });
      // The provider binds the file's disk text in the Host language view; the
      // editor view is not involved (D-087).
      await diagnosticsProvider.bindDocument(harness.identity.workspaceId, resourceId);
      await waitUntil(async () => (
        (await diagnosticsProvider.getDiagnostics(harness.identity.workspaceId, resourceId))
          .some((diagnostic) => diagnostic.message === "fixture error")
      ));

      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("diagnostics", { path: resourceId, full: true })]),
        (context) => {
          diagnosticResult = serializedToolResult(context, "diagnostics");
          return fauxAssistantMessage("done");
        },
      ]);
      const session = await setupSession({
        root: harness.workspaceRoot,
        faux,
        workspaceId: harness.identity.workspaceId,
        serviceHostOptions: { diagnosticsProvider },
        authorizeWorkspacePath: async (_actor, inputPath) => ({
          authorityId: "session-e2e-authority",
          workspaceId: harness.identity.workspaceId,
          canonicalResourceId: path.resolve(harness.workspaceRoot, inputPath),
          inputPath,
          resourceId: inputPath,
        }),
      });
      try {
        const snapshot = await session.host.create(harness.workspaceRoot);
        await session.host.prompt(snapshot.sessionId, "check the fixture diagnostics");
        await session.host.session.waitForIdle();
        assert.match(diagnosticResult, /fixture error/);
        assert.match(diagnosticResult, /diagnostics/);
      } finally {
        await session.dispose();
      }
    } finally {
      faux.unregister();
      await language.dispose();
      await harness.cleanup();
    }
  });
});

describe("session e2e — Harness counters", () => {
  it("publishes real tool failures, retries, output bytes, observations, and cache ratio through session stats", async () => {
    await withTempRoot("varin-s-counters-", async (root) => {
      const faux = registerFauxProvider();
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("read", { path: "missing-counter-file.txt" })]),
        () => fauxAssistantMessage([fauxToolCall("read", { path: "missing-counter-file.txt" })]),
        () => fauxAssistantMessage([fauxToolCall("diagnostics", { path: "missing-counter-file.txt" })]),
        () => fauxAssistantMessage("done"),
      ]);
      const session = await setupSession({ root, faux });
      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "try the same missing file twice");
        await session.host.session.waitForIdle();
        const stats = session.host.stats(snapshot.sessionId);
        assert.ok((stats.toolErrors ?? 0) >= 2);
        assert.ok((stats.toolRetries ?? 0) >= 1);
        assert.ok((stats.outputBytes ?? 0) > 0);
        assert.ok((stats.observationCalls ?? 0) >= 1);
        assert.equal(typeof stats.cacheHitRatio, "number");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });
});

// ── Permission gate ────────────────────────────────────────────────

describe("session e2e — permission gate extension", () => {
  it("asks before a write and performs it when the user allows once", async () => {
    await withTempRoot("varin-s-perm-allow-", async (root) => {
      const faux = registerFauxProvider();
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "allowed.txt", content: "hi" })]),
        () => fauxAssistantMessage("done"),
      ]);

      const session = await setupSession({
        root,
        faux,
        answerDialog: () => "Allow once",
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "write allowed.txt");
        await session.host.session.waitForIdle();

        assert.equal(session.uiRequests.length, 1, "a write in normal mode must ask exactly once");
        assert.match(
          session.uiRequests[0]!.title,
          /allowed\.txt/,
          "the dialog must name the path being written",
        );
        assert.ok(existsSync(join(root, "allowed.txt")), "allowing once must let the write through");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("blocks the tool and leaves the file alone when the user denies", async () => {
    await withTempRoot("varin-s-perm-deny-", async (root) => {
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "denied.txt", content: "hi" })]),
        (context) => { contexts.push(context); return fauxAssistantMessage("understood"); },
      ]);

      const session = await setupSession({
        root,
        faux,
        answerDialog: () => "Deny",
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "write denied.txt");
        await session.host.session.waitForIdle();

        assert.equal(session.uiRequests.length, 1);
        assert.ok(!existsSync(join(root, "denied.txt")), "a denied write must not touch the disk");
        // The model has to learn it was blocked, and why.
        assert.ok(contexts.length >= 1, "the agent loop must continue after a block");
        assert.match(JSON.stringify(contexts[0]!.messages), /denied/i, "the block reason must reach the model");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("binds a session approval to one resource and always asks for a high-risk path", async () => {
    await withTempRoot("varin-s-perm-session-", async (root) => {
      const faux = registerFauxProvider();
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "one.txt", content: "1" })]),
        () => fauxAssistantMessage([fauxToolCall("write", { path: "two.txt", content: "2" })]),
        () => fauxAssistantMessage([fauxToolCall("write", { path: ".env", content: "SECRET=1" })]),
        () => fauxAssistantMessage("done"),
      ]);

      const session = await setupSession({
        root,
        faux,
        answerDialog: (_request, index) => (
          index === 0 ? "Allow for this session scope" : index === 1 ? "Allow once" : "Deny"
        ),
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "write three files");
        await session.host.session.waitForIdle();

        // Session grants are bound to a normalized resource. The second file
        // therefore asks independently, and `.env` remains high risk.
        assert.equal(
          session.uiRequests.length,
          3,
          `expected one dialog per resource, got ${session.uiRequests.length}: ${session.uiRequests.map((r) => r.title).join(" | ")}`,
        );
        assert.match(session.uiRequests[0]!.title, /one\.txt/);
        assert.match(session.uiRequests[1]!.title, /two\.txt/);
        assert.match(session.uiRequests[2]!.title, /\.env/, "the final dialog must be the .env write");
        assert.ok(existsSync(join(root, "one.txt")), "first write was allowed");
        assert.ok(existsSync(join(root, "two.txt")), "second write was independently allowed");
        assert.ok(!existsSync(join(root, ".env")), "the high-risk write was denied");
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("does not ask for a read-only tool", async () => {
    await withTempRoot("varin-s-perm-read-", async (root) => {
      const faux = registerFauxProvider();
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })]),
        () => fauxAssistantMessage("done"),
      ]);

      const session = await setupSession({
        root,
        faux,
        answerDialog: () => "Deny",
      });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "read a file");
        await session.host.session.waitForIdle();

        assert.equal(
          session.uiRequests.length,
          0,
          "mutation:none tools are allowed without a prompt",
        );
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

  it("uses the configured Smart judge for an ordinary edit without prompting", async () => {
    await withTempRoot("varin-s-perm-smart-", async (root) => {
      const faux = registerFauxProvider();
      const model = faux.getModel();
      const judgeContexts: Context[] = [];
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "smart.txt", content: "ok" })]),
        (context) => { judgeContexts.push(context); return fauxAssistantMessage("allow"); },
        () => fauxAssistantMessage("done"),
      ]);
      const agentDir = join(root, "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "settings.json"), JSON.stringify({
        harness: {
          models: { permissionJudge: { providerId: model.provider, modelId: model.id } },
          permissions: { mode: "smart", rules: [] },
        },
      }), "utf8");
      const session = await setupSession({ root, faux, answerDialog: () => "Deny" });

      try {
        const snapshot = await session.host.create(root);
        await session.host.prompt(snapshot.sessionId, "write smart.txt");
        await session.host.session.waitForIdle();
        assert.equal(session.uiRequests.length, 0);
        assert.ok(existsSync(join(root, "smart.txt")));
        assert.equal(judgeContexts.length, 1);
        assert.match(judgeContexts[0]!.systemPrompt ?? "", /permission judge/i);
      } finally {
        await session.dispose();
        faux.unregister();
      }
    });
  });

});


describe("D-284 request admission", () => {
  it("commits before a tool-loop continuation needs space, not after the final reply", async () => {
    await withTempRoot("varin-request-admission-", async (root) => {
      await mkdir(join(root, "agent"), { recursive: true });
      await writeFile(join(root, "agent", "settings.json"), JSON.stringify({
        compaction: { enabled: true, reserveTokens: 4_000, keepRecentTokens: 1_200 },
        harness: { context: { preparationWaterline: 0.4 } },
      }), "utf8");
      await writeFile(join(root, "material.txt"), Array.from({ length: 1_500 },
        (_, i) => `line ${i + 1}: ${"material ".repeat(8)}`).join("\n"), "utf8");
      // Keep the fourth request decisively beyond capacity even after the
      // provider's measured-token calibration replaces the initial estimate.
      const faux = registerFauxProvider({ models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 800 }] });
      let session: Awaited<ReturnType<typeof setupSession>> | undefined;
      const foreground: { compacted: boolean; chars: number }[] = [];
      let summaryCalls = 0;
      const respond = (context: Context, options: { cacheRetention?: string } | undefined) => {
        // Faux's synthetic cache-write count overlaps its uncached input.
        // Disable that test-only estimator so the capacity test uses one input count.
        if (options) options.cacheRetention = "none";
        if (context.systemPrompt?.includes("background compaction agent")) {
          summaryCalls += 1;
          return fauxAssistantMessage("The task reads material.txt in chunks. Continue reading; original entries remain in history.");
        }
        foreground.push({
          compacted: session!.host.session.sessionManager.getEntries().some((entry) => entry.type === "compaction"),
          chars: JSON.stringify(context).length,
        });
        return foreground.length <= 3
          ? fauxAssistantMessage([fauxToolCall("read", { path: "material.txt", offset: 1 + (foreground.length - 1) * 230, limit: 230 })])
          : fauxAssistantMessage("Finished reading the requested material.");
      };
      faux.setResponses(Array.from({ length: 20 }, () => respond));
      try {
        session = await setupSession({ root, faux });
        const created = await session.host.create(root);
        await session.host.prompt(created.sessionId, "Read the first 690 lines in three consecutive read calls.");
        await session.host.session.waitForIdle();
        assert.equal(foreground.length, 4, JSON.stringify(session.host.session.sessionManager.getEntries()
          .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
          .map((entry) => ({ id: entry.id, stopReason: (entry as { message: { stopReason?: string } }).message.stopReason,
            error: (entry as { message: { errorMessage?: string } }).message.errorMessage }))));
        assert.ok(foreground.slice(1).some((request) => request.compacted),
          `tool-loop requests must see the committed boundary before going out; shapes=${JSON.stringify(foreground)}; summaries=${summaryCalls}`);
        const entries = session.host.session.sessionManager.getEntries();
        assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "toolResult").length, 3,
          "compaction must retain every original tool result in native Pi history");
      } finally {
        await session?.dispose();
        faux.unregister();
      }
    });
  });
});
