/**
 * Fast Decision Model (快速决策模型) — a vendor-neutral structured-judgment
 * capability. This is not a chat slot, not a rerank endpoint, and not free-text
 * generation: the caller supplies a goal, authorized material, and typed
 * questions; the adapter maps them onto the provider's native protocol
 * (TypeSafe `systemone` is the first). See docs/design/fast-decision-model-design.md.
 */

import { HarnessInferenceSettingsValidationError } from "./harness-inference.js";

/**
 * Consumers registered for fast-decision judgments. New purposes are added
 * here. `web`/`scholarly` are the D-315 L5 consumers that batch-judge real
 * Web and scholarly candidates; they reuse the same binding/override/cancel
 * machinery as `explore`. `memory-organization` is the BC2 consumer that
 * judges whether durable source fragments carry memory-worthy content before
 * a generative pass narrates proposals. `memory-recall` is the BC3 consumer
 * that judges whether recalled memory candidates contribute to the current
 * goal before they enter a model request.
 */
export const FAST_DECISION_PURPOSES = ["explore", "web", "scholarly", "memory-organization", "memory-recall"] as const;
export type HarnessFastDecisionPurpose = (typeof FAST_DECISION_PURPOSES)[number];

export type HarnessFastDecisionProtocol = "typesafe-systemone";

/** One credential-free binding slot. Secrets stay in the Pi provider/auth layer. */
export interface HarnessFastDecisionBinding {
  protocol: HarnessFastDecisionProtocol;
  providerId: string;
  modelId: string;
  /** Provider-relative request path; the adapter default applies when absent. */
  endpoint?: string;
}

/**
 * `harness.fastDecision` — default binding plus per-purpose override or
 * explicit disable. Resolution order: purpose override, then default, then
 * unconfigured. `"off"` cannot be re-enabled by the default binding.
 */
export interface HarnessFastDecisionSettings {
  default?: HarnessFastDecisionBinding;
  purposes?: Partial<Record<HarnessFastDecisionPurpose, HarnessFastDecisionBinding | "off">>;
}

export type HarnessFastDecisionPurposeResolution =
  | { status: "ready"; binding: HarnessFastDecisionBinding }
  | { status: "disabled" }
  | { status: "unconfigured" };

/** Resolve one consumer's effective binding. Pure settings logic — no provider check. */
export function resolveFastDecisionPurpose(
  settings: HarnessFastDecisionSettings | undefined,
  purpose: HarnessFastDecisionPurpose,
): HarnessFastDecisionPurposeResolution {
  const override = settings?.purposes?.[purpose];
  if (override === "off") return { status: "disabled" };
  if (override !== undefined) return { status: "ready", binding: override };
  if (settings?.default) return { status: "ready", binding: settings.default };
  return { status: "unconfigured" };
}

/** Credential-free resolved binding identity, produced by the Pi side. */
export interface HarnessResolvedFastDecisionBinding extends HarnessFastDecisionBinding {
  configurationId: string;
}

export type HarnessFastDecisionPurposeStatus =
  | { status: "ready"; binding: HarnessResolvedFastDecisionBinding }
  | { status: "disabled" | "unconfigured" | "invalid" | "unavailable"; message?: string };

/** What a protocol can express. Consumers rely on these, not on vendor fields. */
export interface HarnessFastDecisionCapabilities {
  judge: boolean;
  choose: boolean;
  score: boolean;
  modalities: readonly string[];
  /** Provider input budget for state+questions, when the adapter knows it. */
  maxStateTokens?: number;
  maxChoiceOptions?: number;
}

export function fastDecisionCapabilities(protocol: HarnessFastDecisionProtocol): HarnessFastDecisionCapabilities {
  switch (protocol) {
    // TypeSafe Jev 1.13: text-only, 64k tokens per request, 32k for state plus
    // the longest question, up to 255 options per Choice (docs.typesafe.ai/models).
    case "typesafe-systemone":
      return { judge: true, choose: true, score: true, modalities: ["text"], maxStateTokens: 32768, maxChoiceOptions: 255 };
  }
}

/** Structured question input. Adapters may pass objects/arrays through natively. */
export type FastDecisionInstructions = string | Record<string, unknown> | readonly unknown[];

export type FastDecisionQuestion =
  | {
      id: string;
      kind: "judge";
      /** Yes/no judgment. The answer is the provider's value, not a verified fact. */
      instructions: FastDecisionInstructions;
      criteria?: { yes?: string; no?: string };
    }
  | {
      id: string;
      kind: "choose";
      instructions: FastDecisionInstructions;
      /** Candidate identities come from this request only. */
      options: ReadonlyArray<{ id: string; detail?: string }>;
      /** Ask the adapter to offer an explicit no-suitable-option choice. */
      allowNone?: boolean;
    }
  | {
      id: string;
      kind: "score";
      instructions: FastDecisionInstructions;
      /** Ordered rubric levels (adapter validates the real limit). */
      levels: readonly string[];
    };

/** Authorized material the model may judge. `id` is the only join key. */
export interface FastDecisionMaterial {
  id: string;
  text: string;
  /** Human/model-facing location, e.g. `path:12-40`. Grounding, not identity. */
  label?: string;
  revision?: string;
}

export interface HarnessFastDecisionParams {
  configurationId: string;
  providerId: string;
  modelId: string;
  protocol: HarnessFastDecisionProtocol;
  purpose: HarnessFastDecisionPurpose;
  /** The consumer's goal, e.g. the explore question. */
  goal: string;
  materials: FastDecisionMaterial[];
  questions: FastDecisionQuestion[];
  batchId: string;
  endpoint?: string;
}

export type FastDecisionAnswer =
  | { id: string; kind: "judge"; value: number }
  | {
      id: string;
      kind: "choose";
      /** `null` means the provider's explicit no-suitable-option answer. */
      choice: string | null;
      probabilities?: Record<string, number>;
      confidence?: number;
    }
  | {
      id: string;
      kind: "score";
      score: number;
      probabilities?: Record<string, number>;
      confidence?: number;
    };

export interface HarnessFastDecisionResult {
  batchId: string;
  providerId: string;
  modelId: string;
  /** Versioned model id reported by the provider, when it differs from the alias. */
  servedModelId?: string;
  answers: FastDecisionAnswer[];
  /** Question ids the provider did not answer or answered invalidly. Never false/zero. */
  missing: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const nonEmpty = (value: unknown): string | undefined => (
  typeof value === "string" && value.trim() ? value.trim() : undefined
);

const fastDecisionEndpoint = (value: unknown, path: string): string | undefined => {
  if (value === undefined) return undefined;
  const endpoint = nonEmpty(value);
  if (!endpoint) throw new HarnessInferenceSettingsValidationError(`${path} must be a non-empty string`);
  if (/^[a-z][a-z\d+.-]*:/iu.test(endpoint) || endpoint.startsWith("//") || endpoint.includes("\\")) {
    throw new HarnessInferenceSettingsValidationError(`${path} must be a provider-relative HTTP path`);
  }
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
};

const parseBinding = (value: unknown, path: string): HarnessFastDecisionBinding => {
  if (!isRecord(value)) {
    throw new HarnessInferenceSettingsValidationError(`${path} must be a binding object`);
  }
  if (value.protocol !== "typesafe-systemone") {
    throw new HarnessInferenceSettingsValidationError(`${path}.protocol must be typesafe-systemone`);
  }
  const providerId = nonEmpty(value.providerId);
  if (!providerId) throw new HarnessInferenceSettingsValidationError(`${path}.providerId must be a non-empty string`);
  const modelId = nonEmpty(value.modelId);
  if (!modelId) throw new HarnessInferenceSettingsValidationError(`${path}.modelId must be a non-empty string`);
  const endpoint = fastDecisionEndpoint(value.endpoint, `${path}.endpoint`);
  return {
    protocol: "typesafe-systemone",
    providerId,
    modelId,
    ...(endpoint === undefined ? {} : { endpoint }),
  };
};

export function parseHarnessFastDecisionSettings(value: unknown): HarnessFastDecisionSettings | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new HarnessInferenceSettingsValidationError("harness.fastDecision must be an object");
  }
  const settings: HarnessFastDecisionSettings = {};
  if (value.default !== undefined) {
    settings.default = parseBinding(value.default, "harness.fastDecision.default");
  }
  if (value.purposes !== undefined) {
    if (!isRecord(value.purposes)) {
      throw new HarnessInferenceSettingsValidationError("harness.fastDecision.purposes must be an object");
    }
    const purposes: NonNullable<HarnessFastDecisionSettings["purposes"]> = {};
    for (const [purpose, entry] of Object.entries(value.purposes)) {
      if (!FAST_DECISION_PURPOSES.includes(purpose as HarnessFastDecisionPurpose)) {
        throw new HarnessInferenceSettingsValidationError(
          `harness.fastDecision.purposes.${purpose} is not a registered purpose`,
        );
      }
      purposes[purpose as HarnessFastDecisionPurpose] = entry === "off"
        ? "off"
        : parseBinding(entry, `harness.fastDecision.purposes.${purpose}`);
    }
    settings.purposes = purposes;
  }
  return settings;
}
