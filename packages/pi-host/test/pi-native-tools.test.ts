import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAgentSession, createMcpExtension, createCodemodeExtension, loadMcpRuntime, createToolSearchExtension, DefaultResourceLoader, ModelRuntime, SessionManager,
  type ExtensionFactory, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { McpAuthority, type McpAuthorityLease } from "../src/mcp-authority.js";
import { createMcpHarnessServices } from "../../web/application-host/lib/harness/mcp-service.js";
import type { McpOwnerRequest } from "@varin/protocol";
import { PiMcpConfigBridge, createPiMcpConfigBridgeExtension } from "../src/pi-mcp-config-bridge.js";
import { createPermissionGateExtension } from "../src/harness/permission-gate-extension.js";
import type { HostServicesBridge } from "../src/harness/host-services-bridge.js";
import { attachContextRequestBoundary, type ContextModelRequest } from "../src/harness/context-request-boundary.js";
import { createPiDocsTool, PI_CODEMODE_REFERENCE } from "../src/harness/pi-docs-tool.js";
import { projectMessage } from "../src/protocol-projector.js";

// Real local stdio MCP peer. No network, credentials, or paid model request.
const peer = `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line); if (request.id === undefined) continue;
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : request.method === 'tools/list'
    ? { tools: [{ name: 'echo', description: 'echo fixture', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, outputSchema: { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'] } }] }
    : request.method === 'tools/call'
    ? { content: [{ type: 'text', text: request.params.arguments.text }], structuredContent: { echoed: request.params.arguments.text } }
    : request.method === 'resources/list' ? { resources: [] }
    : request.method === 'resources/templates/list' ? { resourceTemplates: [] } : {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}`;

test("native codemode reads runtime references and projects image calls with non-token usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-native-images-"));
  const faux = fauxProvider(); const model = faux.getModel();
  const runtime = await ModelRuntime.create({ allowModelNetwork: false,
    authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
  runtime.registerProvider(model.provider, { streamSimple: faux.provider.streamSimple,
    api: model.api, baseUrl: model.baseUrl, models: [model] });
  await runtime.setRuntimeApiKey(model.provider, "local-fixture");
  const imageModel = runtime.getModelsOfType("image", "openrouter")[0]!;
  assert.ok(imageModel); await runtime.setRuntimeApiKey(imageModel.provider, "local-fixture");
  let imageCalls = 0;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8l0AAAAASUVORK5CYII=";
  // Only the provider result is mocked. The real registry, sandbox, journal and projector run.
  runtime.generateImages = async (resolved, context, options) => {
    imageCalls++; assert.equal(resolved.id, imageModel.id);
    assert.equal(context.input[0]?.type, "text"); assert.ok(options?.signal);
    return { api: resolved.api, provider: resolved.provider, model: resolved.id,
      output: [{ type: "image", data: png, mimeType: "image/png" }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0.05, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.05 } },
      stopReason: "stop", timestamp: Date.now() };
  };
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, extensionFactories: [
    { name: "codemode", builtin: true, replaceable: true,
      factory: createCodemodeExtension({ docsReference: PI_CODEMODE_REFERENCE }) },
  ] }); await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
    model, sessionManager: SessionManager.inMemory(root), resourceLoader: loader,
    customTools: [createPiDocsTool()], noTools: "builtin" });
  await session.bindExtensions({ mode: "rpc" }); session.setActiveToolsByName(["codemode"]);
  assert.equal(session.getActiveToolNames().includes("pi_docs"), false, "old loadouts do not need a new direct declaration");
  const code = `text(await tools.pi_docs({document:"codemode.md",limit:2}));
    const model = await models.getModelOfType("image",${JSON.stringify(imageModel.provider)},${JSON.stringify(imageModel.id)});
    const result = await models.generateImages(model,{input:[{type:"text",text:"fixture only"}]});
    for (const block of result.output) if (block.type === "image") image(block);`;
  faux.setResponses([() => fauxAssistantMessage([fauxToolCall("codemode", { code })]), () => fauxAssistantMessage("done")]);
  try {
    await session.prompt("local fixture");
    const entry = session.sessionManager.getBranch().find(entry => entry.type === "message" && entry.message.role === "toolResult");
    assert.ok(entry?.type === "message" && entry.message.role === "toolResult");
    const result = entry.message;
    assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(imageCalls, 1);
    assert.ok(result.content.some(block => block.type === "image"));
    assert.match(JSON.stringify(result.content), /Codemode/);
    assert.match(JSON.stringify(result.details), /models.generateImages/);
    assert.equal(result.usage?.cost.total, 0.05);
    const projected = projectMessage(result);
    assert.ok(projected.role === "toolResult");
    assert.equal(projected.usage?.totalTokens, 0); assert.equal(projected.usage?.cost.total, 0.05);
    assert.ok(projected.content.some(block => block.type === "image"));
    const current = session.sessionManager.buildSessionContext().messages.filter(message => message.role === "system").at(-1);
    assert.match(JSON.stringify(current), /pi_docs/);
  } finally { session.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("native virtual routing retains the selection and admits against the physical request limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-native-routing-"));
  const faux = fauxProvider({ models: [{ id: "physical", contextWindow: 8_000, maxTokens: 512 }] });
  const model = faux.getModel();
  faux.setResponses([() => ({ ...fauxAssistantMessage("routed response"), model: model.id, provider: model.provider, api: model.api })]);
  const runtime = await ModelRuntime.create({ allowModelNetwork: false,
    authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
  runtime.registerProvider(model.provider, { streamSimple: faux.provider.streamSimple,
    api: model.api, baseUrl: model.baseUrl, models: [model] });
  await runtime.setRuntimeApiKey(model.provider, "faux-key");
  const virtual = { provider: "routing", id: "adaptive", name: "adaptive",
    route: () => ({ model, thinkingLevel: "off" as const }) };
  runtime.registerVirtualModel(virtual);
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
    extensionFactories: [{ name: "routing", factory: pi => pi.registerVirtualModel(virtual) }] });
  await loader.reload();
  const selected = runtime.getModel("routing", "adaptive")!;
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
    model: selected, sessionManager: SessionManager.inMemory(root), resourceLoader: loader, tools: [] });
  await session.bindExtensions({ mode: "rpc" });
  const requests: ContextModelRequest[] = [];
  const boundary = attachContextRequestBoundary(session, {
    getCompactionSettings: () => ({ enabled: false, reserveTokens: 512, keepRecentTokens: 1_000 }),
    observe: request => requests.push(request), compact: async () => { throw new Error("unexpected compaction"); },
  });
  try {
    await session.prompt("route this request");
    assert.equal(requests[0]?.model.id, "physical");
    assert.equal(session.model?.id, "adaptive");
    assert.equal(session.routedModel?.model.id, "physical");
    const calls = faux.state.callCount;
    await session.prompt("large ".repeat(8_000));
    assert.equal(requests.at(-1)?.needsSpace, true);
    assert.equal(faux.state.callCount, calls, "over-capacity input never reaches the physical provider");
  } finally { boundary.dispose(); session.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("native MCP, codemode, permissions, nested events, and shutdown share one owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-native-mcp-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  const script = join(root, "peer.mjs"); await writeFile(script, peer);
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ operatorNote: "keep-this", mcpServers: {
    fixture: { command: process.execPath, args: [script] },
    secret: { url: "https://user:password@example.test/mcp?token=secret#secret", enabled: false },
  } }));
  const faux = fauxProvider(); const model = faux.getModel();
  const runtime = await ModelRuntime.create({ allowModelNetwork: false,
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  runtime.registerProvider(model.provider, { streamSimple: faux.provider.streamSimple,
    api: model.api, baseUrl: model.baseUrl, models: [model] });
  await runtime.setRuntimeApiKey(model.provider, "faux-key");
  const manager = SessionManager.inMemory(root);
  const bridge = new PiMcpConfigBridge(); const states: unknown[] = [];
  const mcpRuntime = await loadMcpRuntime(); let transports = 0;
  const authority = new McpAuthority({ createTransport: (...args) => { transports++; return mcpRuntime.createDefaultTransport(...args); } });
  const ownerScope = { agentDir, configCwd: root, executionCwd: root, environmentId: "fixture",
    executionScope: "workspace" as const, projectTrusted: true, sessionId: manager.getSessionId() };
  const host = createMcpHarnessServices(authority, () => ownerScope);
  const hostBridge = { request: async (method: string, params: unknown, options?: { signal?: AbortSignal }) => {
    assert.equal(method, "mcp.owner");
    return host.services["mcp.owner"].handle(params as McpOwnerRequest, {
      actor: { authorityInstanceId: "fixture", workerId: "pi-fixture", workerGeneration: 1,
        sessionId: manager.getSessionId(), workspaceId: "fixture", grantedCapabilities: ["control.mcp"] },
      sessionId: manager.getSessionId(), workspaceId: "fixture", authorizedPaths: [],
      signal: options?.signal ?? new AbortController().signal,
    });
  } } as Pick<HostServicesBridge, "request">;
  let nativeLease: McpAuthorityLease | undefined;
  const permissionCalls: string[] = [];
  let allowedTools: readonly string[] | undefined;
  const gate = createPermissionGateExtension({ cwd: root, sessionId: manager.getSessionId(),
    policy: { mode: "bypass", rules: [] }, allowedTools: () => allowedTools,
    bridge: { request: async (method, params) => {
      if (method === "permission.audit") return {};
      assert.equal(method, "permission.inspect");
      permissionCalls.push((params as { tool: string }).tool);
      return { ...params, action: "read", paths: [], networkTargets: [], threadScopes: [],
        executionWorkspaceId: "fixture", owningWorkspaceId: "fixture", evidenceComplete: true };
    } } as Pick<HostServicesBridge, "request">,
  });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, extensionFactories: [
    { name: "codemode", builtin: true, replaceable: true, factory: createCodemodeExtension() },
    { name: "tool-search", builtin: true, replaceable: true, factory: createToolSearchExtension() },
    { name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension(bridge.nativeOptions(agentDir, (_event, data) => states.push(data), hostBridge)) },
    { name: "config-bridge", factory: createPiMcpConfigBridgeExtension(bridge) },
    { name: "permission-gate", factory: gate },
  ] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime,
    model, sessionManager: manager, resourceLoader: loader, noTools: "builtin" });
  await session.bindExtensions({ mode: "rpc", onError: error => { throw new Error(error.error); } });
  const events: AgentSessionEvent[] = []; session.subscribe(event => events.push(event));
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(await tools.mcp__fixture__echo({text:"native echo"}));' })]),
    () => fauxAssistantMessage("done"),
    () => fauxAssistantMessage([fauxToolCall("codemode", { code: 'text(await tools.mcp__fixture__echo({text:"blocked"}));' })]),
    () => fauxAssistantMessage("blocked done"),
  ]);
  try {
    nativeLease = await authority.acquire(ownerScope, { servers: ["fixture"] });
    assert.equal(transports, 1, "Pi and native leases share one real MCP transport");
    const echo = nativeLease.binding.tools.find(tool => tool.tool === "echo")!;
    assert.ok(echo);
    assert.throws(() => nativeLease!.validateArguments(echo.name, echo.schemaVersion, { text: 7 }), /mcp-arguments-invalid/);
    assert.equal((await nativeLease.callTool(echo.name, { text: "shared owner" }, { schemaVersion: echo.schemaVersion,
      signal: new AbortController().signal })).structuredContent?.echoed, "shared owner");
    await session.prompt("native script");
    const results = manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult");
    const result = results[0]?.type === "message" && results[0].message.role === "toolResult" ? results[0].message : undefined;
    assert.ok(result && !result.isError, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /native echo/);
    assert.equal(result.nestedCalls?.calls[0]?.name, "mcp__fixture__echo");
    assert.ok(permissionCalls.includes("codemode") && permissionCalls.includes("mcp__fixture__echo"));
    assert.ok(events.some(event => event.type === "tool_execution_start" && event.toolName === "mcp__fixture__echo" && event.parentToolCallId));
    const snapshot = await bridge.snapshot(session.sessionId);
    assert.equal(snapshot.provider.owner, "native");
    assert.ok(snapshot.catalog?.sources.some(source => source.target.root === "agent" && source.target.path === "mcp.json"));
    assert.doesNotMatch(JSON.stringify(snapshot), /password|token=secret/);
    const command = session.extensionRunner?.getCommand("mcp"); assert.ok(command);
    await command.handler("disable fixture", session.extensionRunner!.createCommandContext());
    assert.throws(() => nativeLease!.assertCallable(echo.name, echo.schemaVersion), /mcp-owner-revoked/);
    const saved = await readFile(join(agentDir, "mcp.json"), "utf8");
    assert.match(saved, /keep-this/);
    assert.match(saved, /"enabled": false/);
    await command.handler("enable fixture", session.extensionRunner!.createCommandContext());
    allowedTools = ["codemode"];
    await session.prompt("blocked script");
    const final = manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "toolResult").at(-1);
    assert.ok(final?.type === "message" && final.message.role === "toolResult" && final.message.isError);
    assert.match(JSON.stringify(final), /authorized tool set/);
  } finally {
    await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
    nativeLease?.release(); host.dispose(); await authority.close();
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
  assert.ok(states.some(state => (state as { value?: unknown }).value === null), "shutdown clears the observed native owner");
});

test("a user MCP extension replaces the built-in owner through native Pi discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-mcp-choice-"));
  try {
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, extensionFactories: [
      { name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
      { name: "user-choice", factory: pi => { pi.registerCommand("mcp", {
        description: "chosen external MCP owner", handler: async () => {},
      }); } },
    ] });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.equal(loaded.errors.length, 0);
    const owners = loaded.extensions.filter(extension => extension.commands.has("mcp"));
    assert.equal(owners.length, 1);
    assert.equal(owners[0]?.commands.get("mcp")?.description, "chosen external MCP owner");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native nested calls retain resource ordering without serializing independent calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "varin-native-nested-"));
  const faux = fauxProvider(); const model = faux.getModel();
  const runtime = await ModelRuntime.create({ allowModelNetwork: false,
    authPath: join(root, "auth.json"), modelsPath: join(root, "models.json") });
  runtime.registerProvider(model.provider, { streamSimple: faux.provider.streamSimple,
    api: model.api, baseUrl: model.baseUrl, models: [model] });
  await runtime.setRuntimeApiKey(model.provider, "faux-key");
  const log: string[] = []; let release!: () => void; let started = 0;
  const pair = new Promise<void>(resolve => { release = resolve; });
  const extension: ExtensionFactory = pi => {
    pi.registerTool({ name: "work", label: "work", description: "work",
      parameters: Type.Object({ key: Type.String(), independent: Type.Boolean() }),
      prepareExecution: args => ({ resources: [{ id: args.key, access: "write" }] }),
      execute: async (_id, args) => {
        log.push(`start:${args.key}`);
        if (args.independent) { if (++started === 2) release(); await pair; }
        log.push(`end:${args.key}`);
        return { content: [{ type: "text", text: args.key }], details: {} };
      } });
    pi.registerTool({ name: "orchestrate", label: "orchestrate", description: "orchestrate",
      parameters: Type.Object({}), execute: async (_id, _args, _signal, _update, ctx) => {
        await Promise.all([ctx.executeTool("work", { key: "a", independent: true }), ctx.executeTool("work", { key: "b", independent: true })]);
        await Promise.all([ctx.executeTool("work", { key: "same", independent: false }), ctx.executeTool("work", { key: "same", independent: false })]);
        return { content: [{ type: "text", text: "done" }], details: {} };
      } });
  };
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root,
    extensionFactories: [{ name: "fixture", factory: extension }] }); await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime,
    model, sessionManager: SessionManager.inMemory(root), resourceLoader: loader, noTools: "builtin" });
  await session.bindExtensions({ mode: "rpc", onError: error => { throw new Error(error.error); } });
  faux.setResponses([() => fauxAssistantMessage([fauxToolCall("orchestrate", {})]), () => fauxAssistantMessage("done")]);
  try {
    await session.prompt("work");
    assert.ok(log.indexOf("start:b") < log.indexOf("end:a"));
    assert.deepEqual(log.slice(4), ["start:same", "end:same", "start:same", "end:same"]);
  } finally { session.dispose(); await rm(root, { recursive: true, force: true }); }
});
