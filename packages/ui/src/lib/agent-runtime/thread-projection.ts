import { subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import type { AgentResourceReference } from '@varin/protocol';
import { PartialJson } from '@/lib/interactive-ui/partial-json';
import { useThreadContextUsageStore } from '@/stores/useThreadContextUsageStore';

interface ProgressView {
  stream: string;
  requestId: string;
  sequence: number;
  firstObserved: number;
  items: Map<string, StreamingTextPart>;
  calls: Map<string, StreamingToolCall>;
  readers: Map<string, PartialJson>;
}
export interface StreamingToolCall { id: string; name: string; rawArguments: string; sequence: number; reference?: string; interrupted?: boolean }
export type StreamingTextPart = { type: 'text'; text: string } | { type: 'thinking'; thinking: string };
interface ProviderProgress { kind?: string; data?: { kind?: string; item_id?: string; text?: string; call_id?: string; name?: string; request_id?: string; delta?: string } }

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
  private interruptedTools: StreamingToolCall[] = [];
  private readonly committedRequests = new Set<string>();
  private removeEndpoint: (() => void) | undefined;
  private contextSnapshot?: ThreadSnapshot;
  private contextRefreshing = false;
  constructor(private readonly api: ThreadsAPI, private readonly identity: ThreadIdentity,
    private readonly publish: (snapshot: ThreadSnapshot) => void,
    private readonly report: (error: unknown) => void,
    private readonly publishProgress: (parts: StreamingTextPart[]) => void = () => {},
    private readonly publishTools: (calls: StreamingToolCall[]) => void = () => {}) {}

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
          if (!this.initialized) { this.cursor = Math.max(this.cursor, snapshot.eventCursor); this.initialized = true; }
          let activeRunId = snapshot.thread.branches.find(branch => branch.branch_id === this.identity.branchId)?.active_run_id ?? null;
          // Scoped progress can arrive while an older snapshot is still being read.
          const incoming = this.activeRunId ? this.progress.get(this.activeRunId) : undefined;
          if (!activeRunId && incoming && incoming.firstObserved > observedBeforeSnapshot) activeRunId = this.activeRunId;
          if (activeRunId && activeRunId !== this.activeRunId) this.interruptedTools = [];
          this.activeRunId = activeRunId;
          const knownCalls = new Set(snapshot.history.flatMap(item => {
            const envelope = item.content as { id?: string; content?: { call?: { call_id?: string } } };
            const call = envelope?.content?.call;
            const prefix = /^model-item:(\d+):/.exec(envelope?.id ?? '');
            const requestId = item.modelRequest?.requestId ?? (prefix ? envelope.id!.slice(prefix[0].length, prefix[0].length + Number(prefix[1])) : undefined);
            if (item.source === 'assistant' && requestId) this.committedRequests.add(requestId);
            return call?.call_id && requestId ? [JSON.stringify([item.run_id, requestId, call.call_id])] : [];
          }));
          this.interruptedTools = this.interruptedTools.filter(call => !knownCalls.has(call.id));
          for (const [runId, progress] of this.progress) {
            if (this.committedRequests.has(progress.requestId)) progress.items.clear();
            for (const [id, call] of progress.calls) if (knownCalls.has(call.id)) { progress.calls.delete(id); progress.readers.delete(id); }
            // Progress can beat both durable replay and this snapshot's reads. A snapshot
            // started before the first delta cannot rule out its newly accepted Run.
            if (runId !== activeRunId && progress.firstObserved <= observedBeforeSnapshot) {
              if (!activeRunId) this.interruptedTools = [...progress.calls.values()].filter(call => call.name === 'render_ui').map(call => ({ ...call, interrupted: true }));
              this.progress.delete(runId);
            }
          }
          this.publishCurrentProgress();
          this.publish(snapshot);
          this.contextSnapshot = snapshot;
          void this.refreshContext();
        }
      }
    } catch (error) { if (!this.abort.signal.aborted) this.report(error); }
    finally { this.refreshing = false; }
  }

  /** Context inspection can scan metadata beyond the visible page; streaming never awaits it. */
  private async refreshContext(): Promise<void> {
    if (this.contextRefreshing) return;
    this.contextRefreshing = true;
    try {
      while (this.contextSnapshot && !this.abort.signal.aborted) {
        const snapshot = this.contextSnapshot;
        this.contextSnapshot = undefined;
        try {
          const inspection = await this.api.contextInspection(this.identity, { headId: snapshot.historyPage.head }, this.abort.signal);
          if (inspection.head !== snapshot.historyPage.head) throw new Error('Context inspection did not match the selected history');
          if (!this.abort.signal.aborted) useThreadContextUsageStore.getState().observe(snapshot, inspection);
        } catch (error) {
          if (!this.abort.signal.aborted && !this.contextSnapshot) useThreadContextUsageStore.getState().observe(snapshot, undefined,
            error instanceof Error ? error.message : String(error));
        }
      }
    } finally { this.contextRefreshing = false; }
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
    this.publishProgress(current ? [...current.items.values()] : []);
    this.publishTools(current ? [...current.calls.values()] : this.interruptedTools);
  }

  private async observe(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        if (!this.initialized) void this.refresh();
        if (this.abort.signal.aborted) return;
        await this.api.observe(this.initialized ? this.cursor : null, event => {
          if (this.abort.signal.aborted) return;
          if ('cursor' in event && typeof event.cursor === 'number' && !('stream' in event)) {
            if (event.cursor <= this.cursor) return;
            this.cursor = event.cursor;
            void this.refresh();
          } else if ('stream' in event && event.stream === 'progress') {
            if (event.threadId !== this.identity.threadId || event.branchId !== this.identity.branchId
              || this.committedRequests.has(event.requestId)) return;
            const observed = ++this.progressObservation;
            const stream = `${event.kernelEpoch}:${event.streamId}`;
            let progress = this.progress.get(event.runId);
            if (!progress || progress.stream !== stream || progress.requestId !== event.requestId) {
              progress = { stream, requestId: event.requestId, sequence: progress?.stream === stream ? progress.sequence : 0,
                firstObserved: observed, items: new Map(), calls: new Map(), readers: new Map() };
              this.progress.set(event.runId, progress);
            }
            if (event.sequence !== progress.sequence + 1) {
              progress.items.clear();
              progress.calls.clear();
              progress.readers.clear();
              if (event.runId === this.activeRunId) this.publishCurrentProgress();
              void this.refresh();
            }
            progress.sequence = event.sequence;
            const batch = event.event as { kind: 'batch'; events: ProviderProgress[] };
            if (batch.kind !== 'batch' || !Array.isArray(batch.events)) return;
            for (const payload of batch.events) {
              const data = payload?.data;
              if (payload?.kind === 'provider' && typeof data?.call_id === 'string') {
                const old = progress.calls.get(data.call_id);
                if (data.kind === 'tool_call_started' || data.kind === 'tool_arguments_delta') progress.calls.set(data.call_id, {
                  id: data.request_id ? JSON.stringify([event.runId, data.request_id, data.call_id]) : old?.id ?? data.call_id,
                  name: data.name ?? old?.name ?? '', rawArguments: (old?.rawArguments ?? '') + (data.delta ?? ''), sequence: event.sequence,
                });
                const call = progress.calls.get(data.call_id);
                if (call?.name === 'render_ui') {
                  let reader = progress.readers.get(data.call_id);
                  const fresh = !reader;
                  if (!reader) { reader = new PartialJson(); progress.readers.set(data.call_id, reader); }
                  const args = reader.feed(fresh ? call.rawArguments : data.delta ?? '') as { ref?: string } | undefined;
                  if (reader.completeFields.has('ref') && typeof args?.ref === 'string') call.reference = args.ref;
                }
              }
              if (payload.kind === 'provider' && (data?.kind === 'text_delta' || data?.kind === 'reasoning_delta')
                && typeof data.item_id === 'string' && typeof data.text === 'string') {
                const old = progress.items.get(data.item_id);
                progress.items.set(data.item_id, data.kind === 'reasoning_delta'
                  ? { type: 'thinking', thinking: (old?.type === 'thinking' ? old.thinking : '') + data.text }
                  : { type: 'text', text: (old?.type === 'text' ? old.text : '') + data.text });
              }
            }
            if (event.runId !== this.activeRunId) { this.activeRunId = event.runId; void this.refresh(); }
            this.publishCurrentProgress();
          }
        }, { signal: this.abort.signal });
      } catch (error) { if (!this.abort.signal.aborted) this.report(error); }
      if (this.abort.signal.aborted) return;
      // A closed transport has no reliable presentation deltas; reconstruct from history.
      this.progress.clear(); this.publishProgress([]); this.publishTools([]);
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
