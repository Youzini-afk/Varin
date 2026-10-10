import { subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import type { ThreadIdentity, ThreadSnapshot, ThreadsAPI } from '@varin/application-client';
import type { AgentResourceReference } from '@varin/protocol';

/** Rebuildable view only. No model history or running state is written by the UI. */
export class ThreadProjection {
  private readonly abort = new AbortController();
  private cursor = 0;
  private initialized = false;
  private refreshing = false;
  private dirty = false;
  private activeRunId: string | null = null;
  private readonly progress = new Map<string, string>();
  private stream = "";
  private sequence = 0;
  private historyHead: string | undefined;
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
        const snapshot = await this.api.snapshot(this.identity);
        if (!this.abort.signal.aborted) {
          if (!this.initialized) { this.cursor = snapshot.eventCursor; this.initialized = true; }
          this.activeRunId = snapshot.thread.branches.find(branch => branch.branch_id === this.identity.branchId)?.active_run_id ?? null;
          const head = snapshot.history.at(-1)?.id;
          if (!this.activeRunId || head !== this.historyHead) { this.progress.clear(); this.publishProgress(''); }
          this.historyHead = head;
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
  close(): void { this.removeEndpoint?.(); this.abort.abort(); }

  private async observe(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        if (!this.initialized) await this.refresh();
        if (this.abort.signal.aborted) return;
        if (this.initialized) await this.api.observe(this.cursor, event => {
          if ('cursor' in event && typeof event.cursor === 'number' && !('stream' in event)) {
            if (event.cursor <= this.cursor) return;
            this.cursor = event.cursor;
            void this.refresh();
          } else if ('stream' in event && event.stream === 'progress' && event.runId === this.activeRunId) {
            const stream = `${event.kernelEpoch}:${event.streamId}`;
            if (stream !== this.stream) { this.stream = stream; this.sequence = 0; this.progress.clear(); }
            if (event.sequence !== this.sequence + 1) {
              this.progress.clear(); this.publishProgress(''); void this.refresh();
            }
            this.sequence = event.sequence;
            const payload = event.event as { kind?: string; data?: { kind?: string; item_id?: string; text?: string } };
            if (payload && payload.kind === 'provider' && payload.data?.kind === 'text_delta' && typeof payload.data.item_id === 'string' && typeof payload.data.text === 'string') {
              this.progress.set(payload.data.item_id, (this.progress.get(payload.data.item_id) ?? '') + payload.data.text);
              this.publishProgress([...this.progress.values()].join('\n'));
            }
          }
        }, { signal: this.abort.signal });
      } catch (error) { if (!this.abort.signal.aborted) this.report(error); }
      if (this.abort.signal.aborted) return;
      // A closed transport has no reliable presentation deltas; reconstruct from history.
      this.progress.clear(); this.publishProgress(''); this.stream = ''; this.sequence = 0;
      void this.refresh();
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 1_000);
        this.abort.signal.addEventListener('abort', finish, { once: true });
      });
    }
  }
}

/** Render public text blocks; provider originals are retained by Rust and never rewritten here. */
export function historyText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(historyText).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  const value = content as Record<string, unknown>;
  if (typeof value.text === 'string') return value.text;
  if (value.kind === 'tool_call' && value.call && typeof value.call === 'object') return `Tool: ${String((value.call as { name?: unknown }).name ?? '')}`;
  if (value.kind === 'tool_result' && value.result && typeof value.result === 'object') return JSON.stringify((value.result as { completion?: unknown }).completion, null, 2);
  if (value.content !== undefined) return historyText(value.content);
  if (value.blocks !== undefined) return historyText(value.blocks);
  return '';
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

/** UI projection of accepted inline images; never fetch arbitrary provider URLs as a fallback. */
export function historyImages(content: unknown): import('@varin/protocol').ImageAttachment[] {
  if (!content || typeof content !== 'object') return [];
  const value = content as Record<string, unknown>;
  if (value.content !== undefined) return historyImages(value.content);
  const attachments = Array.isArray(value.attachments) ? value.attachments : value.kind === 'attachment' ? [value] : [];
  return attachments.flatMap(attachment => {
    if (!attachment || typeof attachment !== 'object') return [];
    const item = attachment as { media_type?: unknown; content_ref?: unknown };
    if (typeof item.media_type !== 'string' || !item.media_type.startsWith('image/') || typeof item.content_ref !== 'string') return [];
    const prefix = `data:${item.media_type};base64,`;
    return item.content_ref.startsWith(prefix) ? [{ mimeType: item.media_type, data: item.content_ref.slice(prefix.length) }] : [];
  });
}
