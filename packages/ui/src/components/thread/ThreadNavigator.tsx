import React from 'react';
import type { HistoryItem } from '@varin/protocol';
import { historyParts } from '@/lib/agent-runtime/thread-content';
import { historySemantic } from '@/lib/agent-runtime/thread-timeline';
import { useI18n } from '@/lib/i18n';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

function MessagePreview({ item }: { item: HistoryItem }) {
  const text = historyParts(item.content, item.source).flatMap(part => part.kind === 'text' ? [part.text] : []).join('\n');
  return <p className="line-clamp-3 whitespace-pre-wrap">{text}</p>;
}

export function ThreadNavigator({ items, scrollArea }: { items: readonly HistoryItem[]; scrollArea: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useI18n();
  const [activeId, setActiveId] = React.useState<string>();
  const markers = React.useMemo(() => {
    let round = 0;
    return items.flatMap(item => {
      if (item.source !== 'user' && historySemantic(item)?.kind !== 'text') return [];
      if (item.source === 'user') round++;
      return [{ item, round }];
    });
  }, [items]);
  React.useEffect(() => {
    const root = scrollArea.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.messageId!;
        if (entry.isIntersecting) visible.set(id, entry.boundingClientRect.top); else visible.delete(id);
      }
      const first = [...visible].sort((a, b) => a[1] - b[1])[0];
      if (first) setActiveId(first[0]);
    }, { root });
    root.querySelectorAll('[data-message-id]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [items, scrollArea]);
  if (!markers.length) return null;
  return <nav className="thread-turn-navigation" aria-label={t('chat.promptNavigator.aria')}>
    {markers.map(({ item, round }, index) => <Tooltip key={item.id}><TooltipTrigger asChild>
      <button type="button" className="thread-turn-marker" data-message-role={item.source}
        aria-current={item.id === activeId ? 'location' : undefined}
        aria-label={`${item.source === 'user' ? t('harness.messages.you') : 'Varin'} · ${t('chat.promptNavigator.turn', { number: round })}`}
        onClick={() => { scrollArea.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(item.id)}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }); setActiveId(item.id); }}
        onKeyDown={event => {
          const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? markers.length - 1 : undefined;
          if (next !== undefined) { event.preventDefault(); event.currentTarget.closest('nav')?.querySelectorAll('button')[next]?.focus(); }
        }}><span /></button>
    </TooltipTrigger><TooltipContent side="right" className="max-w-72"><p className="mb-1 typography-micro text-muted-foreground">{item.source === 'user' ? t('harness.messages.you') : 'Varin'} · {t('chat.promptNavigator.turn', { number: round })}</p><MessagePreview item={item} /></TooltipContent></Tooltip>)}
  </nav>;
}
