import React from 'react';
import { motion, useIsPresent } from 'motion/react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { INSTANT_TRANSITION, springTransition } from '@/lib/motion/tokens';
import { useMobileAutocompleteMaxHeight } from '../useMobileAutocompleteMaxHeight';

export interface ComposerMenuItem {
  id: string;
  group: string;
  label: string;
  description?: string;
  source?: string;
  value?: React.ReactNode;
  disabled?: string;
  icon?: React.ReactNode;
  next?: boolean;
}
export interface ComposerMenuHandle { handleKeyDown(key: string): boolean }
function candidateSelection(items: readonly { id: string }[], previous?: { id: string; index: number }): number {
  if (!items.length) return -1;
  const index = previous ? items.findIndex(item => item.id === previous.id) : -1;
  return index >= 0 ? index : Math.min(previous?.index ?? 0, items.length - 1);
}
/** One controller for pointer, keyboard and accessible selection across both sigils. */
export const ComposerMenu = React.forwardRef<ComposerMenuHandle, {
  id: string; items: readonly ComposerMenuItem[]; query: string; scope: string;
  onChoose(id: string, mode: 'confirm' | 'complete'): void; onClose(): void;
  onActive?(id?: string): void; status?: React.ReactNode; children?: React.ReactNode;
  title?: string; onBack?(): void;
}>(({ id, items, query, scope, onChoose, onClose, onActive, status, children, title, onBack }, ref) => {
  const { t } = useI18n();
  const present = useIsPresent();
  const container = React.useRef<HTMLDivElement>(null);
  const layer = React.useRef<HTMLDivElement>(null);
  const hasLayer = Boolean(children);
  React.useLayoutEffect(() => {
    if (!hasLayer) return;
    const target = layer.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled), [tabindex="0"]') ?? layer.current;
    target?.focus();
  }, [hasLayer, title]);
  const isMobile = useUIStore(state => state.isMobile);
  const maxHeight = useMobileAutocompleteMaxHeight(container, isMobile);
  const reduced = usePrefersReducedMotion();
  const [selection, setSelection] = React.useState<{ id: string; index: number; query: string; scope: string }>();
  const index = candidateSelection(items, selection?.query === query && selection.scope === scope ? selection : undefined);
  const item = items[index];
  const activeId = item?.id;
  const nodes = React.useRef(new Map<string, HTMLDivElement>());
  const last = React.useRef({ x: 0, y: 0, moved: false });
  const suppressClick = React.useRef(false);
  const move = (index: number) => { const item = items[index]; if (item) setSelection({ id: item.id, index, query, scope }); };
  React.useEffect(() => { onActive?.(!children && item ? `${id}-${encodeURIComponent(item.id)}` : undefined); }, [id, item, children, onActive]);
  React.useEffect(() => { if (activeId && !children) nodes.current.get(activeId)?.scrollIntoView?.({ block: 'nearest' }); }, [activeId, children]);
  React.useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) onClose(); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [onClose]);
  React.useImperativeHandle(ref, () => ({ handleKeyDown(key) {
    if (key === 'Escape') { if (children && onBack) onBack(); else onClose(); return true; }
    if (children) return key === 'Enter';
    if (!items.length) return false;
    if (key === 'ArrowDown' || key === 'ArrowUp') { move((index + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length); return true; }
    if (key === 'Enter' || key === 'Tab') { if (item) onChoose(item.id, key === 'Tab' ? 'complete' : 'confirm'); return true; }
    return false;
  } }));
  return <motion.div ref={container} initial={{ opacity: 0, y: reduced ? 0 : 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduced ? 0 : 5 }}
    transition={reduced ? INSTANT_TRANSITION : springTransition('settle')}
    className="absolute bottom-full left-0 z-[100] mb-2 flex max-h-80 w-full min-w-0 flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-lg"
    onClick={event => {
      // Domain controls were also built for standalone panels. Their default button
      // semantics must never submit the enclosing ordinary-message form.
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (hasLayer && button && (!button.getAttribute('type') || button.getAttribute('type') === 'submit')) event.preventDefault();
    }}
    onKeyDown={event => { if (hasLayer && event.key === 'Enter' && event.target instanceof HTMLElement && event.target.tagName === 'INPUT' && !['button', 'submit', 'reset'].includes((event.target as HTMLInputElement).type)) { event.preventDefault(); event.stopPropagation(); return; } if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (children && onBack) onBack(); else onClose(); } }}
    aria-hidden={!present || undefined} style={{ ...(maxHeight ? { maxHeight } : {}), ...(!present ? { pointerEvents: 'none' } : {}) }}>
    {children && <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 typography-ui-label"><button type="button" onClick={onBack} aria-label={t('composer.menu.back')}>←</button><span>{title}</span></div>}
    <div className={cn('min-h-0 overflow-y-auto overscroll-contain p-1', children && 'hidden')}>
      <div id={id} role="listbox" aria-label={t('composer.menu.title')}>
      {items.map((entry, position) => <React.Fragment key={entry.id}>
        {(position === 0 || items[position - 1].group !== entry.group) && <div className="px-2 pb-1 pt-2 typography-micro text-muted-foreground">{entry.group}</div>}
        <div id={`${id}-${encodeURIComponent(entry.id)}`} role="option" aria-selected={index === position} aria-disabled={Boolean(entry.disabled)} title={entry.disabled ?? entry.description}
          ref={node => { if (node) nodes.current.set(entry.id, node); else nodes.current.delete(entry.id); }}
          className={cn('flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 typography-ui-label', index === position && 'bg-interactive-selection', entry.disabled && 'text-muted-foreground')}
          onMouseDown={event => event.preventDefault()} onPointerDown={event => { last.current = { x: event.clientX, y: event.clientY, moved: false }; suppressClick.current = false; }}
          onPointerMove={event => { if (event.pointerType === 'touch') { if (Math.hypot(event.clientX - last.current.x, event.clientY - last.current.y) > 6) last.current.moved = true; } else move(position); }}
          onPointerUp={event => { if (event.pointerType === 'touch' && last.current.moved) suppressClick.current = true; }}
          onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } onChoose(entry.id, 'confirm'); }}>
          <span className="mt-0.5 shrink-0">{entry.icon}</span>
          <span className="min-w-0 flex-1"><span className="flex flex-wrap items-baseline gap-x-2"><span className="font-medium">{entry.label}</span>{entry.description && <span className="min-w-0 line-clamp-2 text-muted-foreground typography-meta">{entry.description}</span>}</span>
            {entry.disabled && <span className="block typography-micro text-muted-foreground">{entry.disabled}</span>}</span>
          {(entry.source || entry.value) && <span className="max-w-[32%] shrink-0 truncate typography-micro text-muted-foreground">{entry.value ?? entry.source}</span>}
          {entry.next && <span aria-hidden="true">›</span>}
        </div>
      </React.Fragment>)}
      </div>
      {status}
      {!items.length && !status && <p className="px-2 py-3 typography-meta text-muted-foreground">{t('chat.commandAutocomplete.empty')}</p>}
    </div>
    {children && <motion.div ref={layer} tabIndex={-1} key={title} initial={{ opacity: 0, x: reduced ? 0 : 5 }} animate={{ opacity: 1, x: 0 }} transition={reduced ? INSTANT_TRANSITION : springTransition('settle')} className="min-h-0 overflow-y-auto p-3">{children}</motion.div>}
    {!children && <p className="border-t border-border/50 px-3 py-1.5 typography-micro text-muted-foreground">{t('composer.menu.keys')}</p>}
  </motion.div>;
});
