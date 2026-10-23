/** Component-private CPU encoder. One shared worker owns one loaded model.
 * Protocol 1 separates queue permission, actual encoder entry, and physical settlement. */
import { parentPort, workerData } from 'node:worker_threads';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const { entry, modelRoot, modelFileName, pooling, normalize, dim, maxBatchSize = 32, coalesceQueries = false } = workerData;
if (workerData.protocol !== 1) throw new Error('Unsupported local encoder worker protocol');
let threads = workerData.threads;
const foreground = [], background = [];
const requests = new Map();
let active = false;
const { pipeline, env } = await import(pathToFileURL(entry).href);
env.allowRemoteModels = false;
env.localModelPath = dirname(modelRoot);
const load = () => pipeline('feature-extraction', basename(modelRoot), {
  local_files_only: true, dtype: 'fp32', model_file_name: modelFileName,
  session_options: { intraOpNumThreads: threads, interOpNumThreads: 1,
    intra_op_num_threads: threads, inter_op_num_threads: 1 },
});
const loadStarted = performance.now();
let extract = await load();
let loadMs = performance.now() - loadStarted;
let scheduled = false;
const missing = () => ({ measurement: 'missing', inputTokens: null, outputTokens: null });
const settle = (item, result) => {
  if (!requests.delete(item.id)) return;
  parentPort.postMessage({ type: 'settled', id: item.id, ...result,
    ...(result.usage?.measurement === 'estimated' ? { usageBasis: 'untruncated-tokenizer-estimate' } : {}) });
};
const notStarted = item => settle(item, { requestStarted: false, completed: false, usage: missing(), cancelled: true });
const schedule = () => {
  if (scheduled || active) return;
  scheduled = true;
  setImmediate(() => { scheduled = false; void pump(); });
};
const authorize = item => {
  if (!item.gated) return Promise.resolve(true);
  return new Promise(resolve => {
    item.permission = resolve;
    item.phase = 'permission';
    parentPort.postMessage({ type: 'dispatch_ready', id: item.id });
  });
};
function estimate(item) {
  // encode() is an untruncated estimate, not the pipeline's actual attention mask.
  // The encoder produces vectors and no generated output tokens.
  try {
    const lengths = item.texts.map(text => extract.tokenizer.encode(text).length);
    if (lengths.every(value => Number.isSafeInteger(value) && value >= 0)) {
      return { measurement: 'estimated', inputTokens: lengths.reduce((a, b) => a + b, 0), outputTokens: 0 };
    }
  } catch { /* Optional runtime cannot supply the estimate. Preserve the missing dimension. */ }
  return { measurement: 'missing', inputTokens: null, outputTokens: 0 };
}
async function pump() {
  if (active) return;
  const request = foreground.shift() ?? background.shift();
  if (!request) return;
  active = true;
  const selected = [request];
  let count = request.texts.length;
  if (coalesceQueries && !request.gated && request.priority === 'foreground') {
    while (foreground.length && !foreground[0].gated && count + foreground[0].texts.length <= maxBatchSize) {
      const next = foreground.shift(); count += next.texts.length; selected.push(next);
    }
  }
  let batch = [];
  try {
    // Model replacement is preparation. No request is permitted into forward yet.
    if (request.priority === 'background' && foreground.length === 0 && request.threads !== undefined && request.threads !== threads) {
      const previousThreads = threads;
      threads = request.threads;
      const began = performance.now();
      let replacement;
      try { replacement = await load(); }
      catch (error) { threads = previousThreads; throw error; }
      const previous = extract; extract = replacement;
      loadMs = performance.now() - began;
      await previous.dispose();
    }
    const permissions = await Promise.all(selected.map(item => requests.has(item.id) ? authorize(item) : false));
    batch = selected.filter((item, index) => permissions[index] && requests.has(item.id));
    if (!batch.length) return;
    const began = performance.now(), cpu = process.cpuUsage();
    const texts = batch.flatMap(item => item.texts);
    for (const item of batch) {
      item.phase = 'running'; item.usage = estimate(item);
      parentPort.postMessage({ type: 'started', id: item.id, usage: item.usage,
        ...(item.usage.measurement === 'estimated' ? { usageBasis: 'untruncated-tokenizer-estimate' } : {}) });
    }
    const output = await extract(texts, { pooling, normalize });
    const elapsed = performance.now() - began, usedCpu = process.cpuUsage(cpu);
    const listed = typeof output.tolist === 'function' ? output.tolist() : output;
    const rows = Array.isArray(listed[0]) ? listed : [listed];
    if (rows.length !== texts.length || rows.some(row => row.length !== dim || row.some(value => !Number.isFinite(value)))) {
      throw new Error(`Local encoder returned an invalid batch (${rows.length} rows, expected ${texts.length} in ${dim} dimensions)`);
    }
    let offset = 0;
    for (const item of batch) {
      settle(item, { requestStarted: true, completed: true, usage: item.usage,
        vectors: rows.slice(offset, offset + item.texts.length),
        durationMs: elapsed * item.texts.length / texts.length,
        cpuMs: (usedCpu.user + usedCpu.system) / 1000 * item.texts.length / texts.length, threads, loadMs });
      offset += item.texts.length;
    }
  } catch (error) {
    for (const item of selected) settle(item, { requestStarted: item.phase === 'running', completed: item.phase === 'running',
      usage: item.usage ?? missing(), error: error instanceof Error ? error.message : String(error) });
  } finally {
    active = false;
    schedule();
  }
}
parentPort.on('message', message => {
  const item = requests.get(message.id);
  if (message.type === 'cancel') {
    if (!item) return;
    // Running native forward is not cancellable. Its original result/usage must drain.
    if (item.phase === 'running') { parentPort.postMessage({ type: 'cancel_pending', id: item.id }); return; }
    for (const queue of [foreground, background]) {
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
    }
    item.permission?.(false);
    notStarted(item);
    return;
  }
  if (message.type === 'execute') {
    if (item?.phase === 'permission') { item.phase = 'permitted'; item.permission(true); }
    return;
  }
  if (message.type !== 'enqueue' || requests.has(message.id) || !Number.isSafeInteger(message.id)
    || !Array.isArray(message.texts) || !message.texts.length || message.texts.some(text => typeof text !== 'string')) {
    throw new Error('Invalid local encoder request');
  }
  const request = { ...message, phase: 'queued' };
  requests.set(request.id, request);
  (request.priority === 'foreground' ? foreground : background).push(request);
  schedule();
});
parentPort.postMessage({ type: 'ready', protocol: 1 });
