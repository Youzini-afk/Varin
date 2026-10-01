/**
 * Chat-independent Pi runtime binding for embedding, rerank and classifiers.
 * Provider/model definitions come from user + operator authority only. A
 * trusted project's provider layer never participates in background inference.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { classify as classifySystemOne } from "@earendil-works/pi-ai/api/typesafe-system-one";
import type { ClassifierModel, ClassifierApi } from "@earendil-works/pi-ai";
import {
  FAST_DECISION_PURPOSES,
  HarnessInferenceSettingsValidationError,
  estimateMemoryOrganizerInputTokens,
  memoryOrganizerOutputReservation,
  parseHarnessEmbeddingSettings,
  parseHarnessFastDecisionSettings,
  parseHarnessRerankSettings,
  remoteEmbeddingSpaceParts,
  resolveFastDecisionPurpose,
  REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS,
  type HarnessEmbedParams,
  type HarnessEmbedResult,
  type HarnessEmbeddingSettings,
  type HarnessFastDecisionParams,
  type HarnessFastDecisionPurposeStatus,
  type HarnessFastDecisionResult,
  type HarnessFastDecisionSettings,
  type HarnessInferenceBindingSnapshot,
  type HarnessMemoryOrganizeParams,
  type HarnessMemoryOrganizeResult,
  type HarnessRerankParams,
  type HarnessRerankResult,
  type HarnessRerankSettings,
  type HarnessSettingsInput,
  type HarnessVectorSpaceBinding,
  type ProviderInferenceCapability,
} from "@varin/protocol";
import { HostError } from "../errors.js";
import { ProviderConfigurationManager } from "../provider-configuration.js";
import { requestAdaptiveEmbeddings } from "./openai-embeddings.js";
import { requestHttpRerank } from "./http-rerank.js";
import { requestClassifier, ClassifierRequestError, ClassifierResponseError } from "./native-classifier.js";

export { REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS };

export interface BackgroundInferenceOptions {
  agentDir: string;
  cwd: string;
  fetchImpl?: typeof fetch;
  /** Used only for the user's in-process AuthStorage overlay. */
  modelRuntime?: ModelRuntime;
}

type ResolvedProviderBinding = {
  apiKey?: string;
  baseUrl: string;
  configurationId: string;
  headers?: Record<string, string>;
  endpoint?: string;
  classifierApi?: ClassifierApi;
};

const digest = (value: unknown): string => createHash("sha256")
  .update(JSON.stringify(value)).digest("hex").slice(0, 16);

const credentialFreeUrl = (value: string): string => {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return value.replace(/\/$/u, "");
  }
};

const spaceIdOf = (input: {
  protocol: string;
  providerId: string;
  modelId: string;
  configurationId: string;
  maxTokens: number;
  dimensions: number;
}): string => digest(remoteEmbeddingSpaceParts(input));

const stringHeaders = (headers: Record<string, string | null> | undefined): Record<string, string> | undefined => {
  if (!headers) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) if (typeof value === "string") cleaned[key] = value;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
};

const harnessFromSettings = (manager: SettingsManager): HarnessSettingsInput => {
  const harness = (manager.getGlobalSettings() as { harness?: unknown }).harness;
  if (harness === undefined) return {};
  if (!harness || typeof harness !== "object" || Array.isArray(harness)) {
    throw new HarnessInferenceSettingsValidationError("harness must be an object");
  }
  return harness as HarnessSettingsInput;
};

export class BackgroundInferenceRuntime {
  readonly #agentDir: string;
  readonly #cwd: string;
  readonly #fetchImpl: typeof fetch | undefined;
  readonly #settings: SettingsManager;
  readonly #providers: ProviderConfigurationManager;
  readonly #authRuntime: ModelRuntime | undefined;
  readonly #active = new Map<string, { controller: AbortController; requestId?: string }>();
  readonly #reservations = new Map<string, {
    batchId: string;
    state: "reserved" | "cancelled" | "rejected";
  }>();
  readonly #reservedByBatch = new Map<string, string>();
  #configRuntime: ModelRuntime | undefined;
  #configRuntimePromise: Promise<ModelRuntime> | undefined;
  #disposed = false;

  constructor(options: BackgroundInferenceOptions) {
    this.#agentDir = options.agentDir;
    this.#cwd = options.cwd;
    this.#fetchImpl = options.fetchImpl;
    this.#authRuntime = options.modelRuntime;
    this.#settings = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
    this.#providers = new ProviderConfigurationManager({ agentDir: options.agentDir });
  }

  embeddingSettings(): HarnessEmbeddingSettings | undefined {
    return parseHarnessEmbeddingSettings(harnessFromSettings(this.#settings).embedding);
  }

  rerankSettings(): HarnessRerankSettings | undefined {
    return parseHarnessRerankSettings(harnessFromSettings(this.#settings).rerank);
  }

  fastDecisionSettings(): HarnessFastDecisionSettings | undefined {
    return parseHarnessFastDecisionSettings(harnessFromSettings(this.#settings).fastDecision);
  }

  async describe(): Promise<HarnessInferenceBindingSnapshot> {
    try {
      await this.reload();
    } catch {
      return {
        embedding: { status: "unavailable", message: "Harness settings could not be read" },
        rerank: { status: "unavailable", message: "Harness settings could not be read" },
        fastDecision: {
          purposes: Object.fromEntries(FAST_DECISION_PURPOSES.map((purpose) => [
            purpose,
            { status: "unavailable", message: "Harness settings could not be read" },
          ])),
        },
      };
    }
    const embedding = await (async (): Promise<HarnessInferenceBindingSnapshot["embedding"]> => {
      let settings: HarnessEmbeddingSettings | undefined;
      try { settings = this.embeddingSettings(); }
      catch { return { status: "invalid", message: "Embedding settings are malformed" }; }
      if (!settings) return { status: "unconfigured" };
      try {
        const provider = await this.#resolveProviderBinding(settings.providerId, settings.modelId, false, "embedding");
        return { status: "ready", binding: { ...settings, configurationId: provider.configurationId } };
      } catch {
        return { status: "unavailable", message: "Embedding provider binding is unavailable" };
      }
    })();
    const rerank = await (async (): Promise<HarnessInferenceBindingSnapshot["rerank"]> => {
      let settings: HarnessRerankSettings | undefined;
      try { settings = this.rerankSettings(); }
      catch { return { status: "invalid", message: "Rerank settings are malformed" }; }
      if (!settings) return { status: "unconfigured" };
      try {
        const provider = await this.#resolveProviderBinding(settings.providerId, settings.modelId, false, "rerank");
        const endpoint = settings.endpoint ?? provider.endpoint;
        return { status: "ready", binding: { ...settings, ...(endpoint ? { endpoint } : {}), configurationId: provider.configurationId } };
      } catch {
        return { status: "unavailable", message: "Rerank provider binding is unavailable" };
      }
    })();
    const fastDecision = await (async (): Promise<NonNullable<HarnessInferenceBindingSnapshot["fastDecision"]>> => {
      let settings: HarnessFastDecisionSettings | undefined;
      try { settings = this.fastDecisionSettings(); }
      catch {
        return {
          purposes: Object.fromEntries(FAST_DECISION_PURPOSES.map((purpose) => [
            purpose,
            { status: "invalid", message: "Fast decision settings are malformed" },
          ])),
        };
      }
      const purposes: Record<string, HarnessFastDecisionPurposeStatus> = {};
      for (const purpose of FAST_DECISION_PURPOSES) {
        const resolution = resolveFastDecisionPurpose(settings, purpose);
        if (resolution.status === "disabled") {
          purposes[purpose] = { status: "disabled" };
          continue;
        }
        if (resolution.status === "unconfigured") {
          purposes[purpose] = { status: "unconfigured" };
          continue;
        }
        try {
          const provider = await this.#resolveProviderBinding(
            resolution.binding.providerId, resolution.binding.modelId, false, "decision",
          );
          const endpoint = resolution.binding.endpoint ?? provider.endpoint;
          purposes[purpose] = {
            status: "ready",
            binding: { ...resolution.binding, ...(endpoint ? { endpoint } : {}), configurationId: provider.configurationId },
          };
        } catch {
          purposes[purpose] = { status: "unavailable", message: "Fast decision provider binding is unavailable" };
        }
      }
      return { purposes };
    })();
    return { embedding, rerank, fastDecision };
  }

  async reload(): Promise<void> {
    await this.#settings.reload();
    const errors = this.#settings.drainErrors();
    if (errors.length > 0) {
      throw new HostError(
        "settings_read_failed",
        errors.map((entry) => entry.error.message).join("; "),
      );
    }
  }

  async embed(
    params: HarnessEmbedParams & { signal?: AbortSignal },
    requestId?: string,
  ): Promise<HarnessEmbedResult> {
    const signal = this.#begin(params.batchId, params.signal, requestId);
    try {
      await this.reload();
      signal.throwIfAborted();
      const configured = this.embeddingSettings();
      if (!configured) throw new HostError("embedding_unconfigured", "Remote embedding is not configured");
      const endpoint = await this.#resolveProviderBinding(configured.providerId, configured.modelId, true, "embedding");
      const maxTokens = configured.maxTokens ?? REMOTE_EMBEDDING_DEFAULT_MAX_TOKENS;
      if (
        configured.protocol !== params.protocol
        || configured.providerId !== params.providerId
        || configured.modelId !== params.modelId
        || endpoint.configurationId !== params.configurationId
        || configured.dimensions !== params.dimensions
        || params.maxTokens !== maxTokens
      ) throw new HostError(
        "embedding_binding_mismatch",
        `Embed request does not match the current frozen binding (${[
          configured.protocol !== params.protocol ? "protocol" : "",
          configured.providerId !== params.providerId ? "provider" : "",
          configured.modelId !== params.modelId ? "model" : "",
          endpoint.configurationId !== params.configurationId ? "configuration" : "",
          configured.dimensions !== params.dimensions ? "dimensions" : "",
          params.maxTokens !== maxTokens ? "maxTokens" : "",
        ].filter(Boolean).join(",")})`,
      );
      signal.throwIfAborted();
      const result = await requestAdaptiveEmbeddings({
        baseUrl: endpoint.baseUrl,
        ...(endpoint.endpoint ? { endpoint: endpoint.endpoint } : {}),
        apiKey: endpoint.apiKey!,
        ...(endpoint.headers ? { headers: endpoint.headers } : {}),
        model: configured.modelId,
        input: params.items.map((item) => item.text),
        ...(configured.dimensions === undefined ? {} : { dimensions: configured.dimensions }),
        ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
        signal,
      });
      signal.throwIfAborted();
      const space: HarnessVectorSpaceBinding = {
        providerId: configured.providerId,
        modelId: configured.modelId,
        protocol: "openai-compatible",
        configurationId: endpoint.configurationId,
        dim: result.dim,
        maxTokens,
        spaceId: spaceIdOf({
          protocol: "openai-compatible",
          providerId: configured.providerId,
          modelId: configured.modelId,
          configurationId: endpoint.configurationId,
          maxTokens,
          dimensions: result.dim,
        }),
      };
      return {
        batchId: params.batchId,
        space,
        items: result.vectors.map((vector, index) => ({ id: params.items[index]!.id, index, vector })),
      };
    } finally {
      this.#finish(params.batchId, requestId);
    }
  }

  async rerank(
    params: HarnessRerankParams & { signal?: AbortSignal },
    requestId?: string,
  ): Promise<HarnessRerankResult> {
    const signal = this.#begin(params.batchId, params.signal, requestId);
    try {
      await this.reload();
      signal.throwIfAborted();
      const configured = this.rerankSettings();
      if (!configured) throw new HostError("rerank_unconfigured", "Rerank is not configured");
      const endpoint = await this.#resolveProviderBinding(configured.providerId, configured.modelId, true, "rerank");
      const requestEndpoint = configured.endpoint ?? endpoint.endpoint;
      if (
        configured.protocol !== params.protocol
        || configured.providerId !== params.providerId
        || configured.modelId !== params.modelId
        || endpoint.configurationId !== params.configurationId
        || requestEndpoint !== params.endpoint
        || configured.maxDocumentTokens !== params.maxDocumentTokens
      ) throw new HostError("rerank_binding_mismatch", "Rerank request does not match the current frozen binding");
      signal.throwIfAborted();
      const scores = await requestHttpRerank({
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey!,
        ...(endpoint.headers ? { headers: endpoint.headers } : {}),
        model: configured.modelId,
        query: params.query,
        documents: params.documents,
        ...(requestEndpoint ? { endpoint: requestEndpoint } : {}),
        ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
        signal,
      });
      signal.throwIfAborted();
      return { batchId: params.batchId, providerId: configured.providerId, modelId: configured.modelId, scores };
    } finally {
      this.#finish(params.batchId, requestId);
    }
  }

  async fastDecision(
    params: HarnessFastDecisionParams & { signal?: AbortSignal },
    requestId?: string,
  ): Promise<HarnessFastDecisionResult> {
    const signal = this.#begin(params.batchId, params.signal, requestId);
    try {
      await this.reload();
      signal.throwIfAborted();
      const resolution = resolveFastDecisionPurpose(this.fastDecisionSettings(), params.purpose);
      if (resolution.status === "disabled") {
        throw new HostError("fast_decision_disabled", `Fast decision is disabled for ${params.purpose}`);
      }
      if (resolution.status === "unconfigured") {
        throw new HostError("fast_decision_unconfigured", "Fast decision is not configured");
      }
      const configured = resolution.binding;
      const endpoint = await this.#resolveProviderBinding(configured.providerId, configured.modelId, true, "decision");
      const requestEndpoint = configured.endpoint ?? endpoint.endpoint;
      if (
        configured.protocol !== params.protocol
        || configured.providerId !== params.providerId
        || configured.modelId !== params.modelId
        || endpoint.configurationId !== params.configurationId
        || requestEndpoint !== params.endpoint
      ) throw new HostError("fast_decision_binding_mismatch", "Fast decision request does not match the current frozen binding");
      signal.throwIfAborted();
      let result;
      try {
        const runtime = await this.#runtime();
        const native = runtime.getModelOfType("classifier", configured.providerId, configured.modelId);
        if (!runtime.getProvider(configured.providerId)?.classify) {
          runtime.registerProvider(configured.providerId, { classifiers: { "typesafe-system-one": { classify: classifySystemOne } } });
        }
        const nativeModel: ClassifierModel<ClassifierApi> = native ? { ...native, baseUrl: endpoint.baseUrl,
          ...(endpoint.classifierApi ? { api: endpoint.classifierApi } : {}) } : {
          type: "classifier", api: endpoint.classifierApi ?? "typesafe-system-one", provider: configured.providerId,
          id: configured.modelId, name: configured.modelId, baseUrl: endpoint.baseUrl,
          contextWindow: 0, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        result = await requestClassifier({
          nativeModel,
          classify: runtime.classify.bind(runtime),
          baseUrl: endpoint.baseUrl,
          ...(endpoint.apiKey === undefined ? {} : { apiKey: endpoint.apiKey }),
          ...(endpoint.headers ? { headers: endpoint.headers } : {}),
          ...(requestEndpoint ? { endpoint: requestEndpoint } : {}),
          model: configured.modelId,
          state: { goal: params.goal, materials: params.materials },
          questions: params.questions,
          ...(this.#fetchImpl ? { fetchImpl: this.#fetchImpl } : {}),
          signal,
        });
      } catch (error) {
        if (error instanceof ClassifierRequestError) {
          throw new HostError("fast_decision_invalid_request", error.message);
        }
        if (error instanceof ClassifierResponseError) {
          throw new HostError("fast_decision_provider_error", error.message);
        }
        throw error;
      }
      signal.throwIfAborted();
      return {
        batchId: params.batchId,
        providerId: configured.providerId,
        modelId: configured.modelId,
        ...(result.servedModelId ? { servedModelId: result.servedModelId } : {}),
        answers: result.answers,
        missing: result.missing,
        ...(result.usage ? { usage: result.usage } : {}),
      };
    } finally {
      this.#finish(params.batchId, requestId);
    }
  }

  /**
   * Generative memory-organizing completion (BC2). Unlike embed/rerank/
   * fastDecision this uses the real chat model slot `models.memoryOrganizer`
   * through ModelRuntime so provider protocols stay uniform; the Host supplies
   * the frozen selection and this side re-reads settings so a mid-flight
   * settings change is a mismatch, not a silent redirect.
   */
  async memoryOrganize(
    params: HarnessMemoryOrganizeParams & { signal?: AbortSignal },
    requestId?: string,
  ): Promise<HarnessMemoryOrganizeResult> {
    const signal = this.#begin(params.batchId, params.signal, requestId);
    try {
      await this.reload();
      signal.throwIfAborted();
      const configured = harnessFromSettings(this.#settings).models?.memoryOrganizer;
      if (!configured && params.modelSource !== "bot") {
        throw new HostError("memory_organizer_unconfigured", "Memory organizer model is not configured");
      }
      if (configured && (configured.providerId !== params.providerId || configured.modelId !== params.modelId
        || params.modelSource === "bot")) {
        throw new HostError(
          "memory_organizer_binding_mismatch",
          "Memory organize request does not match the current model binding",
        );
      }
      const runtime = this.#authRuntime;
      if (!runtime) {
        throw new HostError("memory_organizer_unavailable", "Memory organizer model runtime is unavailable");
      }
      const model = runtime.getModel(params.providerId, params.modelId);
      if (!model) {
        throw new HostError(
          "memory_organizer_unavailable",
          `Memory organizer model is unavailable: ${params.providerId}/${params.modelId}`,
        );
      }
      const maxOutputTokens = params.maxOutputTokens
        ?? memoryOrganizerOutputReservation(model.contextWindow, model.maxTokens);
      const estimatedInputTokens = estimateMemoryOrganizerInputTokens(params.system, params.prompt);
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > model.maxTokens
        || estimatedInputTokens + maxOutputTokens > model.contextWindow) {
        throw new HostError("memory_organizer_capacity",
          `Memory organizer request needs about ${estimatedInputTokens} input tokens plus ${maxOutputTokens} output tokens; model context is ${model.contextWindow}`);
      }
      const response = await runtime.completeSimple(model, {
        systemPrompt: params.system,
        messages: [{ role: "user", content: params.prompt, timestamp: Date.now() }],
      }, { reasoning: "minimal", toolChoice: "none", signal, maxTokens: maxOutputTokens });
      signal.throwIfAborted();
      if (response.stopReason === "error" || response.stopReason === "aborted" || response.stopReason === "length") {
        throw new HostError("memory_organizer_incomplete", `Memory organizer completion ended with ${response.stopReason}`);
      }
      const text = response.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!text) {
        throw new HostError("memory_organizer_empty", "Memory organizer returned no content");
      }
      const usage = response.usage;
      return {
        batchId: params.batchId,
        providerId: params.providerId,
        modelId: params.modelId,
        text,
        ...(usage ? { usage: { inputTokens: usage.input, outputTokens: usage.output } } : {}),
      };
    } finally {
      this.#finish(params.batchId, requestId);
    }
  }

  cancel(batchId: string): boolean {
    const active = this.#active.get(batchId);
    if (active) {
      active.controller.abort();
      return true;
    }
    const requestId = this.#reservedByBatch.get(batchId);
    const reservation = requestId ? this.#reservations.get(requestId) : undefined;
    if (reservation?.state === "reserved") {
      reservation.state = "cancelled";
      return true;
    }
    return false;
  }

  reserve(requestId: string, batchId: string): boolean {
    if (this.#disposed || this.#reservations.has(requestId)) return false;
    const rejected = this.#active.has(batchId) || this.#reservedByBatch.has(batchId);
    this.#reservations.set(requestId, { batchId, state: rejected ? "rejected" : "reserved" });
    if (!rejected) this.#reservedByBatch.set(batchId, requestId);
    return !rejected;
  }

  releaseReservation(requestId: string): void {
    const reservation = this.#reservations.get(requestId);
    if (!reservation) return;
    this.#reservations.delete(requestId);
    if (this.#reservedByBatch.get(reservation.batchId) === requestId) {
      this.#reservedByBatch.delete(reservation.batchId);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const active of this.#active.values()) active.controller.abort();
    this.#active.clear();
    this.#reservations.clear();
    this.#reservedByBatch.clear();
  }

  #begin(batchId: string, callerSignal?: AbortSignal, requestId?: string): AbortSignal {
    if (this.#disposed) throw new HostError("host_disposed", "Background inference is disposed");
    const reservation = requestId ? this.#reservations.get(requestId) : undefined;
    if (requestId) {
      if (!reservation || reservation.batchId !== batchId) {
        throw new HostError("inference_batch_unreserved", "Inference request reservation is missing or mismatched");
      }
      this.releaseReservation(requestId);
      if (reservation.state === "rejected") {
        throw new HostError("inference_batch_conflict", `Inference batch is already active or queued: ${batchId}`);
      }
    }
    if (this.#active.has(batchId)) {
      throw new HostError("inference_batch_conflict", `Inference batch is already active: ${batchId}`);
    }
    const controller = new AbortController();
    this.#active.set(batchId, { controller, ...(requestId ? { requestId } : {}) });
    if (reservation?.state === "cancelled") controller.abort();
    return callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
  }

  #finish(batchId: string, requestId?: string): void {
    const active = this.#active.get(batchId);
    if (active && active.requestId === requestId) this.#active.delete(batchId);
    if (requestId) this.releaseReservation(requestId);
  }

  async #runtime(): Promise<ModelRuntime> {
    if (this.#configRuntime) {
      await this.#providers.apply(this.#configRuntime, this.#cwd, false);
      return this.#configRuntime;
    }
    this.#configRuntimePromise ??= (async () => {
      const runtime = await ModelRuntime.create({
        allowModelNetwork: false,
        authPath: join(this.#agentDir, "auth.json"),
        modelsPath: join(this.#agentDir, "models.json"),
      });
      // ModelRuntime loaded the user layer; projectTrusted=false adds only operator config.
      await this.#providers.apply(runtime, this.#cwd, false);
      this.#configRuntime = runtime;
      return runtime;
    })();
    try { return await this.#configRuntimePromise; }
    finally { this.#configRuntimePromise = undefined; }
  }

  async #resolveProviderBinding(providerId: string, modelId: string, withAuth: boolean, kind: ProviderInferenceCapability): Promise<ResolvedProviderBinding> {
    const runtime = await this.#runtime();
    const provider = runtime.getProvider(providerId);
    const model = kind === "decision" ? runtime.getModelOfType("classifier", providerId, modelId) : runtime.getModel(providerId, modelId);
    let editable: Awaited<ReturnType<ProviderConfigurationManager["effectiveConfig"]>> | undefined;
    try { editable = await this.#providers.effectiveConfig(this.#cwd, providerId, false); } catch { /* built-in */ }
    const capabilities = await this.#providers.effectiveCapabilities(this.#cwd, providerId, false);
    const capability = capabilities?.[kind];
    if (capability?.enabled === false) throw new HostError("provider_capability_disabled", `Provider ${providerId} has disabled ${kind}`);
    const capabilityModel = capability?.models?.find(entry => entry.id === modelId);
    const baseUrl = capabilityModel?.baseUrl ?? capability?.baseUrl ?? (capability && kind !== "decision" ? undefined : model?.baseUrl) ?? editable?.baseUrl ?? provider?.baseUrl;
    if (!baseUrl) throw new HostError("provider_endpoint_missing", `Provider ${providerId} does not define a base URL`);
    const classifierApi = kind === "decision" ? (capabilityModel?.api ?? model?.api ?? "typesafe-system-one") as ClassifierApi : undefined;
    const configurationId = digest({
      providerId,
      modelId,
      baseUrl: credentialFreeUrl(baseUrl),
      api: classifierApi ?? capability?.protocol ?? model?.api ?? editable?.api,
      capability: capability?.protocol,
      endpoint: capability?.endpoint,
      credentialRef: capability?.credentialRef,
    });
    const resolved = { baseUrl, configurationId, ...(classifierApi ? { classifierApi } : {}), ...(capability?.endpoint ? { endpoint: capability.endpoint } : {}) };
    if (!withAuth) return resolved;
    const credentialRef = capability?.credentialRef ?? providerId;
    // Reuse only a live, non-persistent credential overlay from the chat
    // runtime. Resolve configured keys/headers in the project-free runtime.
    const runtimeKey = this.#authRuntime?.getProviderAuthStatus(credentialRef).source === "runtime"
      ? (await this.#authRuntime.getAuth(credentialRef))?.auth.apiKey : undefined;
    const auth = await runtime.getAuth(credentialRef, runtimeKey ? { apiKey: runtimeKey } : {});
    const apiKey = auth?.auth.apiKey;
    if (!auth || kind !== "decision" && !apiKey) throw new HostError("provider_auth_missing", `Provider ${credentialRef} has no credential`);
    const headers = stringHeaders(auth.auth.headers);
    return { ...resolved, ...(apiKey === undefined ? {} : { apiKey }), ...(headers ? { headers } : {}) };
  }
}

export function createBackgroundInferenceRuntime(options: BackgroundInferenceOptions): BackgroundInferenceRuntime {
  return new BackgroundInferenceRuntime(options);
}
