/**
 * Host-local encoder via the optional local semantic component. The runtime is
 * loaded from the component's absolute entry only after a package is enabled;
 * missing weights are `unavailable`, not an empty ready index.
 */

import os from "node:os";
import type { LocalEmbeddingSettlement } from "./local-execution.js";
import { basename, join } from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { intraOpThreads, LOCAL_DEFAULT_SPACE, type VectorSpaceIdentity } from "./identity.js";
import type { SemanticEmbedder, SemanticEmbedderStatus } from "./embedder.js";
import { resolveInstalledModelPack, type ResolvedModelPack } from "./model-store.js";
import { createLocalCpuPolicy, type LocalCpuSettings } from './local-cpu-policy.js';

type TokenizerModule = {
  Tokenizer: new (model: object, configuration: object) => { encode(text: string): { ids: number[] } };
};
// 32 is the measured CPU batch size for near-window inputs. It is only an
// inference grain: embed() always walks every input and preserves its order.
const INFERENCE_BATCH_SIZE = 32;

// Keep native ONNX imports exclusively inside the disposable encoder Worker.
// Importing the full Transformers module here would pin its DLLs in the Host.
const loadTokenizer = async (entry: string): Promise<TokenizerModule> => (
  await import(/* @vite-ignore */ pathToFileURL(entry).href) as TokenizerModule
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
  let references = 1;
  let retired = false;
  let retireDone!: () => void;
  const retiredWork = new Promise<void>(resolve => { retireDone = resolve; });
  let disposing: Promise<void> | undefined;
  const retain = (): (() => void) => {
    if (disposed || references === 0) throw new Error("Local encoder is disposed.");
    references++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      references--;
      if (retired && references === 0) void embedder.dispose!().then(retireDone);
    };
  };
  const requests = new Map<number, {
    resolve(result: LocalEmbeddingSettlement): void;
    lengths: number[]; priority: 'foreground' | 'background'; cleanup(): void;
    beforeDispatch?: () => Promise<void>;
    started: boolean | null; usage?: LocalEmbeddingSettlement['usage']; usageBasis?: LocalEmbeddingSettlement['usageBasis']; failure?: string;
  }>();
  let runBatch: ((texts: readonly string[], lengths: number[], priority: 'foreground' | 'background', signal?: AbortSignal,
    beforeDispatch?: () => Promise<void>) => Promise<LocalEmbeddingSettlement>) | undefined;

  const threadCount = (): number => adaptive || options.cpu
    ? policy.initialThreads : Math.min(packSnapshot?.recipe.preferredCpuThreads ?? Infinity,
      intraOpThreads(options.parallelism ?? os.availableParallelism()));

  const embedder: SemanticEmbedder = {
    retain,
    retire: () => {
      if (!retired) {
        retired = true; references--;
        if (references === 0) void embedder.dispose!().then(retireDone);
      }
      return retiredWork;
    },
    ...(packSnapshot?.component ? { localExecution: {
      identity: Object.freeze({ kind: 'local_component' as const, ...packSnapshot.component, modelRevision: packSnapshot.space.modelRevision }),
      batch: async (texts: readonly string[], input: { signal: AbortSignal; beforeDispatch(): Promise<void>; priority: 'foreground' | 'background'; tokenLengths?: readonly number[] }) => {
        const release = retain();
        try {
          await embedder.prepare();
          if (!runBatch) throw new Error('Local encoder worker is unavailable');
          return await runBatch(texts, [...(input.tokenLengths ?? [])], input.priority, input.signal, input.beforeDispatch);
        } finally { release(); }
      },
    } } : {}),
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
      const releasePreparation = retain();
      try {
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
        const threads = threadCount();
        if (pack.tokenizerPath) {
          if (!pack.tokenizerEntry) throw new Error('Local tokenizer runtime is unavailable');
          const [{ Tokenizer }, model, configuration] = await Promise.all([
            loadTokenizer(pack.tokenizerEntry), readFile(pack.tokenizerPath, 'utf8'), readFile(join(pack.root, 'tokenizer_config.json'), 'utf8'),
          ]);
          const tokenizer = new Tokenizer(JSON.parse(model), JSON.parse(configuration));
          encode = text => tokenizer.encode(text).ids.length;
        }
        if (disposed) throw new Error("Local encoder is disposed.");
        if (pack.onnxPath) {
          if (!pack.transformersEntry || !pack.inferenceWorkerEntry) throw new Error("Local encoder worker runtime is unavailable.");
          await new Promise<void>((resolve, reject) => {
            const activeWorker = new Worker(pathToFileURL(pack.inferenceWorkerEntry!), { execArgv: [], workerData: {
              protocol: 1, entry: pack.transformersEntry, modelRoot: pack.root, modelFileName: basename(pack.onnxPath!, ".onnx"),
              pooling: pack.space.pooling, normalize: pack.space.normalize, dim: pack.space.dim, threads,
              maxBatchSize: inferenceBatchSize, coalesceQueries: adaptive,
            } });
            worker = activeWorker;
            activeWorker.on("error", error => { workerFailure = error; reject(error); });
            activeWorker.on("exit", () => {
              const error = workerFailure ?? new Error("Local encoder worker exited.");
              workerFailure = error;
              reject(error);
              for (const request of requests.values()) {
                request.cleanup();
                request.resolve({ requestStarted: request.started, completed: false,
                  usage: request.usage ?? { measurement: 'missing', inputTokens: null, outputTokens: null },
                  ...(request.usageBasis ? { usageBasis: request.usageBasis } : {}), error: error.message });
              }
              requests.clear();
            });
            activeWorker.on("message", (message: LocalEmbeddingSettlement & { type?: string; protocol?: number; id?: number;
              durationMs?: number; cpuMs?: number; threads?: number; loadMs?: number }) => {
              if (message.type === "ready") {
                if (message.protocol !== 1) { workerFailure = new Error('Unsupported local encoder worker protocol'); reject(workerFailure); void activeWorker.terminate(); return; }
                activeWorker.unref(); resolve(); return;
              }
              const request = message.id === undefined ? undefined : requests.get(message.id);
              if (!request || message.id === undefined) return;
              if (message.type === 'dispatch_ready') {
                void (async () => {
                  try {
                    await request.beforeDispatch!();
                    if (!requests.has(message.id!)) return;
                    // If exit wins before started is observed, execution entry is unknown.
                    request.started = null;
                    activeWorker.postMessage({ type: 'execute', id: message.id });
                  } catch (error) {
                    request.failure = error instanceof Error ? error.message : String(error);
                    activeWorker.postMessage({ type: 'cancel', id: message.id });
                  }
                })();
                return;
              }
              if (message.type === 'started') { request.started = true; request.usage = message.usage; request.usageBasis = message.usageBasis; return; }
              if (message.type !== 'settled') return;
              requests.delete(message.id);
              request.cleanup();
              if (adaptive && message.durationMs !== undefined && message.threads !== undefined && message.cpuMs !== undefined) {
                policy.record({ lengths: request.lengths, priority: request.priority,
                  durationMs: message.durationMs, cpuMs: message.cpuMs, threads: message.threads,
                  ...(message.loadMs === undefined ? {} : { loadMs: message.loadMs }) });
              }
              request.resolve({ ...message, ...(request.failure ? { error: request.failure } : {}) });
              if (requests.size === 0) activeWorker.unref();
            });
          });
          runBatch = (texts, lengths, priority, signal, beforeDispatch) => {
            if (!worker || workerFailure || disposed) return Promise.reject(workerFailure ?? new Error("Local encoder is disposed."));
            const activeWorker = worker;
            const id = ++requestId;
            return new Promise(resolve => {
              const abort = () => { activeWorker.postMessage({ type: 'cancel', id }); };
              if (signal?.aborted) {
                resolve({ requestStarted: false, completed: false, cancelled: true,
                  usage: { measurement: 'missing', inputTokens: null, outputTokens: null } }); return;
              }
              signal?.addEventListener('abort', abort, { once: true });
              requests.set(id, { resolve, lengths, priority, started: beforeDispatch ? false : null,
                ...(beforeDispatch ? { beforeDispatch } : {}), cleanup: () => signal?.removeEventListener('abort', abort) });
              activeWorker.ref();
              activeWorker.postMessage({ type: 'enqueue', id, texts, priority, gated: !!beforeDispatch,
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
              const result = await runBatch!(batch, lengths.slice(offset, offset + batch.length), priority, signal);
              signal?.throwIfAborted();
              if (result.error || !result.vectors) throw new Error(result.error ?? 'Local encoder returned no vectors');
              const rows = result.vectors;
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
      } finally { releasePreparation(); }
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
      const release = retain();
      try { return await extractor(texts, request?.signal, request?.priority ?? (request?.purpose === "query" ? "foreground" : "background"), request?.scheduled, request?.tokenLengths); }
      finally { release(); }
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
    dispose: () => {
      if (disposing) return disposing;
      disposed = true;
      disposing = (async () => {
        const activeWorker = worker;
        worker = null;
        await activeWorker?.terminate();
        // Preparation cannot create a worker after disposal. Terminate an already
        // created worker first, so a stuck model load cannot deadlock shutdown.
        await preparePromise?.catch(() => {});
        encode = null;
        extractor = null;
        runBatch = undefined;
        prepared = false;
        preparedRoot = null;
        retireDone();
      })();
      return disposing;
    },
  };
  return embedder;
}
