import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  convertToLlm,
  createAgentSessionServices,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ThinkingBudgets, ThinkingLevel, Transport, Usage } from "@earendil-works/pi-ai";
import {
  readCompactionTaskSpec,
  resolveCompactionRecoverySettings,
  type CompactionRunResult,
  type CompactionTrace,
  type CompactionTraceEntry,
  type CompactionTaskSpec,
  type HarnessError,
  type HostEventData,
  type JsonValue,
} from "@varin/protocol";
import {
  COMPACTION_SYSTEM_PROMPT,
  compactionMaterialMessages,
  compactionInstruction,
  deserializeCompactionModel,
} from "./harness/compaction-agent.js";
import { createCompactionQueryTools } from "./harness/compaction-tools.js";
import {
  contextRequestKey,
  modelRequestOptions,
  RequestBudgetObservation,
} from "./harness/context-request-boundary.js";
import { HostServicesBridge } from "./harness/host-services-bridge.js";
import { ProviderConfigurationManager } from "./provider-configuration.js";
import { createCompactionWatchdog } from "./compaction-watchdog.js";

function addUsage(total: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (next === undefined) return total;
  if (total === undefined) return JSON.parse(JSON.stringify(next)) as Usage;
  return {
    input: total.input + next.input,
    output: total.output + next.output,
    cacheRead: total.cacheRead + next.cacheRead,
    cacheWrite: total.cacheWrite + next.cacheWrite,
    ...(total.cacheWrite1h === undefined && next.cacheWrite1h === undefined
      ? {}
      : { cacheWrite1h: (total.cacheWrite1h ?? 0) + (next.cacheWrite1h ?? 0) }),
    ...(total.reasoning === undefined && next.reasoning === undefined
      ? {}
      : { reasoning: (total.reasoning ?? 0) + (next.reasoning ?? 0) }),
    totalTokens: total.totalTokens + next.totalTokens,
    cost: {
      input: total.cost.input + next.cost.input,
      output: total.cost.output + next.cost.output,
      cacheRead: total.cost.cacheRead + next.cost.cacheRead,
      cacheWrite: total.cost.cacheWrite + next.cost.cacheWrite,
      total: total.cost.total + next.cost.total,
    },
  };
}

/**
 * The internal compaction worker (D-314 §4). One dedicated pi-host subprocess
 * per task: it runs a real Pi Agent loop with read-only query executors, on the
 * parent session's model and resolved execution config, and returns S1. It
 * never creates a session, worktree, thread, or a second history database.
 */
type CompactionEmit = <E extends "harness.request" | "harness.cancel" | "compaction.trace">(
  event: E,
  data: HostEventData<E>,
) => void;

export class CompactionWorkerRuntime {
  readonly #agentDir: string;
  readonly #emit: CompactionEmit;
  readonly #configureModelRuntime: ((runtime: ModelRuntime) => void | Promise<void>) | undefined;
  #bridge: HostServicesBridge | undefined;
  #agent: Agent | undefined;
  #abortController = new AbortController();
  #aborted = false;
  #stalled = false;
  #queries = 0;

  constructor(options: {
    agentDir: string;
    emit: CompactionEmit;
    /**
     * Test seam for in-memory providers (e.g. faux): production workers rely on
     * the shared agentDir credential/model stores plus provider configuration.
     */
    configureModelRuntime?: (runtime: ModelRuntime) => void | Promise<void>;
  }) {
    this.#agentDir = options.agentDir;
    this.#emit = options.emit;
    this.#configureModelRuntime = options.configureModelRuntime;
  }

  /** Abort the current task and any in-flight read-only query synchronously. */
  abort(): void {
    this.#aborted = true;
    this.#abortController.abort();
    this.#agent?.abort();
    this.#bridge?.dispose();
  }

  #throwIfAborted(): void {
    if (this.#aborted) throw new Error("Compaction worker aborted");
  }

  respondHarness(
    sessionId: string,
    requestId: string,
    outcome: { ok: true; result: unknown } | { ok: false; error: HarnessError },
  ): boolean {
    return this.#bridge?.respond(sessionId, requestId, outcome) ?? false;
  }

  async run(params: unknown): Promise<CompactionRunResult> {
    this.#throwIfAborted();
    const spec: CompactionTaskSpec = readCompactionTaskSpec(params);
    this.#stalled = false;
    const watchdog = createCompactionWatchdog(spec.recovery ?? resolveCompactionRecoverySettings(undefined), () => {
      this.#stalled = true;
      this.abort();
    });
    watchdog.start();
    try { return await watchdog.race(this.#runTask(spec, watchdog)); }
    finally { watchdog.dispose(); }
  }

  async #runTask(spec: CompactionTaskSpec, watchdog: ReturnType<typeof createCompactionWatchdog>): Promise<CompactionRunResult> {
    const trace: CompactionTrace = { taskId: spec.taskId ?? randomUUID(), entries: [] };
    const progress = (update: { type: "started" | "finished" } | { type: "delta"; channel: "text" | "thinking"; delta: string } | { type: "entry"; entry: CompactionTraceEntry } | { type: "failed"; message: string }) => {
      try { this.#emit("compaction.trace", { sessionId: spec.sessionId, taskId: trace.taskId,
        ...(spec.attempt === undefined ? {} : { attempt: spec.attempt }), ...update }); }
      catch { /* The summary remains authoritative when a viewer disconnects. */ }
    };
    progress({ type: "started" });
    const bridge = new HostServicesBridge({
      emit: (event, data) => this.#emit(event, data),
      sessionId: spec.sessionId,
    });
    this.#bridge = bridge;
    this.#queries = 0;
    try {
      const model = deserializeCompactionModel(spec.model);
      // Same credential and model stores as the owning session
      // (createAgentSessionServices): auth.json/models.json under agentDir.
      const modelRuntime = await ModelRuntime.create({
        allowModelNetwork: false,
        authPath: join(this.#agentDir, "auth.json"),
        modelsPath: join(this.#agentDir, "models.json"),
        signal: this.#abortController.signal,
      });
      this.#throwIfAborted();
      // Match the owning session's trust and settings view. The native service
      // loader registers static Pi extension providers before the Varin-scoped
      // provider overlays are applied; no AgentSession or business loop is made.
      const cwd = process.cwd();
      const settingsManager = SettingsManager.create(cwd, this.#agentDir, { projectTrusted: spec.projectTrusted });
      const services = await createAgentSessionServices({
        agentDir: this.#agentDir,
        cwd,
        modelRuntime,
        modelRuntimeSignal: this.#abortController.signal,
        settingsManager,
      });
      this.#throwIfAborted();
      const extensionErrors = services.resourceLoader.getExtensions().errors;
      const resourceDiagnostics = [
        ...extensionErrors.map((entry) => `Failed to load extension "${entry.path}": ${entry.error}`),
        ...services.diagnostics
          .filter((diagnostic) => diagnostic.type === "error")
          .map((diagnostic) => diagnostic.message),
      ];
      await new ProviderConfigurationManager({ agentDir: this.#agentDir })
        .apply(modelRuntime, cwd, services.settingsManager.isProjectTrusted());
      await this.#configureModelRuntime?.(modelRuntime);
      this.#throwIfAborted();
      const resolvedModel = modelRuntime.getModel(model.provider, model.id);
      if (!resolvedModel) {
        const related = resourceDiagnostics.filter((diagnostic) =>
          diagnostic.includes(model.provider) || diagnostic.includes(model.id));
        throw new Error(
          `Compaction model is unavailable after provider setup: ${model.provider}/${model.id}`
          + (related.length === 0 ? "" : `; ${related.join("; ")}`),
        );
      }
      const executionModel = (candidate: typeof model) => JSON.stringify({
        provider: candidate.provider,
        id: candidate.id,
        api: candidate.api,
        baseUrl: candidate.baseUrl,
        contextWindow: candidate.contextWindow,
        maxTokens: candidate.maxTokens,
        ...(candidate.compat === undefined ? {} : { compat: candidate.compat }),
        ...(candidate.samplingParams === undefined ? {} : { samplingParams: candidate.samplingParams }),
      });
      if (executionModel(resolvedModel) !== executionModel(model)) {
        throw new Error(`Compaction model configuration changed while starting: ${model.provider}/${model.id}`);
      }
      const tools = createCompactionQueryTools(bridge, () => { this.#queries += 1; });
      const budget = new RequestBudgetObservation();
      const providerRetrySettings = services.settingsManager.getProviderRetrySettings();
      const httpIdleTimeoutMs = services.settingsManager.getHttpIdleTimeoutMs();
      const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2_147_483_647 : httpIdleTimeoutMs;
      const settingsThinkingBudgets = services.settingsManager.getThinkingBudgets();
      const agent = new Agent({
        initialState: {
          systemPrompt: COMPACTION_SYSTEM_PROMPT,
          model,
          messages: compactionMaterialMessages(spec),
          ...(spec.options.reasoning === undefined
            ? {}
            : { thinkingLevel: spec.options.reasoning as ThinkingLevel }),
        },
        // The core agent's default transformer silently drops Pi custom
        // messages. The coding-agent transformer turns S0 (compactionSummary)
        // and extension custom messages into provider-visible user messages.
        convertToLlm,
        streamFn: (nextModel, context, options) => {
          const providerOptions = {
            ...options,
            maxTokens: spec.options.maxTokens,
            ...(spec.options.temperature === undefined ? {} : { temperature: spec.options.temperature }),
            ...(spec.options.samplingParams === undefined
              ? {}
              : { samplingParams: spec.options.samplingParams as Record<string, unknown> }),
            ...(spec.options.cacheRetention === undefined
              ? {}
              : { cacheRetention: spec.options.cacheRetention as never }),
          };
          providerOptions.signal?.throwIfAborted();
          // Agent tools carry executors for the loop, but only their provider
          // schema belongs in a model request. Keep the observed context
          // detached because the Agent mutates its working transcript after a
          // tool turn while the next request is being prepared.
          const outgoingContext = context;
          const observedContext = structuredClone(outgoingContext);
          const requestOptions = modelRequestOptions(providerOptions);
          const key = contextRequestKey(nextModel, outgoingContext, requestOptions);
          const inputTokens = budget.estimate(key, outgoingContext);
          if (nextModel.contextWindow > 0 && inputTokens + spec.options.maxTokens > nextModel.contextWindow) {
            throw new Error(
              `Compaction request needs approximately ${inputTokens} input tokens plus ${spec.options.maxTokens} reserved output tokens, beyond the ${nextModel.contextWindow}-token context window; original history was retained.`,
            );
          }
          const timeoutMs = providerOptions.timeoutMs
            ?? providerRetrySettings.timeoutMs
            ?? effectiveTimeoutMs;
          const websocketConnectTimeoutMs = providerOptions.websocketConnectTimeoutMs
            ?? services.settingsManager.getWebSocketConnectTimeoutMs();
          const runtimeOptions = {
            ...providerOptions,
            timeoutMs,
            ...(websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs }),
            ...(providerOptions.maxRetries === undefined
              ? (providerRetrySettings.maxRetries === undefined ? {} : { maxRetries: providerRetrySettings.maxRetries })
              : {}),
            ...(providerOptions.maxRetryDelayMs === undefined
              ? { maxRetryDelayMs: providerRetrySettings.maxRetryDelayMs }
              : {}),
          };
          const result = modelRuntime.streamSimple(nextModel, outgoingContext, runtimeOptions);
          // Calibrate the next request only from the actual provider response.
          // A failed/aborted response follows RequestBudgetObservation's native
          // rules and does not poison the estimate for later requests.
          void result.result()
            .then((response) => budget.record(key, observedContext, response))
            .catch(() => undefined);
          return result;
        },
        sessionId: spec.options.sessionId ?? spec.sessionId,
        ...(spec.options.transport === undefined
          ? { transport: services.settingsManager.getTransport() }
          : { transport: spec.options.transport as Transport }),
        ...(spec.options.thinkingBudgets === undefined
          ? (settingsThinkingBudgets === undefined
            ? {}
            : { thinkingBudgets: settingsThinkingBudgets as ThinkingBudgets })
          : { thinkingBudgets: spec.options.thinkingBudgets as ThinkingBudgets }),
        maxRetryDelayMs: providerRetrySettings.maxRetryDelayMs,
        toolExecution: "parallel",
      });
      this.#agent = agent;
      agent.state.tools = tools;
      let lastAssistant: AssistantMessage | undefined;
      let totalUsage: Usage | undefined;
      const unsubscribe = agent.subscribe(async (event) => {
        if (event.type === "message_update") {
          const delta = event.assistantMessageEvent;
          if (delta.type === "text_delta" || delta.type === "thinking_delta" || delta.type === "toolcall_delta") {
            watchdog.streamed();
          }
          if (delta.type === "text_delta" || delta.type === "thinking_delta") {
            progress({ type: "delta", channel: delta.type === "text_delta" ? "text" : "thinking", delta: delta.delta });
          }
        }
        if (event.type === "message_end" && event.message.role === "assistant") {
          watchdog.waiting();
          lastAssistant = event.message as AssistantMessage;
          totalUsage = addUsage(totalUsage, lastAssistant.usage);
          const text = lastAssistant.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
          const thinking = lastAssistant.content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("\n");
          if (text || thinking) {
            const entry: CompactionTraceEntry = { kind: "assistant", at: Date.now(), ...(text ? { text } : {}), ...(thinking ? { thinking } : {}) };
            trace.entries.push(entry);
            progress({ type: "entry", entry });
          }
        } else if (event.type === "tool_execution_start") {
          watchdog.waiting();
          const entry: CompactionTraceEntry = {
            kind: "tool-call", at: Date.now(), toolCallId: event.toolCallId, toolName: event.toolName,
            args: JSON.parse(JSON.stringify(event.args ?? null)) as JsonValue,
          };
          trace.entries.push(entry);
          progress({ type: "entry", entry });
        } else if (event.type === "tool_execution_end") {
          watchdog.waiting();
          const entry: CompactionTraceEntry = {
            kind: "tool-result", at: Date.now(), toolCallId: event.toolCallId, toolName: event.toolName,
            isError: event.isError,
            result: JSON.parse(JSON.stringify(event.result ?? null)) as JsonValue,
          };
          trace.entries.push(entry);
          progress({ type: "entry", entry });
        }
      });
      try {
        watchdog.waiting();
        await agent.prompt(compactionInstruction(spec));
        await agent.waitForIdle();
        this.#throwIfAborted();
      } finally {
        unsubscribe();
      }
      if (!lastAssistant) {
        throw new Error(agent.state.errorMessage ?? "The compaction agent produced no response");
      }
      if (lastAssistant.stopReason === "aborted" || lastAssistant.stopReason === "length") {
        throw new Error(`Compaction did not complete: ${lastAssistant.stopReason}`);
      }
      if (lastAssistant.stopReason === "error") {
        throw new Error(`Compaction failed: ${lastAssistant.errorMessage || "unknown error"}`);
      }
      if (lastAssistant.stopReason !== "stop") {
        throw new Error(`Compaction did not complete: ${lastAssistant.stopReason}`);
      }
      if (lastAssistant.content.some((block) => block.type === "toolCall")) {
        throw new Error("Compaction returned tool calls instead of a final summary");
      }
      const summary = lastAssistant.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!summary) throw new Error("Compaction returned no summary text");
      progress({ type: "finished" });
      return {
        summary,
        queries: this.#queries,
        trace,
        ...(totalUsage === undefined
          ? {}
          : { usage: JSON.parse(JSON.stringify(totalUsage)) }),
      };
    } catch (error) {
      if (!this.#stalled) progress({ type: "failed", message: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.#agent = undefined;
      this.#bridge = undefined;
      bridge.dispose();
    }
  }
}
