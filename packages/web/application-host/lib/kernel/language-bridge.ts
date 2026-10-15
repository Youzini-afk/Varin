import { waitWithSignal } from '../cancellation.js';
import type { LanguageQuery } from './protocol.generated.js';
import type { LanguageToolOwner, LanguageResult } from './language-owner.js';

export interface PrivateLanguageResponse { v: 1; kind: 'language-response'; id: string; kernelEpoch: string; result: LanguageResult }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
export const unavailableLanguageResult = (message: string): LanguageResult => ({ status: 'unavailable', items: [], omissions: { outOfScope: 0, unmappable: 0, stale: 0, unavailable: 0 }, message });
const validQuery = (value: unknown): value is LanguageQuery => {
  if (!record(value) || !['runId','threadId','grantId','path'].every(key => text(value[key]))
    || !record(value.source) || !['workspace_id','execution_workspace_id'].every(key => text(record(value.source) ? value.source[key] : undefined))
    || !['live_root','materialized','fixed_branch'].includes(String(value.source.mode))
    || !(value.physicalRoot === null || record(value.physicalRoot) && ['hostId','canonicalRoot','rootId'].every(key => text(record(value.physicalRoot) ? value.physicalRoot[key] : undefined)))
) return false;
  const noPosition = value.line === undefined && value.character === undefined;
  const position = [value.line, value.character].every(item => Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) <= 4294967295);
  switch (value.method) {
    case 'definition': case 'references': case 'hover':
      return position && value.query === undefined && value.direction === undefined;
    case 'diagnostics': case 'document_symbols':
      return noPosition && value.query === undefined && value.direction === undefined;
    case 'workspace_symbols':
      return noPosition && typeof value.query === 'string' && value.direction === undefined;
    case 'call_hierarchy':
      return position && value.query === undefined && (value.direction === 'incoming' || value.direction === 'outgoing');
    default: return false;
  }
};
/** Only private kernel frames reach this adapter. Calls never enter a serial Host queue. */
export class LanguageBridge {
  private owner?: LanguageToolOwner;
  private readonly active = new Map<string, { epoch: string; controller: AbortController; query?: LanguageQuery }>();
  constructor(private readonly currentEpoch: () => string | null,
    private readonly send: (response: PrivateLanguageResponse) => Promise<void>, private readonly transportFailed: () => void) {}
  setOwner(owner: LanguageToolOwner): void {
    if (this.owner && this.owner !== owner) throw new Error('Language owner is already connected');
    this.owner = owner;
  }
  async releaseSource(match: { runId?: string; grantId?: string }): Promise<void> {
    for (const entry of this.active.values()) if (entry.query
      && (match.runId === undefined || entry.query.runId === match.runId)
      && (match.grantId === undefined || entry.query.grantId === match.grantId)) entry.controller.abort(new DOMException('Language source retired', 'AbortError'));
    await this.owner?.releaseSource?.(match);
  }
  close(): void {
    for (const entry of this.active.values()) entry.controller.abort(new DOMException('Language channel closed', 'AbortError'));
    this.active.clear();
    void this.owner?.releaseSource?.({}).catch(() => undefined); // Unknown process exits remain owned by the supervisor.
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
    const entry = { epoch, controller, ...(validQuery(value.query) ? { query: value.query } : {}) };
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
