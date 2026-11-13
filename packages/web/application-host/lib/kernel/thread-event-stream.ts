import type { ServerResponse } from 'node:http';

// Per-observer memory isolation, independent of the socket's transient high-water mark.
// One stalled browser must not retain an unbounded shared runtime event history.
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
type Frame = { text: string; bytes: number; cursor: number | undefined };

/** write(false) has accepted the frame. Queue later frames until drain, without replaying it. */
export class ThreadEventStream {
  private pending: Frame[] = [];
  private next = 0;
  private pendingBytes = 0;
  private paused = false;
  private closed = false;

  constructor(private readonly response: ServerResponse, private cursor: number,
    private readonly maxBufferedBytes = MAX_BUFFERED_BYTES) {
    response.on('drain', this.drain);
    response.once('close', this.dispose);
    response.once('error', this.failed);
  }

  send = (event: unknown): boolean => {
    if (this.closed) return false;
    if (this.response.destroyed || this.response.writableEnded) { this.dispose(); return false; }
    const text = `data: ${JSON.stringify(event)}\n\n`;
    const bytes = Buffer.byteLength(text);
    if (this.pendingBytes + this.response.writableLength + bytes > this.maxBufferedBytes) {
      // Durable replay resumes from the last frame accepted by the socket. Progress is
      // explicitly invalidated, rather than silently truncating an apparently healthy stream.
      this.end({ stream: 'resync', cursor: this.cursor, reason: 'slow-consumer' });
      return false;
    }
    const cursor = event && typeof event === 'object' && 'cursor' in event && Number.isSafeInteger(event.cursor)
      ? event.cursor as number : undefined;
    const frame = { text, bytes, cursor };
    if (this.paused) { this.pending.push(frame); this.pendingBytes += bytes; }
    else this.write(frame);
    return !this.closed;
  };

  private write(frame: Frame): void {
    if (frame.cursor !== undefined) this.cursor = frame.cursor;
    try { this.paused = !this.response.write(frame.text); }
    catch { this.failed(); }
  }

  private drain = (): void => {
    if (this.closed) return;
    this.paused = false;
    while (!this.closed && !this.paused && this.next < this.pending.length) {
      const frame = this.pending[this.next++]!;
      this.pendingBytes -= frame.bytes;
      this.write(frame);
    }
    // Release accepted frames even when new arrivals keep this observer perpetually busy.
    this.pending = this.pending.slice(this.next); this.next = 0;
  };

  private dispose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.pending = []; this.next = 0; this.pendingBytes = 0;
    this.response.off('drain', this.drain);
    this.response.off('close', this.dispose);
    this.response.off('error', this.failed);
  };

  private failed = (): void => { this.dispose(); this.response.destroy(); };

  end = (finalEvent?: unknown): void => {
    if (this.closed) return;
    this.dispose();
    try { this.response.end(finalEvent === undefined ? undefined : `data: ${JSON.stringify(finalEvent)}\n\n`); }
    catch { this.response.destroy(); }
  };
}
