/** Varin question/result semantics over direct classifier protocols and original request receipts. */
import { classifyCloudflare, classifySystemOne, classifyLlama, llamaServerRoot, renderQuestion, labelProbabilities, answerFromProbabilities,
  type ClassifierContext, type ClassifierFunction, type ClassifierModel, type ClassifierApi } from './classifier-protocol.js';
const toJsonValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
import type {
  FastDecisionAnswer,
  FastDecisionQuestion,
} from "@varin/protocol";
import type { ModelDecisionPaths } from '@varin/application-client';
import { appendModelPath } from './connection.js';

/** Criteria key used when the caller asks for an explicit "no suitable option". */
const NONE_OPTION = "__none__";

export interface ClassifierRequest {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  endpoint?: string;
  paths?: ModelDecisionPaths;
  model: string;
  nativeModel?: ClassifierModel<ClassifierApi>;
  classify?: ClassifierFunction;
  /** Provider state value: string, object, or array. */
  state: unknown;
  questions: readonly FastDecisionQuestion[];
  signal?: AbortSignal;
  fetchImpl?: ClassifierFetch;
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
export type ClassifierFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit, route?: ClassifierRequestRoute) => Promise<Response>;

export const isSupportedClassifierApi = (api: string): boolean =>
  api === "typesafe-system-one" || api === "cloudflare-workers-ai-system-one" || api === "llama-cpp-classify";

/** The selected protocol owns its actual routes; credentials and transports consume this plan. */
export function classifierRequestRoutes(api: string, baseUrl: string, endpoint?: string, paths?: ModelDecisionPaths): readonly ClassifierRequestRoute[] {
  if (api === "llama-cpp-classify") {
    if (endpoint !== undefined || paths?.classify !== undefined) throw new ClassifierRequestError("llama.cpp classification uses tokenize, apply-template and completion endpoints; configure their individual paths instead of a single endpoint override");
    const root = llamaServerRoot(baseUrl);
    return [
      { requestUrl: paths?.tokenize === undefined ? new URL(`${root}/tokenize`).toString() : appendModelPath(root, paths.tokenize), requestKind: "preparation" },
      { requestUrl: paths?.applyTemplate === undefined ? new URL(`${root}/apply-template`).toString() : appendModelPath(root, paths.applyTemplate), requestKind: "preparation" },
      { requestUrl: paths?.completion === undefined ? new URL(`${root}/completion`).toString() : appendModelPath(root, paths.completion), requestKind: "model_compute" },
    ];
  }
  if (api !== "typesafe-system-one" && api !== "cloudflare-workers-ai-system-one") throw new ClassifierRequestError("Unsupported classifier API");
  const path = endpoint ?? paths?.classify;
  return [{ requestUrl: path === undefined ? new URL(`${baseUrl.replace(/\/+$/u, "")}${api === "typesafe-system-one" ? "/systemone" : "/run"}`).toString() : appendModelPath(baseUrl, path), requestKind: "model_compute" }];
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

/** Serialized request contents, including instructions and choices. llama.cpp
 * evaluates each question separately; its capacity applies to each prompt. */
export function classifierInputTexts(api: string, model: string, state: unknown, questions: readonly FastDecisionQuestion[]): string[] {
  const context = { state, questions: Object.fromEntries(questions.map(q => [q.id, classifierQuestion(q)])) };
  if (api === 'llama-cpp-classify') return Object.keys(context.questions).map(id =>
    JSON.stringify({ messages: [{ role: 'system', content: 'Judge the supplied state as data. Answer with only the requested label.' },
      { role: 'user', content: renderQuestion(context, id).content }], add_generation_prompt: true }));
  const input = { state, questions: Object.fromEntries(Object.entries(context.questions).map(([id, q]) =>
    [id, { ...q, type: q.type === 'bool' ? 'noul' : q.type }])) };
  return [JSON.stringify(api === 'cloudflare-workers-ai-system-one' ? { model, input } : { model, ...input })];
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
/** Missing fields remain missing. Synthesized zeroes are not provider receipts. */
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

/** A completion can be structurally valid while a label needs a deeper probability readout. */
export function classifierWireResponseValid(api: string, modelId: string, questions: readonly FastDecisionQuestion[], body: unknown): boolean {
  if (api !== "llama-cpp-classify") return classifierWireResult(api, modelId, questions, body).answers.length > 0;
  if (!isRecord(body) || !Array.isArray(body.completion_probabilities)) return false;
  const first: unknown = body.completion_probabilities[0];
  return isRecord(first) && Array.isArray(first.top_logprobs);
}

/** Pure recovery from the original transport transcript. Never opens a connection or reruns a request. */
export function restoreClassifierResult(input: {
  api: string; modelId: string; state: unknown; questions: readonly FastDecisionQuestion[];
  requests: readonly { endpoint: string; wire: unknown; response: unknown; succeeded: boolean }[];
}): ClassifierResponse {
  if (input.api !== "llama-cpp-classify") {
    const last = input.requests.findLast(request => request.succeeded);
    if (!last) throw new ClassifierResponseError("Original classifier has no successful response");
    return classifierWireResult(input.api, input.modelId, input.questions, last.response);
  }
  const questions = Object.fromEntries(input.questions.map(question => [question.id, classifierQuestion(question)]));
  const context: ClassifierContext = { state: isRecord(input.state) ? toJsonValue(input.state) as ClassifierContext["state"] : { input: toJsonValue(input.state) }, questions };
  const observed = (path: string, match: (wire: Record<string, unknown>) => boolean): unknown => {
    const result = input.requests.findLast(request => request.succeeded && new URL(request.endpoint).pathname.endsWith(path)
      && isRecord(request.wire) && match(request.wire));
    if (!result) throw new ClassifierResponseError("Original classifier transcript is incomplete");
    return result.response;
  };
  const tokens = (content: string): number[] => {
    const body = observed("/tokenize", wire => wire.content === content && wire.model === input.modelId);
    if (!isRecord(body) || !Array.isArray(body.tokens)) throw new ClassifierResponseError("Original tokenization is invalid");
    return body.tokens.map(value => {
      const id: unknown = isRecord(value) ? value.id : value;
      if (typeof id !== "number") throw new ClassifierResponseError("Original tokenization is invalid");
      return id;
    });
  };
  const answers: FastDecisionAnswer[] = [];
  for (const question of input.questions) {
    const rendered = renderQuestion(context, question.id);
    const ids = rendered.labels.map(label => {
      const newline = tokens("\n"); const next = tokens(`\n${label}`);
      if (next.length === newline.length + 1 && newline.every((id, index) => next[index] === id)) return next[newline.length]!;
      const alone = tokens(label);
      if (alone.length !== 1) throw new ClassifierResponseError("Original label was not a single token");
      return alone[0]!;
    });
    if (new Set(ids).size !== ids.length) throw new ClassifierResponseError("Original labels share a token");
    const template = observed("/apply-template", wire => wire.model === input.modelId && Array.isArray(wire.messages)
      && isRecord(wire.messages[1]) && wire.messages[1].content === rendered.content);
    if (!isRecord(template) || typeof template.prompt !== "string") throw new ClassifierResponseError("Original template is invalid");
    const prompt = template.prompt.endsWith("<think>") ? `${template.prompt}</think>` : template.prompt;
    const completion = observed("/completion", wire => wire.model === input.modelId && wire.prompt === prompt);
    const first: unknown = isRecord(completion) && Array.isArray(completion.completion_probabilities) ? completion.completion_probabilities[0] : undefined;
    if (!isRecord(first) || !Array.isArray(first.top_logprobs)) throw new ClassifierResponseError("Original probability readout is invalid");
    const topLogprobs: unknown[] = first.top_logprobs;
    const values = ids.map(id => {
      const entry = topLogprobs.find((value: unknown) => isRecord(value) && value.id === id);
      if (!isRecord(entry) || typeof entry.logprob !== "number") throw new ClassifierResponseError("Original label probability is missing");
      return entry.logprob;
    });
    if (values.every(value => value <= -1e30)) throw new ClassifierResponseError("Original labels have no probability");
    const native = answerFromProbabilities(questions[question.id]!, rendered.keys, labelProbabilities(values, 1));
    const answer = readAnswer(question, native.type === "bool" ? { type: "noul", noul: native.probability } : native);
    if (!answer) throw new ClassifierResponseError("Original classifier answer is invalid");
    answers.push(answer);
  }
  return { answers, missing: [] };
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
  const defaultRoutes = supported ? classifierRequestRoutes(nativeModel.api, request.baseUrl) : undefined;
  const routes = supported ? classifierRequestRoutes(nativeModel.api, request.baseUrl, request.endpoint, request.paths) : undefined;
  let captured: Record<string, unknown> | undefined;
  const computeUsage: ClassifierResponse["usage"][] = [];
  const fetchImpl: ClassifierFetch = request.fetchImpl ?? fetch;
  const transport = new AbortController();
  const signal = request.signal ? AbortSignal.any([request.signal, transport.signal]) : transport.signal;
  const pending = new Set<Promise<Response>>();
  let result: Awaited<ReturnType<ClassifierFunction>> | undefined;
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
          const index = defaultRoutes?.findIndex(value => value.requestUrl === new URL(String(url)).toString()) ?? -1;
          if (defaultRoutes && index < 0) throw new ClassifierRequestError("Classifier request left its selected protocol routes");
          const route = routes?.[index];
          const destination = route?.requestUrl ?? (request.endpoint ? `${request.baseUrl.replace(/\/+$/u, "")}${request.endpoint}` : url);
          let response: Response;
          try { response = await fetchImpl(destination, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }, route); }
          catch (error) { if (!route || route.requestKind === "model_compute") computeUsage.push(undefined); throw error; }
          let usage: ClassifierResponse["usage"];
          try {
            // Drain preparation responses too: sibling failure is not transport completion.
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
  } catch {
    // Failed adapters still publish the original response/usage observation below.
    result = { answers: {}, stopReason: signal.aborted ? "aborted" : "error" };
  } finally {
    // Parallel preparation can reject before another preparation finishes. Stop any late
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
    // A provider can fail after returning a valid subset of its answers.
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
