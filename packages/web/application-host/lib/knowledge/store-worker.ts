/** Application Host private storage process. Never imported into Electron main. */
import { openKnowledgeStoreEngine, type KnowledgeStoreEngine } from "./store-engine.js";
import {
  isStoreMethod, storeFailure, type StoreChildMessage, type StoreOpenOptions,
  type StoreRequest, type StoreResponse,
} from "./store-protocol.js";

if (!process.send) throw new Error("Knowledge storage requires a private IPC channel");
const stores = new Map<number, KnowledgeStoreEngine>();
let tail: Promise<void> = Promise.resolve();
let disconnected = false;
const send = (message: StoreChildMessage): void => {
  if (!process.connected) return;
  process.send!(message, (error: Error | null) => {
    if (error && process.connected) process.disconnect();
  });
};
const validateRequest = (value: unknown): value is StoreRequest => {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<StoreRequest>;
  return Number.isSafeInteger(r.id) && Number.isSafeInteger(r.storeId)
    && (r.method === "open" || isStoreMethod(r.method)) && Array.isArray(r.args);
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
      continue;
    }

    // Requests arrive in admitted order. Only a contiguous run on one store
    // shares a checkpoint; no cross-store transaction or rollback is implied.
    const group: StoreRequest[] = [];
    while (offset < requests.length) {
      const r = requests[offset]!;
      if (r.storeId !== first.storeId || r.method === "open" || r.method === "close") break;
      group.push(r);
      offset += 1;
    }
    const store = stores.get(first.storeId);
    if (!store) {
      for (const r of group) responses.push({ id: r.id, ok: false, error: storeFailure(new Error("Knowledge store is not open")) });
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
  }
  send({ type: "results", responses });
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
    const results = await Promise.allSettled([...stores.values()].map(store => store.close()));
    // Process exit also releases Windows mmap handles still retained by the addon.
    process.exit(results.some(result => result.status === "rejected") ? 1 : 0);
  });
});
send({ type: "ready", version: 1 });
