import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

/** Measure actual content so wrapping and font changes do not hide short prompts. */
export const PiCollapsibleUserContent: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const enabled = useUIStore(state => state.collapsibleUserMessages);
  const { t } = useI18n();
  const content = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  const [expanded, setExpanded] = React.useState(false);
  const [long, setLong] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.75;
      setLong(element.scrollHeight > line * 12 + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [children, enabled]);
  return <>
    <div id={id} onFocusCapture={() => setExpanded(true)} className="overflow-hidden" style={enabled && !expanded ? { maxHeight: '12lh' } : undefined}>
      <div ref={content}>{children}</div>
    </div>
    {enabled && long ? <button type="button" className="mt-2 rounded typography-meta text-muted-foreground hover:text-foreground"
      aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(value => !value)}>
      {t(expanded ? 'chat.userTextPart.collapse' : 'inlineComment.actions.showMore')}
    </button> : null}
  </>;
};
