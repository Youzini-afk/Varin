import { randomUUID } from 'node:crypto';
import type { ComputerEvidenceEntry, ComputerEvidenceParams, ComputerEvidenceResult } from '@varin/protocol';
import type { KernelScopedClient } from '../kernel/kernel-client.js';
import { HarnessServiceError } from '../harness/service-error.js';

/** Kernel-owned immutable steps; a reserved but unwritten seq is an honest gap. */
export function createComputerEvidence(options: {
  client(): Promise<KernelScopedClient>;
  workspaceId: string;
  owns(desktopId: string): Promise<boolean>;
}) {
  const tails = new Map<string, Promise<void>>();
  const cursorId = (id: string) => `computer.evidence.cursor:${id}`;
  const stepId = (id: string, seq: number) => `computer.evidence.step:${id}:${seq}`;

  const record = async (desktopId: string, entry: Omit<ComputerEvidenceEntry, 'seq' | 'at'>): Promise<void> => {
    const operation = (tails.get(desktopId) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (!await options.owns(desktopId)) return;
      const client = await options.client();
      const previous = await client.getRecord(options.workspaceId, cursorId(desktopId));
      const reserved = await client.putRecord({ operationId: randomUUID(), workspaceId: options.workspaceId,
        recordId: cursorId(desktopId), recordType: 'computer.evidence.cursor', state: 'active',
        payloadJson: '{}', ownerIds: [], references: [],
        ...(previous ? { expectedRecordRevision: previous.recordRevision } : {}) });
      const seq = reserved.recordRevision;
      await client.putRecord({ operationId: randomUUID(), workspaceId: options.workspaceId,
        recordId: stepId(desktopId, seq), recordType: 'computer.evidence.step', state: 'active',
        payloadJson: JSON.stringify({ ...entry, seq, at: new Date().toISOString() }), ownerIds: [], references: [],
        ...(entry.sessionId ? { sessionId: entry.sessionId } : {}) });
    });
    tails.set(desktopId, operation);
    try { await operation; }
    finally { if (tails.get(desktopId) === operation) tails.delete(desktopId); }
  };

  const read = async (desktopId: string, params: ComputerEvidenceParams & { signal?: AbortSignal }): Promise<ComputerEvidenceResult> => {
    if (params.since !== undefined && (!Number.isSafeInteger(params.since) || params.since < 0)) {
      throw new HarnessServiceError('invalid-params', 'Evidence since must be a non-negative sequence');
    }
    const limit = params.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new HarnessServiceError('invalid-params', 'Evidence limit must be a positive integer');
    const client = await options.client();
    const last = (await client.getRecord(options.workspaceId, cursorId(desktopId)))?.recordRevision ?? 0;
    if (params.since !== undefined && params.since > last) {
      throw new HarnessServiceError('invalid-params', 'Evidence since is beyond this desktop journal');
    }
    const entries: ComputerEvidenceEntry[] = [];
    const forward = params.since !== undefined;
    let seq = forward ? params.since! + 1 : last;
    let scanned = params.since ?? last;
    while (forward ? seq <= last : seq > 0) {
      params.signal?.throwIfAborted();
      const stored = await client.getRecord(options.workspaceId, stepId(desktopId, seq));
      if (stored) {
        let entry: ComputerEvidenceEntry;
        try { entry = JSON.parse(stored.payloadJson) as ComputerEvidenceEntry; }
        catch { throw new HarnessServiceError('unavailable', `Malformed computer evidence at sequence ${seq}`); }
        if (entry.seq !== seq || typeof entry.at !== 'string' || !['observe', 'action'].includes(entry.lane)
          || typeof entry.tool !== 'string' || !['ok', 'error', 'cancelled', 'unknown', 'rejected'].includes(entry.outcome)) {
          throw new HarnessServiceError('unavailable', `Invalid computer evidence at sequence ${seq}`);
        }
        if (params.sessionId === undefined || entry.sessionId === params.sessionId) entries.push(entry);
      }
      scanned = seq;
      seq += forward ? 1 : -1;
      if (entries.length === limit) break;
    }
    if (!forward) entries.reverse();
    return { desktopId, entries, nextSince: forward ? scanned : last, hasMore: forward && seq <= last };
  };
  return { record, read, drain: async () => { await Promise.allSettled(tails.values()); } };
}
