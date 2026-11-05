import React from 'react';
import { createPortal } from 'react-dom';
import { subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { subscribeUiSessions, uiSessionsRevision, notifyUiSessions, type UiSession } from '@/lib/interactive-ui/sessions';
import { clearUiInlinePlacement, inlineViewportClip, locateInlineUi, mountedUiInlineSessions, registerUiInlineAnchor, uiInlineAnchor } from '@/lib/interactive-ui/inline-placement';
import { bindInlineScroll } from '@/lib/interactive-ui/inline-scroll';
import { UiEmbedAncestryContext } from '@/lib/interactive-ui/embed-ancestry';
import { UiRevisionLink } from './UiRevisionLink';
import { UiWorkView } from './InteractiveUiCard';
import { DeclarativeUiContent } from './DeclarativeUiContent';

subscribeRuntimeEndpointWillChange(clearUiInlinePlacement);
export function InlineUiSlot({ session, anchorKey, kind, cwd = '' }: { session: UiSession; anchorKey: string; kind: 'tool' | 'embed'; cwd?: string }) {
  const target = React.useRef<HTMLDivElement>(null), { t } = useI18n();
  React.useSyncExternalStore(subscribeUiSessions, uiSessionsRevision, uiSessionsRevision);
  React.useLayoutEffect(() => target.current ? registerUiInlineAnchor(session, { key: anchorKey, element: target.current, kind, cwd }) : undefined, [session, anchorKey, kind, cwd]);
  const selected = uiInlineAnchor(session)?.key === anchorKey;
  return <div ref={target} tabIndex={-1} aria-owns={selected ? `ui-inline-${encodeURIComponent(session.key)}` : undefined}
    className="min-w-0" style={selected ? { minHeight: session.inlineHeight ?? session.inlineSize?.height ?? 1 } : undefined}>
    {!selected && <button type="button" className="my-1 max-w-full break-words text-left text-sm text-primary underline-offset-4 hover:underline" onClick={() => locateInlineUi(session)}>{session.display?.title || t('ui.content.title')} · {t('ui.content.locate')}</button>}
  </div>;
}
/** A view's DOM never moves between Markdown/tool roots. Moving its anchored
 * viewport leaves the same iframe document, scripts, focus and lease alive. */
export function InlineUiViews({ prefix }: { prefix: string }) {
  React.useSyncExternalStore(subscribeUiSessions, uiSessionsRevision, uiSessionsRevision);
  return <>{mountedUiInlineSessions(prefix).map(session => <InlineUiView key={session.key} session={session} />)}</>;
}
function InlineUiView({ session }: { session: UiSession }) {
  const layer = React.useRef<HTMLDivElement>(null);
  const anchor = uiInlineAnchor(session), display = session.display;
  const mounted = Boolean(anchor && display);
  React.useLayoutEffect(() => {
    const element = anchor?.element, view = layer.current;
    if (!element || !view) return;
    const releaseScroll = bindInlineScroll(view, element);
    let frame = 0;
    const position = () => {
      frame = 0;
      if (!element.isConnected) { view.style.visibility = 'hidden'; return; }
      const rect = element.getBoundingClientRect();
      const { top, left, right, bottom } = inlineViewportClip(element);
      view.style.width = `${rect.width}px`;
      view.style.transform = `translate(${rect.left}px,${rect.top}px)`;
      const height = view.getBoundingClientRect().height;
      session.inlineHeight = height;
      if (element.style.minHeight !== `${height}px`) element.style.minHeight = `${height}px`;
      view.style.visibility = rect.width > 0 && rect.top + height > top && rect.top < bottom ? 'visible' : 'hidden';
      view.style.clipPath = `inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.top + height - bottom)}px ${Math.max(0, left - rect.left)}px)`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(position); };
    const observer = new ResizeObserver(schedule); observer.observe(element); observer.observe(view);
    let layoutRoot = element.parentElement;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      observer.observe(parent);
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) { layoutRoot = parent; break; }
    }
    // Virtual row transforms and growth above the slot do not necessarily resize
    // the slot. Observe its layout owner, batching all notifications per frame.
    const mutations = new MutationObserver(schedule);
    if (layoutRoot) mutations.observe(layoutRoot, { subtree: true, childList: true, characterData: true, attributes: layoutRoot !== document.body });
    window.addEventListener('scroll', schedule, true); window.addEventListener('resize', schedule); position();
    return () => { releaseScroll(); observer.disconnect(); mutations.disconnect(); window.removeEventListener('scroll', schedule, true); window.removeEventListener('resize', schedule); cancelAnimationFrame(frame); element.style.minHeight = ''; };
  }, [anchor, session, mounted]);
  if (!anchor || !display || typeof document === 'undefined') return null;
  return createPortal(<UiEmbedAncestryContext.Provider value={[...session.embedAncestors ?? [], display.source.ref ?? session.key]}><div ref={layer} id={`ui-inline-${encodeURIComponent(session.key)}`} className="flow-root min-w-0 text-foreground"
    onFocusCapture={event => { if (event.currentTarget.contains(event.target)) { session.interacting = true; notifyUiSessions(); } }}
    onBlurCapture={event => { if (event.currentTarget.contains(event.target) && !event.currentTarget.contains(event.relatedTarget as Node | null)) { session.interacting = false; notifyUiSessions(); } }} style={{ position: 'fixed', top: 0, left: 0, zIndex: 1, visibility: 'hidden' }}>
    {display.content ? <DeclarativeUiContent node={display.content} sourceKey={session.key} session={session} source={display.source} isStreaming={!display.committed} />
      : <UiWorkView session={session} {...display} cwd={anchor.cwd} anchored />}
    <UiRevisionLink session={session} />
  </div></UiEmbedAncestryContext.Provider>, document.body);
}
