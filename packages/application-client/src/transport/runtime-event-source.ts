import { buildRuntimeFetchUrl, runtimeFetch } from './runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './runtime-switch.js';
import type { RuntimeUrlQuery } from './runtime-url.js';

export interface RuntimeEventSourceOptions {
  query?: RuntimeUrlQuery;
  withCredentials?: boolean;
  /** False when the domain consumer already owns its reconnect/backoff. */
  reconnect?: boolean;
}

/** EventSource semantics over the existing HTTP response decoder. Browser
 * observations use the shared WebSocket; relay observations keep the relay.
 * Only this SSE consumer reconnects, never the underlying HTTP transport.
 */
export class RuntimeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly withCredentials: boolean;
  readyState = RuntimeEventSource.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private controller: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private retryMs = 3_000;
  private lastEventId = '';
  private generation = getRuntimeEndpointGeneration();

  constructor(readonly url: string, private options: RuntimeEventSourceOptions = {}) {
    super();
    this.withCredentials = options.withCredentials ?? false;
    // Let the caller attach listeners before even a synchronously failing
    // fetch can emit an error.
    queueMicrotask(() => { void this.connect(); });
  }

  close(): void {
    this.readyState = RuntimeEventSource.CLOSED;
    clearTimeout(this.reconnectTimer);
    this.controller?.abort();
    void this.reader?.cancel().catch(() => {});
    this.controller = null;
  }

  private emit(event: Event): void {
    this.dispatchEvent(event);
    try {
      if (event.type === 'open') this.onopen?.(event);
      else if (event.type === 'error') this.onerror?.(event);
      else if (event.type === 'message') this.onmessage?.(event as MessageEvent<string>);
    } catch (error) {
      // Browser event-handler errors are reported to the page, not converted
      // into a disconnect/replay of a healthy observation.
      if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
      else setTimeout(() => { throw error; }, 0);
    }
  }

  private async connect(): Promise<void> {
    if (this.readyState === RuntimeEventSource.CLOSED) return;
    const controller = this.controller = new AbortController();
    let retry = this.options.reconnect !== false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // Never replay a desktop/view subscription on a different Host that
      // happens to have the same domain ID. The UI owns Host-switch remounts.
      if (this.generation !== getRuntimeEndpointGeneration()) {
        retry = false;
        throw new Error('Application Host changed during event observation');
      }
      const headers = new Headers({ Accept: 'text/event-stream' });
      if (this.lastEventId) headers.set('Last-Event-ID', this.lastEventId);
      const response = await runtimeFetch(this.url, {
        ...(this.options.query ? { query: this.options.query } : {}),
        headers,
        signal: controller.signal,
        credentials: this.withCredentials ? 'include' : 'same-origin',
        cache: 'no-store',
      });
      if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
        retry = false;
        await response.body?.cancel();
        throw new Error(`Event observation was rejected (${response.status})`);
      }
      if (!response.body) throw new Error('Event observation has no response body');
      controller.signal.throwIfAborted();
      this.readyState = RuntimeEventSource.OPEN;
      this.emit(new Event('open'));
      reader = this.reader = response.body.getReader();
      const decoder = new TextDecoder();
      let line = '';
      let ignoreLf = false;
      let data = '';
      let eventType = '';
      let eventId = this.lastEventId;
      let origin = '';
      try {
        origin = new URL(response.url || buildRuntimeFetchUrl(this.url), typeof window === 'undefined' ? undefined : window.location.href).origin;
      } catch { /* Relay paths need not have a network origin. */ }
      const consumeLine = () => {
        if (!line) {
          this.lastEventId = eventId;
          if (data) {
            const event = new MessageEvent<string>(eventType || 'message', {
              data: data.slice(0, -1), lastEventId: this.lastEventId, origin,
            });
            this.emit(event);
          }
          data = '';
          eventType = '';
          return;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') data += `${value}\n`;
        else if (field === 'event') eventType = value;
        else if (field === 'id' && !value.includes('\0')) eventId = value;
        else if (field === 'retry' && /^\d+$/u.test(value)) {
          const delay = Number(value);
          if (Number.isSafeInteger(delay)) this.retryMs = delay;
        }
      };
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Event observation ended');
        for (const character of decoder.decode(chunk.value, { stream: true })) {
          if (ignoreLf && character === '\n') { ignoreLf = false; continue; }
          ignoreLf = false;
          if (character === '\r' || character === '\n') {
            consumeLine();
            line = '';
            ignoreLf = character === '\r';
            if (controller.signal.aborted) break;
          } else line += character;
        }
      }
    } catch {
      if (controller.signal.aborted || this.controller !== controller) return;
      if (this.generation !== getRuntimeEndpointGeneration()) retry = false;
      this.readyState = retry ? RuntimeEventSource.CONNECTING : RuntimeEventSource.CLOSED;
      this.emit(new Event('error'));
      // An onerror listener may close/recreate the source itself.
      if (retry && this.readyState !== RuntimeEventSource.CLOSED) {
        this.reconnectTimer = setTimeout(() => { void this.connect(); }, Math.min(this.retryMs, 2_147_483_647));
      }
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      if (this.reader === reader) this.reader = null;
      controller.abort();
      if (this.controller === controller) this.controller = null;
    }
  }
}
