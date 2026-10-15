import { subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import type { AgentResourceReference } from '@varin/protocol';

interface ProgressView {
  stream: string;
  sequence: number;
  firstObserved: number;
  items: Map<string, string>;
}

/** Rebuildable view only. No model history or running state is written by the UI. */
export class ThreadProjection {
  private readonly abort = new AbortController();
  private cursor = 0;
  private initialized = false;
  private refreshing = false;
  private dirty = false;
  private activeRunId: string | null = null;
  private readonly progress = new Map<string, ProgressView>();
  private progressObservation = 0;
  private assistantHead: string | undefined;
  private removeEndpoint: (() => void) | undefined;
  constructor(private readonly api: ThreadsAPI, private readonly identity: ThreadIdentity,
    private readonly publish: (snapshot: ThreadSnapshot) => void,
    private readonly report: (error: unknown) => void,
    private readonly publishProgress: (text: string) => void = () => {}) {}

  async refresh(): Promise<void> {
    this.dirty = true;
    if (this.refreshing || this.abort.signal.aborted) return;
    this.refreshing = true;
    try {
      while (this.dirty && !this.abort.signal.aborted) {
        this.dirty = false;
        const observedBeforeSnapshot = this.progressObservation;
        const snapshot = await this.api.snapshot(this.identity);
        if (!this.abort.signal.aborted) {
          if (!this.initialized) { this.cursor = snapshot.eventCursor; this.initialized = true; }
          const activeRunId = snapshot.thread.branches.find(branch => branch.branch_id === this.identity.branchId)?.active_run_id ?? null;
          let assistantHead: string | undefined;
          for (let index = snapshot.history.length - 1; index >= 0; index -= 1) {
            if (snapshot.history[index]!.source === 'assistant') { assistantHead = snapshot.history[index]!.id; break; }
          }
          // A delayed user/tool history read does not supersede provider text. Only an
          // assistant commit replaces it; Run ownership is always confirmed by Catalog.
          if (activeRunId === this.activeRunId && assistantHead !== this.assistantHead && activeRunId) {
            this.progress.get(activeRunId)?.items.clear();
          }
          this.activeRunId = activeRunId;
          this.assistantHead = assistantHead;
          for (const [runId, progress] of this.progress) {
            // Progress can beat both durable replay and this snapshot's reads. A snapshot
            // started before the first delta cannot rule out its newly accepted Run.
            if (runId !== activeRunId && progress.firstObserved <= observedBeforeSnapshot) this.progress.delete(runId);
          }
          this.publishCurrentProgress();
          this.publish(snapshot);
        }
      }
    } catch (error) { if (!this.abort.signal.aborted) this.report(error); }
    finally { this.refreshing = false; }
  }

  start(): void {
    // Snapshot carries a cursor captured before its reads. Replay covers commits made during
    // those reads, without replaying every older thread merely to display this branch.
    this.removeEndpoint = subscribeRuntimeEndpointWillChange(() => this.close());
    void this.observe();
  }
  close(): void { this.removeEndpoint?.(); this.abort.abort(); this.progress.clear(); }

  private publishCurrentProgress(): void {
    const current = this.activeRunId ? this.progress.get(this.activeRunId) : undefined;
    this.publishProgress(current ? [...current.items.values()].join('\n') : '');
  }

  private async observe(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        if (!this.initialized) await this.refresh();
        if (this.abort.signal.aborted) return;
        if (this.initialized) await this.api.observe(this.cursor, event => {
          if (this.abort.signal.aborted) return;
          if ('cursor' in event && typeof event.cursor === 'number' && !('stream' in event)) {
            if (event.cursor <= this.cursor) return;
            this.cursor = event.cursor;
            void this.refresh();
          } else if ('stream' in event && event.stream === 'progress') {
            const observed = ++this.progressObservation;
            const stream = `${event.kernelEpoch}:${event.streamId}`;
            let progress = this.progress.get(event.runId);
            if (!progress || progress.stream !== stream) {
              progress = { stream, sequence: 0, firstObserved: observed, items: new Map() };
              this.progress.set(event.runId, progress);
            }
            if (event.sequence !== progress.sequence + 1) {
              progress.items.clear();
              if (event.runId === this.activeRunId) this.publishCurrentProgress();
              void this.refresh();
            }
            progress.sequence = event.sequence;
            const payload = event.event as { kind?: string; data?: { kind?: string; item_id?: string; text?: string } };
            if (payload && payload.kind === 'provider' && payload.data?.kind === 'text_delta' && typeof payload.data.item_id === 'string' && typeof payload.data.text === 'string') {
              progress.items.set(payload.data.item_id, (progress.items.get(payload.data.item_id) ?? '') + payload.data.text);
            }
            if (event.runId === this.activeRunId) this.publishCurrentProgress();
            else void this.refresh();
          }
        }, { signal: this.abort.signal });
      } catch (error) { if (!this.abort.signal.aborted) this.report(error); }
      if (this.abort.signal.aborted) return;
      // A closed transport has no reliable presentation deltas; reconstruct from history.
      this.progress.clear(); this.publishProgress('');
      void this.refresh();
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 1_000);
        this.abort.signal.addEventListener('abort', finish, { once: true });
      });
    }
  }
}

export interface SkillMaterialMetadata {
  ordinal: number;
  resourceId: string;
  name: string;
  reference: AgentResourceReference;
}

/** Separate resource metadata from the unchanged user text. Never project a skill body. */
export function historySkillMaterials(content: unknown): SkillMaterialMetadata[] {
  if (!content || typeof content !== 'object') return [];
  const entries = (content as Record<string, unknown>).skillInvocations;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const value = entry as Record<string, unknown>;
    if (typeof value.ordinal !== 'number' || !Number.isSafeInteger(value.ordinal) || value.ordinal < 0
      || typeof value.resourceId !== 'string' || typeof value.name !== 'string'
      || !value.reference || typeof value.reference !== 'object') return [];
    const reference = value.reference as Record<string, unknown>;
    if (typeof reference.domainId !== 'string' || typeof reference.viewId !== 'string'
      || typeof reference.path !== 'string' || typeof reference.canonicalId !== 'string'
      || typeof reference.version !== 'string') return [];
    return [{ ordinal: value.ordinal, resourceId: value.resourceId, name: value.name,
      reference: { domainId: reference.domainId, viewId: reference.viewId, path: reference.path,
        canonicalId: reference.canonicalId, version: reference.version } }];
  });
}
