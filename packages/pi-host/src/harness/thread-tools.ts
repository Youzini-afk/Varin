import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";
import type {
  ResearchCapability,
  ResearchResourceManifest,
  ResolvedResearchCapability,
  ResolvedPreset,
  ThreadDispatchResult,
  ThreadListResult,
  ThreadWaitResult,
  ThreadSendResult,
  ThreadReadResult,
  ThreadMergeResult,
  ThreadUpdateResult,
  ThreadKillResult,
} from "@varin/protocol";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS, RESEARCH_CAPABILITY_DEFINITIONS, buildTeamPrompt, isPresetId } from "@varin/protocol";

/**
 * Build an error result for a thread tool failure.
 * Returns isError:true with the harness error code and message.
 */
function threadErrorResult(toolName: string, error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true; details: Record<string, unknown> } {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error instanceof HarnessRequestError || (error as { code?: string }).code !== undefined)
    ? (error as { code: string }).code
    : "failed";
  return {
    content: [{ type: "text", text: `${toolName} failed (${code}): ${message}` }],
    isError: true,
    details: { code },
  };
}

const DispatchParams = Type.Object({
  task: Type.String(),
  kind: Type.Optional(Type.Union([
    Type.Literal("implementation"),
    Type.Literal("discussion"),
  ], { description: "implementation (default) produces work; discussion starts a read-only consult thread that answers against memory and material, then reports back" })),
  bot: Type.Optional(Type.String({ description: "With kind:discussion — consult a specific Bot: the thread runs with that Bot's persona, model default, and memory scope, and reports back through the normal response path" })),
  preset: Type.Optional(Type.String()),
  input: Type.Optional(Type.Union([
    Type.Literal("task"),
    Type.Literal("inherit"),
  ], { description: "task starts on the brief (default); inherit carries the parent's committed input captured at dispatch" })),
  worktree: Type.Optional(Type.Literal("shared")),
  scope: Type.Optional(Type.Array(Type.String())),
  capability: Type.Optional(Type.Union([
    Type.Literal('investigation'),
    Type.Literal('experimental-design'),
    Type.Literal('fast-exploration'),
    Type.Literal('high-throughput-execution'),
  ], { description: 'Research capability; runs on its dedicated model slot, or on the caller\'s current model when model:"inherit" is passed explicitly.' })),
  model: Type.Optional(Type.Literal("inherit", { description: 'For a capability dispatch, explicitly inherit the caller\'s current model instead of the capability\'s configured slot' })),
  resources: Type.Optional(Type.Object({
    cpu: Type.Optional(Type.Boolean()),
    gpu: Type.Optional(Type.Boolean()),
    network: Type.Optional(Type.Boolean()),
    longRunning: Type.Optional(Type.Boolean()),
  })),
  environment: Type.Optional(Type.Object({
    workTarget: Type.Optional(Type.String({ description: "Managed execution target for the child's shell/process ops; omitted fields inherit this work's environment binding" })),
    desktopId: Type.Optional(Type.String({ description: "Computer desktop the child's GUI ops target by default" })),
  }, { description: "Initial execution-environment binding; absent inherits this work's binding" })),
});

const ThreadListParams = Type.Object({
  ids: Type.Optional(Type.Array(Type.String())),
  full: Type.Optional(Type.Boolean()),
});

const ThreadWaitParams = Type.Object({
  ids: Type.Optional(Type.Array(Type.String())),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })),
});

const ThreadSendParams = Type.Object({
  threadId: Type.Optional(Type.String({ description: "Target thread — a child, sibling, or the parent thread. Omit when to=parent" })),
  to: Type.Optional(Type.Literal("parent", { description: "Send to the caller thread's own parent instead of a threadId" })),
  message: Type.String(),
  kind: Type.Optional(Type.Union([
    Type.Literal("inform"),
    Type.Literal("request"),
  ], { description: "inform only delivers the message without waking a waiting thread; request asks for execution — on a settled thread it starts a new Run" })),
  context: Type.Optional(Type.Union([
    Type.Literal("continue"),
    Type.Literal("fresh"),
  ], { description: "For a request on a settled thread: continue resumes its retained session (default); fresh rebuilds the input on a new session" })),
  requestId: Type.Optional(Type.String({ description: "Idempotency key — a retry with the same id returns the recorded outcome instead of duplicating delivery" })),
  replyTo: Type.Optional(Type.String({ description: "The requestId of a request you are answering — completes the requester's wait" })),
  capability: Type.Optional(Type.Union([
    Type.Literal('investigation'),
    Type.Literal('experimental-design'),
    Type.Literal('fast-exploration'),
    Type.Literal('high-throughput-execution'),
  ], { description: "With kind=request on a settled thread: the new Run re-routes under this capability's frozen tools/model — earlier Runs stay immutable" })),
  model: Type.Optional(Type.Literal("inherit", { description: "With capability: keep the target thread's recorded model when the capability's slot is not configured" })),
  resources: Type.Optional(Type.Object({
    cpu: Type.Optional(Type.Boolean()),
    gpu: Type.Optional(Type.Boolean()),
    network: Type.Optional(Type.Boolean()),
    longRunning: Type.Optional(Type.Boolean()),
  }, { description: "Resource manifest merged over the capability defaults" })),
  wait: Type.Optional(Type.Number({ description: "Seconds to wait for this request's correlated reply after acceptance (default 0). A timeout ends only this wait — the message and the target's work continue; retry with the same requestId to keep waiting without re-sending" })),
});

const ThreadReadParams = Type.Object({
  threadId: Type.String(),
  runId: Type.Optional(Type.String({ description: "Read a fixed Run's delivery and transcript, even while a later attempt is running or failed." })),
  resultRevision: Type.Optional(Type.Integer({ minimum: 1, description: "Read the report bound to this published result revision." })),
  what: Type.Optional(Type.Union([
    Type.Literal("blocks"),
    Type.Literal("report"),
    Type.Literal("steps"),
    Type.Literal("transcript"),
  ])),
  since: Type.Optional(Type.Integer({ minimum: 0 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "UTF-8 byte offset for report paging, or match offset for transcript search" })),
  length: Type.Optional(Type.Integer({ minimum: 1, description: "UTF-8 byte length for report paging" })),
  entry: Type.Optional(Type.String({ description: "transcript: locate one immutable session entry id — e.g. the reference a status excerpt carries — with before/after neighbours" })),
  before: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  after: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  query: Type.Optional(Type.String({ description: "transcript: search the branch for entries containing this text" })),
  path: Type.Optional(Type.String({ description: "transcript: narrow the search to entries mentioning this path" })),
});

const ThreadMergeParams = Type.Object({
  threadId: Type.String(),
  resultRevision: Type.Optional(Type.Integer({ minimum: 1, description: "Published result revision to integrate; defaults to the thread's latest result." })),
  expectedBindingFingerprint: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
  resolutions: Type.Optional(Type.Array(Type.Object({
    path: Type.String(),
    choice: Type.Union([Type.Literal("parent"), Type.Literal("child"), Type.Literal("base"), Type.Literal("text")]),
    text: Type.Optional(Type.String()),
    expectedParentRevision: Type.String(),
    expectedLocalEditRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  }))),
});

const ThreadUpdateParams = Type.Object({
  threadId: Type.String(),
  resultRevision: Type.Optional(Type.Integer({ minimum: 1, description: "Published parent result revision to incorporate into this thread's baseline; defaults to the parent's latest published result." })),
});

const ThreadKillParams = Type.Object({
  threadId: Type.String(),
  keep_worktree: Type.Optional(Type.Boolean()),
});

/**
 * `dispatch` is task-centered (D-285): `task` is the core input and `preset`
 * is optional. A normal dispatch resolves the model from the session's
 * current model and the tool list from the session's active tools — the
 * child inherits the caller's ordinary authorized capabilities. A preset
 * freezes its declared tool list and a model resolved from the user slot or
 * an explicit inherit; presets whose slot is unconfigured are omitted from
 * the team prompt and rejected rather than silently borrowing the main
 * model. The team prompt is generated from that preset set at session
 * creation, so it is static for the session and does not invalidate the
 * prefix cache.
 */
export function createDispatchTool(
  bridge: HostServicesBridge,
  _sessionId: string,
  presets: readonly ResolvedPreset[] = [],
  options: {
    concurrency?: number;
    /** Active tool names of the dispatching session (normal-dispatch default). */
    getActiveToolNames?: () => string[];
    resolvedResearchCapabilities?: readonly ResolvedResearchCapability[];
    getResearchCapabilities?: () => Promise<readonly ResolvedResearchCapability[]>;
  } = {},
): ToolDefinition {
  const available = presets.map((p) => p.id);
  const teamPrompt = buildTeamPrompt([...presets]);
  const researchCapabilities = options.resolvedResearchCapabilities ?? [];
  return defineTool({
    name: "dispatch",
    label: "Dispatch",
    description: "Dispatch a sub-agent thread for a task. kind:\"discussion\" starts a read-only consult thread that answers against memory and reports back. Optional preset picks a fixed execution configuration. Asynchronous — returns immediately, never blocks.",
    promptSnippet: "dispatch: spawn a sub-agent thread for a task",
    promptGuidelines: [
      teamPrompt,
    ],
    parameters: DispatchParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        let model: { providerId: string; modelId: string } | undefined;
        let tools: string[] | undefined;
        let research: { capability: ResearchCapability; resources: ResearchResourceManifest } | undefined;
        if (params.kind === "discussion" && (params.preset !== undefined || params.capability !== undefined)) {
          return {
            content: [{ type: 'text' as const, text: 'dispatch failed: discussion consult cannot be combined with a preset or capability' }],
            isError: true,
            details: { code: 'invalid-params' },
          };
        }
        if (params.bot !== undefined && params.kind !== "discussion") {
          return {
            content: [{ type: 'text' as const, text: 'dispatch failed: bot consultation requires kind:"discussion"' }],
            isError: true,
            details: { code: 'invalid-params' },
          };
        }
        if (params.capability !== undefined) {
          let currentCapabilities = researchCapabilities;
          try {
            if (options.getResearchCapabilities) currentCapabilities = await options.getResearchCapabilities();
          } catch (error) { return threadErrorResult("dispatch", error); }
          const resolved = currentCapabilities.find((entry) => entry.capability === params.capability);
          const definition = RESEARCH_CAPABILITY_DEFINITIONS[params.capability];
          if (params.preset !== undefined) {
            return {
              content: [{ type: 'text' as const, text: 'dispatch failed: capability cannot be combined with preset' }],
              isError: true,
              details: { code: 'invalid-params' },
            };
          }
          if (params.model === "inherit") {
            const current = ctx?.model;
            if (!current) {
              return {
                content: [{ type: 'text' as const, text: "dispatch failed: model \"inherit\" needs a current model on the calling session" }],
                isError: true,
                details: { code: 'unavailable' },
              };
            }
            model = { providerId: current.provider, modelId: current.id };
          } else if (resolved) {
            model = resolved.model;
          } else {
            return {
              content: [{ type: 'text' as const, text: `research capability unavailable: ${params.capability}. Configure its dedicated model slot first, or pass model:"inherit" to use your current model.` }],
              isError: true,
              details: { code: 'unavailable', capability: params.capability },
            };
          }
          tools = definition.tools;
          research = {
            capability: definition.capability,
            resources: { ...definition.defaultResources, ...(params.resources ?? {}) },
          };
        } else if (params.model !== undefined) {
          return {
            content: [{ type: 'text' as const, text: 'dispatch failed: model applies only together with a capability' }],
            isError: true,
            details: { code: 'invalid-params' },
          };
        }
        if (params.preset !== undefined) {
        const preset = presets.find((p) => p.id === params.preset);
        if (!preset && !isPresetId(params.preset) && !params.preset.startsWith("custom:")) {
          return {
            content: [{
              type: "text" as const,
              text: `unknown preset: ${params.preset}. Available presets: ${available.join(", ") || "(none configured)"}`,
            }],
            isError: true,
            details: { code: "invalid-params", availablePresets: available },
          };
        }
        // The catalog in the prompt is a snapshot. The Host resolves the current
        // definition, so an agent created through settings can be used in this turn.
        const current = ctx?.model;
        model = current ? { providerId: current.provider, modelId: current.id } : preset?.model;
      } else if (params.capability === undefined && params.bot !== undefined) {
        // The Host prefers the consulted Bot's model. If that Bot has no model
        // preference, the caller's current model is the explicit fallback.
        const current = ctx?.model;
        if (!current) {
          return {
            content: [{ type: 'text' as const, text: 'dispatch failed: no current model is selected for this session' }],
            isError: true,
            details: { code: 'unavailable' },
          };
        }
        model = { providerId: current.provider, modelId: current.id };
        tools = options.getActiveToolNames?.();
      } else if (params.capability === undefined) {
        const current = ctx?.model;
        if (!current) {
          return {
            content: [{ type: "text" as const, text: "dispatch failed: no current model is selected for this session" }],
            isError: true,
            details: { code: "unavailable" },
          };
        }
        model = { providerId: current.provider, modelId: current.id };
        tools = options.getActiveToolNames?.();
      } else if (params.resources !== undefined && research === undefined) {
        return {
          content: [{ type: 'text' as const, text: 'dispatch failed: resources require a research capability' }],
          isError: true,
          details: { code: 'invalid-params' },
        };
      }
      try {
        const result = await bridge.request<"thread.dispatch">("thread.dispatch", {
          ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
          task: params.task,
          ...(params.kind !== undefined ? { kind: params.kind } : {}),
          ...(params.bot !== undefined ? { bot: params.bot } : {}),
          ...(params.preset !== undefined ? { preset: params.preset } : {}),
          ...(params.input !== undefined ? { input: params.input } : {}),
          ...(params.worktree !== undefined ? { worktree: params.worktree } : {}),
          ...(model === undefined ? {} : { model }),
          ...(tools !== undefined ? { tools } : {}),
          ...(params.scope !== undefined ? { scope: params.scope } : {}),
          ...(params.environment !== undefined ? { environment: params.environment } : {}),
          ...(research === undefined ? {} : { research }),
        });
        const typed = result as ThreadDispatchResult;
        return { content: [{ type: "text", text: typed.text }], details: { threadId: typed.threadId, queued: typed.queued } };
      } catch (error) {
        return threadErrorResult("dispatch", error);
      }
    },
  });
}

export function createThreadsTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "threads",
    label: "Threads",
    description: "List sub-agent threads without blocking. Defaults to changes since the previous view; wait blocks for a result or addressed dependency.",
    promptSnippet: "threads: quick non-blocking glance at sub-agent threads",
    parameters: ThreadListParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.list">("thread.list", {
          ...(params.ids !== undefined ? { ids: params.ids } : {}),
          ...(params.full !== undefined ? { full: params.full } : {}),
        });
        const typed = result as ThreadListResult;
        return { content: [{ type: "text", text: typed.text }], details: { count: typed.threads.length,
          ...(typed.observationRef ? { observationRef: typed.observationRef } : {}) } };
      } catch (error) {
        return threadErrorResult("threads", error);
      }
    },
  });
}

export function createWaitTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "wait",
    label: "Wait",
    description: "Wait for a thread result, an addressed request/reply, actionable attention, or timeout. Routine progress and inform messages do not wake the model. A yielded Run resumes only after reacquiring the shared execution slot.",
    promptSnippet: "wait: await a result or addressed dependency (timeout is normal)",
    promptGuidelines: [
      "wait ignores routine progress and ordinary inform messages. Timeout ends dependency watching, but resuming model work still waits for shared execution admission.",
    ],
    parameters: ThreadWaitParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const waitTimeout = Math.min(
          params.timeout_ms ?? (HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000),
          HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000,
        );
        // The Host applies waitTimeout to dependency watching, then reacquires
        // execution admission. Cancellation/disposal, not a second fixed timer,
        // bounds that latter wait.
        const result = await bridge.request<"thread.wait">("thread.wait", {
          ...(params.ids !== undefined ? { ids: params.ids } : {}),
          timeoutMs: waitTimeout,
        }, { timeoutMs: 0, ...(signal ? { signal } : {}) });
        const typed = result as ThreadWaitResult;
        return {
          content: [{ type: "text", text: typed.text }],
          details: {
            done: typed.done,
            ...(typed.observationRef ? { observationRef: typed.observationRef } : {}),
            running: typed.running,
            waiting: typed.waiting,
            queued: typed.queued,
            timedOut: typed.timedOut,
          },
        };
      } catch (error) {
        // An indeterminate wait failure cannot authorize another model request
        // while this Run may still have yielded its execution slot.
        if (!(error instanceof HarnessRequestError) || ["failed", "timeout", "unavailable"].includes(error.code)) _ctx?.abort();
        return threadErrorResult("wait", error);
      }
    },
  });
}

export function createSendTool(bridge: HostServicesBridge, _sessionId: string, options: {
  resolvedResearchCapabilities?: readonly ResolvedResearchCapability[];
  getResearchCapabilities?: () => Promise<readonly ResolvedResearchCapability[]>;
} = {}): ToolDefinition {
  const researchCapabilities = options.resolvedResearchCapabilities ?? [];
  return defineTool({
    name: "send",
    label: "Send",
    description: "Send a message to a related thread (child, sibling, or parent). kind: 'inform' delivers without waking a waiting thread; 'request' asks for execution — on a settled thread it starts a new Run (context: 'continue' resumes its session; 'fresh' rebuilds the input). replyTo answers a request and completes the requester's wait. capability re-routes the new Run under that capability's frozen configuration.",
    promptSnippet: "send: inform a teammate; kind=request resumes a settled thread",
    parameters: ThreadSendParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        let research: { capability: ResearchCapability; resources: ResearchResourceManifest } | undefined;
        let model: { providerId: string; modelId: string } | "inherit" | undefined;
        if (params.capability !== undefined) {
          const currentCapabilities = options.getResearchCapabilities ? await options.getResearchCapabilities() : researchCapabilities;
          const resolved = currentCapabilities.find((entry) => entry.capability === params.capability);
          const definition = RESEARCH_CAPABILITY_DEFINITIONS[params.capability];
          if (resolved === undefined && params.model !== "inherit") {
            return {
              content: [{ type: 'text' as const, text: `research capability unavailable: ${params.capability}. Configure its dedicated model slot first, or pass model:"inherit" to keep the thread's model.` }],
              isError: true,
              details: { code: 'unavailable', capability: params.capability },
            };
          }
          model = params.model === "inherit" ? "inherit" : resolved!.model;
          research = {
            capability: definition.capability,
            resources: { ...definition.defaultResources, ...(params.resources ?? {}) },
          };
        } else if (params.model !== undefined || params.resources !== undefined) {
          return {
            content: [{ type: 'text' as const, text: 'send failed: model/resources apply only together with a capability' }],
            isError: true,
            details: { code: 'invalid-params' },
          };
        }
        const result = await bridge.request<"thread.send">("thread.send", {
          ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
          ...(params.to !== undefined ? { to: params.to } : {}),
          message: params.message,
          from: "parent-agent",
          ...(params.kind !== undefined ? { kind: params.kind } : {}),
          ...(params.context !== undefined ? { context: params.context } : {}),
          ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
          ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
          ...(params.capability !== undefined ? { capability: params.capability } : {}),
          ...(research !== undefined ? { resources: research.resources } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(params.wait !== undefined ? { wait: params.wait } : {}),
        }, params.wait !== undefined && params.wait > 0
          ? { timeoutMs: 0, ...(signal ? { signal } : {}) }
          : undefined);
        const typed = result as ThreadSendResult;
        const state = `${typed.lifecycle}/${typed.attention}`;
        const receipt = typed.accepted
          ? `message ${typed.messageId ?? ""} to ${params.to === "parent" ? "parent" : params.threadId}: ${typed.delivery ?? "accepted"} (${state})${typed.runId ? `; Run ${typed.runId}` : ""}`
          : "not accepted";
        const outcome = typed.reply
          ? `reply ${typed.reply.messageId} from ${typed.reply.from.kind} ${typed.reply.from.id} at ${typed.reply.at}:\n${typed.reply.text}`
          : typed.timedOut
            ? `timed out waiting for a reply — the message ${typed.messageId ?? ""} stays recorded; retry with the same requestId to keep waiting without re-sending`
            : "Delivery is not execution completion.";
        return { content: [{ type: "text", text: `${receipt}. ${outcome}` }], details: typed };
      } catch (error) {
        return threadErrorResult("send", error);
      }
    },
  });
}

export function createReadThreadTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "read_thread",
    label: "Read Thread",
    description: "Read a teammate's notes, delivery report, transcript slice, or transcript entries. Use runId or resultRevision for an immutable earlier delivery; what:'transcript' with an entry id expands the exact passage a status excerpt cites; viewing never executes work.",
    promptSnippet: "read_thread: read a teammate's notes (blocks), report, steps, or transcript entries",
    parameters: ThreadReadParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.read">("thread.read", {
          threadId: params.threadId,
          ...(params.runId === undefined ? {} : { runId: params.runId }),
          ...(params.resultRevision === undefined ? {} : { resultRevision: params.resultRevision }),
          ...(params.what !== undefined ? { what: params.what } : {}),
          ...(params.since !== undefined ? { since: params.since } : {}),
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.length !== undefined ? { length: params.length } : {}),
          ...(params.entry !== undefined ? { entry: params.entry } : {}),
          ...(params.before !== undefined ? { before: params.before } : {}),
          ...(params.after !== undefined ? { after: params.after } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(params.query !== undefined ? { query: params.query } : {}),
          ...(params.path !== undefined ? { path: params.path } : {}),
        }, signal ? { signal } : undefined);
        const typed = result as ThreadReadResult;
        return {
          content: [{ type: "text", text: typed.text }],
          details: {
            hasReport: typed.report !== null,
            transcriptRef: typed.transcriptRef,
            ...(typed.nextOffset === undefined ? {} : { nextOffset: typed.nextOffset }),
            ...(typed.eof === undefined ? {} : { eof: typed.eof }),
          },
        };
      } catch (error) {
        return threadErrorResult("read_thread", error);
      }
    },
  });
}

export function createMergeTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "merge",
    label: "Merge",
    description: "Integrate a completed sub-agent's published result into parent files or editor drafts. Draft changes remain unsaved. Reports applied paths, conflicts, and any recovery required.",
    promptSnippet: "merge: integrate a completed teammate's published result",
    parameters: ThreadMergeParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.merge">("thread.merge", {
          threadId: params.threadId,
          ...(params.resultRevision !== undefined ? { resultRevision: params.resultRevision } : {}),
          ...(params.expectedBindingFingerprint !== undefined ? { expectedBindingFingerprint: params.expectedBindingFingerprint } : {}),
          ...(params.resolutions !== undefined ? { resolutions: params.resolutions } : {}),
        }, signal ? { signal } : undefined);
        const typed = result as ThreadMergeResult;
        const preview = typed.preview;
        const resolutionPaths = preview?.paths.filter((path) => path.decision === "conflict") ?? [];
        const resolutionBinding = preview && resolutionPaths.length > 0 ? {
          resultRevision: preview.resultRevision,
          expectedBindingFingerprint: preview.bindingFingerprint,
          paths: resolutionPaths.map((path) => ({
            path: path.path,
            target: path.target,
            expectedParentRevision: preview.binding[path.path]?.revision,
            ...(preview.binding[path.path]?.localEditRevision === undefined ? {} : {
              expectedLocalEditRevision: preview.binding[path.path]!.localEditRevision,
            }),
          })),
        } : null;
        return {
          content: [{ type: "text", text: resolutionBinding
            ? `${typed.text}\nConflict resolution binding (use these versions when submitting resolutions):\n${JSON.stringify(resolutionBinding)}`
            : typed.text }],
          details: {
            merged: typed.merged,
            conflicts: typed.conflicts,
            status: typed.status,
            appliedPaths: typed.appliedPaths,
            surfaceTargetPaths: typed.surfaceTargetPaths,
            operationId: typed.operationId,
            resultRevision: typed.resultRevision,
            ...(resolutionBinding ? { resolutionBinding } : {}),
          },
        };
      } catch (error) {
        return threadErrorResult("merge", error);
      }
    },
  });
}

export function createUpdateTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "update",
    label: "Update",
    description: "Incorporate a published parent result revision into a started teammate's working baseline. The teammate's own changes are preserved through a three-way merge; paths where both sides diverged keep the teammate's bytes and are reported as conflicts.",
    promptSnippet: "update: pull a published parent revision into a teammate's baseline",
    parameters: ThreadUpdateParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.update">("thread.update", {
          threadId: params.threadId,
          ...(params.resultRevision !== undefined ? { resultRevision: params.resultRevision } : {}),
        }, signal ? { signal } : undefined);
        const typed = result as ThreadUpdateResult;
        return {
          content: [{ type: "text", text: typed.text }],
          details: {
            status: typed.status,
            resultRevision: typed.resultRevision,
            baseRef: typed.baseRef,
            updatedFromParent: typed.updatedFromParent,
            keptPaths: typed.keptPaths,
            mergedPaths: typed.mergedPaths,
            conflicts: typed.conflicts,
          },
        };
      } catch (error) {
        return threadErrorResult("update", error);
      }
    },
  });
}

export function createKillTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "kill",
    label: "Kill",
    description: "Stop a sub-agent and retain its published work. Idle materializations can be reclaimed after the result is saved; keep_worktree explicitly preserves the directory.",
    promptSnippet: "kill: stop a teammate; published work is retained",
    parameters: ThreadKillParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"thread.kill">("thread.kill", {
          threadId: params.threadId,
          ...(params.keep_worktree !== undefined ? { keepWorktree: params.keep_worktree } : {}),
        });
        const typed = result as ThreadKillResult;
        return { content: [{ type: "text", text: typed.text }], details: {} };
      } catch (error) {
        return threadErrorResult("kill", error);
      }
    },
  });
}
