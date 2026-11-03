/**
 * Puppeteer's single-page transport over a native page debugger port.
 * Target bootstrap follows Puppeteer ExtensionTransport (Copyright 2024 Google
 * Inc., Apache-2.0). No debugging socket or second Chromium instance is opened.
 */
import type { ConnectionTransport } from 'puppeteer-core';

export interface NativePageDebugger {
  id: string;
  title(): string;
  url(): string;
  version: { protocolVersion: string; product: string; revision: string; userAgent: string; jsVersion: string };
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  subscribe(message: (method: string, params: unknown, sessionId?: string) => void, closed: () => void): () => void;
  disconnect(): void | Promise<void>;
}

export class NativePageTransport implements ConnectionTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;
  private closed = false;
  private readonly tabId: string;
  private readonly pageId: string;
  private readonly tabSession = 'varin-tab';
  private readonly pageSession = 'varin-page';
  private readonly unsubscribe: () => void;
  constructor(private readonly port: NativePageDebugger) {
    this.tabId = `tab:${port.id}`; this.pageId = `page:${port.id}`;
    this.unsubscribe = port.subscribe(this.message, this.detached);
  }
  private emit(value: object) { queueMicrotask(() => { if (!this.closed) this.onmessage?.(JSON.stringify(value)); }); }
  private message = (method: string, params: unknown, sessionId?: string) => {
    this.emit({ method, params, sessionId: sessionId || this.pageSession });
  };
  private detached = () => { this.close(); };
  private target(type: 'tab' | 'page') {
    return { targetId: type === 'tab' ? this.tabId : this.pageId, type, title: this.port.title(),
      url: this.port.url(), attached: false, canAccessOpener: false };
  }
  send(message: string) {
    const request = JSON.parse(message) as { id: number; method: string; sessionId?: string; params?: Record<string, unknown> };
    const respond = (result: unknown) => this.emit({ id: request.id, ...(request.sessionId ? { sessionId: request.sessionId } : {}), result });
    if (this.closed) return;
    if (request.method === 'Browser.getVersion') {
      respond(this.port.version); return;
    }
    if (request.method === 'Target.getBrowserContexts') { respond({ browserContextIds: [] }); return; }
    if (request.method === 'Target.setDiscoverTargets' && !request.sessionId) {
      for (const type of ['tab', 'page'] as const) this.emit({ method: 'Target.targetCreated', params: { targetInfo: this.target(type) } });
      respond({}); return;
    }
    if (request.method === 'Target.setAutoAttach' && (!request.sessionId || request.sessionId === this.tabSession)) {
      const tab = !request.sessionId;
      this.emit({ method: 'Target.attachedToTarget', ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        params: { targetInfo: this.target(tab ? 'tab' : 'page'), sessionId: tab ? this.tabSession : this.pageSession, waitingForDebugger: false } });
      respond({}); return;
    }
    // Only this page and its child sessions are exposed by this transport.
    // Browser-wide target creation/closure is owned by NativeBrowserOwner.
    if (!request.sessionId || request.sessionId === this.tabSession) {
      this.emit({ id: request.id, ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        error: { code: -32601, message: `${request.method} is unavailable on this page transport` } }); return;
    }
    void this.port.send(request.method, request.params,
      request.sessionId === this.pageSession ? undefined : request.sessionId).then(respond, error => {
      this.emit({ id: request.id, sessionId: request.sessionId, error: { code: -32000, message: String(error.message ?? error) } });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    void Promise.resolve(this.port.disconnect()).catch(() => undefined);
    this.onclose?.();
  }
}
