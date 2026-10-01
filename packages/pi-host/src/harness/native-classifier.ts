/** Varin question/result semantics over Pi native classifiers. Pi owns transport and retries. */
import { classify as classifySystemOne } from "@earendil-works/pi-ai/api/typesafe-system-one";
import type { ClassifierContext, ClassifierFunction, ClassifierModel, ClassifierApi } from "@earendil-works/pi-ai";
import { toJsonValue } from "../json.js";
import type {
  FastDecisionAnswer,
  FastDecisionQuestion,
} from "@varin/protocol";

/** Criteria key used when the caller asks for an explicit "no suitable option". */
const NONE_OPTION = "__none__";

export interface ClassifierRequest {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  endpoint?: string;
  model: string;
  nativeModel?: ClassifierModel<ClassifierApi>;
  classify?: ClassifierFunction;
  /** Provider state value: string, object, or array. */
  state: unknown;
  questions: readonly FastDecisionQuestion[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface ClassifierResponse {
  /** Versioned model reported by the provider, when it differs from the alias sent. */
  servedModelId?: string;
  answers: FastDecisionAnswer[];
  /** Question ids the provider skipped or answered invalidly. */
  missing: string[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export class ClassifierRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierRequestError";
  }
}

export class ClassifierResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClassifierResponseError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const finiteNumber = (value: unknown): number | undefined => (
  typeof value === "number" && Number.isFinite(value) ? value : undefined
);

const probabilities = (value: unknown): Record<string, number> | null | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const entries: Array<[string, number]> = [];
  for (const [key, entry] of Object.entries(value)) {
    const n = finiteNumber(entry);
    if (n === undefined || n < 0 || n > 1) return null;
    entries.push([key, n]);
  }
  return Object.fromEntries(entries);
};

function classifierQuestion(question: FastDecisionQuestion): ClassifierContext["questions"][string] {
  const instructions = typeof question.instructions === "string" ? question.instructions : JSON.stringify(question.instructions);
  switch (question.kind) {
    case "judge":
      return {
        type: "bool", instructions,
        criteria: { true: question.criteria?.yes ?? "yes", false: question.criteria?.no ?? "no" },
      };
    case "choose": {
      if (question.options.length === 0) {
        throw new ClassifierRequestError(`choose question ${question.id} needs at least one option`);
      }
      const criteria: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const option of question.options) {
        if (option.id === NONE_OPTION) {
          throw new ClassifierRequestError(`choose question ${question.id} uses the reserved option id`);
        }
        if (Object.hasOwn(criteria, option.id)) {
          throw new ClassifierRequestError(`choose question ${question.id} has a duplicate option id`);
        }
        criteria[option.id] = option.detail ?? option.id;
      }
      if (question.allowNone) {
        criteria[NONE_OPTION] = "None of the options fits the question.";
      }
      return { type: "choice", instructions, criteria };
    }
    case "score": {
      if (question.levels.length < 2) {
        throw new ClassifierRequestError(`score question ${question.id} needs at least two rubric levels`);
      }
      return { type: "score", instructions, criteria: [...question.levels] };
    }
  }
}

function readAnswer(question: FastDecisionQuestion, raw: unknown): FastDecisionAnswer | undefined {
  if (!isRecord(raw)) return undefined;
  switch (question.kind) {
    case "judge": {
      if (raw.type !== "noul") return undefined;
      const value = finiteNumber(raw.noul);
      if (value === undefined || value < 0 || value > 1) return undefined;
      return { id: question.id, kind: "judge", value };
    }
    case "choose": {
      if (raw.type !== "choice") return undefined;
      const choice = raw.choice;
      if (typeof choice !== "string") return undefined;
      const valid = choice === NONE_OPTION
        ? Boolean(question.allowNone)
        : question.options.some((option) => option.id === choice);
      if (!valid) return undefined;
      const probs = probabilities(raw.probabilities);
      if (probs === null) return undefined;
      if (probs && Object.keys(probs).some((key) => (
        key !== NONE_OPTION && !question.options.some((option) => option.id === key)
      ))) return undefined;
      const confidence = finiteNumber(raw.confidence);
      if (raw.confidence !== undefined && (confidence === undefined || confidence < 0 || confidence > 1)) return undefined;
      return {
        id: question.id,
        kind: "choose",
        choice: choice === NONE_OPTION ? null : choice,
        ...(probs ? { probabilities: probs } : {}),
        ...(confidence === undefined ? {} : { confidence }),
      };
    }
    case "score": {
      if (raw.type !== "score") return undefined;
      const score = finiteNumber(raw.score);
      if (score === undefined || score < 0 || score > question.levels.length - 1) return undefined;
      const probs = probabilities(raw.probabilities);
      if (probs === null) return undefined;
      if (probs && Object.keys(probs).some((key) => {
        const level = Number(key);
        return !Number.isInteger(level) || level < 0 || level >= question.levels.length;
      })) return undefined;
      const confidence = finiteNumber(raw.confidence);
      if (raw.confidence !== undefined && (confidence === undefined || confidence < 0 || confidence > 1)) return undefined;
      return {
        id: question.id,
        kind: "score",
        score,
        ...(probs ? { probabilities: probs } : {}),
        ...(confidence === undefined ? {} : { confidence }),
      };
    }
  }
}

export async function requestClassifier(request: ClassifierRequest): Promise<ClassifierResponse> {
  const questions = Object.create(null) as ClassifierContext["questions"];
  for (const question of request.questions) {
    if (Object.hasOwn(questions, question.id)) throw new ClassifierRequestError(`duplicate question id ${question.id}`);
    questions[question.id] = classifierQuestion(question);
  }
  const nativeModel = request.nativeModel ?? {
    type: "classifier", provider: "typesafe", api: "typesafe-system-one", id: request.model,
    name: request.model, input: ["text"], baseUrl: request.baseUrl, contextWindow: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (nativeModel.api === "llama-cpp-classify" && request.endpoint) {
    throw new ClassifierRequestError("llama.cpp classification uses tokenize, apply-template and completion endpoints; configure its server base URL instead of a single endpoint override");
  }
  let captured: Record<string, unknown> | undefined;
  const fetchImpl = request.fetchImpl ?? fetch;
  const result = await (request.classify ?? classifySystemOne)(nativeModel, {
    state: isRecord(request.state) ? toJsonValue(request.state) as ClassifierContext["state"] : { input: toJsonValue(request.state) },
    questions,
  }, {
    ...(request.apiKey === undefined ? {} : { apiKey: request.apiKey }),
    ...(request.headers ? { headers: request.headers } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
    fetch: async (url, init) => {
      // A role override changes only this frozen request's destination. Payload,
      // authentication, cancellation and retry behavior stay with the native API.
      const destination = request.endpoint ? `${request.baseUrl.replace(/\/+$/u, "")}${request.endpoint}` : url;
      const response = await fetchImpl(destination, init);
      if (response.ok) {
        try {
          const body: unknown = await response.clone().json();
          if (isRecord(body)) captured = body;
        } catch { /* The native adapter reports invalid JSON. */ }
      }
      return response;
    },
  });
  request.signal?.throwIfAborted();
  const wireAnswers = captured && isRecord(captured.answers) ? captured.answers : undefined;
  if (result.stopReason !== "stop" && !wireAnswers) {
    throw new ClassifierResponseError(result.errorMessage ?? `Classifier request ended with ${result.stopReason}`);
  }
  const answers: FastDecisionAnswer[] = [];
  const missing: string[] = [];
  for (const question of request.questions) {
    const native = result.answers[question.id];
    const wire = native?.type === "bool" ? { type: "noul", noul: native.probability } : native;
    // Native System One currently fails the whole result on a skipped answer.
    // Keep valid partial answers under Varin's existing missing-answer contract.
    const answer = readAnswer(question, wire ?? wireAnswers?.[question.id]);
    if (answer) answers.push(answer); else missing.push(question.id);
  }
  const served = typeof captured?.model === "string" && captured.model !== request.model ? captured.model : undefined;
  return {
    ...(served ? { servedModelId: served } : {}), answers, missing,
    ...(result.usage ? { usage: { inputTokens: result.usage.input, outputTokens: result.usage.output } } : {}),
  };
}
