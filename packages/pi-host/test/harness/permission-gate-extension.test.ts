import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { defaultRules, evaluateGate, type PermissionAuditRecord, type PermissionInspectParams } from "@varin/protocol";
import { buildPermissionPolicy, createPermissionGateExtension } from "../../src/harness/permission-gate-extension.js";

const workspaceRoot = resolve("permission-gate-workspace");

const inspect = (params: PermissionInspectParams) => ({
  tool: params.tool,
  source: params.source,
  action: params.action,
  executionWorkspaceId: "execution-ws",
  owningWorkspaceId: "owning-ws",
  cwd: "workspace:/",
  paths: params.paths.map((path) => {
    const resourceId = relative(workspaceRoot, path).replaceAll("\\", "/");
    return {
      inputPath: path,
      workspaceId: "execution-ws",
      resourceId,
      canonicalResourceId: `workspace:/${resourceId}`,
    };
  }),
  networkTargets: params.networkTargets,
  threadScopes: params.threadScopes,
  evidenceComplete: params.evidenceComplete,
});

const makeBridge = (options: { failInspect?: boolean; workTarget?: string; failEnvironment?: boolean } = {}) => {
  const audits: PermissionAuditRecord[] = [];
  return {
    audits,
    bridge: {
      request: async (method: string, params: unknown) => {
        if (method === "environment.get") {
          if (options.failEnvironment) throw new Error("binding is unreadable");
          return { threadId: "thread-1", environment: options.workTarget ? { workTarget: options.workTarget, updatedAt: "now" } : null };
        }
        if (method === "permission.inspect") {
          if (options.failInspect) throw new Error("outside workspace");
          return inspect(params as PermissionInspectParams);
        }
        if (method === "permission.audit") {
          audits.push(params as PermissionAuditRecord);
          return { accepted: true };
        }
        throw new Error(`unexpected method ${method}`);
      },
    } as never,
  };
};

const harness = (
  options: Parameters<typeof createPermissionGateExtension>[0],
  tools: Array<{ name: string; sourceInfo: { path: string; source: string; scope: string; origin: string } }>,
) => {
  let toolCall: ((event: { toolName: string; input: unknown }, ctx: unknown) => Promise<unknown>) | undefined;
  createPermissionGateExtension(options)({
    getAllTools: () => tools,
    registerCommand: () => {},
    on: (event: string, handler: typeof toolCall) => {
      if (event === "tool_call") toolCall = handler;
    },
  } as never);
  if (!toolCall) throw new Error("tool_call handler was not registered");
  return toolCall;
};

const ui = (choices: Array<string | undefined> = ["Allow once"]) => {
  const state = { selectCalls: 0, titles: [] as string[] };
  return {
    state,
    context: {
      cwd: workspaceRoot,
      signal: undefined,
      ui: {
        select: async (title: string) => {
          state.selectCalls += 1;
          state.titles.push(title);
          return choices.shift();
        },
      },
    },
  };
};

const builtin = (name: string) => ({
  name,
  sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
});
const packageTool = (name: string, path = "C:/pkg/index.js") => ({
  name,
  sourceInfo: { path, source: "npm:example", scope: "user", origin: "package" },
});
const mcpTool = (name: string) => ({
  name,
  sourceInfo: { path: "C:/pkg/pi-mcp-adapter/index.js", source: "npm:@varin/pi-mcp-adapter", scope: "user", origin: "package" },
});

const normal = () => ({ mode: "normal" as const, rules: defaultRules("normal") });

describe("native permission gate integration", () => {
  it("keeps preset approval choices and user rules ahead of mode defaults", () => {
    const policy = buildPermissionPolicy("normal", { worker: true, retrieval: false }, [
      { tool: "read", decision: "deny" },
    ]);
    assert.equal(evaluateGate("dispatch", { preset: "worker", task: "inspect" }, policy).decision, "ask");
    assert.equal(evaluateGate("dispatch", { preset: "retrieval", task: "find" }, policy).decision, "allow");
    assert.equal(evaluateGate("read", { path: "private.txt" }, policy).decision, "deny");
  });
  it("retains retrieval path authorization without reserving the source for scheduling", async () => {
    const { bridge, audits } = makeBridge();
    const sourceInfo = { path: "<sdk>", source: "sdk", scope: "temporary", origin: "top-level" };
    const call = harness({ policy: normal(), sessionId: "s", cwd: workspaceRoot, bridge }, [{ name: "explore", sourceInfo }]);
    const result = await call({ toolName: "explore", input: { question: "source", paths: ["src/source.ts"] } }, ui().context) as {
      block?: boolean; executionPlan?: { barrier?: boolean; resources?: unknown[] };
    };
    assert.notEqual(result.block, true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.target.source.kind, "harness");
    assert.equal(audits[0]?.target.paths[0]?.resourceId, "src/source.ts");
    assert.notEqual(result.executionPlan?.barrier, true);
    assert.deepEqual(result.executionPlan?.resources, []);
  });

  it("allows diagnostics and memory reads while keeping memory mutation grants scoped", async () => {
    const { bridge, audits } = makeBridge();
    const sourceInfo = { path: "<sdk>", source: "sdk", scope: "temporary", origin: "top-level" };
    const call = harness({ policy: normal(), sessionId: "s", cwd: workspaceRoot, bridge }, [
      { name: "network_diag", sourceInfo }, { name: "memory", sourceInfo },
    ]);
    const result = ui(["Allow for this session scope", "Deny"]);
    for (const [toolName, input] of [
      ["network_diag", { url: "https://example.com" }],
      ["memory", { action: "search", query: "shell" }],
    ] as const) {
      const decision = await call({ toolName, input }, result.context) as { block?: boolean; executionPlan?: { barrier?: boolean } };
      assert.notEqual(decision.block, true);
      assert.equal(decision.executionPlan?.barrier, false);
      assert.equal(audits.at(-1)?.target.source.kind, "harness");
      assert.equal(audits.at(-1)?.target.action, "read");
    }
    assert.equal(result.state.selectCalls, 0);
    const write = { action: "remember", content: "note", scope: "session" };
    await call({ toolName: "memory", input: write }, result.context);
    await call({ toolName: "memory", input: write }, result.context);
    const denied = await call({ toolName: "memory", input: { ...write, scope: "user" } }, result.context);
    assert.equal(result.state.selectCalls, 2);
    assert.equal((denied as { block: boolean }).block, true);
    assert.equal(audits.at(-1)?.target.action, "control");
  });

  it("pins an inherited shell target before permission inspection", async () => {
    const { bridge, audits } = makeBridge({ workTarget: "managed:cloud" });
    const call = harness({ policy: normal(), sessionId: "s", cwd: workspaceRoot, bridge }, [builtin("bash")]);
    const input = { command: "cat /remote/file", cwd: "/remote", target: undefined as string | undefined };
    await call({ toolName: "bash", input }, ui().context as never);
    assert.equal(input.target, "managed:cloud");
    assert.deepEqual(audits[0]?.target.threadScopes, ["execution-target:managed:cloud"]);
    assert.deepEqual(audits[0]?.target.paths, []);
  });

  it("blocks an unreadable environment rather than approving local execution", async () => {
    const { bridge, audits } = makeBridge({ failEnvironment: true });
    const call = harness({ policy: { mode: "bypass", rules: defaultRules("bypass") }, sessionId: "s", cwd: workspaceRoot, bridge }, [builtin("bash")]);
    const result = await call({ toolName: "bash", input: { command: "echo ok" } }, ui().context as never);
    assert.equal((result as { block: boolean }).block, true);
    assert.equal(audits.length, 0);
  });
  it("recognizes native research queries and keeps experiment control grants bound to the target", async () => {
    const { bridge, audits } = makeBridge();
    const sourceInfo = { path: "<sdk>", source: "sdk", scope: "temporary", origin: "top-level" };
    const call = harness({ policy: normal(), sessionId: "s", cwd: workspaceRoot, bridge }, [
      { name: "experiment", sourceInfo }, { name: "resources", sourceInfo },
    ]);
    const result = ui(["Allow for this session scope", "Deny"]);
    await call({ toolName: "resources", input: {} }, result.context as never);
    await call({ toolName: "experiment", input: { action: "logs", attemptId: "a" } }, result.context as never);
    assert.equal(result.state.selectCalls, 0);
    assert.equal(audits.at(-1)?.target.source.kind, "harness");
    await call({ toolName: "experiment", input: { action: "cancel", attemptId: "a" } }, result.context as never);
    await call({ toolName: "experiment", input: { action: "cancel", attemptId: "a" } }, result.context as never);
    const denied = await call({ toolName: "experiment", input: { action: "cancel", attemptId: "b" } }, result.context as never);
    assert.equal(result.state.selectCalls, 2);
    assert.equal((denied as { block: boolean }).block, true);
  });

  it("is the gate for Pi built-ins and allows maintained read-only actions without prompting", async () => {
    const { bridge, audits } = makeBridge();
    const call = harness({ policy: normal(), sessionId: "s", cwd: workspaceRoot, bridge }, [builtin("read")]);
    const result = ui();
    assert.deepEqual(await call({ toolName: "read", input: { path: "src/a.ts" } }, result.context as never), {
      executionPlan: {
        barrier: false,
        resources: [{
          id: "host-path:execution-ws:workspace:/src/a.ts",
          access: "read",
          scope: "exact",
        }],
      },
    });
    assert.equal(result.state.selectCalls, 0);
    assert.equal(audits.at(-1)?.decision, "allow");
    assert.equal(audits.at(-1)?.target.source.kind, "builtin");
  });

  it("asks for MCP and unknown package tools even when their names look read-only", async () => {
    const { bridge } = makeBridge();
    const result = ui(["Deny", "Deny"]);
    const mcp = harness({ policy: normal(), sessionId: "s", cwd: workspaceRoot, bridge }, [mcpTool("read")]);
    const pkg = harness({ policy: normal(), sessionId: "s", cwd: workspaceRoot, bridge }, [packageTool("inspect")]);
    assert.deepEqual(await mcp({ toolName: "read", input: { path: "src/a.ts" } }, result.context as never), {
      block: true,
      reason: "User denied read",
    });
    assert.deepEqual(await pkg({ toolName: "inspect", input: {} }, result.context as never), {
      block: true,
      reason: "User denied inspect",
    });
    assert.equal(result.state.selectCalls, 2);
  });

  it("remembers only the same normalized source/action/workspace/resource scope", async () => {
    const { bridge, audits } = makeBridge();
    const result = ui(["Allow for this session scope", "Allow once"]);
    const call = harness({ policy: normal(), sessionId: "s", cwd: workspaceRoot, bridge }, [builtin("edit")]);
    await call({ toolName: "edit", input: { path: "src/a.ts" } }, result.context as never);
    await call({ toolName: "edit", input: { path: "src/a.ts" } }, result.context as never);
    await call({ toolName: "edit", input: { path: "src/b.ts" } }, result.context as never);
    assert.equal(result.state.selectCalls, 2, "same scope reuses grant; different canonical path asks again");
    assert.equal(audits[0]?.remembered, true);
    assert.equal(audits[1]?.remembered, true);
    assert.equal(audits[1]?.prompted, false);
  });

  it("does not remember high-risk or incomplete inspections", async () => {
    const { bridge } = makeBridge({ failInspect: true });
    const result = ui(["Allow once", "Allow once"]);
    const call = harness({ policy: normal(), sessionId: "s", cwd: workspaceRoot, bridge }, [builtin("bash")]);
    await call({ toolName: "bash", input: { command: "echo ok" } }, result.context as never);
    await call({ toolName: "bash", input: { command: "echo ok" } }, result.context as never);
    assert.equal(result.state.selectCalls, 2);
  });

  it("Smart can resolve an ordinary complete ask but never unknown/high-impact evidence", async () => {
    const { bridge } = makeBridge();
    let judged = 0;
    const result = ui(["Deny"]);
    const edit = harness({
      policy: { mode: "smart", rules: defaultRules("smart") },
      sessionId: "s",
      cwd: workspaceRoot,
      bridge,
      smartJudge: async () => { judged += 1; return "allow"; },
    }, [builtin("edit")]);
    const editResult = await edit({ toolName: "edit", input: { path: "src/a.ts" } }, result.context as never);
    assert.equal((editResult as { executionPlan?: { resources?: unknown[] } }).executionPlan?.resources?.length, 1);
    assert.equal(judged, 1);

    const unknown = harness({
      policy: { mode: "smart", rules: defaultRules("smart") },
      sessionId: "s2",
      cwd: workspaceRoot,
      bridge,
      smartJudge: async () => { judged += 1; return "allow"; },
    }, [packageTool("do_anything")]);
    await unknown({ toolName: "do_anything", input: {} }, result.context as never);
    assert.equal(judged, 1);
    assert.equal(result.state.selectCalls, 1);
  });

  it("dialog cancellation blocks rather than passing the call", async () => {
    const { bridge } = makeBridge();
    const result = ui([undefined]);
    const call = harness({ policy: normal(), sessionId: "s", cwd: workspaceRoot, bridge }, [builtin("bash")]);
    assert.deepEqual(await call({ toolName: "bash", input: { command: "echo ok" } }, result.context as never), {
      block: true,
      reason: "Permission dialog dismissed for bash",
    });
  });
});
