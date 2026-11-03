import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { DesktopNativeTransport } from './bridge.js';

/** All Tauri imports stay in the shell adapter, outside the React product. */
export function createNativeDesktopTransport(): DesktopNativeTransport {
  const currentWindow = getCurrentWebviewWindow();
  return {
    invoke,
    listen: (handler) => currentWindow.listen<unknown>('varin:emit', (event: { payload: unknown }) => handler(event.payload)),
  };
}
