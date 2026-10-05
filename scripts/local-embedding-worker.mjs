/** Component-private CPU encoder. Native ONNX and tokenizer work never run on
 * the Application Host event loop. One worker owns one loaded model. */
import { parentPort, workerData } from 'node:worker_threads';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const { entry, modelRoot, modelFileName, pooling, normalize, dim, maxBatchSize = 32, coalesceQueries = false } = workerData;
let threads = workerData.threads;
const foreground = [], background = [];
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

const schedule = () => {
  if (scheduled || active) return;
  scheduled = true;
  setImmediate(() => { scheduled = false; void pump(); });
};

async function pump() {
  if (active) return;
  const request = foreground.shift() ?? background.shift();
  if (!request) return;
  active = true;
  const batch = [request];
  // Collect queries already admitted by the event loop, with no timer to wait
  // for a fuller batch. Fixed-grain quantized imports retain their old batches.
  let count = request.texts.length;
  if (coalesceQueries && request.priority === 'foreground') {
    while (foreground.length && count + foreground[0].texts.length <= maxBatchSize) {
      const next = foreground.shift(); count += next.texts.length; batch.push(next);
    }
  }
  try {
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
    const began = performance.now(), cpu = process.cpuUsage();
    const texts = batch.flatMap(item => item.texts);
    const output = await extract(texts, { pooling, normalize });
    const elapsed = performance.now() - began, usedCpu = process.cpuUsage(cpu);
    const listed = typeof output.tolist === 'function' ? output.tolist() : output;
    const rows = Array.isArray(listed[0]) ? listed : [listed];
    if (rows.length !== texts.length || rows.some(row => row.length !== dim || row.some(value => !Number.isFinite(value)))) {
      throw new Error(`Local encoder returned an invalid batch (${rows.length} rows, expected ${texts.length} in ${dim} dimensions)`);
    }
    let offset = 0;
    for (const item of batch) {
      parentPort.postMessage({ id: item.id, vectors: rows.slice(offset, offset + item.texts.length),
        durationMs: elapsed * item.texts.length / texts.length,
        cpuMs: (usedCpu.user + usedCpu.system) / 1000 * item.texts.length / texts.length, threads, loadMs });
      offset += item.texts.length;
    }
  } catch (error) {
    for (const item of batch) parentPort.postMessage({ id: item.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    active = false;
    // Allow incoming query messages to be admitted before the next CPU call.
    schedule();
  }
}

parentPort.on('message', request => {
  if (request.cancel !== undefined) {
    for (const queue of [foreground, background]) {
      const index = queue.findIndex(item => item.id === request.cancel);
      if (index >= 0) queue.splice(index, 1);
    }
    return;
  }
  (request.priority === 'foreground' ? foreground : background).push(request);
  schedule();
});
parentPort.postMessage({ type: 'ready' });
