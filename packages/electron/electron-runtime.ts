import type { BrowserWindow } from 'electron';

export interface RendererRuntimeConfig {
  apiBaseUrl: string;
  clientToken: string;
  relayHostId?: string | undefined;
  requestHeaders: Record<string, string>;
}

declare module 'electron' {
  interface BrowserWindow {
    __varinInitScript?: string | null | undefined;
    __varinLabel?: string | undefined;
    __varinMiniChat?: boolean | undefined;
    __varinMiniChatThreadKey?: string | undefined;
    __varinPinned?: boolean | undefined;
    __varinRuntimeConfig?: RendererRuntimeConfig | undefined;
    __varinTitleBarOverlayEnabled?: boolean | undefined;
  }
}

declare global {
  const __VARIN_UPDATER_E2E_BUILD__: boolean | undefined;
}

export type WindowFocusListener = (event: Electron.Event, browserWindow: BrowserWindow) => void;
