/**
 * Puppeteer's single-page transport, adapted for Electron's debugger port.
 * Target bootstrap follows Puppeteer ExtensionTransport (Copyright 2024 Google
 * Inc., Apache-2.0). No debugging socket or second Chromium instance is opened.
 */
import type { WebContents } from 'electron';
import type { ConnectionTransport } from 'puppeteer-core';

export class ElectronPageTransport implements ConnectionTransport {
  onmessage?: (message: string) => void;
  onclose?: () => void;
  private closed = false;
  private readonly tabId: string;
  private readonly pageId: string;
  private readonly tabSession = 'varin-tab';
  private readonly pageSession = 'varin-page';
  constructor(private readonly contents: WebContents) {
    this.tabId = `tab:${contents.id}`; this.pageId = `page:${contents.id}`;
    contents.debugger.attach('1.3');
    contents.debugger.on('message', this.message);
    contents.debugger.on('detach', this.detached);
  }
  private emit(value: object) { queueMicrotask(() => { if (!this.closed) this.onmessage?.(JSON.stringify(value)); }); }
  private message = (_event: Electron.Event, method: string, params: unknown, sessionId?: string) => {
    this.emit({ method, params, sessionId: sessionId || this.pageSession });
  };
  private detached = () => { this.close(); };
  private target(type: 'tab' | 'page') {
    return { targetId: type === 'tab' ? this.tabId : this.pageId, type, title: this.contents.getTitle(),
      url: this.contents.getURL(), attached: false, canAccessOpener: false };
  }
  send(message: string) {
    const request = JSON.parse(message) as { id: number; method: string; sessionId?: string; params?: Record<string, unknown> };
    const respond = (result: unknown) => this.emit({ id: request.id, ...(request.sessionId ? { sessionId: request.sessionId } : {}), result });
    if (this.closed) return;
    if (request.method === 'Browser.getVersion') {
      respond({ protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, revision: process.versions.electron,
        userAgent: this.contents.getUserAgent(), jsVersion: process.versions.v8 }); return;
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
    // Browser-wide target creation/closure is owned by ElectronBrowserOwner.
    if (!request.sessionId || request.sessionId === this.tabSession) {
      this.emit({ id: request.id, ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        error: { code: -32601, message: `${request.method} is unavailable on this page transport` } }); return;
    }
    void this.contents.debugger.sendCommand(request.method, request.params,
      request.sessionId === this.pageSession ? undefined : request.sessionId).then(respond, error => {
      this.emit({ id: request.id, sessionId: request.sessionId, error: { code: -32000, message: String(error.message ?? error) } });
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.contents.debugger.removeListener('message', this.message);
    this.contents.debugger.removeListener('detach', this.detached);
    if (!this.contents.isDestroyed() && this.contents.debugger.isAttached()) this.contents.debugger.detach();
    this.onclose?.();
  }
}
