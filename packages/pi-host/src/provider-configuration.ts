import { createHostModelRuntime } from './host-model-runtime.js';
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ModelRuntime,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import * as systemOne from "@earendil-works/pi-ai/api/typesafe-system-one";
import * as cloudflareSystemOne from "@earendil-works/pi-ai/api/cloudflare-workers-ai-system-one";
import * as llamaClassify from "@earendil-works/pi-ai/api/llama-cpp-classify";
import type { Api, Model, CredentialStore } from "@earendil-works/pi-ai";
import {
  type ProviderConfigDetails,
  type ProviderConfigInput,
  type ProviderConfigLocation,
  type ProviderConfigScope,
  parseProviderConfigInput,
  parseProviderCapabilities,
  type ProviderCapabilities,
  ProviderConfigValidationError,
} from "@varin/protocol";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { HostError } from "./errors.js";

type JsonObject = Record<string, unknown>;
type ChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

interface ConfigDocument {
  content: string;
  data: JsonObject;
  exists: boolean;
  path: string;
}

interface RuntimeConfigurationState {
  appliedIds: Set<string>;
  baseRegistrations: Map<string, ProviderConfig>;
}

const EMPTY_CONFIG = "{\n  \"providers\": {}\n}\n";
const LOCK_RETRY_MS = 50;
const EDITABLE_PROVIDER_KEYS = ["api", "authHeader", "baseUrl", "models", "name", "capabilities"] as const;

function configurableDuration(name: string): number | undefined {
  const configured = process.env[name];
  if (configured === undefined || configured.trim() === "") return undefined;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number; 0 disables the cutoff`);
  }
  return parsed === 0 ? undefined : Math.floor(parsed);
}

const LOCK_TIMEOUT_MS = configurableDuration("VARIN_PROVIDER_CONFIG_LOCK_TIMEOUT_MS");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function isPathInside(base: string, candidate: string): boolean {
  const path = relative(base, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] =>
      entry[0].length > 0 && typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function mergeCompat(
  base: ChatModelConfig["compat"],
  override: unknown,
): ChatModelConfig["compat"] {
  if (!isObject(override)) return base;
  return { ...(isObject(base) ? base : {}), ...override } as ChatModelConfig["compat"];
}

function normalizeThinkingLevelMap(
  value: unknown,
  fallback: ChatModelConfig["thinkingLevelMap"],
): ChatModelConfig["thinkingLevelMap"] {
  if (!isObject(value)) return fallback;
  const result: NonNullable<ChatModelConfig["thinkingLevelMap"]> = {};
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const entry = value[level];
    if (entry === null || typeof entry === "string") {
      result[level] = entry;
    }
  }
  return Object.keys(result).length > 0 ? result : fallback;
}

function nativePromptCache(value: unknown, fallback?: Model<Api>["promptCache"]): Model<Api>["promptCache"] {
  if (value === undefined) return fallback;
  if (!isObject(value)) throw new HostError("provider_config_invalid", "promptCache must be an object");
  const result: NonNullable<Model<Api>["promptCache"]> = {};
  for (const tier of ["short", "long"] as const) {
    if (value[tier] === undefined) continue;
    const lifetime = finitePositive(value[tier]);
    if (lifetime === undefined) throw new HostError("provider_config_invalid", `promptCache.${tier} must be positive`);
    result[tier] = lifetime;
  }
  return result;
}

function nativeCostTiers(value: unknown, fallback?: Model<Api>["cost"]["tiers"]): Model<Api>["cost"]["tiers"] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value)) throw new HostError("provider_config_invalid", "cost.tiers must be an array");
  const fields = ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"] as const;
  return value.map(entry => {
    if (!isObject(entry) || fields.some(field => typeof entry[field] !== "number" || !Number.isFinite(entry[field]))) {
      throw new HostError("provider_config_invalid", "cost.tiers entries must contain finite thresholds and rates");
    }
    return Object.fromEntries(fields.map(field => [field, entry[field]])) as unknown as NonNullable<Model<Api>["cost"]["tiers"]>[number];
  });
}

function nativeSamplingParams(value: unknown, fallback?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (value === undefined) return fallback;
  if (!isObject(value)) throw new HostError("provider_config_invalid", "samplingParams must be an object");
  return { ...fallback, ...value };
}

function nativeInputLimits(value: unknown, fallback?: Model<Api>["inputLimits"]): Model<Api>["inputLimits"] {
  if (value === undefined) return fallback;
  if (!isObject(value)) throw new HostError("provider_config_invalid", "inputLimits must be an object");
  const images = isObject(value.images) ? value.images : undefined;
  return { ...fallback, ...value, ...(images ? { images: { ...fallback?.images, ...images,
    ...(isObject(images.resize) ? { resize: { ...fallback?.images?.resize, ...images.resize } } : {}),
  } } : {}) } as Model<Api>["inputLimits"];
}

function modelFromLayer(
  providerId: string,
  raw: JsonObject,
  provider: JsonObject,
  fallback: ProviderModelConfig | undefined,
): ProviderModelConfig {
  const id = safeString(raw.id);
  if (!id) throw new HostError("provider_config_invalid", `Provider ${providerId} has a model without an id`);
  const api = safeString(raw.api) ?? safeString(provider.api) ?? fallback?.api;
  const baseUrl =
    safeString(raw.baseUrl) ?? safeString(provider.baseUrl) ?? fallback?.baseUrl;
  if (!api) {
    throw new HostError(
      "provider_config_invalid",
      `Provider ${providerId}, model ${id} does not define an API`,
    );
  }
  if (!baseUrl) {
    throw new HostError(
      "provider_config_invalid",
      `Provider ${providerId}, model ${id} does not define a base URL`,
    );
  }
  const rawCost = isObject(raw.cost) ? raw.cost : {};
  const fallbackCost = fallback?.cost ?? { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };
  const tiers = nativeCostTiers(rawCost.tiers, fallbackCost.tiers);
  const modelInput = Array.isArray(raw.input)
    ? [...new Set(raw.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image"))]
    : undefined;
  const type = raw.type ?? fallback?.type ?? "chat";
  if (type !== "chat" && type !== "image" && type !== "classifier") {
    throw new HostError("provider_config_invalid", `Provider ${providerId}, model ${id} has an unsupported model type`);
  }
  const sharedHeaders = stringRecord(raw.headers) ?? fallback?.headers;
  const shared = {
    api, baseUrl, id, name: safeString(raw.name) ?? fallback?.name ?? id,
    input: modelInput && modelInput.length > 0 ? modelInput : (fallback?.input ?? ["text"]),
    cost: {
      ...fallbackCost,
      ...(tiers === undefined ? {} : { tiers }),
      cacheRead: finiteNonNegative(rawCost.cacheRead) ?? fallbackCost.cacheRead,
      cacheWrite: finiteNonNegative(rawCost.cacheWrite) ?? fallbackCost.cacheWrite,
      input: finiteNonNegative(rawCost.input) ?? fallbackCost.input,
      output: finiteNonNegative(rawCost.output) ?? fallbackCost.output,
    },
    ...(sharedHeaders ? { headers: sharedHeaders } : {}),
    ...(isObject(raw.inputLimits) ? { inputLimits: raw.inputLimits } : fallback?.inputLimits ? { inputLimits: fallback.inputLimits } : {}),
  };
  if (type === "image") return {
    ...shared, type, output: Array.isArray(raw.output) ? raw.output as Array<"text" | "image">
      : fallback?.type === "image" ? fallback.output : ["image"],
  } as ProviderModelConfig;
  if (type === "classifier") return {
    ...shared, type, contextWindow: finitePositive(raw.contextWindow)
      ?? (fallback?.type === "classifier" ? fallback.contextWindow : undefined) ?? 0,
  } as ProviderModelConfig;
  const chatFallback = fallback?.type === "image" || fallback?.type === "classifier" ? undefined : fallback;
  const promptCache = nativePromptCache(raw.promptCache, chatFallback?.id === id ? chatFallback.promptCache : undefined);
  const samplingParams = nativeSamplingParams(raw.samplingParams, chatFallback?.id === id ? chatFallback.samplingParams : undefined);
  const providerCompat = mergeCompat(undefined, provider.compat);
  const compat = mergeCompat(mergeCompat(chatFallback?.compat, providerCompat), raw.compat);
  const headers = stringRecord(raw.headers) ?? fallback?.headers;
  const thinkingLevelMap = normalizeThinkingLevelMap(
    raw.thinkingLevelMap,
    chatFallback?.thinkingLevelMap,
  );
  return {
    ...shared,
    type: "chat",
    ...(compat === undefined ? {} : { compat }),
    contextWindow: finitePositive(raw.contextWindow) ?? chatFallback?.contextWindow ?? 128_000,
    cost: {
      cacheRead: finiteNonNegative(rawCost.cacheRead) ?? fallbackCost.cacheRead,
      cacheWrite: finiteNonNegative(rawCost.cacheWrite) ?? fallbackCost.cacheWrite,
      input: finiteNonNegative(rawCost.input) ?? fallbackCost.input,
      output: finiteNonNegative(rawCost.output) ?? fallbackCost.output,
      ...(shared.cost.tiers === undefined ? {} : { tiers: shared.cost.tiers }),
    },
    ...(headers === undefined ? {} : { headers }),
    id,
    input: modelInput && modelInput.length > 0 ? modelInput : (fallback?.input ?? ["text"]),
    maxTokens: finitePositive(raw.maxTokens) ?? chatFallback?.maxTokens ?? 16_384,
    name: safeString(raw.name) ?? fallback?.name ?? id,
    reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : (chatFallback?.reasoning ?? false),
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(promptCache === undefined ? {} : { promptCache }),
    ...(samplingParams === undefined ? {} : { samplingParams }),
  };
}

function applyModelOverride(model: ProviderModelConfig, value: unknown): ProviderModelConfig {
  if (!isObject(value)) return model;
  const cost = isObject(value.cost) ? value.cost : {};
  const tiers = nativeCostTiers(cost.tiers, model.cost.tiers);
  const inputLimits = nativeInputLimits(value.inputLimits, model.inputLimits);
  const modelInput = Array.isArray(value.input)
    ? [...new Set(value.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image"))]
    : undefined;
  if (model.type === "image" || model.type === "classifier") return {
    ...model,
    ...(safeString(value.name) ? { name: safeString(value.name)! } : {}),
    input: modelInput && modelInput.length > 0 ? modelInput : model.input,
    ...(inputLimits === undefined ? {} : { inputLimits }),
    cost: { ...model.cost, ...cost,
      ...(tiers === undefined ? {} : { tiers }) },
    ...(model.type === "classifier" && finitePositive(value.contextWindow) ? { contextWindow: finitePositive(value.contextWindow)! } : {}),
  } as ProviderModelConfig;
  const promptCache = value.promptCache === undefined ? model.promptCache
    : { ...model.promptCache, ...nativePromptCache(value.promptCache) };
  const samplingParams = nativeSamplingParams(value.samplingParams, model.samplingParams);
  return {
    ...model,
    compat: mergeCompat(model.compat, value.compat),
    ...(inputLimits === undefined ? {} : { inputLimits }),
    ...(promptCache === undefined ? {} : { promptCache }),
    ...(samplingParams === undefined ? {} : { samplingParams }),
    contextWindow: finitePositive(value.contextWindow) ?? model.contextWindow,
    cost: {
      ...model.cost,
      cacheRead: finiteNonNegative(cost.cacheRead) ?? model.cost.cacheRead,
      cacheWrite: finiteNonNegative(cost.cacheWrite) ?? model.cost.cacheWrite,
      input: finiteNonNegative(cost.input) ?? model.cost.input,
      output: finiteNonNegative(cost.output) ?? model.cost.output,
      ...(tiers === undefined ? {} : { tiers }),
    },
    input: modelInput && modelInput.length > 0 ? modelInput : model.input,
    maxTokens: finitePositive(value.maxTokens) ?? model.maxTokens,
    name: safeString(value.name) ?? model.name,
    reasoning: typeof value.reasoning === "boolean" ? value.reasoning : model.reasoning,
    thinkingLevelMap: normalizeThinkingLevelMap(value.thinkingLevelMap, model.thinkingLevelMap),
  };
}

function runtimeProviderConfig(
  runtime: ModelRuntime,
  providerId: string,
  value: unknown,
): ProviderConfig {
  if (!isObject(value)) {
    throw new HostError("provider_config_invalid", `Provider ${providerId} must be an object`);
  }
  const currentModels = runtime.getAllModels(providerId).map((model) => ({ ...model })) as ProviderModelConfig[];
  parseProviderCapabilities(value.capabilities);
  let models: ProviderModelConfig[] | undefined;
  if (Array.isArray(value.models) || isObject(value.modelOverrides)) {
    models = currentModels;
    for (const rawModel of Array.isArray(value.models) ? value.models : []) {
      if (!isObject(rawModel)) {
        throw new HostError(
          "provider_config_invalid",
          `Provider ${providerId} contains a non-object model definition`,
        );
      }
      const id = safeString(rawModel.id);
      const type = rawModel.type ?? "chat";
      const existingIndex = id === undefined ? -1 : models.findIndex((model) => model.id === id && (model.type ?? "chat") === type);
      const fallback = existingIndex >= 0 ? models[existingIndex] : models.find(model => (model.type ?? "chat") === type);
      const normalized = modelFromLayer(providerId, rawModel, value, fallback);
      if (existingIndex >= 0) models[existingIndex] = normalized;
      else models.push(normalized);
    }
    if (isObject(value.modelOverrides)) {
      const overrides = value.modelOverrides;
      models = models.map((model) => applyModelOverride(model, overrides[model.id]));
    }
  }
  const name = safeString(value.name);
  const baseUrl = safeString(value.baseUrl);
  const api = safeString(value.api);
  const apiKey = safeString(value.apiKey);
  const headers = stringRecord(value.headers);
  return {
    ...(api === undefined ? {} : { api }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(typeof value.authHeader === "boolean" ? { authHeader: value.authHeader } : {}),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(headers === undefined ? {} : { headers }),
    ...(models === undefined ? {} : { models }),
    ...(name === undefined ? {} : { name }),
  };
}

function providerRecord(document: ConfigDocument, providerId: string): JsonObject | undefined {
  const providers = isObject(document.data.providers) ? document.data.providers : undefined;
  if (!providers || !Object.prototype.hasOwnProperty.call(providers, providerId)) return undefined;
  const value = providers?.[providerId];
  return isObject(value) ? value : undefined;
}

function capabilitiesFromDocuments(documents: Partial<Record<ProviderConfigScope, ConfigDocument>>, providerId: string): ProviderCapabilities | undefined {
  let result: ProviderCapabilities | undefined;
  for (const scope of ["user", "project", "custom"] as const) {
    const document = documents[scope];
    const value = document && providerRecord(document, providerId);
    const capabilities = value && parseProviderCapabilities(value.capabilities);
    if (capabilities) result = { ...result, ...capabilities };
  }
  return result;
}

function browserSafeConfig(providerId: string, value: JsonObject): ProviderConfigInput | undefined {
  const models = Array.isArray(value.models)
    ? value.models.filter(isObject).map((model) => {
        const cost = isObject(model.cost) ? model.cost : undefined;
        return {
          ...(model.type === undefined ? {} : { type: model.type }),
          ...(Array.isArray(model.output) ? { output: model.output } : {}),
          ...(safeString(model.api) === undefined ? {} : { api: safeString(model.api) }),
          ...(safeString(model.baseUrl) === undefined
            ? {}
            : { baseUrl: safeString(model.baseUrl) }),
          ...(finitePositive(model.contextWindow) === undefined
            ? {}
            : { contextWindow: finitePositive(model.contextWindow) }),
          ...(cost === undefined
            ? {}
            : {
                cost: {
                  ...(finiteNonNegative(cost.cacheRead) === undefined
                    ? {}
                    : { cacheRead: finiteNonNegative(cost.cacheRead) }),
                  ...(finiteNonNegative(cost.cacheWrite) === undefined
                    ? {}
                    : { cacheWrite: finiteNonNegative(cost.cacheWrite) }),
                  ...(finiteNonNegative(cost.input) === undefined
                    ? {}
                    : { input: finiteNonNegative(cost.input) }),
                  ...(finiteNonNegative(cost.output) === undefined
                    ? {}
                    : { output: finiteNonNegative(cost.output) }),
                },
              }),
          id: model.id,
          ...(Array.isArray(model.input) ? { input: model.input } : {}),
          ...(finitePositive(model.maxTokens) === undefined
            ? {}
            : { maxTokens: finitePositive(model.maxTokens) }),
          ...(safeString(model.name) === undefined ? {} : { name: safeString(model.name) }),
          ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
          ...(isObject(model.thinkingLevelMap)
            ? { thinkingLevelMap: model.thinkingLevelMap }
            : {}),
        };
      })
    : undefined;
  try {
    return parseProviderConfigInput({
      api: value.api,
      authHeader: value.authHeader,
      baseUrl: value.baseUrl,
      id: providerId,
      ...(models === undefined ? {} : { models }),
      name: value.name,
      capabilities: value.capabilities,
    });
  } catch (error) {
    if (error instanceof ProviderConfigValidationError) return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function readDocument(path: string): Promise<ConfigDocument> {
  let content: string;
  let exists = true;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw new HostError("provider_config_read_failed", `Failed to read ${path}`, { cause: error });
    }
    content = EMPTY_CONFIG;
    exists = false;
  }
  const errors: ParseError[] = [];
  const parsed = parse(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !isObject(parsed)) {
    const first = errors[0];
    const issue = first ? `${printParseErrorCode(first.error)} at offset ${first.offset}` : "root is not an object";
    throw new HostError("provider_config_invalid", `Invalid models configuration (${issue}): ${path}`);
  }
  if (parsed.providers !== undefined && !isObject(parsed.providers)) {
    throw new HostError("provider_config_invalid", `models.json providers must be an object: ${path}`);
  }
  return { content, data: parsed, exists, path };
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.varin.lock`;
  const started = Date.now();
  for (;;) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if (handle) {
      const token = randomUUID();
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }),
          "utf8",
        );
        return async () => {
          await handle.close();
          try {
            const owner = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
            if (isObject(owner) && owner.token === token) {
              await rm(lockPath, { force: true, recursive: true });
            }
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(lockPath, { force: true, recursive: true }).catch(() => undefined);
        throw error;
      }
    }
    let removeAbandoned = false;
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
      removeAbandoned = !isObject(owner) || !processIsAlive(Number(owner.pid));
    } catch (readError) {
      if (errorCode(readError) === "ENOENT") continue;
      const info = await stat(lockPath).catch((statError: unknown) => {
        if (errorCode(statError) === "ENOENT") return undefined;
        throw statError;
      });
      if (!info) continue;
      removeAbandoned = Date.now() - info.mtimeMs > 2_000;
    }
    if (removeAbandoned) {
      const abandonedPath = `${lockPath}.abandoned.${process.pid}.${randomUUID()}`;
      try {
        await rename(lockPath, abandonedPath);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw error;
      }
      await rm(abandonedPath, { force: true, recursive: true });
      continue;
    }
    if (LOCK_TIMEOUT_MS !== undefined && Date.now() - started >= LOCK_TIMEOUT_MS) {
      throw new HostError("provider_config_locked", `Timed out waiting for models configuration: ${path}`, {
        retryable: true,
      });
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    await chmod(path, 0o600);
  } finally {
    await rm(tempPath, { force: true });
  }
}

/** Enumerate configured native connections without resolving helpers or creating binding metadata. */
export async function configuredCredentialModels(path: string, models: readonly { provider: string; id: string }[]): Promise<Set<string>> {
  const document = await readDocument(path);
  const configured = new Set<string>();
  const hasHeaders = (value: unknown) => isObject(value) && Object.keys(value).length > 0;
  for (const model of models) {
    const entry = providerRecord(document, model.provider);
    if (!entry) continue;
    const override = isObject(entry.modelOverrides) ? entry.modelOverrides[model.id] : undefined;
    const definition = Array.isArray(entry.models) ? entry.models.find(value => isObject(value) && value.id === model.id) : undefined;
    if (entry.apiKey !== undefined || hasHeaders(entry.headers)
      || (isObject(override) && hasHeaders(override.headers))
      || (isObject(definition) && hasHeaders(definition.headers))) configured.add(JSON.stringify([model.provider, model.id]));
  }
  return configured;
}

/** Nonsecret configured-key identity. Uses the existing models-file lock and JSONC writer.
 * The file revision deliberately invalidates configured bindings after ANY models-file edit.
 * The private owner receives the expression for dispatch resolution; it is never hashed or
 * copied to the credential store, public model metadata, or durable native history.
 */
export async function configuredCredentialBinding(path: string, providerId: string,
  options: { includeKey?: boolean; modelId?: string } = {},
): Promise<{ handle: string; revision: string; key?: string; headers: Record<string, string>; generatedAuthorization: boolean } | undefined> {
  if (!await pathExists(path)) return undefined;
  const release = await acquireLock(path);
  try {
    const document = await readDocument(path);
    const entry = providerRecord(document, providerId);
    if (!entry) return undefined;
    const key = options.includeKey === false ? undefined : entry.apiKey;
    if (key !== undefined && (typeof key !== "string" || !key)) throw new Error("configured-key-invalid");
    const headers: Record<string, string> = Object.create(null);
    const mergeHeaders = (value: unknown) => {
      if (value === undefined) return;
      if (!isObject(value)) throw new Error("configured-headers-invalid");
      for (const [name, expression] of Object.entries(value)) {
        if (typeof expression !== "string") throw new Error("configured-headers-invalid");
        headers[name.toLowerCase()] = expression;
      }
    };
    mergeHeaders(entry.headers);
    // Include configured values in source identity even when authHeader supersedes them.
    // Model headers are applied after the generated Authorization header by the SDK.
    let generatedAuthorization = entry.authHeader === true;
    if (options.modelId) {
      const overrides = isObject(entry.modelOverrides) ? entry.modelOverrides[options.modelId] : undefined;
      const overrideHeaders = isObject(overrides) ? overrides.headers : undefined;
      mergeHeaders(overrideHeaders);
      if (isObject(overrideHeaders) && Object.keys(overrideHeaders).some(name => name.toLowerCase() === "authorization")) generatedAuthorization = false;
      const definition = Array.isArray(entry.models) ? entry.models.find(model => isObject(model) && model.id === options.modelId) : undefined;
      const modelHeaders = isObject(definition) ? definition.headers : undefined;
      mergeHeaders(modelHeaders);
      if (isObject(modelHeaders) && Object.keys(modelHeaders).some(name => name.toLowerCase() === "authorization")) generatedAuthorization = false;
    }
    if (key === undefined && Object.keys(headers).length === 0) return undefined;
    let binding = entry.$varinCredentialBinding;
    if (binding === undefined) {
      binding = { schema: 1, handle: randomUUID() };
      const content = applyEdits(document.content, modify(document.content,
        ["providers", providerId, "$varinCredentialBinding"], binding,
        { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
      await atomicWrite(path, content);
    }
    if (!isObject(binding) || binding.schema !== 1 || typeof binding.handle !== "string" || !binding.handle) {
      throw new Error("configured-credential-metadata-invalid");
    }
    // These are filesystem revision facts, never a digest of credentials. ctime also catches
    // in-place edits which restore mtime; inode identifies atomic replacements across restart.
    const info = await stat(path, { bigint: true });
    return { handle: binding.handle, revision: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":"), ...(typeof key === "string" ? { key } : {}), headers, generatedAuthorization };
  } finally { await release(); }
}

async function updateProviderEntry(
  path: string,
  providerId: string,
  value: JsonObject | undefined,
  replaceKeys: readonly string[] = [],
): Promise<void> {
  await mkdir(resolve(path, ".."), { mode: 0o700, recursive: true });
  const release = await acquireLock(path);
  try {
    const document = await readDocument(path);
    let content = document.content;
    if (!isObject(document.data.providers)) {
      content = applyEdits(
        content,
        modify(content, ["providers"], {}, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      );
    }
    const current = providerRecord(document, providerId);
    if (value && current) {
      // The form edits a credential-blind subset. Keep native fields it cannot
      // edit (headers, inputLimits, compatibility, cache metadata) on matching
      // model types; removal and replacement of the editable fields still work.
      if (Array.isArray(value.models) && Array.isArray(current.models)) {
        const currentModels = current.models;
        const editable = ["api", "baseUrl", "contextWindow", "cost", "id", "input", "maxTokens", "name", "reasoning", "thinkingLevelMap", "type", "output"];
        value = { ...value, models: value.models.map(model => {
          if (!isObject(model)) return model;
          const prior = currentModels.find((entry: unknown) => isObject(entry) && entry.id === model.id && (entry.type ?? "chat") === (model.type ?? "chat"));
          if (!isObject(prior)) return model;
          const merged = { ...prior };
          for (const key of editable) delete merged[key];
          return { ...merged, ...model, ...(isObject(prior.cost) && isObject(model.cost) ? { cost: { ...prior.cost, ...model.cost } } : {}) };
        }) };
      }
      for (const key of replaceKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key) || !Object.prototype.hasOwnProperty.call(current, key)) {
          continue;
        }
        content = applyEdits(
          content,
          modify(content, ["providers", providerId, key], undefined, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          }),
        );
      }
      for (const [key, entry] of Object.entries(value)) {
        if (JSON.stringify(current[key]) === JSON.stringify(entry)) continue;
        content = applyEdits(
          content,
          modify(content, ["providers", providerId, key], entry, {
            formattingOptions: { insertSpaces: true, tabSize: 2 },
          }),
        );
      }
    } else {
      content = applyEdits(
        content,
        modify(content, ["providers", providerId], value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      );
    }
    await atomicWrite(path, content.endsWith("\n") ? content : `${content}\n`);
  } finally {
    await release();
  }
}

export interface ProviderConfigurationManagerOptions {
  agentDir: string;
  customConfigPath?: string;
  /** Existing Application Host credential authority, never a second store. */
  credentials?: CredentialStore;
}

export class ProviderConfigurationManager {
  readonly #agentDir: string;
  readonly #customPath: string | undefined;
  readonly #credentials: CredentialStore | undefined;
  readonly #runtimeStates = new WeakMap<ModelRuntime, RuntimeConfigurationState>();
  #inferenceCatalog: { key: string; runtime: Promise<ModelRuntime> } | undefined;

  constructor(options: ProviderConfigurationManagerOptions) {
    this.#agentDir = resolve(options.agentDir);
    this.#credentials = options.credentials;
    const configuredPath = options.customConfigPath ?? process.env.VARIN_MODELS_CONFIG;
    this.#customPath = configuredPath ? resolve(configuredPath) : undefined;
  }

  async apply(runtime: ModelRuntime, cwd: string, projectTrusted: boolean): Promise<string[]> {
    const warnings: string[] = [];
    let state = this.#runtimeStates.get(runtime);
    if (!state) {
      state = { appliedIds: new Set(), baseRegistrations: new Map() };
      for (const providerId of runtime.getRegisteredProviderIds()) {
        const config = runtime.getRegisteredProviderConfig(providerId);
        if (config) state.baseRegistrations.set(providerId, config);
      }
      this.#runtimeStates.set(runtime, state);
    } else {
      const currentIds = new Set(runtime.getRegisteredProviderIds());
      for (const providerId of currentIds) {
        if (state.appliedIds.has(providerId)) continue;
        const config = runtime.getRegisteredProviderConfig(providerId);
        if (config) state.baseRegistrations.set(providerId, config);
      }
      for (const providerId of state.baseRegistrations.keys()) {
        if (!state.appliedIds.has(providerId) && !currentIds.has(providerId)) {
          state.baseRegistrations.delete(providerId);
        }
      }
    }
    for (const providerId of state.appliedIds) {
      runtime.unregisterProvider(providerId);
      const base = state.baseRegistrations.get(providerId);
      if (base) runtime.registerProvider(providerId, base);
    }
    state.appliedIds.clear();
    await runtime.refresh({ allowNetwork: false });
    const documents: Partial<Record<ProviderConfigScope, ConfigDocument>> = {};
    for (const scope of ["user", "project", "custom"] as const) {
      if (scope === "project" && !projectTrusted) continue;
      const path = this.#pathForScope(scope, cwd);
      if (!path) continue;
      let document: ConfigDocument;
      try {
        await this.#assertSafePath(scope, cwd, path, false);
        document = await readDocument(path);
      } catch (error) {
        if (error instanceof HostError && error.code === "provider_config_read_failed") {
          warnings.push(error.message);
          continue;
        }
        if (error instanceof HostError && error.code === "provider_config_invalid") {
          warnings.push(error.message);
          continue;
        }
        if (errorCode(error) === "ENOENT") continue;
        warnings.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (!document.exists) continue;
      documents[scope] = document;
      if (scope === "user") continue; // Native Pi loads the user's api/models/auth fields.
      const providers = isObject(document.data.providers) ? document.data.providers : {};
      for (const [providerId, value] of Object.entries(providers)) {
        try {
          runtime.registerProvider(providerId, runtimeProviderConfig(runtime, providerId, value));
          state.appliedIds.add(providerId);
        } catch (error) {
          warnings.push(
            `Failed to apply ${scope} provider ${providerId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    // Apply the effective chat choice after all native layers. Disabling never
    // deletes model definitions, and a higher-scope enable can restore them.
    const configuredIds = new Set(Object.values(documents).flatMap(document => Object.keys(isObject(document.data.providers) ? document.data.providers : {})));
    for (const providerId of configuredIds) {
      try {
        const capabilities = capabilitiesFromDocuments(documents, providerId);
        const models = runtime.getAllModels(providerId).map(model => ({ ...model })) as ProviderModelConfig[];
        for (const entry of capabilities?.decision?.enabled === false ? [] : capabilities?.decision?.models ?? []) {
          if (models.some(model => model.type === "classifier" && model.id === entry.id)) continue;
          const baseUrl = entry.baseUrl ?? capabilities?.decision?.baseUrl ?? runtime.getProvider(providerId)?.baseUrl;
          models.push({ ...entry, type: "classifier", api: entry.api ?? "typesafe-system-one",
            name: entry.name ?? entry.id, contextWindow: entry.contextWindow ?? 0, input: entry.input ?? ["text"],
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, ...entry.cost },
            ...(baseUrl ? { baseUrl } : {}),
          } as ProviderModelConfig);
        }
        const classifiers = models.some(model => model.type === "classifier") ? {
          "typesafe-system-one": systemOne,
          "cloudflare-workers-ai-system-one": cloudflareSystemOne,
          "llama-cpp-classify": llamaClassify,
          ...runtime.getRegisteredProviderConfig(providerId)?.classifiers,
        } : undefined;
        if (classifiers || capabilities?.chat === false) {
          runtime.registerProvider(providerId, {
            ...(classifiers ? { classifiers } : {}),
            models: capabilities?.chat === false ? models.filter(model => model.type === "image" || model.type === "classifier") : models,
          });
          state.appliedIds.add(providerId);
        }
      } catch (error) {
        warnings.push(`Failed to apply provider capabilities for ${providerId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await runtime.refresh({ allowNetwork: false });
    return warnings;
  }

  async getDetails(
    runtime: ModelRuntime,
    cwd: string,
    providerId: string,
    projectTrusted: boolean,
  ): Promise<ProviderConfigDetails> {
    const normalizedId = this.#providerId(providerId);
    const documents = await this.#documents(cwd, projectTrusted);
    const locations = await this.#locations(cwd, documents, normalizedId, projectTrusted);
    let effectiveScope: ProviderConfigScope | undefined;
    let effective: JsonObject | undefined;
    for (const scope of ["custom", "project", "user"] as const) {
      const document = documents[scope];
      if (!document) continue;
      const candidate = providerRecord(document, normalizedId);
      if (candidate) {
        effectiveScope = scope;
        effective = candidate;
        break;
      }
    }
    const status = runtime.getProviderAuthStatus(normalizedId);
    const config = effective ? browserSafeConfig(normalizedId, effective) : undefined;
    const backgroundDocuments = { ...documents };
    delete backgroundDocuments.project;
    let capabilities = capabilitiesFromDocuments(backgroundDocuments, normalizedId);
    // Use the native typed catalog, composed without project input. A project
    // provider override must not redirect background inference suggestions.
    const catalog = await this.inferenceRuntime(cwd);
    const classifiers = catalog.getModelsOfType("classifier", normalizedId);
    if (classifiers.length) {
      const declared = capabilities?.decision;
      const models = [...(declared?.models ?? [])];
      for (const model of classifiers) {
        if (!models.some(entry => entry.id === model.id)) models.push({
          id: model.id, name: model.name, api: model.api,
          contextWindow: model.contextWindow,
        });
      }
      capabilities = { ...capabilities, decision: { protocol: "pi-classifier", ...declared, models } };
    }
    return {
      auth: {
        configured: status.configured,
        ...(status.label === undefined ? {} : { label: status.label }),
        ...(status.source === undefined ? {} : { source: status.source }),
      },
      ...(config === undefined ? {} : { config }),
      ...(capabilities === undefined ? {} : { capabilities }),
      ...(effectiveScope === undefined ? {} : { effectiveScope }),
      locations,
      providerId: normalizedId,
    };
  }

  /** Catalog and configured credentials for inference, without project overrides. */
  async inferenceRuntime(cwd: string): Promise<ModelRuntime> {
    const documents = await this.#documents(cwd, false);
    const key = JSON.stringify([documents.user?.data, documents.custom?.data]);
    if (this.#inferenceCatalog?.key !== key) {
      const catalog = (this.#credentials ? ModelRuntime.create : createHostModelRuntime)({
        allowModelNetwork: false,
        ...(this.#credentials ? { credentials: this.#credentials } : {}),
        authPath: join(this.#agentDir, "auth.json"),
        modelsPath: join(this.#agentDir, "models.json"),
      }).then(async native => { await this.apply(native, cwd, false); return native; });
      this.#inferenceCatalog = { key, runtime: catalog };
      void catalog.catch(() => {
        if (this.#inferenceCatalog?.runtime === catalog) this.#inferenceCatalog = undefined;
      });
    }
    return this.#inferenceCatalog.runtime;
  }

  /** Private auth-source facts for Host leases. Never return through browser/RPC metadata.
   * Endpoint/model selection is deliberately excluded: changing routing retires a binding,
   * whereas changing a credential source revokes it. No source is hashed or persisted.
   */
  async inferenceCredentialSources(cwd: string, providerId: string): Promise<{
    configured: boolean;
    sources: unknown[];
    revision: string;
  }> {
    const documents = await this.#documents(cwd, false);
    const sources: unknown[] = [];
    const revisions: string[] = [];
    for (const scope of ["user", "custom"] as const) {
      const document = documents[scope];
      const value = document && providerRecord(document, this.#providerId(providerId));
      if (!value) continue;
      sources.push({ scope, apiKey: value.apiKey, headers: value.headers, authHeader: value.authHeader });
      const info = await stat(document!.path, { bigint: true });
      revisions.push([scope, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'));
    }
    return { configured: sources.length > 0, sources, revision: revisions.join('|') };
  }

  async upsert(
    runtime: ModelRuntime,
    cwd: string,
    scope: ProviderConfigScope,
    input: ProviderConfigInput,
    projectTrusted: boolean,
  ): Promise<ProviderConfigDetails> {
    this.#assertProjectScopeTrusted(scope, projectTrusted);
    const config = parseProviderConfigInput(input);
    const path = this.#requiredPathForScope(scope, cwd);
    await this.#assertSafePath(scope, cwd, path, true);
    const next: JsonObject = {
      ...(config.api === undefined ? {} : { api: config.api }),
      ...(config.authHeader === undefined ? {} : { authHeader: config.authHeader }),
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(config.models === undefined ? {} : { models: config.models }),
      ...(config.name === undefined ? {} : { name: config.name }),
      ...(config.capabilities === undefined ? {} : { capabilities: config.capabilities }),
    };
    // Validate against the currently composed native Pi catalog before touching disk. This keeps
    // partial overrides available while preventing a malformed new model from being silently saved
    // and then skipped during the next catalog refresh.
    runtimeProviderConfig(runtime, config.id, next);
    await updateProviderEntry(path, config.id, next, EDITABLE_PROVIDER_KEYS);
    await this.apply(runtime, cwd, projectTrusted);
    return this.getDetails(runtime, cwd, config.id, projectTrusted);
  }

  async delete(
    runtime: ModelRuntime,
    cwd: string,
    providerId: string,
    scope: ProviderConfigScope | "all",
    projectTrusted: boolean,
  ): Promise<ProviderConfigDetails> {
    const normalizedId = this.#providerId(providerId);
    const scopes: ProviderConfigScope[] =
      scope === "all" ? ["user", "project", "custom"] : [scope];
    for (const targetScope of scopes) {
      this.#assertProjectScopeTrusted(targetScope, projectTrusted);
    }
    for (const targetScope of scopes) {
      const path = this.#pathForScope(targetScope, cwd);
      if (!path) continue;
      await this.#assertSafePath(targetScope, cwd, path, true);
      if (!(await pathExists(path))) continue;
      await updateProviderEntry(path, normalizedId, undefined);
    }
    await this.apply(runtime, cwd, projectTrusted);
    return this.getDetails(runtime, cwd, normalizedId, projectTrusted);
  }

  async effectiveConfig(
    cwd: string,
    providerId: string,
    projectTrusted: boolean,
  ): Promise<ProviderConfigInput> {
    const normalizedId = this.#providerId(providerId);
    const documents = await this.#documents(cwd, projectTrusted);
    for (const scope of ["custom", "project", "user"] as const) {
      const document = documents[scope];
      const value = document ? providerRecord(document, normalizedId) : undefined;
      const config = value ? browserSafeConfig(normalizedId, value) : undefined;
      if (config) return config;
    }
    throw new HostError(
      "provider_config_not_found",
      `No editable Pi provider configuration exists for ${normalizedId}`,
    );
  }

  /** Same configuration authority and scope order as native providers; no project layer for background calls. */
  async effectiveCapabilities(cwd: string, providerId: string, projectTrusted: boolean): Promise<ProviderCapabilities | undefined> {
    const documents = await this.#documents(cwd, projectTrusted);
    return capabilitiesFromDocuments(documents, this.#providerId(providerId));
  }

  #providerId(value: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new HostError("invalid_params", "providerId is invalid");
    }
    return normalized;
  }

  #assertProjectScopeTrusted(scope: ProviderConfigScope, projectTrusted: boolean): void {
    if (scope === "project" && !projectTrusted) {
      throw new HostError(
        "project_not_trusted",
        "Project is not trusted; refusing to access project provider configuration",
      );
    }
  }

  #pathForScope(scope: ProviderConfigScope, cwd: string): string | undefined {
    if (scope === "user") return join(this.#agentDir, "models.json");
    if (scope === "project") return join(resolve(cwd), ".pi", "models.json");
    return this.#customPath;
  }

  #requiredPathForScope(scope: ProviderConfigScope, cwd: string): string {
    const path = this.#pathForScope(scope, cwd);
    if (!path) {
      throw new HostError(
        "provider_config_scope_unavailable",
        scope === "custom"
          ? "VARIN_MODELS_CONFIG is not configured"
          : `Provider scope ${scope} is unavailable`,
      );
    }
    return path;
  }

  async #assertSafePath(
    scope: ProviderConfigScope,
    cwd: string,
    path: string,
    forWrite: boolean,
  ): Promise<void> {
    if (scope === "custom") return;
    const base = scope === "project" ? resolve(cwd) : this.#agentDir;
    if (!isPathInside(base, resolve(path))) {
      throw new HostError("provider_config_path_denied", `Provider configuration escapes ${base}`);
    }
    if (!(await pathExists(base))) {
      if (!forWrite || scope === "project") {
        throw new HostError("provider_config_path_denied", `Provider configuration root is missing: ${base}`);
      }
      await mkdir(base, { mode: 0o700, recursive: true });
    }
    const baseReal = await realpath(base);
    const parent = resolve(path, "..");
    if (await pathExists(parent)) {
      const parentInfo = await lstat(parent);
      if (parentInfo.isSymbolicLink()) {
        throw new HostError("provider_config_path_denied", `Provider configuration parent is a symlink: ${parent}`);
      }
      const parentReal = await realpath(parent);
      if (!isPathInside(baseReal, parentReal)) {
        throw new HostError("provider_config_path_denied", `Provider configuration escapes ${baseReal}`);
      }
    }
    if (await pathExists(path)) {
      const fileInfo = await lstat(path);
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
        throw new HostError("provider_config_path_denied", `Provider configuration is not a regular file: ${path}`);
      }
    }
  }

  async #documents(
    cwd: string,
    projectTrusted: boolean,
  ): Promise<Partial<Record<ProviderConfigScope, ConfigDocument>>> {
    const result: Partial<Record<ProviderConfigScope, ConfigDocument>> = {};
    for (const scope of ["user", "project", "custom"] as const) {
      if (scope === "project" && !projectTrusted) continue;
      const path = this.#pathForScope(scope, cwd);
      if (!path) continue;
      await this.#assertSafePath(scope, cwd, path, false);
      result[scope] = await readDocument(path);
    }
    return result;
  }

  async #locations(
    cwd: string,
    documents: Partial<Record<ProviderConfigScope, ConfigDocument>>,
    providerId: string,
    projectTrusted: boolean,
  ): Promise<Record<ProviderConfigScope, ProviderConfigLocation>> {
    const location = (
      scope: ProviderConfigScope,
      available: boolean,
      path: string | undefined,
    ): ProviderConfigLocation => ({
      available,
      exists:
        documents[scope] !== undefined &&
        providerRecord(documents[scope] as ConfigDocument, providerId) !== undefined,
      ...(path === undefined ? {} : { path }),
      scope,
      writable: available,
    });
    return {
      custom: location("custom", this.#customPath !== undefined, this.#customPath),
      project: location("project", projectTrusted, this.#pathForScope("project", cwd)),
      user: location("user", true, this.#pathForScope("user", cwd)),
    };
  }
}
