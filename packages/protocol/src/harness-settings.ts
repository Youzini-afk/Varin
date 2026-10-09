/**
 * Harness settings live under `harness` in Pi's agent-directory settings.json.
 * Trusted project overrides come from <workspace>/.pi/settings.json.
 * Pi owns source loading and project trust; tool assembly resolves them at session creation.
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
import { type HarnessCustomAgent } from "./harness-agents.js";
import { normalizeHarnessAgentConfiguration, type HarnessModelBinding } from "./harness-model-slots.js";

/** A provider + model pair, as stored in a model slot. */
export interface ModelSelection {
  providerId: string;
  modelId: string;
}

/** Auto assigns action and selection duties independently; explicit modes keep one judgment path. */
export type HarnessExploreDecisionMode = "auto" | "llm" | "fast-decision" | "rerank" | "source";

export interface HarnessCodeRetrievalSettings {
  decision: HarnessExploreDecisionMode;
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

export type HarnessWebSearchProvider = "brave" | "exa" | "tavily" | "jina" | "searxng";

export interface HarnessWebSearchSettings {
  provider: HarnessWebSearchProvider;
  /** Required for SearXNG; optional override for hosted providers. */
  endpoint?: string;
  /** Pi auth.json entry name. SearXNG may omit it for an unauthenticated instance. */
  credentialRef?: string;
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

/**
 * Raw persisted shape accepted while reading Pi settings. `context` is the
 * current object; `memory` is the retired keeper setting, still read so an
 * explicit user `mode: "off"` keeps background preparation disabled.
 */
export interface HarnessContextSettingsInput {
  backgroundPreparation?: unknown;
  preparationWaterline?: unknown;
  compactionRecovery?: unknown;
}

export interface HarnessMemorySettingsInput {
  mode?: unknown;
  shadowMode?: unknown;
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
};

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
  legacyMemory: unknown,
): HarnessContextSettings {
  if (context !== undefined
    && (typeof context !== "object" || context === null || Array.isArray(context))) {
    throw new HarnessSettingsValidationError("harness.context must be an object");
  }
  const input = (context ?? {}) as HarnessContextSettingsInput;
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
  // A retired harness.memory.mode: "off" or shadowMode: false was the user's
  // explicit opt-out of background maintenance; it maps to disabling
  // background preparation only, never to disabling automatic compaction.
  const memory = (typeof legacyMemory === "object" && legacyMemory !== null && !Array.isArray(legacyMemory)
    ? legacyMemory
    : {}) as HarnessMemorySettingsInput;
  const legacyOff = memory.mode === "off" || memory.shadowMode === false;
  return {
    backgroundPreparation: input.backgroundPreparation ?? !legacyOff,
    preparationWaterline: input.preparationWaterline ?? DEFAULT_HARNESS_CONTEXT_SETTINGS.preparationWaterline,
    compactionRecovery: resolveCompactionRecoverySettings(input.compactionRecovery),
  };
}

export type HarnessSettingsInput = Omit<Partial<HarnessSettings>, "context" | "nextStep" | "documentReading" | "codeRetrieval"> & {
  context?: HarnessContextSettingsInput;
  memory?: HarnessMemorySettingsInput;
  nextStep?: Partial<HarnessNextStepSettings>;
  documentReading?: HarnessDocumentReadingSettingsInput;
  codeRetrieval?: Partial<HarnessCodeRetrievalSettings>;
};

export interface HarnessSettings {
  tools: Partial<Record<string, boolean>>;
  shell: "auto" | "git-bash" | "powershell" | "wsl";
  output: { visibleBytes: number };
  bash: { waitMs: number };
  models: Partial<Record<HarnessModelRole, HarnessModelBinding>>;
  /** User-owned profiles dispatched through the ordinary native Thread runtime. */
  agents: Record<string, HarnessCustomAgent>;
  codeRetrieval: HarnessCodeRetrievalSettings;
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
  /** Context-management settings (background compaction preparation). */
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
    search?: HarnessWebSearchSettings;
    domains?: Partial<HarnessWebDomainPolicy>;
  };
  permissions?: {
    mode?: PermissionMode;
    rules?: PermissionRule[];
  };
}

export type HarnessModelRole =
  | "agentPlanning"
  | "explore"
  | "retrievalAgent"
  | "worker"
  | "reader"
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
  bash: { waitMs: 10000 },
  models: {},
  agents: {},
  codeRetrieval: { decision: "auto" },
  dispatch: { concurrency: 12, askBefore: {} },
  knowledge: {
    eventRetentionDays: 30,
    autoOrganize: { user: true, bot: true },
  },
  context: { backgroundPreparation: true, preparationWaterline: 0.75,
    compactionRecovery: { ...DEFAULT_HARNESS_CONTEXT_SETTINGS.compactionRecovery } },
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
  const {
    context: _userContext,
    documentReading: userDocumentReading,
    embedding: userEmbedding,
    fastDecision: userFastDecision,
    memory: _userMemory,
    rerank: userRerank,
    nextStep: userNextStep,
    codeRetrieval: userCodeRetrieval,
    computer: userComputer,
    ...userRest
  } = user;
  const {
    context: _workspaceContext,
    documentReading: _workspaceDocumentReading,
    embedding: _workspaceEmbedding,
    fastDecision: _workspaceFastDecision,
    memory: _workspaceMemory,
    rerank: _workspaceRerank,
    nextStep: _workspaceNextStep,
    codeRetrieval: _workspaceCodeRetrieval,
    computer: _workspaceComputer,
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
  for (const [id, role] of [["quick-implement", "quickImplement"], ["hard-implement", "hardImplement"], ["frontend", "frontend"], ["review", "review"], ["check", "check"]] as const) {
    if (askBefore[id]) askBefore.worker = true;
    if (askBefore[id]) askBefore[`custom:saved-${role}`] = true;
    delete askBefore[id];
  }
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
  const agentConfiguration = normalizeHarnessAgentConfiguration(user.models, user.agents);
  const merged: HarnessSettings = {
    ...DEFAULT_HARNESS_SETTINGS,
    ...userRest,
    ...workspaceRest,
    // Deep merge (depth 1) for nested objects
    tools: { ...DEFAULT_HARNESS_SETTINGS.tools, ...user.tools, ...workspace.tools },
    output: { ...DEFAULT_HARNESS_SETTINGS.output, ...user.output, ...workspace.output },
    bash: { ...DEFAULT_HARNESS_SETTINGS.bash, ...user.bash, ...workspace.bash },
    // Model/provider selection is user-owned. A repository cannot redirect
    // auxiliary requests to another provider.
    models: agentConfiguration.models,
    agents: agentConfiguration.agents,
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
    // Background preparation is user-owned. A repository cannot enable
    // background model calls the user turned off; a legacy memory.mode "off"
    // keeps preparation disabled, and project settings cannot re-enable it.
    context: resolveHarnessContextSettings(user.context, user.memory),
    // Local document parser executables are user-owned. Project settings can
    // never select a process for the Host to launch.
    documentReading,
    // Next-step suggestions are user-owned. A project cannot enable them when
    // the user has opted out, and project settings cannot redirect the model.
    nextStep: resolveHarnessNextStepSettings(userNextStep),
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
            ...(user.web?.search ? { search: { ...user.web.search } } : {}),
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
