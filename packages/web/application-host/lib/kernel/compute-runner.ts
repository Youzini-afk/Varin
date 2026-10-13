import { randomUUID } from "node:crypto";
import type { KernelScopedClient } from "./kernel-client.js";
import type { KernelComputeReadResult, KernelComputeRecord, KernelComputeStartParams } from "./protocol.generated.js";

export type KernelComputeInput = Omit<KernelComputeStartParams, "jobId">;
export interface KernelComputeOptions {
  signal?: AbortSignal | undefined;
  collect?: boolean | undefined;
  onRecords?: ((records: KernelComputeRecord[]) => void | Promise<void>) | undefined;
  /** Local observer only; called after original terminal evidence and release. */
  onDrained?: (() => void) | undefined;
}
export interface KernelComputeResult extends Omit<KernelComputeReadResult, "records"> {
  records: KernelComputeRecord[];
}
const terminal = (status: string): boolean => !["queued", "running"].includes(status);
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const validate = (page: KernelComputeReadResult, workspaceId: string, jobId: string, epoch?: string): void => {
  if (!page || page.jobId !== jobId || page.workspaceId !== workspaceId || typeof page.kernelEpoch !== "string"
    || (epoch !== undefined && page.kernelEpoch !== epoch)
    || !["queued", "running", "ready", "empty", "partial", "failed", "cancelled"].includes(page.status)
    || !Array.isArray(page.records) || !Number.isSafeInteger(page.nextCursor) || !Number.isSafeInteger(page.endCursor)
    || page.nextCursor < 0 || page.endCursor < page.nextCursor || !Number.isSafeInteger(page.scannedFiles)
    || page.records.some((record) => typeof record.kind !== "string" || typeof record.path !== "string" || typeof record.revision !== "string")) {
    throw new Error("Native computation returned an invalid identity, cursor or record");
  }
};
const withAbort = async (work: Promise<void>, signal?: AbortSignal): Promise<void> => {
  if (!signal) return work;
  signal.throwIfAborted();
  let onAbort!: () => void;
  try {
    await Promise.race([work, new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("Computation cancelled", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
};

/** One read-only operation. Only Rust terminal evidence permits release. */
export async function runKernelCompute(
  client: KernelScopedClient,
  input: KernelComputeInput,
  options: KernelComputeOptions = {},
): Promise<KernelComputeResult> {
  options.signal?.throwIfAborted();
  const jobId = "compute:" + randomUUID();
  const address = { workspaceId: input.workspaceId, jobId };
  // Do not abandon admission while a native job might have been created. An
  // abort during this short handoff is applied to the exact returned job.
  let page = await client.computeStart({ ...input, jobId });
  validate(page, input.workspaceId, jobId);
  const epoch = page.kernelEpoch;
  const root = page.root;
  let cursor = 0;
  let cancelled = false;
  let finished = false;
  const records: KernelComputeRecord[] = [];
  const cancel = async (): Promise<void> => {
    if (cancelled) return;
    await client.computeCancel(address);
    cancelled = true;
  };
  try {
    for (;;) {
      validate(page, input.workspaceId, jobId, epoch);
      if (page.root !== root) throw new Error("Native computation changed its pinned root");
      if (options.signal?.aborted) await cancel();
      if (!cancelled) {
        if (page.nextCursor !== cursor + page.records.length) throw new Error("Native computation cursor skipped records");
        if (options.collect !== false) records.push(...page.records);
        if (page.records.length > 0 && options.onRecords) {
          await withAbort(Promise.resolve(options.onRecords(page.records)), options.signal);
        }
      }
      cursor = page.nextCursor;
      if (terminal(page.status) && cursor === page.endCursor) {
        finished = true;
        options.signal?.throwIfAborted();
        return { ...page, records };
      }
      await pause(page.records.length > 0 ? 0 : 5);
      page = await client.computeRead({ ...address, cursor });
    }
  } finally {
    if (!finished) {
      await cancel();
      // Cancellation discards buffered output and unblocks the worker; its
      // terminal record is still required before dropping the reader reference.
      for (;;) {
        const observed = await client.computeRead({ ...address, cursor });
        validate(observed, input.workspaceId, jobId, epoch);
        cursor = observed.nextCursor;
        if (terminal(observed.status)) break;
        await pause(5);
      }
    }
    await client.computeRelease(address);
    // Observers cannot replace the original result or failure. A cleanup failure
    // above never reaches this notification.
    try { options.onDrained?.(); } catch { /* observational callback */ }
  }
}
