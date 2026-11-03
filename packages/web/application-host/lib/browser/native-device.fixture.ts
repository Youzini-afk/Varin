import { createHash } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { NativeBrowserShellPort } from './native-shell-owner.js';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
export class NativeDevice implements NativeBrowserShellPort {
  listeners = new Set<(event: string, payload: unknown) => void>();
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  pages = new Map<string, { title: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; destroyed: boolean }>();
  holdDownload = false;
  pendingScript = deferred<unknown>(); scriptStarted = false; badCapture = false; generation = 0;
  constructor(readonly directory: string) {}
  subscribe(listener: (event: string, payload: unknown) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(payload: Record<string, unknown>) { for (const listener of this.listeners) listener('browser.native', payload); }
  cdp(pageId: string, method: string, params: unknown) { this.emit({ kind: 'cdp', pageId, method, params }); }
  context(pageId: string) { this.cdp(pageId, 'Runtime.executionContextCreated', { context: { id: 1, origin: 'https://example.com', name: '', auxData: { isDefault: true, type: 'default', frameId: 'frame' } } }); }
  async request(method: string, raw: unknown): Promise<unknown> {
    const params = raw as Record<string, unknown>, pageId = String(params.pageId); this.calls.push({ method, params });
    if (method === 'browser.create') {
      const state = { title: '', url: 'about:blank', loading: false, canGoBack: false, canGoForward: false, destroyed: false }; this.pages.set(pageId, state);
      return { requestContext: params.requestContext, state, viewport: { width: 1, height: 1, scale: 1 }, version: { protocolVersion: '1.3', product: 'Chrome/150.0', revision: 'fixture', userAgent: 'fixture', jsVersion: 'fixture' } };
    }
    if (method === 'browser.command') {
      const command = String(params.method), args = params.params as Record<string, unknown> | undefined;
      if (command === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame', loaderId: 'loader', url: this.pages.get(pageId)?.url, securityOrigin: 'https://example.com', mimeType: 'text/html' } } };
      if (command === 'Runtime.enable') this.context(pageId);
      if (command === 'Page.createIsolatedWorld') return { executionContextId: 2 };
      if (command === 'Page.navigate') {
        const state = this.pages.get(pageId)!; state.url = String(args?.url); this.emit({ kind: 'changed', pageId, state: { ...state } }); const loaderId = `load-${++this.generation}`;
        this.cdp(pageId, 'Page.frameNavigated', { frame: { id: 'frame', loaderId, url: state.url, securityOrigin: 'https://example.com', mimeType: 'text/html' } }); this.context(pageId);
        for (const name of ['init', 'DOMContentLoaded', 'load']) this.cdp(pageId, 'Page.lifecycleEvent', { frameId: 'frame', loaderId, name, timestamp: 1 });
        return { frameId: 'frame', loaderId };
      }
      if (command === 'Runtime.callFunctionOn') return { result: { type: 'object', value: String(args?.functionDeclaration).includes('document.documentElement') ? '<html><body>isolated</body></html>' : { width: 1, height: 1, scale: 1, x: 0, y: 0 } } };
      if (command === 'Runtime.evaluate') {
        if (String(args?.expression).startsWith('pending-script')) { this.scriptStarted = true; return await this.pendingScript.promise; }
        return { result: { type: 'string', value: 'result' } };
      }
      return {};
    }
    if (method === 'browser.close') { const state = this.pages.get(pageId); if (state) state.destroyed = true; this.emit({ kind: 'closed', pageId }); return null; }
    if (method === 'browser.load') { this.pages.get(pageId)!.url = String(params.url); return null; }
    if (method === 'browser.capture') {
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aetkAAAAASUVORK5CYII=', 'base64'); const file = path.join(this.directory, 'capture.png'); await writeFile(file, bytes);
      return { captureId: 'capture-one', file, size: bytes.length, width: 1, height: 1, sha256: this.badCapture ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex') };
    }
    if (method === 'browser.releaseCapture') { await rm(path.join(this.directory, 'capture.png'), { force: true }); return null; }
    if (method === 'browser.download.save') { await writeFile(String(params.filePath), 'download bytes'); if(this.holdDownload)return null; this.emit({ kind: 'download-progress', downloadId: params.downloadId, receivedBytes: 14, totalBytes: 14, state: 'completed', terminal: true }); return null; }
    return null;
  }
}
