/**
 * In-process vector reuse. Identity is space + purpose + the text actually
 * sent to the backend. A full cache never rejects a query; it only evicts.
 */

import type { SemanticEmbedPurpose } from "./embedder.js";
import { embedTextKey } from "./identity.js";

export const DEFAULT_VECTOR_CACHE_BYTES = 64 * 1024 * 1024;

export type VectorCacheKey = {
  spaceId: string;
  purpose: SemanticEmbedPurpose;
  embedText: string;
  /** Query credential provenance; background/index reuse keeps its original key. */
  authority?: string;
};

const keyOf = (input: VectorCacheKey): string => (
  `${input.spaceId}\0${input.purpose}\0${embedTextKey(input.embedText)}\0${input.authority ?? ""}`
);

const vectorBytes = (vector: readonly number[]): number => vector.length * 8 + 64;

export function createVectorCache(options?: { maxBytes?: number }) {
  const maxBytes = options?.maxBytes ?? DEFAULT_VECTOR_CACHE_BYTES;
  const entries = new Map<string, { vector: number[]; bytes: number }>();
  const inFlight = new Map<string, {
    promise: Promise<number[]>;
    resolve(vector: number[]): void;
    reject(error: unknown): void;
  }>();
  let usedBytes = 0;

  const evict = (needed: number): void => {
    if (maxBytes <= 0) {
      entries.clear();
      usedBytes = 0;
      return;
    }
    while (usedBytes + needed > maxBytes && entries.size > 0) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const removed = entries.get(oldestKey);
      entries.delete(oldestKey);
      usedBytes = Math.max(0, usedBytes - (removed?.bytes ?? 0));
    }
  };

  return {
    get usedBytes() { return usedBytes; },
    get size() { return entries.size; },
    get(input: VectorCacheKey): number[] | undefined {
      const entry = entries.get(keyOf(input));
      if (!entry) return undefined;
      const key = keyOf(input);
      entries.delete(key);
      entries.set(key, entry);
      return entry.vector;
    },
    set(input: VectorCacheKey, vector: readonly number[]): void {
      const key = keyOf(input);
      const bytes = vectorBytes(vector);
      const previous = entries.get(key);
      if (previous) usedBytes = Math.max(0, usedBytes - previous.bytes);
      entries.delete(key);
      if (bytes > maxBytes) {
        entries.delete(key);
        return;
      }
      evict(bytes);
      entries.delete(key);
      entries.set(key, { vector: [...vector], bytes });
      usedBytes += bytes;
    },
    claim(input: VectorCacheKey): {
      owner: boolean;
      promise: Promise<number[]>;
      resolve(vector: readonly number[]): void;
      reject(error: unknown): void;
    } {
      const key = keyOf(input);
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key);
        entries.set(key, cached);
        return {
          owner: false,
          promise: Promise.resolve(cached.vector),
          resolve: () => undefined,
          reject: () => undefined,
        };
      }
      const existing = inFlight.get(key);
      if (existing) return { owner: false, ...existing };
      let resolvePromise!: (vector: number[]) => void;
      let rejectPromise!: (error: unknown) => void;
      const promise = new Promise<number[]>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      // A different batch can own this claim while its consumers are still
      // preparing their own vectors. Keep rejection handled until they await it.
      void promise.catch(() => undefined);
      const created = {
        promise,
        resolve: (vector: readonly number[]) => {
          if (inFlight.get(key) !== created) return;
          inFlight.delete(key);
          resolvePromise([...vector]);
        },
        reject: (error: unknown) => {
          if (inFlight.get(key) !== created) return;
          inFlight.delete(key);
          rejectPromise(error);
        },
      };
      inFlight.set(key, created);
      return { owner: true, ...created };
    },
    clear(): void {
      entries.clear();
      usedBytes = 0;
    },
  };
}

export type SemanticVectorCache = ReturnType<typeof createVectorCache>;
