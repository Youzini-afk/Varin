/** Component-private CPU encoder. Native ONNX and tokenizer work never run on
 * the Application Host event loop. One worker owns one loaded model. */
import { parentPort, workerData } from 'node:worker_threads';
import { basename, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const { entry, modelRoot, modelFileName, pooling, normalize, dim, threads } = workerData;
const foreground = [], background = [];
let active = false;
const { pipeline, env } = await import(pathToFileURL(entry).href);
env.allowRemoteModels = false;
env.localModelPath = dirname(modelRoot);
const extract = await pipeline('feature-extraction', basename(modelRoot), {
  local_files_only: true, dtype: 'fp32', model_file_name: modelFileName,
  session_options: { intraOpNumThreads: threads, interOpNumThreads: 1,
    intra_op_num_threads: threads, inter_op_num_threads: 1 },
});

async function pump() {
  if (active) return;
  const request = foreground.shift() ?? background.shift();
  if (!request) return;
  active = true;
  try {
    const output = await extract(request.texts, { pooling, normalize });
    const listed = typeof output.tolist === 'function' ? output.tolist() : output;
    const rows = Array.isArray(listed[0]) ? listed : [listed];
    if (rows.length !== request.texts.length || rows.some(row => row.length !== dim || row.some(value => !Number.isFinite(value)))) {
      throw new Error(`Local encoder returned an invalid batch (${rows.length} rows, expected ${request.texts.length} in ${dim} dimensions)`);
    }
    parentPort.postMessage({ id: request.id, vectors: rows });
  } catch (error) {
    parentPort.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    active = false;
    // Allow incoming query messages to be admitted before the next CPU call.
    setImmediate(pump);
  }
}

parentPort.on('message', request => {
  (request.priority === 'foreground' ? foreground : background).push(request);
  void pump();
});
parentPort.postMessage({ type: 'ready' });
