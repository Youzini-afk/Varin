/** Browser identity is independent of the window currently presenting a page. */
export interface BrowserPage {
  browserId: string;
  pageId: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  retained: boolean;
  crashed?: string;
  agentPaused?: boolean;
  activeAction?: string;
  scriptPending?: boolean;
  dialog?: { type: string; message: string; defaultPrompt?: string };
}

export interface BrowserPoint { x: number; y: number }
export interface BrowserViewport { width: number; height: number; scale: number }
export interface BrowserElement {
  ref?: string;
  frameId?: string;
  role: string;
  name?: string;
  value?: string;
  description?: string;
  level?: number;
  state?: Record<string, string | number | boolean>;
}
export interface BrowserObservation {
  page: BrowserPage;
  observationId: string;
  viewport: BrowserViewport;
  frames: { frameId: string; parentId?: string; url: string; available: boolean }[];
  elements?: BrowserElement[];
  text?: string;
  offset?: number;
  nextOffset?: number;
  total?: number;
  image?: { mimeType: 'image/png'; base64: string; width: number; height: number };
}

export type BrowserReadRequest = {
  pageId: string;
  view?: 'overview' | 'text' | 'structure' | 'screenshot' | 'find';
  frameId?: string;
  ref?: string;
  query?: string;
  offset?: number;
  limit?: number;
};
export type BrowserAction =
  | { action: 'navigate'; url: string }
  | { action: 'back' | 'forward' | 'reload' | 'close' }
  | { action: 'click' | 'double_click' | 'hover'; ref: string }
  | { action: 'click' | 'double_click' | 'hover'; point: BrowserPoint; observationId: string }
  | { action: 'scroll'; deltaX?: number; deltaY: number; ref?: string; point?: BrowserPoint; observationId?: string }
  | { action: 'type'; text: string; ref?: string; replace?: boolean }
  | { action: 'press'; key: string; modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[]; ref?: string }
  | { action: 'select'; ref: string; values: string[] }
  | { action: 'check'; ref: string; checked: boolean }
  | { action: 'drag'; from: BrowserPoint; to: BrowserPoint; observationId: string }
  | { action: 'dialog'; accept: boolean; text?: string }
  | { action: 'evaluate'; script: string; frameId?: string }
  | { action: 'wait'; condition: 'loaded' | 'element' | 'url' | 'download'; ref?: string; url?: string; downloadId?: string; timeoutMs?: number };

export interface BrowserDownload {
  downloadId: string;
  pageId: string;
  name: string;
  url: string;
  receivedBytes: number;
  totalBytes?: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
}
export interface BrowserActionResult {
  page: BrowserPage;
  action: BrowserAction['action'] | 'upload';
  method?: 'native-input' | 'dom-control' | 'page-script';
  value?: unknown;
  downloads?: BrowserDownload[];
}
export type BrowserEvent =
  | { kind: 'page'; page: BrowserPage }
  | { kind: 'closed'; pageId: string }
  | { kind: 'download'; download: BrowserDownload }
  | { kind: 'dialog'; pageId: string; type: string; message: string; defaultPrompt?: string };

/** Trusted embedding port. Files are transferred by the Host's original resource owner. */
export interface BrowserOwner {
  readonly browserId: string;
  list(): Promise<BrowserPage[]>;
  open(input: { url: string; pageId?: string; retained?: boolean }, scope: { threadId?: string; signal?: AbortSignal }): Promise<BrowserPage>;
  read(input: BrowserReadRequest, signal?: AbortSignal): Promise<BrowserObservation>;
  act(pageId: string, action: BrowserAction, signal?: AbortSignal): Promise<BrowserActionResult>;
  downloads(pageId: string): Promise<BrowserDownload[]>;
  readDownload(pageId: string, downloadId: string, signal?: AbortSignal): Promise<{ name: string; bytes: Uint8Array }>;
  releaseDownload(pageId: string, downloadId: string): Promise<void>;
  upload(pageId: string, ref: string, files: { name: string; bytes: Uint8Array }[], signal?: AbortSignal): Promise<BrowserActionResult>;
  subscribe(listener: (event: BrowserEvent) => void): () => void;
  retainForThread(pageId: string, threadId: string): void;
  releaseThread(threadId: string): Promise<void>;
}
/** Receipt from the browser's original executor, including rejection before input. */
const BROWSER_EXECUTION_ERROR = Symbol.for('varin.browser.execution-error');
export class BrowserExecutionError extends Error {
  readonly [BROWSER_EXECUTION_ERROR] = true;
  constructor(cause: unknown, readonly effect: 'none' | 'unknown', readonly executorStopped = true,
    readonly completion?: Promise<void>) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'BrowserExecutionError';
  }
}
/** Electron and the embedded Host are separate bundles in the same process. */
export function isBrowserExecutionError(value: unknown): value is BrowserExecutionError {
  return value instanceof Error && (value as BrowserExecutionError)[BROWSER_EXECUTION_ERROR] === true;
}
