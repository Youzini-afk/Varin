import type { Browser, Page } from 'puppeteer-core';
import type { BrowserDownload } from '@varin/protocol';

export interface NativeBrowserBounds { x: number; y: number; width: number; height: number }
export interface NativeBrowserPageState {
  title: string; url: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; destroyed: boolean;
  /** Transport loss is not evidence that the original executor has stopped. */
  disconnected?: boolean;
}
export type NativeBrowserPageEvent = { kind: 'changed' | 'input' | 'closed' } | { kind: 'crashed'; reason: string };

/** One real native page and its CDP connection. Presentation never owns page lifetime. */
export interface NativeBrowserPage {
  browser: Browser;
  page: Page;
  state(): NativeBrowserPageState;
  viewport(): { width: number; height: number; scale: number };
  subscribe(listener: (event: NativeBrowserPageEvent) => void): () => void;
  load(url: string): Promise<void>;
  stop(): void | Promise<void>;
  back(): void | Promise<void>;
  forward(): void | Promise<void>;
  reload(): void | Promise<void>;
  capture(): Promise<{ base64: string; width: number; height: number }>;
  present(viewId: string, window: unknown, bounds: NativeBrowserBounds, visible: boolean): void | Promise<void>;
  layout(viewId: string, window: unknown, bounds: NativeBrowserBounds, visible: boolean): void | Promise<void>;
  detach(viewId: string, window: unknown): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface NativeBrowserDownload {
  pageId: string;
  state(): Omit<BrowserDownload, 'downloadId' | 'pageId'>;
  saveTo(file: string): void | Promise<void>;
  cancel(): void | Promise<void>;
  /** Resolves only after the original native writer has terminated. Dispatching
   * cancel, losing its page or observing an interrupted update is not proof. */
  finished(): Promise<void>;
  /** Releases only the confirmed terminal native receipt, never the writer. */
  release(): void | Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** Shell adapters own native views and private sessions, never application execution. */
export interface NativeBrowserHost {
  create(pageId: string): Promise<NativeBrowserPage>;
  subscribeDownloads(listener: (download: NativeBrowserDownload) => void): () => void;
  dispose(): void | Promise<void>;
}
