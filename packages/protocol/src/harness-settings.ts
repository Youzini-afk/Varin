/**
 * Harness settings live under `harness` in the native Agent settings documents.
 * Trusted project overrides come from the native project settings document.
 * The Host model/settings owner loads them and enforces project trust at admission.
 */

import {
  parseHarnessEmbeddingSettings,
  parseHarnessRerankSettings,
  type HarnessEmbeddingSettings,
  type HarnessRerankSettings,
} from "./harness-inference.js";
import {
  parseHarnessFastDecisionSettings,
  type HarnessFastDecisionSettings,
} from "./harness-fast-decision.js";
import { mergePolicies, type PermissionMode, type PermissionRule } from "./permission-gate.js";
import { parseHarnessAgents, type HarnessCustomAgent } from "./harness-agents.js";
import { parseHarnessModelSlots, type HarnessModelBinding } from "./harness-model-slots.js";
import { parseHarnessImageSettings, type HarnessImageSettings } from './harness-images.js';
import { THINKING_LEVELS, type ThinkingLevel } from "./types.js";
import { isTimeZone, type MessageTimeSettings } from './message-time.js';

/** A provider + model pair, as stored in a model slot. */
export interface ModelSelection {
  providerId: string;
  modelId: string;
}

/** User-owned one-shot selector; its own thinking is independent of the delegated executor. */
export interface HarnessDelegationModelSelectionSettings {
  enabled: boolean;
  model?: ModelSelection;
  /** Omitted means the selector model's configured default, never the parent's thinking. */
  thinkingLevel?: ThinkingLevel;
}

export function resolveHarnessDelegationModelSelectionSettings(value: unknown): HarnessDelegationModelSelectionSettings {
  if (value === undefined) return { enabled: false };
  const fail = (message: string): never => { throw new HarnessSettingsValidationError(`harness.delegationModelSelection ${message}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("must be an object");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "enabled" && key !== "model" && key !== "thinkingLevel")) return fail("contains an unknown field");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") return fail("enabled must be a boolean");
  let model: ModelSelection | undefined;
  if (input.model !== undefined) {
    if (!input.model || typeof input.model !== "object" || Array.isArray(input.model)) return fail("model requires providerId and modelId");
    const selected = input.model as Record<string, unknown>;
    if (Object.keys(selected).some(key => key !== "providerId" && key !== "modelId")
      || typeof selected.providerId !== "string" || !selected.providerId.trim()
      || typeof selected.modelId !== "string" || !selected.modelId.trim()) return fail("model requires providerId and modelId");
    model = { providerId: selected.providerId, modelId: selected.modelId };
  }
  if (input.enabled === true && !model) return fail("enabled selection requires a model");
  if (input.thinkingLevel !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(input.thinkingLevel)) return fail("thinkingLevel must be a supported thinking level");
  return { enabled: input.enabled === true, ...(model ? { model } : {}),
    ...(input.thinkingLevel === undefined ? {} : { thinkingLevel: input.thinkingLevel as ThinkingLevel }) };
}

/** Auto assigns action and selection duties independently; explicit modes keep one judgment path. */
export type HarnessExploreDecisionMode = "auto" | "llm" | "fast-decision" | "rerank" | "source";

export interface HarnessCodeRetrievalSettings {
  decision: HarnessExploreDecisionMode;
}

/** An old non-chat choice requires an explicit ordinary-model selection. */
export function requiresRetrievalModelSelection(settings:Pick<HarnessSettings,'models'|'codeRetrieval'|'fastDecision'|'rerank'>):boolean {
  const selected=settings.models.explore;
  if(selected?.enabled===false || selected?.modelId || selected?.inherit===true)return false;
  if(selected?.inherit===false)return true;
  const mode=settings.codeRetrieval.decision;
  const purpose=settings.fastDecision?.purposes?.explore;
  const fast=purpose==='off'?undefined:purpose ?? settings.fastDecision?.default;
  return ['fast-decision','rerank','source'].includes(mode) || mode==='auto' && Boolean(fast || settings.rerank);
}

export function resolveHarnessCodeRetrievalSettings(value: unknown): HarnessCodeRetrievalSettings {
  if (value === undefined) return { decision: "auto" };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessSettingsValidationError("harness.codeRetrieval must be an object");
  }
  const decision = (value as { decision?: unknown }).decision ?? "auto";
  if (decision !== "auto" && decision !== "llm" && decision !== "fast-decision"
    && decision !== "rerank" && decision !== "source") {
    throw new HarnessSettingsValidationError("harness.codeRetrieval.decision is invalid");
  }
  return { decision };
}

export type HarnessWebSearchProvider = "brave" | "exa" | "tavily" | "jina" | "searxng" | "anysearch";

export interface HarnessWebSearchSettings {
  provider: HarnessWebSearchProvider;
  /** Required for SearXNG; optional override for hosted providers. */
  endpoint?: string;
  /** Host credential reference. Optional for AnySearch anonymous search or unauthenticated SearXNG. */
  credentialRef?: string;
}

/** Current, credential-free search connection configuration. Missing configuration
 * uses the product's anonymous defaults; an explicit empty list enables none. */
export interface HarnessWebSearchConnection extends HarnessWebSearchSettings {
  id: string;
  name: string;
  enabled: boolean;
  description?: string;
}

export interface HarnessWebSearchConfiguration {
  /** Omitted keeps anonymous connections; an explicit empty array enables none. */
  connections?: HarnessWebSearchConnection[];
  defaultConnectionId?: string;
  fallbackConnectionIds: string[];
  enabled?: boolean;
  smartSelection?: boolean;
}

/** Normalize supported legacy assets once at the settings boundary. Never turn
 * malformed or explicitly disabled configuration into the anonymous default. */
export function parseHarnessWebSearchSettings(value: unknown): HarnessWebSearchConfiguration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if ((input.enabled !== undefined && typeof input.enabled !== "boolean")
    || (input.smartSelection !== undefined && typeof input.smartSelection !== "boolean")) return null;
  const preferences = {
    ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
    ...(typeof input.smartSelection === "boolean" ? { smartSelection: input.smartSelection } : {}),
  };
  const adapter = (entry: unknown): HarnessWebSearchSettings | null => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    const provider = item.provider;
    if (provider !== "brave" && provider !== "exa" && provider !== "tavily" && provider !== "jina" && provider !== "searxng" && provider !== "anysearch") return null;
    if (["endpoint", "credentialRef"].some(key => item[key] !== undefined && typeof item[key] !== "string")) return null;
    const endpoint = typeof item.endpoint === "string" ? item.endpoint.trim() : "";
    const credentialRef = typeof item.credentialRef === "string" ? item.credentialRef.trim() : "";
    return { provider, ...(endpoint ? { endpoint } : {}), ...(credentialRef ? { credentialRef } : {}) };
  };
  if (!("connections" in input)) {
    if (!("provider" in input)) {
      if (!Object.keys(preferences).length || Object.keys(input).some(key => !["enabled", "smartSelection", "fallbackConnectionIds"].includes(key))
        || (input.fallbackConnectionIds !== undefined && (!Array.isArray(input.fallbackConnectionIds) || input.fallbackConnectionIds.length))) return null;
      return { ...preferences, fallbackConnectionIds: [] };
    }
    const legacy = adapter(input);
    if (!legacy) return null;
    const id = `configured-${legacy.provider}`;
    return { connections: [{ ...legacy, id, name: legacy.provider, enabled: true }], defaultConnectionId: id, fallbackConnectionIds: [], ...preferences };
  }
  if (!Array.isArray(input.connections)
    || (input.defaultConnectionId !== undefined && typeof input.defaultConnectionId !== "string")
    || !Array.isArray(input.fallbackConnectionIds) || !input.fallbackConnectionIds.every(id => typeof id === "string")) return null;
  const connections: HarnessWebSearchConnection[] = [];
  const ids = new Set<string>();
  for (const entry of input.connections) {
    const parsed = adapter(entry);
    if (!parsed) return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(item.id)
      || ids.has(item.id) || typeof item.name !== "string" || !item.name.trim()
      || typeof item.enabled !== "boolean" || (item.description !== undefined && typeof item.description !== "string")) return null;
    ids.add(item.id);
    connections.push({ ...parsed, id: item.id, name: item.name.trim(), enabled: item.enabled,
      ...(typeof item.description === "string" && item.description.trim() ? { description: item.description.trim() } : {}) });
  }
  const defaultConnectionId = typeof input.defaultConnectionId === "string" ? input.defaultConnectionId : undefined;
  const fallbackConnectionIds = [...new Set(input.fallbackConnectionIds as string[])];
  if ((defaultConnectionId !== undefined && !ids.has(defaultConnectionId)) || fallbackConnectionIds.some(id => !ids.has(id))) return null;
  return { connections, ...(defaultConnectionId === undefined ? {} : { defaultConnectionId }), fallbackConnectionIds, ...preferences };
}

/** Search ranking/exclusion defaults, never a network-access authorization. */
export interface HarnessWebSourcePreferences {
  preferredDomains?: string[];
  excludedDomains?: string[];
}
export function parseHarnessWebSourcePreferences(value: unknown): HarnessWebSourcePreferences | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const result: HarnessWebSourcePreferences = {};
  for (const key of ["preferredDomains", "excludedDomains"] as const) {
    if (input[key] === undefined) continue;
    if (!Array.isArray(input[key]) || !(input[key] as unknown[]).every(domain => typeof domain === "string" && /^[a-z0-9\p{L}](?:[a-z0-9\p{L}.-]*[a-z0-9\p{L}])?$/iu.test(domain.trim()))) return null;
    result[key] = [...new Set((input[key] as string[]).map(domain => domain.trim().toLowerCase()))];
  }
  return result;
}

export interface HarnessWebDomainPolicy {
  /** Undefined means unrestricted; an explicit empty array means allow none. */
  allow?: string[];
  block: string[];
}

export interface HarnessWorktreeBudget {
  maxBytes?: number;
  minFreeRatio?: number;
}

export interface HarnessWorktreeSettings {
  setup?: string;
  setupTimeoutMs?: number;
  copyIgnored?: string[];
  shareDependencies?: boolean;
  reclaimIdle?: boolean;
  budget?: HarnessWorktreeBudget;
}

export interface HarnessContextSettings {
  /**
   * Background summary preparation for compaction. Default true. User-owned;
   * a workspace cannot enable background model calls the user turned off.
   */
  backgroundPreparation: boolean;
  /** Fraction of usable input where preparation starts (0-1, default 0.75). */
  preparationWaterline: number;
  compactionRecovery: CompactionRecoverySettings;
  messageTime: MessageTimeSettings;
}

export interface CompactionRecoverySettings {
  enabled: boolean;
  /** Silence after a streamed model update before treating the request as stalled. */
  streamIdleMs: number;
  /** Wait for the first model update or a non-streaming completion. */
  responseWaitMs: number;
  /** Fresh worker attempts after a confirmed stall; the frozen input is reused. */
  maxRetries: number;
}


/** User-owned post-turn next-step picker. Disabled by default. */
export interface HarnessNextStepSettings {
  enabled: boolean;
}

/** User-owned optional local document parsers; empty values restore defaults. */
export interface HarnessDocumentReadingSettings {
  doclingCommand: string;
  tesseractCommand: string;
  ocrLanguage: string;
}

export interface HarnessDocumentReadingSettingsInput {
  doclingCommand?: unknown;
  tesseractCommand?: unknown;
  ocrLanguage?: unknown;
}

const DEFAULT_HARNESS_NEXT_STEP_SETTINGS: HarnessNextStepSettings = { enabled: false };

export const DEFAULT_HARNESS_DOCUMENT_READING_SETTINGS: HarnessDocumentReadingSettings = {
  doclingCommand: "docling",
  tesseractCommand: "tesseract",
  ocrLanguage: "eng",
};

export function resolveHarnessDocumentReadingSettings(value: unknown): HarnessDocumentReadingSettings {
  if (value === undefined) return { ...DEFAULT_HARNESS_DOCUMENT_READING_SETTINGS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessSettingsValidationError("harness.documentReading must be an object");
  }
  const input = value as HarnessDocumentReadingSettingsInput;
  const resolveString = (key: keyof HarnessDocumentReadingSettings): string => {
    const candidate = input[key];
    if (candidate === undefined) return DEFAULT_HARNESS_DOCUMENT_READING_SETTINGS[key];
    if (typeof candidate !== "string") {
      throw new HarnessSettingsValidationError(`harness.documentReading.${key} must be a string`);
    }
    return candidate.trim() || DEFAULT_HARNESS_DOCUMENT_READING_SETTINGS[key];
  };
  return {
    doclingCommand: resolveString("doclingCommand"),
    tesseractCommand: resolveString("tesseractCommand"),
    ocrLanguage: resolveString("ocrLanguage"),
  };
}

export function resolveHarnessNextStepSettings(value: unknown): HarnessNextStepSettings {
  if (value === undefined) return { ...DEFAULT_HARNESS_NEXT_STEP_SETTINGS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessSettingsValidationError("harness.nextStep must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new HarnessSettingsValidationError("harness.nextStep.enabled must be a boolean");
  }
  return { enabled: input.enabled ?? DEFAULT_HARNESS_NEXT_STEP_SETTINGS.enabled };
}

/** Raw context settings accepted by the native Agent settings owner. */
export interface HarnessContextSettingsInput {
  backgroundPreparation?: unknown;
  preparationWaterline?: unknown;
  compactionRecovery?: unknown;
  messageTime?: unknown;
}

export class HarnessSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessSettingsValidationError";
  }
}


const DEFAULT_HARNESS_CONTEXT_SETTINGS: HarnessContextSettings = {
  backgroundPreparation: true,
  preparationWaterline: 0.75,
  compactionRecovery: { enabled: true, streamIdleMs: 120_000, responseWaitMs: 300_000, maxRetries: 1 },
  messageTime: { enabled: false, timeZone: null },
};

export function resolveMessageTimeSettings(value: unknown): MessageTimeSettings {
  if (value === undefined) return { ...DEFAULT_HARNESS_CONTEXT_SETTINGS.messageTime };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HarnessSettingsValidationError('harness.context.messageTime must be an object');
  }
  const input = value as Record<string, unknown>;
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
    throw new HarnessSettingsValidationError('harness.context.messageTime.enabled must be a boolean');
  }
  const timeZone = input.timeZone ?? null;
  if (timeZone !== null && (typeof timeZone !== 'string' || !isTimeZone(timeZone))) {
    throw new HarnessSettingsValidationError('harness.context.messageTime.timeZone must be a valid time zone or null');
  }
  return { enabled: input.enabled ?? false, timeZone };
}

export function resolveCompactionRecoverySettings(value: unknown): CompactionRecoverySettings {
  if (value === undefined) return { ...DEFAULT_HARNESS_CONTEXT_SETTINGS.compactionRecovery };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HarnessSettingsValidationError("harness.context.compactionRecovery must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new HarnessSettingsValidationError("harness.context.compactionRecovery.enabled must be a boolean");
  }
  const timer = (key: "streamIdleMs" | "responseWaitMs"): number => {
    const setting = input[key] ?? DEFAULT_HARNESS_CONTEXT_SETTINGS.compactionRecovery[key];
    if (!Number.isSafeInteger(setting) || Number(setting) < 1 || Number(setting) > 2_147_483_647) {
      throw new HarnessSettingsValidationError(`harness.context.compactionRecovery.${key} must be a positive timer duration`);
    }
    return Number(setting);
  };
  const maxRetries = input.maxRetries ?? DEFAULT_HARNESS_CONTEXT_SETTINGS.compactionRecovery.maxRetries;
  if (!Number.isSafeInteger(maxRetries) || Number(maxRetries) < 0) {
    throw new HarnessSettingsValidationError("harness.context.compactionRecovery.maxRetries must be a non-negative integer");
  }
  return { enabled: input.enabled ?? DEFAULT_HARNESS_CONTEXT_SETTINGS.compactionRecovery.enabled,
    streamIdleMs: timer("streamIdleMs"), responseWaitMs: timer("responseWaitMs"), maxRetries: Number(maxRetries) };
}

export function resolveHarnessContextSettings(
  context: unknown,
): HarnessContextSettings {
  if (context !== undefined
    && (typeof context !== "object" || context === null || Array.isArray(context))) {
    throw new HarnessSettingsValidationError("harness.context must be an object");
  }
  const input = (context ?? {}) as HarnessContextSettingsInput;
  if (Object.keys(input).some(key => !["backgroundPreparation", "preparationWaterline", "compactionRecovery", "messageTime"].includes(key))) {
    throw new HarnessSettingsValidationError("Unsupported harness.context setting");
  }
  if (input.backgroundPreparation !== undefined && typeof input.backgroundPreparation !== "boolean") {
    throw new HarnessSettingsValidationError("harness.context.backgroundPreparation must be a boolean");
  }
  if (input.preparationWaterline !== undefined
    && (typeof input.preparationWaterline !== "number"
      || input.preparationWaterline <= 0
      || input.preparationWaterline >= 1)) {
    throw new HarnessSettingsValidationError(
      "harness.context.preparationWaterline must be a number between 0 and 1",
    );
  }
  return {
    backgroundPreparation: input.backgroundPreparation ?? DEFAULT_HARNESS_CONTEXT_SETTINGS.backgroundPreparation,
    preparationWaterline: input.preparationWaterline ?? DEFAULT_HARNESS_CONTEXT_SETTINGS.preparationWaterline,
    compactionRecovery: resolveCompactionRecoverySettings(input.compactionRecovery),
    messageTime: resolveMessageTimeSettings(input.messageTime),
  };
}

export type HarnessSettingsInput = Omit<Partial<HarnessSettings>, "context" | "nextStep" | "documentReading" | "codeRetrieval" | "delegationModelSelection"> & {
  context?: HarnessContextSettingsInput;
  nextStep?: Partial<HarnessNextStepSettings>;
  documentReading?: HarnessDocumentReadingSettingsInput;
  codeRetrieval?: Partial<HarnessCodeRetrievalSettings>;
  delegationModelSelection?: Partial<HarnessDelegationModelSelectionSettings>;
};

export interface HarnessSettings {
  images?: HarnessImageSettings;
  tools: Partial<Record<string, boolean>>;
  shell: "auto" | "bash" | "zsh" | "sh" | "fish" | "pwsh" | "powershell" | "cmd" | "dash" | "ksh" | "nu";
  output: { visibleBytes: number };
  models: Partial<Record<HarnessModelRole, HarnessModelBinding>>;
  /** User-owned profiles dispatched through the ordinary native Thread runtime. */
  agents: Record<string, HarnessCustomAgent>;
  codeRetrieval: HarnessCodeRetrievalSettings;
  /** User-owned optional selector for new native free delegations; disabled by default. */
  delegationModelSelection: HarnessDelegationModelSelectionSettings;
  dispatch: { concurrency: number; askBefore: Partial<Record<string, boolean>> };
  knowledge: {
    eventRetentionDays: number;
    /**
     * Background memory organization (BC2): which source scopes the organizer
     * may process (`bot`), and whether inferred proposals may land
     * in the `user` scope. Explicit memory actions are never gated by this.
     * Both switches are user-owned; a project cannot re-enable organizing
     * the user turned off.
     */
    autoOrganize: { user: boolean; bot: boolean };
  };
  /** User-owned message context and background compaction preparation. */
  context: HarnessContextSettings;
  /** User-owned post-turn next-step suggestions; projects cannot enable it. */
  nextStep: HarnessNextStepSettings;
  /** Optional Host-side document parsers and OCR language; user-owned. */
  documentReading: HarnessDocumentReadingSettings;
  /** Dedicated embedding backend. Not a chat model slot. */
  embedding?: HarnessEmbeddingSettings;
  /** Dedicated rerank backend. Not a chat completion or embeddings alias. */
  rerank?: HarnessRerankSettings;
  /**
   * Computer Use (BC4): the desktop work targets by default. User-owned —
   * a project cannot redirect agent input to a machine the user did not pick.
   */
  computer?: { defaultDesktop: string | null };
  /**
   * Fast Decision Model binding: default slot plus per-purpose override or
   * `"off"`. User-owned; not a chat model slot (D-312).
   */
  fastDecision?: HarnessFastDecisionSettings;
  worktree?: HarnessWorktreeSettings;
  web?: {
    render?: boolean;
    readingAssistance?: boolean;
    sourcePreferences?: HarnessWebSourcePreferences;
    search?: HarnessWebSearchSettings | HarnessWebSearchConfiguration;
    domains?: Partial<HarnessWebDomainPolicy>;
  };
  permissions?: {
    mode?: PermissionMode;
    rules?: PermissionRule[];
  };
}

export type HarnessModelRole =
  | "contextCompaction"
  | "agentPlanning"
  | "explore"
  | "retrievalAgent"
  | "researchPeer"
  | "worker"
  | "verifier"
  | "reader"
  | "webSelection"
  | "nextStep"
  | "permissionJudge"
  | "researchInvestigation"
  | "researchExperimentalDesign"
  | "researchFastExploration"
  | "researchHighThroughputExecution"
  | "memoryOrganizer";

export const DEFAULT_HARNESS_SETTINGS: HarnessSettings = {
  tools: {},
  shell: "auto",
  output: { visibleBytes: 32768 },
  models: {},
  agents: {},
  codeRetrieval: { decision: "auto" },
  delegationModelSelection: { enabled: false },
  dispatch: { concurrency: 12, askBefore: {} },
  knowledge: {
    eventRetentionDays: 30,
    autoOrganize: { user: true, bot: true },
  },
  context: { backgroundPreparation: true, preparationWaterline: 0.75,
    compactionRecovery: { ...DEFAULT_HARNESS_CONTEXT_SETTINGS.compactionRecovery },
    messageTime: { ...DEFAULT_HARNESS_CONTEXT_SETTINGS.messageTime } },
  nextStep: { enabled: false },
  documentReading: { ...DEFAULT_HARNESS_DOCUMENT_READING_SETTINGS },
  worktree: {
    copyIgnored: [],
    shareDependencies: false,
    reclaimIdle: true,
  },
  permissions: { mode: "normal", rules: [] },
};

const normalizeDomainRule = (value: string): string => value.trim().toLowerCase().replace(/^\.+|\.+$/g, "");

export const normalizeHarnessWebDomainRules = (values: readonly string[] | undefined): string[] | undefined => {
  if (values === undefined) return undefined;
  return [...new Set(values.map(normalizeDomainRule).filter(Boolean))];
};

export const harnessDomainRuleMatches = (hostname: string, rule: string): boolean => {
  const host = hostname.trim().toLowerCase().replace(/\.+$/g, "");
  const normalized = normalizeDomainRule(rule);
  return Boolean(normalized) && (host === normalized || host.endsWith(`.${normalized}`));
};

const intersectDomainAllows = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): string[] | undefined => {
  const a = normalizeHarnessWebDomainRules(left);
  const b = normalizeHarnessWebDomainRules(right);
  if (a === undefined) return b;
  if (b === undefined) return a;
  const result: string[] = [];
  for (const leftRule of a) {
    for (const rightRule of b) {
      if (harnessDomainRuleMatches(leftRule, rightRule)) result.push(leftRule);
      else if (harnessDomainRuleMatches(rightRule, leftRule)) result.push(rightRule);
    }
  }
  return [...new Set(result)];
};

/** User policy is the ceiling. A trusted workspace can only narrow it. */
export const mergeHarnessWebDomainPolicy = (
  user: Partial<HarnessWebDomainPolicy> | undefined,
  workspace: Partial<HarnessWebDomainPolicy> | undefined,
): HarnessWebDomainPolicy => {
  const allow = intersectDomainAllows(user?.allow, workspace?.allow);
  return {
    ...(allow === undefined ? {} : { allow }),
    block: [...new Set([
      ...(normalizeHarnessWebDomainRules(user?.block) ?? []),
      ...(normalizeHarnessWebDomainRules(workspace?.block) ?? []),
    ])],
  };
};

export function mergeHarnessSettings(
  user: HarnessSettingsInput,
  workspace: HarnessSettingsInput,
): HarnessSettings {
  if ("memory" in user || "memory" in workspace) {
    throw new HarnessSettingsValidationError("Unsupported harness.memory settings; configure harness.context explicitly");
  }
  const {
    context: _userContext,
    documentReading: userDocumentReading,
    embedding: userEmbedding,
    fastDecision: userFastDecision,
    rerank: userRerank,
    nextStep: userNextStep,
    delegationModelSelection: userDelegationModelSelection,
    codeRetrieval: userCodeRetrieval,
    computer: userComputer,
    images: userImages,
    ...userRest
  } = user;
  const {
    context: _workspaceContext,
    documentReading: _workspaceDocumentReading,
    embedding: _workspaceEmbedding,
    fastDecision: _workspaceFastDecision,
    rerank: _workspaceRerank,
    nextStep: _workspaceNextStep,
    delegationModelSelection: _workspaceDelegationModelSelection,
    codeRetrieval: _workspaceCodeRetrieval,
    computer: _workspaceComputer,
    images: _workspaceImages,
    ...workspaceRest
  } = workspace;
  const askBeforeKeys = new Set([
    ...Object.keys(user.dispatch?.askBefore ?? {}),
    ...Object.keys(workspace.dispatch?.askBefore ?? {}),
  ]);
  const askBefore = Object.fromEntries([...askBeforeKeys].map((key) => [
    key,
    user.dispatch?.askBefore?.[key] === true || workspace.dispatch?.askBefore?.[key] === true,
  ]));
  const permissions = mergePolicies(
    {
      mode: user.permissions?.mode ?? DEFAULT_HARNESS_SETTINGS.permissions?.mode ?? "normal",
      rules: user.permissions?.rules ?? [],
    },
    {
      ...(workspace.permissions?.mode === undefined ? {} : { mode: workspace.permissions.mode }),
      ...(workspace.permissions?.rules === undefined ? {} : { rules: workspace.permissions.rules }),
    },
  );
  let documentReading: HarnessDocumentReadingSettings;
  try {
    documentReading = resolveHarnessDocumentReadingSettings(userDocumentReading);
  } catch {
    // Ordinary session settings and UI projection must survive an invalid
    // optional parser binding. Host parser consumers validate the raw user
    // setting before attempting to launch an optional process.
    documentReading = { ...DEFAULT_HARNESS_DOCUMENT_READING_SETTINGS };
  }
  const merged: HarnessSettings = {
    ...DEFAULT_HARNESS_SETTINGS,
    ...userRest,
    ...workspaceRest,
    shell: user.shell ?? DEFAULT_HARNESS_SETTINGS.shell,
    // Deep merge (depth 1) for nested objects
    tools: { ...DEFAULT_HARNESS_SETTINGS.tools, ...user.tools, ...workspace.tools },
    output: { ...DEFAULT_HARNESS_SETTINGS.output, ...user.output, ...workspace.output },
    // Model/provider selection is user-owned. A repository cannot redirect
    // auxiliary requests to another provider.
    models: parseHarnessModelSlots(user.models),
    agents: parseHarnessAgents(user.agents),
    images: (() => { try { return parseHarnessImageSettings(userImages); } catch { return {}; } })(),
    // An optional, externally edited judgment choice must not prevent chat
    // creation. Its direct consumer reports the invalid choice and keeps source
    // ranking; settings.update validates new writes separately.
    codeRetrieval: (() => {
      try { return resolveHarnessCodeRetrievalSettings(userCodeRetrieval); }
      catch { return { decision: "source" as const }; }
    })(),
    dispatch: {
      ...DEFAULT_HARNESS_SETTINGS.dispatch,
      ...user.dispatch,
      ...workspace.dispatch,
      askBefore,
    },
    knowledge: {
      ...DEFAULT_HARNESS_SETTINGS.knowledge,
      ...user.knowledge,
      ...workspace.knowledge,
      // Bot background organization is user-owned, independent of project settings.
      autoOrganize: {
        user: user.knowledge?.autoOrganize?.user
          ?? DEFAULT_HARNESS_SETTINGS.knowledge.autoOrganize.user,
        bot: user.knowledge?.autoOrganize?.bot
          ?? DEFAULT_HARNESS_SETTINGS.knowledge.autoOrganize.bot,
      },
    },
    // Message time and background preparation are user-owned.
    context: resolveHarnessContextSettings(user.context),
    // Local document parser executables are user-owned. Project settings can
    // never select a process for the Host to launch.
    documentReading,
    // Next-step suggestions are user-owned. A project cannot enable them when
    // the user has opted out, and project settings cannot redirect the model.
    nextStep: resolveHarnessNextStepSettings(userNextStep),
    // Projects cannot enable a selector or redirect its model and credential.
    delegationModelSelection: resolveHarnessDelegationModelSelectionSettings(userDelegationModelSelection),
    // Embedding and rerank bindings are user-owned. A repository cannot
    // redirect remote inference or select another provider credential.
    ...((() => {
      // Optional background inference cannot make ordinary chat unusable when
      // an older/external file is malformed. Its direct consumers parse the
      // raw global value and report invalid/unavailable; settings.update still
      // rejects writing a malformed candidate.
      let embedding: HarnessEmbeddingSettings | undefined;
      let rerank: HarnessRerankSettings | undefined;
      let fastDecision: HarnessFastDecisionSettings | undefined;
      try { embedding = parseHarnessEmbeddingSettings(userEmbedding); } catch { embedding = undefined; }
      try { rerank = parseHarnessRerankSettings(userRerank); } catch { rerank = undefined; }
      try { fastDecision = parseHarnessFastDecisionSettings(userFastDecision); } catch { fastDecision = undefined; }
      return {
        ...(embedding ? { embedding } : {}),
        ...(rerank ? { rerank } : {}),
        ...(fastDecision ? { fastDecision } : {}),
      };
    })()),
    ...(user.web || workspace.web
      ? {
          web: {
            // Search provider/credential and renderer access are user-owned.
            ...(user.web?.render === undefined ? {} : { render: user.web.render }),
            ...(user.web?.readingAssistance === undefined ? {} : { readingAssistance: user.web.readingAssistance }),
            ...(user.web?.search ? { search: parseHarnessWebSearchSettings(user.web.search) ?? { ...user.web.search } } : {}),
            ...(user.web?.sourcePreferences || workspace.web?.sourcePreferences ? {
              sourcePreferences: { ...user.web?.sourcePreferences, ...workspace.web?.sourcePreferences },
            } : {}),
            // Workspace policy may only add blocks or narrow the allow-set.
            domains: mergeHarnessWebDomainPolicy(user.web?.domains, workspace.web?.domains),
          },
        }
      : {}),
    // The default Computer Use target is user-owned, like model selection.
    computer: {
      defaultDesktop: userComputer?.defaultDesktop ?? null,
    },
    worktree: {
      ...DEFAULT_HARNESS_SETTINGS.worktree,
      ...user.worktree,
      ...workspace.worktree,
      ...(user.worktree?.budget || workspace.worktree?.budget
        ? {
            budget: {
              ...user.worktree?.budget,
              ...workspace.worktree?.budget,
            },
          }
        : {}),
    },
    permissions,
  };
  return merged;
}
