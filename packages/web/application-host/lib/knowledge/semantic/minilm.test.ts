import { beforeEach, describe, expect, it, vi } from "vitest";
import { LOCAL_MINILM_SPACE } from "./identity.js";
import type { ResolvedModelPack } from "./model-store.js";
import { fileURLToPath } from 'node:url';

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  class Worker extends EventEmitter {
    data: { pooling: string; normalize: boolean; threads: number };
    constructor(_url: unknown, options: { workerData: Worker['data'] }) {
      super();
      this.data = options.workerData;
      transformerState().sessionOptions.push({ intraOpNumThreads: this.data.threads, intra_op_num_threads: this.data.threads });
      queueMicrotask(() => this.emit('message', { type: 'ready' }));
    }
    ref() {}
    unref() {}
    terminate() { return Promise.resolve(0); }
    postMessage(request: { id:number; texts:string[] }) {
      transformerState().batches.push([...request.texts]);
      transformerState().options.push({ pooling: this.data.pooling, normalize: this.data.normalize });
      const vectors = request.texts.map(text => {
        const vector = new Array<number>(LOCAL_MINILM_SPACE.dim).fill(0);
        vector[Number.parseInt(text.slice(1),10) % LOCAL_MINILM_SPACE.dim] = 1;
        return vector;
      });
      queueMicrotask(() => this.emit('message', { id:request.id, vectors }));
    }
  }
  return { Worker };
});

type TransformerTestState = {
  batches: string[][];
  options: Array<{ pooling?: string; normalize?: boolean }>;
  sessionOptions: Array<unknown>;
};

const transformerState = (): TransformerTestState => {
  const target = globalThis as typeof globalThis & { __varinMinilmTestState?: TransformerTestState };
  target.__varinMinilmTestState ??= { batches: [], options: [], sessionOptions: [] };
  return target.__varinMinilmTestState;
};

import { createLocalSemanticEmbedder } from "./local-embedder.js";

const pack: ResolvedModelPack = {
  id: "all-minilm-l6-v2",
  root: "C:/model/all-minilm-l6-v2",
  recipe: {
    schemaVersion: 1,
    provider: "local",
    model: LOCAL_MINILM_SPACE.model,
    modelRevision: LOCAL_MINILM_SPACE.modelRevision,
    dim: LOCAL_MINILM_SPACE.dim,
    pooling: LOCAL_MINILM_SPACE.pooling,
    normalize: LOCAL_MINILM_SPACE.normalize,
    maxTokens: LOCAL_MINILM_SPACE.maxTokens,
    onnxFile: "model_quantized.onnx",
    tokenizerFile: "tokenizer.json",
  },
  space: LOCAL_MINILM_SPACE,
  onnxPath: "C:/model/all-minilm-l6-v2/onnx/model_quantized.onnx",
  tokenizerPath: "C:/model/all-minilm-l6-v2/tokenizer.json",
  source: "bundled",
  transformersEntry: fileURLToPath(new URL('./fixtures/embedding-tokenizer.mjs', import.meta.url)),
  inferenceWorkerEntry: "C:/model/runtime/local-embedding-worker.mjs",
};

describe("local MiniLM batching", () => {
  beforeEach(() => {
    const transformer = transformerState();
    transformer.batches.length = 0;
    transformer.options.length = 0;
    transformer.sessionOptions.length = 0;
  });

  it("embeds every input as ordered array batches and keeps single queries array-shaped", async () => {
    const transformer = transformerState();
    const embedder = createLocalSemanticEmbedder({ dataDir: "", pack });
    await embedder.prepare();
    const vectors = await embedder.embed(Array.from({ length: 70 }, (_, index) => `v${index}`));

    expect(transformer.batches.map((batch) => batch.length)).toEqual([32, 32, 6]);
    expect(vectors).toHaveLength(70);
    expect(vectors.every((vector) => vector.length === LOCAL_MINILM_SPACE.dim)).toBe(true);
    expect(vectors[0]?.[0]).toBe(1);
    expect(vectors[69]?.[69]).toBe(1);
    expect(transformer.options.every((options) => options.normalize === true && options.pooling === "mean")).toBe(true);

    const [query] = await embedder.embed(["v7"]);
    expect(transformer.batches.at(-1)).toEqual(["v7"]);
    expect(query).toHaveLength(LOCAL_MINILM_SPACE.dim);
    expect(query?.[7]).toBe(1);
    expect(transformer.sessionOptions[0]).toMatchObject({
      intraOpNumThreads: expect.any(Number),
      intra_op_num_threads: expect.any(Number),
    });
  });
});
