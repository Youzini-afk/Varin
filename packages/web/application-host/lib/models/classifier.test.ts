import { expect, it } from 'vitest';
import { requestClassifier, ClassifierResponseError } from './classifier.js';
const model = { api: 'llama-cpp-classify' as const, id: 'test-classifier', baseUrl: 'https://llama.invalid/router/v1' };
const questions = [{ id: 'one', kind: 'score' as const, instructions: 'Evaluate one', levels: ['bad', 'good'] }];
const request = { baseUrl: model.baseUrl, model: model.id, nativeModel: model, state: { task: 'test' }, questions };
interface RequestBody { content: string; messages: { content: string }[]; model: string; n_probs: number; post_sampling_probs: boolean }
const bodyOf = (init?: RequestInit) => JSON.parse(String(init?.body)) as RequestBody;
const tokenize = (body: RequestBody) => Response.json({ tokens: [...body.content].map((char: string) => char.codePointAt(0)) });
const completion = (input: number, labels = ['0', '1']) => Response.json({ tokens_evaluated: input, tokens_predicted: 1,
  completion_probabilities: [{ top_logprobs: labels.map(label => ({ id: label.codePointAt(0), logprob: label === '0' ? 0 : -1e30 })) }] });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

it.each([false, true])('uses custom llama.cpp paths with shared endpoint=%s while retaining payloads and compute usage', async shared => {
  const seen = new Set<string>();
  const kinds = new Set<string>();
  const result = await requestClassifier({ ...request, paths: { tokenize: shared ? '/custom/run' : '/custom/tokens', applyTemplate: shared ? '/custom/run' : '/custom/template', completion: '/custom/run' },
    fetchImpl: async (url, init, route) => {
      const destination = String(url); seen.add(destination);
      const body = bodyOf(init);
      expect(body.model).toBe(model.id);
      expect(route?.requestUrl).toBe(destination);
      kinds.add(route!.requestKind);
      if (route?.requestKind === 'preparation') {
        if (typeof body.content === 'string') {
          expect(destination).toBe(`https://llama.invalid/router/custom/${shared ? 'run' : 'tokens'}`);
          return tokenize(body);
        }
        expect(destination).toBe(`https://llama.invalid/router/custom/${shared ? 'run' : 'template'}`);
        return Response.json({ prompt: body.messages[1]!.content });
      }
      expect(destination).toBe('https://llama.invalid/router/custom/run');
      return completion(13);
    } });
  expect(seen.size).toBe(shared ? 1 : 3);
  expect(kinds).toEqual(new Set(['preparation', 'model_compute']));
  expect(result).toMatchObject({ answers: [{ id: 'one', score: 0 }], missing: [], usage: { inputTokens: 13, outputTokens: 1 } });
});

it('keeps deeper probability readout usage while leaving transport retries to its owner', async () => {
  const depths: number[] = [];
  const result = await requestClassifier({ ...request, fetchImpl: async (url, init) => {
    const body = bodyOf(init);
    expect(body.model).toBe(model.id);
    if (String(url).endsWith('/tokenize')) return tokenize(body);
    if (String(url).endsWith('/apply-template')) return Response.json({ prompt: body.messages[1]!.content });
    expect(body.post_sampling_probs).toBe(false); depths.push(body.n_probs);
    return completion(body.n_probs === 256 ? 11 : 7, body.n_probs === 256 ? ['0'] : ['0', '1']);
  } });
  expect(depths).toEqual([256, 4096]);
  expect(result).toMatchObject({ answers: [{ id: 'one', score: 0 }], missing: [], usage: { inputTokens: 18, outputTokens: 2 } });
});

it.each([false, true])('waits for original preparation drain after cancellation=%s or sibling failure', async cancelled => {
  const entered = deferred(), aborted = deferred(), release = deferred();
  const controller = new AbortController(); let settled = false, computations = 0;
  const work = requestClassifier({ ...request, signal: controller.signal, fetchImpl: async (url, init) => {
    const body = bodyOf(init);
    if (String(url).endsWith('/tokenize')) {
      if (!cancelled && body.content === '\n1') { await entered.promise; return Response.json({ tokens: 'invalid' }); }
      return tokenize(body);
    }
    if (String(url).endsWith('/apply-template')) {
      entered.resolve();
      return new Response(new ReadableStream({ start(stream) {
        init!.signal!.addEventListener('abort', () => { aborted.resolve(); void release.promise.then(() => stream.error(new Error('drained'))); }, { once: true });
      } }), { headers: { 'content-type': 'application/json' } });
    }
    computations++; return completion(1);
  } }).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  await entered.promise;
  if (cancelled) controller.abort();
  await aborted.promise;
  expect(settled).toBe(false); expect(computations).toBe(0);
  release.resolve();
  const result = await work;
  expect('error' in result && result.error).toBeInstanceOf(ClassifierResponseError);
  expect('error' in result && result.error.result).toEqual({ answers: [], missing: ['one'] });
});

it('keeps completed answers when cancelled during a later preparation without inventing compute usage', async () => {
  const entered = deferred(), aborted = deferred(), release = deferred(); const controller = new AbortController(); let templates = 0;
  const work = requestClassifier({ ...request, questions: [...questions, { ...questions[0]!, id: 'two' }], signal: controller.signal,
    fetchImpl: async (url, init) => {
      const body = bodyOf(init);
      if (String(url).endsWith('/tokenize')) return tokenize(body);
      if (String(url).endsWith('/apply-template')) {
        if (++templates === 1) return Response.json({ prompt: body.messages[1]!.content });
        entered.resolve(); return new Response(new ReadableStream({ start(stream) {
          init!.signal!.addEventListener('abort', () => { aborted.resolve(); void release.promise.then(() => stream.error(new Error('drained'))); }, { once: true });
        } }));
      }
      return completion(17);
    } }).catch(error => error as ClassifierResponseError);
  await entered.promise; controller.abort(); await aborted.promise; release.resolve();
  const result = await work;
  expect(result).toBeInstanceOf(ClassifierResponseError);
  expect((result as ClassifierResponseError).result).toMatchObject({ answers: [{ id: 'one', score: 0 }], missing: ['two'], usage: { inputTokens: 17, outputTokens: 1 } });
});

it('does not retry past cancellation during a provider-requested backoff', async () => {
  const controller = new AbortController(); let calls = 0;
  const work = requestClassifier({ baseUrl: 'https://classifier.invalid', model: 'classifier', state: {}, questions,
    signal: controller.signal, fetchImpl: async () => { calls++; controller.abort(); return Response.json({ usage: { input_tokens: 3, output_tokens: 1 } }, { status: 503, headers: { 'retry-after': '10' } }); } }).catch(error => error);
  expect(await work).toBeInstanceOf(ClassifierResponseError); expect(calls).toBe(1);
});

it('uses single-token choice labels while retaining the caller option identities', async () => {
  const labels: string[] = [];
  const result = await requestClassifier({ ...request, questions: [{ id: 'choice', kind: 'choose', instructions: 'Choose a color', options: [{ id: 'red', detail: 'red option' }, { id: 'blue', detail: 'blue option' }] }], fetchImpl: async (url, init) => {
    const body = bodyOf(init);
    if (String(url).endsWith('/tokenize')) { labels.push(body.content); return tokenize(body); }
    if (String(url).endsWith('/apply-template')) return Response.json({ prompt: body.messages[1]!.content });
    return Response.json({ tokens_evaluated: 9, tokens_predicted: 1, completion_probabilities: [{ top_logprobs: [{ id: 65, logprob: -1e30 }, { id: 66, logprob: 0 }] }] });
  } });
  expect(labels).toContain('\nA'); expect(labels).toContain('\nB');
  expect(result).toMatchObject({ answers: [{ id: 'choice', choice: 'blue', probabilities: { red: 0, blue: 1 } }], missing: [] });
});
