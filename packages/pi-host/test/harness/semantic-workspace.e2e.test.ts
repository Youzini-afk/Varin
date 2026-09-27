/**
 * Public explore -> Host router -> production workspace semantic runtime.
 *
 * The inference broker below is deliberately thin: settings and inference
 * requests are served by a real SessionHost BackgroundInferenceRuntime, whose
 * fetch implementation is a local faux HTTP provider.  Semantic recall and
 * rerank are always the methods returned by createWorkspaceSemanticRuntime.
 */
import assert from "node:assert/strict";
import { readdir, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path, { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import type {
  HarnessEmbedParams,
  HarnessRerankParams,
  ExploreQueryFinishResult,
  HostEvent,
  HostEventData,
} from "@varin/protocol";

import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { createExploreFileReader } from "../../../web/application-host/lib/harness/explore-file-reader.js";
import { createHarnessPathAuthority } from "../../../web/application-host/lib/harness/path-authority.js";
import { createWorkspaceSemanticRuntime, type WorkspaceSemanticRuntimeOptions } from "../../../web/application-host/lib/knowledge/semantic/workspace-runtime.js";
import { createHashEmbedder } from "../../../web/application-host/lib/knowledge/semantic/embedder.js";
import { createStructureSource } from "../../../web/application-host/lib/structure/source.js";
import { createDocumentAuthority } from "../../../web/application-host/lib/documents/authority.js";
import { createRecoveryTurnCoordinator } from "../../../web/application-host/lib/recovery/turn-coordinator.js";
import { createNativeComputeTestHarness } from "../../../web/application-host/lib/kernel/compute.test-helper.js";
import { createTreeSitterStructureProvider } from "../../../web/application-host/lib/structure/tree-sitter-provider.js";
import { createRecoveryFileStore } from "../../../web/application-host/lib/recovery/file-store.test-helper.js";
import { createInMemoryRecoveryDurablePort } from "../../../web/application-host/lib/recovery/recovery-durable-port.test-helper.js";
import { SessionHost } from "../../src/session-host.js";
import { serializedToolResult } from "./provider-context.js";

type Workspace = { workspaceId: string; root: string };

const sourceFiles = async (root: string): Promise<Array<{ name: string; path: string; relativePath: string }>> => {
  const files: Array<{ name: string; path: string; relativePath: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile() && /\.(?:ts|tsx|js|jsx)$/u.test(entry.name)) {
        files.push({
          name: entry.name,
          path: absolute,
          relativePath: path.relative(root, absolute).split(path.sep).join("/"),
        });
      }
    }
  };
  await visit(root);
  return files;
};

interface SemanticHarness {
  documents: ReturnType<typeof createDocumentAuthority>;
  parent: Workspace;
  child: Workspace;
  semantic: ReturnType<typeof createWorkspaceSemanticRuntime>;
  root: string;
  serviceHost: ReturnType<typeof createHarnessServiceHost>;
  runSession: (workspace: Workspace, faux: ReturnType<typeof registerFauxProvider>, options?: { journal?: boolean; key?: string }) => Promise<SemanticSession>;
  cleanup: () => Promise<void>;
  embedBodies: string[][];
  embedRequests: Array<{ workspaceId: string; input: string[]; authorization: string | null }>;
  rerankBodies: Array<Array<{ id: string; text: string }>>;
  inferenceCalls: string[];
  semanticErrors: unknown[];
}

interface SemanticSession {
  host: SessionHost;
  prompt: (text: string) => Promise<void>;
  observationOrder: string[];
  toolResults: Array<{ toolName: string; result: unknown }>;
  close: () => Promise<void>;
}

async function createSemanticHarness(options: {
  embedding?: boolean;
  rerank?: boolean;
  malformedEmbedding?: boolean;
  inferenceFailure?: boolean;
} = {}): Promise<SemanticHarness> {
  const root = await mkdtemp(join(tmpdir(), "varin-semantic-workspace-e2e-"));
  const parentRoot = join(root, "owner");
  const childRoot = join(root, "materialized-child");
  const dataDir = join(root, "host-data");
  await mkdir(parentRoot, { recursive: true });
  await mkdir(childRoot, { recursive: true });

  const baseUrl = "https://models.example/v1";
  let forwardDocumentMutation = (_event: Parameters<ReturnType<typeof createWorkspaceSemanticRuntime>["observeDocumentMutation"]>[0]): void => {};
  const documents = createDocumentAuthority({
    hostId: "semantic-public-e2e-host",
    dataDir,
    isAllowedRoot: async () => true,
    isTrusted: async () => true,
    onMutation: (event) => forwardDocumentMutation(event),
  });
  const parentIdentity = await documents.resolveWorkspace({ path: parentRoot });
  const childIdentity = await documents.resolveWorkspace({ path: childRoot });
  const parent = { workspaceId: parentIdentity.workspaceId, root: parentRoot };
  const child = { workspaceId: childIdentity.workspaceId, root: childRoot };
  const durableRecoveryStore = createInMemoryRecoveryDurablePort();
  documents.bindDurableMutationStorage(async (workspaceId, operation) => {
    const inspected = await documents.inspectWorkspace(workspaceId);
    return operation({
      durableRecoveryStore,
      fileStore: createRecoveryFileStore(),
      identity: {
        authorityId: documents.hostId,
        canonicalRoot: inspected.root,
        filesystemProfile: "test",
        workspaceId,
      },
      resourceOperationGate: { run: (_resources, callback) => callback() },
      root: join(dataDir, "agent-mutation-objects"),
    });
  });
  const paths = createHarnessPathAuthority({
    authorityId: "semantic-public-e2e-authority",
    documents,
  });
  const embedBodies: string[][] = [];
  const embedRequests: SemanticHarness["embedRequests"] = [];
  const rerankBodies: Array<Array<{ id: string; text: string }>> = [];
  const inferenceCalls: string[] = [];
  const semanticErrors: unknown[] = [];
  const rerankModel = "rerank-test";
  const hostsByCwd = new Map<string, SessionHost>();
  const broker = {
    requestForWorkspace: async (
      cwd: string,
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      inferenceCalls.push(`${method}:${cwd}`);
      // The config anchor (VARIN_DATA_DIR in production) is served by whichever
      // session worker is alive; it never owns workspace documents itself.
      const targetHost = hostsByCwd.get(path.resolve(cwd))
        ?? (path.resolve(cwd) === path.resolve(dataDir) ? hostsByCwd.values().next().value : undefined);
      if (!targetHost) throw new Error(`No SessionHost for execution workspace ${cwd}`);
      if (method === "settings.get") return targetHost.getSettings();
      if (method === "harness.inference.describe") return targetHost.describeInference();
      if (method === "harness.embed") {
        return targetHost.embed(params as unknown as HarnessEmbedParams);
      }
      if (method === "harness.rerank") return targetHost.rerank(params as unknown as HarnessRerankParams);
      if (method === "harness.inference.cancel") {
        return { cancelled: targetHost.cancelInference(String(params.batchId)) };
      }
      throw new Error(`Unexpected workspace broker method: ${method}`);
    },
    watchConfig: async () => ({ watchId: `semantic-watch-${Math.random().toString(36).slice(2)}` }),
    unwatchConfig: async () => ({ unwatched: true }),
  } as unknown as NonNullable<ReturnType<WorkspaceSemanticRuntimeOptions["getBroker"]>>;

  const compute = createNativeComputeTestHarness();
  const semantic = createWorkspaceSemanticRuntime({
    dataDir,
    hostId: "semantic-public-e2e-host",
    configCwd: dataDir,
    documents: {
      read: documents.read,
      inspectWorkspace: documents.inspectWorkspace,
      watch: documents.watch,
      agentInputDraftPaths: documents.agentInputDraftPaths,
      readAgentInputSnapshot: documents.readAgentInputSnapshot,
    },
    structureSource: createStructureSource([
      createTreeSitterStructureProvider({ compute, parseBudgetMs: 30_000 }),
    ]),
    searchFilesystemFiles: async (workspaceRoot) => sourceFiles(workspaceRoot),
    isIndexablePath: async () => true,
    embedder: createHashEmbedder(),
    getBroker: () => broker,
    executionViews: { get: () => undefined },
    workingBranches: { pinQuery: async () => null },
    onError: (error) => { semanticErrors.push(error); },
  });
  forwardDocumentMutation = (event) => semantic.observeDocumentMutation(event);

  const serviceHost = createHarnessServiceHost({
    search: async () => ({ status: "empty" as const, generation: undefined }),
    resolveWorkspaceRoot: async (workspaceId) => {
      if (workspaceId === parent.workspaceId) return parent.root;
      if (workspaceId === child.workspaceId) return child.root;
      return null;
    },
    readExploreFile: createExploreFileReader(documents, paths),
    semanticRecall: semantic.semanticRecall,
    harnessSettings: semantic.harnessSettings,
    rerankExploreViews: semantic.rerankExploreViews,
    // The native journal asks this first. Returning disk makes the fixture use
    // the real Pi write tool and the real after-phase journal event.
    documentBranchWrite: async () => ({ status: "disk" as const }),
    documentSurfaceWrite: (sessionId, workspaceId, context, changes, signal) => (
      documents.applyAgentSurfaceWrite(sessionId, workspaceId, context, changes, signal)
    ),
  });

  const runSession = async (
    workspace: Workspace,
    faux: ReturnType<typeof registerFauxProvider>,
    sessionOptions: { journal?: boolean; key?: string } = {},
  ): Promise<SemanticSession> => {
    const agentDir = join(root, `agent-${workspace.workspaceId}`);
    await mkdir(agentDir, { recursive: true });
    const model = faux.getModel();
    const settings = {
      harness: {
        ...(options.embedding === false ? {} : {
          embedding: options.malformedEmbedding ? { providerId: "embed-provider" } : {
            protocol: "openai-compatible",
            providerId: "embed-provider",
            modelId: "text-embedding-3-small",
            dimensions: 2,
          },
        }),
        ...(options.rerank === false ? {} : {
          rerank: {
            protocol: "http-rerank",
            providerId: "embed-provider",
            modelId: rerankModel,
          },
        }),
      },
    };
    await writeFile(join(agentDir, "settings.json"), JSON.stringify(settings));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        "embed-provider": {
          name: "Embedding provider",
          baseUrl,
          api: "openai-completions",
          models: [],
        },
      },
    }));

    let sessionId = "";
    const workerId = `semantic-worker-${workspace.workspaceId}`;
    let currentExecution: { id: string; promises: Promise<unknown>[] } | undefined;
    const observationOrder: string[] = [];
    const toolResults: Array<{ toolName: string; result: unknown }> = [];
    const actor = () => ({
      authorityInstanceId: "semantic-public-e2e-authority",
      sessionId,
      workerId,
      workerGeneration: 1,
    } as const);

    const forwardCoordinatorEvent = (event: HostEvent, data: HostEventData<HostEvent>): void => {
      const execution = currentExecution;
      if (!execution || (event !== "agent.event" && event !== "workspace.mutation.request")) return;
      const task = coordinator.processEvent({
        executionId: execution.id,
        kind: "host",
        envelope: { kind: "event", event, data },
        sessionId,
        workerId,
      });
      execution.promises.push(task);
      void task;
    };

    const router = createHarnessRouter({
      respond: async (identity, requestId, outcome) => {
        host.respondHarness(identity.sessionId, requestId, outcome);
      },
      resolveActor: (identity) => serviceHost.resolveActor(identity),
      authorizeWorkspacePath: (currentActor, inputPath, pathOptions) => paths.resolve(currentActor, inputPath, pathOptions),
      cancelExploreQuery: (currentActor, queryId) => serviceHost.exploreQueryStore.cancel(currentActor, queryId),
    });
    registerHarnessServices(router, serviceHost);

    const emit = (<E extends HostEvent>(event: E, data: HostEventData<E>): void => {
      forwardCoordinatorEvent(event, data as HostEventData<HostEvent>);
      if (event === "agent.event") {
        const projected = (data as HostEventData<"agent.event">).event;
        if (projected.type === "tool_execution_end") {
          toolResults.push({ toolName: projected.toolName, result: projected.result });
          if (projected.toolName === "explore") observationOrder.push("explore-result");
        }
      }
      if (event === "harness.request") {
        if (!serviceHost.hasActor(actor())) {
          serviceHost.registerSession({
            actor: actor(),
            grantedCapabilities: [
              "context.session", "read.output", "read.search", "write.document",
            ],
            workspaceId: workspace.workspaceId,
            workspaceRoot: workspace.root,
          });
        }
        void router.processEvent({
          actor: actor(),
          kind: "host",
          envelope: { kind: "event", event, data },
        });
      }
      if (event === "extension.ui.request") {
        const request = data as unknown as { id?: string; method?: string };
        if (request.id && request.method === "select") {
          host.ui.respond({ requestId: request.id, value: "Allow once" });
        }
      }
    }) as <E extends HostEvent>(event: E, data: HostEventData<E>) => void;

    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
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
      await services.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
      return { model };
    };

    const host = new SessionHost({
      agentDir,
      configureServices,
      emit,
      projectTrustOverride: true,
      inferenceFetch: async (url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          input?: string[];
          documents?: Array<{ id: string; text: string }>;
        };
        const text = String(url);
        if (text.endsWith("/embeddings")) {
          const input = body.input ?? [];
          embedBodies.push(input);
          const authorization = new Headers(init?.headers).get("Authorization");
          embedRequests.push({ workspaceId: workspace.workspaceId, input, authorization });
          if (options.inferenceFailure) return new Response("provider down", { status: 503 });
          return new Response(JSON.stringify({
            data: input.map((value, index) => ({
              index,
              // The source and question deliberately use different words.
              // This local provider supplies the semantic relation.
              embedding: /accrueLedger|reconcileVault|bookkeeping|persistence/iu.test(value)
                ? [1, 0]
                : [0, 1],
            })),
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        assert.ok(text.endsWith("/rerank"), `Unexpected inference endpoint ${text}`);
        const docs = body.documents ?? [];
        rerankBodies.push(docs);
        if (options.inferenceFailure) return new Response("provider down", { status: 503 });
        return new Response(JSON.stringify({
          results: docs.map((document, index) => ({
            id: document.id,
            index,
            relevance_score: index === 0 ? 0.99 : 0.1,
          })),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    if (sessionOptions.journal) {
      host.setHarnessDocumentReadEnabled(true);
      host.setWorkspaceMutationJournalEnabled(true);
    }

    const coordinator = createRecoveryTurnCoordinator({
      documents: { inspectMutation: documents.inspectMutation },
      getSessionSnapshot: () => ({ workspace: { kind: "workspace", id: workspace.workspaceId, authorityId: workspace.workspaceId } }),
      invokeService: async (request) => {
        const input = request.args[0] as { executionId?: string; sessionId?: string; userEntryId?: string; workspaceId?: string; workerId?: string; runtimeGeneration?: number };
        const binding = {
          activeWriterScopes: [],
          checkpointId: `checkpoint-${input.executionId ?? "unknown"}`,
          executionId: input.executionId ?? "unknown",
          provenance: "observed-during" as const,
          runtimeGeneration: input.runtimeGeneration ?? 1,
          runtimeKey: `${input.workerId ?? workerId}@${input.runtimeGeneration ?? 1}`,
          sessionId: input.sessionId ?? sessionId,
          startedAt: new Date().toISOString(),
          status: request.method === "recordTurnSettled" ? "ready" as const : "pending" as const,
          unrecordedResourceIds: [],
          userEntryId: input.userEntryId ?? "user-entry",
          workerId: input.workerId ?? workerId,
          workspaceId: input.workspaceId ?? workspace.workspaceId,
          ...(request.method === "recordTurnSettled" ? { settledAt: new Date().toISOString() } : {}),
        };
        if (request.method === "recordTurnStart") return { status: "ready", binding };
        if (request.method === "recordTurnSettled") {
          observationOrder.push("turn-settled");
          return { status: "ready", binding };
        }
        if (request.method === "recordMutationBefore" || request.method === "recordMutationAfter") {
          return { status: "ready", recorded: true };
        }
        throw new Error(`Unexpected recovery method: ${request.method}`);
      },
      respondMutation: async (request, accepted) => {
        if (request.phase === "after" && request.succeeded === true) observationOrder.push("ack-after");
        host.respondWorkspaceMutation(request.sessionId, request.requestId, accepted);
      },
      observeToolWrite: async (workspaceId, absolutePath) => {
        observationOrder.push("observe-tool-write");
        await documents.observeAgentWrite(workspaceId, absolutePath);
        await semantic.observeToolWrite(workspaceId, absolutePath);
      },
      writerTracker: {
        admit: async () => ({ close: async () => undefined }),
        waitForIdle: async () => ({ mutationObserved: true, coverageComplete: true, changedResourceIds: [] }),
      },
    });

    const snapshot = await host.create(workspace.root);
    sessionId = snapshot.sessionId;
    await host.runtime.services.modelRuntime.setRuntimeApiKey(
      "embed-provider",
      sessionOptions.key ?? `embed-key-${workspace.workspaceId}`,
    );
    const executionRoot = (await documents.inspectWorkspace(workspace.workspaceId)).root;
    hostsByCwd.set(path.resolve(executionRoot), host);
    const prompt = async (text: string): Promise<void> => {
      const execution = { id: `execution-${snapshot.sessionId}-${Date.now()}-${Math.random()}`, promises: [] as Promise<unknown>[] };
      currentExecution = execution;
      const lease = await coordinator.admit({
        cwd: workspace.root,
        executionId: execution.id,
        method: "agent.prompt",
        phase: "agent-run",
        runtimeGeneration: 1,
        sessionId: snapshot.sessionId,
        workerId,
        workspace: { kind: "workspace", id: workspace.workspaceId, authorityId: workspace.workspaceId },
      });
      try {
        await host.prompt(snapshot.sessionId, text);
        await host.session.waitForIdle();
        await Promise.all(execution.promises);
      } finally {
        await lease?.close();
        currentExecution = undefined;
      }
    };
    const close = async (): Promise<void> => {
      currentExecution = undefined;
      await coordinator.dispose();
      await host.dispose();
      router.dispose();
      if (hostsByCwd.get(path.resolve(executionRoot)) === host) hostsByCwd.delete(path.resolve(executionRoot));
    };
    return { host, prompt, observationOrder, toolResults, close };
  };

  return {
    documents,
    parent,
    child,
    semantic,
    root,
    serviceHost,
    runSession,
    embedBodies,
    embedRequests,
    rerankBodies,
    inferenceCalls,
    semanticErrors,
    cleanup: async () => {
      await semantic.dispose();
      await compute.dispose();
      await serviceHost.dispose();
      await documents.dispose();
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    },
  };
}

const lastToolMessage = (contexts: Context[]): string => {
  const context = contexts.at(-1);
  if (!context) throw new Error("Expected a provider context after the explore call");
  return serializedToolResult(context, "explore");
};
const exploreDetails = (session: SemanticSession): ExploreQueryFinishResult["details"] => {
  const result = session.toolResults.findLast((tool) => tool.toolName === "explore")?.result as {
    details?: { provenance?: ExploreQueryFinishResult["details"] };
  } | undefined;
  assert.ok(result?.details?.provenance, "public explore must provide structured provenance");
  return result.details.provenance;
};

describe("public explore workspace semantic runtime", () => {
  it("uses the resolved remote binding and rerank through the public tool, with independent Documents workspaces", async () => {
    const harness = await createSemanticHarness();
    const faux = registerFauxProvider();
    const contexts: Context[] = [];
    const query = "where is bookkeeping condensed before persistence";
    try {
      await writeFile(join(harness.parent.root, "owner.ts"), "export function ownerLedger() { return \"owner-only\"; }\n");
      await writeFile(join(harness.child.root, "child.ts"), "export function accrueLedger() { return \"child-only\"; }\n");
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("explore", { question: query })]),
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("done");
        },
      ]);
      const ownerSession = await harness.runSession(harness.parent, faux, { key: "owner-key" });
      const session = await harness.runSession(harness.child, faux, { key: "child-key" });
      try {
        await harness.semantic.scanWorkspace(harness.parent.workspaceId);
        await harness.semantic.scanWorkspace(harness.child.workspaceId);
        await session.prompt("find the bookkeeping implementation");
        const toolResult = lastToolMessage(contexts);
        assert.match(toolResult, /child\.ts/, JSON.stringify(harness.semanticErrors));
        assert.match(toolResult, /accrueLedger/);
        const details = exploreDetails(session);
        assert.equal(details.semantic?.status, "ready");
        assert.equal(details.semantic.scope?.scopeId, harness.child.workspaceId);
        assert.equal(details.rerank?.status, "used");
        assert.ok(harness.embedBodies.some((batch) => batch.some((text) => /bookkeeping|persistence/iu.test(text))), "the natural-language query must reach remote embeddings");
        assert.ok(harness.embedBodies.some((batch) => batch.some((text) => /accrueLedger/iu.test(text))), "the child source must reach remote embeddings");
        assert.ok(harness.rerankBodies.length > 0, "dedicated rerank must run when no LLM selection is configured");
        assert.ok(harness.inferenceCalls.some((call) => call.startsWith("settings.get:")));
        assert.ok(harness.inferenceCalls.some((call) => call.startsWith("harness.inference.describe:")));
        assert.ok(harness.inferenceCalls.some((call) => call.startsWith("harness.embed:")));
        assert.ok(harness.inferenceCalls.some((call) => call.startsWith("harness.rerank:")));
        assert.ok(harness.embedRequests.some((request) => request.workspaceId === harness.parent.workspaceId
          && request.authorization === "Bearer owner-key" && request.input.some((text) => text.includes("ownerLedger"))));
        assert.ok(harness.embedRequests.some((request) => request.authorization === "Bearer owner-key"
          && request.input.some((text) => text.includes("accrueLedger"))));
        assert.doesNotMatch(toolResult, /owner-key|child-key|faux-key/);

        const parentResult = await harness.semantic.semanticRecall(harness.parent.workspaceId, query, 5);
        assert.equal(parentResult.hits.some((hit) => hit.documentId === "child.ts"), false, "the owner workspace must not see the materialized child source");
      } finally {
        await session.close();
        await ownerSession.close();
      }
    } finally {
      faux.unregister();
      await harness.cleanup();
    }
  });

  it("observes a durable Host child write before the next public explore call", async () => {
    const harness = await createSemanticHarness();
    const faux = registerFauxProvider();
    const contexts: Context[] = [];
    try {
      await writeFile(join(harness.parent.root, "owner.ts"), "export function ownerLedger() { return \"owner-only\"; }\n");
      await writeFile(join(harness.child.root, "child.ts"), "export function accrueLedger() { return \"old-child\"; }\n");
      faux.setResponses([
        () => fauxAssistantMessage([fauxToolCall("write", { path: "child.ts", content: "export function reconcileVault() { return \"updated-child\"; }\n" })]),
        async () => {
          // Documents publishes the durable Host mutation before returning the
          // write result, while semantic reindexing continues in the background.
          // Let that work settle before the next tool call in the same Pi run.
          await harness.semantic.drain();
          return fauxAssistantMessage([fauxToolCall("explore", { question: "where is bookkeeping condensed before persistence" })]);
        },
        (context) => {
          contexts.push(context);
          return fauxAssistantMessage("done");
        },
      ]);
      const session = await harness.runSession(harness.child, faux, { journal: true });
      try {
        // Build the baseline generation after the real workspace SessionHost is
        // available to the workspace inference broker.
        await harness.semantic.scanWorkspace(harness.child.workspaceId);
        const before = await harness.semantic.semanticRecall(harness.child.workspaceId, "where is bookkeeping condensed before persistence", 5);
        const beforeDocument = await harness.documents.read({ workspaceId: harness.child.workspaceId, resourceId: "child.ts" });
        assert.equal(beforeDocument.status, "ready");
        if (beforeDocument.status !== "ready") throw new Error("Expected baseline child document");
        assert.match(before.hits[0]?.body ?? "", /old-child/);
        await session.prompt("write the latest child implementation, then locate the bookkeeping implementation");
        const result = lastToolMessage(contexts);
        assert.match(result, /child\.ts/);
        assert.match(result, /reconcileVault|updated-child/, JSON.stringify(session.toolResults));
        const current = await harness.documents.read({ workspaceId: harness.child.workspaceId, resourceId: "child.ts" });
        assert.equal(current.status, "ready");
        if (current.status !== "ready") throw new Error("Expected updated child document");
        assert.match(current.content, /reconcileVault/);
        assert.notEqual(current.revision, beforeDocument.revision);
        assert.match(result, new RegExp(current.revision.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
        assert.ok(harness.embedBodies.some((batch) => batch.some((text) => text.includes("reconcileVault"))));
        const updated = await harness.semantic.semanticRecall(harness.child.workspaceId, "where is bookkeeping condensed before persistence", 5);
        assert.match(updated.hits[0]?.body ?? "", /updated-child/);
        assert.ok(session.observationOrder.indexOf("explore-result") >= 0
          && session.observationOrder.indexOf("explore-result") < session.observationOrder.indexOf("turn-settled"),
        `explore must finish before recovery settles the turn: ${session.observationOrder.join(",")}`);
        const owner = await harness.documents.read({ workspaceId: harness.parent.workspaceId, resourceId: "owner.ts" });
        assert.equal(owner.status, "ready");
        if (owner.status !== "ready") throw new Error("Expected owner document");
        assert.doesNotMatch(owner.content, /reconcileVault/);
      } finally {
        await session.close();
      }
    } finally {
      faux.unregister();
      await harness.cleanup();
    }
  });

  it("keeps unconfigured, invalid, and remote failure outcomes distinguishable", async () => {
    const run = async (variant: { embedding?: boolean; malformed?: boolean; inferenceFailure?: boolean }) => {
      const harness = await createSemanticHarness({
        ...(variant.embedding === undefined ? {} : { embedding: variant.embedding }),
        ...(variant.malformed === undefined ? {} : { malformedEmbedding: variant.malformed }),
        ...(variant.inferenceFailure === undefined ? {} : { inferenceFailure: variant.inferenceFailure }),
      });
      const faux = registerFauxProvider();
      const contexts: Context[] = [];
      try {
        await writeFile(join(harness.child.root, "child.ts"), "export function accrueLedger() { return \"child\"; }\n");
        faux.setResponses([
          () => fauxAssistantMessage([fauxToolCall("explore", { question: "where is bookkeeping condensed before persistence" })]),
          (context) => { contexts.push(context); return fauxAssistantMessage("done"); },
        ]);
        const session = await harness.runSession(harness.child, faux);
        try {
          await harness.semantic.scanWorkspace(harness.child.workspaceId);
          await session.prompt("find the bookkeeping implementation");
          return {
            details: exploreDetails(session),
            binding: await harness.semantic.resolveKnowledgeEmbedder(harness.child.workspaceId),
            remoteEmbeds: harness.embedBodies.length,
          };
        } finally {
          await session.close();
        }
      } finally {
        faux.unregister();
        await harness.cleanup();
      }
    };

    const unconfigured = await run({ embedding: false });
    const invalid = await run({ malformed: true });
    const failed = await run({ inferenceFailure: true });
    assert.equal(unconfigured.binding.status, "unconfigured");
    assert.equal(unconfigured.remoteEmbeds, 0);
    assert.ok(["ready", "empty"].includes(unconfigured.details.semantic?.status ?? ""), JSON.stringify(unconfigured.details));
    assert.equal(invalid.binding.status, "invalid");
    assert.equal(invalid.remoteEmbeds, 0);
    assert.ok(["failed", "unavailable"].includes(invalid.details.semantic?.status ?? ""), JSON.stringify(invalid.details));
    assert.equal(failed.binding.status, "ready");
    assert.ok(failed.remoteEmbeds > 0);
    assert.ok(["failed", "unavailable"].includes(failed.details.semantic?.status ?? ""), JSON.stringify(failed.details));
  });
});
