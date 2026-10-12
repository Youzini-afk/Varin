/** Varin question/result semantics over Pi native classifiers. Pi owns transport and retries. */
import { classify as classifyCloudflare } from "@earendil-works/pi-ai/api/cloudflare-workers-ai-system-one";
import { classify as classifySystemOne } from "@earendil-works/pi-ai/api/typesafe-system-one";
import { classify as classifyLlama, llamaServerRoot } from "@earendil-works/pi-ai/api/llama-cpp-classify";
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
  constructor(message: string, readonly result?: ClassifierResponse) {
    super(message);
    this.name = "ClassifierResponseError";
  }
}

export interface ClassifierRequestRoute {
  requestUrl: string;
  requestKind: "preparation" | "model_compute";
}

export const isSupportedClassifierApi = (api: string): boolean =>
  api === "typesafe-system-one" || api === "cloudflare-workers-ai-system-one" || api === "llama-cpp-classify";

/** The selected protocol owns its actual routes; credentials and transports consume this plan. */
export function classifierRequestRoutes(api: string, baseUrl: string, endpoint?: string): readonly ClassifierRequestRoute[] {
  if (api === "llama-cpp-classify") {
    if (endpoint !== undefined) throw new ClassifierRequestError("llama.cpp classification uses tokenize, apply-template and completion endpoints; configure its server base URL instead of a single endpoint override");
    const root = llamaServerRoot(baseUrl);
    return [
      { requestUrl: new URL(`${root}/tokenize`).toString(), requestKind: "preparation" },
      { requestUrl: new URL(`${root}/apply-template`).toString(), requestKind: "preparation" },
      { requestUrl: new URL(`${root}/completion`).toString(), requestKind: "model_compute" },
    ];
  }
  if (api !== "typesafe-system-one" && api !== "cloudflare-workers-ai-system-one") throw new ClassifierRequestError("Unsupported classifier API");
  return [{ requestUrl: new URL(`${baseUrl.replace(/\/+$/u, "")}${endpoint ?? (api === "typesafe-system-one" ? "/systemone" : "/run")}`).toString(), requestKind: "model_compute" }];
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

/** Interpret only the selected API's documented envelope, never guess nested answers. */
export function classifierWireOutput(api: string, body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  if (api === "typesafe-system-one" || api === "llama-cpp-classify") return body;
  if (api !== "cloudflare-workers-ai-system-one" || body.success === false || !isRecord(body.result)) return undefined;
  if ("answers" in body.result) return body.result;
  return body.result.state === "Completed" && isRecord(body.result.result) ? body.result.result : undefined;
}
/** Preserve the selected protocol's original counters, including invalid or missing dimensions. */
export function classifierRawUsage(api: string, body: unknown): unknown {
  if (api !== "llama-cpp-classify") return classifierWireOutput(api, body)?.usage ?? null;
  if (!isRecord(body)) return null;
  const entries = ["tokens_evaluated", "tokens_predicted", "tokens_cached", "timings"]
    .filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]);
  return entries.length ? Object.fromEntries(entries) : null;
}
/** Missing fields remain missing. The SDK's normalized zeroes are not provider receipts. */
export function classifierWireUsage(api: string, body: unknown): ClassifierResponse["usage"] {
  const raw = api === "llama-cpp-classify" ? body : classifierWireOutput(api, body)?.usage;
  if (!isRecord(raw)) return undefined;
  const valid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  const input = api === "llama-cpp-classify" ? raw.tokens_evaluated : raw.input_tokens;
  const output = api === "llama-cpp-classify" ? raw.tokens_predicted : raw.output_tokens;
  const inputTokens = valid(input) ? input : undefined;
  const outputTokens = valid(output) ? output : undefined;
  return inputTokens === undefined && outputTokens === undefined ? undefined : {
    ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/** Pure response interpretation is shared by durable transport receipts and caller projection. */
export function classifierWireResult(api: string, modelId: string, questions: readonly FastDecisionQuestion[], body: unknown): ClassifierResponse {
  const original = classifierWireOutput(api, body);
  const wire = original && isRecord(original.answers) ? original.answers : {};
  const answers: FastDecisionAnswer[] = [];
  const missing: string[] = [];
  for (const question of questions) {
    const answer = readAnswer(question, wire[question.id]);
    if (answer) answers.push(answer); else missing.push(question.id);
  }
  const usage = classifierWireUsage(api, body);
  const servedModelId = typeof original?.model === "string" && original.model !== modelId ? original.model : undefined;
  return { answers, missing, ...(usage ? { usage } : {}), ...(servedModelId ? { servedModelId } : {}) };
}

/** A completion can be structurally valid while a label needs a deeper SDK readout. */
export function classifierWireResponseValid(api: string, modelId: string, questions: readonly FastDecisionQuestion[], body: unknown): boolean {
  if (api !== "llama-cpp-classify") return classifierWireResult(api, modelId, questions, body).answers.length > 0;
  if (!isRecord(body) || !Array.isArray(body.completion_probabilities)) return false;
  const first: unknown = body.completion_probabilities[0];
  return isRecord(first) && Array.isArray(first.top_logprobs);
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
  const supported = isSupportedClassifierApi(nativeModel.api);
  if (!supported && !request.classify) throw new ClassifierRequestError("Unsupported classifier API without its registered implementation");
  const routes = supported ? classifierRequestRoutes(nativeModel.api, request.baseUrl, request.endpoint) : undefined;
  let captured: Record<string, unknown> | undefined;
  const computeUsage: ClassifierResponse["usage"][] = [];
  const fetchImpl = request.fetchImpl ?? fetch;
  const transport = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, transport.signal]) : transport.signal;
  const pending = new Set<Promise<Response>>();
  let result;
  try {
    result = await (request.classify ?? (nativeModel.api === "llama-cpp-classify" ? classifyLlama : nativeModel.api === "cloudflare-workers-ai-system-one" ? classifyCloudflare : classifySystemOne))(nativeModel, {
      state: isRecord(request.state) ? toJsonValue(request.state) as ClassifierContext["state"] : { input: toJsonValue(request.state) },
      questions,
    }, {
      ...(request.apiKey === undefined ? {} : { apiKey: request.apiKey }),
      ...(request.headers ? { headers: request.headers } : {}),
      signal,
      fetch: (url, init) => {
        const work = (async () => {
          signal.throwIfAborted();
          // A role override changes only this frozen request's destination. Payload,
          // authentication, cancellation and retry behavior stay with the native API.
          const destination = request.endpoint ? `${request.baseUrl.replace(/\/+$/u, "")}${request.endpoint}` : url;
          const route = routes?.find(value => value.requestUrl === new URL(String(destination)).toString());
          if (routes && !route) throw new ClassifierRequestError("Classifier request left its selected protocol routes");
          const response = await fetchImpl(destination, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
          let usage: ClassifierResponse["usage"];
          try {
            // Drain preparation responses too: the SDK can finish after a sibling fails.
            const body: unknown = await response.clone().json();
            if (!route || route.requestKind === "model_compute") {
              if (isRecord(body) && response.ok) captured = body;
              usage = classifierWireUsage(nativeModel.api, body);
            }
          } catch { /* The native adapter reports invalid JSON. */ }
          if (!route || route.requestKind === "model_compute") computeUsage.push(usage);
          return response;
        })();
        pending.add(work);
        void work.finally(() => pending.delete(work)).catch(() => {});
        return work;
      },
    });
  } finally {
    // SDK Promise.all can reject before another preparation finishes. Stop any late
    // fallback/retry, then await the original transports instead of treating abort as drain.
    if (!result || result.stopReason !== "stop" || pending.size) transport.abort();
    await Promise.allSettled([...pending]);
  }
  const original = classifierWireOutput(nativeModel.api, captured);
  const wireAnswers = nativeModel.api !== "llama-cpp-classify" && original && isRecord(original.answers) ? original.answers : undefined;
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
  const served = typeof original?.model === "string" && original.model !== request.model ? original.model : undefined;
  let usage = supported ? classifierWireUsage(nativeModel.api, captured)
    : result.usage ? { inputTokens: result.usage.input, outputTokens: result.usage.output } : undefined;
  if (nativeModel.api === "llama-cpp-classify") {
    usage = {};
    for (const field of ["inputTokens", "outputTokens"] as const) {
      if (computeUsage.length && computeUsage.every(value => value?.[field] !== undefined)) usage[field] = computeUsage.reduce((total, value) => total + value![field]!, 0);
    }
    if (!Object.keys(usage).length) usage = undefined;
  }
  const response: ClassifierResponse = {
    ...(served ? { servedModelId: served } : {}), answers, missing,
    ...(usage ? { usage } : {}),
  };
  if (request.signal?.aborted || result.stopReason !== "stop" && !wireAnswers) {
    throw new ClassifierResponseError(request.signal?.aborted ? "Classifier request cancelled" : "Classifier response is unavailable or invalid", response);
  }
  return response;
}
