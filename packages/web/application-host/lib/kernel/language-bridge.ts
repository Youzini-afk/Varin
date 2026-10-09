import { waitWithSignal } from '../cancellation.js';
import type { LanguageQuery } from './protocol.generated.js';
import type { LanguageToolOwner, LanguageResult } from './language-owner.js';

export interface PrivateLanguageResponse { v: 1; kind: 'language-response'; id: string; kernelEpoch: string; result: LanguageResult }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const unavailableLanguageResult = (message: string): LanguageResult => ({ status: 'unavailable', items: [], omissions: { outOfScope: 0, unmappable: 0, stale: 0, unavailable: 0 }, message });
const validQuery = (value: unknown): value is LanguageQuery => {
  if (!record(value) || !['runId','threadId','workspaceId','executionWorkspaceId','path'].every(key => text(value[key]))
    || !record(value.liveRoot) || !['hostId','canonicalRoot','rootId'].every(key => text(value.liveRoot && record(value.liveRoot) ? value.liveRoot[key] : undefined))
    || !['definition','references','diagnostics'].includes(String(value.method))) return false;
  return value.method === 'diagnostics' ? value.line === undefined && value.character === undefined
    : [value.line,value.character].every(position => Number.isSafeInteger(position) && Number(position) >= 0);
};
/** Only private kernel frames reach this adapter. Calls never enter a serial Host queue. */
export class LanguageBridge {
  private owner?: LanguageToolOwner;
  private readonly active = new Map<string, { epoch: string; controller: AbortController }>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateLanguageResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  setOwner(owner: LanguageToolOwner): void {
    if (this.owner && this.owner !== owner) throw new Error('Language owner is already connected');
    this.owner = owner;
  }
  close(): void {
    for (const entry of this.active.values()) entry.controller.abort(new DOMException('Language channel closed', 'AbortError'));
    this.active.clear();
  }
  consume(value: unknown): boolean {
    if (!record(value) || !['language-request','language-cancel'].includes(String(value.kind))) return false;
    if (value.v !== 1 || !text(value.id) || !text(value.kernelEpoch) || value.kernelEpoch !== this.currentEpoch()) return true;
    const id = value.id; const epoch = value.kernelEpoch;
    if (value.kind === 'language-cancel') {
      const entry = this.active.get(id);
      if (entry?.epoch === epoch) entry.controller.abort(new DOMException('Language query cancelled', 'AbortError'));
      return true;
    }
    if (this.active.has(id)) return true;
    const controller = new AbortController();
    const entry = { epoch, controller };
    this.active.set(id, entry);
    const query = value.query;
    const owner = this.owner;
    void (async () => {
      let result: LanguageResult;
      try {
        result = validQuery(query) && owner
          ? await waitWithSignal(owner(query, controller.signal), controller.signal)
          : unavailableLanguageResult(owner ? 'Invalid language query' : 'Language owner is unavailable');
      } catch (error) {
        result = controller.signal.aborted ? { ...unavailableLanguageResult('Language query cancelled'), status: 'cancelled' }
          : unavailableLanguageResult(error instanceof Error ? error.message : 'Language query failed');
      }
      if (this.active.get(id) !== entry) return;
      this.active.delete(id);
      if (epoch !== this.currentEpoch()) return;
      await this.send({ v: 1, kind: 'language-response', id, kernelEpoch: epoch, result });
    })().catch(() => this.transportFailed());
    return true;
  }
}
