/**
 * Host-local encoder via the optional local semantic component. The runtime is
 * loaded from the component's absolute entry only after a package is enabled;
 * missing weights are `unavailable`, not an empty ready index.
 */

import os from "node:os";
import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { intraOpThreads, LOCAL_DEFAULT_SPACE, type VectorSpaceIdentity } from "./identity.js";
import type { SemanticEmbedder, SemanticEmbedderStatus } from "./embedder.js";
import { resolveInstalledModelPack, type ResolvedModelPack } from "./model-store.js";
import { createLocalCpuPolicy, type LocalCpuSettings } from './local-cpu-policy.js';

type Encoded = { length: number } | ArrayLike<number>;

type TransformersModule = {
  env: {
    allowRemoteModels?: boolean;
    localModelPath?: string;
    backends?: {
      onnx?: {
        wasm?: { numThreads?: number };
      };
    };
  };
  AutoTokenizer: {
    from_pretrained: (source: string, options?: { local_files_only?: boolean }) => Promise<{
      encode: (text: string) => Encoded | Promise<Encoded>;
    }>;
  };
};

const encodedLength = (value: Encoded): number => (
  typeof (value as { length: number }).length === "number" ? (value as { length: number }).length : 0
);

/**
 * Kept out of the bundler's static graph so a desktop build does not inline the
 * runtime, but a real dynamic import so it actually loads and is testable — the
 * previous `new Function("return import(...)")` form threw "A dynamic import
 * callback was not specified" under the test runner, which is why this path had
 * never run (D-172).
 */
const TRANSFORMERS_MODULE_ID = "@huggingface/transformers";
// 32 is the measured CPU batch size for near-window inputs. It is only an
// inference grain: embed() always walks every input and preserves its order.
const INFERENCE_BATCH_SIZE = 32;

const loadTransformers = async (entry?: string): Promise<TransformersModule> => (
  await import(/* @vite-ignore */ (entry ? pathToFileURL(entry).href : TRANSFORMERS_MODULE_ID)) as TransformersModule
);

export function createLocalSemanticEmbedder(options: {
  dataDir: string;
  pack?: ResolvedModelPack | null;
  parallelism?: number;
  cpu?: LocalCpuSettings;
}): SemanticEmbedder {
  // A query keeps one model identity for its entire lifetime. The workspace
  // owner replaces this instance when a new component is enabled.
  const packSnapshot = options.pack !== undefined ? options.pack : resolveInstalledModelPack(options.dataDir);
  const currentPack = (): ResolvedModelPack | null => packSnapshot;
  const inferenceBatchSize = packSnapshot?.recipe.inferenceBatchSize ?? INFERENCE_BATCH_SIZE;
  const adaptive = packSnapshot?.recipe.adaptiveBatching ?? false;
  const policy = createLocalCpuPolicy({ parallelism: options.parallelism ?? os.availableParallelism(),
    ...(options.cpu ? { settings: options.cpu } : {}), maxBatchSize: inferenceBatchSize, maxTokens: packSnapshot?.space.maxTokens ?? 512,
    ...(packSnapshot?.recipe.preferredCpuThreads ? { initialThreads: packSnapshot.recipe.preferredCpuThreads } : {}) });
  let encode: ((text: string) => number) | null = null;
  let prepared = false;
  let preparedRoot: string | null = null;
  let preparePromise: Promise<void> | null = null;
  let extractor: ((texts: readonly string[], signal?: AbortSignal, priority?: "foreground" | "background", scheduled?: boolean, tokenLengths?: readonly number[]) => Promise<number[][]>) | null = null;
  let worker: Worker | null = null;
  let workerFailure: Error | null = null;
  let disposed = false;
  let requestId = 0;
  const requests = new Map<number, { resolve(vectors: number[][]): void; reject(error: Error): void;
    lengths: number[]; priority: 'foreground' | 'background'; cleanup(): void }>();

  const threadCount = (): number => adaptive || options.cpu
    ? policy.initialThreads : Math.min(packSnapshot?.recipe.preferredCpuThreads ?? Infinity,
      intraOpThreads(options.parallelism ?? os.availableParallelism()));

  const configureThreads = (mod: TransformersModule): number => {
    const threads = threadCount();
    if (mod.env.backends?.onnx?.wasm) mod.env.backends.onnx.wasm.numThreads = threads;
    return threads;
  };

  const embedder: SemanticEmbedder = {
    inferenceBatchSize,
    batchByLength: packSnapshot?.recipe.batchByLength ?? false,
    ownsScheduling: true,
    ...(adaptive ? { selectBatchSize: policy.selectBatchSize, waitForBackground: policy.waitForBackground,
      executionStatus: policy.snapshot } : {}),
    get status(): SemanticEmbedderStatus {
      return currentPack()?.onnxPath ? "ready" : "unavailable";
    },
    get space(): VectorSpaceIdentity {
      return currentPack()?.space ?? LOCAL_DEFAULT_SPACE;
    },
    prepare: async () => {
      if (disposed) throw new Error("Local encoder is disposed.");
      if (workerFailure) throw workerFailure;
      const current = currentPack();
      if (prepared && preparedRoot === (current?.root ?? null)) return;
      if (preparePromise) return preparePromise;
      prepared = false;
      preparedRoot = null;
      encode = null;
      extractor = null;
      preparePromise = (async () => {
        const pack = currentPack();
        if (!pack?.root) {
          prepared = true;
          preparedRoot = null;
          encode = null;
          extractor = null;
          return;
        }
        const mod = await loadTransformers(pack.transformersEntry);
        const threads = configureThreads(mod);
        // transformers.js resolves a local pack as `${env.localModelPath}/${id}`
        // and looks for `onnx/<file>` inside it. A file:// URL as the id makes it
        // read `tokenizer_config.json` off the wrong base (D-172).
        mod.env.allowRemoteModels = false;
        mod.env.localModelPath = dirname(pack.root);
        const source = basename(pack.root);
        if (pack.tokenizerPath) {
          const tokenizer = await mod.AutoTokenizer.from_pretrained(source, { local_files_only: true });
          encode = (text) => {
            const ids = tokenizer.encode(text);
            return encodedLength(ids as Encoded);
          };
        }
        if (pack.onnxPath) {
          if (!pack.transformersEntry || !pack.inferenceWorkerEntry) throw new Error("Local encoder worker runtime is unavailable.");
          await new Promise<void>((resolve, reject) => {
            const activeWorker = new Worker(pathToFileURL(pack.inferenceWorkerEntry!), { execArgv: [], workerData: {
              entry: pack.transformersEntry, modelRoot: pack.root, modelFileName: basename(pack.onnxPath!, ".onnx"),
              pooling: pack.space.pooling, normalize: pack.space.normalize, dim: pack.space.dim, threads,
              maxBatchSize: inferenceBatchSize, coalesceQueries: adaptive,
            } });
            worker = activeWorker;
            const fail = (error: Error) => {
              workerFailure = error;
              reject(error);
              for (const request of requests.values()) { request.cleanup(); request.reject(error); }
              requests.clear();
              activeWorker.unref();
            };
            activeWorker.on("error", fail);
            activeWorker.on("exit", () => fail(new Error("Local encoder worker exited.")));
            activeWorker.on("message", (message: { type?: string; id?: number; vectors?: number[][]; error?: string;
              durationMs?: number; cpuMs?: number; threads?: number; loadMs?: number }) => {
              if (message.type === "ready") { activeWorker.unref(); resolve(); return; }
              const request = message.id === undefined ? undefined : requests.get(message.id);
              if (!request || message.id === undefined) return;
              requests.delete(message.id);
              request.cleanup();
              if (adaptive && message.durationMs !== undefined && message.threads !== undefined && message.cpuMs !== undefined) {
                policy.record({ lengths: request.lengths, priority: request.priority,
                  durationMs: message.durationMs, cpuMs: message.cpuMs, threads: message.threads,
                  ...(message.loadMs === undefined ? {} : { loadMs: message.loadMs }) });
              }
              if (message.error) request.reject(new Error(message.error));
              else if (message.vectors) request.resolve(message.vectors);
              else request.reject(new Error("Local encoder worker returned an incomplete response."));
              if (requests.size === 0) activeWorker.unref();
            });
          });
          const run = (texts: readonly string[], lengths: number[], priority: "foreground" | "background", signal?: AbortSignal): Promise<number[][]> => {
            if (!worker || workerFailure || disposed) return Promise.reject(workerFailure ?? new Error("Local encoder is disposed."));
            const activeWorker = worker;
            const id = ++requestId;
            return new Promise((resolve, reject) => {
              const abort = () => {
                requests.delete(id);
                signal?.removeEventListener('abort', abort);
                activeWorker.postMessage({ cancel: id });
                if (requests.size === 0) activeWorker.unref();
                reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
              };
              if (signal?.aborted) { reject(signal.reason); return; }
              signal?.addEventListener('abort', abort, { once: true });
              requests.set(id, { resolve, reject, lengths, priority,
                cleanup: () => signal?.removeEventListener('abort', abort) });
              activeWorker.ref();
              activeWorker.postMessage({ id, texts, priority,
                threads: adaptive ? policy.nextThreads(priority) : threads });
            });
          };
          extractor = async (texts, signal, priority = "background", scheduled = false, tokenLengths) => {
            const vectors: number[][] = [];
            const lengths = adaptive ? tokenLengths ?? texts.map(text => encode!(text)) : [];
            for (let offset = 0; offset < texts.length;) {
              signal?.throwIfAborted();
              if (adaptive && priority === 'background' && !scheduled) await policy.waitForBackground(signal);
              const candidates = texts.slice(offset, offset + inferenceBatchSize);
              const size = adaptive && !scheduled ? policy.selectBatchSize(lengths.slice(offset, offset + candidates.length)) : candidates.length;
              const batch = candidates.slice(0, size);
              const rows = await run(batch, lengths.slice(offset, offset + batch.length), priority, signal);
              signal?.throwIfAborted();
              if (rows.length !== batch.length || rows.some((row) => row.length !== pack.space.dim)) {
                throw new Error(`Local encoder returned ${rows.length} vectors for ${batch.length} inputs in ${pack.space.dim} dimensions.`);
              }
              vectors.push(...rows);
              offset += batch.length;
            }
            return vectors;
          };
        }
        prepared = true;
        preparedRoot = pack.root;
      })();
      const pending = preparePromise;
      try { await pending; }
      finally {
        if (preparePromise === pending) preparePromise = null;
      }
    },
    countTokens: (text) => {
      if (encode) return encode(text);
      throw new Error("Local encoder tokenizer is not prepared.");
    },
    embed: async (texts, request) => {
      const pack = currentPack();
      if (!pack?.onnxPath || !extractor || preparedRoot !== pack.root) {
        throw new Error("Local encoder model pack is unavailable.");
      }
      return extractor(texts, request?.signal, request?.priority ?? (request?.purpose === "query" ? "foreground" : "background"), request?.scheduled, request?.tokenLengths);
    },
    embedBatch: async (request) => {
      request.signal?.throwIfAborted();
      const vectors = await embedder.embed(request.items.map((item) => item.text), {
        purpose: request.purpose, ...(request.signal ? { signal: request.signal } : {}),
      });
      request.signal?.throwIfAborted();
      const space = embedder.space;
      if (vectors.length !== request.items.length || vectors.some((vector) => vector.length !== space.dim)) {
        throw new Error(`Local encoder returned ${vectors.length} vectors for ${request.items.length} inputs in ${space.dim} dimensions.`);
      }
      return {
        batchId: request.batchId,
        space,
        items: request.items.map((item, index) => ({
          id: item.id,
          index,
          vector: vectors[index]!,
        })),
      };
    },
    dispose: async () => {
      disposed = true;
      const activeWorker = worker;
      worker = null;
      const error = new Error("Local encoder is disposed.");
      for (const request of requests.values()) { request.cleanup(); request.reject(error); }
      requests.clear();
      await activeWorker?.terminate();
    },
  };
  return embedder;
}
