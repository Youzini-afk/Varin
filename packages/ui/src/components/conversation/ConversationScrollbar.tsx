import React from 'react';
import { OverlayScrollbar } from '@/components/ui/OverlayScrollbar';
import { useI18n } from '@/lib/i18n';
import { CHAT_TIMELINE_SCROLL_INTENT_EVENT } from './chatTimelineScrollState';

/** The track belongs to the whole chat layout, while scrolling stays with LegendList. */
export function ConversationScrollbar({ viewport, trackRef }: {
  viewport: HTMLElement;
  trackRef: React.RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const id = React.useId();
  const containerRef = React.useMemo(() => ({ current: viewport }), [viewport]);
  React.useLayoutEffect(() => {
    if (viewport.id) return;
    viewport.id = id;
    return () => { if (viewport.id === id) viewport.removeAttribute('id'); };
  }, [id, viewport]);
  const takeScrollOwnership = React.useCallback(() => {
    viewport.dispatchEvent(new CustomEvent(CHAT_TIMELINE_SCROLL_INTENT_EVENT, { bubbles: true, detail: 'away-from-end' }));
  }, [viewport]);
  const changeDrag = React.useCallback((dragging: boolean) => {
    viewport.dispatchEvent(new CustomEvent(CHAT_TIMELINE_SCROLL_INTENT_EVENT, { bubbles: true, detail: { dragging } }));
  }, [viewport]);
  return <OverlayScrollbar containerRef={containerRef} trackRef={trackRef} disableHorizontal
    interactiveTrack ariaLabel={t('chat.scrollbar.aria')} ariaControls={viewport.id || id}
    onScrollIntent={takeScrollOwnership} onDragChange={changeDrag} className="conversation-scrollbar" />;
}
