import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestClassifier,
  ClassifierRequestError,
  ClassifierResponseError,
  classifierWireUsage,
  classifierRawUsage,
} from "../../src/harness/native-classifier.js";
import type { FastDecisionQuestion } from "@varin/protocol";
import { classify as classifyLlama } from "@earendil-works/pi-ai/api/llama-cpp-classify";

const jsonResponse = (status: number, body: unknown) => (
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
);

const judge: FastDecisionQuestion = {
  id: "m:v1",
  kind: "judge",
  instructions: { question: "keep?", material: "v1" },
  criteria: { yes: "relevant", no: "noise" },
};
const choose: FastDecisionQuestion = {
  id: "a:next",
  kind: "choose",
  instructions: "pick a step",
  options: [{ id: "read:b.ts", detail: "read callee" }, { id: "symbol:foo", detail: JSON.stringify({ purpose: "inspect implementation" }) }],
  allowNone: true,
};
const score: FastDecisionQuestion = {
  id: "s:v1",
  kind: "score",
  instructions: "rate relevance",
  levels: ["unrelated", "partial", "direct"],
};

describe("Varin semantics over native Pi classifiers", () => {
  it("uses native llama.cpp token probabilities without requiring an API key", async () => {
    const requests: string[] = [];
    const signals: AbortSignal[] = [];
    const nativeModel = { type: "classifier" as const, provider: "local", api: "llama-cpp-classify" as const,
      id: "local-anonymous-fixture", name: "local", baseUrl: "http://localhost:8080/v1", contextWindow: 8_000,
      input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push(String(url));
      if (init?.signal) signals.push(init.signal);
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      const body = JSON.parse(String(init?.body)) as { content?: string };
      if (String(url).endsWith("/tokenize")) return jsonResponse(200, {
        tokens: body.content === "\n" ? [1] : body.content === "\nYes" ? [1, 2] : [1, 3],
      });
      if (String(url).endsWith("/apply-template")) return jsonResponse(200, { prompt: "fixture prompt" });
      assert.ok(String(url).endsWith("/completion"));
      return jsonResponse(200, { completion_probabilities: [{ top_logprobs: [
        { id: 2, logprob: 0 }, { id: 3, logprob: -2 },
      ] }] });
    };
    const result = await requestClassifier({ baseUrl: nativeModel.baseUrl, model: nativeModel.id,
      nativeModel, classify: classifyLlama, state: "local evidence", questions: [judge], fetchImpl });
    assert.deepEqual(result.missing, []);
    assert.equal(result.answers[0]?.kind, "judge");
    if (result.answers[0]?.kind === "judge") assert.ok(result.answers[0].value > 0.8);
    assert.equal(result.usage, undefined, "the provider did not report usage");
    assert.ok(requests.every(url => url.startsWith("http://localhost:8080/")));
    assert(signals.every(signal => !signal.aborted), "normal completed transports are not cancelled during cleanup");
    await assert.rejects(() => requestClassifier({ baseUrl: nativeModel.baseUrl, model: nativeModel.id,
      nativeModel, classify: classifyLlama, state: "local evidence", questions: [judge], fetchImpl,
      endpoint: "/one-endpoint" }), /several|tokenize/);
  });

  it("maps typed questions onto the native questions protocol and parses every answer kind", async () => {
    let seenBody: Record<string, unknown> | undefined;
    let seenUrl = "";
    let seenAuth: string | null = null;
    const result = await requestClassifier({
      baseUrl: "https://jev.example/api",
      apiKey: "secret",
      model: "jev-1.13",
      state: { goal: "how does callee work", materials: [{ id: "v1" }] },
      questions: [judge, choose, score],
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenAuth = new Headers(init?.headers).get("authorization");
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(200, {
          model: "jev-1.13-2026-09",
          answers: {
            "m:v1": { type: "noul", noul: 0.87 },
            "a:next": { type: "choice", choice: "read:b.ts", probabilities: { "read:b.ts": 0.8, "symbol:foo": 0.1 }, confidence: 0.9 },
            "s:v1": { type: "score", score: 2, confidence: 0.95 },
          },
          usage: { input_tokens: 512, output_tokens: 9 },
        });
      },
    });
    assert.equal(seenUrl, "https://jev.example/api/systemone");
    assert.equal(seenAuth, "Bearer secret");
    assert.equal(seenBody?.model, "jev-1.13");
    const questions = seenBody?.questions as Record<string, Record<string, unknown>>;
    assert.equal(questions["m:v1"]?.type, "noul");
    assert.deepEqual(questions["m:v1"]?.criteria, { true: "relevant", false: "noise" });
    assert.equal(questions["a:next"]?.type, "choice");
    const criteria = questions["a:next"]?.criteria as Record<string, unknown>;
    assert.ok(Object.hasOwn(criteria, "read:b.ts"));
    assert.equal(criteria["symbol:foo"], JSON.stringify({ purpose: "inspect implementation" }));
    assert.ok(Object.hasOwn(criteria, "__none__"));
    assert.equal(questions["s:v1"]?.type, "score");
    assert.deepEqual(questions["s:v1"]?.criteria, ["unrelated", "partial", "direct"]);

    assert.equal(result.servedModelId, "jev-1.13-2026-09");
    assert.deepEqual(result.usage, { inputTokens: 512, outputTokens: 9 });
    const byId = new Map(result.answers.map((answer) => [answer.id, answer]));
    assert.deepEqual(byId.get("m:v1"), { id: "m:v1", kind: "judge", value: 0.87 });
    const choice = byId.get("a:next");
    assert.equal(choice?.kind, "choose");
    if (choice?.kind === "choose") assert.equal(choice.choice, "read:b.ts");
    const scored = byId.get("s:v1");
    assert.equal(scored?.kind, "score");
    if (scored?.kind === "score") assert.equal(scored.score, 2);
    assert.deepEqual(result.missing, []);
  });

  it("reports unanswered and invalid answers as missing instead of reinterpreting them", async () => {
    const result = await requestClassifier({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [judge, choose, score],
      fetchImpl: async () => jsonResponse(200, {
        answers: {
          "m:v1": { type: "noul", noul: 1.5 },
          "a:next": { type: "choice", choice: "read:other.ts" },
          "s:v1": { type: "score", score: 1 },
        },
        usage: { input_tokens: 450, output_tokens: 3 },
      }),
    });
    assert.deepEqual(result.missing.sort(), ["a:next", "m:v1"]);
    assert.equal(result.answers.length, 1);
    assert.equal(result.answers[0]?.id, "s:v1");
    assert.deepEqual(result.usage, { inputTokens: 450, outputTokens: 3 });

    const noneChosen = await requestClassifier({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [choose],
      fetchImpl: async () => jsonResponse(200, {
        answers: { "a:next": { type: "choice", choice: "__none__" } },
      }),
    });
    assert.equal(noneChosen.answers[0]?.kind, "choose");
    if (noneChosen.answers[0]?.kind === "choose") assert.equal(noneChosen.answers[0].choice, null);
  });

  it("preserves question and option IDs that match object prototype keys", async () => {
    const result = await requestClassifier({ baseUrl: "https://jev.example", apiKey: "secret", model: "jev-1.13",
      state: "evidence", questions: [{ id: "__proto__", kind: "choose", instructions: "choose",
        options: [{ id: "__proto__", detail: "valid option" }] }],
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria: Record<string, string> }> };
        assert.ok(Object.hasOwn(body.questions, "__proto__"));
        assert.equal(body.questions.__proto__?.criteria.__proto__, "valid option");
        return jsonResponse(200, { answers: Object.fromEntries([["__proto__", {
          type: "choice", choice: "__proto__", probabilities: Object.fromEntries([["__proto__", 1]]), confidence: 1,
        }]]) });
      },
    });
    assert.deepEqual(result.missing, []);
    const answer = result.answers[0];
    assert.equal(answer?.kind, "choose");
    if (answer?.kind === "choose") {
      assert.equal(answer.choice, "__proto__");
      assert.ok(Object.hasOwn(answer.probabilities!, "__proto__"));
      assert.equal(answer.probabilities?.__proto__, 1);
    }
  });

  it("honors a provider-relative endpoint and rejects transport/contract failures", async () => {
    let seenUrl = "";
    await requestClassifier({
      baseUrl: "https://jev.example/root/",
      apiKey: "secret",
      endpoint: "/custom/systemone",
      model: "jev-1.13",
      state: "goal",
      questions: [judge],
      fetchImpl: async (url) => {
        seenUrl = String(url);
        return jsonResponse(200, { answers: { "m:v1": { type: "noul", noul: 1 } } });
      },
    });
    assert.equal(seenUrl, "https://jev.example/root/custom/systemone");

    await assert.rejects(() => requestClassifier({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [judge],
      fetchImpl: async () => jsonResponse(503, { error: "down" }),
    }), ClassifierResponseError);
    await assert.rejects(() => requestClassifier({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [judge],
      fetchImpl: async () => jsonResponse(200, { ok: true }),
    }), ClassifierResponseError);
  });

  it("rejects malformed questions before any HTTP request", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return jsonResponse(200, { answers: {} });
    };
    await assert.rejects(() => requestClassifier({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [judge, { ...judge }],
      fetchImpl,
    }), ClassifierRequestError);
    await assert.rejects(() => requestClassifier({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [{ id: "c", kind: "choose", instructions: "x", options: [{ id: "__none__" }] }],
      fetchImpl,
    }), ClassifierRequestError);
    await assert.rejects(() => requestClassifier({
      baseUrl: "https://jev.example",
      apiKey: "secret",
      model: "jev-1.13",
      state: "goal",
      questions: [{ id: "s", kind: "score", instructions: "x", levels: ["only"] }],
      fetchImpl,
    }), ClassifierRequestError);
    assert.equal(calls, 0);
  });
  for (const nested of [false, true]) it(`preserves Cloudflare ${nested ? 'Completed' : 'direct'} partial answers and missing usage fields`, async () => {
    const nativeModel = { type: 'classifier' as const, api: 'cloudflare-workers-ai-system-one' as const,
      provider: 'cloudflare', id: 'typesafe/jev', name: 'fixture', baseUrl: 'https://cloudflare.invalid/accounts/fake/ai',
      contextWindow: 0, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const result = await requestClassifier({ nativeModel, baseUrl: nativeModel.baseUrl, apiKey: 'fixture-only',
      model: nativeModel.id, state: 'actual candidates', questions: [judge, score], fetchImpl: async (url, init) => {
        assert.equal(String(url), 'https://cloudflare.invalid/accounts/fake/ai/run');
        const wire = JSON.parse(String(init?.body));
        assert.equal(wire.model, nativeModel.id);
        assert.equal(wire.input.questions['s:v1'].type, 'score');
        const output = { answers: { 's:v1': { type: 'score', score: 0 } }, usage: { input_tokens: 13 } };
        return jsonResponse(200, { success: true, result: nested ? { state: 'Completed', result: output } : output });
      } });
    assert.deepEqual(result.answers, [{ id: 's:v1', kind: 'score', score: 0 }]);
    assert.deepEqual(result.missing, ['m:v1']);
    assert.deepEqual(result.usage, { inputTokens: 13 });
  });

  it('retains received usage for invalid answers and cancellation after the complete response', async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      await assert.rejects(requestClassifier({ baseUrl: 'https://typesafe.invalid', model: 'fixture', apiKey: 'fixture-only',
        state: 'evidence', questions: [score], signal: controller.signal, fetchImpl: async () => {
          if (cancel) controller.abort();
          return jsonResponse(200, { ...(cancel ? { answers: { 's:v1': { type: 'score', score: 0 } } } : {}),
            usage: { input_tokens: 19, output_tokens: 4 } });
        } }), error => {
        assert(error instanceof ClassifierResponseError);
        assert.deepEqual(error.result?.usage, { inputTokens: 19, outputTokens: 4 });
        assert.equal(error.result?.answers.length, cancel ? 1 : 0);
        return true;
      });
    }
  });

});

const llamaModel = (id: string) => ({ type: 'classifier' as const, provider: 'local', api: 'llama-cpp-classify' as const,
  id, name: id, baseUrl: 'https://llama.invalid/root/v1/', contextWindow: 8000,
  input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const llamaBody = { tokens_evaluated: 12, tokens_predicted: 1, tokens_cached: 9,
  completion_probabilities: [{ top_logprobs: [{ id: 2, logprob: 0 }, { id: 3, logprob: -2 }] }] };
const llamaPreparation = (url: string, body: { content?: string }) => url.endsWith('/tokenize')
  ? Response.json({ tokens: body.content === '\n' ? [1] : body.content === '\nYes' ? [1, 2] : [1, 3] })
  : url.endsWith('/apply-template') ? Response.json({ prompt: 'fixture prompt' }) : undefined;

it('isolates real SDK label preparation across simultaneous callers and credential headers', async () => {
  const model = llamaModel('isolated-callers');
  const cancelled = new AbortController();
  let started!: () => void;
  const pending = new Promise<void>(resolve => { started = resolve; });
  const first = requestClassifier({ nativeModel: model, baseUrl: model.baseUrl, model: model.id,
    state: 'a', questions: [judge], signal: cancelled.signal, headers: { 'x-account': 'first' },
    fetchImpl: async (url, init) => {
      assert.equal(new Headers(init?.headers).get('x-account'), 'first');
      if (String(url).endsWith('/tokenize')) {
        started();
        await new Promise<void>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }));
      }
      return Response.json({ prompt: 'first' });
    } });
  const rejected = assert.rejects(first, ClassifierResponseError);
  await pending;
  let ownTokenizations = 0;
  const second = await requestClassifier({ nativeModel: model, baseUrl: model.baseUrl, model: model.id,
    state: 'b', questions: [judge], headers: { 'x-account': 'second' }, fetchImpl: async (url, init) => {
      assert.equal(new Headers(init?.headers).get('x-account'), 'second');
      if (String(url).endsWith('/tokenize')) ownTokenizations++;
      const prepared = llamaPreparation(String(url), JSON.parse(String(init?.body)));
      if (prepared) return prepared;
      cancelled.abort();
      return Response.json(llamaBody);
    } });
  await rejected;
  assert.equal(ownTokenizations, 4);
  assert.equal(second.answers.length, 1);
  assert.deepEqual(second.usage, { inputTokens: 12, outputTokens: 1 });
});

it('retains completed questions and each retry/readout usage when a later llama question fails', async () => {
  const model = llamaModel('partial-questions');
  const depths: number[] = [];
  let completions = 0;
  await assert.rejects(requestClassifier({ nativeModel: model, baseUrl: model.baseUrl, model: model.id,
    state: 'evidence', questions: [judge, { ...judge, id: 'later' }], fetchImpl: async (url, init) => {
      const wire = JSON.parse(String(init?.body));
      const prepared = llamaPreparation(String(url), wire);
      if (prepared) return prepared;
      depths.push(wire.n_probs); completions++;
      if (completions === 1) return Response.json({ tokens_evaluated: 3, tokens_predicted: 0 }, { status: 503, headers: { 'retry-after': '0' } });
      if (completions === 2) return Response.json({ ...llamaBody, completion_probabilities: [{ top_logprobs: [{ id: 2, logprob: 0 }] }] });
      if (completions === 3) return Response.json(llamaBody);
      return Response.json({ tokens_evaluated: 7, tokens_predicted: 1, completion_probabilities: [] });
    } }), error => {
      assert(error instanceof ClassifierResponseError);
      assert.equal(error.result?.answers[0]?.id, judge.id);
      assert.deepEqual(error.result?.missing, ['later']);
      assert.deepEqual(error.result?.usage, { inputTokens: 34, outputTokens: 3 });
      return true;
    });
  assert.deepEqual(depths, [256, 256, 4096, 256]);
});

it('waits for an aborted preparation body to drain and prevents late fallback requests', async () => {
  const model = llamaModel('drained-preparation');
  let abortSeen!: () => void, drain!: () => void;
  const aborted = new Promise<void>(resolve => { abortSeen = resolve; });
  const drained = new Promise<void>(resolve => { drain = resolve; });
  let completed = false, requests = 0;
  const work = requestClassifier({ nativeModel: model, baseUrl: model.baseUrl, model: model.id,
    state: 'evidence', questions: [judge], fetchImpl: async (url, init) => {
      requests++;
      if (String(url).endsWith('/tokenize')) return Response.json({ invalid: true });
      assert(String(url).endsWith('/apply-template'));
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        init!.signal!.addEventListener('abort', () => {
          abortSeen();
          void drained.then(() => controller.error(new DOMException('drained', 'AbortError')));
        }, { once: true });
      } });
      return new Response(stream);
    } });
  void work.finally(() => { completed = true; }).catch(() => {});
  const rejected = assert.rejects(work, ClassifierResponseError);
  await aborted;
  assert.equal(completed, false);
  const originalRequests = requests;
  drain();
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, originalRequests);
});

it('reads only real native completion counters, retaining partial and raw usage without estimates', () => {
  const raw = { tokens_evaluated: 0, tokens_predicted: -1, tokens_cached: 5,
    timings: { prompt_n: 7, predicted_n: 1 }, n_predict: 1 };
  assert.deepEqual(classifierWireUsage('llama-cpp-classify', raw), { inputTokens: 0 });
  assert.deepEqual(classifierRawUsage('llama-cpp-classify', raw), {
    tokens_evaluated: 0, tokens_predicted: -1, tokens_cached: 5, timings: raw.timings,
  });
  assert.equal(classifierWireUsage('llama-cpp-classify', { timings: raw.timings, n_predict: 1 }), undefined);
  assert.deepEqual(classifierWireUsage('llama-cpp-classify', { tokens_evaluated: Number.MAX_SAFE_INTEGER + 1, tokens_predicted: 1 }), { outputTokens: 1 });
});

it('preserves an explicitly registered custom classifier protocol, routing and its own usage', async () => {
  const model = { ...llamaModel('custom'), api: 'fixture-custom-classifier' };
  let actual = '';
  const result = await requestClassifier({ nativeModel: model, baseUrl: model.baseUrl, model: model.id,
    state: 'evidence', questions: [judge], fetchImpl: async url => { actual = String(url); return Response.json({ custom: true }); },
    classify: async (selected, context, options) => {
      assert.equal(selected.api, model.api);
      const response = await options!.fetch!('https://custom.invalid/own-route', { method: 'POST', body: '{}' });
      assert.deepEqual(await response.json(), { custom: true });
      return { api: selected.api, provider: selected.provider, model: selected.id, stopReason: 'stop', timestamp: Date.now(),
        answers: { [Object.keys(context.questions)[0]!]: { type: 'bool', probability: 0.25 } },
        usage: { input: 27, output: 5, totalTokens: 32, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    } });
  assert.equal(actual, 'https://custom.invalid/own-route');
  assert.deepEqual(result.answers, [{ id: judge.id, kind: 'judge', value: 0.25 }]);
  assert.deepEqual(result.usage, { inputTokens: 27, outputTokens: 5 });
  await assert.rejects(requestClassifier({ nativeModel: model, baseUrl: model.baseUrl, model: model.id,
    state: 'evidence', questions: [judge] }), /registered implementation/);
});
