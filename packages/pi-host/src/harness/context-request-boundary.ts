import {
  buildSessionContext,
  calculateContextTokens,
  estimateTokens,
  type AgentSession,
  type AgentSessionEvent,
  type CompactionResult,
  type CompactionSettings,
} from "@earendil-works/pi-coding-agent";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { activeCompactionMessages } from "./compaction-context.js";

/** A logical model request after Pi's context hooks and convertToLlm. */
export interface ContextModelRequest {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions;
  inputTokens: number;
  reserveTokens: number;
  needsSpace: boolean;
}

export class ContextCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextCapacityError";
  }
}

/** Estimate the entire request, not usage embedded in an older transcript. */
export function estimateModelInputTokens(context: Context): number {
  const prefix = (context.systemPrompt?.length ?? 0)
    + (context.tools?.length ? JSON.stringify(context.tools).length : 0);
  return Math.ceil(prefix / 4)
    + context.messages.reduce((tokens, message) => tokens + estimateTokens(message), 0);
}

function sameMessage(left: Context["messages"][number], right: Context["messages"][number]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Calibrate only against an actual request with the same prefix. Native total
 * usage already includes cached tokens; adding cacheRead again would double it.
 * A compaction/model/prefix change invalidates this observation, not the history.
 */
export class RequestBudgetObservation {
  private previous: { key: string; context: Context; estimated: number; input: number } | undefined;

  clear(): void { this.previous = undefined; }

  estimate(key: string, context: Context): number {
    const estimated = estimateModelInputTokens(context);
    const previous = this.previous;
    if (!previous || previous.key !== key
      || previous.context.messages.length > context.messages.length
      || !previous.context.messages.every((message, index) => sameMessage(message, context.messages[index]!))) {
      return estimated;
    }
    return Math.max(0, previous.input + estimated - previous.estimated);
  }

  record(key: string, context: Context, response: AssistantMessage): void {
    if (response.stopReason === "error" || response.stopReason === "aborted") return;
    const input = calculateContextTokens(response.usage) - response.usage.output;
    if (!Number.isFinite(input) || input <= 0) return;
    this.previous = { key, context, estimated: estimateModelInputTokens(context), input };
  }
}

// These are Agent-loop callbacks, not provider request configuration. In
// particular, a derived summary must never carry a tool executor or drain queues.
const LOOP_OPTIONS = new Set([
  "model", "convertToLlm", "transformContext", "getApiKey", "getSteeringMessages",
  "getFollowUpMessages", "beforeToolCall", "afterToolCall", "shouldStopAfterTurn",
  "prepareNextTurn", "toolExecution",
]);

export function modelRequestOptions(options: SimpleStreamOptions | undefined): SimpleStreamOptions {
  return Object.fromEntries(Object.entries(options ?? {}).filter(([key]) => !LOOP_OPTIONS.has(key)));
}

/** Credential-free request identity; held only inside the owning Pi worker. */
export function contextRequestKey(model: Model<Api>, context: Context, options: SimpleStreamOptions): string {
  return JSON.stringify({
    model: { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl,
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, samplingParams: model.samplingParams },
    systemPrompt: context.systemPrompt,
    tools: context.tools?.map(({ name, description, parameters }) => ({ name, description, parameters })),
    reasoning: options.reasoning,
    thinkingBudgets: options.thinkingBudgets,
    temperature: options.temperature,
    samplingParams: options.samplingParams,
    maxTokens: options.maxTokens,
    cacheRetention: options.cacheRetention,
    transport: options.transport,
    sessionId: options.sessionId,
    toolChoice: options.toolChoice,
  });
}

export interface ContextRequestBoundaryOptions {
  getCompactionSettings(): Required<Pick<CompactionSettings, "enabled" | "reserveTokens" | "keepRecentTokens">>;
  /** An explicit manual summary may be applied at capacity even with automatic compaction disabled. */
  hasPreparedExplicitCompaction?(): boolean;
  /** Observe every request; needsSpace requests must not start a second task. */
  observe(request: ContextModelRequest): void;
  /** Return one fixed, validated compaction. Failure must not fall through. */
  compact(request: ContextModelRequest, signal: AbortSignal): Promise<CompactionResult>;
  /** Prepare candidate input before capacity admission; refresh after compaction. */
  inject?(request: ContextModelRequest, session: AgentSession): Promise<{
    request?: ContextModelRequest;
    /** Only environment facts enter native history; the team snapshot remains transient. */
    retained?: { content: string; details: Record<string, unknown> };
    confirm?(): void | Promise<void>;
  } | undefined>;
  onEvent?(event: AgentSessionEvent): void;
  onStatus?(): void;
}

/**
 * Adapter over public Pi seams, not an Agent loop. Pi still executes tools,
 * drains steering/follow-up queues, converts messages, and writes session JSONL.
 * We admit the fully constructed request and use SessionManager's compaction
 * writer at that safe boundary. prepareNextTurn refreshes the loop's local view
 * after such a commit, so an old pre-compaction array cannot return next turn.
 */
export function attachContextRequestBoundary(session: AgentSession, options: ContextRequestBoundaryOptions) {
  const agent = session.agent;
  const stream = agent.streamFunction;
  const prepareNextTurn = agent.prepareNextTurnWithContext;
  const budget = new RequestBudgetObservation();
  let committing = false;
  let generation = 0;
  let refreshedGeneration = 0;
  let latestOptions: SimpleStreamOptions = {};
  let disposed = false;

  const request = (model: Model<Api>, context: Context, rawOptions?: SimpleStreamOptions): ContextModelRequest => {
    context = { ...context, ...(context.tools ? { tools: context.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) } : {}) };
    const modelOptions = modelRequestOptions(rawOptions);
    const settings = options.getCompactionSettings();
    // An explicit request output reservation is respected. A model's advertised
    // maximum output is a ceiling, not a new Harness-sized input window.
    const reserveTokens = Math.max(settings.reserveTokens, modelOptions.maxTokens ?? 0);
    const inputTokens = budget.estimate(contextRequestKey(model, context, modelOptions), context);
    return { model, context, options: modelOptions, inputTokens, reserveTokens,
      needsSpace: model.contextWindow > 0 && inputTokens + reserveTokens > model.contextWindow };
  };

  const currentRequest = async (signal?: AbortSignal): Promise<ContextModelRequest> => {
    const model = session.model;
    if (!model) throw new ContextCapacityError("The session has no model for context preparation");
    const { reasoning: _reasoning, ...inheritedOptions } = latestOptions;
    const raw = activeCompactionMessages(session.sessionManager.buildSessionContext().messages);
    const messages = agent.transformContext ? await agent.transformContext(raw, signal) : raw;
    return request(model, {
      systemPrompt: agent.state.systemPrompt,
      tools: agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      messages: await agent.convertToLlm(messages),
    }, {
      ...inheritedOptions,
      ...(agent.state.thinkingLevel === "off" ? {} : { reasoning: agent.state.thinkingLevel }),
      ...(signal ? { signal } : {}),
      sessionId: session.sessionId,
      transport: agent.transport,
      ...(agent.thinkingBudgets ? { thinkingBudgets: agent.thinkingBudgets } : {}),
    });
  };

  const wrapper: StreamFn = async (model, context, rawOptions) => {
    if (disposed) throw new ContextCapacityError("The context request boundary has been disposed");
    latestOptions = modelRequestOptions(rawOptions);
    const signal = rawOptions?.signal ?? agent.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    let next = request(model, context, rawOptions);
    let injection: Awaited<ReturnType<NonNullable<ContextRequestBoundaryOptions["inject"]>>>;
    const prepare = async (): Promise<void> => {
      injection = await options.inject?.(next, session);
      signal.throwIfAborted();
      // Input estimates are recomputed here, never trusted from an injector.
      if (injection?.request) next = request(next.model, injection.request.context, next.options);
      options.observe(next);
    };
    try {
      await prepare();
      while (next.needsSpace) {
        if (!options.getCompactionSettings().enabled && !options.hasPreparedExplicitCompaction?.()) {
          throw new ContextCapacityError(`Model input needs approximately ${next.inputTokens} tokens plus ${next.reserveTokens} reserved output tokens, beyond the ${model.contextWindow}-token context window; automatic compaction is disabled. History was not changed.`);
        }
        if (!committing) {
          committing = true;
          options.onStatus?.();
          options.onEvent?.({ type: "compaction_start", reason: "threshold" });
        }
        const before = next.inputTokens;
        const result = await options.compact(next, signal);
        signal.throwIfAborted();
        const branch = session.sessionManager.getBranch();
        if (!branch.some((entry) => entry.id === result.firstKeptEntryId)) {
          throw new ContextCapacityError("The prepared context boundary no longer belongs to the active branch");
        }
        const preview = buildSessionContext([...branch, {
          type: "compaction", id: "varin-context-preview", parentId: session.sessionManager.getLeafId(),
          timestamp: new Date().toISOString(), summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId, tokensBefore: before,
        }]);
        const previewTokens = estimateModelInputTokens({ ...next.context,
          messages: await agent.convertToLlm(activeCompactionMessages(preview.messages)) });
        signal.throwIfAborted();
        if (previewTokens + next.reserveTokens > model.contextWindow
          && previewTokens >= estimateModelInputTokens(next.context)) {
          throw new ContextCapacityError("The prepared summary does not free input capacity. No compaction was committed; use paginated material or adjust the configured window.");
        }
        const id = session.sessionManager.appendCompaction(result.summary, result.firstKeptEntryId,
          before, result.details, true, result.usage);
        const entry = session.sessionManager.getEntry(id);
        if (!entry || entry.type !== "compaction") throw new Error("Pi did not publish the compaction entry");
        agent.state.messages = activeCompactionMessages(session.sessionManager.buildSessionContext().messages);
        generation += 1;
        budget.clear();
        options.onEvent?.({ type: "entry_appended", entry });
        await session.extensionRunner?.emit({ type: "session_compact", compactionEntry: entry,
          fromExtension: true, reason: "threshold", willRetry: false });
        next = await currentRequest(signal);
        await prepare();
        options.onEvent?.({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
          result: { ...result, tokensBefore: before, estimatedTokensAfter: next.inputTokens } });
        committing = false;
        options.onStatus?.();
        if (next.needsSpace && next.inputTokens >= before) {
          throw new ContextCapacityError("Compaction cannot make this request fit. Read the oversized material in pages or increase the configured model capacity; the original Pi history is retained.");
        }
      }
      signal.throwIfAborted();
      // Calling the original SDK stream preserves ModelRuntime auth, provider
      // headers, retries, payload hooks, and all applicable main-request options.
      const outgoing = structuredClone(next.context);
      const key = contextRequestKey(next.model, outgoing, next.options);
      const sentGeneration = generation;
      const result = await stream(next.model, next.context, { ...rawOptions, ...next.options, signal });
      void result.result().then((response) => {
        if (!disposed && generation === sentGeneration) budget.record(key, outgoing, response);
      }).catch(() => undefined);
      if (!injection?.retained && !injection?.confirm) return result;
      const delivery = injection;
      const forwarded = createAssistantMessageEventStream();
      // Creating a provider stream is not proof of sending: credential and HTTP
      // failures can arrive as its first event. Retain only after a real response.
      void (async () => {
        let delivered = false;
        try {
          for await (const event of result) {
            if (!delivered && event.type !== "error") {
              delivered = true;
              if (delivery.retained) {
                const id = session.sessionManager.appendCustomMessageEntry(
                  "varin-context", delivery.retained.content, false, delivery.retained.details,
                );
                const entry = session.sessionManager.getEntry(id);
                if (!entry) throw new Error("Pi did not retain the delivered environment observations");
                agent.state.messages = activeCompactionMessages(session.sessionManager.buildSessionContext().messages);
                generation += 1;
                options.onEvent?.({ type: "entry_appended", entry });
              }
              // History already carries the receipt; an unavailable Host must
              // not hold up the provider's first token while acknowledging it.
              void Promise.resolve().then(() => delivery.confirm?.()).catch(() => undefined);
            }
            forwarded.push(event);
          }
          forwarded.end(await result.result());
        } catch (error) {
          const reason = signal.aborted ? "aborted" : "error";
          forwarded.push({ type: "error", reason, error: {
            role: "assistant", content: [], api: next.model.api, provider: next.model.provider,
            model: next.model.id, stopReason: reason, timestamp: Date.now(),
            errorMessage: error instanceof Error ? error.message : String(error),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          } });
        }
      })();
      return forwarded;
    } catch (error) {
      if (committing) options.onEvent?.({ type: "compaction_end", reason: "threshold", aborted: signal.aborted,
        result: undefined, willRetry: false, errorMessage: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      committing = false;
      options.onStatus?.();
    }
  };

  const refresh: NonNullable<typeof prepareNextTurn> = async (context, signal) => {
    const update = await prepareNextTurn?.(context, signal);
    if (generation === refreshedGeneration) return update;
    refreshedGeneration = generation;
    const messages = activeCompactionMessages(session.sessionManager.buildSessionContext().messages);
    agent.state.messages = messages;
    return { ...update, context: { ...context.context, ...update?.context, messages } };
  };
  agent.streamFunction = wrapper;
  agent.prepareNextTurnWithContext = refresh;

  return {
    currentRequest,
    isCommitting: () => committing,
    dispose: () => {
      disposed = true;
      budget.clear();
      if (agent.streamFunction === wrapper) agent.streamFunction = stream;
      if (agent.prepareNextTurnWithContext === refresh) {
        if (prepareNextTurn) agent.prepareNextTurnWithContext = prepareNextTurn;
        else delete agent.prepareNextTurnWithContext;
      }
    },
  };
}
