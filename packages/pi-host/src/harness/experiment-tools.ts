import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HostServicesBridge } from "./host-services-bridge.js";
import { HarnessRequestError } from "./host-services-bridge.js";
import type {
  ExperimentCollectResult,
  ExperimentGetResult,
  ExperimentListResult,
  ExperimentLogsResult,
  ExperimentSubmitResult,
  ExperimentSubmitParams,
  ExperimentWaitResult,
  ResourceListResult,
  SourceListResult,
  SourceRegisterResult,
} from "@varin/protocol";
import { HARNESS_MAX_REQUEST_TIMEOUT_MS } from "@varin/protocol";

/**
 * Experiment/resource/source tools (7C/7D, D-300).
 *
 * The tool surface stays small on purpose: one `experiment` tool covers
 * submit/list/get/logs/wait/cancel/collect, `resources` shows the machine
 * overview, and `research_source` registers provenance-carrying inputs.
 * Detail expands by identity — an attemptId opens the full record, paged
 * logs, and collected artifacts — instead of separate synonyms per verb.
 * These tools are not a second shell: an attempt has durable identity,
 * admission, and a backend binding that survives this session.
 */

function experimentErrorResult(toolName: string, error: unknown): { content: Array<{ type: "text"; text: string }>; isError: true; details: Record<string, unknown> } {
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

const invalidParams = (toolName: string, message: string) => ({
  content: [{ type: "text" as const, text: `${toolName} failed (invalid-params): ${message}` }],
  isError: true as const,
  details: { code: "invalid-params" },
});

const ExperimentResourcesParams = Type.Object({
  cpuCores: Type.Optional(Type.Number({ minimum: 0 })),
  memoryMb: Type.Optional(Type.Number({ minimum: 0 })),
  gpuCount: Type.Optional(Type.Integer({ minimum: 0 })),
  gpuMemoryMb: Type.Optional(Type.Number({ minimum: 0 })),
  longRunning: Type.Optional(Type.Boolean({ description: "Scheduling preference only — not a resource dimension" })),
});

const ExperimentSubmitItemParams = Type.Object({
  requestId: Type.String({ description: "Stable per-item idempotency key" }),
  title: Type.Optional(Type.String()),
  specId: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  args: Type.Optional(Type.Array(Type.String())),
  cwd: Type.Optional(Type.String()),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  inputs: Type.Optional(Type.Array(Type.Object({
    sourceId: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    objectHash: Type.Optional(Type.String()),
    role: Type.Optional(Type.String()),
  }))),
  resources: Type.Optional(ExperimentResourcesParams),
  outputPaths: Type.Optional(Type.Array(Type.String())),
  machineId: Type.Optional(Type.String()),
});

const ExperimentParams = Type.Object({
  action: Type.Union([
    Type.Literal("submit"),
    Type.Literal("submit_many"),
    Type.Literal("list"),
    Type.Literal("get"),
    Type.Literal("logs"),
    Type.Literal("artifact"),
    Type.Literal("wait"),
    Type.Literal("wait_many"),
    Type.Literal("cancel"),
    Type.Literal("cancel_many"),
    Type.Literal("collect"),
    Type.Literal("rerun"),
  ], { description: "submit starts a durable attempt; get/logs/artifact/collect expand by attemptId; wait blocks until terminal or timeout; cancel requests backend stop" }),
  attemptId: Type.Optional(Type.String({ description: "Required for get, logs, wait, cancel, collect" })),
  attemptIds: Type.Optional(Type.Array(Type.String(), { description: "wait_many/cancel_many: existing attempt identities" })),
  items: Type.Optional(Type.Array(ExperimentSubmitItemParams, { description: "submit_many: independent existing experiment specifications" })),
  artifactId: Type.Optional(Type.String({ description: "artifact: collected result identity from get/collect; reads text by byte page" })),
  // submit
  requestId: Type.Optional(Type.String({ description: "submit: idempotency key — a retry with the same id returns the recorded attempt instead of starting a second job" })),
  title: Type.Optional(Type.String({ description: "submit: short human-readable label for this experiment" })),
  specId: Type.Optional(Type.String({ description: "submit: reuse a previously recorded spec (cannot combine with inline fields); list: filter attempts by spec" })),
  command: Type.Optional(Type.String({ description: "submit: executable to run — required unless specId is given" })),
  args: Type.Optional(Type.Array(Type.String())),
  cwd: Type.Optional(Type.String({ description: "submit: absolute directory inside the workspace; defaults to the workspace root" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "submit: environment overrides merged over the inherited environment" })),
  inputs: Type.Optional(Type.Array(Type.Object({
    sourceId: Type.Optional(Type.String({ description: "A registered research_source id" })),
    path: Type.Optional(Type.String({ description: "Workspace-relative input path" })),
    objectHash: Type.Optional(Type.String({ description: "sha256-… object in the workspace store" })),
    role: Type.Optional(Type.String({ description: "What this input is for" })),
  }))),
  resources: Type.Optional(ExperimentResourcesParams),
  outputPaths: Type.Optional(Type.Array(Type.String({ description: "submit: workspace-relative output paths collected as artifacts after exit" }))),
  machineId: Type.Optional(Type.String({ description: "submit: target machine; defaults to local" })),
  // list
  state: Type.Optional(Type.Union([
    Type.Literal("submitted"),
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("stopping"),
    Type.Literal("completed"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
    Type.Literal("lost"),
  ], { description: "list: filter attempts by state" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "list: max attempts returned" })),
  // logs
  stream: Type.Optional(Type.Union([Type.Literal("stdout"), Type.Literal("stderr")], { description: "logs: stream to read (default stdout)" })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "logs: byte offset into the stream — pass the previous nextOffset to page" })),
  maxBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  // wait
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1, description: "wait: deadline in milliseconds; timeout ends only this wait, never the job" })),
});

const SourceParams = Type.Object({
  action: Type.Union([Type.Literal("register"), Type.Literal("list")]),
  kind: Type.Optional(Type.Union([
    Type.Literal("dataset"),
    Type.Literal("paper"),
    Type.Literal("code"),
    Type.Literal("artifact"),
    Type.Literal("collection"),
    Type.Literal("other"),
  ], { description: "register: required source kind; list: optional filter" })),
  label: Type.Optional(Type.String()),
  uri: Type.Optional(Type.String({ description: "register: external locator" })),
  path: Type.Optional(Type.String({ description: "register: workspace-relative locator" })),
  objectHash: Type.Optional(Type.String({ description: "register: sha256-… object locator" })),
  note: Type.Optional(Type.String({ description: "register: provenance note" })),
});

export function createExperimentTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "experiment",
    label: "Experiment",
    description: "Run and manage durable experiments. submit pins a spec and starts an attempt on a machine (local backend now); list shows concise attempt rows; get/logs/artifact/collect expand one attemptId; wait blocks until the attempt finishes or times out; cancel requests backend stop. Retrying a submit with the same requestId returns the recorded attempt instead of starting a second job.",
    promptSnippet: "experiment: submit/list/get/logs/artifact/wait/cancel/collect durable experiment attempts",
    promptGuidelines: [
      "Attempts retain their identity after the Run ends or the session disconnects. get/list read existing attempts; wait timeout leaves the job running.",
      "Unconfirmed capacity requests queue. artifact reads collected text by artifactId with nextOffset pagination; binary artifacts remain downloadable from the research panel.",
    ],
    parameters: ExperimentParams,
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const needAttempt = (): string => {
        if (params.attemptId === undefined || params.attemptId.trim() === "") {
          throw new HarnessRequestError("invalid-params", `action "${params.action}" requires attemptId`);
        }
        return params.attemptId;
      };
      const submitDraft = async (draft: ExperimentSubmitParams): Promise<ExperimentSubmitResult> => {
        if (draft.specId !== undefined && (draft.command !== undefined || draft.args !== undefined
          || draft.cwd !== undefined || draft.env !== undefined || draft.inputs !== undefined
          || draft.resources !== undefined || draft.outputPaths !== undefined)) {
          throw new HarnessRequestError("invalid-params", "specId cannot be combined with inline spec fields");
        }
        if (draft.specId === undefined && (draft.command === undefined || draft.command.trim() === "")) {
          throw new HarnessRequestError("invalid-params", "submit requires command (or a specId to reuse a recorded spec)");
        }
        return bridge.request<"experiment.submit">("experiment.submit", draft, signal ? { signal } : undefined) as Promise<ExperimentSubmitResult>;
      };
      try {
        switch (params.action) {
          case "artifact": {
            const attemptId = needAttempt();
            if (!params.artifactId?.trim()) return invalidParams("experiment", "artifact requires artifactId");
            const result = await bridge.request("experiment.artifact", {
              attemptId,
              artifactId: params.artifactId,
              ...(params.offset === undefined ? {} : { offset: params.offset }),
              ...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
            }, signal ? { signal } : undefined);
            return {
              content: [{ type: "text", text: result.text === null
                ? `${result.name}: this byte range is binary. Download the artifact from the research panel.`
                : `${result.name} [bytes ${result.offset}–${result.nextOffset}${result.eof ? ", end" : "; continue with offset=" + result.nextOffset}]\n${result.text}` }],
              details: { attemptId, artifactId: result.artifactId, offset: result.offset, nextOffset: result.nextOffset, eof: result.eof, binary: result.text === null },
            };
          }
          case "submit": {
            const result = await submitDraft({
              ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
              ...(params.title !== undefined ? { title: params.title } : {}),
              ...(params.specId !== undefined ? { specId: params.specId } : {}),
              ...(params.command !== undefined ? { command: params.command } : {}),
              ...(params.args !== undefined ? { args: params.args } : {}),
              ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
              ...(params.env !== undefined ? { env: params.env } : {}),
              ...(params.inputs !== undefined ? { inputs: params.inputs } : {}),
              ...(params.resources !== undefined ? { resources: params.resources } : {}),
              ...(params.outputPaths !== undefined ? { outputPaths: params.outputPaths } : {}),
              ...(params.machineId !== undefined ? { machineId: params.machineId } : {}),
            });
            const typed = result;
            return {
              content: [{ type: "text", text: `${typed.text}\nTo act when it finishes, register follow_up (source kind "experiment", attemptId "${typed.attempt.attemptId}") — non-blocking; the attempt keeps running.` }],
              details: {
                specId: typed.spec.specId,
                attemptId: typed.attempt.attemptId,
                state: typed.attempt.state,
                backend: typed.attempt.backend,
                ...(typed.attempt.machineId !== undefined ? { machineId: typed.attempt.machineId } : {}),
                ...(typed.attempt.queueReason !== undefined ? { queueReason: typed.attempt.queueReason } : {}),
              },
            };
          }
          case "submit_many": {
            if (!params.items?.length) return invalidParams("experiment", "submit_many requires at least one item");
            const submitted = await Promise.allSettled(params.items.map((item) => submitDraft(item)));
            const items = submitted.map((result, index) => result.status === "fulfilled"
              ? {
                  index,
                  requestId: params.items![index]!.requestId,
                  accepted: true as const,
                  attempt: result.value.attempt,
                  spec: result.value.spec,
                }
              : {
                  index,
                  requestId: params.items![index]!.requestId,
                  accepted: false as const,
                  error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                });
            const accepted = items.filter((item) => item.accepted).length;
            return {
              content: [{ type: "text", text: items.map((item) => item.accepted
                ? `${item.requestId}: ${item.attempt.attemptId} — ${item.attempt.state}`
                : `${item.requestId}: failed — ${item.error}`).join("\n") }],
              details: { count: items.length, accepted, failed: items.length - accepted, items },
              ...(accepted === 0 ? { isError: true as const } : {}),
            };
          }
          case "rerun": {
            const priorId = needAttempt();
            const prior = await bridge.request<"experiment.get">("experiment.get", { attemptId: priorId }, signal ? { signal } : undefined) as ExperimentGetResult;
            const result = await submitDraft({
              specId: prior.attempt.specId,
              retryOfAttemptId: priorId,
              ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
              ...(params.machineId !== undefined ? { machineId: params.machineId } : prior.attempt.machineId ? { machineId: prior.attempt.machineId } : {}),
              ...(params.title !== undefined ? { title: params.title } : {}),
            });
            return {
              content: [{ type: "text", text: `attempt ${result.attempt.attemptId} reruns ${priorId} — ${result.attempt.state}. Register follow_up (source kind "experiment", attemptId "${result.attempt.attemptId}") to continue when it finishes — non-blocking.` }],
              details: { attempt: result.attempt, spec: result.spec, retryOfAttemptId: priorId },
            };
          }
          case "list": {
            const result = await bridge.request<"experiment.list">("experiment.list", {
              ...(params.state !== undefined ? { state: params.state } : {}),
              ...(params.specId !== undefined ? { specId: params.specId } : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {}),
            }, signal ? { signal } : undefined);
            const typed = result as ExperimentListResult;
            return {
              content: [{ type: "text", text: typed.text }],
              details: { count: typed.attempts.length },
            };
          }
          case "get": {
            const result = await bridge.request<"experiment.get">("experiment.get", {
              attemptId: needAttempt(),
            }, signal ? { signal } : undefined);
            const typed = result as ExperimentGetResult;
            const attempt = typed.attempt;
            const lines = [
              `attempt ${attempt.attemptId} — ${attempt.state} on ${attempt.backend}${attempt.machineId ? `/${attempt.machineId}` : ""}`,
              `spec ${attempt.specId}${typed.spec?.title ? ` (${typed.spec.title})` : ""} — ${typed.spec ? `${typed.spec.command} ${typed.spec.args.join(" ")}`.trim() : "spec record unavailable"}`,
              ...(typed.job ? [`job ${typed.job.jobId} — ${typed.job.state}${typed.job.backendJobId ? ` (backend ${typed.job.backendJobId})` : ""}${typed.job.exitCode !== undefined && typed.job.exitCode !== null ? ` exit ${typed.job.exitCode}` : ""}`] : []),
              `collection: ${attempt.collection}${attempt.error ? ` · error: ${attempt.error}` : ""}`,
              ...(typed.artifacts.length > 0
                ? [`artifacts:\n${typed.artifacts.map((artifact) => `  ${artifact.name} — ${artifact.state}${artifact.byteLength !== undefined ? `, ${artifact.byteLength}B` : ""}${artifact.truncated ? ", truncated" : ""}${artifact.objectHash ? `, ${artifact.objectHash}` : ""}`).join("\n")}`]
                : []),
            ];
            return {
              content: [{ type: "text", text: lines.join("\n") }],
              details: { attempt, job: typed.job ?? null, artifacts: typed.artifacts, spec: typed.spec ?? null },
            };
          }
          case "logs": {
            const result = await bridge.request<"experiment.logs">("experiment.logs", {
              attemptId: needAttempt(),
              ...(params.stream !== undefined ? { stream: params.stream } : {}),
              ...(params.offset !== undefined ? { offset: params.offset } : {}),
              ...(params.maxBytes !== undefined ? { maxBytes: params.maxBytes } : {}),
            }, signal ? { signal } : undefined);
            const typed = result as ExperimentLogsResult;
            return {
              content: [{ type: "text", text: typed.text || `(${typed.stream} empty at offset ${typed.offset})` }],
              details: {
                attemptId: typed.attemptId,
                stream: typed.stream,
                offset: typed.offset,
                nextOffset: typed.nextOffset,
                eof: typed.eof,
                origin: typed.origin,
              },
            };
          }
          case "wait": {
            const timeoutMs = Math.min(
              params.timeout_ms ?? (HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000),
              HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000,
            );
            // The service owns the wait deadline and the execution-slot yield;
            // no second fixed timer may abort it (same rule as thread.wait).
            const result = await bridge.request<"experiment.wait">("experiment.wait", {
              attemptId: needAttempt(),
              timeoutMs,
            }, { timeoutMs: 0, ...(signal ? { signal } : {}) });
            const typed = result as ExperimentWaitResult;
            const attempt = typed.attempt;
            return {
              content: [{
                type: "text",
                text: `attempt ${attempt.attemptId} — ${attempt.state}${attempt.exitCode !== undefined && attempt.exitCode !== null ? ` (exit ${attempt.exitCode})` : ""}${typed.timedOut ? " — timed out; the job keeps running, wait again or use action:\"cancel\"" : ""}`,
              }],
              details: { attempt, timedOut: typed.timedOut },
            };
          }
          case "wait_many": {
            if (!params.attemptIds?.length) return invalidParams("experiment", "wait_many requires attemptIds");
            const timeoutMs = Math.min(params.timeout_ms ?? (HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000), HARNESS_MAX_REQUEST_TIMEOUT_MS - 5_000);
            const waited = await Promise.allSettled(params.attemptIds.map((attemptId) => bridge.request<"experiment.wait">(
              "experiment.wait", { attemptId, timeoutMs }, { timeoutMs: 0, ...(signal ? { signal } : {}) },
            )));
            const items = waited.map((result, index) => result.status === "fulfilled"
              ? { attemptId: params.attemptIds![index]!, ok: true as const, attempt: result.value.attempt, timedOut: result.value.timedOut }
              : { attemptId: params.attemptIds![index]!, ok: false as const, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
            return {
              content: [{ type: "text", text: items.map((item) => item.ok
                ? `${item.attemptId} — ${item.attempt.state}${item.timedOut ? " (wait timed out; still running)" : ""}`
                : `${item.attemptId} — wait failed: ${item.error}`).join("\n") }],
              details: { items },
            };
          }
          case "cancel": {
            const result = await bridge.request<"experiment.cancel">("experiment.cancel", {
              attemptId: needAttempt(),
            }, signal ? { signal } : undefined);
            const typed = result as { attempt: { attemptId: string; state: string } };
            return {
              content: [{ type: "text", text: `attempt ${typed.attempt.attemptId} — ${typed.attempt.state}` }],
              details: { attempt: typed.attempt },
            };
          }
          case "cancel_many": {
            if (!params.attemptIds?.length) return invalidParams("experiment", "cancel_many requires attemptIds");
            const cancelled = await Promise.allSettled(params.attemptIds.map((attemptId) => bridge.request<"experiment.cancel">(
              "experiment.cancel", { attemptId }, signal ? { signal } : undefined,
            )));
            const items = cancelled.map((result, index) => result.status === "fulfilled"
              ? { attemptId: params.attemptIds![index]!, ok: true as const, attempt: result.value.attempt }
              : { attemptId: params.attemptIds![index]!, ok: false as const, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
            return {
              content: [{ type: "text", text: items.map((item) => item.ok
                ? `${item.attemptId} — ${item.attempt.state}`
                : `${item.attemptId} — cancel failed: ${item.error}`).join("\n") }],
              details: { items },
            };
          }
          case "collect": {
            const result = await bridge.request<"experiment.collect">("experiment.collect", {
              attemptId: needAttempt(),
            }, signal ? { signal } : undefined);
            const typed = result as ExperimentCollectResult;
            const lines = typed.artifacts.map((artifact) =>
              `  ${artifact.name} — ${artifact.state}${artifact.byteLength !== undefined ? `, ${artifact.byteLength}B` : ""}${artifact.error ? `, ${artifact.error}` : ""}`);
            return {
              content: [{
                type: "text",
                text: `attempt ${typed.attempt.attemptId} — collection ${typed.attempt.collection}${lines.length > 0 ? `\nartifacts:\n${lines.join("\n")}` : ""}`,
              }],
              details: { attempt: typed.attempt, artifacts: typed.artifacts },
            };
          }
        }
      } catch (error) {
        return experimentErrorResult("experiment", error);
      }
    },
  });
}

export function createResourcesTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "resources",
    label: "Resources",
    description: "Show the machine resource overview: capacity, confirmed commitments, observed usage with its source and age, and connection state. Unknown usage is unknown, not idle.",
    promptSnippet: "resources: machine capacity, commitments, and observed usage",
    parameters: Type.Object({}),
    executionMode: "parallel",
    execute: async (_toolCallId, _params, signal, _onUpdate, _ctx) => {
      try {
        const result = await bridge.request<"resource.list">("resource.list", {}, signal ? { signal } : undefined);
        const typed = result as ResourceListResult;
        return {
          content: [{ type: "text", text: typed.text }],
          details: { machines: typed.machines, generatedAt: typed.generatedAt },
        };
      } catch (error) {
        return experimentErrorResult("resources", error);
      }
    },
  });
}

export function createResearchSourceTool(bridge: HostServicesBridge, _sessionId: string): ToolDefinition {
  return defineTool({
    name: "research_source",
    label: "Research Source",
    description: "Register or list provenance-carrying research inputs (dataset, paper, code, artifact, collection, other). Registration records the locator only — it does not fetch or copy content. A registered sourceId can feed experiment inputs.",
    promptSnippet: "research_source: register/list research inputs with provenance",
    parameters: SourceParams,
    executionMode: "parallel",
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        switch (params.action) {
          case "register": {
            if (params.kind === undefined) {
              return invalidParams("research_source", "register requires kind");
            }
            if (params.uri === undefined && params.path === undefined && params.objectHash === undefined) {
              return invalidParams("research_source", "register requires at least one locator: uri, path, or objectHash");
            }
            const result = await bridge.request<"source.register">("source.register", {
              kind: params.kind,
              ...(params.label !== undefined ? { label: params.label } : {}),
              ...(params.uri !== undefined ? { uri: params.uri } : {}),
              ...(params.path !== undefined ? { path: params.path } : {}),
              ...(params.objectHash !== undefined ? { objectHash: params.objectHash } : {}),
              ...(params.note !== undefined ? { note: params.note } : {}),
            }, signal ? { signal } : undefined);
            const typed = result as SourceRegisterResult;
            return {
              content: [{ type: "text", text: `source ${typed.source.sourceId} registered (${typed.source.kind}${typed.source.label ? `, ${typed.source.label}` : ""})` }],
              details: { source: typed.source },
            };
          }
          case "list": {
            const result = await bridge.request<"source.list">("source.list", {
              ...(params.kind !== undefined ? { kind: params.kind } : {}),
            }, signal ? { signal } : undefined);
            const typed = result as SourceListResult;
            return {
              content: [{ type: "text", text: typed.text }],
              details: { count: typed.sources.length, sources: typed.sources },
            };
          }
        }
      } catch (error) {
        return experimentErrorResult("research_source", error);
      }
    },
  });
}
