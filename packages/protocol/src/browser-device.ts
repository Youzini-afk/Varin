import type { BrowserOwner, BrowserPage, BrowserViewport } from './browser.js';

/** The device is stable; owner and page generations are process-owned and never adopted after restart. */
export interface BrowserDeviceIdentity {
  deviceId: string;
  browserId: string;
  ownerGeneration: string;
  label: string;
}
export interface BrowserDevice extends BrowserDeviceIdentity {
  hostId: string;
  grantId: string | null;
  state: 'connected' | 'disconnected' | 'revoking';
  local: boolean;
  error?: string;
}
export interface BrowserCatalog { hostId: string; devices: BrowserDevice[]; defaultBrowserId: string | null; pages: BrowserPage[] }
export interface BrowserDeviceStatus extends BrowserDeviceIdentity {
  connections: { hostId: string; grantId: string; state: 'connected' | 'disconnected' | 'revoking'; error?: string }[];
}
export type BrowserDeviceCommand = { action: 'status' }
  | { action: 'connect'; expectedHostId: string; shareInteractiveProfile: true }
  | { action: 'disconnect'; expectedHostId: string };

export interface BrowserFrameInfo {
  browserId: string; pageId: string; pageGeneration: string; ownerGeneration: string;
  streamId: string; sequence: number; controlEpoch: string; viewport: BrowserViewport;
  mimeType: 'image/jpeg';
}
/** Produced by Chromium's compositing/screencast lifecycle, never a screenshot timer. */
export interface BrowserFrame extends BrowserFrameInfo { bytes: Uint8Array }
export type BrowserUserInput =
  | { type: 'pointer'; phase: 'move' | 'down' | 'up'; x: number; y: number; button: 'none' | 'left' | 'middle' | 'right'; buttons: number; clickCount: number; modifiers: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | { type: 'key'; phase: 'down' | 'up'; key: string; code: string; windowsVirtualKeyCode: number; location: number; modifiers: number; autoRepeat: boolean }
  | { type: 'text'; text: string }
  | { type: 'composition'; text: string; selectionStart: number; selectionEnd: number }
  | { type: 'touch'; phase: 'start' | 'move' | 'end' | 'cancel'; points: { id: number; x: number; y: number; radiusX: number; radiusY: number; force: number }[]; modifiers: number }
  | { type: 'release' };
export interface BrowserInputRequest {
  pageId: string; pageGeneration: string; streamId: string; controlEpoch: string; frameSequence: number;
  input: BrowserUserInput;
}
export interface BrowserPresentationOwner extends BrowserOwner {
  readonly ownerGeneration: string;
  takeControl(pageId: string, paused: boolean, viewerId?: string): BrowserPage | Promise<BrowserPage>;
  subscribeFrames(pageId: string, streamId: string, listener: (frame: BrowserFrame) => void): Promise<() => Promise<void>>;
  input(request: BrowserInputRequest, signal?: AbortSignal): Promise<void>;
  resize(pageId: string, streamId: string, width: number, height: number): Promise<void>;
  chooseFiles(pageId: string, chooserId: string, files: { name: string; bytes: Uint8Array }[], signal?: AbortSignal): Promise<void>;
}

/** Binary framing shared by Host, device and UI. Fixed prefix avoids JSON/base64 images. */
export const BROWSER_BINARY_MAX = 16 * 1024 * 1024;
export const BROWSER_HEADER_MAX = 16 * 1024;
export function encodeBrowserPacket(header: Record<string, unknown>, bytes: Uint8Array): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify({ ...header, byteLength: bytes.byteLength }));
  if (encoded.byteLength > BROWSER_HEADER_MAX || bytes.byteLength > BROWSER_BINARY_MAX) throw new Error('Browser packet exceeds the negotiated transport buffer');
  const packet = new Uint8Array(4 + encoded.byteLength + bytes.byteLength);
  new DataView(packet.buffer).setUint32(0, encoded.byteLength);
  packet.set(encoded, 4); packet.set(bytes, 4 + encoded.byteLength); return packet;
}
export function decodeBrowserPacket(packet: Uint8Array): { header: Record<string, unknown>; bytes: Uint8Array } {
  if (packet.byteLength < 4 || packet.byteLength > BROWSER_BINARY_MAX + BROWSER_HEADER_MAX + 4) throw new Error('Invalid browser binary packet size');
  const length = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0);
  if (!length || length > BROWSER_HEADER_MAX || 4 + length > packet.byteLength) throw new Error('Invalid browser binary header size');
  const header: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packet.subarray(4, 4 + length)));
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('Invalid browser binary header');
  if ((header as Record<string, unknown>).byteLength !== packet.byteLength - 4 - length) throw new Error('Browser payload length changed');
  return { header: header as Record<string, unknown>, bytes: packet.subarray(4 + length) };
}
