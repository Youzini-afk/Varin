import { subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import type { NativeThreadIdentity, NativeThreadSnapshot, NativeThreadsAPI } from '@varin/application-client';

/** Rebuildable view only. No model history or running state is written by the UI. */
export class NativeThreadProjection {
  private readonly abort = new AbortController();
  private cursor = 0;
  private refreshing = false;
  private dirty = false;
  private activeRunId: string | null = null;
  private readonly progress = new Map<string, string>();
  private stream = "";
  private sequence = 0;
  private historyHead: string | undefined;
  private removeEndpoint: (() => void) | undefined;
  constructor(private readonly api: NativeThreadsAPI, private readonly identity: NativeThreadIdentity,
    private readonly publish: (snapshot: NativeThreadSnapshot) => void,
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
    // Subscribe before the first snapshot, then replay since the last committed cursor.
    this.removeEndpoint = subscribeRuntimeEndpointWillChange(() => this.close());
    void this.observe();
    void this.refresh();
  }
  close(): void { this.removeEndpoint?.(); this.abort.abort(); }

  private async observe(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.api.observe(this.cursor, event => {
          if ('cursor' in event && typeof event.cursor === 'number' && !('stream' in event)) {
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
export function nativeHistoryText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(nativeHistoryText).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  const value = content as Record<string, unknown>;
  if (typeof value.text === 'string') return value.text;
  if (value.kind === 'tool_call' && value.call && typeof value.call === 'object') return `Tool: ${String((value.call as { name?: unknown }).name ?? '')}`;
  if (value.kind === 'tool_result' && value.result && typeof value.result === 'object') return JSON.stringify((value.result as { completion?: unknown }).completion, null, 2);
  if (value.content !== undefined) return nativeHistoryText(value.content);
  if (value.blocks !== undefined) return nativeHistoryText(value.blocks);
  return '';
}

/** UI projection of accepted inline images; never fetch arbitrary provider URLs as a fallback. */
export function nativeHistoryImages(content: unknown): import('@varin/protocol').ImageAttachment[] {
  if (!content || typeof content !== 'object') return [];
  const value = content as Record<string, unknown>;
  if (value.content !== undefined) return nativeHistoryImages(value.content);
  const attachments = Array.isArray(value.attachments) ? value.attachments : value.kind === 'attachment' ? [value] : [];
  return attachments.flatMap(attachment => {
    if (!attachment || typeof attachment !== 'object') return [];
    const item = attachment as { media_type?: unknown; content_ref?: unknown };
    if (typeof item.media_type !== 'string' || !item.media_type.startsWith('image/') || typeof item.content_ref !== 'string') return [];
    const prefix = `data:${item.media_type};base64,`;
    return item.content_ref.startsWith(prefix) ? [{ mimeType: item.media_type, data: item.content_ref.slice(prefix.length) }] : [];
  });
}
