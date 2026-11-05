import React from 'react';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useToolDisclosureChoices } from './toolDisclosureContext';

/** Preview actual rendered lines, regardless of language, source or Markdown shape. */
export function ToolExcerpt({ id, text, markdown = false }: { id: string; text: string; markdown?: boolean }) {
  const { t } = useI18n();
  const choices = useToolDisclosureChoices();
  const [expanded, setExpanded] = React.useState(() => choices?.get(id) ?? false);
  const [size, setSize] = React.useState<{ full: number; preview: number }>();
  const content = React.useRef<HTMLDivElement>(null);
  const regionId = React.useId();
  React.useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const full = element.getBoundingClientRect().height;
      if (full <= 0) return;
      const line = Number.parseFloat(window.getComputedStyle(element).lineHeight);
      if (!Number.isFinite(line) || line <= 0) return;
      const preview = line * 4;
      setSize(previous => previous?.full === full && previous.preview === preview ? previous : { full, preview });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, markdown]);
  const overflowing = size ? size.full > size.preview + 1 : false;
  const toggle = () => { const next = !expanded; choices?.set(id, next); setExpanded(next); };
  return <div className="tool-excerpt" data-expanded={expanded || !overflowing}>
    <div id={regionId} className="tool-excerpt-viewport" style={size ? { height: expanded ? size.full : Math.min(size.full, size.preview) } : undefined}>
      <div ref={content} className="tool-excerpt-content">
        {markdown ? <MarkdownRenderer content={text} messageId={id} variant="tool" enableFileReferences={false} />
          : <p className="whitespace-pre-wrap break-words">{text}</p>}
      </div>
    </div>
    {overflowing && <button type="button" className="tool-excerpt-toggle" aria-expanded={expanded} aria-controls={regionId} onClick={toggle}>
      {t(expanded ? 'chat.tools.collapseContent' : 'chat.tools.expandContent')}
      <Icon name="arrow-down-s" className="size-3" />
    </button>}
  </div>;
}
