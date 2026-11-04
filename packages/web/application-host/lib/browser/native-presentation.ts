import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CDPSession, Frame, Page, Protocol } from 'puppeteer-core';
import { BrowserExecutionError, type BrowserFrame, type BrowserClipboardRequest, type BrowserClipboardSelection, type BrowserInputRequest } from '@varin/protocol';

import { NativeBrowserClipboard } from './native-clipboard.js';

export interface PresentationPage {
  id: string; presentationStreams: Set<string>; generation: string; controlEpoch: string; viewerId?: string; agentPaused: boolean; page: Page;
  uploadDirectories: Set<string>;
  fileChooser?: { chooserId: string; multiple: boolean; backendNodeId: number };
}
type Stream = { listener(frame: BrowserFrame): void; lastSequence: number; viewport?: { width: number; height: number; scale: number } };
type Capture = { page: PresentationPage; session: CDPSession; streams: Map<string, Stream>; sequence: number; keys: Map<string, Protocol.Input.DispatchKeyEventRequest>;
  buttons: Map<string, Protocol.Input.DispatchMouseEventRequest>; clipboard: NativeBrowserClipboard; stopped: boolean; stopEvents(): void; releaseActivity(): Promise<void> };

/** This adapter observes and inputs the original Chromium page. It owns no page lifetime. */
export class NativeBrowserPresentation {
  private readonly captures = new Map<string, Promise<Capture>>();
  constructor(private readonly options: {
    browserId: string; ownerGeneration: string; scratchDirectory: string;
    require(pageId: string): PresentationPage;
    changed(page: PresentationPage): void;
    acquireActivity(page: PresentationPage): Promise<() => Promise<void>>;
    queued<T>(page: PresentationPage, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  }) {}
  private capture(pageId: string): Promise<Capture> {
    let pending = this.captures.get(pageId);
    if (!pending) {
      pending = (async () => {
        const page = this.options.require(pageId);
        const session = (page.page.mainFrame() as Frame & { client: CDPSession }).client;
        const releaseActivity = await this.options.acquireActivity(page);
        const capture: Capture = { page, session, streams: new Map(), sequence: 0, keys: new Map(), buttons: new Map(), clipboard: new NativeBrowserClipboard(), stopped: false, stopEvents: () => {}, releaseActivity };
        const frameListener = (event: Protocol.Page.ScreencastFrameEvent) => {
          // ACK the native frame after taking bounded ownership. A slow observer
          // drops obsolete frames in its transport; it never stalls the page.
          void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
          if (capture.stopped) return;
          const width = event.metadata.deviceWidth, height = event.metadata.deviceHeight;
          if (!(width > 0 && height > 0)) return;
          const bytes = Buffer.from(event.data, 'base64');
          const sequence = ++capture.sequence;
          for (const [streamId, stream] of capture.streams) {
            stream.lastSequence = sequence; stream.viewport = { width, height, scale: event.metadata.pageScaleFactor || 1 };
            stream.listener({ browserId: this.options.browserId, ownerGeneration: this.options.ownerGeneration,
              pageId, pageGeneration: page.generation, controlEpoch: page.controlEpoch, streamId, sequence,
              viewport: stream.viewport, mimeType: 'image/jpeg', bytes });
          }
        };
        const chooserListener = (event: Protocol.Page.FileChooserOpenedEvent) => {
          if (event.backendNodeId === undefined) return;
          page.fileChooser = { chooserId: randomUUID(), multiple: event.mode === 'selectMultiple', backendNodeId: event.backendNodeId };
          this.options.changed(page);
        };
        session.on('Page.screencastFrame', frameListener); session.on('Page.fileChooserOpened', chooserListener);
        capture.stopEvents = () => { session.off('Page.screencastFrame', frameListener); session.off('Page.fileChooserOpened', chooserListener); };
        try {
          await session.send('Page.enable');
          await session.send('Page.setInterceptFileChooserDialog', { enabled: true });
          return capture;
        } catch (error) { capture.stopEvents(); await releaseActivity(); throw error; }
      })();
      this.captures.set(pageId, pending);
      void pending.catch(() => { if (this.captures.get(pageId) === pending) this.captures.delete(pageId); });
    }
    return pending;
  }
  async subscribe(pageId: string, streamId: string, listener: (frame: BrowserFrame) => void): Promise<() => Promise<void>> {
    if (!streamId) throw new Error('Browser stream identity is required');
    const capture = await this.capture(pageId);
    if (capture.stopped || capture.streams.has(streamId)) throw new Error('Browser stream identity is already used or ended');
    capture.streams.set(streamId, { listener, lastSequence: 0 });
    try {
      if (capture.streams.size === 1) await capture.session.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
    } catch (error) { capture.streams.delete(streamId); await this.close(pageId); throw error; }
    capture.page.presentationStreams.add(streamId); this.options.changed(capture.page);
    let stopped = false;
    return async () => {
      if (stopped) return; stopped = true;
      capture.streams.delete(streamId);
      await capture.clipboard.release(streamId);
      if (capture.page.viewerId === streamId) await this.release(capture);
      if (!capture.streams.size) await this.close(pageId);
      capture.page.presentationStreams.delete(streamId); this.options.changed(capture.page);
    };
  }
  private async release(capture: Capture): Promise<void> {
    const { session } = capture;
    await capture.clipboard.release();
    const keys = [...capture.keys], buttons = [...capture.buttons];
    const work = keys.map(([, key]) => session.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' }));
    for (const [, button] of buttons) work.push(session.send('Input.dispatchMouseEvent', { ...button, type: 'mouseReleased', buttons: 0 }) as Promise<void>);
    work.push(session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }));
    await Promise.all(work);
    for (const [id, key] of keys) if (capture.keys.get(id) === key) capture.keys.delete(id);
    for (const [id, button] of buttons) if (capture.buttons.get(id) === button) capture.buttons.delete(id);
  }
  async clipboard(request: BrowserClipboardRequest, signal?: AbortSignal): Promise<BrowserClipboardSelection | null> {
    const page = this.options.require(request.pageId), capture = await this.captures.get(request.pageId);
    const stream = capture?.streams.get(request.streamId);
    const valid = () => Boolean(capture && !capture.stopped && capture.streams.has(request.streamId)
      && page.generation === request.pageGeneration && page.agentPaused && page.viewerId === request.streamId && page.controlEpoch === request.controlEpoch);
    if (!capture || !stream || !valid()) throw new BrowserExecutionError('Browser clipboard generation or human control lease is stale', 'none');
    if (!Number.isSafeInteger(request.frameSequence) || request.frameSequence <= 0 || request.frameSequence > stream.lastSequence) throw new BrowserExecutionError('Clipboard access requires an observed browser frame', 'none');
    return this.options.queued(page, async () => {
      signal?.throwIfAborted();
      if (!valid()) throw new BrowserExecutionError('Browser clipboard control changed before dispatch', 'none');
      return capture.clipboard.execute(request, page.page, valid);
    }, signal);
  }
  async invalidateClipboard(pageId: string): Promise<void> {
    const capture = await this.captures.get(pageId); await capture?.clipboard.release();
  }
  async input(request: BrowserInputRequest, signal?: AbortSignal): Promise<void> {
    const page = this.options.require(request.pageId);
    const pending = this.captures.get(request.pageId);
    if (!pending) throw new BrowserExecutionError('This browser view has ended', 'none');
    const capture = await pending, stream = capture.streams.get(request.streamId);
    if (!stream || page.generation !== request.pageGeneration || !page.agentPaused || page.viewerId !== request.streamId || page.controlEpoch !== request.controlEpoch) {
      throw new BrowserExecutionError('Browser input generation or human control lease is stale', 'none');
    }
    const input = request.input;
    if (input.type !== 'release' && (!Number.isSafeInteger(request.frameSequence) || request.frameSequence <= 0 || request.frameSequence > stream.lastSequence)) throw new BrowserExecutionError('Input requires an observed browser frame', 'none');
    let dispatched = false;
    try {
      await this.options.queued(page, async () => {
        signal?.throwIfAborted();
        if (capture.stopped || !capture.streams.has(request.streamId) || page.controlEpoch !== request.controlEpoch) throw new Error('The browser view changed before input dispatch');
        dispatched = true;
        const send = capture.session.send.bind(capture.session);
        if (input.type === 'release') { dispatched = true; await this.release(capture); return; }
        if (input.type === 'pointer') {
          const params: Protocol.Input.DispatchMouseEventRequest = { type: input.phase === 'down' ? 'mousePressed' : input.phase === 'up' ? 'mouseReleased' : 'mouseMoved',
            x: input.x, y: input.y, button: input.button, buttons: input.buttons, clickCount: input.clickCount, modifiers: input.modifiers };
          if (input.phase === 'down') capture.buttons.set(input.button, params);
          else if (input.phase === 'up') capture.buttons.delete(input.button);
          await send('Input.dispatchMouseEvent', params);
        } else if (input.type === 'wheel') await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: input.x, y: input.y, deltaX: input.deltaX, deltaY: input.deltaY, modifiers: input.modifiers });
        else if (input.type === 'key') {
          const params: Protocol.Input.DispatchKeyEventRequest = { type: input.phase === 'down' ? 'rawKeyDown' : 'keyUp', key: input.key, code: input.code,
            windowsVirtualKeyCode: input.windowsVirtualKeyCode, location: input.location, modifiers: input.modifiers, autoRepeat: input.autoRepeat };
          if (input.phase === 'down') capture.keys.set(input.code, params); else capture.keys.delete(input.code);
          await send('Input.dispatchKeyEvent', params);
        } else if (input.type === 'text') await send('Input.insertText', { text: input.text });
        else if (input.type === 'composition') await send('Input.imeSetComposition', { text: input.text, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd });
        else if (input.type === 'touch') await send('Input.dispatchTouchEvent', { type: input.phase === 'start' ? 'touchStart' : input.phase === 'move' ? 'touchMove' : input.phase === 'end' ? 'touchEnd' : 'touchCancel', touchPoints: input.points, modifiers: input.modifiers });
      }, signal);
    } catch (error) { throw error instanceof BrowserExecutionError ? error : new BrowserExecutionError(error, dispatched ? 'unknown' : 'none'); }
  }
  async resize(pageId: string, streamId: string, width: number, height: number): Promise<void> {
    const capture = await this.captures.get(pageId);
    if (!capture || !capture.streams.has(streamId)) throw new Error('The browser view has ended');
    if (![width, height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 16384)) throw new Error('Browser viewport exceeds Chromium texture dimensions');
    // Only the current human holder may resize; another observer must letterbox.
    if (capture.page.viewerId !== streamId || !capture.page.agentPaused) throw new Error('Take control before resizing the browser viewport');
    await capture.clipboard.release();
    capture.page.controlEpoch = randomUUID(); this.options.changed(capture.page);
    await capture.session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }
  async chooseFiles(pageId: string, chooserId: string, files: { name: string; bytes: Uint8Array }[], signal?: AbortSignal): Promise<void> {
    const page = this.options.require(pageId), chooser = page.fileChooser;
    const capture = await this.captures.get(pageId);
    if (!capture || !chooser || chooser.chooserId !== chooserId) throw new Error('The original browser file chooser has ended');
    if (!chooser.multiple && files.length > 1) throw new Error('This file input accepts only one file');
    await this.options.queued(page, async () => {
      if (page.fileChooser !== chooser) throw new Error('The original browser file chooser changed');
      signal?.throwIfAborted();
      await mkdir(this.options.scratchDirectory, { recursive: true });
      const directory = await mkdtemp(path.join(this.options.scratchDirectory, 'upload-')); page.uploadDirectories.add(directory);
      const paths: string[] = [];
      for (const [index, file] of files.entries()) {
        const folder = path.join(directory, String(index)); await mkdir(folder);
        const target = path.join(folder, path.basename(file.name) || 'attachment'); await writeFile(target, file.bytes, { signal }); paths.push(target);
      }
      signal?.throwIfAborted();
      await capture.session.send('DOM.setFileInputFiles', { files: paths, backendNodeId: chooser.backendNodeId });
      delete page.fileChooser; this.options.changed(page);
    }, signal);
  }
  async releaseInput(pageId: string): Promise<void> { const capture = await this.captures.get(pageId); if (capture) await this.release(capture); }
  async forgetClosed(pageId: string): Promise<void> { const pending = this.captures.get(pageId); this.captures.delete(pageId); const capture = await pending; capture?.stopEvents(); await capture?.clipboard.release(); }
  async close(pageId: string): Promise<void> {
    const pending = this.captures.get(pageId); if (!pending) return;
    const capture = await pending; capture.stopped = true;
    await this.release(capture);
    await capture.session.send('Page.stopScreencast');
    await capture.session.send('Page.setInterceptFileChooserDialog', { enabled: false });
    capture.stopEvents(); await capture.releaseActivity();
    if (this.captures.get(pageId) === pending) this.captures.delete(pageId);
  }
}
