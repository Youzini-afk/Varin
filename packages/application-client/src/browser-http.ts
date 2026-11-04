import { BROWSER_BINARY_MAX, BROWSER_HEADER_MAX, decodeBrowserPacket, type BrowserAction, type BrowserActionResult, type BrowserCatalog, type BrowserEvent,
  type BrowserFrame, type BrowserClipboardRequest, type BrowserClipboardSelection, type BrowserInputRequest, type BrowserPage, type BrowserReadRequest, type BrowserObservation, type BrowserDownload } from '@varin/protocol';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { RuntimeEventSource } from './transport/runtime-event-source.js';

export class BrowserRequestError extends Error {
  constructor(message: string, readonly effect: 'none' | 'unknown' = 'none', readonly executorStopped = true) { super(message); this.name = 'BrowserRequestError'; }
}
/** The client is bound to the selected Host generation, never silently retargeted. */
export function createBrowserHttpClient() {
  const generation = getRuntimeEndpointGeneration();
  let hostId: string | undefined;
  const assert = () => { if (generation !== getRuntimeEndpointGeneration()) throw new BrowserRequestError('The selected Host changed; the original Browser page was not replaced'); };
  const request = async <T>(path: string, body?: unknown, init?: RequestInit): Promise<T> => {
    assert();
    const response = await runtimeFetch(`/api/browsers${path}`, { ...init, headers: { ...(hostId ? { 'X-Varin-Browser-Host': hostId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...init?.headers },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new BrowserRequestError(result.error || 'Browser request failed', result.browserExecution?.effect ?? 'none', result.browserExecution?.executorStopped ?? true);
    assert();
    const actual = response.headers.get('X-Varin-Browser-Host');
    if (!actual || hostId && actual !== hostId) throw new BrowserRequestError('Browser Host identity changed');
    hostId = actual; return result as T;
  };
  const pagePath = (pageId: string) => `/pages/${encodeURIComponent(pageId)}`;
  return {
    generation,
    catalog: () => request<BrowserCatalog>(''),
    select: (browserId: string | null) => request('/default', { browserId }),
    revoke: (browserId: string) => request(`/devices/${encodeURIComponent(browserId)}/revoke`, {}),
    open: (url: string) => request<BrowserPage>('/pages', { url }),
    action: (pageId: string, action: BrowserAction) => request<BrowserActionResult>(`${pagePath(pageId)}/action`, action),
    read: (input: BrowserReadRequest) => request<BrowserObservation>(`${pagePath(input.pageId)}/read`, input),
    control: (pageId: string, streamId: string, paused: boolean) => request<BrowserPage>(`${pagePath(pageId)}/control`, { streamId, paused }),
    clipboard: (input: BrowserClipboardRequest) => request<BrowserClipboardSelection | null>(`${pagePath(input.pageId)}/clipboard`, input),
    input: (input: BrowserInputRequest) => request(`${pagePath(input.pageId)}/input`, input),
    resize: (pageId: string, streamId: string, width: number, height: number) => request(`${pagePath(pageId)}/resize`, { streamId, width, height }),
    downloads: (pageId: string) => request<BrowserDownload[]>(`${pagePath(pageId)}/downloads`),
    async download(pageId: string, downloadId: string) {
      assert(); const response = await runtimeFetch(`/api/browsers${pagePath(pageId)}/downloads/${encodeURIComponent(downloadId)}`, { headers: hostId ? { 'X-Varin-Browser-Host': hostId } : {} });
      if (!response.ok) throw new BrowserRequestError('Browser download is unavailable'); assert(); return response.blob();
    },
    async chooseFiles(pageId: string, chooserId: string, files: File[]) {
      assert();
      const total = files.reduce((total, file) => total + file.size, 0);
      if (total > 64 * 1024 * 1024) throw new BrowserRequestError('This browser connection has a 64 MiB transfer memory budget. Select a smaller batch.');
      const header = new TextEncoder().encode(JSON.stringify({ chooserId, files: files.map(file => ({ name: file.name, byteLength: file.size })) }));
      if (header.length > BROWSER_HEADER_MAX) throw new BrowserRequestError('The browser upload manifest is too large');
      const prefix = new Uint8Array(4); new DataView(prefix.buffer).setUint32(0, header.length);
      return request(`${pagePath(pageId)}/upload`, undefined, { method: 'POST', headers: { 'Content-Type': 'application/x-varin-browser-files' }, body: new Blob([prefix, header, ...files]) });
    },
    events(pageId: string, listener: (event: BrowserEvent) => void) {
      assert(); const stream = new RuntimeEventSource(`/api/browsers${pagePath(pageId)}/events`);
      stream.onmessage = message => { if (generation === getRuntimeEndpointGeneration()) listener(JSON.parse(message.data) as BrowserEvent); };
      return () => stream.close();
    },
    async frames(pageId: string, streamId: string, listener: (frame: BrowserFrame) => void, signal: AbortSignal) {
      assert();
      const response = await runtimeFetch(`/api/browsers${pagePath(pageId)}/frames`, { query: { streamId }, signal, headers: hostId ? { 'X-Varin-Browser-Host': hostId } : {} });
      if (!response.ok || response.headers.get('Content-Type')?.split(';')[0] !== 'application/x-varin-browser-frames') throw new BrowserRequestError('The original Browser device did not open a live frame stream');
      if (!response.body) throw new BrowserRequestError('Browser frame stream has no body');
      await consumeBrowserFrames(response.body, frame => { assert(); if (frame.pageId !== pageId || frame.streamId !== streamId) throw new Error('Browser frame identity changed'); listener(frame); }, signal);
    },
  };
}
export type BrowserHttpClient = ReturnType<typeof createBrowserHttpClient>;

/** Stateful decoder accepts arbitrary HTTP chunk boundaries with one frame of storage. */
export async function consumeBrowserFrames(body: ReadableStream<Uint8Array>, listener: (frame: BrowserFrame) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  let chunks: Uint8Array[] = [], available = 0, offset = 0, headerLength = 0, packetLength = 0;
  const take = (length: number, consume = true) => {
    const result = new Uint8Array(length); let copied = 0, position = offset, index = 0;
    while (copied < length) { const chunk = chunks[index]!, count = Math.min(length - copied, chunk.byteLength - position); result.set(chunk.subarray(position, position + count), copied); copied += count; position += count;
      if (position === chunk.byteLength) { index++; position = 0; } }
    if (consume) { chunks = chunks.slice(index); offset = position; available -= length; }
    return result;
  };
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); }; signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read(); if (result.done) break;
      chunks.push(result.value); available += result.value.byteLength;
      while (true) {
        if (!headerLength) { if (available < 4) break; headerLength = new DataView(take(4, false).buffer).getUint32(0); if (!headerLength || headerLength > BROWSER_HEADER_MAX) throw new Error('Invalid browser frame header'); }
        if (!packetLength) {
          if (available < headerLength + 4) break;
          const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(take(headerLength + 4, false).subarray(4))) as { byteLength?: unknown };
          if (typeof header.byteLength !== 'number' || !Number.isSafeInteger(header.byteLength) || header.byteLength < 0 || header.byteLength > BROWSER_BINARY_MAX) throw new Error('Invalid browser frame size');
          packetLength = 4 + headerLength + header.byteLength;
        }
        if (available < packetLength) break;
        const { header, bytes } = decodeBrowserPacket(take(packetLength));
        if (header.kind !== 'frame' || header.mimeType !== 'image/jpeg') throw new Error('Invalid browser frame format');
        listener({ ...header, bytes } as unknown as BrowserFrame); headerLength = 0; packetLength = 0;
      }
      if (available > BROWSER_BINARY_MAX + BROWSER_HEADER_MAX + 4) throw new Error('Browser frame receive budget exceeded');
    }
    if (!signal?.aborted && available) throw new Error('Browser frame stream ended inside its original frame');
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
