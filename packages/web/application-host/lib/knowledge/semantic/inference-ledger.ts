/** Host facade over the existing semantic storage process; never a second DB owner. */
import { knowledgeStoreProcess } from "../store-process.js";
import type { SemanticInferenceLedger, SemanticInferenceLedgerOpenOptions } from "./inference-ledger-contract.js";
export type { SemanticInferenceLedger, SemanticInferenceLedgerIdentity, SemanticInferenceOperation,
  SemanticInferenceAdmission, SemanticInferenceAdmissionResult, SemanticInferenceSettlement,
  SemanticInferenceFact, SemanticInferenceFactFilter } from "./inference-ledger-contract.js";
export { semanticInferenceOperationKey } from "./inference-ledger-contract.js";

export function createSemanticInferenceLedger(options: SemanticInferenceLedgerOpenOptions): SemanticInferenceLedger {
  let owner: ReturnType<typeof knowledgeStoreProcess> | null = null;
  let storeId = 0;
  let opening: Promise<void> | null = null;
  let initializationFailed = false;
  let closed = false;
  let closing: Promise<void> | null = null;
  const pending = new Set<Promise<unknown>>();
  const open = (): Promise<void> => {
    if (opening) return opening;
    owner = knowledgeStoreProcess("semantic");
    storeId = owner.register({ revision: () => {}, notify: () => {} });
    const active = owner;
    opening = active.request(storeId, "semantic", ["inference-open", options]).then(() => undefined).catch(async error => {
      initializationFailed = true;
      await active.release(storeId);
      throw error;
    });
    return opening;
  };
  const call = async <T>(method: string, args: unknown[]): Promise<T> => {
    await open();
    return await owner!.request(storeId, "semantic", [`inference-${method}`, ...args]) as T;
  };
  const track = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed || closing) return Promise.reject(new Error("Semantic inference ledger is closed"));
    // Once admission may have reached the owner, always observe the durable
    // acknowledgement before deciding whether an external request may be sent.
    const task = Promise.resolve().then(operation);
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };
  return {
    admit: input => track(() => call("admit", [input])),
    settle: (token, settlement) => track(() => call("settle", [token, settlement])),
    read: key => track(() => call("read", [key])),
    list: (filter = {}) => track(() => call("list", [filter])),
    close: () => {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = (async () => {
        await Promise.allSettled([...pending]);
        if (opening && !initializationFailed) {
          try { await call("close", []); }
          catch (error) {
            if (owner?.failed) { closed = true; await owner.release(storeId); }
            throw error;
          }
          await owner!.release(storeId);
        }
        closed = true;
      })().catch(error => { closing = null; throw error; });
      return closing;
    },
  };
}
