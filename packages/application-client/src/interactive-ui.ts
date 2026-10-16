import type { JsonValue } from '@varin/protocol';
import type { ThreadIdentity } from './threads.js';
import { runtimeFetch } from './transport/runtime-fetch.js';
import { getRuntimeEndpointGeneration } from './transport/runtime-switch.js';
import { RuntimeEventSource } from './transport/runtime-event-source.js';

export type UiChange =
  | { file: string; op: 'write' | 'append'; text: string }
  | { file: string; op: 'edit'; edits: { oldText: string; newText: string }[] }
  | { file: string; op: 'delete' };
export interface RenderUiInput { ref?: string; title?: string; entry?: string; changes: UiChange[] }
export interface UiReceipt { kind: 'ui'; ref: string; workRef: string; title: string; revision: number; entry: string; files: string[] }
export interface UiSource extends UiReceipt { contents: Record<string, string>; assets: Record<string, { mimeType: string; data: string }> }
export type UiReadView = 'summary' | 'source' | 'state' | 'screen' | 'structure';
export interface UiReadInput { kind: 'ui'; ref: string; view?: UiReadView; file?: string; startLine?: number; endLine?: number; offset?: number; limit?: number }
export interface UiSourceIdentity {
  ref?: string;
  preview?: { callId: string; sequence: number; baseRef?: string; contents: Record<string, string>; entry: string; title: string };
}
export interface UiViewState { data: JsonValue; scroll: { x: number; y: number }; controls: Record<string, JsonValue> }
export interface UiStructureNode { tag: string; text?: string; value?: string; selector?: string; bounds: { x: number; y: number; width: number; height: number } }
export interface UiObservation extends UiSourceIdentity {
  viewRef: string; capturedAt: string; state: UiViewState;
  context?: JsonValue;
  render?: { state: 'preview' | 'loading' | 'ready' | 'error'; message?: string };
  stateCapturedAt?: string;
  textRange?: { start: { selector: string; childIndex?: number; offset: number }; end: { selector: string; childIndex?: number; offset: number } };
  viewport: { width: number; height: number }; structure?: UiStructureNode[];
  image?: { mimeType: 'image/png'; data: string; method: 'screen' | 'dom'; capturedAt?: string; bounds?: { x: number; y: number; width: number; height: number } };
}
export interface UiSelection {
  ref: string; snapshotRef: string; title: string; source: UiSourceIdentity; viewRef: string;
  text?: string; region?: { x: number; y: number; width: number; height: number };
  image?: { mimeType: string; data: string }; structure?: UiStructureNode[];
}
export interface UiViewRegistration { viewRef: string; token: string; state: UiViewState | null }
export interface UiCaptureRequest { id: string; view: UiReadView }
export class InteractiveUiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
let viewClientIdentity: string | undefined;
/** Every instance remains bound to the Host on which its references were acquired. */
export function createInteractiveUiHttpAPI(generation = getRuntimeEndpointGeneration()) {
  const clientId = viewClientIdentity ??= crypto.randomUUID();
  const post = async <T>(action: string, identity: ThreadIdentity, input: object, signal?: AbortSignal): Promise<T> => {
    const check = () => { signal?.throwIfAborted(); if (generation !== getRuntimeEndpointGeneration()) throw new InteractiveUiError(409, 'Host changed; reopen this content.'); };
    check();
    const response = await runtimeFetch(`/api/interactive-ui/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...identity, ...input }), ...(signal ? { signal } : {}) });
    const result = await response.json(); check();
    if (!response.ok) throw new InteractiveUiError(response.status, result.message ?? 'Content request failed');
    return result as T;
  };
  return {
    source: (identity: ThreadIdentity, ref: string, signal?: AbortSignal) => post<UiSource>('source', identity, { ref }, signal),
    attach: (identity: ThreadIdentity, source: UiSourceIdentity, viewRef?: string, signal?: AbortSignal) => post<UiViewRegistration>('view/attach', identity, { source, viewRef, clientId }, signal),
    detach: (identity: ThreadIdentity, viewRef: string, token: string, state?: UiViewState) => post<{ closed: true }>('view/detach', identity, { viewRef, token, state }),
    state: (identity: ThreadIdentity, viewRef: string, token: string, state: UiViewState) => post<{ saved: true }>('view/state', identity, { viewRef, token, state }),
    observe: (identity: ThreadIdentity, viewRef: string, token: string, listener: (request: UiCaptureRequest) => void, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      if (generation !== getRuntimeEndpointGeneration()) { reject(new InteractiveUiError(409, 'Host changed')); return; }
      const stream = new RuntimeEventSource('/api/interactive-ui/view/observe', { query: { ...identity, viewRef, token }, reconnect: false });
      const close = () => { stream.close(); signal.removeEventListener('abort', close); resolve(); };
      signal.addEventListener('abort', close, { once: true });
      stream.onmessage = event => listener(JSON.parse(event.data) as UiCaptureRequest);
      stream.onerror = () => { stream.close(); signal.removeEventListener('abort', close); reject(new InteractiveUiError(503, 'View observation disconnected')); };
    }),
    reply: (identity: ThreadIdentity, viewRef: string, token: string, id: string, observation?: UiObservation, error?: string) => post<{ received: true }>('view/reply', identity, { viewRef, token, id, observation, error }),
    select: (identity: ThreadIdentity, observation: UiObservation, selection: { text?: string; region?: UiSelection['region'] }) => post<UiSelection>('select', identity, { observation, selection }),
    selection: (identity: ThreadIdentity, ref: string) => post<UiSelection>('selection', identity, { ref }),
  };
}
export type InteractiveUiAPI = ReturnType<typeof createInteractiveUiHttpAPI>;
