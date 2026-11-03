import type { DesktopBootOutcome, DesktopRuntimeInfo } from '@varin/application-client';

declare global {
  interface Window {
    __VARIN_HOME__?: string;
    __VARIN_MACOS_MAJOR__?: number;
    __VARIN_LOCAL_ORIGIN__?: string;
    __VARIN_DESKTOP_RUNTIME__?: DesktopRuntimeInfo;
    __VARIN_ELECTRON__?: { runtime?: string; locale?: DesktopRuntimeInfo['locale']; arch?: string; macVibrancy?: boolean; macVibrancySupported?: boolean; trayEnabled?: boolean };
    __VARIN_PLATFORM__?: string;
    __VARIN_DESKTOP_BOOT_OUTCOME__?: DesktopBootOutcome;
  }

  interface WebviewElement extends HTMLElement {
    loadURL(url: string): void;
    goBack(): void;
    goForward(): void;
    reload(): void;
    getURL(): string;
    getTitle(): string;
    isLoading(): boolean;
    getWebContentsId(): number;
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<WebviewElement> & {
          src?: string;
          partition?: string;
          preload?: string;
          nodeintegration?: string;
          allowpopups?: string;
          ref?: React.Ref<WebviewElement>;
        },
        WebviewElement
      >;
    }
  }
}

export {};
