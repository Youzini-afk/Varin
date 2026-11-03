/** Electron debugger binding for the shared single-page Puppeteer transport. */
import type { WebContents } from 'electron';
import { NativePageTransport } from '@varin/web/server/lib/browser/native-page-transport.js';

export class ElectronPageTransport extends NativePageTransport {
  constructor(contents: WebContents) {
    contents.debugger.attach('1.3');
    super({
      id: String(contents.id), title: () => contents.getTitle(), url: () => contents.getURL(),
      version: { protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`,
        revision: process.versions.electron, userAgent: contents.getUserAgent(), jsVersion: process.versions.v8 },
      send: (method, params, sessionId) => contents.debugger.sendCommand(method, params, sessionId),
      subscribe(message, closed) {
        const receive = (_event: Electron.Event, method: string, params: unknown, sessionId?: string) => message(method, params, sessionId);
        contents.debugger.on('message', receive); contents.debugger.on('detach', closed);
        return () => { contents.debugger.removeListener('message', receive); contents.debugger.removeListener('detach', closed); };
      },
      disconnect() { if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach(); },
    });
  }
}
