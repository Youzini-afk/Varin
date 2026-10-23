import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ThinkingPreview } from './ThinkingPreview';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { TimelineSessionContext } from './toolDisclosureContext';
import { timelinePresentationCache } from './timelinePresentationCache';
import type { ChatThinkingContent } from './types';

interface ThinkingView {
  expanded?: boolean;
  scrollTop: number;
  follow: boolean;
}

export function ChatThinkingBlock({ content, messageId, streaming, label }: {
  content: ChatThinkingContent; messageId: string; streaming: boolean; label: string;
}) {
  const { t } = useI18n();
  const visible = useUIStore(state => state.showReasoningTraces);
  // Retain the saved preference: true means initially collapsed, not uncollapsible when false.
  const initiallyCollapsed = useUIStore(state => state.collapsibleThinkingBlocks);
  const sessionId = React.useContext(TimelineSessionContext);
  const view = React.useMemo(() => {
    const create = (): ThinkingView => ({ scrollTop: 0, follow: true });
    if (!sessionId) return create();
    const views = timelinePresentationCache(sessionId, 'thinking', () => new Map<string, ThinkingView>());
    if (!views.has(messageId)) views.set(messageId, create());
    return views.get(messageId)!;
  }, [sessionId, messageId]);
  const [, renderChoice] = React.useReducer(value => value + 1, 0);
  const open = !content.redacted && (view.expanded ?? !initiallyCollapsed);
  const hasContent = visible && (content.redacted || Boolean(content.thinking.trim()));
  const [visited, setVisited] = React.useState(open);
  const [following, setFollowing] = React.useState(view.follow);
  const viewport = React.useRef<HTMLDivElement>(null);
  const body = React.useRef<HTMLDivElement>(null);
  const panelId = React.useId();
  const headingId = React.useId();

  React.useEffect(() => { if (open) setVisited(true); }, [open]);
  React.useLayoutEffect(() => {
    const node = viewport.current;
    if (!hasContent || !open || !node) return;
    setFollowing(view.follow);
    node.scrollTop = view.follow ? node.scrollHeight : view.scrollTop;
    const follow = () => {
      if (view.follow) node.scrollTop = node.scrollHeight;
    };
    // Completed Markdown, font loading and window resizing may change height without new tokens.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(follow);
    observer.observe(node);
    if (body.current) observer.observe(body.current);
    return () => observer.disconnect();
  }, [hasContent, open, view]);
  React.useLayoutEffect(() => {
    if (open && view.follow && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [content.thinking, streaming, open, view]);

  if (!hasContent) return null;
  return <section className="thinking-block" data-open={open} data-streaming={streaming}
    data-conversation-activity-kind="thinking">
    <button type="button" className="thinking-heading typography-meta" id={headingId}
      aria-expanded={open} aria-controls={content.redacted ? undefined : panelId}
      disabled={content.redacted}
      onClick={() => { view.expanded = !open; renderChoice(); }}>
      <Icon name="brain" className="thinking-icon size-3.5 shrink-0" />
      <span className="thinking-label">{label}</span>
      {content.redacted ? <span className="min-w-0 flex-1 text-left">{t('chat.reasoningTrace.unavailable')}</span>
        : <ThinkingPreview text={content.thinking} streaming={streaming} active={!open} />}
      {!content.redacted && <Icon name="arrow-right-s" className="thinking-chevron size-3.5 shrink-0" />}
    </button>
    {!content.redacted && <div className="thinking-panel" id={panelId} aria-hidden={!open} inert={!open}>
      <div className="thinking-panel-clip">
        {(open || visited) && <div className="thinking-window">
          <div ref={viewport} className="thinking-scroll" data-conversation-tool-scroll="true"
            role="region" aria-labelledby={headingId} tabIndex={open ? 0 : -1}
            onScroll={event => {
              if (!open) return;
              const node = event.currentTarget;
              view.scrollTop = node.scrollTop;
              view.follow = node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
              setFollowing(view.follow);
            }}>
            <div ref={body} className="thinking-body">
              {streaming
                ? <div className="markdown-content markdown-reasoning whitespace-pre-wrap break-words">{content.thinking}</div>
                : <MarkdownRenderer content={content.thinking} messageId={messageId} variant="reasoning" />}
            </div>
          </div>
          {!following && <button type="button" className="thinking-follow typography-micro"
            onClick={() => {
              view.follow = true; setFollowing(true);
              if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
            }}>
            <Icon name="arrow-down" className="size-3.5" />{t('chat.tools.followOutput')}
          </button>}
        </div>}
      </div>
    </div>}
  </section>;
}
