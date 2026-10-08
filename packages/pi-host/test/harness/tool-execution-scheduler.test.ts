import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runAgentLoop,
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentTool,
  type ToolExecutionPlan,
} from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type JsonValue,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionContext, ToolCallEvent, ToolCallEventResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_HARNESS_SETTINGS, defaultRules, type PermissionInspectParams } from "@varin/protocol";
import { withToolExecutionResources } from "../../src/harness/tool-execution-resources.js";
import { createPermissionGateExtension } from "../../src/harness/permission-gate-extension.js";
import { selectHarnessTools } from "../../src/harness/select-tools.js";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "test",
  model: "test",
  usage,
  stopReason,
  timestamp: Date.now(),
});

const responseStream = (message: AssistantMessage): AssistantMessageEventStream => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push(message.stopReason === "error" || message.stopReason === "aborted"
      ? { type: "error", reason: message.stopReason, error: message }
      : { type: "done", reason: message.stopReason as "stop" | "toolUse", message });
  });
  return stream;
};

const runBatch = async (
  tools: AgentTool[],
  calls: Array<{ id: string; name: string; arguments: Record<string, JsonValue> }>,
  config: Partial<AgentLoopConfig> = {},
  onEvent?: (event: AgentEvent) => void,
) => {
  let request = 0;
  const context: AgentContext = { messages: [{ role: "system", content: "test", timestamp: 0 }], tools };
  const events: unknown[] = [];
  const messages = await runAgentLoop(
    [{ role: "user", content: "run", timestamp: Date.now() }],
    context,
    {
      model: { provider: "test", id: "test", api: "openai-responses" } as AgentLoopConfig["model"],
      convertToLlm: (input) => input as never,
      ...config,
    },
    async (event) => { events.push(event); onEvent?.(event); },
    undefined,
    () => responseStream(request++ === 0
      ? assistant(calls.map((call) => ({ type: "toolCall", ...call })), "toolUse")
      : assistant([{ type: "text", text: "done" }], "stop")),
  );
  return { events, messages };
};

const WorkParams = Type.Object({
  label: Type.String(),
  resource: Type.String(),
  access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
});

test("Pi overlaps independent calls around a failing unknown sequential barrier", async () => {
  const log: string[] = [];
  let releaseBefore!: () => void;
  let releaseAfter!: () => void;
  const before = new Promise<void>((resolve) => { releaseBefore = resolve; });
  const after = new Promise<void>((resolve) => { releaseAfter = resolve; });
  let beforeStarted = 0;
  let afterStarted = 0;

  const work: AgentTool<typeof WorkParams> = {
    name: "work",
    label: "work",
    description: "work",
    parameters: WorkParams,
    prepareExecution: (args): ToolExecutionPlan => ({
      resources: [{ id: args.resource, access: args.access }],
    }),
    execute: async (_id, args) => {
      log.push(`start:${args.label}`);
      if (args.label === "a" || args.label === "b") {
        beforeStarted += 1;
        if (beforeStarted === 2) releaseBefore();
        await before;
      } else {
        afterStarted += 1;
        if (afterStarted === 2) releaseAfter();
        await after;
      }
      log.push(`end:${args.label}`);
      return { content: [{ type: "text", text: args.label }], details: {} };
    },
  };
  const barrier: AgentTool = {
    name: "barrier",
    label: "barrier",
    description: "barrier",
    parameters: Type.Object({}),
    executionMode: "sequential",
    execute: async () => {
      log.push("start:barrier", "fail:barrier");
      throw new Error("barrier failed");
    },
  };

  await runBatch([work, barrier], [
    { id: "a", name: "work", arguments: { label: "a", resource: "path:a", access: "write" } },
    { id: "b", name: "work", arguments: { label: "b", resource: "path:b", access: "write" } },
    { id: "barrier", name: "barrier", arguments: {} },
    { id: "c", name: "work", arguments: { label: "c", resource: "path:c", access: "write" } },
    { id: "d", name: "work", arguments: { label: "d", resource: "path:d", access: "write" } },
  ]);

  assert.ok(log.indexOf("start:b") < log.indexOf("end:a"));
  assert.ok(log.indexOf("start:a") < log.indexOf("end:b"));
  assert.ok(log.indexOf("start:barrier") > log.indexOf("end:a"));
  assert.ok(log.indexOf("start:barrier") > log.indexOf("end:b"));
  assert.ok(log.indexOf("start:c") > log.indexOf("fail:barrier"));
  assert.ok(log.indexOf("start:d") < log.indexOf("end:c"));
});

test("Pi preserves same-resource order and still lets a later read inspect failure state", async () => {
  let firstSettled = false;
  let secondExecuted = false;
  let secondSawSettled = false;
  const tool: AgentTool<typeof WorkParams> = {
    name: "work",
    label: "work",
    description: "work",
    parameters: WorkParams,
    prepareExecution: (args) => ({ resources: [{ id: args.resource, access: args.access }] }),
    execute: async (_id, args) => {
      if (args.label === "edit") {
        firstSettled = true;
        throw new Error("edit failed");
      }
      secondExecuted = true;
      secondSawSettled = firstSettled;
      return { content: [{ type: "text", text: "current state" }], details: {} };
    },
  };
  const { messages } = await runBatch([tool], [
    { id: "edit", name: "work", arguments: { label: "edit", resource: "path:same", access: "write" } },
    { id: "read", name: "work", arguments: { label: "read", resource: "path:same", access: "read" } },
  ]);
  assert.equal(secondExecuted, true);
  assert.equal(secondSawSettled, true);
  const first = messages.find((message) => message.role === "toolResult" && message.toolCallId === "edit");
  assert.equal(first?.role === "toolResult" && first.isError, true);
  const second = messages.find((message) => message.role === "toolResult" && message.toolCallId === "read");
  assert.equal(second?.role, "toolResult");
  if (second?.role === "toolResult") {
    assert.equal(second.isError, false);
    assert.match(second.content[0]?.type === "text" ? second.content[0].text : "", /current state/);
  }
});

test("Pi resolves resource effects only after the permission hook approves", async () => {
  let planned = 0;
  let executed = 0;
  const tool: AgentTool<typeof WorkParams> = {
    name: "work",
    label: "work",
    description: "work",
    parameters: WorkParams,
    prepareExecution: () => {
      planned += 1;
      return { resources: [] };
    },
    execute: async () => {
      executed += 1;
      return { content: [{ type: "text", text: "unexpected" }], details: {} };
    },
  };
  await runBatch([tool], [
    { id: "blocked", name: "work", arguments: { label: "blocked", resource: "path:a", access: "read" } },
  ], {
    beforeToolCall: async () => ({ block: true, reason: "denied" }),
  });
  assert.equal(planned, 0);
  assert.equal(executed, 0);
});

test("Pi merges Host-authoritative permission resources with tool-owned effects", async () => {
  let active = false;
  let overlapped = false;
  const tool: AgentTool<typeof WorkParams> = {
    name: "work",
    label: "work",
    description: "work",
    parameters: WorkParams,
    prepareExecution: (args) => ({ resources: [{ id: args.resource, access: args.access }] }),
    execute: async () => {
      if (active) overlapped = true;
      active = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      active = false;
      return { content: [{ type: "text", text: "done" }], details: {} };
    },
  };
  await runBatch([tool], [
    { id: "one", name: "work", arguments: { label: "one", resource: "local:a", access: "write" } },
    { id: "two", name: "work", arguments: { label: "two", resource: "local:b", access: "write" } },
  ], {
    beforeToolCall: async () => ({
      executionPlan: { resources: [{ id: "host-path:canonical-same", access: "write" }] },
    }),
  });
  assert.equal(overlapped, false);
});

test("Harness plans full patch paths and directory descendants with canonical identities", async () => {
  const definition = (name: string): ToolDefinition => withToolExecutionResources({
    name,
    label: name,
    description: name,
    parameters: Type.Any(),
    execute: async () => ({ content: [], details: {} }),
  }, process.cwd());
  const write = await definition("write").prepareExecution?.({ path: "src/../same.ts" });
  const read = await definition("read").prepareExecution?.({ path: "same.ts" });
  const grep = await definition("grep").prepareExecution?.({ path: "." });
  const patch = await definition("apply_patch").prepareExecution?.({
    patch: "*** Begin Patch\n*** Update File: same.ts\n@@\n-old\n+new\n*** Add File: nested/new.ts\n+new\n*** End Patch",
  });

  assert.equal(write?.resources?.[0]?.id, read?.resources?.[0]?.id);
  assert.equal(grep?.resources?.[0]?.scope, "subtree");
  assert.ok(write?.resources?.[0]?.ancestors?.includes(grep?.resources?.[0]?.id ?? ""));
  assert.equal(patch?.resources?.length, 2);
  assert.equal(new Set(patch?.resources?.map((resource) => resource.id)).size, 2);
  assert.equal((await definition("merge").prepareExecution?.({ threadId: "thread-1" }))?.barrier, true);
});

test("Harness execution plans order a workspace write before dispatch-style capture", async () => {
  let writeFinished = false;
  let captureSawWrite = false;
  const write = withToolExecutionResources({
    name: "write",
    label: "write",
    description: "write",
    parameters: Type.Object({ path: Type.String() }),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      writeFinished = true;
      return { content: [{ type: "text" as const, text: "written" }], details: {} };
    },
  }, process.cwd());
  const dispatch = withToolExecutionResources({
    name: "dispatch",
    label: "dispatch",
    description: "dispatch",
    parameters: Type.Object({ task: Type.String() }),
    execute: async () => {
      captureSawWrite = writeFinished;
      return { content: [{ type: "text" as const, text: "captured" }], details: {} };
    },
  }, process.cwd());

  await runBatch([write as unknown as AgentTool, dispatch as unknown as AgentTool], [
    { id: "write", name: "write", arguments: { path: "src/file.ts" } },
    { id: "dispatch", name: "dispatch", arguments: { task: "inspect current files" } },
  ]);
  assert.equal(captureSawWrite, true);
});

test("computer status calls finish while a preceding dispatch is still preparing", { timeout: 5000 }, async () => {
  let release!: () => void;
  let statusReady!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const statuses = new Promise<void>(resolve => { statusReady = resolve; });
  const observed: string[] = [];
  let dispatchFinished = false;
  const result = () => ({ content: [{ type: "text" as const, text: "done" }], details: {} });
  const dispatch = withToolExecutionResources({
    name: "dispatch", label: "dispatch", description: "dispatch",
    parameters: Type.Object({ task: Type.String() }),
    execute: async () => { await held; dispatchFinished = true; return result(); },
  }, process.cwd());
  const computer = withToolExecutionResources({
    name: "computer", label: "computer", description: "computer", executionMode: "sequential" as const,
    parameters: Type.Object({ action: Type.String() }),
    execute: async (_id: string, args: { action: string }) => {
      observed.push(args.action);
      if (observed.length === 2) statusReady();
      return result();
    },
  }, process.cwd());
  const running = runBatch([dispatch, computer] as unknown as AgentTool[], [
    { id: "dispatch", name: "dispatch", arguments: { task: "inspect current files" } },
    { id: "access", name: "computer", arguments: { action: "access" } },
    { id: "list", name: "computer", arguments: { action: "list" } },
  ]);
  try {
    await statuses;
    assert.equal(dispatchFinished, false);
    assert.deepEqual(observed.sort(), ["access", "list"]);
  } finally { release(); await running; }
});

test("retrieval overlaps source writes, unrelated writes and experiment reads", async () => {
  const log: string[] = [];
  let release!: () => void;
  let readEntered!: () => void;
  let writeEntered!: () => void;
  let sourceEntered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const read = new Promise<void>((resolve) => { readEntered = resolve; });
  const write = new Promise<void>((resolve) => { writeEntered = resolve; });
  const source = new Promise<void>((resolve) => { sourceEntered = resolve; });
  const result = () => ({ content: [{ type: "text" as const, text: "done" }], details: {} });
  const explore = withToolExecutionResources({
    name: "explore", label: "explore", description: "explore", executionMode: "parallel" as const,
    parameters: Type.Object({ question: Type.String(), paths: Type.Array(Type.String()) }),
    execute: async () => { log.push("search:start"); await held; log.push("search:end"); return result(); },
  }, process.cwd());
  const edit = withToolExecutionResources({
    name: "edit", label: "edit", description: "edit", executionMode: "sequential" as const,
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id: string, args: { path: string }) => {
      log.push(args.path);
      if (args.path === "artifacts/health.txt") writeEntered();
      if (args.path === "src/source.ts") sourceEntered();
      return result();
    },
  }, process.cwd());
  const experiment = withToolExecutionResources({
    name: "experiment", label: "experiment", description: "experiment", executionMode: "sequential" as const,
    parameters: Type.Object({ action: Type.String() }),
    execute: async () => { log.push("experiment:list"); readEntered(); return result(); },
  }, process.cwd());
  const running = runBatch([explore, edit, experiment] as unknown as AgentTool[], [
    { id: "search", name: "explore", arguments: { question: "source", paths: ["src"] } },
    { id: "observe", name: "experiment", arguments: { action: "list" } },
    { id: "unrelated", name: "edit", arguments: { path: "artifacts/health.txt" } },
    { id: "source", name: "edit", arguments: { path: "src/source.ts" } },
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all([read, write, source]), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("independent tools waited for retrieval")), 5_000);
    })]);
    assert.ok(log.includes("search:start"));
    assert.ok(log.includes("src/source.ts"));
  } finally {
    clearTimeout(timer);
    release();
    await running;
  }
  assert.ok(log.indexOf("src/source.ts") < log.indexOf("search:end"));
});

test("registered diagnostics, memory, settings and history finish while retrieval is still running through the permission gate", async () => {
  const cwd = process.cwd();
  const bridge = { request: async (method: string, params: PermissionInspectParams) => {
    if (method === "permission.audit") return { accepted: true };
    assert.equal(method, "permission.inspect");
    assert.deepEqual(params.paths, []);
    return { ...params, executionWorkspaceId: "workspace", owningWorkspaceId: "workspace", paths: [] };
  } } as never;
  const definitions = selectHarnessTools(DEFAULT_HARNESS_SETTINGS, {
    bridge, sessionId: "session", cwd, workspaceMutationJournal: undefined,
    isOpenAIFamily: false, settingsAvailable: true,
  });
  let gate!: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void>;
  createPermissionGateExtension({ policy: { mode: "bypass", rules: defaultRules("bypass") }, sessionId: "session", cwd, bridge })({
    getAllTools: () => definitions.map(tool => ({ ...tool,
      sourceInfo: { path: "<sdk>", source: "sdk", scope: "temporary", origin: "top-level" },
    })),
    registerCommand: () => {},
    on: (event: string, handler: typeof gate) => { if (event === "tool_call") gate = handler; },
  } as never);
  let release!: () => void;
  let finished!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const fastFinished = new Promise<void>(resolve => { finished = resolve; });
  const starts: string[] = [];
  const ends: Array<Extract<AgentEvent, { type: "tool_execution_end" }>> = [];
  const tools = definitions.map(tool => ({ ...tool, execute: async () => {
    starts.push(tool.name);
    if (tool.name === "explore") await held;
    return { content: [{ type: "text" as const, text: tool.name }], details: {} };
  } })) as AgentTool[];
  const running = runBatch(tools, [
    { id: "search", name: "explore", arguments: { question: "shell background execution" } },
    { id: "network", name: "network_diag", arguments: { url: "https://example.com" } },
    { id: "memory", name: "memory", arguments: { action: "search", query: "shell" } },
    { id: "settings", name: "settings_search", arguments: { query: "shell" } },
    { id: "history", name: "history", arguments: { query: "shell" } },
  ], {
    beforeToolCall: async ({ toolCall, args }) => (await gate({ type: "tool_call", toolCallId: toolCall.id,
      toolName: toolCall.name, input: args } as ToolCallEvent, { cwd } as ExtensionContext)) ?? undefined,
  }, event => {
    if (event.type !== "tool_execution_end") return;
    ends.push(event);
    if (ends.length === 4) finished();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([fastFinished, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("read tools were held behind retrieval")), 5_000);
    })]);
    assert.ok(starts.includes("explore"));
    assert.deepEqual(ends.map(event => event.toolName).sort(), ["history", "memory", "network_diag", "settings_search"]);
    assert.ok(ends.every(event => !event.isError && starts.includes(event.toolName)));
  } finally {
    clearTimeout(timer);
    release();
    await running;
  }
});

test("memory mutations order later reads while unrelated tools can finish", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const log: string[] = [];
  const memory = withToolExecutionResources({
    name: "memory", label: "memory", description: "memory", executionMode: "sequential" as const,
    parameters: Type.Object({ action: Type.String() }),
    execute: async (_id: string, args: { action: string }) => {
      log.push(`start:${args.action}`);
      if (args.action === "remember") await held;
      log.push(`end:${args.action}`);
      return { content: [], details: {} };
    },
  }, process.cwd());
  const independent: AgentTool = {
    name: "independent", label: "independent", description: "independent", parameters: Type.Object({}),
    execute: async () => { log.push("independent"); release(); return { content: [], details: {} }; },
  };
  const timer = setTimeout(release, 5_000);
  try {
    await runBatch([memory as AgentTool, independent], [
      { id: "write", name: "memory", arguments: { action: "remember" } },
      { id: "read", name: "memory", arguments: { action: "search" } },
      { id: "other", name: "independent", arguments: {} },
    ]);
    assert.ok(log.indexOf("independent") < log.indexOf("end:remember"));
    assert.ok(log.indexOf("start:search") > log.indexOf("end:remember"));
  } finally {
    clearTimeout(timer);
    release();
  }
});
