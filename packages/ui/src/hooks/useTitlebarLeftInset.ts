import { useEffect, useState } from 'react';
import { getDesktopPlatform, invokeDesktop, isDesktopShell, usesFramelessDesktopChrome } from '@/lib/desktop';
import { useTabletStandalonePwaRuntime } from '@/lib/device';

/** Each workbench owns its titlebar, including when it is the first shell mounted.
 * Reserve native controls directly rather than inheriting another shell's CSS side effect. */
export function useTitlebarLeftInset(contentInset = '0.75rem'): string {
  const desktop = isDesktopShell();
  const nativeMacControls = desktop && getDesktopPlatform() === 'darwin';
  const tabletStandalone = useTabletStandalonePwaRuntime();
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!nativeMacControls) return;
    let disposed = false;
    const sync = async () => {
      try {
        const value = await invokeDesktop('desktop_is_window_fullscreen');
        if (!disposed) setFullscreen(value === true);
      } catch {
        // Until the shell can report fullscreen, keep native controls unobstructed.
        if (!disposed) setFullscreen(false);
      }
    };
    const resize = () => { void sync(); };
    void sync();
    window.addEventListener('varin:window-resized', resize);
    return () => {
      disposed = true;
      window.removeEventListener('varin:window-resized', resize);
    };
  }, [nativeMacControls]);

  if (nativeMacControls && !fullscreen) return '5.5rem';
  if (tabletStandalone) return `max(calc(${contentInset} + var(--varin-wco-left-inset, 0px)), 5.5rem)`;
  if (!desktop || usesFramelessDesktopChrome()) return `calc(${contentInset} + var(--varin-wco-left-inset, 0px))`;
  return contentInset;
}
