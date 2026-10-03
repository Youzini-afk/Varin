import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { SurfaceExtensionRuntime } from "@varin/extension-surface";
import {
  createVarinEditorMonacoClient,
  defineEditorMount,
  defineSurfaceMount,
  resolveHostExtensionModule,
  resolveIsolatedExtensionModule,
  resolveSurfaceExtensionModule,
  type VarinExtensionMigrationInput,
} from "../src/index.js";
import {
  runEditorExtensionConformance,
  runHostExtensionConformance,
  runIsolatedExtensionConformance,
  runSurfaceExtensionConformance,
} from "../src/testing.js";

test("the author conformance harness proves contribution and service teardown", async () => {
  const runtime = new SurfaceExtensionRuntime({ surface: "web" });
  const result = await runSurfaceExtensionConformance({
    activation: (context) => {
      context.contribute({
        contractVersion: 1,
        data: {},
        id: "dev.example.conformance.page",
        kind: "page",
        supports: ["web"],
      }, {});
      context.provide({ id: "dev.example.conformance.service", version: 1 }, {});
    },
    owner: {
      desiredRevision: 1,
      entrypointId: "main",
      extensionId: "dev.example.conformance",
      extensionVersion: "1.0.0",
      generation: 1,
      hostId: "2d7b1dc1-7ccd-4be7-9fd1-23f31dc8cf1a",
      realmId: "conformance",
    },
    runtime,
  });
  assert.deepEqual(result.activeContributionIds, ["dev.example.conformance.page"]);
  assert.deepEqual(result.activeServiceIds, ["dev.example.conformance.service"]);
  assert.equal(runtime.getSnapshot().contributions.length, 0);
});

test("the author conformance harness exercises Host storage, services, and cleanup", async () => {
  let disposed = false;
  const result = await runHostExtensionConformance({
    extensionId: "dev.example.host-conformance",
    activation: async (context) => {
      context.services.provide({ id: "dev.example.host-service", version: 1 }, { read: () => "ok" });
      await context.storage.update({ ready: true });
      const workspace = await context.storage.open({ key: "preferences", schemaVersion: 2, scope: "workspace" });
      await workspace.update({ layout: "wide" });
      context.effect(() => { disposed = true; });
    },
  });
  assert.deepEqual(result.providedServiceIds, ["dev.example.host-service@1"]);
  assert.deepEqual(result.finalStorage.document.data, { ready: true });
  assert.deepEqual(
    result.finalStorages.find((snapshot) => snapshot.address.scope === "workspace")?.document.data,
    { layout: "wide" },
  );
  assert.equal(result.registeredDisposers, 1);
  assert.equal(disposed, true);
});

test("the author conformance harness exercises isolated contributions and cleanup", async () => {
  let disposed = false;
  const result = await runIsolatedExtensionConformance({
    activation: (context) => {
      context.contribute({
        contractVersion: 1,
        data: {},
        id: "dev.example.isolated.page",
        kind: "page",
        supports: ["web"],
      });
      context.effect(() => { disposed = true; });
    },
  });
  assert.deepEqual(result.contributionIds, ["dev.example.isolated.page"]);
  assert.equal(result.registeredDisposers, 1);
  assert.equal(disposed, true);
});

test("the typed optional Monaco client uses the same serializable service in managed and isolated realms", async () => {
  const service = {
    getActiveView: () => ({
      status: "ready" as const,
      view: {
        documentVersion: 3,
        focused: true,
        generation: 2,
        kind: "text" as const,
        languageId: "typescript",
        providerId: "varin.builtin.text",
        resource: { resourceId: "src/main.ts", workspaceId: "workspace" },
        selection: null,
        viewId: "view-1",
      },
    }),
    getState: () => ({
      status: "ready" as const,
      state: { activeViewId: "view-1", revision: 1, views: [] },
    }),
    waitForState: () => ({
      status: "ready" as const,
      state: { activeViewId: "view-1", revision: 2, views: [] },
    }),
  };
  const managed = createVarinEditorMonacoClient({
    useService: () => service as never,
  });
  assert.equal((await managed.getActiveView()).status, "ready");
  const managedState = await managed.waitForState({ afterRevision: 1 });
  assert.equal(managedState.status, "ready");
  assert.equal(managedState.status === "ready" ? managedState.state.revision : null, 2);
  assert.equal((await createVarinEditorMonacoClient({ useService: () => undefined }).getActiveView()).status, "absent");

  let isolatedStatus = "missing";
  await runIsolatedExtensionConformance({
    activation: async (context) => {
      const client = createVarinEditorMonacoClient(context);
      isolatedStatus = (await client.getActiveView()).status;
      const isolatedState = await client.getState();
      assert.equal(isolatedState.status === "ready" ? isolatedState.state.revision : null, 1);
    },
    services: [{
      descriptor: { id: "varin.editor.monaco", version: 1 },
      implementation: service,
      providerId: "varin.builtin.text",
    }],
  });
  assert.equal(isolatedStatus, "ready");
  await runIsolatedExtensionConformance({
    activation: async (context) => {
      isolatedStatus = (await createVarinEditorMonacoClient(context).getActiveView()).status;
    },
  });
  assert.equal(isolatedStatus, "absent");
});

test("module resolvers preserve extension-object method ownership", async () => {
  const host = resolveHostExtensionModule({
    value: "host-owned",
    activate() {
      assert.equal((this as { value: string }).value, "host-owned");
    },
    migrate(input: VarinExtensionMigrationInput) {
      assert.equal((this as { value: string }).value, "host-owned");
      return input.data;
    },
  } as never);
  await runHostExtensionConformance({ activation: host.activate, extensionId: "dev.example.bound-host" });
  assert.deepEqual(await host.migrate?.({ data: { ok: true }, fromSchemaVersion: 1, toSchemaVersion: 2 }), { ok: true });

  const isolated = resolveIsolatedExtensionModule({
    value: "isolated-owned",
    activate() {
      assert.equal((this as { value: string }).value, "isolated-owned");
    },
  } as never);
  await runIsolatedExtensionConformance({ activation: isolated.activate });

  const surface = resolveSurfaceExtensionModule({
    value: "surface-owned",
    activate() {
      assert.equal((this as { value: string }).value, "surface-owned");
    },
  } as never);
  await surface.activate({} as never);
});

test("defineSurfaceMount exposes the framework-neutral DOM lifecycle contract", async () => {
  const controller = new AbortController();
  const container = { textContent: "" } as HTMLElement;
  let disposed = 0;
  const implementation = defineSurfaceMount<{ label: string }>(async (element, context) => {
    assert.equal(context.contributionId, "dev.example.mount.panel");
    assert.equal(context.owner.extensionId, "dev.example.mount");
    assert.equal(context.signal, controller.signal);
    element.textContent = context.props.label;
    return () => {
      disposed += 1;
      element.textContent = "";
    };
  });

  const cleanup = await implementation.mount(container, {
    contributionId: "dev.example.mount.panel",
    owner: {
      desiredRevision: 1,
      entrypointId: "main",
      extensionId: "dev.example.mount",
      extensionVersion: "1.0.0",
      generation: 1,
      hostId: "72694a4f-093a-4f79-8763-3ca9f06b7078",
      realmId: "mount-test",
    },
    props: { label: "framework neutral" },
    reportError: (error) => { throw error; },
    signal: controller.signal,
  });
  assert.equal(container.textContent, "framework neutral");
  assert.equal(typeof cleanup, "function");
  if (typeof cleanup === "function") await cleanup();
  assert.equal(disposed, 1);
  assert.equal(container.textContent, "");
});

test("workspace.documents capability helper forwards resource-scoped calls", async () => {
  const { callWorkspaceDocuments, VARIN_WORKSPACE_DOCUMENTS_CAPABILITY } = await import("../src/index.js");
  assert.equal(VARIN_WORKSPACE_DOCUMENTS_CAPABILITY, "workspace.documents");
  const calls: Array<[string, string, unknown]> = [];
  const result = await callWorkspaceDocuments({
    call: async (capability, method, params) => {
      calls.push([capability, method, params]);
      return { status: "missing", resource: params };
    },
  }, "read", { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resourceId: "note.txt" });
  assert.deepEqual(calls, [[
    "workspace.documents",
    "read",
    { workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", resourceId: "note.txt" },
  ]]);
  assert.equal((result as { status?: string }).status, "missing");
});

test("workspace.search and workspace.language capability helpers forward host calls", async () => {
  const {
    callWorkspaceLanguage,
    callWorkspaceSearch,
    VARIN_WORKSPACE_LANGUAGE_CAPABILITY,
    VARIN_WORKSPACE_SEARCH_CAPABILITY,
  } = await import("../src/index.js");
  assert.equal(VARIN_WORKSPACE_SEARCH_CAPABILITY, "workspace.search");
  assert.equal(VARIN_WORKSPACE_LANGUAGE_CAPABILITY, "workspace.language");
  const calls: Array<[string, string, unknown]> = [];
  const client = {
    call: async (capability: string, method: string, params: unknown) => {
      calls.push([capability, method, params]);
      return { status: "absent" };
    },
  };
  await callWorkspaceSearch(client, "searchContent", { workspaceId: "ws", query: "todo" });
  await callWorkspaceLanguage(client, "getStatus", { workspaceId: "ws", languageId: "typescript" });
  assert.deepEqual(calls, [
    ["workspace.search", "searchContent", { workspaceId: "ws", query: "todo" }],
    ["workspace.language", "getStatus", { workspaceId: "ws", languageId: "typescript" }],
  ]);
});

test("typed document and language clients forward calls and providers confine package assets", async () => {
  const {
    createWorkspaceDocumentsClient,
    createWorkspaceLanguageClient,
    defineLanguageProvider,
  } = await import("../src/index.js");
  const calls: Array<[string, string]> = [];
  const capabilities = {
    call: async (capability: string, method: string) => {
      calls.push([capability, method]);
      if (method === "write") return { status: "written", revision: "d1_1", byteLength: 3 };
      if (method === "registerProvider") return { status: "registered", providerId: "md" };
      return { status: "ok" };
    },
  };
  const written = await createWorkspaceDocumentsClient(capabilities).write({
    resource: { workspaceId: "ws", resourceId: "note.txt" },
    content: "one",
    encoding: "utf-8",
    bom: false,
    expectedRevision: null,
    operationId: "op-1",
  });
  assert.equal((written as { status?: string }).status, "written");
  await createWorkspaceLanguageClient(capabilities).registerProvider({
    command: "node",
    languageIds: ["markdown"],
    providerId: "md",
  });
  const packageRoot = join(process.cwd(), "extension-fixture");
  const provider = defineLanguageProvider((context) => {
    assert.equal(context.assets.path("runtime/server.mjs"), join(packageRoot, "runtime", "server.mjs"));
    assert.throws(() => context.assets.path("../outside.mjs"), /escapes the extension package/);
    return {
      command: "node",
      languageIds: ["markdown"],
      providerId: "md",
    };
  });
  await runHostExtensionConformance({
    activation: provider.activate,
    extensionId: "dev.example.language",
    packageRoot,
  });
  assert.deepEqual(calls.slice(0, 2), [
    ["workspace.documents", "write"],
    ["workspace.language", "registerProvider"],
  ]);
});

test("debug and test host helpers register through capabilities and unregister on dispose", async () => {
  const {
    createWorkspaceDebugClient,
    createWorkspaceTestClient,
    callWorkspaceTasks,
    defineDebugAdapter,
    defineTestProvider,
    VARIN_WORKBENCH_CONTEXT_KEYS,
    VARIN_WORKSPACE_DEBUG_CAPABILITY,
    VARIN_WORKSPACE_TASKS_CAPABILITY,
    VARIN_WORKSPACE_TEST_CAPABILITY,
  } = await import("../src/index.js");
  assert.equal(VARIN_WORKSPACE_DEBUG_CAPABILITY, "workspace.debug");
  assert.equal(VARIN_WORKSPACE_TEST_CAPABILITY, "workspace.test");
  assert.equal(VARIN_WORKSPACE_TASKS_CAPABILITY, "workspace.tasks");
  assert.equal(VARIN_WORKBENCH_CONTEXT_KEYS.debugIsPaused, "debugIsPaused");
  const calls: Array<[string, string]> = [];
  const capabilities = {
    call: async (capability: string, method: string) => {
      calls.push([capability, method]);
      return { status: "ok" };
    },
  };
  await createWorkspaceDebugClient(capabilities).registerAdapter({
    adapterId: "node",
    command: "node",
  });
  await createWorkspaceTestClient(capabilities).registerProvider({
    providerId: "node-test",
    command: "node",
  });
  await callWorkspaceTasks(capabilities, "list", { workspaceId: "ws" });
  const debugResult = await runHostExtensionConformance({
    activation: defineDebugAdapter({ adapterId: "node", command: "node" }).activate,
    extensionId: "dev.example.debug",
  });
  const testResult = await runHostExtensionConformance({
    activation: defineTestProvider({ providerId: "node-test", command: "node" }).activate,
    extensionId: "dev.example.test",
  });
  assert.ok(debugResult.registeredDisposers >= 1);
  assert.ok(testResult.registeredDisposers >= 1);
  assert.deepEqual(calls, [
    ["workspace.debug", "registerAdapter"],
    ["workspace.test", "registerProvider"],
    ["workspace.tasks", "list"],
  ]);
});

test("workbench conformance covers async mount abort, profile switch, and resource conflict", async () => {
  const {
    runIsolatedDocumentConflictConformance,
    runSurfaceMountConformance,
    runWorkbenchProfileConformance,
  } = await import("../src/testing.js");
  const mount = await runSurfaceMountConformance();
  assert.equal(mount.mounted, true);
  assert.equal(mount.disposed, true);
  assert.equal(mount.aborted, true);
  const profiles = runWorkbenchProfileConformance();
  assert.equal(profiles.beforeSwitch, "default");
  assert.equal(profiles.afterSwitch, "studio");
  assert.equal(profiles.desiredEnabledUnchanged, true);
  assert.equal(profiles.failedCandidateKeepsPrevious, true);
  assert.equal((await runIsolatedDocumentConflictConformance()).status, "conflict");
});

test("editor conformance exercises incremental typed failures and mount cleanup", async () => {
  const implementation = defineEditorMount((_container, mount) => {
    const unsubscribe = mount.props.document.subscribe(() => undefined);
    return () => unsubscribe();
  });
  const result = await runEditorExtensionConformance({ implementation });
  assert.deepEqual(result, {
    aborted: true,
    appliedStatus: "applied",
    conflictStatus: "conflict",
    disposed: true,
    invalidStatus: "invalid-range",
    overlappingStatus: "overlapping-ranges",
    staleStatus: "stale",
    subscriptionsReleased: true,
    unsupportedStatus: "unsupported",
  });
});
