import React from 'react';
import { getDesktopRuntime } from '@/lib/desktopRuntime';

type Props = Omit<React.IframeHTMLAttributes<HTMLIFrameElement>, 'src' | 'srcDoc' | 'sandbox' | 'referrerPolicy'> & {
  html: string;
  policy: 'interactive' | 'feedback';
};

/** srcdoc inherits its parent's CSP. The native shell instead supplies a static
 * response with its own opaque sandbox policy, without relaxing app scripts.
 * No document content, runtime URL or credentials are placed in a request URL. */
export const SandboxedHtmlFrame = React.forwardRef<HTMLIFrameElement, Props>(function SandboxedHtmlFrame(
  { html, policy, onLoad, ...props }, forwardedRef,
) {
  const frame = React.useRef<HTMLIFrameElement | null>(null);
  const native = getDesktopRuntime()?.runtime === 'tauri';
  const generation = React.useMemo(() => ({ id: native ? crypto.randomUUID() : '', html, policy, installed: false }), [html, policy, native]);
  React.useLayoutEffect(() => {
    if (!native) return;
    const receive = (event: MessageEvent) => {
      if (generation.installed || event.source !== frame.current?.contentWindow
        || event.data?.type !== 'varin-preview:ready' || event.data.id !== generation.id) return;
      generation.installed = true;
      frame.current?.contentWindow?.postMessage({ type: 'varin-preview:install', id: generation.id, html: generation.html }, '*');
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [generation, native]);
  const ref = React.useCallback((node: HTMLIFrameElement | null) => {
    frame.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);
  return <iframe {...props} key={native ? generation.id : undefined} ref={ref}
    sandbox="allow-scripts" referrerPolicy="no-referrer"
    {...(native ? { src: `http://varin-preview.localhost/${policy}#${generation.id}` } : { srcDoc: html })}
    onLoad={event => { if (!native || generation.installed) onLoad?.(event); }} />;
});
