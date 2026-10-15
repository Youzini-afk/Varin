import type { KernelProcessInteractionReceipt } from './protocol.generated.js';

type ExpectedInteraction = { processId: string; operationId: string; kernelEpoch?: string } & (
  | { kind: 'write'; requestedBytes: number; eofRequested: boolean }
  | { kind: 'resize'; cols: number; rows: number }
);

/** The original effect evidence remains available to callers after a partial or unknown write. */
export class ProcessInteractionError extends Error {
  constructor(readonly receipt: KernelProcessInteractionReceipt) {
    super(`Process ${receipt.kind} ${receipt.state}: ${receipt.reason ?? 'the effect was not completely confirmed'}`);
    this.name = 'ProcessInteractionError';
  }
}

/** A queue acknowledgement or an unrelated original receipt cannot complete this interaction. */
export function requireAppliedProcessInteraction(receipt: KernelProcessInteractionReceipt, expected: ExpectedInteraction): void {
  if (!receipt || receipt.processId !== expected.processId || receipt.operationId !== expected.operationId
    || receipt.kind !== expected.kind || (expected.kernelEpoch !== undefined && receipt.kernelEpoch !== expected.kernelEpoch)
    || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 0
    || !['applied', 'partial', 'not_applied', 'unknown'].includes(receipt.state)
    || typeof receipt.cancelled !== 'boolean' || (receipt.reason !== null && typeof receipt.reason !== 'string')) {
    throw new Error('Process interaction receipt identity or state is invalid');
  }
  if (receipt.kind === 'write' && expected.kind === 'write') {
    if (receipt.requestedBytes !== expected.requestedBytes || receipt.eofRequested !== expected.eofRequested
      || !Number.isSafeInteger(receipt.confirmedBytes) || receipt.confirmedBytes < 0 || receipt.confirmedBytes > receipt.requestedBytes
      || typeof receipt.eofApplied !== 'boolean'
      || (receipt.eofApplied && !receipt.eofRequested)
      || (receipt.state === 'applied' && (receipt.confirmedBytes !== receipt.requestedBytes || receipt.eofApplied !== receipt.eofRequested))) {
      throw new Error('Process input receipt differs from its original intent');
    }
  } else if (receipt.kind === 'resize' && expected.kind === 'resize'
    && (receipt.cols !== expected.cols || receipt.rows !== expected.rows)) {
    throw new Error('Process resize receipt differs from its original intent');
  }
  if (receipt.state !== 'applied') throw new ProcessInteractionError(receipt);
}
