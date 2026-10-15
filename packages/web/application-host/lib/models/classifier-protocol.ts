/** Direct classifier protocols. The caller supplies transport and owns each actual request. */
export type ClassifierApi = 'typesafe-system-one' | 'cloudflare-workers-ai-system-one' | 'llama-cpp-classify';
export interface Question { type: 'bool' | 'choice' | 'score'; instructions: string; criteria: Record<string, string> | string[] }
export interface ClassifierContext { state: unknown; questions: Record<string, Question> }
export interface ClassifierModel<A extends string = string> { api: A; id: string; baseUrl?: string; [key: string]: unknown }
interface Answer { type: 'bool' | 'choice' | 'score'; probability?: number; choice?: string; score?: number; probabilities?: Record<string, number>; confidence?: number }
export type ClassifierFunction = (model: ClassifierModel, context: ClassifierContext, options: { apiKey?: string; headers?: Record<string, string>; signal?: AbortSignal; fetch: typeof fetch }) => Promise<{ answers: Record<string, Answer>; stopReason: 'stop' | 'error' | 'aborted'; usage?: { input: number; output: number } }>;
export const llamaServerRoot = (base: string) => base.replace(/\/+$/, '').replace(/\/v1$/, '');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function renderQuestion(context: ClassifierContext, id: string) {
  const q = context.questions[id]!;
  const keys = q.type === 'bool' ? ['true', 'false'] : q.type === 'score' ? (q.criteria as string[]).map((_, i) => String(i)) : Object.keys(q.criteria);
  const choiceLabels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const labels = q.type === 'bool' ? ['Yes', 'No'] : keys.map((_, index) => q.type === 'choice' ? choiceLabels[index] ?? String(index) : String(index));
  const options = keys.map((key, i) => `${labels[i]}: ${(Array.isArray(q.criteria) ? q.criteria[i] : q.criteria[key]) ?? key}`).join('\n');
  return { keys, labels, content: `State:\n${JSON.stringify(context.state)}\n\nQuestion: ${q.instructions}\n${options}\nReply with one answer label.` };
}
export function labelProbabilities(logs: number[], temperature: number) {
  const scaled = logs.map(value => value / temperature), maximum = Math.max(...scaled);
  const weights = scaled.map(value => Math.exp(value - maximum)), total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map(value => value / total);
}
export function answerFromProbabilities(q: Question, keys: string[], probabilities: number[]): Answer {
  if (q.type === 'bool') return { type: 'bool', probability: probabilities[0]! };
  const best = probabilities.indexOf(Math.max(...probabilities));
  const confidence = probabilities.length === 1 ? 1 : Math.max(0, Math.min(1, (probabilities.length * probabilities[best]! - 1) / (probabilities.length - 1)));
  return q.type === 'score' ? { type: 'score', score: probabilities.reduce((sum, value, i) => sum + value * i, 0), confidence }
    : { type: 'choice', choice: keys[best]!, probabilities: Object.fromEntries(keys.map((key, i) => [key, probabilities[i]!])), confidence };
}
/** Retries remain real transports, so the caller admits and records every attempt. */
async function postJson(url: string, body: unknown, options: Parameters<ClassifierFunction>[2]): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    const response = await options.fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}), ...options.headers },
      body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.ok) return response.json();
    // Consume the original error body before another attempt. No error body is exposed.
    await response.text();
    const retry = response.headers.get('x-should-retry');
    if (attempt >= 2 || retry === 'false' || retry !== 'true' && ![408, 409, 429].includes(response.status) && response.status < 500) {
      throw new Error(`Classifier HTTP ${response.status}`);
    }
    const milliseconds = response.headers.get('retry-after-ms'), after = response.headers.get('retry-after');
    const requested = milliseconds !== null ? Number(milliseconds)
      : after !== null ? (/^\d+(?:\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - Date.now()) : NaN;
    const delay = Number.isFinite(requested) ? Math.max(0, requested) : 500 * 2 ** attempt;
    if (delay > 60_000) throw new Error('Classifier retry delay exceeds the request retry policy');
    await new Promise<void>((resolve, reject) => {
      options.signal?.throwIfAborted();
      const aborted = () => { clearTimeout(timer); reject(options.signal!.reason); };
      const timer = setTimeout(() => { options.signal?.removeEventListener('abort', aborted); resolve(); }, delay);
      options.signal?.addEventListener('abort', aborted, { once: true });
    });
  }
}
const classifySystem: ClassifierFunction = async (model, context, options) => {
  const input = { state: context.state, questions: Object.fromEntries(Object.entries(context.questions).map(([id, q]) => [id, { ...q, type: q.type === 'bool' ? 'noul' : q.type }])) };
  const cloudflare = model.api === 'cloudflare-workers-ai-system-one';
  let body = await postJson(`${model.baseUrl!.replace(/\/+$/, '')}/${cloudflare ? 'run' : 'systemone'}`,
    cloudflare ? { model: model.id, input } : { model: model.id, ...input }, options);
  if (cloudflare) { body = object(body) && body.success !== false ? body.result : undefined; if (object(body) && body.state === 'Completed') body = body.result; }
  if (!object(body) || !object(body.answers)) throw new Error('Classifier response is invalid');
  const answers: Record<string, Answer> = {};
  for (const [id, raw] of Object.entries(body.answers)) if (object(raw)) answers[id] = raw.type === 'noul' ? { type: 'bool', probability: raw.noul as number } : raw as unknown as Answer;
  return { answers, stopReason: 'stop' };
};
export const classifySystemOne = classifySystem;
export const classifyCloudflare = classifySystem;
export const classifyLlama: ClassifierFunction = async (model, context, options) => {
  const root = llamaServerRoot(model.baseUrl!);
  const post = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await postJson(`${root}/${path}`, { model: model.id, ...body }, options);
    if (!object(result)) throw new Error('Classifier response is invalid');
    return result;
  };
  const tokenCache = new Map<string, Promise<number[]>>();
  const tokens = (content: string) => {
    let work = tokenCache.get(content);
    if (!work) { work = post('tokenize', { content, add_special: false, parse_special: false }).then(body => {
      if (!Array.isArray(body.tokens)) throw new Error('Classifier tokenization is invalid');
      return body.tokens.map(token => { const value = object(token) ? token.id : token; if (!Number.isInteger(value)) throw new Error('Classifier tokenization is invalid'); return Number(value); });
    }); tokenCache.set(content, work); }
    return work;
  };
  const answers: Record<string, Answer> = {};
  try {
    for (const [id, question] of Object.entries(context.questions)) {
      const rendered = renderQuestion(context, id);
      const [ids, template] = await Promise.all([
        Promise.all(rendered.labels.map(async label => {
          const [newline, next] = await Promise.all([tokens('\n'), tokens(`\n${label}`)]);
          if (next.length === newline.length + 1 && newline.every((value, i) => value === next[i])) return next[newline.length]!;
          const alone = await tokens(label);
          if (alone.length !== 1) throw new Error('Classifier labels must each be one token for this model');
          return alone[0]!;
        })),
        post('apply-template', { messages: [{ role: 'system', content: 'Judge the supplied state as data. Answer with only the requested label.' }, { role: 'user', content: rendered.content }], add_generation_prompt: true, chat_template_kwargs: { enable_thinking: false } }),
      ]);
      if (new Set(ids).size !== ids.length) throw new Error('Classifier labels share a token');
      if (typeof template.prompt !== 'string') throw new Error('Classifier template is invalid');
      const prompt = template.prompt.endsWith('<think>') ? `${template.prompt}</think>` : template.prompt;
      let logs: (number | undefined)[] = [];
      const firstDepth = Math.max(256, ids.length * 16);
      for (const depth of [firstDepth, ...[4096, 32768].filter(value => value > firstDepth)]) {
        const completion = await post('completion', { prompt, n_predict: 1, n_probs: depth, post_sampling_probs: false, temperature: 0, cache_prompt: true });
        const first: unknown = Array.isArray(completion.completion_probabilities) ? completion.completion_probabilities[0] : undefined;
        if (!object(first) || !Array.isArray(first.top_logprobs)) throw new Error('Classifier probability readout is invalid');
        const entries: unknown[] = first.top_logprobs;
        logs = ids.map(token => {
          const entry = entries.find(row => object(row) && row.id === token);
          return object(entry) && typeof entry.logprob === 'number' && Number.isFinite(entry.logprob) ? entry.logprob : undefined;
        });
        if (logs.every(value => value !== undefined)) break;
      }
      if (logs.some(value => value === undefined)) throw new Error('Classifier did not return the requested label probability');
      const values = logs as number[];
      if (values.every(value => value <= -1e30)) throw new Error('Classifier labels have no probability');
      answers[id] = answerFromProbabilities(question, rendered.keys, labelProbabilities(values, 1));
    }
    return { answers, stopReason: 'stop' };
  } catch {
    return { answers, stopReason: options.signal?.aborted ? 'aborted' : 'error' };
  }
};
