import { fauxProvider, getCurrentTools, normalizeContext, type Context } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { AgentSessionServices } from "@earendil-works/pi-coding-agent";
import type { HostEvent, HostEventData } from "@varin/protocol";
import { createDocumentAuthority } from "../../../web/application-host/lib/documents/authority.js";
import { createHarnessPathAuthority } from "../../../web/application-host/lib/harness/path-authority.js";
import { createWorkspaceContentSearch } from "../../../web/application-host/lib/search/content.js";
import { createExploreFileReader } from "../../../web/application-host/lib/harness/explore-file-reader.js";
import { createHarnessServiceHost } from "../../../web/application-host/lib/harness/service-host.js";
import { createHarnessRouter } from "../../../web/application-host/lib/harness/router.js";
import { registerHarnessServices } from "../../../web/application-host/lib/harness/harness-services.js";
import { createThreadRegistry } from "../../../web/application-host/lib/harness/thread-registry.js";
import { createThreadRuntime, type ThreadSessionAdapter } from "../../../web/application-host/lib/harness/thread-runtime.js";
import { createThreadWorktreeRuntime } from "../../../web/application-host/lib/harness/thread-worktree.js";
import { ThreadExecutionViewRegistry } from "../../../web/application-host/lib/harness/working-state/execution-view.js";
import { createWorkingBranchLookups } from "../../../web/application-host/lib/harness/working-state/working-branch-lookups.js";
import { projectZone2Threads } from "../../../web/application-host/lib/harness/zone2-threads.js";
import { createNativeAuthorityTestRuntime } from "../../../web/application-host/lib/kernel/native-authority.test-helper.js";
import { createManagedRootAdmission } from "../../../web/application-host/lib/kernel/managed-root-admission.js";
import { assertManagedWorktreeOwnership } from "../../../web/application-host/lib/harness/worktree-ownership.js";
import { createKernelComputeService } from "../../../web/application-host/lib/kernel/compute-service.js";
import { SessionHost } from "../../src/session-host.js";

const waitUntil = async (predicate: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for retrieval session work");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe("retrieval thread public slice", () => {
  it("dispatches a retrieval child that explores, reads, and submits Host-validated facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "retrieval-session-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "agent");
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    const authBody = [
      "export const ignored = 1;",
      "export function login(user: string) {",
      "  return user;",
      "}",
      "export const after = 2;",
    ].join("\n");
    await writeFile(join(workspace, "src", "auth.ts"), authBody, "utf8");
    await writeFile(join(workspace, "outside.ts"), "export const secret = true;\n", "utf8");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Retrieval Test"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "retrieval@example.com"], { cwd: workspace });
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: workspace, stdio: "ignore" });

    const documents = createDocumentAuthority({
      hostId: "retrieval-e2e-host",
      dataDir: join(root, "documents"),
      isAllowedRoot: async () => true,
      isTrusted: async () => true,
    });
    const identity = await documents.resolveWorkspace({ path: workspace });
    const native = await createNativeAuthorityTestRuntime({ documents, hostId: "retrieval-e2e-host", dataDir: join(root, "data") });
    const { workingStates } = native;
    const compute = createKernelComputeService({ client: native.client, resolveIdentity: async (cwd) => {
      const { workspaceId } = await documents.resolveWorkspace({ path: cwd });
      return { workspaceId, executionWorkspaceId: workspaceId, canonicalRoot: (await documents.inspectWorkspace(workspaceId)).root };
    } });
    const executionViews = new ThreadExecutionViewRegistry();
    const branchLookups = createWorkingBranchLookups({ views: executionViews, workingStates });
    const paths = createHarnessPathAuthority({
      authorityId: "retrieval-e2e-authority",
      documents,
    });
    const search = createWorkspaceContentSearch({ documents, pathModule: path, compute });

    const faux = fauxProvider();
    const model = faux.getModel();
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      harness: {
        models: {
          retrievalAgent: { providerId: model.provider, modelId: model.id },
        },
      },
    }), "utf8");

    const configureServices = async (services: AgentSessionServices) => {
      services.modelRuntime.registerProvider(model.provider, {
          streamSimple: faux.provider.streamSimple,
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

    const registry = createThreadRegistry({ dataDir: join(root, "threads"), hostId: "retrieval-e2e" });
    const childHosts = new Map<string, SessionHost>();
    const childSessionFiles = new Map<string, string>();
    const childRunIds = new Map<string, string>();
    const executionContexts = new Map<string, { workspaceId: string; root: string }>();
    let spawningRunId: string | undefined;
    let childInitialPrompt = "";
    let childTranscript = "";
    let childTools: string[] = [];
    let childModelId: string | undefined;
    let childScope: string[] | undefined;
    let parentHost: SessionHost | null = null;
    let router: ReturnType<typeof createHarnessRouter> | null = null;
    let harnessServiceHost: ReturnType<typeof createHarnessServiceHost> | null = null;
    let runtime: ReturnType<typeof createThreadRuntime> | null = null;
    const parentUserText = "SECRET_PARENT_ONLY locate the login helper";

    const hostFor = (sessionId: string): SessionHost => {
      if (sessionId === parentHost?.sessionId) return parentHost;
      const host = childHosts.get(sessionId);
      if (!host) throw new Error(`Unknown retrieval session: ${sessionId}`);
      return host;
    };

    const actorFor = (sessionId: string) => {
      if (sessionId === parentHost?.sessionId) {
        return {
          authorityInstanceId: "retrieval-e2e-authority",
          sessionId,
          workerId: "parent-worker",
          workerGeneration: 1,
        } as const;
      }
      const runId = childRunIds.get(sessionId);
      return {
        authorityInstanceId: "retrieval-e2e-authority",
        sessionId,
        workerId: `child-worker-${sessionId}`,
        workerGeneration: 1,
        ...(runId ? { runId } : {}),
        workspaceScope: ["src", "only-in-parent.ts"],
      } as const;
    };

    const ensureRegistered = async (sessionId: string): Promise<void> => {
      const actor = actorFor(sessionId);
      if (harnessServiceHost!.hasActor(actor)) return;
      const isParent = sessionId === parentHost?.sessionId;
      const execution = executionContexts.get(sessionId);
      harnessServiceHost!.registerSession({
        actor,
        grantedCapabilities: isParent
          ? ["context.session", "control.thread", "read.output", "read.lsp"]
          : ["context.session", "control.thread", "read.document", "read.search", "read.output", "read.lsp"],
        workspaceId: execution?.workspaceId ?? identity.workspaceId,
        workspaceRoot: execution?.root ?? workspace,
      });
    };

    const emitFrom = (sessionId: string, event: HostEvent, data: unknown): void => {
      if (event === "harness.request") {
        void (async () => {
          await ensureRegistered(sessionId);
          await router!.processEvent({
            actor: actorFor(sessionId),
            kind: "host",
            envelope: { kind: "event", event: "harness.request", data },
          });
        })();
        return;
      }
      if (event === "agent.event" && sessionId !== parentHost?.sessionId) {
        runtime!.processEvent({
          kind: "host",
          sessionId,
          envelope: { kind: "event", event: "agent.event", data },
        });
      }
    };

    const createChildHost = (): SessionHost => {
      const child = new SessionHost({
        agentDir,
        configureServices,
        emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
          const sessionId = child.sessionId;
          if (!sessionId) return;
          emitFrom(sessionId, event, data);
        },
        projectTrustOverride: true,
      });
      child.setHarnessDocumentReadEnabled(true);
      child.setHarnessDocumentPathOverlayEnabled(true);
      child.setHarnessLspNavigationEnabled(true);
      return child;
    };

    const sessions: ThreadSessionAdapter = {
      create: async (input) => {
        if (!spawningRunId) throw new Error("retrieval child created without a Run id");
        childScope = input.scope;
        const child = createChildHost();
        const created = await child.create(input.cwd, input.name, input.parentSession, input.tools, input.model, input.permissions);
        childHosts.set(created.sessionId, child);
        childRunIds.set(created.sessionId, spawningRunId);
        executionContexts.set(created.sessionId, { workspaceId: input.workspaceId, root: input.cwd });
        childTools = [...created.activeTools];
        childModelId = created.model?.id;
        if (created.sessionFile) childSessionFiles.set(created.sessionId, created.sessionFile);
        return created;
      },
      open: async (input) => {
        const sessionFile = childSessionFiles.get(input.sessionId);
        if (!sessionFile) throw new Error(`Missing retrieval child session: ${input.sessionId}`);
        const child = createChildHost();
        const opened = await child.open({
          cwd: input.cwd,
          sessionFile,
          tools: input.tools,
          ...(input.model ? { model: input.model } : {}),
          ...(input.permissions ? { permissions: input.permissions } : {}),
        });
        childHosts.set(opened.sessionId, child);
        if (opened.sessionFile) childSessionFiles.set(opened.sessionId, opened.sessionFile);
        return opened;
      },
      prompt: async (sessionId, text, instructions) => {
        childInitialPrompt = text;
        const result = await hostFor(sessionId).prompt(sessionId, text, undefined, instructions);
        if (!result.accepted) throw new Error("Retrieval child prompt was not accepted");
      },
      send: async (sessionId, text) => { await hostFor(sessionId).followUp(sessionId, text); },
      abort: async (sessionId) => { await hostFor(sessionId).abort(sessionId); },
      close: async (sessionId) => {
        try {
          childTranscript = JSON.stringify(hostFor(sessionId).entries(sessionId, "branch").entries);
        } catch {
          // Session may already be inactive after settle.
        }
        await hostFor(sessionId).close(sessionId);
      },
      snapshot: async (sessionId) => hostFor(sessionId).snapshot(),
      summary: async (sessionId) => hostFor(sessionId).summary(sessionId),
      stats: async (sessionId) => hostFor(sessionId).stats(sessionId),
      entries: async (sessionId, scope = "branch") => hostFor(sessionId).entries(sessionId, scope),
    };

    const managedWorktreeRoot = join(root, "managed-scratch");
    const managed = createManagedRootAdmission({
      listWorktrees: async (id) => (await registry.listWorkspaceThreads(id)).flatMap(thread => thread.worktree ? [thread.worktree] : []),
      assertOwnership: (worktree, operation, candidates) => assertManagedWorktreeOwnership(worktree, operation, candidates, {
        authorizeManagedRoot: (candidate) => path.resolve(candidate) === path.resolve(managedWorktreeRoot),
      }),
    });
    native.adapter.bindManagedRootResolver(managed.materialization);
    const worktrees = createThreadWorktreeRuntime({
      authorizeManagedRoot: (candidate) => path.resolve(candidate) === path.resolve(managedWorktreeRoot),
      createScratch: async (_sourceRoot, threadId) => ({
        path: join(managedWorktreeRoot, threadId),
        managedRoot: managedWorktreeRoot,
      }),
      createWorktree: async (_sourceRoot, input) => {
        const target = join(managedWorktreeRoot, String(input.worktreeName));
        await mkdir(target, { recursive: true });
        return { path: target, managedRoot: managedWorktreeRoot };
      },
      getWorktreeBootstrapStatus: async () => ({ status: "ready", phase: "setup-ready", error: null, updatedAt: Date.now() }),
    });
    runtime = createThreadRuntime({
      registry,
      sessions,
      resolveWorkspaceRoot: async (id) => (await documents.inspectWorkspace(id)).root,
      resolveRuntimeWorkspaceId: async (directory) => (await documents.resolveWorkspace({ path: directory })).workspaceId,
      readBlocks: async () => [{ label: "plan", content: "parent-only block that must not copy the conversation" }],
      workingStates,
      executionViews,
      worktrees,
    });

    harnessServiceHost = createHarnessServiceHost({
      search: (request, options) => search.searchContent(request, options),
      resolveWorkspaceRoot: async (id) => (await documents.inspectWorkspace(id)).root,
      pathAuthority: paths,
      readExploreFile: createExploreFileReader(documents, paths, (sessionId, resourceId, workspaceId) => branchLookups.exploreFile(sessionId, resourceId, workspaceId)),
      pinWorkingBranchQuery: (sessionId, options) => branchLookups.pinQuery(sessionId, options),
      documentReadSource: async (sessionId, _context, resourceId, workspaceId) => (
        await branchLookups.readSource(sessionId, resourceId, workspaceId) ?? { status: "disk" as const }
      ),
      workingBranchEnsureMaterialized: (sessionId, signal) => runtime!.materializeExecutionView(sessionId, signal),
      lspNavigationServices: {
        symbols: { handle: async () => ({ status: "ready", text: "parentOnly symbol", value: [] }) },
        definition: { handle: async () => ({ status: "empty", text: "no definition" }) },
        references: { handle: async () => ({ status: "empty", text: "no references" }) },
        hover: { handle: async () => ({ status: "empty", text: "no hover" }) },
      } as never,
      threadRegistry: registry,
      threadPrepareIsolatedBranch: (input) => runtime!.prepareIsolatedBranch(input),
      threadSpawnSession: async (input) => {
        spawningRunId = input.runId;
        return runtime!.spawn(input);
      },
    });
    router = createHarnessRouter({
      resolveActor: (identity) => harnessServiceHost!.resolveActor(identity),
      respond: async (identity, requestId, outcome) => {
        hostFor(identity.sessionId).respondHarness(identity.sessionId, requestId, outcome);
      },
      authorizeWorkspacePath: (actor, inputPath, options) => paths.resolve(actor, inputPath, options),
    });
    registerHarnessServices(router, harnessServiceHost);

    parentHost = new SessionHost({
      agentDir,
      configureServices,
      emit: <E extends HostEvent>(event: E, data: HostEventData<E>) => {
        const sessionId = parentHost?.sessionId;
        if (!sessionId) return;
        emitFrom(sessionId, event, data);
      },
      projectTrustOverride: true,
    });
    parentHost.setHarnessThreadRuntimeEnabled(true);

    let parentPhase = 0;
    let childPhase = 0;
    let followPhase = 0;
    const respond = (context: Context) => {
      const blob = JSON.stringify(context.messages);
      if (blob.includes("Read the retrieval report")) {
        followPhase += 1;
        const match = blob.match(/thread-[0-9a-f]{8}/i);
        if (followPhase === 1) {
          return fauxAssistantMessage([fauxToolCall("wait", match ? { ids: [match[0]] } : {})]);
        }
        if (followPhase === 2) {
          return fauxAssistantMessage([fauxToolCall("read_thread", {
            threadId: match?.[0] ?? "missing",
            what: "report",
          })]);
        }
        return fauxAssistantMessage("Parent read the retrieval report.");
      }
      if (getCurrentTools(normalizeContext(context).messages).some(tool => tool.name === "submit_facts")) {
        childPhase += 1;
        if (childPhase === 1) {
          return fauxAssistantMessage([fauxToolCall("explore", { question: "login helper", anchors: ["login"] })]);
        }
        if (childPhase === 2) {
          return fauxAssistantMessage([fauxToolCall("read", { path: "only-in-parent.ts" })]);
        }
        if (childPhase === 3) {
          return fauxAssistantMessage([fauxToolCall("symbols", { path: "only-in-parent.ts", query: "parentOnly" })]);
        }
        if (childPhase === 4) {
          return fauxAssistantMessage([fauxToolCall("read", { path: "src/auth.ts" })]);
        }
        if (childPhase === 5) {
          return fauxAssistantMessage([fauxToolCall("related", { anchor: "src/auth.ts" })]);
        }
        if (childPhase === 6) {
          return fauxAssistantMessage([fauxToolCall("submit_facts", {
            question: "Where is login implemented?",
            facts: [
              { claim: "login is exported from src/auth.ts", sources: [{ kind: "local", path: "src/auth.ts", startLine: 2, endLine: 4 }] },
              { claim: "parent-only source is frozen", sources: [{ kind: "local", path: "only-in-parent.ts", startLine: 1, endLine: 1 }] },
              { claim: "secret outside scope", sources: [{ kind: "local", path: "outside.ts", startLine: 1, endLine: 1 }] },
              { claim: "invented range", sources: [{ kind: "local", path: "src/auth.ts", startLine: 80, endLine: 90 }] },
            ],
            unknowns: ["who calls login"],
            attempted: [{ action: "related src/auth.ts", outcome: "unavailable" }],
          })]);
        }
        return fauxAssistantMessage("The login helper is exported from src/auth.ts; callers remain unknown.");
      }
      parentPhase += 1;
      if (parentPhase === 1) {
        return fauxAssistantMessage([fauxToolCall("dispatch", {
          preset: "retrieval",
          task: "Where is login implemented?",
          scope: ["src", "only-in-parent.ts"],
        })]);
      }
      return fauxAssistantMessage("dispatched retrieval");
    };
    faux.setResponses(Array.from({ length: 16 }, () => respond));

    try {
      const parent = await parentHost.create(workspace, "Parent");
      const parentThread = await registry.createThread({
        scopeId: identity.workspaceId,
        parent: { kind: "session", id: parent.sessionId },
        brief: "Parent implementation view",
        preset: "hard-implement",
        kind: "implementation",
        createdBy: "agent",
        // The parent Run occupies one root execution slot while it dispatches.
        // Give the delegated retrieval Run a second slot so this vertical slice
        // exercises execution rather than the queued-admission contract.
        concurrency: 2,
        autoRun: true,
        worktree: "isolated",
        tools: ["dispatch", "wait", "read_thread"],
        permissions: {},
      });
      const parentRun = await registry.startRun(identity.workspaceId, parentThread.id);
      await registry.markRunRunning(identity.workspaceId, parentThread.id, parentRun.id, parent.sessionId);
      const parentScratch = join(managedWorktreeRoot, parentThread.id);
      await mkdir(parentScratch, { recursive: true });
      await workingStates.withBranchStore(identity.workspaceId, "parent-frozen-only-file", async (store) => {
        const baseline = await store.captureDirectory(workspace);
        const branchId = `thread-${parentThread.id}`;
        await store.createBranch(identity.workspaceId, branchId, baseline, "parent-baseline");
        const body = Buffer.from("export const parentOnly = 'frozen-parent-body';\n", "utf8");
        const object = await store.putObject(body);
        await store.commitVirtualWrites(branchId, 0, { "only-in-parent.ts": {
          kind: "regular-file",
          objectHash: object.hash,
          byteLength: object.byteLength,
        } });
        await registry.setWorkingState(identity.workspaceId, parentThread.id, {
          branchId,
          worktree: {
            path: parentScratch,
            managedRoot: managedWorktreeRoot,
            base: "parent-baseline",
            viewMode: "virtual",
            materialized: false,
            preparationStage: "ready",
          },
        });
      });
      const beforeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
      const beforeStatus = execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: workspace });
      const beforeIndex = await readFile(join(workspace, ".git", "index"));
      await assert.rejects(readFile(join(workspace, "only-in-parent.ts")), { code: "ENOENT" });
      const first = await parentHost.prompt(parent.sessionId, parentUserText);
      assert.equal(first.accepted, true);
      await parentHost.session.waitForIdle();

      await waitUntil(async () => {
        const childId = [...childHosts.keys()][0];
        if (childId) {
          try {
            childTranscript = JSON.stringify(hostFor(childId).entries(childId, "branch").entries);
          } catch {
            // Child may already be closing while the Run settles.
          }
        }
        const threads = await registry.listThreads(identity.workspaceId, { kind: "thread", id: parentThread.id });
        const retrieval = threads.find((thread) => thread.preset === "retrieval");
        return retrieval?.lifecycle === "settled";
      });

      const threads = await registry.listThreads(identity.workspaceId, { kind: "thread", id: parentThread.id });
      const retrieval = threads.find((thread) => thread.preset === "retrieval");
      assert.ok(retrieval);
      assert.equal(retrieval.manifest.carryBlocks, false);
      assert.deepEqual(childScope, ["src", "only-in-parent.ts"]);
      assert.equal(childModelId, model.id);
      assert.ok(childTools.includes("submit_facts"));
      assert.ok(childTools.includes("explore"));
      assert.ok(!childTools.includes("bash"));
      assert.ok(!childTools.includes("edit"));
      assert.ok(!childInitialPrompt.includes(parentUserText));
      assert.ok(!childInitialPrompt.includes("<parent-blocks"));

      assert.ok(childTranscript.length > 0);
      assert.equal(childTranscript.includes(parentUserText), false);

      assert.equal(
        retrieval.report?.evidence?.facts.some((fact) => fact.status === "source-checked" && fact.claim.includes("login")),
        true,
        `${JSON.stringify(retrieval.report?.evidence)}\n${childTranscript}`,
      );
      assert.equal(retrieval.report?.evidence?.facts.some((fact) => fact.status === "source-checked" && fact.claim.includes("parent-only")), true);
      assert.equal(retrieval.report?.evidence?.facts.some((fact) => fact.claim.includes("secret outside")), false);
      assert.equal(retrieval.report?.evidence?.facts.some((fact) => fact.claim === "invented range" && fact.status === "source-checked"), false);
      assert.equal(retrieval.report?.conclusion, "The login helper is exported from src/auth.ts; callers remain unknown.");
      assert.equal(retrieval.report?.changedFiles.length, 0);
      assert.equal(retrieval.resultRevision, undefined);
      assert.equal(retrieval.integration, "none");
      assert.equal(retrieval.verification, undefined);
      assert.notEqual(path.resolve(retrieval.worktree!.path), path.resolve(workspace));
      assert.ok(path.resolve(retrieval.worktree!.path).startsWith(path.resolve(managedWorktreeRoot)));
      assert.equal(JSON.stringify(retrieval.report).includes("priority"), false);
      assert.equal(await readFile(join(workspace, "src", "auth.ts"), "utf8"), authBody);
      await assert.rejects(readFile(join(workspace, "only-in-parent.ts")), { code: "ENOENT" });
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }), beforeHead);
      assert.deepEqual(execFileSync("git", ["status", "--porcelain=v1", "-z"], { cwd: workspace }), beforeStatus);
      assert.deepEqual(await readFile(join(workspace, ".git", "index")), beforeIndex);

      const zone2 = await projectZone2Threads(
        { registry, cursors: harnessServiceHost.observationCursors },
        { sessionId: parent.sessionId, scopeId: identity.workspaceId },
      );
      assert.equal(zone2.status, "ready");
      if (zone2.status === "ready") {
        const projected = zone2.items.find((item) => item.id === retrieval.id);
        assert.ok(projected);
        assert.ok((projected?.evidenceSummary ?? "").includes("source-checked"));
        assert.equal(projected?.conclusion, retrieval.report?.conclusion);
      }

      const second = await parentHost.prompt(parent.sessionId, "Read the retrieval report");
      assert.equal(second.accepted, true);
      await parentHost.session.waitForIdle();
    } finally {
      await runtime?.dispose();
      for (const child of childHosts.values()) await child.dispose();
      await parentHost?.dispose();
      router?.dispose();
      await harnessServiceHost?.dispose();
      await registry.dispose();
      await compute.dispose();
      await native.dispose();
      await documents.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
