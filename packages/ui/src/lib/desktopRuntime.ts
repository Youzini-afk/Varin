import type { DesktopRuntimeInfo } from '@varin/application-client';

/** Presentation only. Native owners independently authorize every command. */
export const getDesktopRuntime = (): DesktopRuntimeInfo | null => {
  if (typeof window === 'undefined') return null;
  const runtime = window.__VARIN_DESKTOP_RUNTIME__;
  if (runtime?.runtime === 'electron' || runtime?.runtime === 'tauri') return runtime;
  const legacy = window.__VARIN_ELECTRON__;
  return legacy?.runtime === 'electron' ? { ...legacy, runtime: 'electron' } : null;
};
