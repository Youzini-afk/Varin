import { waitWithSignal } from '../cancellation.js';
import type { ThreadAttentionSnapshot, ThreadIdentity } from '@varin/application-client';

/** Private Storage record metadata; BotService remains the only Bot identity owner. */
export interface AttentionBotProfile { botId: string; entry: ThreadIdentity; recordRevision: number; }
export interface NativeThreadAttentionSnapshot extends ThreadAttentionSnapshot {
  botGates?: { botId: string; profileRevision: number; kernelEpoch: number }[];
}
export type AttentionBotProfiles = () => Promise<AttentionBotProfile[]>;

/** A revision proof across Storage and Catalog, NOT a cross-database atomic transaction.
 * Only the native facts are transaction-consistent. Missing proof never removes native work.
 */
export async function readThreadAttention(read: () => Promise<NativeThreadAttentionSnapshot>,
  profiles?: AttentionBotProfiles, signal?: AbortSignal): Promise<ThreadAttentionSnapshot> {
  const readProfiles = async () => {
    signal?.throwIfAborted();
    try { return await waitWithSignal(profiles!(), signal); }
    catch (error) { if (signal?.aborted) throw error; return null; }
    finally { signal?.throwIfAborted(); }
  };
  let before = profiles ? await readProfiles() : null;
  // One immediate retry closes a concurrent profile publication gap; no timer or new observer.
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const { botGates, ...snapshot } = await read();
    signal?.throwIfAborted();
    if (!profiles || !botGates) return snapshot;
    const after = await readProfiles();
    const relevant = new Set(snapshot.branches.flatMap(branch => branch.botId ? [branch.botId] : []));
    const initial = new Map(before?.map(profile => [profile.botId, profile]) ?? []);
    const current = new Map(after?.map(profile => [profile.botId, profile]) ?? []);
    const botEntries: NonNullable<ThreadAttentionSnapshot['botEntries']> = [];
    for (const gate of botGates) {
      const first = initial.get(gate.botId); const last = current.get(gate.botId);
      if (!relevant.has(gate.botId) || !first || !last || gate.kernelEpoch !== snapshot.epoch
        || first.recordRevision !== gate.profileRevision || last.recordRevision !== gate.profileRevision
        || first.entry.runtime !== 'agent' || last.entry.runtime !== 'agent'
        || first.entry.threadId !== last.entry.threadId || first.entry.branchId !== last.entry.branchId) continue;
      const entryBranch = snapshot.branches.find(branch => branch.threadId === last.entry.threadId && branch.branchId === last.entry.branchId);
      if (entryBranch && entryBranch.botId !== gate.botId) continue;
      botEntries.push({ botId: gate.botId, threadId: last.entry.threadId, branchId: last.entry.branchId, profileRevision: gate.profileRevision });
    }
    if (attempt === 0 && relevant.size > botEntries.length) { before = after; continue; }
    return { ...snapshot, botEntries };
  }
}
