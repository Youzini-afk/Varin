/** HTTP observation bodies multiplexed over one browser/Host WebSocket.
 * This is a transport for existing routes, never a second service authority.
 */
export const OBSERVATION_WEBSOCKET_PATH = '/api/varin/observations/ws';
// Per-reader buffer, not a response-size limit. One MiB keeps a 100 Mbit/s
// link busy across an 80 ms round trip without buffering an entire response.
export const OBSERVATION_WINDOW_BYTES = 1024 * 1024;

export function encodeObservationData(id: number, bytes: Uint8Array): Uint8Array {
  const frame = new Uint8Array(8 + bytes.byteLength);
  new DataView(frame.buffer).setBigUint64(0, BigInt(id));
  frame.set(bytes, 8);
  return frame;
}
export function decodeObservationData(frame: ArrayBuffer): { id: number; bytes: Uint8Array } {
  if (frame.byteLength < 8) throw new Error('Invalid observation data');
  const id = Number(new DataView(frame).getBigUint64(0));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid observation channel');
  return { id, bytes: new Uint8Array(frame, 8) };
}

export type ObservationClientMessage =
  | { type: 'open'; id: number; path: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; binary?: boolean }
  | { type: 'pull'; id: number }
  | { type: 'credit'; id: number; bytes: number }
  | { type: 'cancel'; id: number };

export type ObservationServerMessage =
  | { type: 'headers'; id: number; status: number; statusText: string; headers: Record<string, string>; binary?: boolean }
  | { type: 'data'; id: number; data: string }
  | { type: 'end'; id: number }
  | { type: 'error'; id: number; message: string };

const GET_PATHS = new Set([
  '/api/external-agents/observe',
  '/api/threads/observe',
  '/api/interactive-ui/view/observe',
  '/api/varin/events',
  '/api/notifications/stream',
  '/api/documents/watch',
  '/api/language/events',
  '/api/tasks/events',
  '/api/tests/events',
  '/api/debug/events',
]);
const POST_PATHS = new Set([
  '/api/varin/extensions/v1/host-state/wait',
  '/api/varin/extensions/v1/services/lease',
]);

/** Accept only canonical Host-local paths, not URLs, dot segments or escapes
 * that could change routing after a proxy/router decodes the path.
 */
export const isAllowedObservationRequest = (method: string, path: string): boolean => {
  if (!path.startsWith('/api/') || /[\\#\r\n]/u.test(path)) return false;
  const pathname = path.split('?', 1)[0]!;
  if (method === 'POST') return POST_PATHS.has(pathname);
  if (method !== 'GET') return false;
  if (GET_PATHS.has(pathname)) return true;
  const desktop = /^\/api\/computers\/desktops\/([^/]+)\/stream$/u.exec(pathname)?.[1];
  if (!desktop) return false;
  try {
    const decoded = decodeURIComponent(desktop);
    return decoded !== '.' && decoded !== '..'
      && !Array.from(decoded).some(character => character === '/' || character === '\\' || character === '%'
        || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  } catch {
    return false;
  }
};
