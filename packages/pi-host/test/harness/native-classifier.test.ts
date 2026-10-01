import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  requestClassifier,
  ClassifierRequestError,
  ClassifierResponseError,
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
    const nativeModel = { type: "classifier" as const, provider: "local", api: "llama-cpp-classify" as const,
      id: "local-anonymous-fixture", name: "local", baseUrl: "http://localhost:8080/v1", contextWindow: 8_000,
      input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push(String(url));
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
});
