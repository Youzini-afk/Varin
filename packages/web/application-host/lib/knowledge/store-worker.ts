/** Application Host private storage process. Never imported into Electron main. */
import { openKnowledgeStoreEngine, type KnowledgeStoreEngine } from "./store-engine.js";
import { createSemanticStoreEngine, type SemanticStoreEngine } from "./semantic/store-engine.js";
import { isSemanticStoreMethod } from "./semantic/store-protocol.js";
import { purgeSemanticWorkspaceCache } from "./semantic/cache-maintenance-engine.js";
import type { SemanticStoreOpenOptions } from "./semantic/store-contract.js";
import {
  isStoreMethod, storeFailure, type StoreChildMessage, type StoreOpenOptions,
  type StoreRequest, type StoreResponse,
} from "./store-protocol.js";

if (!process.send) throw new Error("Knowledge storage requires a private IPC channel");
const stores = new Map<number, KnowledgeStoreEngine>();
const semanticStores = new Map<number, SemanticStoreEngine>();
let tail: Promise<void> = Promise.resolve();
let disconnected = false;
const send = (message: StoreChildMessage): Promise<void> => new Promise(resolve => {
  if (!process.connected) { resolve(); return; }
  process.send!(message, (error: Error | null) => {
    if (error && process.connected) process.disconnect();
    resolve();
  });
});
const validateRequest = (value: unknown): value is StoreRequest => {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<StoreRequest>;
  return Number.isSafeInteger(r.id) && Number.isSafeInteger(r.storeId)
    && (r.method === "open" || r.method === "semantic" || isStoreMethod(r.method)) && Array.isArray(r.args);
};
const openOptions = (value: unknown): StoreOpenOptions => {
  if (!value || typeof value !== "object") throw new Error("Invalid knowledge store open request");
  const input = value as StoreOpenOptions;
  if (typeof input.dataDir !== "string" || typeof input.hostId !== "string"
    || typeof input.workspaceId !== "string" || (input.embedding !== null
      && (!input.embedding || !Number.isSafeInteger(input.embedding.dim) || input.embedding.dim < 1))
    || (input.scope !== undefined && !["workspace", "user", "session", "bot"].includes(input.scope))) {
    throw new Error("Invalid knowledge store open request");
  }
  return input;
};

async function handle(requests: StoreRequest[]): Promise<void> {
  const responses: StoreResponse[] = [];
  let offset = 0;
  while (offset < requests.length) {
    const first = requests[offset]!;
    if (first.method === "semantic") {
      offset += 1;
      try {
        const [method, ...args] = first.args;
        if (method === "purge") {
          await purgeSemanticWorkspaceCache(args[0] as Parameters<typeof purgeSemanticWorkspaceCache>[0]);
          responses.push({ id: first.id, ok: true, value: undefined });
        } else if (method === "open") {
          if (semanticStores.has(first.storeId) || stores.has(first.storeId)) throw new Error("Storage handle already exists");
          const input = args[0] as SemanticStoreOpenOptions;
          if (!input || typeof input.dataDir !== "string" || typeof input.hostId !== "string"
            || typeof input.scope?.scopeId !== "string" || typeof input.scope.scopeKind !== "string"
            || !Number.isSafeInteger(input.space?.dim) || input.space.dim < 1) throw new Error("Invalid semantic store open request");
          const store = createSemanticStoreEngine({ ...input,
            onPersistenceError: error => send({ type: "persistence-error", storeId: first.storeId, error: storeFailure(error) }),
          });
          semanticStores.set(first.storeId, store);
          responses.push({ id: first.id, ok: true, value: { checkpoint: store.checkpoint() } });
        } else {
          if (!isSemanticStoreMethod(method)) throw new Error("Invalid semantic store method");
          const store = semanticStores.get(first.storeId);
          if (!store) throw new Error("Semantic store is not open");
          const value: unknown = await Reflect.apply(store[method], store, args);
          if (method === "close") semanticStores.delete(first.storeId);
          responses.push({ id: first.id, ok: true, value: { value, checkpoint: store.checkpoint() } });
        }
      } catch (error) {
        if (first.args[0] === "open" && error instanceof AggregateError) throw error;
        responses.push({ id: first.id, ok: false, error: storeFailure(error) });
      }
      await send({ type: "results", responses: responses.splice(0) });
      continue;
    }
    if (first.method === "open" || first.method === "close") {
      offset += 1;
      try {
        if (first.method === "open") {
          if (stores.has(first.storeId)) throw new Error("Knowledge store handle already exists");
          const store = await openKnowledgeStoreEngine({
            ...openOptions(first.args[0]),
            onBlocksChanged: (sessionId, change) => send({ type: "blocks", storeId: first.storeId, sessionId, change }),
            onKnowledgeChanged: (ids) => send({
              type: "knowledge", storeId: first.storeId, ids,
              revision: stores.get(first.storeId)!.knowledgeRevision(),
            }),
            onPersistenceError: (error) => send({ type: "persistence-error", storeId: first.storeId, error: storeFailure(error) }),
          });
          stores.set(first.storeId, store);
          responses.push({ id: first.id, ok: true, value: { dim: store.dim }, revision: store.knowledgeRevision() });
        } else {
          const store = stores.get(first.storeId);
          if (store) {
            await store.close();
            stores.delete(first.storeId); // Never discard a handle whose close failed.
          }
          responses.push({ id: first.id, ok: true, value: undefined });
        }
      } catch (error) {
        // An initialization handle that could not be closed must not remain an
        // untracked writer. Disconnect drains the other stores before exit.
        if (first.method === "open" && error instanceof AggregateError) throw error;
        responses.push({ id: first.id, ok: false, error: storeFailure(error) });
      }
      await send({ type: "results", responses: responses.splice(0) });
      continue;
    }

    // Requests arrive in admitted order. Only a contiguous run on one store
    // shares a durability boundary; no cross-store transaction or rollback is implied.
    const group: StoreRequest[] = [];
    while (offset < requests.length) {
      const r = requests[offset]!;
      if (r.storeId !== first.storeId || r.method === "open" || r.method === "close" || r.method === "semantic") break;
      group.push(r);
      offset += 1;
    }
    const store = stores.get(first.storeId);
    if (!store) {
      for (const r of group) responses.push({ id: r.id, ok: false, error: storeFailure(new Error("Knowledge store is not open")) });
      await send({ type: "results", responses: responses.splice(0) });
      continue;
    }
    const results: StoreResponse[] = [];
    try {
      await store.runBatch(async () => {
        for (const r of group) {
          try {
            if (!isStoreMethod(r.method)) throw new Error("Invalid knowledge store method");
            const value: unknown = await Reflect.apply(store[r.method], store, r.args);
            results.push({ id: r.id, ok: true, value });
          } catch (error) {
            results.push({ id: r.id, ok: false, error: storeFailure(error) });
          }
        }
      });
      responses.push(...results.map(result => ({ ...result, revision: store.knowledgeRevision() })));
    } catch (error) {
      // Native checkpoint failed after in-memory changes. Reject every result
      // that depended on this checkpoint, without replaying those mutations.
      const failure = storeFailure(error);
      for (const r of group) {
        const result = results.find(item => item.id === r.id);
        responses.push(result?.ok === false ? result : { id: r.id, ok: false, error: failure });
      }
    }
    // This group's durability boundary is complete. Publish it before entering another
    // store: unrelated native work must not delay an already durable result.
    await send({ type: "results", responses: responses.splice(0) });
  }
}

process.on("message", (message: unknown) => {
  if (disconnected) return;
  if (!message || typeof message !== "object"
    || (message as { type?: unknown }).type !== "batch"
    || !Array.isArray((message as { requests?: unknown }).requests)) {
    process.disconnect();
    return;
  }
  const requests = (message as { requests: unknown[] }).requests;
  if (!requests.every(validateRequest)) { process.disconnect(); return; }
  tail = tail.then(() => handle(requests)).catch(() => {
    // A transport/programming failure has an unknown outcome; the parent rejects
    // outstanding work on disconnect instead of treating it as a successful empty result.
    if (process.connected) process.disconnect();
  });
});
process.once("disconnect", () => {
  disconnected = true;
  void tail.then(async () => {
    const results = await Promise.allSettled([...stores.values(), ...semanticStores.values()].map(store => store.close()));
    // Process exit also releases Windows mmap handles still retained by the addon.
    process.exit(results.some(result => result.status === "rejected") ? 1 : 0);
  });
});
void send({ type: "ready", version: 2 });
