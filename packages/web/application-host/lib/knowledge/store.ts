/** KnowledgeStore facade. The private storage process is the only holder of the
 * native TriviumDB handle; main-process callers receive committed async results. */
import type { KnowledgeStore, OpenWorkspaceKnowledgeDeps } from "./store-contract.js";
import { knowledgeStoreProcess } from "./store-process.js";
import { STORE_METHODS, restoreStoreError, type StoreMethod } from "./store-protocol.js";
export * from "./store-contract.js";

export async function openWorkspaceKnowledge(deps: OpenWorkspaceKnowledgeDeps): Promise<KnowledgeStore> {
  const owner = knowledgeStoreProcess();
  let revision = "";
  let closed = false;
  let closing: Promise<void> | null = null;
  const storeId = owner.register({
    revision: (value) => { revision = value; },
    notify: (message) => {
      if (message.type === "blocks") deps.onBlocksChanged?.(message.sessionId, message.change);
      else if (message.type === "knowledge") deps.onKnowledgeChanged?.(message.ids);
      else if (deps.onPersistenceError) deps.onPersistenceError(restoreStoreError(message.error));
      else console.error("[KnowledgeStore] Deferred checkpoint failed; storage retains pending data for retry");
    },
  });
  let dim: number;
  try {
    const result = await owner.request(storeId, "open", [{
      dataDir: deps.dataDir, hostId: deps.hostId, workspaceId: deps.workspaceId,
      ...(deps.scope === undefined ? {} : { scope: deps.scope }),
      // The authority store uses only the dimension. Embedding callbacks belong
      // to the derived semantic adapters and must not cross a process boundary.
      embedding: deps.embedding ? { dim: deps.embedding.dim } : null,
    }]) as { dim: number };
    dim = result.dim;
  } catch (error) {
    await owner.release(storeId);
    throw error;
  }
  const call = (method: StoreMethod, args: unknown[], signal?: AbortSignal): Promise<unknown> => {
    if (closed || closing) return Promise.reject(new Error("Knowledge store is closing or closed"));
    return owner.request(storeId, method, args, signal);
  };
  const methods = Object.fromEntries((Object.keys(STORE_METHODS) as StoreMethod[])
    .map(method => [method, (...args: unknown[]) => call(method, args)])) as Pick<KnowledgeStore, StoreMethod>;
  return {
    ...methods,
    dim,
    knowledgeRevision: () => {
      if (owner.failed || closed) throw new Error("Knowledge store is unavailable");
      return revision;
    },
    removeFileSymbols: (path, options) => {
      const { signal, ...serializable } = options ?? {};
      // Cancellation is honored before dispatch. Once admitted to the native
      // writer, return its definitive result rather than falsely reporting that
      // a mutation was cancelled after it may already have committed.
      return call("removeFileSymbols", [path, options === undefined ? undefined : serializable], signal) as ReturnType<KnowledgeStore["removeFileSymbols"]>;
    },
    close: () => {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = owner.request(storeId, "close", []).then(async () => {
        closed = true;
        await owner.release(storeId);
      }).catch(async (error: unknown) => {
        closing = null;
        if (owner.failed) {
          closed = true;
          await owner.release(storeId);
        }
        throw error;
      });
      return closing;
    },
  };
}
