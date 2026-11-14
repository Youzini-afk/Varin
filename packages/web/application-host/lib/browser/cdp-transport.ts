import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';

/** A lost CDP response is not evidence that execution stopped. Never replay it. */
export class CdpDisconnectedError extends Error {
  constructor() { super('The browser connection was interrupted; inspect the original page before repeating an action.'); }
}
export interface CdpEvent { method: string; params: CdpResult; sessionId?: string }
// CDP is a negotiated, extensible domain protocol. Validate its envelope here;
// each operation checks the result fields it consumes rather than casting a
// single fixed Chromium version's generated schema over every provider.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CdpResult = Record<string, any>;

/** Owner-configured transport, never a model-supplied egress or credential path. */
export class CdpTransport {
  readonly instanceId: string;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: CdpResult): void; reject(error: Error): void }>();
  private listeners = new Set<(event: CdpEvent) => void>();
  private closeListeners = new Set<() => void>();
  private closed = false;
  private constructor(private readonly socket: WebSocket, endpoint: URL) {
    // CDP's browser token identifies the process/session, not a port or profile path.
    this.instanceId = /\/devtools\/browser\/[^/]+$/.test(endpoint.pathname)
      ? `cdp:${createHash('sha256').update(endpoint.origin + endpoint.pathname).digest('hex')}`
      : `cdp:${randomUUID()}`; // A generic gateway URL does not prove process continuity.
    socket.on('message', data => {
      let message: CdpEvent & { id?: number; result?: CdpResult; error?: { message?: string } };
      try { message = JSON.parse(data.toString()); } catch { socket.close(1002, 'Invalid CDP message'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.close(1002, 'Invalid CDP envelope'); return; }
      if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id); if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`Browser command failed: ${message.error.message ?? 'protocol error'}`));
        else pending.resolve(message.result ?? {});
      } else if (typeof message.method === 'string') {
        if (!message.params || typeof message.params !== 'object' || Array.isArray(message.params)) { socket.close(1002, 'Invalid CDP event'); return; }
        for (const listener of this.listeners) listener(message);
      }
    });
    socket.on('close', () => this.disconnected());
    socket.on('error', () => this.disconnected());
  }
  static async connect(endpoint: string, headers?: Record<string, string>): Promise<CdpTransport> {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new Error('CDP endpoint must be an HTTP(S) or WebSocket URL'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.hash) throw new Error('CDP endpoint must be an HTTP(S) or WebSocket URL without a fragment');
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const versionUrl = new URL(url); versionUrl.pathname = `${versionUrl.pathname.replace(/\/$/, '')}/json/version`;
      const response = await fetch(versionUrl, { ...(headers ? { headers } : {}), redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`The configured CDP endpoint returned HTTP ${response.status}`);
      const version = await response.json() as { webSocketDebuggerUrl?: unknown };
      if (typeof version.webSocketDebuggerUrl !== 'string') throw new Error('The endpoint did not identify a browser WebSocket');
      const websocket = new URL(version.webSocketDebuggerUrl);
      // Discovery must not redirect privileged access to a different service.
      if (websocket.hostname !== url.hostname || (websocket.port || (websocket.protocol === 'wss:' ? '443' : '80')) !== (url.port || (url.protocol === 'https:' ? '443' : '80')) ||
          websocket.protocol !== (url.protocol === 'https:' ? 'wss:' : 'ws:')) throw new Error('The CDP discovery response changed its configured endpoint origin; configure the intended WebSocket URL explicitly');
      url = websocket;
    }
    const socket = new WebSocket(url, { headers, handshakeTimeout: 15_000, followRedirects: false });
    return await new Promise<CdpTransport>((resolve, reject) => {
      const fail = () => { socket.off('open', open); reject(new Error('The configured browser WebSocket could not be connected')); };
      const open = () => { socket.off('error', fail); resolve(new CdpTransport(socket, url)); };
      socket.once('open', open); socket.once('error', fail);
    });
  }
  onEvent(listener: (event: CdpEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onClose(listener: () => void) { this.closeListeners.add(listener); return () => { this.closeListeners.delete(listener); }; }
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpResult> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new CdpDisconnectedError());
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), error => {
        if (error) { this.pending.delete(id); reject(new CdpDisconnectedError()); }
      });
    });
  }
  private disconnected() {
    if (this.closed) return; this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new CdpDisconnectedError());
    this.pending.clear(); for (const listener of this.closeListeners) listener();
    this.listeners.clear(); this.closeListeners.clear();
  }
  close() { this.disconnected(); this.socket.close(); }
}
